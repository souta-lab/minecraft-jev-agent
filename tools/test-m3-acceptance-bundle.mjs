#!/usr/bin/env bun
// test-m3-acceptance-bundle: OFFLINE fixtures for tools/m3-acceptance-bundle.mjs.
//
// Every fixture below is a SYNTHETIC resident tree (packages/buddy-driver/buddy.log,
// packages/buddy-driver/runner.out, packages/buddy-driver/logs/jev/decisions.jsonl,
// packages/buddy-driver/data/resident/acceptance-<runId>.json). No live resident, no
// socket, no network:
//   * `noControlSocket: true` is passed everywhere, so not even the read-only
//     `report` probe runs;
//   * `evidenceClass: 'fixture'` (or 'undeclared') everywhere, so a synthetic PASS
//     can never be reported as a live acceptance.
//
// What is pinned:
//   A. a PASS-shaped synthetic run -> exit 0 only when both M3 and same-run,
//      exact-source M2 gates PASS; gate/artifact conditions agree and liveAcceptance
//      stays false;
//   B. the same run declared `--evidence-class live` -> liveAcceptance is STILL
//      false, because the objective live signals do not hold (synthetic tree);
//   C. a MISSING HOST acceptance record -> the evidence class is stated precisely
//      (writer + triggers + what it attests), the run is still decidable, and
//      `--require-acceptance` makes it a loud blocking gap (exit 2);
//   D. an operator decision scoped to ANOTHER runId -> its inherited premise cannot
//      replace this run's M2 PASS, even when M3 itself PASSes;
//   E. a decision scoped to THIS run whose basis the gate corroborates -> the
//      premise says inherit, but the delegated M2 UNKNOWN still blocks acceptance;
//   E2. M2 UNKNOWN, FAIL, wrong runId, wrong source SHA, or evaluator/wrapper
//      disagreement all block acceptance even when the M3 gate PASSes;
//   F. an injected gate that contradicts the canonical gate -> the bundle reports
//      the CONTRADICTION, marks the condition UNKNOWN and exits 2 (never
//      reconciled towards PASS);
//   G. a tree with no log -> the bundle fails loudly (M3_BUNDLE_INPUT_MISSING) and
//      still writes the bundle;
//   H. CLI surface: --help exit 0, a missing --run exit 2 with a bundle.
//
// Usage: bun tools/test-m3-acceptance-bundle.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAcceptanceBundle, evaluateRequiredM3ArtifactEvidence } from './m3-acceptance-bundle.mjs'
import { runM2Gate } from './m2-gate.mjs'
import { runM3Gate } from './m3-gate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOL = join(HERE, 'm3-acceptance-bundle.mjs')
const ROOTS = []

let checks = 0
function ok(label) {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

const T0 = Date.parse('2026-09-22T10:00:00.000Z')
const at = (sec) => new Date(T0 + sec * 1000).toISOString()
const line = (sec, body) => `[${at(sec)}] ${body}`
const SOURCE_SHA = 'cd7b38b70da61c2883b9a1dc14b34a70a732a88a'
const GENERATION_ID = 'gen-test-1'
const BUILD_HASH = 'e6be1812c804'
const SYSTEM2_CONFIG = 'configuredProvider=typesafe-ai configuredModel=typesafe-ai/jev'
const SYSTEM2_IDENTITY = `generationId=${GENERATION_ID} sourceSha=${SOURCE_SHA} buildHash=${BUILD_HASH} ${SYSTEM2_CONFIG} trigger=queue_empty`
const WORLD_KEY = '{"serverId":"127.0.0.1:25565","dimension":"minecraft:overworld","worldEpoch":1}'
const RUN = 'run-fixture-bundle'

const boot = (sec, runId) =>
  line(
    sec,
    `BOOT pid=4242 runId=${runId} source=${SOURCE_SHA} runtime=bun runtimeVersion=1.4.2 bundle=none ` +
      `milestone=null generations=0 reloads=0 contractVersion=3 schemaVersion=3 revision=1 worldEpoch=1 worldKey=${WORLD_KEY}`,
  )

const PORTAL_CHAIN = [
  'PORTAL_BLOCK_PLACED pos=1,64,0',
  'PORTAL_BLOCK_PLACED pos=2,64,0',
  'PORTAL_FRAME_READY blocks=10 shape=ok',
  'PORTAL_LIT pos=2,65,0 dimension=minecraft:overworld',
  'PORTAL_VERIFIED=true',
]

/** runner.out-shaped authority window; a release line brackets its decisions. */
function runnerOut(runId, { decisions = [`SYSTEM2_AUTHORITY_DECISION ${SYSTEM2_IDENTITY} provider=typesafe-ai model=typesafe-ai/jev chosen=front_nether_portal`] } = {}) {
  const withInputs = decisions.flatMap((decision, index) => {
    const requestId = `bundle-plan-${runId}-${index}`
    const fields = ['generationId', 'sourceSha', 'buildHash', 'configuredProvider', 'configuredModel', 'trigger', 'provider', 'model']
      .map((key) => [key, new RegExp(`\\b${key}=(\\S+)`).exec(decision)?.[1] ?? null])
      .filter(([, value]) => value !== null)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')
    const hostIdentity = `runId=${runId} requestId=${requestId} ${fields}`
    const op = /\bop=(\S+)/.exec(decision)?.[1] ?? 'patch'
    return [
      line(1.5 + index * 0.2, `SYSTEM2_AUTHORITY_INPUT ${hostIdentity}`),
      line(2 + index * 0.2, `${decision} ${hostIdentity}`),
      line(2.1 + index * 0.2, `SYSTEM2_PLAN_APPLIED ${hostIdentity} op=${op} accepted=true applied=${op === 'patch' || op === 'replace' ? 1 : 0}`),
    ]
  })
  return (
    [
      boot(0, runId),
      line(
        1,
        `GENERATION_READY runId=${runId} id=${GENERATION_ID} generationId=${GENERATION_ID} sourceSha=${SOURCE_SHA} buildHash=${BUILD_HASH} ` +
          'system2ConfiguredProvider=typesafe-ai system2ConfiguredModel=typesafe-ai/jev rungIndex=13 rungId=nether_portal ' +
          'policy=typesafe policyProvider=typesafe-ai model=typesafe-ai/jev policyModel=typesafe-ai/jev ' +
          'system2AuthorityStack={"provider":"hybrid","model":"typesafe-ai:typesafe-ai/jev"} ' +
          'system2LastAuthority={"provider":"none","model":"none"} deterministicFallbackEnabled=false ' +
          'planner=llm plannerModel=typesafe-ai/jev',
      ),
      ...withInputs,
      line(3 + decisions.length * 0.2, `HOST_LOCK released runId=${runId}`),
    ].join('\n') + '\n'
  )
}

const DECISIONS = `${JSON.stringify({
  record: 'decision', ts: at(2), source: 'jev', runId: RUN,
  generationId: GENERATION_ID, sourceSha: SOURCE_SHA,
  jev: { provider: 'typesafe-ai', model: 'typesafe-ai/jev' }, action: 'GOTO:nether_portal',
})}\n`

const ACCEPTANCE = (runId) =>
  JSON.stringify({
    record: 'acceptance',
    runId,
    ts: at(40),
    gitCommit: SOURCE_SHA,
    generationHash: 'e6be1812c804',
    contractVersion: 3,
    stateSchemaVersion: 3,
    worldEpoch: 1,
    serverId: '127.0.0.1:25565',
    dimension: 'minecraft:overworld',
    mode: 'llm',
  })

/** A complete-looking synthetic run whose terminal eye count varies. */
function fullLog(runId, { terminalEye, materials = true }) {
  const inputs = materials
    ? '"ender_pearl":12,"blaze_rod":8,"blaze_powder":16,"ender_eye":0'
    : '"ender_eye":0'
  return [
    boot(0, runId),
    line(1, 'SPAWN pos=0.5,64.0,0.5 version=1.21.11 health=20 username=AI_Buddy dimension=minecraft:overworld worldEpoch=1'),
    line(2, 'ENVIRONMENT difficulty=normal spawnMonsters=true spawnAnimals=true spawnMobs=true advanceTime=false'),
    line(10, `INVENTORY items={"diamond":3,"diamond_pickaxe":1,"flint_and_steel":1,"obsidian":10,${inputs}} pos=0.5,64.0,0.5`),
    ...PORTAL_CHAIN.map((body, index) => line(11 + index, body)),
    line(19, 'DIMENSION_TRANSITION from=minecraft:overworld to=minecraft:the_nether dimension=minecraft:the_nether reason=live-change source=live-world'),
    line(30, `INVENTORY items={"ender_eye":${terminalEye},"ender_pearl":0,"blaze_rod":0,"blaze_powder":0} pos=0.5,64.0,0.5`),
  ]
}

function makeRoot(name) {
  const root = mkdtempSync(join(tmpdir(), `m3-bundle-${name}-`))
  ROOTS.push(root)
  mkdirSync(join(root, 'packages/buddy-driver', 'data', 'resident'), { recursive: true })
  mkdirSync(join(root, 'packages/buddy-driver', 'logs', 'jev'), { recursive: true })
  return root
}

function writeFixture(root, runId, { logLines, acceptance = true, runner = {} }) {
  writeFileSync(join(root, 'packages/buddy-driver', 'buddy.log'), `${logLines.join('\n')}\n`, 'utf8')
  writeFileSync(join(root, 'packages/buddy-driver', 'runner.out'), runnerOut(runId, runner), 'utf8')
  writeFileSync(join(root, 'packages/buddy-driver', 'logs', 'jev', 'decisions.jsonl'), DECISIONS, 'utf8')
  const firstInventory = logLines.map((entry) => /\bINVENTORY items=(\{.*\})/.exec(entry)?.[1] ?? null).find((entry) => entry !== null)
  writeFileSync(
    join(root, 'packages/buddy-driver', 'data', 'resident', `m2-snapshot-${runId}.json`),
    JSON.stringify({
      record: 'm2-snapshot',
      runId,
      generationId: GENERATION_ID,
      bootSourceSha: SOURCE_SHA,
      buildHash: BUILD_HASH,
      worldEpoch: 1,
      worldKey: '127.0.0.1:25565|minecraft:overworld|1',
      initialInventory: firstInventory === null ? {} : JSON.parse(firstInventory),
      initialInventoryObservation: {
        runId,
        atMs: Date.parse(at(0)),
        at: at(0),
        generationId: GENERATION_ID,
        bootSourceSha: SOURCE_SHA,
        buildHash: BUILD_HASH,
        worldEpoch: 1,
        worldKey: '127.0.0.1:25565|minecraft:overworld|1',
      },
      markers: [],
    }),
    'utf8',
  )
  if (acceptance) {
    writeFileSync(join(root, 'packages/buddy-driver', 'data', 'resident', `acceptance-${runId}.json`), ACCEPTANCE(runId), 'utf8')
  }
}

function writeDecisions(root, entries) {
  const path = join(root, 'operator-decisions.json')
  writeFileSync(path, JSON.stringify({ record: 'operator-decisions', schemaVersion: 1, decisions: entries }), 'utf8')
  return path
}

/** Inject a controlled M2 evaluator result for acceptance-aggregation fixtures. */
function makeM2GateStub({ status = 'UNKNOWN', gateStatus = status, gateRunId = null, sourceSha = SOURCE_SHA, reason = 'fixture_m2' } = {}) {
  const code = status === 'PASS' ? 0 : status === 'FAIL' ? 1 : 2
  const conditions = status === 'PASS'
    ? { diamond_ready: 'PASS', portal_materials_ready: 'PASS', portal_built: 'PASS', portal_lit: 'PASS' }
    : { diamond_ready: 'UNKNOWN', portal_materials_ready: 'UNKNOWN', portal_built: 'UNKNOWN', portal_lit: 'UNKNOWN' }
  return async ({ onResult, expectedRunId, write }) => {
    const verdict = {
      id: 'M2',
      status: gateStatus,
      code,
      reason,
      runId: gateRunId ?? expectedRunId,
      sourceSha,
      conditions,
      facts: null,
    }
    if (typeof onResult === 'function') onResult(verdict)
    write(`M2_RUN_RESULT status=${status} reason=${reason} runId=${expectedRunId}`)
    return code
  }
}

const runM2GateStub = makeM2GateStub()

/** M3 PASS fixture used to isolate the bundle's cross-milestone acceptance rule. */
async function runM3GatePassStub({ onResult, expectedRunId, sourceSha = SOURCE_SHA, write }) {
  const observedAt = at(31)
  const observation = {
    record: 'current-inventory-observation',
    schemaVersion: 1,
    runId: expectedRunId,
    sourceSha,
    generationId: 'gen-test-1',
    observedAtMs: Date.parse(observedAt),
    observedAt,
    worldKey: { ...JSON.parse(WORLD_KEY), dimension: 'minecraft:the_nether' },
    dimension: 'minecraft:the_nether',
    counts: { ender_eye: 12 },
  }
  const verdict = {
    id: 'M3',
    status: 'PASS',
    code: 0,
    reason: 'twelve_eyes_of_ender_verified',
    runId: expectedRunId,
    sourceSha,
    conditions: { exact_source: 'PASS', ender_eye_ready: 'PASS', model_authority: 'PASS', nether_reached: 'PASS' },
    facts: {
      eyes: { ready: true, enderEye: 12, maxObservedEnderEye: 12 },
      terminalInventory: { status: 'valid', reason: null, observation },
    },
  }
  if (typeof onResult === 'function') onResult(verdict)
  write(`M3_RUN_RESULT status=PASS reason=twelve_eyes_of_ender_verified runId=${expectedRunId}`)
  return 0
}

const PASS_BUNDLE_GATES = Object.freeze({ M2: runM2Gate, M3: runM3GatePassStub })

function stderrCapture() {
  const lines = []
  return { lines, write: (entry) => lines.push(String(entry)), text: () => lines.join('') }
}

function condition(bundle, id) {
  return bundle.conditions.find((entry) => entry.id === id) ?? null
}

// The delivered artifact is an independent acceptance boundary: it must retain
// the exact BODY transition lineage used for the nether_reached predicate.
{
  const transition = {
    from: 'minecraft:overworld',
    to: 'minecraft:the_nether',
    dimension: 'minecraft:the_nether',
    at: at(19),
    atMs: T0 + 19000,
    source: 'live-world',
    runId: RUN,
    sourceSha: SOURCE_SHA,
  }
  const artifact = (dimensionTransition, predicateTransition = dimensionTransition, observedAtMs = transition.atMs) => ({
    runId: RUN,
    run: { boot: { sourceSha: SOURCE_SHA } },
    environment: { dimensions: { transitions: [dimensionTransition] } },
    milestonePredicates: {
      runId: RUN,
      sourceSha: SOURCE_SHA,
      predicates: [{
        id: 'nether_reached',
        satisfied: true,
        observedAtMs,
        source: 'log:DIMENSION_TRANSITION:dimension',
        evidence: { transition: predicateTransition },
      }],
    },
  })
  const verdictFor = (candidate) => evaluateRequiredM3ArtifactEvidence(candidate, RUN)
  const valid = verdictFor(artifact(transition))
  assert.equal(valid.checks.find((entry) => entry.id === 'dimensionTransition.toNether').present, true)
  assert.equal(valid.checks.find((entry) => entry.id === 'milestonePredicates').present, true)

  const portalSource = { ...transition, source: 'PORTAL_LIT' }
  const portal = verdictFor(artifact(portalSource))
  assert.equal(portal.checks.find((entry) => entry.id === 'dimensionTransition.toNether').present, false)
  assert.equal(portal.checks.find((entry) => entry.id === 'milestonePredicates').present, false)

  const mismatchedLineage = verdictFor(artifact(transition, { ...transition, from: 'minecraft:the_end' }))
  assert.equal(mismatchedLineage.checks.find((entry) => entry.id === 'dimensionTransition.toNether').present, true)
  assert.equal(mismatchedLineage.checks.find((entry) => entry.id === 'milestonePredicates').present, false)

  const mismatchedTime = verdictFor(artifact(transition, transition, transition.atMs + 1))
  assert.equal(mismatchedTime.checks.find((entry) => entry.id === 'milestonePredicates').present, false)

  const wrongRun = verdictFor(artifact({ ...transition, runId: 'run-another-world' }))
  assert.equal(wrongRun.checks.find((entry) => entry.id === 'dimensionTransition.toNether').present, false)
  assert.equal(wrongRun.checks.find((entry) => entry.id === 'milestonePredicates').present, false)

  const wrongSource = verdictFor(artifact({ ...transition, sourceSha: 'f'.repeat(40) }))
  assert.equal(wrongSource.checks.find((entry) => entry.id === 'dimensionTransition.toNether').present, false)
  assert.equal(wrongSource.checks.find((entry) => entry.id === 'milestonePredicates').present, false)
  ok('artifact acceptance requires a timed live-world BODY transition and exact predicate lineage')
}

// ---------------------------------------------------------------------------
// A. a synthetic PASS-shaped run: one verdict per condition, gate == artifact
// ---------------------------------------------------------------------------
{
  const root = makeRoot('pass')
  writeFixture(root, RUN, { logLines: fullLog(RUN, { terminalEye: 12 }) })
  const outDir = join(root, 'bundle')
  const { bundle, exitCode } = await buildAcceptanceBundle({
    runId: RUN,
    root,
    outDir,
    evidenceClass: 'fixture',
    noControlSocket: true,
    gates: PASS_BUNDLE_GATES,
    runGate: runM3GatePassStub,
    write: () => {},
  })
  assert.equal(exitCode, 0, `PASS fixture exit=${exitCode} verdict=${bundle.acceptanceVerdict.reason}`)
  assert.equal(bundle.acceptanceVerdict.status, 'PASS')
  assert.equal(bundle.gate.status, 'PASS')
  assert.deepEqual(bundle.gate.conditions, { exact_source: 'PASS', ender_eye_ready: 'PASS', model_authority: 'PASS', nether_reached: 'PASS' })
  assert.match(bundle.gate.resultLine, /^M3_RUN_RESULT status=PASS reason=twelve_eyes_of_ender_verified/)
  // ONE verdict per condition, all from the canonical gate.
  for (const id of ['M3.exact_source', 'M3.ender_eye_ready', 'M3.model_authority', 'M3.nether_reached']) {
    const row = condition(bundle, id)
    assert.equal(row.verdict, 'PASS', `${id} verdict=${row.verdict} reason=${row.reason}`)
    assert.equal(row.source, 'tools/m3-gate.mjs')
  }
  assert.ok(bundle.consistency.find((entry) => entry.check === 'gate_vs_artifact_conditions').ok)
  assert.ok(bundle.consistency.find((entry) => entry.check === 'authority_evidence_bound').ok)
  assert.equal(bundle.artifact.status, 'PASS')
  assert.deepEqual(bundle.artifact.missingEvidence, [])
  assert.equal(bundle.artifact.document.authority.system2.identityStatus, 'verified')
  const unverifiedIdentityArtifact = JSON.parse(JSON.stringify(bundle.artifact.document))
  unverifiedIdentityArtifact.authority.system2.identityStatus = 'unknown'
  const identityEvidence = evaluateRequiredM3ArtifactEvidence(unverifiedIdentityArtifact, RUN)
  assert.equal(identityEvidence.status, 'UNKNOWN')
  assert.ok(identityEvidence.missing.includes('authority.system2GenerationIdentity'))
  assert.equal(evaluateRequiredM3ArtifactEvidence(bundle.artifact.document, RUN).checks.find((entry) => entry.id === 'inventory.initial').present, true)
  const periodicOnlyInventory = JSON.parse(JSON.stringify(bundle.artifact.document))
  delete periodicOnlyInventory.inventory.bootEvidence
  const periodicOnlyEvidence = evaluateRequiredM3ArtifactEvidence(periodicOnlyInventory, RUN)
  assert.equal(periodicOnlyEvidence.status, 'UNKNOWN')
  assert.ok(periodicOnlyEvidence.missing.includes('inventory.initial'), 'a first periodic inventory dump cannot substitute for exact BOOT-bound snapshot evidence')
  const foreignInitialSnapshot = JSON.parse(JSON.stringify(bundle.artifact.document))
  foreignInitialSnapshot.inventory.bootEvidence.snapshotBootSourceSha = 'f'.repeat(40)
  const foreignInitialEvidence = evaluateRequiredM3ArtifactEvidence(foreignInitialSnapshot, RUN)
  assert.equal(foreignInitialEvidence.status, 'UNKNOWN')
  assert.ok(foreignInitialEvidence.missing.includes('inventory.initial'))
  assert.equal(condition(bundle, 'artifact.requiredEvidence').verdict, 'PASS')
  assert.equal(condition(bundle, 'metrics.skillClosure').verdict, 'PRESENT')
  assert.ok(bundle.metrics.report !== null)
  assert.equal(bundle.metrics.report.runId, RUN)
  const m2Row = condition(bundle, 'M2.premise')
  assert.equal(m2Row.verdict, 'PASS')
  assert.equal(m2Row.blocking, true)
  assert.equal(m2Row.detail.gateRunId, RUN)
  assert.equal(m2Row.detail.gateSourceSha, SOURCE_SHA)
  assert.equal(m2Row.detail.expectedSourceSha, SOURCE_SHA)
  assert.equal(m2Row.detail.runMatches, true)
  assert.equal(m2Row.detail.sourceMatches, true)
  assert.equal(bundle.artifact.document.verdicts.M2.gateStatus, 'PASS')
  assert.equal(bundle.artifact.document.verdicts.M2.gateRunId, RUN)
  assert.equal(bundle.artifact.document.verdicts.M2.sourceSha, SOURCE_SHA)
  // A fixture PASS is never a live acceptance.
  assert.equal(bundle.liveAcceptance, false)
  assert.ok(bundle.residual.some((entry) => /evidence class is "fixture"/.test(entry)))
  ok('A. exact-run/source M2 PASS + M3 PASS: BOOT-bound initial snapshot required; fixture liveAcceptance=false')
}

// A2. model counts are not a substitute for a verified generation/call join.
{
  const runId = 'run-fixture-system2-identity-unknown'
  const root = makeRoot('system2-identity-unknown')
  writeFixture(root, runId, { logLines: fullLog(runId, { terminalEye: 12 }), runner: { decisions: [] } })
  const { bundle, exitCode } = await buildAcceptanceBundle({
    runId,
    root,
    outDir: join(root, 'bundle'),
    evidenceClass: 'fixture',
    noControlSocket: true,
    gates: PASS_BUNDLE_GATES,
    runGate: runM3GatePassStub,
    write: () => {},
  })
  assert.notEqual(bundle.acceptanceVerdict.status, 'PASS')
  assert.ok(bundle.artifact.requiredEvidence.missing.includes('authority.system2GenerationIdentity'))
  assert.equal(condition(bundle, 'artifact.requiredEvidence').verdict, 'UNKNOWN')
  assert.equal(bundle.artifact.document.verdicts.M3.status, 'PASS', 'this test deliberately injects a PASS gate to isolate the independent artifact boundary')
  assert.equal(exitCode, 2)
  ok('A2. an injected gate PASS cannot replace verified System2 generation identity in artifact acceptance')
}

// A3. gate PASS cannot replace required environment/run artifact facts
{
  const root = makeRoot('missing-required-environment')
  const logLines = fullLog(RUN, { terminalEye: 12 }).filter((entry) => !entry.includes('ENVIRONMENT difficulty='))
  writeFixture(root, RUN, { logLines })
  const { bundle, exitCode } = await buildAcceptanceBundle({
    runId: RUN,
    root,
    outDir: join(root, 'bundle'),
    evidenceClass: 'fixture',
    noControlSocket: true,
    gates: PASS_BUNDLE_GATES,
    runGate: runM3GatePassStub,
    write: () => {},
  })
  assert.equal(bundle.gate.status, 'PASS')
  assert.equal(condition(bundle, 'M2.premise').verdict, 'PASS')
  const evidence = condition(bundle, 'artifact.requiredEvidence')
  assert.equal(evidence.verdict, 'UNKNOWN')
  assert.ok(evidence.detail.missing.includes('environment.difficulty'))
  assert.ok(evidence.detail.missing.includes('environment.gamerules'))
  assert.equal(bundle.acceptanceVerdict.status, 'UNKNOWN')
  assert.equal(exitCode, 2)
  ok('A3. M2/M3 gate PASS with missing required environment facts remains UNKNOWN at artifact acceptance')
}

// A4. one deterministic System2 decision prevents a no-fallback acceptance
{
  const root = makeRoot('system2-fallback')
  writeFixture(root, RUN, {
    logLines: fullLog(RUN, { terminalEye: 12 }),
    runner: {
      decisions: [
        `SYSTEM2_AUTHORITY_DECISION ${SYSTEM2_IDENTITY} provider=typesafe-ai model=typesafe-ai/jev chosen=front_nether_portal`,
        `SYSTEM2_AUTHORITY_DECISION ${SYSTEM2_IDENTITY} provider=deterministic model=deterministic-baseline chosen=WAIT`,
      ],
    },
  })
  assert.match(readFileSync(join(root, 'packages/buddy-driver', 'runner.out'), 'utf8'), /provider=deterministic model=deterministic-baseline/)
  const { bundle, exitCode } = await buildAcceptanceBundle({
    runId: RUN,
    root,
    outDir: join(root, 'bundle'),
    evidenceClass: 'fixture',
    noControlSocket: true,
    gates: PASS_BUNDLE_GATES,
    runGate: runM3GatePassStub,
    write: () => {},
  })
  assert.equal(bundle.gate.status, 'PASS')
  const evidence = condition(bundle, 'artifact.requiredEvidence')
  assert.equal(evidence.verdict, 'UNKNOWN', JSON.stringify(bundle.artifact.document.authority.system2))
  assert.ok(evidence.detail.missing.includes('authority.system2NoFallback'), JSON.stringify(evidence.detail))
  assert.equal(bundle.acceptanceVerdict.status, 'UNKNOWN')
  assert.equal(exitCode, 2)
  ok('A4. a logged deterministic System2 decision cannot be hidden by an earlier model-backed M2 plan')
}
{
  const root = makeRoot('pass-files')
  writeFixture(root, RUN, { logLines: fullLog(RUN, { terminalEye: 12 }) })
  const outDir = join(root, 'bundle')
  await buildAcceptanceBundle({
    runId: RUN,
    root,
    outDir,
    evidenceClass: 'fixture',
    noControlSocket: true,
    gates: PASS_BUNDLE_GATES,
    runGate: runM3GatePassStub,
    write: () => {},
  })
  const bundle = JSON.parse(readFileSync(join(outDir, 'bundle.json'), 'utf8'))
  const markdown = readFileSync(join(outDir, 'bundle.md'), 'utf8')
  assert.equal(bundle.record, 'm3-acceptance-bundle')
  assert.match(markdown, /VERDICT: \*\*PASS\*\*/)
  assert.match(markdown, /\| M3\.ender_eye_ready \| PASS \| yes \|/)
  assert.match(markdown, /\| M3\.exact_source \| PASS \| yes \|/)
  assert.ok(readFileSync(join(outDir, `artifact-${RUN}.json`), 'utf8').includes('"record": "milestone-run-artifact"'))
  assert.ok(readFileSync(join(outDir, 'metrics.json'), 'utf8').includes('"runId"'))
  // Every command is recorded with an exact argv and its captured output.
  assert.ok(bundle.commands.length >= 3)
  for (const command of bundle.commands) {
    assert.ok(Array.isArray(command.argv) && command.argv.length > 0)
    assert.equal(typeof command.stdoutSha256, 'string')
  }
  const artifactCommand = bundle.commands.find((entry) => entry.id === 'artifact')
  assert.ok(artifactCommand.argv.includes('tools/milestone-run-artifact.mjs'))
  assert.ok(artifactCommand.argv.includes('--no-control-socket'))
  // Every step records REAL captured output (not an empty hash placeholder).
  for (const command of bundle.commands) {
    assert.notEqual(command.stdoutSha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', `${command.id} captured no output`)
  }
  assert.match(readFileSync(join(outDir, 'commands', '02-m3-gate.txt'), 'utf8'), /M3_RUN_RESULT status=PASS/)
  assert.match(readFileSync(join(outDir, 'commands', '03-skill-closure-metrics.txt'), 'utf8'), /"runId": "run-fixture-bundle"/)
  assert.equal(bundle.consistency.find((entry) => entry.check === 'gate_vs_artifact_conditions').severity, 'error')
  ok('A2. the bundle writes bundle.json/bundle.md/artifact/metrics + per-command argv records')
}

// ---------------------------------------------------------------------------
// B. declaring `live` on a synthetic tree must NOT yield a live acceptance
// ---------------------------------------------------------------------------
{
  const root = makeRoot('declared-live')
  writeFixture(root, RUN, { logLines: fullLog(RUN, { terminalEye: 12 }) })
  const { bundle } = await buildAcceptanceBundle({
    runId: RUN,
    root,
    outDir: join(root, 'bundle'),
    evidenceClass: 'live',
    noControlSocket: true,
    gates: PASS_BUNDLE_GATES,
    runGate: runM3GatePassStub,
    write: () => {},
  })
  assert.equal(bundle.acceptanceVerdict.status, 'PASS')
  assert.equal(bundle.evidenceClass, 'live')
  assert.equal(bundle.liveAcceptance, false, 'a synthetic tree must never be a live PASS')
  const failed = bundle.liveSignals.filter((signal) => !signal.ok).map((signal) => signal.id)
  assert.ok(failed.includes('hostLock'), `failed live signals: ${failed.join(',')}`)
  assert.ok(failed.includes('sourceTreeClean'), `failed live signals: ${failed.join(',')}`)
  assert.ok(bundle.residual.some((entry) => /live signal\(s\) not satisfied/.test(entry)))
  ok('B. --evidence-class live on a synthetic tree: PASS but liveAcceptance=false (named signals)')
}

// ---------------------------------------------------------------------------
// C. a MISSING HOST acceptance record: stated precisely, never fabricated
// ---------------------------------------------------------------------------
{
  const root = makeRoot('no-acceptance')
  writeFixture(root, RUN, { logLines: fullLog(RUN, { terminalEye: 12 }), acceptance: false })
  const errors = stderrCapture()
  const { bundle, exitCode } = await buildAcceptanceBundle({
    runId: RUN,
    root,
    outDir: join(root, 'bundle'),
    evidenceClass: 'fixture',
    noControlSocket: true,
    gates: PASS_BUNDLE_GATES,
    runGate: runM3GatePassStub,
    write: errors.write,
  })
  const row = condition(bundle, 'evidence.acceptance')
  assert.equal(bundle.acceptanceVerdict.status, 'PASS')
  assert.equal(exitCode, 0, 'the HOST acceptance record is a diagnostic class by default')
  assert.equal(row.verdict, 'MISSING_NON_BLOCKING')
  assert.equal(row.blocking, false)
  assert.match(row.reason, /acceptance_artifact_missing/)
  assert.match(row.reason, /writeAcceptance\(\)/)
  assert.ok(row.detail.safeTriggers.length >= 3)
  assert.equal(row.detail.fabricatable, false)
  assert.match(row.detail.milestoneQuestionAnsweredBy, /milestoneAcceptance/)
  assert.ok(bundle.residual.some((entry) => /no tool may fabricate it/.test(entry)))

  const strict = await buildAcceptanceBundle({
    runId: RUN,
    root,
    outDir: join(root, 'bundle-strict'),
    evidenceClass: 'fixture',
    noControlSocket: true,
    gates: PASS_BUNDLE_GATES,
    runGate: runM3GatePassStub,
    requireAcceptance: true,
    write: errors.write,
  })
  assert.equal(condition(strict.bundle, 'evidence.acceptance').verdict, 'MISSING')
  assert.equal(condition(strict.bundle, 'evidence.acceptance').blocking, true)
  assert.equal(strict.exitCode, 2)
  assert.match(strict.bundle.acceptanceVerdict.reason, /unmet blocking condition\(s\): evidence\.acceptance=MISSING/)
  ok('C. missing acceptance class named (writer/triggers/non-fabricatable); --require-acceptance blocks')
}
{
  const root = makeRoot('with-acceptance')
  writeFixture(root, RUN, { logLines: fullLog(RUN, { terminalEye: 12 }) })
  const { bundle } = await buildAcceptanceBundle({
    runId: RUN,
    root,
    outDir: join(root, 'bundle'),
    evidenceClass: 'fixture',
    noControlSocket: true,
    gates: PASS_BUNDLE_GATES,
    runGate: runM3GatePassStub,
    write: () => {},
  })
  assert.equal(condition(bundle, 'evidence.acceptance').verdict, 'PRESENT')
  assert.equal(bundle.artifact.document.evidenceClasses.find((entry) => entry.id === 'acceptance').status, 'PRESENT')
  ok('C2. a present HOST acceptance record is reported PRESENT with its class')
}

// ---------------------------------------------------------------------------
// D. an operator decision scoped to ANOTHER run: exact per-run premise
// ---------------------------------------------------------------------------
{
  const root = makeRoot('decision-other-run')
  // The run inherits a portal it did not build: the M2 gate reports inherited_portal.
  const inheritedLog = [
    boot(0, RUN),
    line(1, 'SPAWN pos=0.5,64.0,0.5 version=1.21.11 health=20 username=AI_Buddy dimension=minecraft:overworld worldEpoch=1'),
    line(10, 'INVENTORY items={"ender_pearl":0,"blaze_rod":0,"blaze_powder":0,"ender_eye":0} pos=0.5,64.0,0.5'),
    line(11, 'PORTAL_VERIFIED=true'),
    line(19, 'DIMENSION_TRANSITION from=minecraft:overworld to=minecraft:the_nether dimension=minecraft:the_nether reason=live-change source=live-world'),
  ]
  writeFixture(root, RUN, { logLines: inheritedLog })
  const decisionsPath = writeDecisions(root, [
    {
      record: 'operator-decision',
      milestone: 'M2',
      status: 'PASS',
      authority: 'operator',
      runId: 'run-some-other-run',
      basis: 'inherited_portal',
      ruling: 'fixture: M2 passes on standing evidence',
      recordedAt: at(50),
      scope: 'M2 only',
    },
  ])
  const { bundle } = await buildAcceptanceBundle({
    runId: RUN,
    root,
    outDir: join(root, 'bundle'),
    overrides: { operatorDecisions: decisionsPath },
    evidenceClass: 'fixture',
    noControlSocket: true,
    gates: PASS_BUNDLE_GATES,
    runGate: runM3GatePassStub,
    write: () => {},
  })
  const premise = bundle.artifact.document.verdicts.M2.operatorDecisionPremise
  assert.equal(premise.present, true)
  assert.equal(premise.thisRunInherits, false)
  assert.equal(premise.thisRunMust, 'build')
  assert.equal(premise.decisions[0].runScope, 'run-some-other-run')
  assert.equal(premise.decisions[0].decisionScope, 'M2 only')
  assert.equal(premise.decisions[0].outcome, 'scoped_to_another_run')
  assert.match(premise.consequence, /does NOT cover this run/)
  assert.match(premise.consequence, /scoped to runId=run-fixture-bundle/)
  // The recorded decision is never rewritten and never flips the gate.
  assert.equal(bundle.artifact.document.verdicts.M2.status, 'UNKNOWN')
  assert.equal(bundle.artifact.document.verdicts.M2.reason, 'inherited_portal')
  assert.equal(bundle.artifact.document.verdicts.M2.operatorDecision, null)
  assert.equal(condition(bundle, 'M2.premise').verdict, 'UNKNOWN')
  assert.equal(condition(bundle, 'M2.premise').blocking, true)
  assert.equal(condition(bundle, 'M2.premise').detail.recordedRunScope, 'run-some-other-run')
  assert.equal(condition(bundle, 'M2.premise').detail.thisRunMust, 'build')
  // M3 itself can pass, but the aggregate acceptance remains blocked on this run's M2.
  assert.equal(bundle.gate.status, 'PASS')
  assert.equal(condition(bundle, 'M3.nether_reached').verdict, 'PASS')
  assert.equal(bundle.acceptanceVerdict.status, 'UNKNOWN')
  assert.equal(bundle.exitCode, 2)
  assert.equal(bundle.artifact.document.operatorDecisions.sha256.length, 64)
  assert.equal(premise.sha256, bundle.artifact.document.operatorDecisions.sha256)
  assert.equal(condition(bundle, 'M2.premise').detail.recordedSha256, premise.sha256)
  assert.match(condition(bundle, 'M2.premise').detail.recordedSource, /operator-decisions\.json$/)
  assert.ok(bundle.artifact.missingEvidence.includes('premise:M2'))
  ok('D. decision scoped elsewhere cannot replace same-run M2 PASS even when M3 gate PASSes')
}

// ---------------------------------------------------------------------------
// E. a decision scoped to THIS run: premise says inherit, the verdict stays UNKNOWN
// ---------------------------------------------------------------------------
{
  const root = makeRoot('decision-this-run')
  const inheritedLog = [
    boot(0, RUN),
    line(1, 'SPAWN pos=0.5,64.0,0.5 version=1.21.11 health=20 username=AI_Buddy dimension=minecraft:overworld worldEpoch=1'),
    line(10, 'INVENTORY items={"ender_pearl":0,"blaze_rod":0,"blaze_powder":0,"ender_eye":0} pos=0.5,64.0,0.5'),
    line(11, 'PORTAL_VERIFIED=true'),
    line(19, 'DIMENSION_TRANSITION from=minecraft:overworld to=minecraft:the_nether dimension=minecraft:the_nether reason=live-change source=live-world'),
  ]
  writeFixture(root, RUN, { logLines: inheritedLog })
  const decisionsPath = writeDecisions(root, [
    {
      record: 'operator-decision',
      milestone: 'M2',
      status: 'PASS',
      authority: 'operator',
      runId: RUN,
      basis: 'inherited_portal',
      ruling: 'fixture: M2 passes on standing evidence',
      recordedAt: at(50),
      scope: 'M2 only',
    },
  ])
  const { bundle, exitCode } = await buildAcceptanceBundle({
    runId: RUN,
    root,
    outDir: join(root, 'bundle'),
    overrides: { operatorDecisions: decisionsPath },
    evidenceClass: 'fixture',
    noControlSocket: true,
    gates: PASS_BUNDLE_GATES,
    runGate: runM3GatePassStub,
    write: () => {},
  })
  const premise = bundle.artifact.document.verdicts.M2.operatorDecisionPremise
  assert.equal(premise.thisRunInherits, true)
  assert.equal(premise.thisRunMust, 'inherit')
  assert.equal(premise.decisions[0].outcome, 'inherited_by_this_run')
  assert.equal(premise.decisions[0].corroboratedByThisRun, true)
  assert.equal(bundle.artifact.document.verdicts.M2.operatorDecision.status, 'PASS')
  assert.equal(bundle.artifact.document.verdicts.M2.status, 'UNKNOWN', 'the annotation never rewrites the gate')
  const m2Row = condition(bundle, 'M2.premise')
  assert.equal(m2Row.verdict, 'UNKNOWN')
  assert.equal(m2Row.blocking, true)
  assert.match(m2Row.reason, /inherited M2 premise does not substitute/)
  assert.equal(bundle.gate.status, 'PASS')
  assert.equal(bundle.acceptanceVerdict.status, 'UNKNOWN')
  assert.equal(exitCode, 2)
  assert.ok(!bundle.artifact.missingEvidence.includes('premise:M2'))
  ok('E. same-run inherited decision is diagnostic; delegated M2 UNKNOWN blocks M3 acceptance')
}

// ---------------------------------------------------------------------------
// E2. same-run/source binding and delegated verdict must all agree for M2 PASS
// ---------------------------------------------------------------------------
{
  const cases = [
    {
      name: 'unknown',
      m2: { status: 'UNKNOWN', reason: 'm2_not_proven' },
      expectedStatus: 'UNKNOWN',
      expectedExit: 2,
      expectedRunMatches: true,
      expectedSourceMatches: true,
      reason: /same-run M2 gate UNKNOWN/,
    },
    {
      name: 'fail',
      m2: { status: 'FAIL', reason: 'm2_failed' },
      expectedStatus: 'FAIL',
      expectedExit: 1,
      expectedRunMatches: true,
      expectedSourceMatches: true,
      reason: /same-run M2 gate FAIL/,
    },
    {
      name: 'wrong-run',
      m2: { status: 'PASS', gateRunId: 'run-another-source' },
      expectedStatus: 'UNKNOWN',
      expectedExit: 2,
      expectedRunMatches: false,
      expectedSourceMatches: true,
      reason: /same-run M2 gate identity unavailable or mismatched/,
    },
    {
      name: 'wrong-source',
      m2: { status: 'PASS', sourceSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      expectedStatus: 'UNKNOWN',
      expectedExit: 2,
      expectedRunMatches: true,
      expectedSourceMatches: false,
      reason: /same-run M2 source SHA unavailable or mismatched/,
    },
    {
      name: 'evaluator-wrapper-mismatch',
      m2: { status: 'PASS', gateStatus: 'FAIL' },
      expectedStatus: 'UNKNOWN',
      expectedExit: 2,
      expectedRunMatches: true,
      expectedSourceMatches: true,
      reason: /M2 evaluator\/wrapper verdict mismatch/,
    },
  ]
  for (const entry of cases) {
    const root = makeRoot(`m2-${entry.name}`)
    writeFixture(root, RUN, { logLines: fullLog(RUN, { terminalEye: 12 }) })
    const { bundle, exitCode } = await buildAcceptanceBundle({
      runId: RUN,
      root,
      outDir: join(root, 'bundle'),
      evidenceClass: 'fixture',
      noControlSocket: true,
      gates: { M2: makeM2GateStub(entry.m2), M3: runM3GatePassStub },
      runGate: runM3GatePassStub,
      write: () => {},
    })
    const m2Row = condition(bundle, 'M2.premise')
    assert.equal(bundle.gate.status, 'PASS', `${entry.name}: M3 gate fixture should PASS`)
    assert.equal(m2Row.verdict, entry.expectedStatus, `${entry.name}: M2 row`)
    assert.equal(m2Row.blocking, true, `${entry.name}: M2 row must block`)
    assert.equal(m2Row.detail.runMatches, entry.expectedRunMatches, `${entry.name}: run identity binding`)
    assert.equal(m2Row.detail.sourceMatches, entry.expectedSourceMatches, `${entry.name}: source identity binding`)
    assert.match(m2Row.reason, entry.reason, `${entry.name}: diagnostic reason`)
    assert.equal(bundle.acceptanceVerdict.status, entry.expectedStatus, `${entry.name}: aggregate verdict`)
    assert.equal(exitCode, entry.expectedExit, `${entry.name}: aggregate exit code`)
  }
  ok('E2. M2 UNKNOWN/FAIL/wrong run/wrong SHA/verdict mismatch all block M3 PASS')
}

// ---------------------------------------------------------------------------
// F. a PASS from the artifact side cannot survive the canonical gate's UNKNOWN
// ---------------------------------------------------------------------------
{
  const root = makeRoot('contradiction')
  // The canonical gate sees 0 eyes and no complete crafting inputs (UNKNOWN); the
  // injected artifact gate lies PASS.
  writeFixture(root, RUN, { logLines: fullLog(RUN, { terminalEye: 0, materials: false }) })
  const fakePassGate = async ({ write, onResult, expectedRunId }) => {
    const verdict = {
      id: 'M3',
      status: 'PASS',
      code: 0,
      reason: 'twelve_eyes_of_ender_verified',
      runId: expectedRunId,
      conditions: { exact_source: 'PASS', ender_eye_ready: 'PASS', model_authority: 'PASS', nether_reached: 'PASS' },
      facts: { eyes: { ready: true, enderEye: 12 } },
    }
    if (typeof onResult === 'function') onResult(verdict)
    write('M3_RUN_GATE — injected')
    write(`M3_RUN_RESULT status=PASS reason=twelve_eyes_of_ender_verified runId=${expectedRunId}`)
    return 0
  }
  const { bundle, exitCode } = await buildAcceptanceBundle({
    runId: RUN,
    root,
    outDir: join(root, 'bundle'),
    evidenceClass: 'fixture',
    noControlSocket: true,
    gates: { M2: runM2GateStub, M3: fakePassGate },
    runGate: runM3Gate,
    write: () => {},
  })
  assert.equal(bundle.gate.status, 'UNKNOWN')
  assert.equal(bundle.artifact.document.verdicts.M3.status, 'PASS', 'the injected artifact gate did report PASS')
  const row = condition(bundle, 'M3.ender_eye_ready')
  assert.equal(row.verdict, 'UNKNOWN', 'a contradicted condition is never PASS')
  assert.match(row.reason, /gate\/artifact contradiction/)
  assert.equal(bundle.consistency.find((entry) => entry.check === 'gate_vs_artifact_conditions').ok, false)
  assert.equal(exitCode, 2)
  assert.match(bundle.acceptanceVerdict.reason, /contradiction/)
  ok('F. contradictory artifact gate: CONTRADICTION named, condition UNKNOWN, exit 2 (never reconciled to PASS)')
}

// G. a missing required input fails loudly and still writes the bundle
// ---------------------------------------------------------------------------
{
  const root = makeRoot('no-log')
  mkdirSync(join(root, 'packages/buddy-driver', 'data', 'resident'), { recursive: true })
  const errors = stderrCapture()
  const { bundle, exitCode } = await buildAcceptanceBundle({
    runId: RUN,
    root,
    outDir: join(root, 'bundle'),
    evidenceClass: 'fixture',
    noControlSocket: true,
    write: errors.write,
  })
  assert.equal(exitCode, 2)
  assert.match(errors.text(), /M3_BUNDLE_INPUT_MISSING id=log/)
  assert.ok(bundle.missingRequiredInputs.includes('log'))
  assert.equal(condition(bundle, 'M3.nether_reached').verdict, 'UNKNOWN')
  assert.ok(readFileSync(join(root, 'bundle', 'bundle.json'), 'utf8').includes('"runId": "run-fixture-bundle"'))
  ok('G. no log: M3_BUNDLE_INPUT_MISSING printed loudly, bundle still written, exit 2')
}

// ---------------------------------------------------------------------------
// H. CLI surface
// ---------------------------------------------------------------------------
{
  const help = spawnSync(process.execPath, [TOOL, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /m3-acceptance-bundle — ONE run-scoped acceptance bundle/)
  assert.match(help.stdout, /--evidence-class <c>/)
  const root = makeRoot('no-run')
  const noRun = spawnSync(process.execPath, [TOOL, '--root', root, '--out', join(root, 'bundle'), '--json', '--no-control-socket'], {
    encoding: 'utf8',
  })
  assert.equal(noRun.status, 2)
  const bundle = JSON.parse(noRun.stdout)
  assert.equal(bundle.acceptanceVerdict.reason, 'exact_run_scope_required')
  assert.equal(bundle.liveAcceptance, false)
  ok('H. CLI: --help exit 0; a missing --run exits 2 with an UNKNOWN bundle')
}

for (const root of ROOTS) rmSync(root, { recursive: true, force: true })
console.log(`m3-acceptance-bundle-test ${checks}/${checks} PASS`)
