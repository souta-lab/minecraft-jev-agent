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

const boot = (sec, runId) =>
  line(
    sec,
    `BOOT pid=4242 runId=${runId} source=${SOURCE_SHA} runtime=bun runtimeVersion=1.4.2 bundle=none ` +
      `milestone=null generations=0 reloads=0 contractVersion=3 schemaVersion=3 revision=1 worldEpoch=1 worldKey=${WORLD_KEY}`,
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

/** The runner.out-shaped authority window for one run. */
function runnerOut(runId) {
  return (
    [
      boot(0, runId),
      line(
        1,
        'GENERATION_READY id=gen-test-1 rungIndex=13 rungId=nether_portal ' +
          'goals=["verify the lit nether_portal block in the overworld","enter the lit nether_portal"] ' +
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

function writeFixture(root, runId, { logLines, acceptance = true }) {
  writeFileSync(join(root, 'buddy-driver', 'buddy.log'), `${logLines.join('\n')}\n`, 'utf8')
  writeFileSync(join(root, 'buddy-driver', 'runner.out'), runnerOut(runId), 'utf8')
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
assert.deepEqual(passArtifact.environment.dimensions.observed, ['minecraft:overworld'])
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
// cleanup
// ---------------------------------------------------------------------------
for (const root of ROOTS) rmSync(root, { recursive: true, force: true })
console.log(`\ntest-milestone-run-artifact: ${checks} checks passed`)
