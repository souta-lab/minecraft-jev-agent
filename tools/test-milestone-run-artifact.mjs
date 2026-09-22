#!/usr/bin/env bun
// test-milestone-run-artifact: offline fixtures for tools/milestone-run-artifact.mjs.
//
// Every fixture below is a synthetic resident tree (buddy-driver/buddy.log,
// buddy-driver/logs/jev/decisions.jsonl, buddy-driver/runner.out and
// buddy-driver/data/resident/acceptance-<runId>.json). No live resident, socket,
// or network is used: the flags always include --no-control-socket.
//
//   A. PASS-shaped run   -> exit 0, status PASS, missingEvidence [] and both gates
//                           delegated PASS verdicts (nothing fabricated)
//   B. FAIL-shaped run   -> exit 1, M3 FAIL (crafting inputs complete, eyes short)
//                           while M2 still PASSes
//   C. no --run          -> exit 2, status UNKNOWN, missingEvidence ['runId']
//   D. valid runId, no evidence -> exit 2, UNKNOWN, non-empty missingEvidence
//   E. cross-run evidence -> the requested run's evidence exists but belongs to
//                           another BOOT run: it must never be attributed, so the
//                           gates stay UNKNOWN (no joining across runs)
//   F. fake gate that emits no machine status line -> UNKNOWN, never PASS
//   G. CLI surface (--help / --out)
//   H. server.properties reader whitelist
//   I. no Nether transition -> predicate UNKNOWN, never PASS
//   J. operator decisions: annotated, never a gate flip
//   K/L/M. authority attestation: configured stack, absent marker, foreign runId
//   N/O. milestone acceptance from the delegated verdicts; the complete-run field list
//   P. source provenance: the LATEST source-changing RELOAD hash is the effective
//      source while run.boot.sourceSha stays the run's origin (with trigger/at/
//      generationId/line index, and the line index points at the real marker)
//   Q. no reload marker -> explicit `provenance: "boot"` fallback; a window-blind
//      bundle change is NAMED in missingEvidenceDetail, a clean first-boot window
//      stays COMPLETE (the fallback is never silent and never a fabricated SHA)
//   R. RELOAD markers from another runId are never attributed; the foreign run
//      still resolves its own window
//   S. skipped=unchanged / ok=false markers are OBSERVED but never a new source
//   T. deferred=frozen is staged only; a successful RESUME alone commits it
//   U. the control-socket generation hash is a READ-ONLY cross-check (agreement /
//      disagreement recorded; a foreign runId or a missing socket changes nothing)
//
// Usage: bun tools/test-milestone-run-artifact.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attributeRunLines, buildRunArtifact, coercePropertyValue, readServerProperties, runCli } from './milestone-run-artifact.mjs'
import { scanRunLines } from './m2-gate.mjs'
import { runM3Gate } from './m3-gate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOL = join(HERE, 'milestone-run-artifact.mjs')
const ROOTS = []

let checks = 0
function ok(label) {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

const T0 = Date.parse('2026-09-21T07:00:00.000Z')
const at = (sec) => new Date(T0 + sec * 1000).toISOString()
const line = (sec, body) => `[${at(sec)}] ${body}`
const SOURCE_SHA = '7164b92586fec83c340f5ce874dd81416d4247b2'
const WORLD_KEY = '{"serverId":"127.0.0.1:25565","dimension":"minecraft:overworld","worldEpoch":1}'

const boot = (sec, runId, { generations = 0, reloads = 0, sourceSha = SOURCE_SHA } = {}) =>
  line(
    sec,
    `BOOT pid=4242 runId=${runId} source=${sourceSha} runtime=bun runtimeVersion=1.4.2 bundle=none ` +
      `milestone=null generations=${generations} reloads=${reloads} contractVersion=3 schemaVersion=3 revision=1 worldEpoch=1 worldKey=${WORLD_KEY}`,
  )

const spawnLine = (sec) =>
  line(sec, 'SPAWN pos=0.5,64.0,0.5 version=1.21.11 health=20 username=AI_Buddy dimension=minecraft:overworld worldEpoch=1')

const environmentLine = (sec) =>
  line(sec, 'ENVIRONMENT difficulty=normal spawnMonsters=true spawnAnimals=true spawnMobs=true advanceTime=false keepInventory=true')

const PORTAL_CHAIN = [
  'PORTAL_BLOCK_PLACED pos=1,64,0',
  'PORTAL_BLOCK_PLACED pos=2,64,0',
  'PORTAL_FRAME_READY blocks=10 shape=ok',
  'PORTAL_LIT pos=2,65,0 dimension=minecraft:overworld',
  'PORTAL_VERIFIED=true',
]

/**
 * The runner.out-shaped authority window for one run.
 *
 * `stack` is the resident's `system2AuthorityStack` marker (the CONFIGURED
 * authority stack), `decisions` are the `SYSTEM2_AUTHORITY_DECISION` lines (the
 * providers that actually answered) and `released` closes the window so the
 * policy loader can bracket it without a control socket.
 *
 * Source provenance additions (all default to "the run never reloaded"):
 *   `build`        emits the host's boot-generation `BUILD hash=<h>` line
 *   `reloads`      `{sec, body}` RELOAD marker lines, in the order given
 *   `resumes`      `{sec, ok}` RESUME markers, merged with `reloads` by `sec`
 *   `bootReloads` / `bootGenerations` / `sourceSha`  the BOOT line's own fields
 */
function runnerOut(
  runId,
  {
    stack = '{"provider":"hybrid","model":"typesafe-ai:typesafe-ai/jev"}',
    decisions = ['SYSTEM2_AUTHORITY_DECISION provider=typesafe-ai model=typesafe-ai/jev chosen=front_nether_portal'],
    released = true,
    ready = true,
    offsetSec = 0,
    build = null,
    reloads = [],
    resumes = [],
    bootReloads = 0,
    bootGenerations = 0,
    sourceSha = SOURCE_SHA,
  } = {},
) {
  const lines = [boot(offsetSec, runId, { generations: bootGenerations, reloads: bootReloads, sourceSha })]
  if (build !== null) {
    lines.push(line(offsetSec + 0.5, `BUILD hash=${build} bytes=6181238 ms=51 outfile=/fixture/data/resident/gen-${build}`))
  }
  if (ready) {
    lines.push(
      line(
        offsetSec + 1,
        'GENERATION_READY id=gen-test-1 rungIndex=13 rungId=nether_portal ' +
          'goals=["verify the lit nether_portal block in the overworld","enter the lit nether_portal"] ' +
          'policy=typesafe policyProvider=typesafe-ai model=typesafe-ai/jev policyModel=typesafe-ai/jev ' +
          (stack === null ? '' : `system2AuthorityStack=${stack} `) +
          'system2LastAuthority={"provider":"none","model":"none"} deterministicFallbackEnabled=false ' +
          'planner=llm plannerModel=typesafe-ai/jev',
      ),
    )
  }
  for (const [index, decision] of decisions.entries()) lines.push(line(offsetSec + 2 + index * 0.1, decision))
  if (released) lines.push(line(offsetSec + 3 + decisions.length * 0.1, `HOST_LOCK released runId=${runId}`))
  const extras = [
    ...resumes.map((resume) => ({ sec: resume.sec, body: `RESUME ok=${resume.ok === false ? 'false' : 'true'} reconnect=false` })),
    ...reloads.map((reload) => ({ sec: reload.sec, body: reload.body })),
  ].sort((left, right) => left.sec - right.sec)
  for (const extra of extras) lines.push(line(extra.sec, extra.body))
  return lines.join('\n') + '\n'
}

const DECISIONS = `${JSON.stringify({ record: 'decision', ts: at(2), source: 'jev', action: 'GOTO:nether_portal' })}\n`

const ACCEPTANCE = (runId) =>
  JSON.stringify({
    record: 'acceptance',
    runId,
    ts: at(40),
    gitCommit: 'd8d53c298cdebbde33a14f20e43136263269c666',
    generationHash: 'e6be1812c804',
    contractVersion: 3,
    stateSchemaVersion: 3,
    worldEpoch: 1,
    serverId: '127.0.0.1:25565',
    dimension: 'minecraft:overworld',
    mode: 'llm',
    goalComplete: false,
    dependencies: { mineflayer: '4.39.0' },
  })

function makeRoot(name) {
  const root = mkdtempSync(join(tmpdir(), `run-artifact-${name}-`))
  ROOTS.push(root)
  mkdirSync(join(root, 'buddy-driver', 'data', 'resident'), { recursive: true })
  mkdirSync(join(root, 'buddy-driver', 'logs', 'jev'), { recursive: true })
  return root
}

function writeFixture(root, runId, { logLines, acceptance = true, runner = {} }) {
  writeFileSync(join(root, 'buddy-driver', 'buddy.log'), `${logLines.join('\n')}\n`, 'utf8')
  writeFileSync(join(root, 'buddy-driver', 'runner.out'), runnerOut(runId, runner), 'utf8')
  writeFileSync(join(root, 'buddy-driver', 'logs', 'jev', 'decisions.jsonl'), DECISIONS, 'utf8')
  if (acceptance) {
    writeFileSync(join(root, 'buddy-driver', 'data', 'resident', `acceptance-${runId}.json`), ACCEPTANCE(runId), 'utf8')
  }
}

/** Build a complete-looking log for `runId`, varying only the terminal eyes. */
function fullLog(runId, { terminalEye }) {
  return [
    boot(0, runId),
    spawnLine(1),
    environmentLine(2),
    line(
      10,
      'INVENTORY items={"diamond":3,"diamond_pickaxe":1,"flint_and_steel":1,"obsidian":10,' +
        '"ender_pearl":12,"blaze_rod":8,"blaze_powder":16,"ender_eye":0} pos=0.5,64.0,0.5',
    ),
    ...PORTAL_CHAIN.map((body, index) => line(11 + index, body)),
    // M3 requires live proof of Nether arrival, so the endgame fixture records the transition the way
    // the resident does (a marker carrying `dimension=`), which the gate reads as a run-scoped fact.
    line(19, 'HEARTBEAT pos=0.5,64.0,0.5 health=20 dimension=minecraft:the_nether'),
    line(
      20,
      `MILESTONE name=ender_eye frontier=true index=15 queueDone=0 inventory={"ender_eye":0,"ender_pearl":12,` +
        '"blaze_rod":8,"blaze_powder":16,"diamond":3,"diamond_pickaxe":1,"flint_and_steel":1,"obsidian":10}',
    ),
    line(
      30,
      `INVENTORY items={"diamond":3,"diamond_pickaxe":1,"ender_eye":${terminalEye},"ender_pearl":0,` +
        '"blaze_rod":0,"blaze_powder":0} pos=0.5,64.0,0.5',
    ),
  ]
}

function cli(args) {
  const result = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' })
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    json: () => JSON.parse(result.stdout),
  }
}

const RUN_PASS = 'run-fixture-pass'
const RUN_FAIL = 'run-fixture-fail'

// ---------------------------------------------------------------------------
// A. PASS-shaped run
// ---------------------------------------------------------------------------
const passRoot = makeRoot('pass')
writeFixture(passRoot, RUN_PASS, { logLines: fullLog(RUN_PASS, { terminalEye: 12 }) })
const pass = cli(['--run', RUN_PASS, '--root', passRoot, '--json', '--no-control-socket'])
assert.equal(pass.code, 0, `PASS fixture exit=${pass.code} stderr=${pass.stderr}`)
const passArtifact = pass.json()
assert.equal(passArtifact.status, 'PASS')
assert.equal(passArtifact.complete, true)
assert.deepEqual(passArtifact.missingEvidence, [])
assert.equal(passArtifact.verdicts.M2.status, 'PASS')
assert.equal(passArtifact.verdicts.M3.status, 'PASS')
assert.equal(passArtifact.run.runId, RUN_PASS)
assert.equal(passArtifact.run.boot.sourceSha, SOURCE_SHA)
assert.equal(passArtifact.run.runtime, 'bun')
assert.equal(passArtifact.run.runtimeVersion, '1.4.2')
assert.equal(passArtifact.run.contractVersion, 3)
assert.equal(passArtifact.run.schemaVersion, 3)
assert.equal(passArtifact.run.worldEpoch, 1)
assert.deepEqual(passArtifact.run.worldKey, {
  serverId: '127.0.0.1:25565',
  dimension: 'minecraft:overworld',
  worldEpoch: 1,
})
assert.equal(passArtifact.run.serverVersion, '1.21.11')
// Embedded delegation: the verdict lines are the gates' own machine lines.
assert.ok(passArtifact.verdicts.M2.lines.some((l) => /^M2_RUN_RESULT status=PASS\b/.test(l)))
assert.ok(passArtifact.verdicts.M3.lines.some((l) => /^M3_RUN_RESULT status=PASS\b/.test(l)))
// Inventory: boot vs latest and the milestone subset with first/last timestamps.
assert.equal(passArtifact.inventory.boot.counts.diamond, 3)
assert.equal(passArtifact.inventory.latest.counts.ender_eye, 12)
const eye = passArtifact.inventory.milestoneItems.ender_eye
assert.equal(eye.boot, 0)
assert.equal(eye.latest, 12)
assert.equal(eye.max, 12)
assert.equal(eye.observed, true)
assert.equal(eye.held, true)
assert.equal(eye.firstHeldAt, at(30))
assert.equal(eye.lastHeldAt, at(30))
assert.equal(eye.firstObservedAt, at(10))
assert.equal(eye.lastObservedAt, at(30))
assert.equal(passArtifact.inventory.milestoneItems.ender_pearl.max, 12)
// Environment + authority facts.
assert.equal(passArtifact.environment.difficulty.value, 'normal')
assert.equal(passArtifact.environment.mobSpawning.value, true)
assert.deepEqual(passArtifact.environment.gamerules.value, { advanceTime: false, keepInventory: true, spawnMobs: true })
// The endgame run observed the overworld gate and then the Nether, which is what M3 requires; the
// artifact reports both, in observation order.
assert.deepEqual(passArtifact.environment.dimensions.observed, [
  'minecraft:overworld',
  'minecraft:the_nether',
])
assert.deepEqual(passArtifact.verdicts.M3.conditions.nether_reached, 'PASS')
assert.equal(passArtifact.authority.plannerMode, 'llm')
assert.equal(passArtifact.authority.policyProvider, 'typesafe-ai')
assert.equal(passArtifact.authority.policyModel, 'typesafe-ai/jev')
assert.equal(passArtifact.authority.deterministicFallbackEnabled, false)
assert.equal(passArtifact.authority.system2.provider, 'typesafe-ai')
assert.equal(passArtifact.authority.system2.model, 'typesafe-ai/jev')
assert.equal(passArtifact.authority.system2.portalPlanCount, 1)
// Acceptance artifact was read and is run-bound.
assert.equal(passArtifact.acceptance.present, true)
assert.equal(passArtifact.acceptance.record.runId, RUN_PASS)
// The tool's own attribution agrees with the gates' scanner.
{
  const lines = readFileSync(join(passRoot, 'buddy-driver', 'buddy.log'), 'utf8').split(/\r?\n/)
  const mine = attributeRunLines(RUN_PASS, lines)
  const gate = scanRunLines(RUN_PASS, lines)
  assert.equal(mine.inventorySamples.length, gate.inventorySamples.length)
  assert.equal(mine.dimensionObservations.length, gate.dimensionObservations.length)
  assert.deepEqual(
    mine.inventorySamples.map((s) => s.counts),
    gate.inventorySamples,
  )
}
ok('PASS-shaped fixture: exit 0, missingEvidence [], both gate verdicts embedded')

// First-class milestone predicate evidence: every M2/M3 predicate is present,
// names its own evidence source, and the section is run-scoped.
{
  const section = passArtifact.milestonePredicates
  assert.equal(section.record, 'milestone-predicates')
  assert.equal(section.runId, RUN_PASS)
  assert.equal(section.sourceSha, SOURCE_SHA)
  assert.deepEqual(section.missing, [])
  assert.deepEqual(section.mismatches, [])
  const byId = (id) => section.predicates.find((predicate) => predicate.id === id)
  assert.deepEqual(
    section.predicates.map((predicate) => predicate.id),
    ['portal_built', 'portal_lit', 'portal_verified', 'nether_reached', 'blaze_rods', 'ender_pearls', 'ender_eyes'],
  )
  for (const predicate of section.predicates) {
    assert.equal(predicate.satisfied, true, `${predicate.id} must be proven by the PASS fixture`)
    assert.equal(typeof predicate.source, 'string')
    assert.equal(typeof predicate.observedAtMs, 'number')
  }
  assert.equal(byId('portal_built').source, 'log:PORTAL_FRAME_READY')
  assert.equal(byId('nether_reached').source, 'log:dimension')
  assert.equal(byId('ender_eyes').source, 'log:INVENTORY')
}
ok('PASS fixture carries a first-class, run-scoped milestone predicate section')

// A host observation for this run must be merged into the artifact section and
// upgrade the delegated M3 verdict only because it is truly observed.
{
  const runId = 'run-fixture-host'
  const hostRoot = makeRoot('host')
  writeFixture(hostRoot, runId, { logLines: fullLog(runId, { terminalEye: 0 }) })
  writeFileSync(
    join(hostRoot, 'buddy-driver', 'data', 'resident', `milestone-predicates-${runId}.json`),
    JSON.stringify({
      record: 'milestone-predicates',
      schemaVersion: 1,
      runId,
      sourceSha: SOURCE_SHA,
      generationId: 'gen-host-1',
      observationCount: 3,
      updatedAt: at(45),
      predicates: [
        { id: 'ender_eyes', satisfied: true, observedAtMs: T0 + 45000, observedAt: at(45), source: 'host-observe:rung:ender_eyes', evidence: { rungId: 'ender_eyes' } },
      ],
    }),
  )
  const hosted = cli(['--run', runId, '--root', hostRoot, '--json', '--no-control-socket'])
  assert.equal(hosted.code, 0, `hosted fixture exit=${hosted.code} stderr=${hosted.stderr}`)
  const hostedArtifact = hosted.json()
  const eyes = hostedArtifact.milestonePredicates.predicates.find((predicate) => predicate.id === 'ender_eyes')
  assert.equal(eyes.satisfied, true, 'the resident observation proves the predicate')
  assert.equal(eyes.source, 'host-observe:rung:ender_eyes')
  assert.equal(hostedArtifact.milestonePredicates.hostObservation.present, true)
  assert.ok(hostedArtifact.milestonePredicates.observationSources.includes('host-observe'))
  assert.equal(hostedArtifact.verdicts.M3.status, 'PASS', 'a truly observed predicate can satisfy the terminal condition')
  assert.deepEqual(hostedArtifact.missingEvidence, [])

  // The SAME host file with a DIFFERENT source SHA must be rejected, the derived
  // log fact kept, and the top-level integrity gap surfaced.
  const mismatchRoot = makeRoot('host-mismatch')
  writeFixture(mismatchRoot, runId, { logLines: fullLog(runId, { terminalEye: 0 }) })
  writeFileSync(
    join(mismatchRoot, 'buddy-driver', 'data', 'resident', `milestone-predicates-${runId}.json`),
    JSON.stringify({
      record: 'milestone-predicates',
      schemaVersion: 1,
      runId,
      sourceSha: 'f'.repeat(40),
      predicates: [{ id: 'ender_eyes', satisfied: true, observedAtMs: T0 + 45000, observedAt: at(45), source: 'host-observe:rung:ender_eyes', evidence: {} }],
    }),
  )
  const mismatched = cli(['--run', runId, '--root', mismatchRoot, '--json', '--no-control-socket'])
  const mismatchedArtifact = mismatched.json()
  assert.equal(mismatchedArtifact.milestonePredicates.predicates.find((predicate) => predicate.id === 'ender_eyes').satisfied, false)
  assert.equal(mismatchedArtifact.milestonePredicates.mismatches.length, 1)
  assert.ok(mismatchedArtifact.missingEvidence.includes('milestonePredicate:source_mismatch'))
  assert.notEqual(mismatchedArtifact.verdicts.M3.status, 'PASS')
}
ok('a run-scoped host observation upgrades a predicate; a sourceSha mismatch is rejected and surfaced')


// ---------------------------------------------------------------------------
// B. FAIL-shaped run (materials complete, eyes short)
// ---------------------------------------------------------------------------
const failRoot = makeRoot('fail')
writeFixture(failRoot, RUN_FAIL, { logLines: fullLog(RUN_FAIL, { terminalEye: 0 }) })
const fail = cli(['--run', RUN_FAIL, '--root', failRoot, '--json', '--no-control-socket'])
assert.equal(fail.code, 1, `FAIL fixture exit=${fail.code} stderr=${fail.stderr}`)
const failArtifact = fail.json()
assert.equal(failArtifact.status, 'FAIL')
assert.equal(failArtifact.verdicts.M3.status, 'FAIL')
assert.equal(failArtifact.verdicts.M2.status, 'PASS')
assert.notEqual(failArtifact.verdicts.M3.status, 'PASS')
assert.deepEqual(failArtifact.missingEvidence, [])
ok('FAIL-shaped fixture: exit 1, M3 FAIL while M2 still PASS, no fabricated PASS')

// ---------------------------------------------------------------------------
// C. no --run: UNKNOWN, exit 2, missingEvidence names runId
// ---------------------------------------------------------------------------
const noRun = cli(['--root', passRoot, '--json'])
assert.equal(noRun.code, 2)
const noRunArtifact = noRun.json()
assert.equal(noRunArtifact.status, 'UNKNOWN')
assert.equal(noRunArtifact.reason, 'exact_run_scope_required')
assert.deepEqual(noRunArtifact.missingEvidence, ['runId'])
assert.equal(noRunArtifact.verdicts.M2.status, 'UNKNOWN')
assert.equal(noRunArtifact.verdicts.M3.status, 'UNKNOWN')
assert.notEqual(noRunArtifact.status, 'PASS')
ok('missing --run: exit 2, UNKNOWN, missingEvidence ["runId"]')

// An invalid run-id shape is also refused, never treated as a run.
const badRun = cli(['--run', 'not-a-run', '--root', passRoot, '--json'])
assert.equal(badRun.code, 2)
assert.equal(badRun.json().status, 'UNKNOWN')
assert.deepEqual(badRun.json().missingEvidence, ['runId'])
ok('invalid --run shape: exit 2, UNKNOWN, no evidence lookup')

// ---------------------------------------------------------------------------
// D. valid runId but no evidence at all
// ---------------------------------------------------------------------------
const emptyRoot = makeRoot('empty')
const empty = cli(['--run', 'run-fixture-absent', '--root', emptyRoot, '--json', '--no-control-socket'])
assert.equal(empty.code, 2)
const emptyArtifact = empty.json()
assert.equal(emptyArtifact.status, 'UNKNOWN')
assert.notEqual(emptyArtifact.status, 'PASS')
assert.equal(emptyArtifact.verdicts.M2.status, 'UNKNOWN')
assert.equal(emptyArtifact.verdicts.M3.status, 'UNKNOWN')
assert.ok(emptyArtifact.missingEvidence.includes('boot'))
assert.ok(emptyArtifact.missingEvidence.includes('inventory.boot'))
assert.ok(emptyArtifact.missingEvidence.includes('verdict:M2'))
assert.ok(emptyArtifact.missingEvidence.includes('verdict:M3'))
assert.ok(emptyArtifact.missingEvidence.includes('acceptance'))
assert.ok(!emptyArtifact.missingEvidence.includes('runId'), 'the runId itself was supplied')
ok('valid runId with no evidence: exit 2, UNKNOWN, evidence gaps listed')

// ---------------------------------------------------------------------------
// E. cross-run evidence must never be attributed to the requested run
// ---------------------------------------------------------------------------
const crossRoot = makeRoot('cross')
const OTHER = 'run-fixture-other'
// OTHER owns a complete-looking run; the requested run only has its own BOOT.
const crossLines = [
  ...fullLog(OTHER, { terminalEye: 12 }),
  boot(100, 'run-fixture-empty'),
  line(101, 'HEARTBEAT pos=0,64,0 running=true'),
]
writeFixture(crossRoot, 'run-fixture-empty', { logLines: crossLines })
const cross = cli(['--run', 'run-fixture-empty', '--root', crossRoot, '--json', '--no-control-socket'])
assert.equal(cross.code, 2)
const crossArtifact = cross.json()
assert.equal(crossArtifact.inventory.observationCount, 0, 'foreign-run inventory must not be attributed')
assert.equal(crossArtifact.inventory.milestoneItems.ender_eye.observed, false)
assert.notEqual(crossArtifact.verdicts.M2.status, 'PASS')
assert.notEqual(crossArtifact.verdicts.M3.status, 'PASS')
assert.equal(crossArtifact.verdicts.M2.status, 'UNKNOWN')
assert.equal(crossArtifact.verdicts.M3.status, 'UNKNOWN')
ok('cross-run fixture: foreign BOOT evidence is not attributed, gates stay UNKNOWN')

// ---------------------------------------------------------------------------
// F. a gate with no machine status line can never be reported as PASS
// ---------------------------------------------------------------------------
{
  const { artifact, exitCode } = await buildRunArtifact({
    runId: RUN_PASS,
    root: passRoot,
    overrides: { controlSocketPath: null },
    gates: {
      M2: async ({ write }) => {
        write('M2_RUN_GATE — fake gate with no status line')
        return 0
      },
      M3: runM3Gate,
    },
  })
  assert.equal(exitCode, 2)
  assert.equal(artifact.verdicts.M2.status, 'UNKNOWN')
  assert.notEqual(artifact.verdicts.M2.status, 'PASS')
  assert.ok(artifact.missingEvidence.includes('verdict:M2'))
  assert.equal(artifact.verdicts.M3.status, 'PASS')
}
ok('fake gate without a status line: UNKNOWN, never PASS')

// ---------------------------------------------------------------------------
// G. CLI surface: --help is 0; --out writes a parseable artifact
// ---------------------------------------------------------------------------
{
  const help = await runCli({ argv: ['--help'], write: () => {}, writeError: () => {} })
  assert.equal(help.exitCode, 0)
  const outPath = join(passRoot, 'artifact.json')
  const written = await runCli({
    argv: ['--run', RUN_PASS, '--root', passRoot, '--out', outPath, '--no-control-socket'],
    write: () => {},
    writeError: () => {},
  })
  assert.equal(written.exitCode, 0)
  const parsed = JSON.parse(readFileSync(outPath, 'utf8'))
  assert.equal(parsed.runId, RUN_PASS)
  assert.equal(parsed.missingEvidence.length, 0)
}
ok('--help exits 0; --out writes a parseable complete artifact')

// ---------------------------------------------------------------------------
// H. server.properties reader: whitelisted facts only, never credentials
// ---------------------------------------------------------------------------
{
  const root = makeRoot('props')
  const propsPath = join(root, 'server.properties')
  writeFileSync(
    propsPath,
    [
      '#Minecraft server properties',
      'difficulty=normal',
      'spawn-monsters=true',
      'spawn-animals=false',
      'level-name=world',
      'level-seed=2024',
      'gamemode=survival',
      'pvp=true',
      'rcon.password=SUPERSECRET',
      'online-mode=false',
    ].join('\n'),
  )
  const props = readServerProperties(propsPath)
  assert.equal(props.runScoped, false)
  assert.equal(props.values.difficulty, 'normal')
  assert.equal(props.values['spawn-monsters'], 'true')
  assert.equal(props.values['rcon.password'], undefined)
  assert.ok(!JSON.stringify(props).includes('SUPERSECRET'), 'credentials must never be echoed')
  assert.equal(coercePropertyValue('true'), true)
  assert.equal(coercePropertyValue('2024'), 2024)
  assert.equal(coercePropertyValue('world'), 'world')
}
ok('server.properties reader whitelists facts and never echoes credentials')

// ---------------------------------------------------------------------------
// I. no Nether transition: the predicate is UNKNOWN, never PASS
// ---------------------------------------------------------------------------
{
  const runId = 'run-fixture-nonether'
  const root = makeRoot('nonether')
  const lines = fullLog(runId, { terminalEye: 12 }).filter((entry) => !entry.includes('dimension=minecraft:the_nether'))
  writeFixture(root, runId, { logLines: lines })
  const result = cli(['--run', runId, '--root', root, '--json', '--no-control-socket'])
  const artifact = result.json()
  const nether = artifact.milestonePredicates.predicates.find((predicate) => predicate.id === 'nether_reached')
  assert.equal(nether.satisfied, null, 'a run with no transition observation must not claim the predicate')
  assert.equal(nether.source, null)
  assert.equal(nether.evidence.lastDimension, 'minecraft:overworld')
  assert.ok(artifact.milestonePredicates.missing.includes('nether_reached'))
  assert.equal(artifact.verdicts.M3.conditions.nether_reached, 'UNKNOWN')
  assert.equal(artifact.verdicts.M3.conditions.ender_eye_ready, 'PASS', 'the eyes are still proven')
  assert.notEqual(artifact.status, 'PASS')
  assert.notEqual(result.code, 0)
}
ok('a run with 12 eyes but no Nether transition: nether_reached UNKNOWN, artifact not PASS')

// ---------------------------------------------------------------------------
// J. operator decision: annotated when corroborated, never a silent gate flip
// ---------------------------------------------------------------------------
{
  const runId = 'run-fixture-inherited'
  const root = makeRoot('inherited')
  // A run that INHERITED a verified portal: the runtime verifier reports
  // PORTAL_VERIFIED=true with no build chain of its own.
  const inheritedLog = [
    boot(0, runId),
    spawnLine(1),
    environmentLine(2),
    line(10, 'INVENTORY items={"diamond":3,"diamond_pickaxe":1,"obsidian":10,"ender_pearl":12,"blaze_rod":8,"ender_eye":0} pos=0.5,64.0,0.5'),
    line(11, 'PORTAL_VERIFIED=true'),
    line(19, 'HEARTBEAT pos=0.5,64.0,0.5 health=20 dimension=minecraft:the_nether'),
  ]
  writeFixture(root, runId, { logLines: inheritedLog })

  const base = cli(['--run', runId, '--root', root, '--json', '--no-control-socket', '--no-operator-decisions'])
  const baseArtifact = base.json()
  assert.equal(baseArtifact.verdicts.M2.status, 'UNKNOWN')
  assert.equal(baseArtifact.verdicts.M2.reason, 'inherited_portal')
  assert.ok(baseArtifact.verdicts.M2.lines.some((entry) => /^m2_inherited_portal: true/.test(entry)))
  assert.equal(baseArtifact.verdicts.M2.operatorDecision, null)
  assert.equal(baseArtifact.operatorDecisions.present, false)

  const decisionsPath = join(root, 'operator-decisions.json')
  writeFileSync(
    decisionsPath,
    JSON.stringify({
      record: 'operator-decisions',
      schemaVersion: 1,
      decisions: [
        {
          record: 'operator-decision',
          milestone: 'M2',
          status: 'PASS',
          authority: 'operator',
          runId,
          basis: 'inherited_portal',
          ruling: 'fixture: M2 passes on standing evidence',
          recordedAt: at(50),
        },
      ],
    }),
  )
  const applied = cli(['--run', runId, '--root', root, '--json', '--no-control-socket', '--operator-decisions', decisionsPath])
  const appliedArtifact = applied.json()
  // The delegated verdict is UNCHANGED; only an annotation is added.
  assert.equal(appliedArtifact.verdicts.M2.status, 'UNKNOWN')
  assert.equal(appliedArtifact.verdicts.M2.reason, 'inherited_portal')
  assert.equal(appliedArtifact.verdicts.M2.operatorDecision.status, 'PASS')
  assert.equal(appliedArtifact.verdicts.M2.operatorDecision.gateStatus, 'UNKNOWN')
  assert.equal(appliedArtifact.verdicts.M2.operatorDecision.basis, 'inherited_portal')
  assert.equal(appliedArtifact.verdicts.M2.operatorDecision.ruling, 'fixture: M2 passes on standing evidence')
  assert.ok(appliedArtifact.verdicts.M2.operatorDecision.evidence.inheritedPortalLines.length >= 1)
  assert.deepEqual(appliedArtifact.operatorDecisions.applied, [{ milestone: 'M2', status: 'PASS' }])
  // An operator annotation must not manufacture a PASS artifact either.
  assert.notEqual(appliedArtifact.status, 'PASS')

  // NOT corroborated: the same decision against a run that built its own chain.
  const builtRoot = makeRoot('inherited-not-corroborated')
  writeFixture(builtRoot, runId, { logLines: fullLog(runId, { terminalEye: 12 }) })
  const notCorroborated = cli(['--run', runId, '--root', builtRoot, '--json', '--no-control-socket', '--operator-decisions', decisionsPath])
  const notCorroboratedArtifact = notCorroborated.json()
  assert.equal(notCorroboratedArtifact.verdicts.M2.operatorDecision.status, 'NOT_APPLIED')
  assert.match(notCorroboratedArtifact.verdicts.M2.operatorDecision.reason, /^basis_not_corroborated:inherited_portal$/)
  assert.deepEqual(notCorroboratedArtifact.operatorDecisions.applied, [])

  // A decision for ANOTHER run never applies to this one.
  const other = cli(['--run', 'run-fixture-unrelated', '--root', root, '--json', '--no-control-socket', '--operator-decisions', decisionsPath])
  assert.equal(other.json().verdicts.M2.operatorDecision, null)
}
ok('operator decisions are corroborated, annotated without rewriting the gate, and run-scoped')

// ---------------------------------------------------------------------------
// K. authority attestation: the CONFIGURED stack attests provider/model even
//    when no SYSTEM2_AUTHORITY_DECISION line exists yet (the live defect: the
//    marker was captured but never fed into authority.system2).
// ---------------------------------------------------------------------------
{
  const runId = 'run-fixture-authority'
  const root = makeRoot('authority')
  writeFixture(root, runId, {
    logLines: fullLog(runId, { terminalEye: 12 }),
    runner: {
      stack: '{"provider":"hybrid","model":"typesafe-ai:typesafe-ai/jev|muse-spark:meta/muse-spark-1.3-contributor"}',
      decisions: [],
    },
  })
  const result = cli(['--run', runId, '--root', root, '--json', '--no-control-socket'])
  const artifact = result.json()
  assert.equal(artifact.authority.system2.provider, 'muse-spark')
  assert.equal(artifact.authority.system2.model, 'meta/muse-spark-1.3-contributor')
  assert.equal(artifact.authority.system2.attested, true)
  assert.equal(artifact.authority.system2.attestation.kind, 'configured_authority_stack')
  assert.equal(artifact.authority.system2.attestation.source, 'log:GENERATION_READY:system2AuthorityStack')
  assert.equal(artifact.authority.system2.decisionCount, 0, 'this run has no decision line at all')
  assert.deepEqual(artifact.authority.system2.stack.jev, { provider: 'typesafe-ai', model: 'typesafe-ai/jev' })
  assert.equal(artifact.authority.system2.lastAuthority.provider, 'none', 'the last answerer is still "none"')
  assert.equal(artifact.authority.jev.provider, 'typesafe-ai')
  assert.equal(artifact.authority.jev.model, 'typesafe-ai/jev')
  assert.equal(artifact.authority.jev.attested, true)
  assert.ok(!artifact.missingEvidence.includes('authority.system2'))
  assert.ok(!artifact.missingEvidence.includes('authority.jev'))
  // The delegated gates still need their own decision evidence: a configured
  // stack alone must never manufacture a PASS.
  assert.notEqual(artifact.verdicts.M2.status, 'PASS')
  assert.notEqual(artifact.status, 'PASS')
}
ok('a configured authority stack attests System2/Jev provider+model with no decision line')

// ---------------------------------------------------------------------------
// L. no authority marker at all: the gap stays, with its reason (no invention)
// ---------------------------------------------------------------------------
{
  const runId = 'run-fixture-no-authority'
  const root = makeRoot('no-authority')
  writeFixture(root, runId, {
    logLines: fullLog(runId, { terminalEye: 12 }),
    runner: { stack: null, decisions: [] },
  })
  const artifact = cli(['--run', runId, '--root', root, '--json', '--no-control-socket']).json()
  assert.equal(artifact.authority.system2.provider, null)
  assert.equal(artifact.authority.system2.model, null)
  assert.equal(artifact.authority.system2.authorityStack, null)
  assert.ok(artifact.missingEvidence.includes('authority.system2'))
  const gap = artifact.missingEvidenceDetail.find((entry) => entry.field === 'authority.system2')
  assert.ok(gap, 'the missing authority fact must carry a reason')
  assert.match(gap.reason, /system2AuthorityStack/)
  // The Jev halves are separate markers and stay attested.
  assert.equal(artifact.authority.jev.provider, 'typesafe-ai')
  assert.ok(!artifact.missingEvidence.includes('authority.jev'))
  // missingEvidence and missingEvidenceDetail are one list, not two truths.
  assert.equal(artifact.missingEvidenceDetail.length, artifact.missingEvidence.length)
  assert.deepEqual(
    artifact.missingEvidenceDetail.map((entry) => entry.field),
    artifact.missingEvidence,
  )
}
ok('a run with no authority marker keeps authority.system2 missing with a reason (no invention)')

// ---------------------------------------------------------------------------
// M. markers from a DIFFERENT runId in the same file are never attributed
// ---------------------------------------------------------------------------
{
  const foreign = 'run-fixture-foreign-authority'
  const target = 'run-fixture-target-no-authority'
  const root = makeRoot('foreign-authority')
  const runnerText =
    runnerOut(foreign, {
      stack: '{"provider":"hybrid","model":"typesafe-ai:typesafe-ai/jev|muse-spark:meta/muse-spark-1.3-contributor"}',
      decisions: [],
    }).trimEnd() +
    '\n' +
    runnerOut(target, { stack: null, decisions: [], offsetSec: 100 }).trimEnd() +
    '\n'
  writeFileSync(join(root, 'buddy-driver', 'runner.out'), runnerText, 'utf8')
  writeFileSync(
    join(root, 'buddy-driver', 'buddy.log'),
    `${[boot(100, target), line(101, 'HEARTBEAT pos=0,64,0 running=true')].join('\n')}\n`,
    'utf8',
  )
  writeFileSync(join(root, 'buddy-driver', 'logs', 'jev', 'decisions.jsonl'), '', 'utf8')

  const targetArtifact = cli(['--run', target, '--root', root, '--json', '--no-control-socket']).json()
  assert.equal(targetArtifact.authority.system2.provider, null, 'the FOREIGN stack must not be attributed')
  assert.equal(targetArtifact.authority.system2.authorityStack, null)
  assert.ok(targetArtifact.missingEvidence.includes('authority.system2'))

  // The foreign run's OWN window still attests its own stack.
  const foreignArtifact = cli(['--run', foreign, '--root', root, '--json', '--no-control-socket']).json()
  assert.equal(foreignArtifact.authority.system2.provider, 'muse-spark')
}
ok('authority markers from a different runId in the same file are never used for this run')

// ---------------------------------------------------------------------------
// N. acceptance present + milestone incomplete -> INCOMPLETE, never PASS
// ---------------------------------------------------------------------------
{
  const runId = 'run-fixture-incomplete-acceptance'
  const root = makeRoot('incomplete-acceptance')
  writeFixture(root, runId, { logLines: fullLog(runId, { terminalEye: 0 }) })
  const result = cli(['--run', runId, '--root', root, '--json', '--no-control-socket'])
  const artifact = result.json()
  assert.equal(artifact.acceptance.present, true)
  assert.equal(artifact.acceptance.record.runId, runId)
  assert.equal(artifact.acceptance.writer.symbol, 'writeAcceptance()')
  assert.match(artifact.acceptance.writer.pathPattern, /acceptance-<runId>\.json/)
  assert.equal(artifact.milestoneAcceptance.status, 'INCOMPLETE')
  assert.deepEqual(artifact.milestoneAcceptance.incompleteMilestones, ['M3'])
  assert.deepEqual(artifact.milestoneAcceptance.milestones.M3.unmetConditions, ['ender_eye_ready'])
  assert.notEqual(artifact.status, 'PASS')
  assert.notEqual(result.code, 0)

  // The same run with no record: still INCOMPLETE, and the gap names the writer.
  const bareRoot = makeRoot('incomplete-acceptance-missing')
  writeFixture(bareRoot, runId, { logLines: fullLog(runId, { terminalEye: 0 }), acceptance: false })
  const bare = cli(['--run', runId, '--root', bareRoot, '--json', '--no-control-socket']).json()
  assert.equal(bare.acceptance.present, false)
  assert.equal(bare.milestoneAcceptance.status, 'INCOMPLETE')
  assert.deepEqual(bare.milestoneAcceptance.milestones.M3.unmetConditions, ['ender_eye_ready'])
  const gap = bare.missingEvidenceDetail.find((entry) => entry.field === 'acceptance')
  assert.ok(gap, 'an absent acceptance record must stay a reasoned gap')
  assert.match(gap.reason, /writeAcceptance\(\)/)
  assert.match(gap.reason, /generation-reload-commit/)
}
ok('an acceptance record never turns an incomplete milestone into PASS; its absence keeps a reasoned gap')

// ---------------------------------------------------------------------------
// O. a synthetic COMPLETE run answers the whole operator field list
// ---------------------------------------------------------------------------
{
  const runId = 'run-fixture-complete'
  const root = makeRoot('complete')
  writeFixture(root, runId, {
    logLines: fullLog(runId, { terminalEye: 12 }),
    runner: {
      stack: '{"provider":"hybrid","model":"typesafe-ai:typesafe-ai/jev|muse-spark:meta/muse-spark-1.3-contributor"}',
      decisions: ['SYSTEM2_AUTHORITY_DECISION provider=muse-spark model=meta/muse-spark-1.3-contributor chosen=front_nether_portal'],
    },
  })
  const result = cli(['--run', runId, '--root', root, '--json', '--no-control-socket'])
  assert.equal(result.code, 0, `complete fixture exit=${result.code} stderr=${result.stderr}`)
  assert.equal(result.stderr, '', 'a complete artifact prints no missing-evidence summary')
  const artifact = result.json()
  assert.deepEqual(artifact.missingEvidence, [])
  assert.deepEqual(artifact.missingEvidenceDetail, [])
  assert.equal(artifact.status, 'PASS')
  // exact source SHA
  assert.equal(artifact.run.boot.sourceSha, SOURCE_SHA)
  // MC version / difficulty / environment
  assert.equal(artifact.run.serverVersion, '1.21.11')
  assert.equal(artifact.environment.difficulty.value, 'normal')
  assert.equal(artifact.environment.mobSpawning.value, true)
  assert.equal(artifact.environment.gamerules.value.advanceTime, false)
  // initial + final inventory
  assert.equal(artifact.inventory.boot.counts.ender_eye, 0)
  assert.equal(artifact.inventory.latest.counts.ender_eye, 12)
  // dimension transitions
  assert.deepEqual(
    artifact.environment.dimensions.sequence.map((entry) => entry.dimension),
    ['minecraft:overworld', 'minecraft:the_nether'],
  )
  assert.deepEqual(
    artifact.environment.dimensions.transitions.map((entry) => `${entry.from}->${entry.to}`),
    ['minecraft:overworld->minecraft:the_nether'],
  )
  // milestone predicate evidence
  assert.equal(artifact.milestonePredicates.predicates.length, 7)
  assert.ok(artifact.milestonePredicates.predicates.every((predicate) => predicate.satisfied === true))
  // effective System2 + Jev authority, with no disagreement between the stack,
  // the Jev policy fields and the last answerer.
  assert.deepEqual(
    [artifact.authority.system2.provider, artifact.authority.system2.model],
    ['muse-spark', 'meta/muse-spark-1.3-contributor'],
  )
  assert.deepEqual(
    [artifact.authority.jev.provider, artifact.authority.jev.model],
    ['typesafe-ai', 'typesafe-ai/jev'],
  )
  assert.deepEqual(artifact.authority.system2.disagreements, [])
  // no hidden deterministic fallback
  assert.equal(artifact.authority.fallback.hiddenDeterministicFallback, 'none_observed')
  assert.equal(artifact.authority.fallback.deterministicFallbackEnabled, false)
  assert.equal(artifact.authority.fallback.fallbackCount, 0)
  assert.equal(artifact.authority.fallback.otherCount, 0)
  // acceptance record present and the milestone genuinely complete
  assert.equal(artifact.acceptance.present, true)
  assert.equal(artifact.milestoneAcceptance.status, 'COMPLETE')
  assert.deepEqual(artifact.milestoneAcceptance.incompleteMilestones, [])
  assert.deepEqual(artifact.milestoneAcceptance.milestones.M3.unmetConditions, [])
  assert.deepEqual(artifact.milestoneAcceptance.milestones.M3.unknownConditions, [])
}
ok('a synthetic complete run answers source SHA, env, inventory, transitions, predicates, authority and fallback absence')

// ---------------------------------------------------------------------------
// P. source provenance: the LATEST source-changing reload is the effective source
//    while run.boot.sourceSha stays the run's origin (the live defect: an artifact
//    that named only the SHA at run START for a run that hot-reloaded afterwards)
// ---------------------------------------------------------------------------
{
  const runId = 'run-fixture-reload-two'
  const root = makeRoot('reload-two')
  writeFixture(root, runId, {
    logLines: fullLog(runId, { terminalEye: 12 }),
    runner: {
      build: 'boot11112222',
      reloads: [
        { sec: 50, body: 'RELOAD ok=true trigger=source-changed ms=1240 hash=aaaa11112222 id=gen-first generations=2 listeners={"physicsTick":2} listenerLeak=false' },
        { sec: 60, body: 'RELOAD ok=true trigger=source-changed ms=980 hash=bbbb33334444 id=gen-second generations=3 listeners={"physicsTick":2} listenerLeak=false' },
      ],
    },
  })
  const result = cli(['--run', runId, '--root', root, '--json', '--no-control-socket'])
  // A reload is not by itself a missing fact: this run is still COMPLETE and PASS.
  assert.equal(result.code, 0, `reload fixture exit=${result.code} stderr=${result.stderr}`)
  const artifact = result.json()
  assert.deepEqual(artifact.missingEvidence, [])
  const source = artifact.run.source
  // Origin (untouched) vs effective source (what produced the result).
  assert.equal(artifact.run.boot.sourceSha, SOURCE_SHA)
  assert.equal(source.bootSourceSha, SOURCE_SHA)
  assert.equal(source.bootSourceShaKind, 'git-commit-sha')
  assert.equal(source.provenance, 'reload')
  assert.equal(source.effectiveSourceSha, 'bbbb33334444')
  assert.equal(source.effectiveSourceShaKind, 'generation-bundle-hash')
  assert.equal(source.reloadCount, 2)
  assert.equal(source.sourceChangeCount, 2)
  // The LATEST marker of each kind, with trigger/at/generation id/line index.
  assert.equal(source.latestReload.hash, 'bbbb33334444')
  assert.equal(source.latestReload.trigger, 'source-changed')
  assert.equal(source.latestReload.atMs, T0 + 60000)
  assert.equal(source.latestReload.ts, at(60))
  assert.equal(source.latestReload.generationId, 'gen-second')
  assert.equal(source.latestReload.count, 2)
  assert.equal(source.latestReload.kind, 'source-change')
  assert.equal(source.latestReload.applied, true)
  assert.equal(source.latestReload.durationMs, 980)
  assert.deepEqual(
    [source.latestSourceReload.hash, source.latestSourceReload.generationId],
    ['bbbb33334444', 'gen-second'],
  )
  assert.match(source.provenanceBasis, /hash=bbbb33334444/)
  assert.match(source.provenanceBasis, /trigger=source-changed/)
  // The recorded line index really points at that marker in the run window.
  const windowLines = readFileSync(join(root, 'buddy-driver', 'runner.out'), 'utf8').split(/\r?\n/)
  assert.match(windowLines[source.latestReload.lineIndex], /hash=bbbb33334444/)
  // Window identity: same BOOT rule as the gates, scanned to EOF, with the boot
  // generation's own BUILD hash recorded next to it.
  assert.equal(source.window.status, 'valid')
  assert.equal(source.window.path, join(root, 'buddy-driver', 'runner.out'))
  assert.equal(source.window.scannedToEof, true)
  assert.equal(source.window.closedByRunId, null)
  assert.equal(source.window.bootBuildHash, 'boot11112222')
  assert.equal(source.window.scannedToEof, true)
  assert.deepEqual(source.disagreements, [])
  assert.deepEqual(source.windowBlind, { detected: false, reasons: [] })
  // A run that never reloaded would have no observed markers at all.
  assert.equal(source.observed.length, 2)
  assert.deepEqual(
    source.observed.map((marker) => marker.hash),
    ['aaaa11112222', 'bbbb33334444'],
  )
  assert.ok(!artifact.missingEvidence.some((field) => String(field).startsWith('run.source')))
}
ok('two in-window reloads: the LATEST source-changing hash is effective, with trigger/at/generationId/line recorded')

// ---------------------------------------------------------------------------
// Q. no reload marker: BOOT fallback, named (never silently implied)
// ---------------------------------------------------------------------------
{
  // Q1: no RELOAD marker, but the run's own snapshot attests a bundle hash that
  // differs from the window's boot BUILD hash: the window is blind to a source
  // change, so `provenance: boot` is not provable and that fact is a named gap.
  const runId = 'run-fixture-reload-blind'
  const root = makeRoot('reload-blind')
  writeFixture(root, runId, { logLines: fullLog(runId, { terminalEye: 12 }), runner: { build: 'boot11112222' } })
  writeFileSync(
    join(root, 'buddy-driver', 'data', 'resident', `m2-snapshot-${runId}.json`),
    JSON.stringify({ record: 'm2-snapshot', runId, buildHash: 'later99998888', bootSourceSha: SOURCE_SHA, markers: [] }),
    'utf8',
  )
  const artifact = cli(['--run', runId, '--root', root, '--json', '--no-control-socket']).json()
  const source = artifact.run.source
  assert.equal(source.window.status, 'valid', 'the window itself was readable')
  assert.equal(source.provenance, 'boot')
  assert.equal(source.effectiveSourceSha, SOURCE_SHA, 'with no reload the BOOT SHA is repeated')
  assert.equal(source.effectiveSourceShaKind, 'git-commit-sha')
  assert.equal(source.latestReload, null)
  assert.equal(source.reloadCount, 0)
  assert.equal(source.sourceChangeCount, 0)
  assert.deepEqual(source.observed, [])
  assert.equal(source.windowBlind.detected, true)
  assert.match(source.windowBlind.reasons[0], /snapshot buildHash=later99998888/)
  assert.match(source.windowBlind.reasons[0], /boot BUILD hash=boot11112222/)
  // The unprovable fallback is NAMED, not left to be inferred.
  assert.ok(artifact.missingEvidence.includes('run.source:reload_window'))
  const gap = artifact.missingEvidenceDetail.find((entry) => entry.field === 'run.source:reload_window')
  assert.ok(gap, 'the blind window must carry a reason')
  assert.match(gap.reason, /falls back to the BOOT SHA/)
  assert.match(gap.reason, /provenance=boot/)
  assert.match(gap.reason, /later99998888/)
  // No SHA is invented: the snapshot's hash is never promoted to effectiveSourceSha.
  assert.notEqual(source.effectiveSourceSha, 'later99998888')
  assert.equal(source.provenanceBasis.includes('later99998888'), false)
  assert.match(source.provenanceBasis, /log:BOOT@line 0 source=/)
  // missingEvidence and missingEvidenceDetail stay one list, in the same order.
  assert.equal(artifact.missingEvidenceDetail.length, artifact.missingEvidence.length)
  assert.deepEqual(
    artifact.missingEvidenceDetail.map((entry) => entry.field),
    artifact.missingEvidence,
  )

  // Q2: no reload marker AND nothing contradicts the boot generation: the fallback
  // is exact and explicit, so a never-reloaded run still produces a COMPLETE
  // artifact (provenance is recorded, not implied).
  const cleanId = 'run-fixture-reload-clean'
  const cleanRoot = makeRoot('reload-clean')
  writeFixture(cleanRoot, cleanId, { logLines: fullLog(cleanId, { terminalEye: 12 }), runner: { build: 'boot11112222' } })
  const clean = cli(['--run', cleanId, '--root', cleanRoot, '--json', '--no-control-socket'])
  assert.equal(clean.code, 0, `clean no-reload fixture exit=${clean.code} stderr=${clean.stderr}`)
  const cleanArtifact = clean.json()
  assert.deepEqual(cleanArtifact.missingEvidence, [])
  assert.equal(cleanArtifact.run.source.provenance, 'boot')
  assert.equal(cleanArtifact.run.source.effectiveSourceSha, SOURCE_SHA)
  assert.equal(cleanArtifact.run.source.effectiveSourceShaKind, 'git-commit-sha')
  assert.equal(cleanArtifact.run.source.windowBlind.detected, false)
  assert.match(cleanArtifact.run.source.provenanceBasis, /log:BOOT@line 0 source=/)
  assert.match(cleanArtifact.run.source.provenanceBasis, /no later source/)
}
ok('no reload marker: BOOT fallback named in provenance + a proven blind window named in missingEvidenceDetail')

// ---------------------------------------------------------------------------
// R. RELOAD markers from another runId are never attributed to this run
// ---------------------------------------------------------------------------
{
  const target = 'run-fixture-target-reload'
  const foreign = 'run-fixture-foreign-reload'
  const root = makeRoot('foreign-reload')
  const runnerText =
    runnerOut(target, {
      build: 'bootTarget0001',
      reloads: [{ sec: 50, body: 'RELOAD ok=true trigger=source-changed ms=100 hash=target5555555 id=gen-target generations=2' }],
    }).trimEnd() +
    '\n' +
    runnerOut(foreign, {
      offsetSec: 100,
      build: 'bootForeign001',
      reloads: [{ sec: 150, body: 'RELOAD ok=true trigger=source-changed ms=100 hash=foreign666666 id=gen-foreign generations=9' }],
    }).trimEnd() +
    '\n'
  writeFileSync(join(root, 'buddy-driver', 'runner.out'), runnerText, 'utf8')
  writeFileSync(
    join(root, 'buddy-driver', 'buddy.log'),
    `${[boot(0, target), line(1, 'HEARTBEAT pos=0,64,0 running=true')].join('\n')}\n`,
    'utf8',
  )
  writeFileSync(join(root, 'buddy-driver', 'logs', 'jev', 'decisions.jsonl'), '', 'utf8')

  const targetArtifact = cli(['--run', target, '--root', root, '--json', '--no-control-socket']).json()
  assert.equal(targetArtifact.run.source.provenance, 'reload')
  assert.equal(targetArtifact.run.source.effectiveSourceSha, 'target5555555')
  assert.equal(targetArtifact.run.source.reloadCount, 1)
  assert.equal(targetArtifact.run.source.window.bootBuildHash, 'bootTarget0001')
  assert.equal(targetArtifact.run.source.window.closedByRunId, foreign, 'the foreign BOOT closes this run window')
  assert.equal(
    JSON.stringify(targetArtifact.run.source).includes('foreign666666'),
    false,
    'a foreign reload hash must never appear in this run provenance',
  )

  // The foreign run still resolves its OWN window and its own hash.
  const foreignArtifact = cli(['--run', foreign, '--root', root, '--json', '--no-control-socket']).json()
  assert.equal(foreignArtifact.run.source.provenance, 'reload')
  assert.equal(foreignArtifact.run.source.effectiveSourceSha, 'foreign666666')
  assert.equal(foreignArtifact.run.source.reloadCount, 1)
  assert.equal(foreignArtifact.run.source.window.bootBuildHash, 'bootForeign001')
  assert.equal(foreignArtifact.run.source.window.closedByRunId, null)
  assert.equal(JSON.stringify(foreignArtifact.run.source).includes('target5555555'), false)
}
ok('RELOAD markers from another runId are never attributed; the foreign run resolves its own window')

// ---------------------------------------------------------------------------
// S. skipped=unchanged / failed reloads are OBSERVED but are not a new source
// ---------------------------------------------------------------------------
{
  // S1: a control reload that rebuilt the same bundle and a failed reload: the
  // window records both, and the executing source is still the BOOT generation.
  const runId = 'run-fixture-reload-unchanged-only'
  const root = makeRoot('reload-unchanged-only')
  writeFixture(root, runId, {
    logLines: fullLog(runId, { terminalEye: 12 }),
    runner: {
      build: 'boot11112222',
      reloads: [
        { sec: 50, body: 'RELOAD ok=true trigger=control skipped=unchanged ms=56' },
        { sec: 60, body: 'RELOAD ok=false trigger=source-changed ms=12 message=CONTRACT_VERSION_mismatch' },
      ],
    },
  })
  const artifact = cli(['--run', runId, '--root', root, '--json', '--no-control-socket']).json()
  const source = artifact.run.source
  assert.equal(source.provenance, 'boot')
  assert.equal(source.effectiveSourceSha, SOURCE_SHA)
  assert.equal(source.reloadCount, 2, 'both markers are recorded')
  assert.equal(source.sourceChangeCount, 0, 'neither marker changed the source')
  assert.deepEqual(
    source.observed.map((marker) => marker.kind),
    ['unchanged', 'failed'],
  )
  assert.equal(source.observed[0].trigger, 'control')
  assert.equal(source.observed[0].applied, false)
  assert.equal(source.observed[0].hash, null)
  assert.match(source.observed[0].note, /not a new source/)
  assert.equal(source.observed[1].ok, false)
  assert.equal(source.observed[1].reason, 'CONTRACT_VERSION_mismatch')
  // The latest observed marker is the failed one; it still carries no hash.
  assert.equal(source.latestReload.kind, 'failed')
  assert.equal(source.latestReload.hash, null)
  assert.equal(source.latestSourceReload, null)
  // Observed-but-unchanged is not a blind window: the window positively shows
  // that no source change committed.
  assert.deepEqual(source.windowBlind, { detected: false, reasons: [] })
  assert.ok(!artifact.missingEvidence.some((field) => String(field).startsWith('run.source')))

  // S2: an applied reload followed by skipped=unchanged: the applied hash stays
  // effective while the skipped marker is recorded as the latest observation.
  const tailId = 'run-fixture-reload-unchanged-tail'
  const tailRoot = makeRoot('reload-unchanged-tail')
  writeFixture(tailRoot, tailId, {
    logLines: fullLog(tailId, { terminalEye: 12 }),
    runner: {
      build: 'boot11112222',
      reloads: [
        { sec: 50, body: 'RELOAD ok=true trigger=source-changed ms=100 hash=aaaa11112222 id=gen-first generations=2' },
        { sec: 60, body: 'RELOAD ok=true trigger=control skipped=unchanged ms=59' },
      ],
    },
  })
  const tailSource = cli(['--run', tailId, '--root', tailRoot, '--json', '--no-control-socket']).json().run.source
  assert.equal(tailSource.latestReload.kind, 'unchanged')
  assert.equal(tailSource.latestReload.hash, null)
  assert.equal(tailSource.latestSourceReload.hash, 'aaaa11112222')
  assert.equal(tailSource.effectiveSourceSha, 'aaaa11112222')
  assert.equal(tailSource.provenance, 'reload')
  assert.equal(tailSource.sourceChangeCount, 1)
}
ok('skipped=unchanged and failed reloads are observed, recorded, and never treated as a new source')

// ---------------------------------------------------------------------------
// T. deferred=frozen is staged, and only a successful RESUME commits it
// ---------------------------------------------------------------------------
{
  const frozen = 'RELOAD ok=true trigger=source-changed deferred=frozen ms=120 hash=frozen7777777 contractVersion=3'
  const stagedId = 'run-fixture-reload-frozen'
  const stagedRoot = makeRoot('reload-frozen')
  writeFixture(stagedRoot, stagedId, {
    logLines: fullLog(stagedId, { terminalEye: 12 }),
    runner: { build: 'boot11112222', reloads: [{ sec: 50, body: frozen }] },
  })
  const staged = cli(['--run', stagedId, '--root', stagedRoot, '--json', '--no-control-socket']).json().run.source
  assert.equal(staged.observed[0].kind, 'deferred')
  assert.equal(staged.observed[0].applied, false, 'a frozen candidate is not swapped in')
  assert.equal(staged.provenance, 'boot', 'the live generation is still the boot one')
  assert.equal(staged.effectiveSourceSha, SOURCE_SHA)
  assert.equal(staged.unmatchedDeferred.hash, 'frozen7777777', 'the staged candidate stays visible')

  // The same window plus a successful RESUME: the remembered module becomes live.
  const resumedId = 'run-fixture-reload-frozen-resumed'
  const resumedRoot = makeRoot('reload-frozen-resumed')
  writeFixture(resumedRoot, resumedId, {
    logLines: fullLog(resumedId, { terminalEye: 12 }),
    runner: { build: 'boot11112222', reloads: [{ sec: 50, body: frozen }], resumes: [{ sec: 55, ok: true }] },
  })
  const resumed = cli(['--run', resumedId, '--root', resumedRoot, '--json', '--no-control-socket']).json().run.source
  assert.equal(resumed.provenance, 'reload')
  assert.equal(resumed.effectiveSourceSha, 'frozen7777777')
  assert.equal(resumed.latestSourceReload.appliedBy, 'resume')
  assert.equal(resumed.unmatchedDeferred, null)

  // An UNSUCCESSFUL resume must not commit anything.
  const failedId = 'run-fixture-reload-frozen-resume-failed'
  const failedRoot = makeRoot('reload-frozen-resume-failed')
  writeFixture(failedRoot, failedId, {
    logLines: fullLog(failedId, { terminalEye: 12 }),
    runner: { build: 'boot11112222', reloads: [{ sec: 50, body: frozen }], resumes: [{ sec: 55, ok: false }] },
  })
  const failed = cli(['--run', failedId, '--root', failedRoot, '--json', '--no-control-socket']).json().run.source
  assert.equal(failed.provenance, 'boot')
  assert.equal(failed.effectiveSourceSha, SOURCE_SHA)
  assert.equal(failed.unmatchedDeferred.hash, 'frozen7777777')
}
ok('a deferred=frozen bundle is staged only, and a successful RESUME alone makes it the live source')

// ---------------------------------------------------------------------------
// U. the control-socket generation hash is a READ-ONLY cross-check, never a source
// ---------------------------------------------------------------------------
{
  const runId = 'run-fixture-socket-crosscheck'
  const root = makeRoot('socket-crosscheck')
  writeFixture(root, runId, {
    logLines: fullLog(runId, { terminalEye: 12 }),
    runner: {
      build: 'boot11112222',
      reloads: [{ sec: 50, body: 'RELOAD ok=true trigger=source-changed ms=100 hash=liveabc12345 id=gen-live generations=2' }],
    },
  })
  // `controlSocketPath` must be a non-empty string for the socket read to be
  // attempted; the injected reader stands in for the live resident (no socket is
  // opened and no command other than the read-only `report` is ever sent).
  const overrides = { controlSocketPath: '/fixture/control.sock' }
  const readSocket = (binding) => async () => binding

  const agreeing = await buildRunArtifact({
    runId,
    root,
    overrides,
    readSocket: readSocket({
      runId,
      policyKind: 'typesafe',
      policyModel: 'typesafe-ai/jev',
      generationHash: 'liveabc12345',
      generationId: 'gen-live',
      frozen: false,
    }),
  })
  const agreeSource = agreeing.artifact.run.source
  assert.equal(agreeSource.crossCheck.queried, true)
  assert.equal(agreeSource.crossCheck.readOnly, true)
  assert.equal(agreeSource.crossCheck.command, 'report')
  assert.equal(agreeSource.crossCheck.forRequestedRun, true)
  assert.equal(agreeSource.crossCheck.generationHash, 'liveabc12345')
  assert.equal(agreeSource.crossCheck.generationId, 'gen-live')
  assert.equal(agreeSource.crossCheck.agrees, true)
  assert.deepEqual(agreeSource.disagreements, [])
  assert.equal(agreeSource.effectiveSourceSha, 'liveabc12345')

  // A disagreement is NAMED, and never overwrites the file evidence.
  const disagreeing = await buildRunArtifact({
    runId,
    root,
    overrides,
    readSocket: readSocket({
      runId,
      policyKind: 'typesafe',
      policyModel: 'typesafe-ai/jev',
      generationHash: 'other99999999',
      generationId: 'gen-other',
      frozen: false,
    }),
  })
  const disagreeSource = disagreeing.artifact.run.source
  assert.equal(disagreeSource.crossCheck.agrees, false)
  assert.equal(disagreeSource.disagreements.length, 1)
  assert.match(disagreeSource.disagreements[0], /control_socket_generationHash=other99999999/)
  assert.match(disagreeSource.disagreements[0], /file_latest_source_reload_hash=liveabc12345/)
  assert.equal(disagreeSource.effectiveSourceSha, 'liveabc12345', 'the file fact stands on its own')

  // A socket reply for ANOTHER runId is not used at all.
  const foreign = await buildRunArtifact({
    runId,
    root,
    overrides,
    readSocket: readSocket({ runId: 'run-fixture-someone-else', generationHash: 'foreign00000' }),
  })
  const foreignSource = foreign.artifact.run.source
  assert.equal(foreignSource.crossCheck.forRequestedRun, false)
  assert.equal(foreignSource.crossCheck.generationHash, null)
  assert.equal(foreignSource.crossCheck.agrees, null)
  assert.equal(foreignSource.effectiveSourceSha, 'liveabc12345')
  assert.equal(JSON.stringify(foreignSource.crossCheck).includes('foreign00000'), false)

  // A newer generation INSTANCE of the same bundle (a restart of the live
  // generation, not a source change): the hash agrees and the instance difference
  // is named as exactly that.
  const restarted = await buildRunArtifact({
    runId,
    root,
    overrides,
    readSocket: readSocket({
      runId,
      policyKind: 'typesafe',
      policyModel: 'typesafe-ai/jev',
      generationHash: 'liveabc12345',
      generationId: 'gen-restarted',
      frozen: false,
    }),
  })
  const restartedSource = restarted.artifact.run.source
  assert.equal(restartedSource.crossCheck.agrees, true)
  assert.equal(restartedSource.crossCheck.generationIdDiffers, true)
  assert.deepEqual(restartedSource.disagreements, [])
  assert.match(restartedSource.crossCheck.note, /NEWER INSTANCE of the same bundle hash/)

  // Without any socket the file evidence is unchanged.
  const noSocket = await buildRunArtifact({ runId, root, overrides: { controlSocketPath: null } })
  assert.equal(noSocket.artifact.run.source.crossCheck.queried, false)
  assert.equal(noSocket.artifact.run.source.effectiveSourceSha, 'liveabc12345')
  assert.equal(noSocket.artifact.run.source.crossCheck.agrees, null)
}
ok('the control-socket generation hash is a read-only cross-check: agreement/disagreement named, file facts untouched')

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------
for (const root of ROOTS) rmSync(root, { recursive: true, force: true })
console.log(`\ntest-milestone-run-artifact: ${checks} checks passed`)
