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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { M2_GATE_SNAPSHOT_RECORD, scanRunLines } from './m2-gate.mjs'
import {
  M3_REQUIRED_CONDITIONS,
  M3_RUN_RESULT,
  evaluateEnderEyes,
  evaluateM3AuthorityEvidence,
  evaluateM3Gate,
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
const SOURCE_SHA = 'a'.repeat(40)
const OTHER_SOURCE_SHA = 'b'.repeat(40)
const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const exactSource = (runId = RUN, sourceSha = SOURCE_SHA) => ({
  status: 'exact',
  exact: true,
  runId,
  sourceSha,
  path: 'fixture',
  reloadCount: 0,
  sourceChangeCount: 0,
  reason: null,
})

const VERIFIED_POLICY = {
  decisions: { runId: RUN, source: 'fixture:decisions', jevCount: 3, fallbackCount: 0, otherCount: 0, unclassifiableCount: 0 },
  generation: {
    runId: RUN,
    source: 'fixture:generation',
    policyKind: 'typesafe',
    policyModel: 'typesafe-ai/jev',
    plannerMode: 'llm',
    deterministicFallbackEnabled: false,
  },
  system2: {
    runId: RUN, count: 1, modelCount: 1, identityStatus: 'verified', identityReason: null,
    effectiveProvider: 'fixture-model', effectiveModel: 'model-v1',
  },
}
const FALLBACK_POLICY = {
  decisions: { runId: RUN, source: 'fixture:decisions', jevCount: 0, fallbackCount: 3, otherCount: 0, unclassifiableCount: 0 },
  generation: {
    runId: RUN,
    source: 'fixture:generation',
    policyKind: 'fallback',
    policyModel: 'deterministic-local-fallback',
    plannerMode: 'deterministic',
    deterministicFallbackEnabled: true,
  },
}

const boot = (runId, sourceSha = SOURCE_SHA) => `[2026-09-20T10:00:00.000Z] BOOT pid=1 runId=${runId} bundle=none source=${sourceSha} worldEpoch=1`
const inv = (counts, pos = '10,64,20') => `[2026-09-20T10:00:01.000Z] INVENTORY items=${JSON.stringify(counts)} pos=${pos}`
// The real HEARTBEAT carries NO dimension field (0 occurrences in a live 75 MB log). The body's own
// dimension is reported by DIMENSION_OBSERVED / DIMENSION_TRANSITION (buddy-driver/dimension-observer.ts)
// and by SPAWN / DEATH. These helpers build those real shapes; the old fixture fed the dimension through
// HEARTBEAT, i.e. it tested evidence production never emits and hid a real false PASS.
const heartbeat = () => `[2026-09-20T10:00:01.500Z] HEARTBEAT pos=10,64,20 health=20 rung=enter_nether`
const dimensionObserved = (dimension, runId = RUN) =>
  `[2026-09-20T10:00:01.500Z] DIMENSION_OBSERVED dimension=${dimension} runId=${runId} reason=generation-start source=live-world`
const dimensionTransition = (to, runId = RUN) =>
  `[2026-09-20T10:00:01.700Z] DIMENSION_TRANSITION from=minecraft:overworld to=${to} dimension=${to} runId=${runId} reason=live-change source=live-world`

const PORTAL_CHAIN = [
  '[2026-09-20T10:00:02.000Z] PORTAL_BLOCK_PLACED pos=10,64,20',
  '[2026-09-20T10:00:03.000Z] PORTAL_FRAME_READY blocks=10 shape=ok',
  '[2026-09-20T10:00:04.000Z] PORTAL_LIT pos=11,65,20 dimension=minecraft:overworld',
  '[2026-09-20T10:00:05.000Z] PORTAL_VERIFIED=true',
]

const EYES_READY = inv({ ender_pearl: 12, blaze_rod: 7, blaze_powder: 14, ender_eye: 12 })
const MATERIALS_ONLY = inv({ ender_pearl: 12, blaze_rod: 7, blaze_powder: 14, ender_eye: 4 })
const FULL_RUN = [boot(RUN), dimensionTransition('minecraft:the_nether'), EYES_READY]
const currentObservation = (counts, runId = RUN, sourceSha = SOURCE_SHA, dimension = 'minecraft:the_nether') => {
  const observedAt = '2026-09-20T10:00:08.000Z'
  return {
    record: 'current-inventory-observation',
    schemaVersion: 1,
    runId,
    sourceSha,
    generationId: 'fixture-generation',
    observedAtMs: Date.parse(observedAt),
    observedAt,
    worldKey: { serverId: 'fixture', dimension, worldEpoch: 1 },
    dimension,
    counts,
  }
}

/** Build injected run-scoped evidence through the real M2 scanner (shared schema). */
function evidenceFrom(lines, runId = RUN) {
  const scanned = scanRunLines(runId, lines)
  if (scanned.status !== 'valid') {
    return { status: 'unknown', runId, sources: [], mismatches: [scanned.reason], reason: scanned.reason }
  }
  return {
    status: 'valid',
    runId,
    sourceSha: scanned.sourceSha,
    sourceShaReason: scanned.sourceShaReason,
    sources: [
      {
        name: 'fixture:log',
        path: 'fixture',
        portalEvents: scanned.portalEvents,
        inventorySamples: scanned.inventorySamples,
        dimensionObservations: scanned.dimensionObservations ?? [],
        dimensionTransitions: scanned.dimensionTransitions ?? [],
      },
    ],
    mismatches: [],
  }
}

async function judge({
  lines = FULL_RUN,
  expectedRunId = RUN,
  readEvidence,
  json = false,
  policyEvidence = VERIFIED_POLICY,
  acceptanceGitCommit = null,
} = {}) {
  // M3 acceptance requires a fresh HOST `report` observation of the inventory
  // held now. Derive a run-scoped fixture observation from the latest inventory
  // marker inside the requested BOOT window; historical samples alone cannot
  // make the gate PASS or FAIL.
  let activeRunId = null
  let runSourceSha = null
  let terminalCounts = null
  let terminalDimension = null
  for (const entry of lines) {
    const bootMatch = /\bBOOT\b.*\brunId=(run-[A-Za-z0-9-]+).*\bsource=([0-9a-f]{40})\b/i.exec(entry)
    if (bootMatch !== null) {
      activeRunId = bootMatch[1] ?? null
      runSourceSha = bootMatch[2]?.toLowerCase() ?? null
      continue
    }
    if (activeRunId !== expectedRunId) continue
    const inventoryMatch = /\bINVENTORY\s+items=(\{.*\})/.exec(entry)
    if (inventoryMatch !== null) {
      try { terminalCounts = JSON.parse(inventoryMatch[1] ?? '') } catch { terminalCounts = null }
    }
    const dimensionMatch = /\b(?:DIMENSION_OBSERVED|DIMENSION_TRANSITION|SPAWN|DEATH)\b.*\bdimension=(minecraft:[a-z_]+|[a-z_]+)/.exec(entry)
    if (dimensionMatch !== null) terminalDimension = dimensionMatch[1] ?? terminalDimension
  }
  const observedAt = '2026-09-20T10:00:20.000Z'
  const currentInventoryObservation = terminalCounts === null || expectedRunId === null
    ? null
    : {
        record: 'current-inventory-observation',
        schemaVersion: 1,
        runId: expectedRunId,
        sourceSha: runSourceSha,
        generationId: 'gen-test',
        observedAtMs: Date.parse(observedAt),
        observedAt,
        worldKey: { serverId: 'fixture', dimension: terminalDimension ?? 'minecraft:overworld', worldEpoch: 1 },
        dimension: terminalDimension ?? 'minecraft:overworld',
        counts: terminalCounts,
      }
  const out = capture()
  const dir = mkdtempSync(join(tmpdir(), 'm3-gate-source-'))
  const sourcePath = join(dir, 'runner.out')
  writeFileSync(sourcePath, `${lines.join('\n')}\n`)
  if (acceptanceGitCommit !== null) {
    writeFileSync(
      join(dir, `acceptance-${expectedRunId}.json`),
      JSON.stringify({ record: 'acceptance', runId: expectedRunId, gitCommit: acceptanceGitCommit }),
    )
  }
  try {
    const code = await runM3Gate({
      expectedRunId,
      readEvidence: readEvidence ?? (async () => evidenceFrom(lines, expectedRunId)),
      logPath: sourcePath,
      snapshotDir: dir,
      runnerOutPath: sourcePath,
      write: out.write,
      json,
      policyEvidence,
      policySocket: expectedRunId === null ? null : { runId: expectedRunId, currentInventoryObservation },
    })
    return { code, text: out.text(), lines: out.lines }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function runGateCli(args) {
  const child = Bun.spawnSync(['bun', join(TOOL_DIR, 'm3-gate.mjs'), ...args], {
    cwd: TOOL_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: child.exitCode,
    stdout: new TextDecoder().decode(child.stdout),
    stderr: new TextDecoder().decode(child.stderr),
  }
}

// ---------------------------------------------------------------------------
// 1. RED: the pure fact predicates
// ---------------------------------------------------------------------------
assert.equal(evaluateEnderEyes([{ ender_eye: 12 }]).ready, false, 'historical inventory cannot prove acceptance-time inventory')
assert.equal(evaluateEnderEyes([{ ender_eye: 12 }], { counts: { ender_eye: 12 } }).ready, true)
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
  const badSystem2Lineage = evaluateM3AuthorityEvidence({
    expectedRunId: RUN,
    ...VERIFIED_POLICY,
    system2: { ...VERIFIED_POLICY.system2, identityStatus: 'unknown', identityReason: 'decision generation mismatch' },
  })
  assert.match(badSystem2Lineage.reason, /^system2_generation_identity_unverified/, badSystem2Lineage.reason)
  const unknownSource = evaluateM3AuthorityEvidence({
    expectedRunId: RUN,
    decisions: { ...VERIFIED_POLICY.decisions, otherCount: 1 },
    generation: VERIFIED_POLICY.generation,
    system2: VERIFIED_POLICY.system2,
  })
  assert.equal(unknownSource.code, 2)
  assert.match(unknownSource.reason, /^unrecognized_decision_sources_present/, unknownSource.reason)
  const missingCounts = evaluateM3AuthorityEvidence({
    expectedRunId: RUN,
    decisions: { runId: RUN, jevCount: 1, fallbackCount: 0, unclassifiableCount: 0 },
    generation: VERIFIED_POLICY.generation,
    system2: VERIFIED_POLICY.system2,
  })
  assert.equal(missingCounts.code, 2)
  assert.equal(missingCounts.reason, 'decision_source_counts_unavailable_or_invalid')
  ok('M3 authority requires complete clean decision counts, consistent System2 lineage, and fallback disabled')
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
    /m3_facts: ender_pearl=12 blaze_rod=7 blaze_powder=14 ender_eye=12 ender_eye_max_observed=12 dimension=minecraft:the_nether/,
    text,
  )
  ok('same-run ender_eye>=12 + authority -> PASS/exit 0 (counts + dimension reported)')
}

{
  const changed = await judge({
    lines: [...FULL_RUN, '[2026-09-20T10:00:06.000Z] RELOAD ok=true trigger=source-changed hash=deadbeefcafe id=gen-2'],
  })
  assert.equal(changed.code, 2, changed.text)
  assert.match(changed.text, /m3_source: status=unknown reason=source_changing_reload_has_no_exact_git_sha/)
  assert.match(changed.text, /M3_RUN_RESULT status=UNKNOWN reason=run_source_not_exact/)
  assert.doesNotMatch(changed.text, /status=PASS/)
  const harmless = await judge({
    lines: [
      ...FULL_RUN,
      '[2026-09-20T10:00:06.000Z] RELOAD ok=true trigger=control skipped=unchanged',
      '[2026-09-20T10:00:07.000Z] RELOAD ok=false trigger=source-changed reason=compile_failed',
      `[2026-09-20T10:00:08.000Z] RELOAD runId=${OTHER_RUN} ok=true trigger=source-changed hash=foreignbundle id=foreign`,
    ],
  })
  assert.equal(harmless.code, 0, harmless.text)
  assert.match(harmless.text, /m3_source: status=exact reason=none reloads=2/)

  const mismatch = await judge({ acceptanceGitCommit: OTHER_SOURCE_SHA })
  assert.equal(mismatch.code, 2, mismatch.text)
  assert.match(mismatch.text, /acceptance_git_commit_mismatch/)
  assert.match(mismatch.text, /exact_source: UNKNOWN/)
  assert.doesNotMatch(mismatch.text, /status=PASS/)

  const invalidSha = await judge({ lines: FULL_RUN.map((line) => line.replace(SOURCE_SHA, 'deadbeef')) })
  assert.equal(invalidSha.code, 2, invalidSha.text)
  assert.match(invalidSha.text, /run_source_not_exact reason=run_boot_source_sha_invalid/)
  assert.match(invalidSha.text, /exact_source: UNKNOWN/)
  const restartedWithoutSha = await judge({ lines: [...FULL_RUN, '[2026-09-20T10:00:09.000Z] BOOT pid=2 runId=run-m3-a runtime=bun'] })
  assert.equal(restartedWithoutSha.code, 2, restartedWithoutSha.text)
  assert.match(restartedWithoutSha.text, /run_boot_source_sha_invalid/)
  ok('M3 source contract rejects changed/missing source, preserves unchanged/failed reloads, and checks acceptance provenance')
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
// 4b. normal CLI binds host predicates to the independent BOOT source SHA
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'm3-source-sha-'))
  try {
    const logPath = join(dir, 'buddy.log')
    const runnerOutPath = join(dir, 'runner.out')
    const decisionsPath = join(dir, 'decisions.jsonl')
    const controlSocketPath = join(dir, 'missing-control.sock')
    const predicatePath = join(dir, `milestone-predicates-${RUN}.json`)
    const runLog = [boot(RUN), inv({ ender_pearl: 0, blaze_rod: 0, blaze_powder: 0, ender_eye: 0 })]
    const runnerLog = [
      boot(RUN),
      `[2026-09-20T10:00:00.100Z] GENERATION_READY id=gen-test generationId=gen-test sourceSha=${SOURCE_SHA} buildHash=1234567890ab system2ConfiguredProvider=typesafe-ai system2ConfiguredModel=typesafe-ai/jev policy=typesafe model=typesafe-ai/jev planner=llm deterministicFallbackEnabled=false`,
      '[2026-09-20T10:01:00.000Z] HOST_LOCK released reason=fixture',
    ]
    const decisionLines = [JSON.stringify({
      record: 'decision', ts: '2026-09-20T10:00:01.000Z', source: 'jev', runId: RUN,
      generationId: 'gen-test', sourceSha: SOURCE_SHA,
    })]
    const observedPredicates = [
      { id: 'ender_eyes', satisfied: true, observedAtMs: 1, observedAt: new Date(1).toISOString(), source: 'host-observe:rung:ender_eyes', evidence: {} },
      { id: 'nether_reached', satisfied: true, observedAtMs: 2, observedAt: new Date(2).toISOString(), source: 'log:PORTAL_LIT', evidence: { dimension: 'minecraft:the_nether' } },
    ]
    writeFileSync(logPath, `${runLog.join('\n')}\n`)
    writeFileSync(runnerOutPath, `${runnerLog.join('\n')}\n`)
    writeFileSync(decisionsPath, `${decisionLines.join('\n')}\n`)
    writeFileSync(
      predicatePath,
      JSON.stringify({ record: 'milestone-predicates', schemaVersion: 1, runId: RUN, sourceSha: SOURCE_SHA, predicates: observedPredicates }),
    )

    const commonArgs = [
      '--run', RUN,
      '--log', logPath,
      '--snapshot-dir', dir,
      '--decisions', decisionsPath,
      '--runner-out', runnerOutPath,
      '--control-socket', controlSocketPath,
    ]
    const text = runGateCli(commonArgs)
    assert.equal(text.code, 2, `${text.stderr}\n${text.stdout}`)
    assert.match(text.stdout, new RegExp(`sourceSha: ${SOURCE_SHA}`), text.stdout)
    assert.match(text.stdout, new RegExp(`m3_predicates: runId=${RUN} sourceSha=${SOURCE_SHA}`), text.stdout)
    assert.match(text.stdout, /mismatches=unverified_nether_predicate_source_ignored/, text.stdout)
    assert.match(text.stdout, /nether_reached: UNKNOWN/, text.stdout)
    assert.match(text.stdout, /current_inventory_observation_missing/, text.stdout)

    const json = runGateCli([...commonArgs, '--json'])
    assert.equal(json.code, 2, `${json.stderr}\n${json.stdout}`)
    const parsed = JSON.parse(json.stdout)
    assert.equal(parsed.status, 'UNKNOWN')
    assert.equal(parsed.conditions.ender_eye_ready, 'UNKNOWN')
    assert.equal(parsed.conditions.exact_source, 'PASS')
    assert.equal(parsed.sourceSha, SOURCE_SHA)
    assert.equal(parsed.sourceExactness.status, 'exact')
    assert.equal(parsed.facts.sourceSha, SOURCE_SHA)
    assert.equal(parsed.facts.milestonePredicates.sourceSha, SOURCE_SHA)

    writeFileSync(
      runnerOutPath,
      `${[
        boot(RUN, OTHER_SOURCE_SHA),
        '[2026-09-20T10:00:00.100Z] GENERATION_READY policy=typesafe model=typesafe-ai/jev planner=llm deterministicFallbackEnabled=false',
      ].join('\n')}\n`,
    )
    const sourceStreamMismatch = runGateCli([...commonArgs, '--json'])
    const sourceStreamMismatchJson = JSON.parse(sourceStreamMismatch.stdout)
    assert.equal(sourceStreamMismatch.code, 2)
    assert.match(sourceStreamMismatchJson.reason, /source_stream_boot_sha_disagreement/)
    assert.equal(sourceStreamMismatchJson.conditions.exact_source, 'UNKNOWN')
    writeFileSync(runnerOutPath, `${runnerLog.join('\n')}\n`)

    writeFileSync(
      predicatePath,
      JSON.stringify({ record: 'milestone-predicates', schemaVersion: 1, runId: RUN, sourceSha: OTHER_SOURCE_SHA, predicates: observedPredicates }),
    )
    const mismatched = runGateCli([...commonArgs, '--json'])
    assert.equal(mismatched.code, 2, `${mismatched.stderr}\n${mismatched.stdout}`)
    const mismatchJson = JSON.parse(mismatched.stdout)
    assert.notEqual(mismatchJson.status, 'PASS')
    assert.ok(mismatchJson.facts.milestonePredicates.mismatches.some((reason) => reason.includes('source_sha_mismatch')))
    assert.equal(
      mismatchJson.facts.milestonePredicates.predicates.find((predicate) => predicate.id === 'ender_eyes').satisfied,
      false,
    )

    writeFileSync(
      predicatePath,
      JSON.stringify({ record: 'milestone-predicates', schemaVersion: 1, runId: RUN, sourceSha: null, predicates: observedPredicates }),
    )
    const missingPredicateSha = runGateCli([...commonArgs, '--json'])
    assert.equal(missingPredicateSha.code, 2, `${missingPredicateSha.stderr}\n${missingPredicateSha.stdout}`)
    const missingPredicateJson = JSON.parse(missingPredicateSha.stdout)
    assert.notEqual(missingPredicateJson.status, 'PASS')
    assert.ok(missingPredicateJson.facts.milestonePredicates.mismatches.some((reason) => reason.includes('source_sha_missing')))
    assert.equal(
      missingPredicateJson.facts.milestonePredicates.predicates.find((predicate) => predicate.id === 'ender_eyes').satisfied,
      false,
    )

    const noSourceRun = 'run-m3-no-source'
    const noSourceLogPath = join(dir, 'no-source.log')
    const noSourceRunnerOutPath = join(dir, 'no-source-runner.out')
    const noSourceDecisionsPath = join(dir, 'no-source-decisions.jsonl')
    const noSourceBoot = `[2026-09-20T10:00:00.000Z] BOOT pid=1 runId=${noSourceRun} bundle=none worldEpoch=1`
    writeFileSync(
      noSourceLogPath,
      `${[
        noSourceBoot,
        dimensionTransition('minecraft:the_nether', noSourceRun),
        inv({ ender_pearl: 12, blaze_rod: 7, blaze_powder: 14, ender_eye: 12 }),
      ].join('\n')}\n`,
    )
    writeFileSync(
      noSourceRunnerOutPath,
      `${[
        noSourceBoot,
        '[2026-09-20T10:00:00.100Z] GENERATION_READY policy=typesafe model=typesafe-ai/jev planner=llm deterministicFallbackEnabled=false',
        '[2026-09-20T10:01:00.000Z] HOST_LOCK released reason=fixture',
      ].join('\n')}\n`,
    )
    writeFileSync(noSourceDecisionsPath, `${decisionLines.join('\n')}\n`)
    const unavailable = runGateCli([
      '--run', noSourceRun,
      '--log', noSourceLogPath,
      '--snapshot-dir', dir,
      '--decisions', noSourceDecisionsPath,
      '--runner-out', noSourceRunnerOutPath,
      '--control-socket', controlSocketPath,
      '--json',
    ])
    assert.equal(unavailable.code, 2, `${unavailable.stderr}\n${unavailable.stdout}`)
    const unavailableJson = JSON.parse(unavailable.stdout)
    assert.equal(unavailableJson.status, 'UNKNOWN')
    assert.match(unavailableJson.reason, /run_source_not_exact reason=run_boot_source_sha_invalid/)
    assert.equal(unavailableJson.sourceSha, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  ok('normal --run CLI binds matching BOOT/predicate SHA, rejects mismatch, and cannot replace terminal inventory with historical predicates')
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
  // Run A has only 4 pearls; run B proves the full 12 eyes and independently
  // logs its body transition. The cross-run negative below is about run binding.
  const mixed = [boot(RUN), inv({ ender_pearl: 4 }), boot(OTHER_RUN), dimensionTransition('minecraft:the_nether', OTHER_RUN), EYES_READY]
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
      system2: { ...VERIFIED_POLICY.system2, runId: OTHER_RUN },
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
    policySocket: { runId: RUN, currentInventoryObservation: currentObservation({ ender_eye: 12 }) },
    write: out.write,
  })
  assert.equal(code, 2, out.text())
  assert.match(out.text(), /status=UNKNOWN reason=evidence_run_mismatch/, out.text())
  assert.doesNotMatch(out.text(), /status=PASS/)
  ok('an injected evidence bundle naming another run cannot PASS')
}

{
  // A missing scope is just as unsafe as a different scope: otherwise a
  // caller-provided bundle can borrow this run's source SHA and terminal report
  // while supplying another run's inventory and BODY transition.
  const unscopedEvidence = evidenceFrom([boot(RUN), dimensionTransition('minecraft:the_nether'), EYES_READY])
  delete unscopedEvidence.runId
  const result = evaluateM3Gate({
    expectedRunId: RUN,
    evidence: unscopedEvidence,
    policy: { code: 0, status: 'VERIFIED', reason: 'fixture-policy-pass' },
    currentInventoryObservation: currentObservation({ ender_eye: 12 }),
    sourceExactness: exactSource(),
  })
  assert.equal(result.status, 'UNKNOWN')
  assert.equal(result.reason, `evidence_run_mismatch expected=${RUN} observed=unknown`)
  assert.notEqual(result.status, 'PASS')
  ok('an injected evidence bundle with missing runId cannot PASS')
}

// ---------------------------------------------------------------------------
// 7. RED: a run-scoped snapshot must be bound to both runId and BOOT source SHA
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'm3-gate-'))
  const snapshot = {
    schemaVersion: 1,
    record: M2_GATE_SNAPSHOT_RECORD,
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
  const sourceLog = join(dir, 'source.log')
  writeFileSync(sourceLog, `${boot(RUN)}\n`)
  const out = capture()
  const code = await runM3Gate({
    expectedRunId: RUN,
    readEvidence: null,
    logPath: sourceLog,
    runnerOutPath: sourceLog,
    snapshotDir: dir,
    policyEvidence: VERIFIED_POLICY,
    write: out.write,
  })
  assert.equal(code, 2, out.text())
  assert.match(out.text(), /m3_evidence: valid sources=snapshot/, out.text())
  assert.match(out.text(), new RegExp(`sourceSha: ${SOURCE_SHA}`), out.text())
  assert.match(out.text(), /status=UNKNOWN/, out.text())
  assert.match(out.text(), /run_evidence_source_sha_unverified reason=run_source_sha_snapshot_mismatch/, out.text())

  const terminalObservation = {
    record: 'current-inventory-observation',
    schemaVersion: 1,
    runId: RUN,
    sourceSha: SOURCE_SHA,
    generationId: 'fixture-generation',
    observedAtMs: Date.parse('2026-09-20T10:00:08.000Z'),
    observedAt: '2026-09-20T10:00:08.000Z',
    worldKey: { serverId: 'fixture', dimension: 'minecraft:the_nether', worldEpoch: 1 },
    dimension: 'minecraft:the_nether',
    counts: { ender_eye: 12 },
  }
  writeFileSync(join(dir, `m2-snapshot-${RUN}.json`), JSON.stringify({ ...snapshot, bootSourceSha: SOURCE_SHA }))
  const current = capture()
  const currentCode = await runM3Gate({
    expectedRunId: RUN,
    logPath: sourceLog,
    runnerOutPath: sourceLog,
    snapshotDir: dir,
    policyEvidence: VERIFIED_POLICY,
    policySocket: { runId: RUN, currentInventoryObservation: terminalObservation },
    write: current.write,
  })
  assert.equal(currentCode, 2, current.text())
  assert.match(current.text(), /nether_reached: UNKNOWN/, current.text())
  assert.match(current.text(), /m3_stages_incomplete:nether_reached/, current.text())
  assert.doesNotMatch(current.text(), /status=PASS/)

  // The same run and log SHA do not validate a snapshot copied from another
  // source revision either; inventory and Nether evidence from it stay unusable.
  writeFileSync(join(dir, `m2-snapshot-${RUN}.json`), JSON.stringify({ ...snapshot, bootSourceSha: OTHER_SOURCE_SHA }))
  const mismatched = capture()
  const mismatchedCode = await runM3Gate({
    expectedRunId: RUN,
    logPath: sourceLog,
    runnerOutPath: sourceLog,
    snapshotDir: dir,
    policyEvidence: VERIFIED_POLICY,
    policySocket: { runId: RUN, currentInventoryObservation: terminalObservation },
    write: mismatched.write,
  })
  assert.equal(mismatchedCode, 2, mismatched.text())
  assert.match(mismatched.text(), /run_evidence_source_sha_unverified reason=run_source_sha_snapshot_mismatch/, mismatched.text())
  assert.doesNotMatch(mismatched.text(), /status=PASS/)

  // Positive control: the exact same snapshot is acceptable once it attests to
  // the source SHA independently observed in the BOOT log.
  writeFileSync(join(dir, `m2-snapshot-${RUN}.json`), JSON.stringify({ ...snapshot, bootSourceSha: SOURCE_SHA }))
  const bound = capture()
  writeFileSync(sourceLog, `${boot(RUN)}\n${dimensionTransition('minecraft:the_nether')}\n`)
  const boundCode = await runM3Gate({
    expectedRunId: RUN,
    logPath: sourceLog,
    runnerOutPath: sourceLog,
    snapshotDir: dir,
    policyEvidence: VERIFIED_POLICY,
    policySocket: { runId: RUN, currentInventoryObservation: terminalObservation },
    write: bound.write,
  })
  assert.equal(boundCode, 0, bound.text())
  assert.match(bound.text(), /status=PASS/, bound.text())

  // A file named for another run but carrying RUN's body is never attributed.
  writeFileSync(join(dir, `m2-snapshot-${OTHER_RUN}.json`), JSON.stringify({ ...snapshot, runId: RUN }))
  const out2 = capture()
  const code2 = await runM3Gate({
    expectedRunId: OTHER_RUN,
    readEvidence: null,
    logPath: join(dir, 'absent.log'),
    runnerOutPath: join(dir, 'absent-runner.out'),
    snapshotDir: dir,
    policyEvidence: {
      ...VERIFIED_POLICY,
      decisions: { ...VERIFIED_POLICY.decisions, runId: OTHER_RUN },
      generation: { ...VERIFIED_POLICY.generation, runId: OTHER_RUN },
      system2: { ...VERIFIED_POLICY.system2, runId: OTHER_RUN },
    },
    write: out2.write,
  })
  assert.equal(code2, 2, out2.text())
  assert.doesNotMatch(out2.text(), /status=PASS/)
  ok('a portal dimension in the same-source snapshot cannot prove Nether arrival; a logged live body transition can')
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
  const dir = mkdtempSync(join(tmpdir(), 'm3-live-source-'))
  const sourcePath = join(dir, 'runner.out')
  writeFileSync(sourcePath, `${FULL_RUN.join('\n')}\n`)
  try {
    const code = await runLiveGate({
      argv: ['--run', RUN, '--log', sourcePath, '--runner-out', sourcePath, '--snapshot-dir', dir],
      env: {},
      readEvidence: async (runId) => {
        assert.equal(runId, RUN)
        return evidenceFrom(FULL_RUN)
      },
      policyEvidence: VERIFIED_POLICY,
      policySocket: { runId: RUN, currentInventoryObservation: currentObservation({ ender_eye: 12 }) },
      write: out.write,
    })
    assert.equal(code, 0, out.text())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.match(out.text(), new RegExp(`M3_LIVE_GATE current=${CURRENT_M3} runId=${RUN}`), out.text())
  assert.match(out.text(), new RegExp(`M3_LIVE_RESULT status=PASS reason=twelve_eyes_of_ender_verified runId=${RUN}`), out.text())
  ok('live gate delegates the run-scoped M3 verdict')
}

// ---------------------------------------------------------------------------
// 10. FIRST-CLASS predicate evidence: true can upgrade, false/UNKNOWN cannot
// ---------------------------------------------------------------------------
{
  const shortRun = [boot(RUN), inv({ ender_pearl: 0, blaze_rod: 0, blaze_powder: 0, ender_eye: 0 })]
  const evidence = evidenceFrom(shortRun)
  const policy = evaluateM3AuthorityEvidence({ expectedRunId: RUN, ...VERIFIED_POLICY })
  const terminal = currentObservation({ ender_pearl: 0, blaze_rod: 0, blaze_powder: 0, ender_eye: 12 })
  const base = evaluateM3Gate({ expectedRunId: RUN, evidence, policy, currentInventoryObservation: terminal, sourceExactness: exactSource() })
  assert.equal(base.status, 'UNKNOWN')
  assert.equal(base.conditions.ender_eye_ready, 'PASS')
  assert.equal(base.conditions.nether_reached, 'UNKNOWN')
  // The gate always carries a first-class predicate section, derived from its own
  // run-scoped evidence when the caller did not supply one.
  assert.ok(base.facts.milestonePredicates !== null)
  assert.equal(base.facts.milestonePredicates.predicates.length, 7)
  assert.equal(base.facts.milestonePredicates.predicates.find((p) => p.id === 'ender_eyes').satisfied, false)
  assert.equal(base.facts.milestonePredicates.predicates.find((p) => p.id === 'nether_reached').satisfied, null)
  ok('with no observation the gate derives a full predicate section and stays UNKNOWN')

  const section = {
    runId: RUN,
    sourceSha: SOURCE_SHA,
    observationSources: ['host-observe'],
    missing: [],
    mismatches: [],
    predicates: [
      { id: 'ender_eyes', satisfied: true, observedAtMs: 1, observedAt: new Date(1).toISOString(), source: 'host-observe:rung:ender_eyes', evidence: {} },
      { id: 'nether_reached', satisfied: true, observedAtMs: 2, observedAt: new Date(2).toISOString(), source: 'host-observe:rung:enter_nether', evidence: {} },
    ],
  }
  const unbackedUpgrade = evaluateM3Gate({ expectedRunId: RUN, evidence, policy, dimensions: ['minecraft:the_nether'], milestonePredicates: section, currentInventoryObservation: terminal, sourceExactness: exactSource() })
  assert.equal(unbackedUpgrade.status, 'UNKNOWN', 'a sticky predicate cannot replace the required body transition')
  assert.equal(unbackedUpgrade.conditions.nether_reached, 'UNKNOWN')
  assert.equal(unbackedUpgrade.facts.milestonePredicates.predicates.find((p) => p.id === 'nether_reached').satisfied, null)
  assert.ok(unbackedUpgrade.facts.milestonePredicates.mismatches.includes('unverified_nether_predicate_source_ignored'))
  const injectedTransition = evaluateM3Gate({
    expectedRunId: RUN,
    evidence,
    policy,
    dimensionTransitions: [
      { from: 'minecraft:overworld', to: 'minecraft:the_nether', dimension: 'minecraft:the_nether', atMs: 2, source: 'live-world' },
    ],
    currentInventoryObservation: terminal,
    sourceExactness: exactSource(),
  })
  assert.equal(injectedTransition.conditions.nether_reached, 'UNKNOWN', 'the pure verdict consumes transitions from its run-scoped evidence source only')
  const evidenceWithTransition = evidenceFrom([
    boot(RUN),
    dimensionTransition('minecraft:the_nether'),
    inv({ ender_pearl: 0, blaze_rod: 0, blaze_powder: 0, ender_eye: 0 }),
  ])
  const upgraded = evaluateM3Gate({ expectedRunId: RUN, evidence: evidenceWithTransition, policy, milestonePredicates: section, currentInventoryObservation: terminal, sourceExactness: exactSource() })
  assert.equal(upgraded.status, 'PASS', 'a truly observed predicate is sufficient proof')
  assert.equal(upgraded.conditions.ender_eye_ready, 'PASS')
  assert.equal(upgraded.conditions.nether_reached, 'PASS')
  ok('a same-run body transition plus a bound true predicate upgrades nether_reached')

  const falseSection = {
    ...section,
    predicates: [
      { id: 'ender_eyes', satisfied: false, observedAtMs: 1, observedAt: new Date(1).toISOString(), source: 'host-observe:rung:ender_eyes', evidence: {} },
      { id: 'nether_reached', satisfied: null, observedAtMs: null, observedAt: null, source: null, evidence: {} },
    ],
  }
  const notUpgraded = evaluateM3Gate({ expectedRunId: RUN, evidence, policy, milestonePredicates: falseSection, currentInventoryObservation: terminal, sourceExactness: exactSource() })
  assert.notEqual(notUpgraded.status, 'PASS')
  assert.equal(notUpgraded.conditions.ender_eye_ready, 'PASS')
  assert.equal(notUpgraded.conditions.nether_reached, 'UNKNOWN')

  const wrongSourceSection = { ...section, sourceSha: OTHER_SOURCE_SHA }
  const wrongSource = evaluateM3Gate({ expectedRunId: RUN, evidence, policy, milestonePredicates: wrongSourceSection, currentInventoryObservation: terminal, sourceExactness: exactSource() })
  assert.notEqual(wrongSource.status, 'PASS')
  assert.equal(wrongSource.conditions.ender_eye_ready, 'PASS')
  assert.ok(wrongSource.facts.milestonePredicates.mismatches.some((reason) => reason.includes('source_sha_mismatch')))
  ok('false / UNKNOWN predicate evidence can never manufacture a PASS')
}

// ---------------------------------------------------------------------------
// 11. The resident observation file is read by runId and reported in the output
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'm3-predicates-'))
  try {
    const sourceLog = join(dir, 'source.log')
    writeFileSync(sourceLog, `${boot(RUN)}\n${dimensionTransition('minecraft:the_nether')}\n`)
    writeFileSync(
      join(dir, `milestone-predicates-${RUN}.json`),
      JSON.stringify({
        record: 'milestone-predicates',
        schemaVersion: 1,
        runId: RUN,
        sourceSha: SOURCE_SHA,
        generationId: 'gen-1',
        observationCount: 7,
        updatedAt: new Date(7).toISOString(),
        predicates: [
          { id: 'ender_eyes', satisfied: true, observedAtMs: 1, observedAt: new Date(1).toISOString(), source: 'host-observe:rung:ender_eyes', evidence: {} },
          { id: 'nether_reached', satisfied: true, observedAtMs: 2, observedAt: new Date(2).toISOString(), source: 'host-observe:rung:enter_nether', evidence: {} },
        ],
      }),
    )
    const out = capture()
    const code = await runM3Gate({
      expectedRunId: RUN,
      readEvidence: async () => evidenceFrom([boot(RUN), dimensionTransition('minecraft:the_nether'), inv({ ender_pearl: 0, blaze_rod: 0, ender_eye: 0 })]),
      policyEvidence: VERIFIED_POLICY,
      policySocket: { runId: RUN, currentInventoryObservation: currentObservation({ ender_eye: 12 }) },
      logPath: sourceLog,
      runnerOutPath: sourceLog,
      snapshotDir: dir,
      write: out.write,
    })
    assert.equal(code, 0, out.text())
    assert.match(out.text(), /m3_predicates: runId=run-m3-a .*observed=4\/7 missing=portal_built,portal_lit,portal_verified/, out.text())
    assert.match(out.text(), /m3_predicate ender_eyes: PASS at=.* source=host-observe:rung:ender_eyes/, out.text())

    // A foreign run's observation file must not be attributed to R.
    const foreign = capture()
    const foreignCode = await runM3Gate({
      expectedRunId: RUN,
      readEvidence: async () => evidenceFrom([boot(RUN), dimensionTransition('minecraft:the_nether'), inv({ ender_pearl: 0, blaze_rod: 0, ender_eye: 0 })]),
      policyEvidence: VERIFIED_POLICY,
      logPath: sourceLog,
      runnerOutPath: sourceLog,
      snapshotDir: join(dir, 'absent'),
      write: foreign.write,
    })
    assert.notEqual(foreignCode, 0)
    assert.doesNotMatch(foreign.text(), /status=PASS/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  ok('the gate reads the run-scoped resident predicate file and reports it; a missing file keeps UNKNOWN')
}

// ---------------------------------------------------------------------------
// 2b. RED: only the BODY's own dimension evidence may prove nether_reached
// ---------------------------------------------------------------------------
{
  // Measured live false PASS (2026-09-22, run-muc620xb-1d312): the run never left the overworld, but its own
  // window contained `PORTAL_ENTRY_UNVERIFIED ... enter=26,67,9 dimension=minecraft:the_nether expected=6` - a
  // route TARGET naming the dimension it wanted to reach - and the old loose `dimension=` scan counted it as an
  // observation, so the gate reported `nether_reached: PASS at=unavailable source=log:dimension`. A gate that can
  // manufacture Nether arrival from a plan description would let M3 be declared without ever leaving the overworld.
  const routeTargetOnly = [
    boot(RUN),
    inv({ ender_pearl: 12, blaze_rod: 7, blaze_powder: 14, ender_eye: 12 }),
    '[2026-09-20T10:00:02.000Z] PORTAL_ENTRY_UNVERIFIED reason=site_not_observed site=25,66,9 enter=26,67,9 dimension=minecraft:the_nether expected=6',
  ]
  const asTarget = await judge({ lines: routeTargetOnly })
  assert.match(asTarget.text, /nether_reached: UNKNOWN/, asTarget.text)
  assert.notEqual(asTarget.code, 0)
  assert.doesNotMatch(asTarget.text, /status=PASS/)

  // A portal that LIVES in the Nether is still not the body's own observation (PORTAL_LIT/PORTAL_VERIFIED and the
  // structure/site markers all carry the dimension of the thing they describe).
  const portalInNetherOnly = [
    boot(RUN),
    inv({ ender_pearl: 12, blaze_rod: 7, blaze_powder: 14, ender_eye: 12 }),
    '[2026-09-20T10:00:03.000Z] PORTAL_LIT pos=2,65,0 dimension=minecraft:the_nether',
  ]
  const asPortal = await judge({ lines: portalInNetherOnly })
  assert.match(asPortal.text, /nether_reached: UNKNOWN/, asPortal.text)

  const foreignTransitionOnly = [
    boot(RUN),
    inv({ ender_pearl: 12, blaze_rod: 7, blaze_powder: 14, ender_eye: 12 }),
    dimensionTransition('minecraft:the_nether', OTHER_RUN),
  ]
  const asForeignTransition = await judge({ lines: foreignTransitionOnly })
  assert.equal(asForeignTransition.code, 2, asForeignTransition.text)
  assert.match(asForeignTransition.text, /nether_reached: UNKNOWN/, asForeignTransition.text)
  assert.match(asForeignTransition.text, /m3_stages_incomplete:nether_reached/, asForeignTransition.text)
  assert.doesNotMatch(asForeignTransition.text, /status=PASS/)

  // A generation that starts in the Nether has only a current-location
  // observation, not an observed transition into the dimension.
  const spawnedInNether = [
    boot(RUN),
    inv({ ender_pearl: 12, blaze_rod: 7, blaze_powder: 14, ender_eye: 12 }),
    '[2026-09-20T10:00:04.000Z] SPAWN pos=2.5,65.0,0.5 health=20 username=AI_Buddy dimension=minecraft:the_nether worldEpoch=1',
  ]
  const asSpawn = await judge({ lines: spawnedInNether })
  assert.match(asSpawn.text, /nether_reached: UNKNOWN/, asSpawn.text)
  assert.equal(asSpawn.code, 2, asSpawn.text)
  assert.doesNotMatch(asSpawn.text, /status=PASS/, asSpawn.text)
  ok('Nether location-only evidence cannot replace an independently logged body transition')
}

console.log(`m3-gate-test ${checks}/${checks} PASS`)
