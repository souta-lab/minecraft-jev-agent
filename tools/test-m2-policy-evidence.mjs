#!/usr/bin/env bun
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
  evaluateCurrentM2AuthorityEvidence,
  loadPolicyEvidence,
  parseSystem2AuthorityInputLine,
  parseGenerationLine,
  parseSystem2AuthorityLine,
  resolveRunWindow,
  scanRunnerOut,
} from './m2-policy-evidence.mjs'

let checks = 0
const ok = (label) => {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}
const line = (ts, body) => `[${ts}] ${body}`
const SOURCE_SHA = 'a'.repeat(40)
const BUILD_HASH = 'b'.repeat(12)
const HOST_JEV_PROVIDER = 'typesafe-ai'
const decision = (ts, source, {
  runId = 'run-b',
  generationId = 'g-b',
  sourceSha = SOURCE_SHA,
  actualModel = source === 'jev' ? REQUIRED_POLICY_MODEL : null,
  actualProvider = null,
} = {}) => JSON.stringify({
  record: 'decision', ts, source, runId, generationId, sourceSha,
  ...(source === 'jev' ? { jev: {
    ...(actualModel === null ? {} : { model: actualModel }),
    ...(actualProvider === null ? {} : { provider: actualProvider }),
  } } : {}),
})
const decisionScope = (runId = 'run-b', generationId = 'g-b') => ({
  runId,
  sourceSha: SOURCE_SHA,
  generations: [{
    generationId,
    sourceSha: SOURCE_SHA,
    tsMs: Date.parse('2026-09-18T09:10:01.000Z'),
    policyProvider: HOST_JEV_PROVIDER,
    policyModel: REQUIRED_POLICY_MODEL,
  }],
})
const generation = (id, overrides = {}) => [
  `id=${id}`,
  `generationId=${id}`,
  `sourceSha=${overrides.sourceSha ?? SOURCE_SHA}`,
  `buildHash=${overrides.buildHash ?? BUILD_HASH}`,
  `policy=${overrides.policy ?? 'typesafe'}`,
  `model=${overrides.policyModel ?? 'typesafe-ai/jev'}`,
  `policyProvider=${overrides.policyProvider ?? HOST_JEV_PROVIDER}`,
  `planner=${overrides.planner ?? 'llm'}`,
  `deterministicFallbackEnabled=${overrides.deterministicFallbackEnabled ?? 'false'}`,
  `system2ConfiguredProvider=${overrides.system2Provider ?? 'model-provider'}`,
  `system2ConfiguredModel=${overrides.system2Model ?? 'model-v1'}`,
].join(' ')
const system2Identity = (id, overrides = {}) => [
  `generationId=${id}`,
  `sourceSha=${overrides.sourceSha ?? SOURCE_SHA}`,
  `buildHash=${overrides.buildHash ?? BUILD_HASH}`,
  `provider=${overrides.provider ?? 'model-provider'}`,
  `model=${overrides.model ?? 'model-v1'}`,
  `configuredProvider=${overrides.configuredProvider ?? 'model-provider'}`,
  `configuredModel=${overrides.configuredModel ?? 'model-v1'}`,
  'trigger=queue_empty',
].join(' ')

const dir = mkdtempSync(join(tmpdir(), 'm2-policy-evidence-'))
const runnerOut = join(dir, 'runner.out')
const decisions = join(dir, 'decisions.jsonl')
const missing = join(dir, 'nope.jsonl')

try {
  writeFileSync(
    runnerOut,
    [
      line('2026-09-18T09:00:00.000Z', `BOOT pid=1 runId=run-a bundle=a source=${SOURCE_SHA}`),
      line('2026-09-18T09:00:01.000Z', `GENERATION_READY ${generation('g-a', { policy: 'fallback', policyModel: 'deterministic-local-fallback+descend-aware', planner: 'deterministic', deterministicFallbackEnabled: 'true', system2Provider: 'deterministic', system2Model: 'deterministic' })}`),
      line('2026-09-18T09:00:05.000Z', 'HOST_LOCK released pid=1'),
      line('2026-09-18T09:10:00.000Z', `BOOT pid=2 runId=run-b bundle=b source=${SOURCE_SHA}`),
      line('2026-09-18T09:10:01.000Z', `GENERATION_READY ${generation('g-b')}`),
      line('2026-09-18T09:10:01.500Z', `SYSTEM2_AUTHORITY_INPUT ${system2Identity('g-b')}`),
      line('2026-09-18T09:10:02.000Z', `SYSTEM2_AUTHORITY_DECISION ${system2Identity('g-b')} reason=queue_empty chosen=front_nether_portal goals=["build portal","light portal"]`),
      line('2026-09-18T09:10:05.000Z', 'HOST_LOCK released pid=2'),
      line('2026-09-18T09:15:00.000Z', `BOOT pid=4 runId=run-d bundle=d source=${SOURCE_SHA}`),
      line('2026-09-18T09:15:01.000Z', `GENERATION_READY ${generation('g-d', { system2Provider: 'stub', system2Model: 'stub-system2' })}`),
      line('2026-09-18T09:15:01.500Z', `SYSTEM2_AUTHORITY_INPUT ${system2Identity('g-d', { provider: 'stub', model: 'stub-system2', configuredProvider: 'stub', configuredModel: 'stub-system2' })}`),
      line('2026-09-18T09:15:02.000Z', `SYSTEM2_AUTHORITY_DECISION ${system2Identity('g-d', { provider: 'stub', model: 'stub-system2', configuredProvider: 'stub', configuredModel: 'stub-system2' })} reason=fixture chosen=front_nether_portal goals=["build portal","light portal"]`),
      line('2026-09-18T09:15:05.000Z', 'HOST_LOCK released pid=4'),
      line('2026-09-18T09:20:00.000Z', `BOOT pid=3 runId=run-c bundle=c source=${SOURCE_SHA}`),
      // Alternate structured spelling must be accepted as well.
      line('2026-09-18T09:20:01.000Z', `GENERATION_READY id=g-c generationId=g-c sourceSha=${SOURCE_SHA} policyKind=typesafe policyModel=typesafe-ai/jev`),
    ].join('\n') + '\n',
  )
  writeFileSync(
    decisions,
    [
      decision('2026-09-18T09:00:01.000Z', 'fallback', { runId: 'run-a', generationId: 'g-a' }),
      decision('2026-09-18T09:00:03.000Z', 'fallback', { runId: 'run-a', generationId: 'g-a' }),
      decision('2026-09-18T09:10:01.000Z', 'jev'),
      decision('2026-09-18T09:10:03.000Z', 'jev'),
      decision('2026-09-18T09:15:02.000Z', 'jev', { runId: 'run-d', generationId: 'g-d' }),
      decision('2026-09-18T09:20:02.000Z', 'jev', { runId: 'run-c', generationId: 'g-c' }),
      // A non-decision record inside a window must not be counted.
      JSON.stringify({ record: 'other', ts: '2026-09-18T09:10:02.000Z', source: 'jev' }),
    ].join('\n') + '\n',
  )

  {
    const parsed = parseGenerationLine(`GENERATION_READY ${generation('g', { planner: 'unknown' })}`)
    assert.deepEqual(parsed, {
      generationId: 'g', sourceSha: SOURCE_SHA, buildHash: BUILD_HASH,
      policyKind: 'typesafe', policyModel: 'typesafe-ai/jev', plannerMode: 'unknown', deterministicFallbackEnabled: false,
      system2ConfiguredProvider: 'model-provider', system2ConfiguredModel: 'model-v1', policyProvider: 'typesafe-ai',
    })
    const fallback = parseGenerationLine('GENERATION_READY id=g policy=fallback model=deterministic-local-fallback')
    assert.deepEqual(fallback, {
      generationId: 'g', sourceSha: null, buildHash: null,
      policyKind: 'fallback', policyModel: 'deterministic-local-fallback', plannerMode: null, deterministicFallbackEnabled: null,
      system2ConfiguredProvider: null, system2ConfiguredModel: null, policyProvider: null,
    })
    const rich = parseGenerationLine('GENERATION_READY policy=typesafe model=typesafe-ai/jev planner=llm deterministicFallbackEnabled=false')
    assert.equal(rich.plannerMode, 'llm')
    assert.equal(rich.deterministicFallbackEnabled, false)
    const system2 = parseSystem2AuthorityLine(`SYSTEM2_AUTHORITY_DECISION ${system2Identity('g')} chosen=front_nether_portal goals=["build portal"]`)
    assert.deepEqual(system2, {
      generationId: 'g', sourceSha: SOURCE_SHA, buildHash: BUILD_HASH,
      provider: 'model-provider', model: 'model-v1', configuredProvider: 'model-provider', configuredModel: 'model-v1',
      trigger: 'queue_empty', chosen: 'front_nether_portal', portalPlan: true,
    })
    assert.equal(parseSystem2AuthorityInputLine(`SYSTEM2_AUTHORITY_INPUT ${system2Identity('g')}`).generationId, 'g')
    ok('parseGenerationLine/System2 parser retain planner and authority facts')
  }

  {
    const evidence = await loadPolicyEvidence({ runId: 'run-a', decisionsPath: decisions, runnerOutPath: runnerOut })
    assert.equal(evidence.decisions.runId, 'run-a')
    assert.equal(evidence.decisions.jevCount, 0)
    assert.equal(evidence.decisions.fallbackCount, 2)
    assert.equal(evidence.decisions.unclassifiableCount, 0)
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
    assert.equal(evidence.decisions.otherCount, 0)
    assert.equal(evidence.decisions.unclassifiableCount, 0)
    assert.equal(evidence.generation.runId, 'run-b')
    assert.equal(evidence.generation.policyKind, 'typesafe')
    assert.equal(evidence.generation.source, runnerOut)
    assert.equal(evidence.generation.plannerMode, 'llm')
    assert.equal(evidence.generation.deterministicFallbackEnabled, false)
    assert.equal(evidence.system2.modelCount, 1)
    assert.equal(evidence.system2.identityStatus, 'verified')
    assert.equal(evidence.system2.effectiveProvider, 'model-provider')
    assert.equal(evidence.system2.effectiveModel, 'model-v1')
    assert.equal(evidence.system2.portalPlanCount, 1)
    const verdict = evaluatePolicyEvidence({ expectedRunId: 'run-b', ...evidence })
    assert.equal(verdict.code, 0)
    assert.equal(verdict.status, 'VERIFIED')
    assert.equal(verdict.reason, 'real_policy_evidence_verified')
    const current = evaluateCurrentM2AuthorityEvidence({ expectedRunId: 'run-b', ...evidence })
    assert.equal(current.code, 0)
    assert.equal(current.reason, 'current_m2_authority_verified')
    ok('run-b joins each System2 decision and call input to its same-run source generation')
  }

  {
    const evidence = await loadPolicyEvidence({ runId: 'run-c', decisionsPath: decisions, runnerOutPath: runnerOut })
    assert.equal(evidence.reason, 'run_window_unbounded')
    assert.equal(evidence.decisions, null)
    ok('an unbracketed (not live) run window is refused as UNKNOWN')
  }

  {
    const evidence = await loadPolicyEvidence({ runId: 'run-d', decisionsPath: decisions, runnerOutPath: runnerOut })
    assert.equal(evidence.decisions.jevCount, 1)
    assert.equal(evidence.system2.modelCount, 0)
    assert.equal(evidence.system2.identityStatus, 'unknown')
    assert.match(evidence.system2.identityReason, /system2_decision_non_model_authority/)
    const verdict = evaluateCurrentM2AuthorityEvidence({ expectedRunId: 'run-d', ...evidence })
    assert.equal(verdict.code, 2)
    assert.match(verdict.reason, /^system2_generation_identity_unverified/)
    ok('stub System2 decision cannot verify same-run model authority')
  }

  {
    const lineageOut = join(dir, 'lineage-runner.out')
    const lineageDecisions = join(dir, 'lineage-decisions.jsonl')
    const writeLineage = (runId, events, runSource = SOURCE_SHA, decisionGenerationId = 'gen-1') => {
      const start = '2026-09-18T10:00:00.000Z'
      writeFileSync(lineageOut, [
        line(start, `BOOT pid=9 runId=${runId} source=${runSource}`),
        ...events,
        line('2026-09-18T10:01:00.000Z', 'HOST_LOCK released pid=9'),
      ].join('\n') + '\n')
      writeFileSync(lineageDecisions, decision('2026-09-18T10:00:02.000Z', 'jev', {
        runId,
        generationId: decisionGenerationId,
        sourceSha: runSource,
      }) + '\n')
    }
    const loadLineage = (runId) => loadPolicyEvidence({ runId, decisionsPath: lineageDecisions, runnerOutPath: lineageOut })

    writeLineage('run-model-drift', [
      line('2026-09-18T10:00:01.000Z', `GENERATION_READY ${generation('gen-1')}`),
      line('2026-09-18T10:00:01.100Z', `SYSTEM2_AUTHORITY_INPUT ${system2Identity('gen-1')}`),
      line('2026-09-18T10:00:01.200Z', `SYSTEM2_AUTHORITY_DECISION ${system2Identity('gen-1')}`),
      line('2026-09-18T10:00:01.300Z', `GENERATION_READY ${generation('gen-2', { system2Model: 'model-v2' })}`),
      line('2026-09-18T10:00:01.400Z', `SYSTEM2_AUTHORITY_INPUT ${system2Identity('gen-2', { model: 'model-v2', configuredModel: 'model-v2' })}`),
      line('2026-09-18T10:00:01.500Z', `SYSTEM2_AUTHORITY_DECISION ${system2Identity('gen-2', { model: 'model-v2', configuredModel: 'model-v2' })}`),
    ])
    const drift = await loadLineage('run-model-drift')
    assert.equal(drift.system2.identityStatus, 'unknown')
    assert.match(drift.system2.identityReason, /system2_authority_changed_across_generations/)
    assert.equal(evaluateCurrentM2AuthorityEvidence({ expectedRunId: 'run-model-drift', ...drift }).code, 2)

    writeLineage('run-responder-drift', [
      line('2026-09-18T10:00:01.000Z', `GENERATION_READY ${generation('gen-1')}`),
      line('2026-09-18T10:00:01.100Z', `SYSTEM2_AUTHORITY_INPUT ${system2Identity('gen-1')}`),
      line('2026-09-18T10:00:01.200Z', `SYSTEM2_AUTHORITY_DECISION ${system2Identity('gen-1')}`),
      line('2026-09-18T10:00:01.300Z', `GENERATION_READY ${generation('gen-2')}`),
      line('2026-09-18T10:00:01.400Z', `SYSTEM2_AUTHORITY_INPUT ${system2Identity('gen-2', { model: 'model-v2' })}`),
      line('2026-09-18T10:00:01.500Z', `SYSTEM2_AUTHORITY_DECISION ${system2Identity('gen-2', { model: 'model-v2' })}`),
    ])
    const responderDrift = await loadLineage('run-responder-drift')
    assert.equal(responderDrift.system2.identityStatus, 'unknown')
    assert.match(responderDrift.system2.identityReason, /system2_effective_authority_changed_across_generations/)

    writeLineage('run-unjoined', [
      line('2026-09-18T10:00:01.000Z', `GENERATION_READY ${generation('gen-present')}`),
      line('2026-09-18T10:00:01.100Z', `SYSTEM2_AUTHORITY_INPUT ${system2Identity('gen-missing')}`),
      line('2026-09-18T10:00:01.200Z', `SYSTEM2_AUTHORITY_DECISION ${system2Identity('gen-missing')}`),
    ], SOURCE_SHA, 'gen-present')
    const unjoined = await loadLineage('run-unjoined')
    assert.match(unjoined.system2.identityReason, /system2_decision_generation_unjoined/)

    writeLineage('run-source-mismatch', [
      line('2026-09-18T10:00:01.000Z', `GENERATION_READY ${generation('gen-source')}`),
      line('2026-09-18T10:00:01.100Z', `SYSTEM2_AUTHORITY_INPUT ${system2Identity('gen-source', { sourceSha: 'c'.repeat(40) })}`),
      line('2026-09-18T10:00:01.200Z', `SYSTEM2_AUTHORITY_DECISION ${system2Identity('gen-source', { sourceSha: 'c'.repeat(40) })}`),
    ], SOURCE_SHA, 'gen-source')
    const sourceMismatch = await loadLineage('run-source-mismatch')
    assert.match(sourceMismatch.system2.identityReason, /system2_decision_source_sha_mismatch/)

    writeLineage('run-input-missing', [
      line('2026-09-18T10:00:01.000Z', `GENERATION_READY ${generation('gen-no-input')}`),
      line('2026-09-18T10:00:01.200Z', `SYSTEM2_AUTHORITY_DECISION ${system2Identity('gen-no-input')}`),
    ], SOURCE_SHA, 'gen-no-input')
    const inputMissing = await loadLineage('run-input-missing')
    assert.match(inputMissing.system2.identityReason, /system2_decision_input_unjoined/)
    writeLineage('run-input-before-ready', [
      line('2026-09-18T10:00:01.000Z', `SYSTEM2_AUTHORITY_INPUT ${system2Identity('gen-order')}`),
      line('2026-09-18T10:00:01.100Z', `GENERATION_READY ${generation('gen-order')}`),
      line('2026-09-18T10:00:01.200Z', `SYSTEM2_AUTHORITY_DECISION ${system2Identity('gen-order')}`),
    ], SOURCE_SHA, 'gen-order')
    const inputBeforeReady = await loadLineage('run-input-before-ready')
    assert.match(inputBeforeReady.system2.identityReason, /system2_decision_input_unjoined/)
    ok('System2 model drift, source mismatch, missing generation, and unpaired lifecycle events are UNKNOWN')
  }

  {
    const nowMs = Date.parse('2026-09-18T09:20:03.000Z')
    const evidence = await loadPolicyEvidence({
      runId: 'run-c',
      socket: { runId: 'run-c', policyKind: 'typesafe', policyProvider: HOST_JEV_PROVIDER, policyModel: 'typesafe-ai/jev' },
      decisionsPath: decisions,
      runnerOutPath: runnerOut,
      now: () => nowMs,
    })
    assert.equal(evidence.generation.source, 'socket_report')
    assert.equal(evidence.generation.policyKind, 'typesafe')
    assert.equal(evidence.generation.policyProvider, HOST_JEV_PROVIDER)
    assert.equal(evidence.generation.policyModel, REQUIRED_POLICY_MODEL)
    assert.equal(evidence.decisions.jevCount, 1)
    const verdict = evaluatePolicyEvidence({ expectedRunId: 'run-c', ...evidence })
    assert.equal(verdict.code, 0)
    ok('a live run is bracketed by now and its socket generation status verifies')
  }

  {
    const startMs = Date.parse('2026-09-18T09:10:00.000Z')
    const endMs = Date.parse('2026-09-18T09:10:05.000Z')
    const mismatchPath = join(dir, 'decision-model-mismatch.jsonl')
    const missingPath = join(dir, 'decision-model-missing.jsonl')
    const deterministicPath = join(dir, 'decision-model-deterministic.jsonl')
    writeFileSync(mismatchPath, `${decision('2026-09-18T09:10:02.000Z', 'jev', { actualModel: 'other-model' })}\n`)
    writeFileSync(missingPath, `${decision('2026-09-18T09:10:02.000Z', 'jev', { actualModel: null })}\n`)
    writeFileSync(deterministicPath, `${decision('2026-09-18T09:10:02.000Z', 'jev', { actualModel: 'deterministic-local-fallback' })}\n`)
    for (const [label, path] of [
      ['mismatched', mismatchPath],
      ['missing', missingPath],
      ['deterministic-looking', deterministicPath],
    ]) {
      const counts = await countDecisionSources(path, startMs, endMs, decisionScope())
      assert.equal(counts.jevCount, 0, `${label} result model cannot count as a Jev model decision`)
      assert.equal(counts.unclassifiableCount, 1, `${label} result model must remain UNKNOWN`)
    }
    const injectedProviderPath = join(dir, 'decision-provider-is-not-authority.jsonl')
    writeFileSync(injectedProviderPath, `${decision('2026-09-18T09:10:02.000Z', 'jev', { actualProvider: 'caller-injected-provider' })}\n`)
    const injected = await loadPolicyEvidence({ runId: 'run-b', decisionsPath: injectedProviderPath, runnerOutPath: runnerOut })
    assert.equal(injected.decisions.jevCount, 1)
    assert.equal(injected.generation.policyProvider, HOST_JEV_PROVIDER)
    assert.equal(injected.generation.policyModel, REQUIRED_POLICY_MODEL)
    assert.equal(evaluatePolicyEvidence({ expectedRunId: 'run-b', ...injected }).facts.effectiveProvider, HOST_JEV_PROVIDER)
    ok('every Jev row model joins its HOST generation model; decision-row provider cannot replace HOST identity')
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
    assert.equal(scanned.boots.length, 4)
    assert.equal(scanned.releases.length, 3)
    assert.equal(scanned.generations.length, 4)
    assert.equal(scanned.system2Inputs.length, 2)
    assert.equal(scanned.system2Decisions.length, 2)
    const windowB = resolveRunWindow(scanned.boots, scanned.releases, 'run-b')
    assert.equal(windowB.startMs, Date.parse('2026-09-18T09:10:00.000Z'))
    assert.equal(windowB.endMs, Date.parse('2026-09-18T09:10:05.000Z'))
    ok('scanRunnerOut/resolveRunWindow bracket each BOOT with the next release')
  }

  {
    const counts = await countDecisionSources(
      decisions,
      Date.parse('2026-09-18T09:10:00.000Z'),
      Date.parse('2026-09-18T09:10:05.000Z'),
      decisionScope(),
    )
    assert.deepEqual(
      { jev: counts.jevCount, fallback: counts.fallbackCount, other: counts.otherCount, unclassifiable: counts.unclassifiableCount },
      { jev: 2, fallback: 0, other: 0, unclassifiable: 0 },
    )
    ok('countDecisionSources counts only decision records inside the window')
  }

  {
    const malformedDecisions = join(dir, 'malformed-decisions.jsonl')
    writeFileSync(
      malformedDecisions,
      [
        decision('2026-09-18T09:10:01.000Z', 'jev'),
        '{"record":"decision","ts":"2026-09-18T09:10:04.000Z","source":"fallback",',
      ].join('\n') + '\n',
    )
    const counts = await countDecisionSources(
      malformedDecisions,
      Date.parse('2026-09-18T09:10:00.000Z'),
      Date.parse('2026-09-18T09:10:05.000Z'),
      decisionScope(),
    )
    assert.deepEqual(
      { jev: counts.jevCount, fallback: counts.fallbackCount, other: counts.otherCount, unclassifiable: counts.unclassifiableCount },
      { jev: 1, fallback: 0, other: 0, unclassifiable: 1 },
    )
    const evidence = await loadPolicyEvidence({ runId: 'run-b', decisionsPath: malformedDecisions, runnerOutPath: runnerOut })
    const verdict = evaluatePolicyEvidence({ expectedRunId: 'run-b', ...evidence })
    assert.equal(verdict.status, 'UNKNOWN')
    assert.equal(verdict.reason, 'decision_records_unclassifiable count=1')
    ok('a malformed in-window row claiming record=decision cannot disappear beside a valid Jev row')
  }

  {
    const escapedFallbackDecisions = join(dir, 'escaped-record-fallback-decisions.jsonl')
    writeFileSync(
      escapedFallbackDecisions,
      [
        decision('2026-09-18T09:10:01.000Z', 'jev'),
        // This is valid JSON: JSON.parse decodes the escaped `o` in the key.
        `{"rec\\u006frd":"decision","ts":"2026-09-18T09:10:04.000Z","source":"fallback","runId":"run-b","generationId":"g-b","sourceSha":"${SOURCE_SHA}"}`,
      ].join('\n') + '\n',
    )
    const counts = await countDecisionSources(
      escapedFallbackDecisions,
      Date.parse('2026-09-18T09:10:00.000Z'),
      Date.parse('2026-09-18T09:10:05.000Z'),
      decisionScope(),
    )
    assert.deepEqual(
      { jev: counts.jevCount, fallback: counts.fallbackCount, other: counts.otherCount, unclassifiable: counts.unclassifiableCount },
      { jev: 1, fallback: 1, other: 0, unclassifiable: 0 },
    )
    const evidence = await loadPolicyEvidence({ runId: 'run-b', decisionsPath: escapedFallbackDecisions, runnerOutPath: runnerOut })
    const verdict = evaluatePolicyEvidence({ expectedRunId: 'run-b', ...evidence })
    assert.equal(verdict.status, 'UNKNOWN')
    assert.equal(verdict.reason, 'fallback_decisions_present')
    ok('an escaped JSON record key cannot hide an in-window fallback decision')
  }

  {
    const escapedUnknownDecisions = join(dir, 'escaped-record-unknown-decisions.jsonl')
    writeFileSync(
      escapedUnknownDecisions,
      [
        decision('2026-09-18T09:10:01.000Z', 'jev'),
        `{"rec\\u006frd":"decision","ts":"2026-09-18T09:10:04.000Z","source":"unclassified-policy","runId":"run-b","generationId":"g-b","sourceSha":"${SOURCE_SHA}"}`,
      ].join('\n') + '\n',
    )
    const counts = await countDecisionSources(
      escapedUnknownDecisions,
      Date.parse('2026-09-18T09:10:00.000Z'),
      Date.parse('2026-09-18T09:10:05.000Z'),
      decisionScope(),
    )
    assert.deepEqual(
      { jev: counts.jevCount, fallback: counts.fallbackCount, other: counts.otherCount, unclassifiable: counts.unclassifiableCount },
      { jev: 1, fallback: 0, other: 1, unclassifiable: 1 },
    )
    const evidence = await loadPolicyEvidence({ runId: 'run-b', decisionsPath: escapedUnknownDecisions, runnerOutPath: runnerOut })
    const verdict = evaluatePolicyEvidence({ expectedRunId: 'run-b', ...evidence })
    assert.equal(verdict.status, 'UNKNOWN')
    assert.equal(verdict.reason, 'decision_records_unclassifiable count=1')
    ok('an escaped JSON record key cannot hide an unclassifiable decision source')
  }

  {
    const unknownSourceDecisions = join(dir, 'unknown-source-decisions.jsonl')
    writeFileSync(unknownSourceDecisions, `${decision('2026-09-18T09:10:01.000Z', 'unrecognized-provider')}\n`)
    const counts = await countDecisionSources(
      unknownSourceDecisions,
      Date.parse('2026-09-18T09:10:00.000Z'),
      Date.parse('2026-09-18T09:10:05.000Z'),
      decisionScope(),
    )
    assert.deepEqual(
      { jev: counts.jevCount, fallback: counts.fallbackCount, other: counts.otherCount, unclassifiable: counts.unclassifiableCount },
      { jev: 0, fallback: 0, other: 1, unclassifiable: 1 },
    )
    ok('unknown in-window decision sources are explicitly unclassifiable')
  }

  {
    const startMs = Date.parse('2026-09-18T09:10:00.000Z')
    const endMs = Date.parse('2026-09-18T09:10:05.000Z')
    const timestamp = '2026-09-18T09:10:02.000Z'
    const rows = [
      ['timestamp-only legacy row', { record: 'decision', ts: timestamp, source: 'jev' }],
      ['missing runId', { record: 'decision', ts: timestamp, source: 'jev', generationId: 'g-b', sourceSha: SOURCE_SHA }],
      ['malformed runId', { ...JSON.parse(decision(timestamp, 'jev')), runId: ['run-b'] }],
      ['foreign runId', { ...JSON.parse(decision(timestamp, 'jev')), runId: 'run-a' }],
      ['missing generationId', { record: 'decision', ts: timestamp, source: 'jev', runId: 'run-b', sourceSha: SOURCE_SHA }],
      ['malformed generationId', { ...JSON.parse(decision(timestamp, 'jev')), generationId: 7 }],
      ['generation absent from host window', { ...JSON.parse(decision(timestamp, 'jev')), generationId: 'g-foreign' }],
      ['missing source SHA', { record: 'decision', ts: timestamp, source: 'jev', runId: 'run-b', generationId: 'g-b' }],
      ['malformed source SHA', { ...JSON.parse(decision(timestamp, 'jev')), sourceSha: 'not-a-sha' }],
      ['source SHA mismatch', { ...JSON.parse(decision(timestamp, 'jev')), sourceSha: 'c'.repeat(40) }],
    ]
    for (const [label, row] of rows) {
      const path = join(dir, `invalid-provenance-${label.replaceAll(/[^a-z0-9]+/gi, '-')}.jsonl`)
      writeFileSync(path, `${JSON.stringify(row)}\n`)
      const counts = await countDecisionSources(path, startMs, endMs, decisionScope())
      assert.equal(counts.jevCount, 0, `${label} cannot be counted as a Jev decision`)
      assert.equal(counts.unclassifiableCount, 1, `${label} must remain explicit uncertainty`)
      const evidence = await loadPolicyEvidence({ runId: 'run-b', decisionsPath: path, runnerOutPath: runnerOut })
      const verdict = evaluatePolicyEvidence({ expectedRunId: 'run-b', ...evidence })
      assert.equal(verdict.status, 'UNKNOWN', `${label} must not satisfy the policy gate`)
      assert.match(verdict.reason, /^decision_records_unclassifiable/)
    }
    const badGenerationScope = {
      ...decisionScope(),
      generations: [{ generationId: 'g-b', sourceSha: 'c'.repeat(40), tsMs: startMs + 1000 }],
    }
    const validDecisionPath = join(dir, 'wrong-host-generation-source.jsonl')
    writeFileSync(validDecisionPath, `${decision(timestamp, 'jev')}\n`)
    const badHostCounts = await countDecisionSources(validDecisionPath, startMs, endMs, badGenerationScope)
    assert.equal(badHostCounts.jevCount, 0)
    assert.equal(badHostCounts.unclassifiableCount, 1)
    const conflictingGenerationScope = {
      ...decisionScope(),
      generations: [
        { generationId: 'g-b', sourceSha: SOURCE_SHA, tsMs: startMs + 1000 },
        { generationId: 'g-b', sourceSha: 'c'.repeat(40), tsMs: startMs + 1500 },
      ],
    }
    const conflictingHostCounts = await countDecisionSources(validDecisionPath, startMs, endMs, conflictingGenerationScope)
    assert.equal(conflictingHostCounts.jevCount, 0)
    assert.equal(conflictingHostCounts.unclassifiableCount, 1, 'a duplicated/conflicting host generation id cannot join')
    ok('decision runId, source SHA, and generationId must join exact BOOT and host generation provenance')
  }

  {
    const duplicateKeyDecisions = join(dir, 'duplicate-record-key-decisions.jsonl')
    writeFileSync(
      duplicateKeyDecisions,
      [
        decision('2026-09-18T09:10:01.000Z', 'jev'),
        `{"rec\\u006frd":"decision","record":"other","ts":"2026-09-18T09:10:04.000Z","source":"fallback","runId":"run-b","generationId":"g-b","sourceSha":"${SOURCE_SHA}"}`,
        `{"record":"decision","ts":"2026-09-18T09:10:04.500Z","source":"jev","runId":"run-b","runId":"run-a","generationId":"g-b","sourceSha":"${SOURCE_SHA}"}`,
      ].join('\n') + '\n',
    )
    const evidence = await loadPolicyEvidence({ runId: 'run-b', decisionsPath: duplicateKeyDecisions, runnerOutPath: runnerOut })
    const verdict = evaluatePolicyEvidence({ expectedRunId: 'run-b', ...evidence })
    assert.equal(evidence.decisions.unclassifiableCount, 2)
    assert.equal(verdict.status, 'UNKNOWN')
    assert.equal(verdict.reason, 'decision_records_unclassifiable count=2')
    ok('duplicate escaped record or conflicting identity keys cannot hide a fallback or Jev row')
  }

  // Pure evaluator edges.
  {
    assert.equal(evaluatePolicyEvidence({}).reason, 'exact_run_scope_required')
    assert.ok(
      evaluatePolicyEvidence({ expectedRunId: 'run-x', decisions: { runId: 'run-x', jevCount: 1, fallbackCount: 0, otherCount: 0, unclassifiableCount: 0 }, generation: null }).reason.startsWith("generation_status_unavailable"),
    )
    assert.ok(
      evaluatePolicyEvidence({
        expectedRunId: 'run-x',
        decisions: { runId: 'run-x', jevCount: 1, fallbackCount: 0, otherCount: 0, unclassifiableCount: 0 },
        generation: { runId: 'run-x', policyKind: 'typesafe', policyModel: 'other-model' },
      }).reason.startsWith("policy_model_not_typesafe"),
    )
    assert.ok(
      evaluatePolicyEvidence({
        expectedRunId: 'run-x',
        decisions: { runId: 'run-x', jevCount: 1, fallbackCount: 0, otherCount: 0, unclassifiableCount: 0 },
        generation: { runId: 'run-x', policyKind: 'typesafe', policyModel: 'typesafe-ai/jev' },
      }).reason.startsWith('policy_provider_unverified'),
    )
    assert.ok(
      evaluatePolicyEvidence({
        expectedRunId: 'run-x',
        decisions: { runId: 'run-x', jevCount: 0, fallbackCount: 0, otherCount: 0, unclassifiableCount: 0 },
        generation: { runId: 'run-x', policyKind: 'typesafe', policyProvider: HOST_JEV_PROVIDER, policyModel: 'typesafe-ai/jev' },
      }).reason.startsWith("no_jev_decisions"),
    )
    assert.ok(
      evaluatePolicyEvidence({
        expectedRunId: 'run-x',
        decisions: { runId: 'run-y', jevCount: 5, fallbackCount: 0, otherCount: 0, unclassifiableCount: 0 },
        generation: { runId: 'run-y', policyKind: 'typesafe', policyModel: 'typesafe-ai/jev' },
      }).reason.startsWith("decisions_evidence_run_mismatch"),
    )
    assert.match(
      evaluatePolicyEvidence({
        expectedRunId: 'run-x',
        decisions: { runId: 'run-x', jevCount: 5, fallbackCount: 0, otherCount: 0, unclassifiableCount: 0 },
        generation: { runId: 'run-y', policyKind: 'typesafe', policyModel: 'typesafe-ai/jev' },
      }).reason,
      /^generation_run_mismatch/,
    )
    assert.equal(
      evaluatePolicyEvidence({
        expectedRunId: 'run-x',
        decisions: { runId: 'run-x', jevCount: 3, fallbackCount: 1, otherCount: 0, unclassifiableCount: 0 },
        generation: { runId: 'run-x', policyKind: 'typesafe', policyModel: 'typesafe-ai/jev' },
      }).reason,
      'fallback_decisions_present',
    )
    assert.equal(
      evaluatePolicyEvidence({
        expectedRunId: 'run-x',
        decisions: { runId: 'run-x', jevCount: 3, fallbackCount: 0, otherCount: 1, unclassifiableCount: 0 },
        generation: { runId: 'run-x', policyKind: 'typesafe', policyModel: 'typesafe-ai/jev' },
      }).reason,
      'unrecognized_decision_sources_present count=1',
    )
    assert.equal(
      evaluatePolicyEvidence({
        expectedRunId: 'run-x',
        decisions: { runId: 'run-x', jevCount: 3, fallbackCount: 0, unclassifiableCount: 0 },
        generation: { runId: 'run-x', policyKind: 'typesafe', policyModel: 'typesafe-ai/jev' },
      }).reason,
      'decision_source_counts_unavailable_or_invalid',
    )
    assert.equal(
      evaluatePolicyEvidence({
        expectedRunId: 'run-x',
        decisions: { runId: 'run-x', jevCount: 3, fallbackCount: 0, otherCount: 0 },
        generation: { runId: 'run-x', policyKind: 'typesafe', policyModel: 'typesafe-ai/jev' },
      }).reason,
      'decision_source_completeness_unavailable',
    )
    assert.equal(
      evaluatePolicyEvidence({
        expectedRunId: 'run-x',
        decisions: { runId: 'run-x', jevCount: 3, fallbackCount: 0, otherCount: 0, unclassifiableCount: 1 },
        generation: { runId: 'run-x', policyKind: 'typesafe', policyModel: 'typesafe-ai/jev' },
      }).reason,
      'decision_records_unclassifiable count=1',
    )
    assert.equal(
      evaluatePolicyEvidence({
        expectedRunId: 'run-x',
        decisions: { runId: 'run-x', jevCount: 3, otherCount: 0, unclassifiableCount: 0 },
        generation: { runId: 'run-x', policyKind: 'typesafe', policyModel: 'typesafe-ai/jev' },
      }).reason,
      'decision_source_counts_unavailable_or_invalid',
    )
    assert.equal(
      evaluatePolicyEvidence({
        expectedRunId: 'run-x',
        decisions: { runId: 'run-x', jevCount: 3, fallbackCount: 0, otherCount: 0, unclassifiableCount: Number.NaN },
        generation: { runId: 'run-x', policyKind: 'typesafe', policyModel: 'typesafe-ai/jev' },
      }).reason,
      'decision_source_completeness_unavailable',
    )
    assert.equal(
      evaluatePolicyEvidence({
        expectedRunId: 'run-x',
        decisions: { runId: 'run-x', jevCount: 3, fallbackCount: 0.5, otherCount: 0, unclassifiableCount: 0 },
        generation: { runId: 'run-x', policyKind: 'typesafe', policyModel: 'typesafe-ai/jev' },
      }).reason,
      'decision_source_counts_unavailable_or_invalid',
    )
    assert.equal(REQUIRED_POLICY_KIND, 'typesafe')
    assert.equal(REQUIRED_POLICY_MODEL, 'typesafe-ai/jev')
    ok('pure evaluator requires complete decision-source counts and refuses unknown/malformed/fallback evidence')
  }

  {
    const base = {
      expectedRunId: 'run-current',
      decisions: { runId: 'run-current', source: 'fixture', jevCount: 5, fallbackCount: 0, otherCount: 0, unclassifiableCount: 0 },
      generation: {
        runId: 'run-current', source: 'fixture', policyKind: 'typesafe', policyProvider: HOST_JEV_PROVIDER, policyModel: 'typesafe-ai/jev',
        plannerMode: 'llm', deterministicFallbackEnabled: false,
      },
      system2: {
        runId: 'run-current', source: 'fixture', count: 2, modelCount: 2, portalPlanCount: 1,
        identityStatus: 'verified', identityReason: null,
        effectiveProvider: 'model-provider', effectiveModel: 'model-v1',
      },
    }
    const pass = evaluateCurrentM2AuthorityEvidence(base)
    assert.equal(pass.code, 0)
    assert.equal(pass.reason, 'current_m2_authority_verified')
    assert.equal(evaluateCurrentM2AuthorityEvidence({ ...base, generation: { ...base.generation, plannerMode: 'deterministic' } }).reason, 'planner_not_llm observed=deterministic')
    assert.equal(evaluateCurrentM2AuthorityEvidence({ ...base, generation: { ...base.generation, deterministicFallbackEnabled: true } }).reason, 'deterministic_fallback_not_disabled observed=true')
    assert.equal(evaluateCurrentM2AuthorityEvidence({ ...base, system2: { ...base.system2, modelCount: 0 } }).reason, 'no_model_system2_authority_decision')
    assert.equal(evaluateCurrentM2AuthorityEvidence({ ...base, system2: { ...base.system2, portalPlanCount: 0 } }).reason, 'no_system2_portal_plan_decision')
    ok('current M2 requires llm planner, fallback disabled, and a model-authored portal plan')
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`m2-policy-evidence: ${checks}/${checks} checks passed`)
