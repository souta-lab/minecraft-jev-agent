#!/usr/bin/env bun
// test-m3-acceptance-bundle: OFFLINE fixtures for tools/m3-acceptance-bundle.mjs.
//
// Every fixture below is a SYNTHETIC resident tree (buddy-driver/buddy.log,
// buddy-driver/runner.out, buddy-driver/logs/jev/decisions.jsonl,
// buddy-driver/data/resident/acceptance-<runId>.json). No live resident, no
// socket, no network:
//   * `noControlSocket: true` is passed everywhere, so not even the read-only
//     `report` probe runs;
//   * `evidenceClass: 'fixture'` (or 'undeclared') everywhere, so a synthetic PASS
//     can never be reported as a live acceptance.
//
// What is pinned:
//   A. a PASS-shaped synthetic run -> exit 0, every M3 condition PASS, gate and the
//      artifact's embedded conditions AGREE, and liveAcceptance stays false;
//   B. the same run declared `--evidence-class live` -> liveAcceptance is STILL
//      false, because the objective live signals do not hold (synthetic tree);
//   C. a MISSING HOST acceptance record -> the evidence class is stated precisely
//      (writer + triggers + what it attests), the run is still decidable, and
//      `--require-acceptance` makes it a loud blocking gap (exit 2);
//   D. an operator decision scoped to ANOTHER runId -> the premise says so exactly
//      (scope verbatim, thisRunInherits=false, thisRunMust=build) while the M3
//      conditions are untouched (the M3 gate never consumes M2);
//   E. a decision scoped to THIS run whose basis the gate corroborates -> the
//      premise says inherit, the delegated gate verdict stays UNKNOWN, and the
//      bundle verdict is NOT turned into PASS;
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
import { buildAcceptanceBundle } from './m3-acceptance-bundle.mjs'
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

/** runner.out-shaped authority window; `released` closes it without a socket. */
function runnerOut(runId) {
  return (
    [
      boot(0, runId),
      line(
        1,
        'GENERATION_READY id=gen-test-1 rungIndex=13 rungId=nether_portal ' +
          'policy=typesafe policyProvider=typesafe-ai model=typesafe-ai/jev policyModel=typesafe-ai/jev ' +
          'system2AuthorityStack={"provider":"hybrid","model":"typesafe-ai:typesafe-ai/jev"} ' +
          'system2LastAuthority={"provider":"none","model":"none"} deterministicFallbackEnabled=false ' +
          'planner=llm plannerModel=typesafe-ai/jev',
      ),
      line(2, 'SYSTEM2_AUTHORITY_DECISION provider=typesafe-ai model=typesafe-ai/jev chosen=front_nether_portal'),
      line(3, `HOST_LOCK released runId=${runId}`),
    ].join('\n') + '\n'
  )
}

const DECISIONS = `${JSON.stringify({ record: 'decision', ts: at(2), source: 'jev', action: 'GOTO:nether_portal' })}\n`

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
  mkdirSync(join(root, 'buddy-driver', 'data', 'resident'), { recursive: true })
  mkdirSync(join(root, 'buddy-driver', 'logs', 'jev'), { recursive: true })
  return root
}

function writeFixture(root, runId, { logLines, acceptance = true }) {
  writeFileSync(join(root, 'buddy-driver', 'buddy.log'), `${logLines.join('\n')}\n`, 'utf8')
  writeFileSync(join(root, 'buddy-driver', 'runner.out'), runnerOut(runId), 'utf8')
  writeFileSync(join(root, 'buddy-driver', 'logs', 'jev', 'decisions.jsonl'), DECISIONS, 'utf8')
  if (acceptance) {
    writeFileSync(join(root, 'buddy-driver', 'data', 'resident', `acceptance-${runId}.json`), ACCEPTANCE(runId), 'utf8')
  }
}

function writeDecisions(root, entries) {
  const path = join(root, 'operator-decisions.json')
  writeFileSync(path, JSON.stringify({ record: 'operator-decisions', schemaVersion: 1, decisions: entries }), 'utf8')
  return path
}

/** A minimal M2 stub so the contradiction fixture isolates the M3 comparison. */
async function runM2GateStub({ onResult, expectedRunId }) {
  const verdict = { id: 'M2', status: 'UNKNOWN', code: 2, reason: 'fixture_stub', runId: expectedRunId, conditions: {}, facts: null }
  if (typeof onResult === 'function') onResult(verdict)
  return 2
}

function stderrCapture() {
  const lines = []
  return { lines, write: (entry) => lines.push(String(entry)), text: () => lines.join('') }
}

function condition(bundle, id) {
  return bundle.conditions.find((entry) => entry.id === id) ?? null
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
    write: () => {},
  })
  assert.equal(exitCode, 0, `PASS fixture exit=${exitCode} verdict=${bundle.acceptanceVerdict.reason}`)
  assert.equal(bundle.acceptanceVerdict.status, 'PASS')
  assert.equal(bundle.gate.status, 'PASS')
  assert.deepEqual(bundle.gate.conditions, { ender_eye_ready: 'PASS', model_authority: 'PASS', nether_reached: 'PASS' })
  assert.match(bundle.gate.resultLine, /^M3_RUN_RESULT status=PASS reason=twelve_eyes_of_ender_verified/)
  // ONE verdict per condition, all from the canonical gate.
  for (const id of ['M3.ender_eye_ready', 'M3.model_authority', 'M3.nether_reached']) {
    const row = condition(bundle, id)
    assert.equal(row.verdict, 'PASS', `${id} verdict=${row.verdict} reason=${row.reason}`)
    assert.equal(row.source, 'tools/m3-gate.mjs')
  }
  assert.ok(bundle.consistency.find((entry) => entry.check === 'gate_vs_artifact_conditions').ok)
  assert.ok(bundle.consistency.find((entry) => entry.check === 'authority_evidence_bound').ok)
  assert.equal(bundle.artifact.status, 'PASS')
  assert.deepEqual(bundle.artifact.missingEvidence, [])
  assert.equal(condition(bundle, 'metrics.skillClosure').verdict, 'PRESENT')
  assert.ok(bundle.metrics.report !== null)
  assert.equal(bundle.metrics.report.runId, RUN)
  // A fixture PASS is never a live acceptance.
  assert.equal(bundle.liveAcceptance, false)
  assert.ok(bundle.residual.some((entry) => /evidence class is "fixture"/.test(entry)))
  ok('A. synthetic PASS: gate==artifact, all conditions PASS, liveAcceptance=false')
}
{
  const root = makeRoot('pass-files')
  writeFixture(root, RUN, { logLines: fullLog(RUN, { terminalEye: 12 }) })
  const outDir = join(root, 'bundle')
  await buildAcceptanceBundle({ runId: RUN, root, outDir, evidenceClass: 'fixture', noControlSocket: true, write: () => {} })
  const bundle = JSON.parse(readFileSync(join(outDir, 'bundle.json'), 'utf8'))
  const markdown = readFileSync(join(outDir, 'bundle.md'), 'utf8')
  assert.equal(bundle.record, 'm3-acceptance-bundle')
  assert.match(markdown, /VERDICT: \*\*PASS\*\*/)
  assert.match(markdown, /\| M3\.ender_eye_ready \| PASS \| yes \|/)
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
    write: () => {},
  })
  assert.equal(bundle.acceptanceVerdict.status, 'PASS')
  assert.equal(bundle.evidenceClass, 'live')
  assert.equal(bundle.liveAcceptance, false, 'a synthetic tree must never be a live PASS')
  const failed = bundle.liveSignals.filter((signal) => !signal.ok).map((signal) => signal.id)
  assert.ok(failed.includes('hostLock'), `failed live signals: ${failed.join(',')}`)
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
  assert.equal(condition(bundle, 'M2.premise').blocking, false)
  assert.equal(condition(bundle, 'M2.premise').detail.recordedRunScope, 'run-some-other-run')
  assert.equal(condition(bundle, 'M2.premise').detail.thisRunMust, 'build')
  // M3 does not consume M2 at all: the premise cannot change an M3 condition.
  assert.equal(condition(bundle, 'M3.nether_reached').verdict, 'PASS')
  assert.equal(bundle.artifact.document.operatorDecisions.sha256.length, 64)
  assert.equal(premise.sha256, bundle.artifact.document.operatorDecisions.sha256)
  assert.equal(condition(bundle, 'M2.premise').detail.recordedSha256, premise.sha256)
  assert.match(condition(bundle, 'M2.premise').detail.recordedSource, /operator-decisions\.json$/)
  assert.ok(bundle.artifact.missingEvidence.includes('premise:M2'))
  ok('D. decision scoped elsewhere: premise says NOT covered (scope verbatim), gate verdict unchanged')
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
    write: () => {},
  })
  const premise = bundle.artifact.document.verdicts.M2.operatorDecisionPremise
  assert.equal(premise.thisRunInherits, true)
  assert.equal(premise.thisRunMust, 'inherit')
  assert.equal(premise.decisions[0].outcome, 'inherited_by_this_run')
  assert.equal(premise.decisions[0].corroboratedByThisRun, true)
  assert.equal(bundle.artifact.document.verdicts.M2.operatorDecision.status, 'PASS')
  assert.equal(bundle.artifact.document.verdicts.M2.status, 'UNKNOWN', 'the annotation never rewrites the gate')
  assert.equal(condition(bundle, 'M2.premise').verdict, 'PASS')
  // The milestone is still NOT accepted: 0 eyes.
  assert.notEqual(bundle.acceptanceVerdict.status, 'PASS')
  assert.equal(exitCode, 2)
  assert.ok(!bundle.artifact.missingEvidence.includes('premise:M2'))
  ok('E. decision scoped to this run: premise inherit + PASS, delegated verdict stays UNKNOWN, bundle not PASS')
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
      conditions: { ender_eye_ready: 'PASS', model_authority: 'PASS', nether_reached: 'PASS' },
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
  mkdirSync(join(root, 'buddy-driver', 'data', 'resident'), { recursive: true })
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
