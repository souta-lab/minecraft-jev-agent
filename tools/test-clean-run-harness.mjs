#!/usr/bin/env bun
// test-clean-run-harness: OFFLINE fixtures for the clean-run acceptance path.
//
// Everything below is a FIXTURE. The synthetic resident trees are written under
// <repo>/runs/clean-run-tests/ (gitignored), every bundle is built with
// `evidenceClass: 'fixture'` unless a case explicitly SIMULATES the three
// objective live signals to exercise the ACCEPTED branch, and no server, socket,
// resident or network is touched anywhere in this file.
//
// What is pinned:
//   A. the checked-in descriptor TEMPLATE cannot authorise a run (sourceSha is
//      not frozen) - a stale/placeholder pin fails closed;
//   B. a CLEAN resolved descriptor + a synthetic run whose evidence agrees with
//      it: the canonical M3 gate PASSes, the clean gate says CLEAN, and the
//      combined M3 answer is honestly NOT_ACCEPTED because a fixture is not a
//      live acceptance (full verdict lines are printed);
//   C. the same tree with the three objective live signals SIMULATED (git HEAD ==
//      BOOT source, host.lock present, HOST acceptance record present) reaches
//      CLEAN_RUN_M3 status=ACCEPTED - proving the acceptance wiring, and proving
//      that ACCEPTED needs the canonical gate PASS *and* liveAcceptance, never
//      the clean descriptor alone;
//   D. an ASSISTED descriptor is refused: keepInventory=true (the live world's
//      assist), doDaylightCycle=false (the live world's advance_time=false),
//      a reused level name (`world`), the live seed (2024), an empty/missing
//      seed, and a declared granted item. The M3 gate alone still PASSes that
//      run - which is exactly why this harness exists - but the combined answer
//      is NOT_ACCEPTED / NOT_CLEAN;
//   E. run evidence that CONTRADICTS the clean declaration is caught: the OLD
//      world's levelName/seed in the HOST acceptance record, a granted kit in the
//      boot inventory, a death settle that kept items
//      (LADDER_INVENTORY_SETTLE reason=death itemCount=27 - the live proof that
//      keepInventory is ON), a BOOT source that is not the frozen SHA, and a
//      run-scoped ENVIRONMENT marker whose shorthand `advanceTime=false` is
//      normalised before it can hide;
//   F. clean positive evidence: a death settle with an EMPTY inventory is
//      reported as behavioural keepInventory=false evidence;
//   G. tools/clean-run-prepare.mjs: --dry-run writes NOTHING, --apply stages the
//      world + resolved descriptor + manifest, a second --apply is an idempotent
//      no-op, and a generated world / protected level name / live seed / world
//      directory as --server-root are all REFUSED;
//   H. CLI surfaces: --help exit 0 for both tools, a missing --environment exits 2.
//
// Usage: bun tools/test-clean-run-harness.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAcceptanceBundle } from './m3-acceptance-bundle.mjs'
import { runCleanRunGate, runCli as runGateCli } from './clean-run-gate.mjs'
import { loadCleanEnvironment, validateCleanEnvironment } from './clean-run-environment.mjs'
import { applyPlan, planPrepare, runCli as runPrepareCli } from './clean-run-prepare.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const TEMPLATE = join(HERE, 'fixtures', 'm3-clean-environment.json')
const SCRATCH = join(REPO_ROOT, 'runs', 'clean-run-tests')
const PREPARE_TOOL = join(HERE, 'clean-run-prepare.mjs')
const GATE_TOOL = join(HERE, 'clean-run-gate.mjs')

let checks = 0
function ok(label) {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

const T0 = Date.parse('2026-09-23T10:00:00.000Z')
const at = (sec) => new Date(T0 + sec * 1000).toISOString()
const line = (sec, body) => `[${at(sec)}] ${body}`
const FIXTURE_SHA = 'aa11bb22cc33dd44ee55ff6677889900aabbccdd'
const WORLD_KEY = '{"serverId":"127.0.0.1:25565","dimension":"minecraft:overworld","worldEpoch":1}'
const RUN = 'run-clean-fixture'
const CLEAN_LEVEL = 'm3clean-b1'
const CLEAN_SEED = '-4187923615481'

rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })

const boot = (sec, runId, source = FIXTURE_SHA) =>
  line(
    sec,
    `BOOT pid=4242 runId=${runId} source=${source} runtime=bun runtimeVersion=1.4.2 bundle=none ` +
      `milestone=null generations=0 reloads=0 contractVersion=3 schemaVersion=3 revision=1 worldEpoch=1 worldKey=${WORLD_KEY}`,
  )

const PORTAL_CHAIN = [
  'PORTAL_BLOCK_PLACED pos=1,64,0',
  'PORTAL_BLOCK_PLACED pos=2,64,0',
  'PORTAL_FRAME_READY blocks=10 shape=ok',
  'PORTAL_LIT pos=2,65,0 dimension=minecraft:overworld',
  'PORTAL_VERIFIED=true',
]

/** runner.out-shaped authority window (policyProvider/model/planner=llm). */
function runnerOut(runId, source = FIXTURE_SHA) {
  return (
    [
      boot(0, runId, source),
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

function acceptanceRecord(runId, { levelName = CLEAN_LEVEL, seed = CLEAN_SEED, gitCommit = FIXTURE_SHA } = {}) {
  return JSON.stringify({
    record: 'acceptance',
    runId,
    ts: at(40),
    gitCommit,
    generationHash: 'e6be1812c804',
    contractVersion: 3,
    stateSchemaVersion: 3,
    worldEpoch: 1,
    serverId: '127.0.0.1:25565',
    dimension: 'minecraft:overworld',
    levelName,
    seed,
    mode: 'llm',
  })
}

/**
 * A clean-world run: the body starts with NOTHING, the environment marker states
 * the clean gamerules (in the resident's shorthand), and the M3 chain completes.
 */
function cleanLog(runId, { source = FIXTURE_SHA, envMarker = 'ENVIRONMENT difficulty=normal spawnMonsters=true spawnAnimals=true advanceTime=true keepInventory=false spawnMobs=true', bootInventory = '{}', terminalEye = 12, settle = null, extra = [] } = {}) {
  return [
    boot(0, runId, source),
    line(1, `SPAWN pos=0.5,64.0,0.5 version=1.21.11 health=20 username=AI_Buddy dimension=minecraft:overworld worldEpoch=1`),
    line(2, envMarker),
    line(3, `INVENTORY items=${bootInventory} pos=0.5,64.0,0.5`),
    ...(settle === null ? [] : [line(4, settle)]),
    line(10, 'INVENTORY items={"diamond":3,"diamond_pickaxe":1,"flint_and_steel":1,"obsidian":10,"ender_pearl":12,"blaze_rod":8,"blaze_powder":16,"ender_eye":0} pos=0.5,64.0,0.5'),
    ...PORTAL_CHAIN.map((body, index) => line(11 + index, body)),
    line(19, 'DIMENSION_TRANSITION from=minecraft:overworld to=minecraft:the_nether dimension=minecraft:the_nether reason=live-change source=live-world'),
    line(30, `INVENTORY items={"ender_eye":${terminalEye},"ender_pearl":0,"blaze_rod":0,"blaze_powder":0} pos=0.5,64.0,0.5`),
    ...extra,
  ]
}

function makeRoot(name) {
  const root = join(SCRATCH, name)
  mkdirSync(join(root, 'buddy-driver', 'data', 'resident'), { recursive: true })
  mkdirSync(join(root, 'buddy-driver', 'logs', 'jev'), { recursive: true })
  return root
}

function writeFixture(root, runId, { logLines, acceptance = true, acceptanceOptions = {}, decisions = DECISIONS } = {}) {
  writeFileSync(join(root, 'buddy-driver', 'buddy.log'), `${logLines.join('\n')}\n`, 'utf8')
  writeFileSync(join(root, 'buddy-driver', 'runner.out'), runnerOut(runId), 'utf8')
  writeFileSync(join(root, 'buddy-driver', 'logs', 'jev', 'decisions.jsonl'), decisions, 'utf8')
  if (acceptance) {
    writeFileSync(join(root, 'buddy-driver', 'data', 'resident', `acceptance-${runId}.json`), acceptanceRecord(runId, acceptanceOptions), 'utf8')
  }
}

/** A resolved (frozen) descriptor inside the fixture root. */
function resolvedDescriptor(root, { levelName = CLEAN_LEVEL, levelSeed = CLEAN_SEED, sourceSha = FIXTURE_SHA, mutate = null, container = null } = {}) {
  const template = JSON.parse(readFileSync(TEMPLATE, 'utf8'))
  template.values.levelName = levelName
  template.values.levelSeed = levelSeed
  template.values.sourceSha = sourceSha
  template.cleanRun.sourceSha.state = sourceSha === null ? 'UNSET' : 'FROZEN'
  template.cleanRun.worldContainer = container ?? join(SCRATCH, 'container')
  if (mutate !== null) mutate(template)
  const path = join(root, 'environment-resolved.json')
  writeFileSync(path, `${JSON.stringify(template, null, 2)}\n`, 'utf8')
  return { path, document: template }
}

async function buildBundle(root, runId, { environmentPath, evidenceClass = 'fixture', outName = 'bundle' } = {}) {
  return buildAcceptanceBundle({
    runId,
    root,
    outDir: join(root, outName),
    evidenceClass,
    noControlSocket: true,
    overrides: { environment: environmentPath },
    write: () => {},
  })
}

const condition = (verdict, id) => verdict.conditions.find((entry) => entry.id === id) ?? null
const runCondition = (verdict, id) => condition(verdict, id)

// ---------------------------------------------------------------------------
// A. the checked-in TEMPLATE cannot authorise a run
// ---------------------------------------------------------------------------
{
  const gate = await runCleanRunGate({ environment: TEMPLATE })
  assert.equal(gate.status, 'NOT_CLEAN', `template status=${gate.status}`)
  assert.equal(gate.exitCode, 1)
  const sha = condition(gate, 'descriptor.sourceSha')
  assert.equal(sha.verdict, 'FAIL')
  assert.match(sha.reason, /not frozen/)
  assert.equal(gate.acceptanceStatus, 'UNKNOWN', 'a descriptor-only judgement is never an M3 acceptance')
  const loaded = loadCleanEnvironment(TEMPLATE)
  assert.equal(loaded.error, null)
  assert.ok(loaded.sha256.length === 64)
  ok('A. template descriptor (sourceSha UNSET) is NOT_CLEAN: a stale/placeholder pin cannot authorise a run')
}

// ---------------------------------------------------------------------------
// B. clean descriptor + clean FIXTURE run: gate PASS, clean CLEAN, M3 NOT_ACCEPTED
// ---------------------------------------------------------------------------
{
  const root = makeRoot('clean-run')
  const container = join(SCRATCH, 'container')
  mkdirSync(container, { recursive: true })
  const descriptor = resolvedDescriptor(root, { container })
  writeFixture(root, RUN, { logLines: cleanLog(RUN, { settle: 'LADDER_INVENTORY_SETTLE reason=death readings=9 changed=false empty=true itemCount=0 waitedMs=1000 counts={}' }) })

  // the descriptor itself validates CLEAN against the container
  const check = validateCleanEnvironment(descriptor.document, { descriptorPath: descriptor.path, worldContainer: container })
  assert.equal(check.status, 'CLEAN', `descriptor check: ${check.failed.join(',')}`)

  const { bundle, exitCode } = await buildBundle(root, RUN, { environmentPath: descriptor.path })
  assert.equal(exitCode, 0, `bundle exit=${exitCode} verdict=${bundle.acceptanceVerdict.reason}`)
  assert.equal(bundle.gate.status, 'PASS')
  assert.match(bundle.gate.resultLine, /^M3_RUN_RESULT status=PASS reason=twelve_eyes_of_ender_verified/)
  assert.equal(bundle.liveAcceptance, false)
  // the descriptor IS the artifact's environment record, verbatim
  const envValues = bundle.artifact.document.environment.environmentFile.values
  assert.equal(envValues.gamerules.keep_inventory, false)
  assert.equal(envValues.levelName, CLEAN_LEVEL)
  assert.equal(envValues.levelSeed, CLEAN_SEED)
  assert.equal(bundle.artifact.document.environment.worldChanges, null)

  const outDir = join(root, 'bundle')
  const verdict = await runCleanRunGate({ environment: descriptor.path, bundleDir: outDir, runId: RUN, out: outDir })
  assert.equal(verdict.status, 'CLEAN', `clean status=${verdict.status} failed=${verdict.failed.join(',')}`)
  for (const id of ['run.environmentRecordIsThisDescriptor', 'run.bootSourceSha', 'run.acceptanceRecord', 'run.levelNameAttested', 'run.seedAttested', 'run.gamerulesNotContradicted', 'run.noWorldChanges', 'run.bootInventoryEmpty', 'run.keepInventoryBehaviour', 'run.difficultyNotContradicted', 'run.mobSpawningNotContradicted']) {
    const row = runCondition(verdict, id)
    assert.ok(row !== null, `missing condition ${id}`)
    assert.equal(row.verdict, 'PASS', `${id} verdict=${row.verdict} reason=${row.reason}`)
  }
  assert.match(runCondition(verdict, 'run.keepInventoryBehaviour').reason, /empty inventory after death/)
  // A fixture is NEVER a live acceptance: the combined answer says so exactly.
  assert.equal(verdict.acceptanceStatus, 'NOT_ACCEPTED')
  assert.match(verdict.acceptanceReason, /NOT a live acceptance/)
  assert.equal(verdict.exitCode, 1)
  assert.ok(existsSync(join(outDir, 'clean-run.json')))
  assert.ok(readFileSync(join(outDir, 'clean-run.md'), 'utf8').includes('M3 ACCEPTANCE: **NOT_ACCEPTED**'))
  // bundle.json is untouched by the clean gate
  assert.equal(JSON.parse(readFileSync(join(outDir, 'bundle.json'), 'utf8')).acceptanceVerdict.status, 'PASS')

  // the printed verdict lines (what a reviewer reads)
  const printed = []
  const cli = await runGateCli({ argv: ['--environment', descriptor.path, '--bundle-dir', outDir, '--run', RUN], write: (entry) => printed.push(String(entry)), writeError: () => {} })
  const text = printed.join('')
  assert.match(text, /CLEAN_RUN_GATE .*status=CLEAN/)
  assert.match(text, /CLEAN_RUN_ARTIFACT .*bundleVerdict=PASS liveAcceptance=false evidenceClass=fixture/)
  assert.match(text, /CLEAN_RUN_M3 status=NOT_ACCEPTED/)
  assert.match(text, /CLEAN_RUN_RESULT status=CLEAN acceptance=NOT_ACCEPTED/)
  assert.equal(cli.exitCode, 1)
  // The proof, printed: every verdict line of the offline acceptance path. This is
  // a FIXTURE judgement (evidenceClass=fixture), never live evidence.
  console.log('    --- full clean-run verdict lines for the CLEAN fixture (FIXTURE, not live evidence) ---')
  for (const entry of text.trimEnd().split('\n')) console.log(`    ${entry}`)
  ok('B. clean descriptor + fixture run: M3 gate PASS, clean CLEAN, combined NOT_ACCEPTED (fixture≠live), full verdict lines')
}

// ---------------------------------------------------------------------------
// C. SIMULATED live signals (FIXTURE): the ACCEPTED branch is reachable only with
//    gate PASS + liveAcceptance=true + --evidence-class live
// ---------------------------------------------------------------------------
{
  const root = makeRoot('sim-live')
  const container = join(SCRATCH, 'sim-live-container')
  mkdirSync(container, { recursive: true })
  // a real git HEAD so the bundle's bootSourceMatchesTreeHead signal can hold
  spawnSync('git', ['init', '-q'], { cwd: root })
  writeFileSync(join(root, 'fixture-marker.txt'), 'FIXTURE - simulated live signals, never evidence\n', 'utf8')
  spawnSync('git', ['add', '-A'], { cwd: root })
  spawnSync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-q', '-m', 'fixture'], { cwd: root })
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  assert.ok(/^[0-9a-f]{40}$/.test(head), `fixture git HEAD=${head}`)

  const descriptor = resolvedDescriptor(root, { sourceSha: head, container })
  writeFixture(root, RUN, { logLines: cleanLog(RUN, { source: head }) })
  // the third live signal: a HOST acceptance record (the fixture writes it; a real
  // run must refresh it through the read-only `acceptance` control query).
  writeFileSync(join(root, 'buddy-driver', 'data', 'resident', 'host.lock'), `${JSON.stringify({ pid: 4242, runId: RUN })}\n`, 'utf8')

  const { bundle } = await buildBundle(root, RUN, { environmentPath: descriptor.path, evidenceClass: 'live', outName: 'bundle-live' })
  assert.equal(bundle.acceptanceVerdict.status, 'PASS')
  assert.equal(bundle.liveAcceptance, true, `live signals: ${JSON.stringify(bundle.liveSignals)}`)
  const verdict = await runCleanRunGate({ environment: descriptor.path, bundleDir: join(root, 'bundle-live'), runId: RUN })
  assert.equal(verdict.status, 'CLEAN')
  assert.equal(verdict.acceptanceStatus, 'ACCEPTED', verdict.acceptanceReason)
  assert.equal(verdict.exitCode, 0)
  assert.equal(verdict.run.liveAcceptance, true)
  assert.equal(verdict.run.evidenceClass, 'live')
  assert.ok(verdict.failure === undefined)
  ok('C. simulated live signals (FIXTURE: git HEAD + host.lock + acceptance record) reach CLEAN_RUN_M3 status=ACCEPTED')
}

// ---------------------------------------------------------------------------
// D. an ASSISTED descriptor can never produce a clean verdict
// ---------------------------------------------------------------------------
const ASSISTED_VARIANTS = [
  {
    id: 'keep_inventory=true',
    mutate: (doc) => {
      doc.values.gamerules.keep_inventory = true
    },
    expect: 'descriptor.gamerulesClean',
  },
  {
    id: 'advance_time=false (the live world advance_time=false)',
    mutate: (doc) => {
      doc.values.gamerules.advance_time = false
    },
    expect: 'descriptor.gamerulesClean',
  },
  {
    id: 'levelSeed 2024 (the live world seed)',
    mutate: (doc) => {
      doc.values.levelSeed = '2024'
    },
    expect: 'descriptor.levelSeedNew',
  },
  {
    id: 'levelSeed missing',
    mutate: (doc) => {
      delete doc.values.levelSeed
    },
    expect: 'descriptor.levelSeedNew',
  },
  {
    id: 'levelName world (reused level name)',
    mutate: (doc) => {
      doc.values.levelName = 'world'
    },
    expect: 'descriptor.levelNameNew',
  },
  {
    id: 'grantedItems declared',
    mutate: (doc) => {
      doc.assists.grantedItems = ['shulker_box']
    },
    expect: 'descriptor.noAssists',
  },
  {
    id: 'a mandatory assist gamerule omitted (keep_inventory deleted)',
    mutate: (doc) => {
      delete doc.values.gamerules.keep_inventory
    },
    expect: 'descriptor.gamerulesPresent',
  },
  {
    id: 'sourceSha stale placeholder',
    mutate: (doc) => {
      doc.values.sourceSha = 'TO-BE-FROZEN'
      doc.cleanRun.sourceSha.state = 'UNSET'
    },
    expect: 'descriptor.sourceSha',
  },
  {
    id: 'legacy pack_format only (a bare pack_format no longer declares support)',
    mutate: (doc) => {
      delete doc.cleanRun.gameruleMechanism.datapackFormat
      doc.cleanRun.gameruleMechanism.datapackPackFormat = 88
    },
    expect: 'descriptor.datapackFormat',
  },
  {
    id: 'gamerule scope not declared per dimension',
    mutate: (doc) => {
      delete doc.cleanRun.gameruleScope
    },
    expect: 'descriptor.gameruleScope',
  },
  {
    id: 'a world change is recorded',
    mutate: (doc) => {
      doc.worldChanges = [{ who: 'operator', what: 'gave supplies', why: 'fixture' }]
    },
    expect: 'descriptor.noWorldChanges',
  },
  {
    id: 'difficulty peaceful',
    mutate: (doc) => {
      doc.values.difficulty = 'peaceful'
    },
    expect: 'descriptor.difficulty',
  },
  {
    id: 'target world already generated',
    mutate: (doc) => {
      doc.values.levelName = 'm3clean-already-generated'
    },
    expect: 'descriptor.worldNotGenerated',
    pre: (doc, container) => {
      mkdirSync(join(container, 'm3clean-already-generated'), { recursive: true })
      writeFileSync(join(container, 'm3clean-already-generated', 'level.dat'), 'not-really-nbt', 'utf8')
    },
  },
]
for (const variant of ASSISTED_VARIANTS) {
  const root = makeRoot(`assisted-${variant.id.replace(/[^a-z0-9]+/gi, '-').slice(0, 24)}`)
  const container = join(root, 'container')
  mkdirSync(container, { recursive: true })
  const descriptor = resolvedDescriptor(root, { container, mutate: variant.mutate })
  if (variant.pre !== undefined) variant.pre(descriptor.document, container)
  if (variant.id === 'target world already generated') writeFileSync(descriptor.path, `${JSON.stringify(descriptor.document, null, 2)}\n`, 'utf8')
  const verdict = await runCleanRunGate({ environment: descriptor.path, worldContainer: container })
  assert.equal(verdict.status, 'NOT_CLEAN', `variant ${variant.id} status=${verdict.status}`)
  assert.equal(verdict.exitCode, 1, `variant ${variant.id} exit=${verdict.exitCode}`)
  const row = condition(verdict, variant.expect)
  assert.ok(row !== null, `variant ${variant.id}: missing condition ${variant.expect}`)
  assert.equal(row.verdict, 'FAIL', `variant ${variant.id}: ${variant.expect} verdict=${row.verdict} reason=${row.reason}`)
}
ok(`D1. ${ASSISTED_VARIANTS.length} assisted descriptors are REFUSED (each names the exact failing condition)`)

// D2. the milestone gate alone CANNOT catch the assist: keepInventory=true still
//     PASSes M3, and only the clean gate turns that into NOT_ACCEPTED.
{
  const root = makeRoot('assisted-bundle')
  const container = join(SCRATCH, 'container')
  const descriptor = resolvedDescriptor(root, { container, mutate: (doc) => { doc.values.gamerules.keep_inventory = true } })
  writeFixture(root, RUN, { logLines: cleanLog(RUN) })
  const { bundle, exitCode } = await buildBundle(root, RUN, { environmentPath: descriptor.path })
  assert.equal(exitCode, 0, `the M3 gate PASSes an assisted world (exit=${exitCode})`)
  assert.equal(bundle.gate.status, 'PASS')
  assert.equal(bundle.artifact.document.environment.environmentFile.values.gamerules.keep_inventory, true)
  const verdict = await runCleanRunGate({ environment: descriptor.path, bundleDir: join(root, 'bundle'), runId: RUN })
  assert.equal(verdict.status, 'NOT_CLEAN')
  assert.equal(verdict.acceptanceStatus, 'NOT_ACCEPTED')
  assert.match(verdict.acceptanceReason, /keepInventory|gamerules/)
  // and the printed M3 line refuses it
  const printed = []
  await runGateCli({ argv: ['--environment', descriptor.path, '--bundle-dir', join(root, 'bundle'), '--run', RUN], write: (entry) => printed.push(String(entry)), writeError: () => {} })
  assert.match(printed.join(''), /CLEAN_RUN_M3 status=NOT_ACCEPTED/)
  console.log('    --- assisted (keep_inventory=true) refusal lines ---')
  for (const entry of printed.join('').split('\n')) if (/CLEAN_RUN_(GATE|CONDITION descriptor\.gamerules|M3|RESULT)/.test(entry)) console.log(`    ${entry}`)
  ok('D2. keep_inventory=true: canonical M3 gate PASSes while the clean gate refuses (NOT_ACCEPTED) - the harness, not the gate, catches the assist')
}

// ---------------------------------------------------------------------------
// E. run evidence that CONTRADICTS the clean declaration is caught
// ---------------------------------------------------------------------------
const CONTRADICTIONS = [
  {
    id: 'acceptance record names the OLD world + seed',
    acceptanceOptions: { levelName: 'world', seed: '2024' },
    expect: [['run.levelNameAttested', 'FAIL'], ['run.seedAttested', 'FAIL']],
  },
  {
    id: 'the body started with a granted kit',
    log: { bootInventory: '{"shulker_box":1,"diamond_sword":1}' },
    expect: [['run.bootInventoryEmpty', 'FAIL']],
  },
  {
    id: 'a death settle KEPT items (the live keepInventory=true proof)',
    log: { settle: 'LADDER_INVENTORY_SETTLE reason=death readings=9 changed=false empty=false itemCount=27 waitedMs=1157 counts={"diamond_sword":1}' },
    expect: [['run.keepInventoryBehaviour', 'FAIL']],
  },
  {
    id: 'BOOT source is not the frozen SHA',
    log: { source: 'ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00' },
    expect: [['run.bootSourceSha', 'FAIL']],
  },
  {
    id: 'run-scoped marker says advanceTime=false (shorthand alias)',
    log: { envMarker: 'ENVIRONMENT difficulty=normal spawnMonsters=true advanceTime=false keepInventory=false' },
    expect: [['run.gamerulesNotContradicted', 'FAIL']],
  },
  {
    id: 'run-scoped marker says keepInventory=true (legacy alias)',
    log: { envMarker: 'GAMERULE keepInventory=true' },
    expect: [['run.gamerulesNotContradicted', 'FAIL']],
  },
  {
    id: 'run-scoped marker says difficulty=peaceful',
    log: { envMarker: 'ENVIRONMENT difficulty=peaceful mobSpawning=true' },
    expect: [['run.difficultyNotContradicted', 'FAIL']],
  },
  {
    id: 'no HOST acceptance record (levelName/seed unattested)',
    acceptance: false,
    expectStatus: 'UNKNOWN',
    expect: [['run.acceptanceRecord', 'UNKNOWN'], ['run.levelNameAttested', 'UNKNOWN'], ['run.seedAttested', 'UNKNOWN']],
  },
]
for (const variant of CONTRADICTIONS) {
  const root = makeRoot(`contradiction-${variant.id.replace(/[^a-z0-9]+/gi, '-').slice(0, 24)}`)
  const container = join(SCRATCH, 'container')
  const descriptor = resolvedDescriptor(root, { container })
  writeFixture(root, RUN, {
    logLines: cleanLog(RUN, variant.log ?? {}),
    acceptance: variant.acceptance !== false,
    acceptanceOptions: variant.acceptanceOptions ?? {},
  })
  const { bundle } = await buildBundle(root, RUN, { environmentPath: descriptor.path })
  const verdict = await runCleanRunGate({ environment: descriptor.path, bundleDir: join(root, 'bundle'), runId: RUN })
  const expectedStatus = variant.expectStatus ?? 'NOT_CLEAN'
  assert.equal(verdict.status, expectedStatus, `contradiction ${variant.id} status=${verdict.status}`)
  for (const [id, expected] of variant.expect) {
    const row = runCondition(verdict, id)
    assert.ok(row !== null, `contradiction ${variant.id}: missing condition ${id}`)
    assert.equal(row.verdict, expected, `contradiction ${variant.id}: ${id} verdict=${row.verdict} reason=${row.reason}`)
  }
  assert.equal(verdict.acceptanceStatus, expectedStatus === 'UNKNOWN' ? 'UNKNOWN' : 'NOT_ACCEPTED')
  // the canonical gate is unaffected by the clean premise: M3 is still whatever it is
  assert.equal(bundle.gate.status === 'PASS' || bundle.gate.status === 'UNKNOWN', true)
}
ok(`E1. ${CONTRADICTIONS.length} run-evidence contradictions are caught (each names the exact failing condition)`)

// E2. an observed level.dat measurement proves the TARGET does not exist and
//     reports the live world's own deviations (informational, for the report)
{
  const root = makeRoot('observed-world')
  const container = join(SCRATCH, 'container')
  const descriptor = resolvedDescriptor(root, { container })
  const observedPath = join(root, 'gamerules-observed.json')
  writeFileSync(
    observedPath,
    JSON.stringify({
      worlds: {
        world: {
          levelName: 'world',
          randomSeed: '2024',
          gamerules: { 'minecraft:keep_inventory': { value: true }, 'minecraft:advance_time': { value: false }, 'minecraft:spawn_mobs': { value: true } },
        },
      },
    }),
    'utf8',
  )
  const verdict = await runCleanRunGate({ environment: descriptor.path, worldContainer: container, observedWorldPath: observedPath })
  const row = condition(verdict, 'world.observedTargetAbsent')
  assert.equal(row.verdict, 'PASS', row.reason)
  assert.match(row.reason, /not the clean target/)
  const deviations = row.detail.observed[0].deviationsFromCleanDefaults.join(';')
  assert.match(deviations, /keep_inventory=true/)
  assert.match(deviations, /advance_time=false/)
  assert.equal(verdict.status, 'CLEAN', 'the observation is informational: the target world does not exist yet')
  ok('E2. observed live world (world/2024/minecraft:keep_inventory=true/minecraft:advance_time=false) is named as NOT the target, with its deviations listed')
}

// ---------------------------------------------------------------------------
// F. clean positive behavioural evidence for keepInventory=false
// ---------------------------------------------------------------------------
{
  const root = makeRoot('death-dropped')
  const container = join(SCRATCH, 'container')
  const descriptor = resolvedDescriptor(root, { container })
  writeFixture(root, RUN, { logLines: cleanLog(RUN, { settle: 'LADDER_INVENTORY_SETTLE reason=death readings=9 changed=false empty=true itemCount=0 waitedMs=998 counts={}' }) })
  await buildBundle(root, RUN, { environmentPath: descriptor.path })
  const verdict = await runCleanRunGate({ environment: descriptor.path, bundleDir: join(root, 'bundle'), runId: RUN })
  const row = runCondition(verdict, 'run.keepInventoryBehaviour')
  assert.equal(row.verdict, 'PASS')
  assert.match(row.reason, /empty inventory after death/)
  assert.equal(verdict.status, 'CLEAN')
  ok('F. a death that dropped everything is reported as behavioural keepInventory=false evidence')
}

// ---------------------------------------------------------------------------
// G. tools/clean-run-prepare.mjs
// ---------------------------------------------------------------------------
{
  const root = join(SCRATCH, 'prepare')
  const container = join(root, 'server')
  mkdirSync(container, { recursive: true })
  writeFileSync(
    join(container, 'server.properties'),
    'level-name=world\nlevel-seed=2024\ndifficulty=normal\nspawn-monsters=true\nspawn-animals=true\ngamemode=survival\nforce-gamemode=false\nhardcore=false\npvp=true\nenable-command-block=false\ngenerate-structures=true\nlevel-type=minecraft\\:normal\nallow-nether=true\nallow-flight=true\nspawn-protection=0\nwhite-list=false\nserver-port=25565\nmotd=fixture\n',
    'utf8',
  )

  writeFileSync(join(container, 'ops.json'), '[]', 'utf8')
  const descriptorPath = join(root, 'descriptor.json')
  const descriptorDoc = JSON.parse(readFileSync(TEMPLATE, 'utf8'))
  descriptorDoc.cleanRun.worldContainer = container
  descriptorDoc.cleanRun.gameruleMechanism.datapackFormat = { min: [94, 1], max: [94, 1] }
  writeFileSync(descriptorPath, `${JSON.stringify(descriptorDoc, null, 2)}\n`, 'utf8')
  const args = ['--environment', descriptorPath, '--server-root', container, '--level-name', 'm3clean-prep', '--seed', '998877665544', '--source-sha', FIXTURE_SHA]

  // G1. dry-run writes NOTHING
  const planRun = planPrepare({ descriptorPath, serverRoot: container, levelName: 'm3clean-prep', seed: '998877665544', sourceSha: FIXTURE_SHA })
  assert.equal(planRun.status, 'PLANNED', `plan status=${planRun.status} refusals=${planRun.refusals.map((entry) => entry.reason).join('|')}`)
  assert.ok(planRun.actions.length >= 6)
  const before = readdirSync(container)
  const cli = await runPrepareCli({ argv: [...args, '--dry-run'], write: () => {}, writeError: () => {} })
  assert.equal(cli.exitCode, 0)
  assert.deepEqual(readdirSync(container), before, '--dry-run must not write anything into the server root')
  assert.equal(existsSync(join(container, 'm3-clean-run')), false)
  assert.equal(existsSync(join(container, 'm3clean-prep')), false)
  assert.match(planRun.guards.find((guard) => guard.id === 'no_destructive_operation').detail, /no delete/)
  // spawn-monsters is a DEAD key in this build: the real gate is the gamerule, and
  // the property check must say so loudly instead of implying enforcement
  const deadKey = planRun.propertyChecks.find((entry) => entry.property === 'spawn-monsters')
  assert.ok(deadKey !== undefined, 'spawn-monsters must be reported')
  assert.equal(deadKey.verdict, 'NOT_READ_BY_BUILD')
  assert.match(deadKey.detail, /spawn_mobs \/ spawn_monsters GAMERULE/)
  ok('G1. --dry-run writes NOTHING into the server root and reports every planned action with a content hash')

  // G2. apply stages the world, the datapack, the resolved descriptor and the manifest
  const applied = applyPlan(planRun)
  assert.equal(applied.status, 'APPLIED')
  assert.ok(existsSync(join(container, 'm3clean-prep', 'datapacks', 'm3-clean-gamerules', 'data', 'm3clean', 'function', 'set_gamerules.mcfunction')))
  const mcfunction = readFileSync(join(container, 'm3clean-prep', 'datapacks', 'm3-clean-gamerules', 'data', 'm3clean', 'function', 'set_gamerules.mcfunction'), 'utf8')
  assert.match(mcfunction, /^gamerule keep_inventory false$/m)
  assert.match(readFileSync(join(container, 'm3-clean-run', 'operator-commands.txt'), 'utf8'), /execute in minecraft:the_nether run gamerule/)
  const packMeta = readFileSync(join(container, 'm3clean-prep', 'datapacks', 'm3-clean-gamerules', 'pack.mcmeta'), 'utf8')
  assert.match(packMeta, /"min_format": \[\s*94,\s*1\s*\]/)
  assert.match(packMeta, /"max_format": \[\s*94,\s*1\s*\]/)
  assert.equal(/pack_format/.test(packMeta), false, 'since 1.21.9 a bare pack_format does not declare support: it must not be written')
  // gamerules are per-dimension: every rule is also asserted in the Nether and the End
  assert.match(mcfunction, /^execute in minecraft:the_nether run gamerule keep_inventory false$/m)
  assert.match(mcfunction, /^execute in minecraft:the_end run gamerule keep_inventory false$/m)
  const resolvedPath = join(container, 'm3-clean-run', 'environment-resolved.json')
  const resolved = JSON.parse(readFileSync(resolvedPath, 'utf8'))
  assert.equal(resolved.values.sourceSha, FIXTURE_SHA)
  assert.equal(resolved.cleanRun.sourceSha.state, 'FROZEN')
  assert.equal(resolved.values.levelName, 'm3clean-prep')
  assert.equal(resolved.cleanRun.worldContainer, container)
  const manifest = JSON.parse(readFileSync(join(container, 'm3-clean-run', 'manifest.json'), 'utf8'))
  assert.equal(manifest.target.levelName, 'm3clean-prep')
  assert.equal(manifest.target.levelSeed, '998877665544')
  assert.equal(manifest.descriptor.sha256.length, 64)
  assert.ok(manifest.files.length >= 5)
  const attempts = JSON.parse(readFileSync(join(container, 'm3-clean-run', 'attempts.json'), 'utf8'))
  assert.equal(attempts.attempts.length, 1)
  assert.match(readFileSync(join(container, 'm3-clean-run', 'server.properties.clean'), 'utf8'), /^level-name=m3clean-prep$/m)
  assert.match(readFileSync(join(container, 'm3-clean-run', 'server-properties.diff.txt'), 'utf8'), /level-seed: 2024 -> 998877665544/)
  assert.match(readFileSync(join(container, 'm3-clean-run', 'operator-commands.txt'), 'utf8'), /m3-acceptance-bundle\.mjs/)
  // the resolved descriptor is CLEAN and consumable by the canonical bundle
  const cleanCheck = validateCleanEnvironment(resolved, { descriptorPath: resolvedPath, worldContainer: container })
  assert.equal(cleanCheck.status, 'CLEAN', cleanCheck.failed.join(','))
  ok('G2. --apply stages the clean world dir + gamerule datapack + resolved descriptor + manifest + attempt ledger')

  // G3. idempotency
  const replan = planPrepare({ descriptorPath, serverRoot: container, levelName: 'm3clean-prep', seed: '998877665544', sourceSha: FIXTURE_SHA })
  const reapplied = applyPlan(replan)
  assert.equal(reapplied.status, 'IDEMPOTENT_NOOP')
  assert.deepEqual(reapplied.applied, [])
  assert.ok(reapplied.unchanged.length >= 4)
  assert.equal(JSON.parse(readFileSync(join(container, 'm3-clean-run', 'attempts.json'), 'utf8')).attempts.length, 1, 'a re-apply is not a new attempt')
  ok('G3. a second --apply is an IDEMPOTENT_NOOP (no rewrite, no new attempt)')

  // G4. refusals, each with the EXACT reason it must give
  const basePlan = { descriptorPath, serverRoot: container, levelName: 'm3clean-prep', seed: '998877665544', sourceSha: FIXTURE_SHA }
  const cases = [
    { id: 'world already generated', touchLevelDat: true, expect: /world already GENERATED|world_already_generated/ },
    { id: 'protected level name', over: { levelName: 'world' }, expect: /descriptor\.levelNameNew/ },
    { id: 'live seed 2024', over: { seed: '2024' }, expect: /descriptor\.levelSeedNew/ },
    { id: 'server-root is inside the target world dir', over: { serverRoot: join(container, 'm3clean-prep') }, expect: /server_root_inside_target_world/ },
    { id: 'unfrozen template (no --source-sha)', over: { descriptorPath: TEMPLATE, sourceSha: null, root: null }, expect: /descriptor\.sourceSha/ },
    { id: 'a new seed reusing the staged level name', over: { seed: '112233445566' }, expect: /target_level_name_exists/ },
  ]
  for (const entry of cases) {
    if (entry.touchLevelDat === true) writeFileSync(join(container, 'm3clean-prep', 'level.dat'), 'fixture', 'utf8')
    const planned = planPrepare({ ...basePlan, ...(entry.over ?? {}) })
    assert.equal(planned.status, 'REFUSED', `refusal ${entry.id}: status=${planned.status}`)
    assert.match(planned.refusals.map((refusal) => refusal.reason).join(' | '), entry.expect, `refusal ${entry.id} reasons: ${planned.refusals.map((refusal) => refusal.reason).join(' | ')}`)
    if (entry.touchLevelDat === true) rmSync(join(container, 'm3clean-prep', 'level.dat'))
  }
  // the SAME descriptor+name+seed on an ungenerated staged world is the
  // idempotent path, not a refusal (and it says so)
  const idempotent = planPrepare(basePlan)
  assert.equal(idempotent.status, 'PLANNED')
  assert.ok(idempotent.warnings.some((warning) => /idempotent no-op/.test(warning)))
  ok(`G4. ${cases.length} prepare refusal paths, each with its exact reason (generated world / protected name / live seed / server-root inside target / unfrozen template / level-name reuse)`)
}
// ---------------------------------------------------------------------------
// H. CLI surfaces
// ---------------------------------------------------------------------------
{
  for (const tool of [PREPARE_TOOL, GATE_TOOL]) {
    const help = spawnSync(process.execPath, [tool, '--help'], { encoding: 'utf8' })
    assert.equal(help.status, 0, `${tool} --help exit=${help.status}`)
    const missing = spawnSync(process.execPath, [tool], { encoding: 'utf8' })
    assert.equal(missing.status, 2, `${tool} without --environment exit=${missing.status}`)
  }
  const template = spawnSync(process.execPath, [GATE_TOOL, '--environment', TEMPLATE], { encoding: 'utf8' })
  assert.equal(template.status, 1, `template gate exit=${template.status}`)
  assert.match(template.stdout, /CLEAN_RUN_RESULT status=NOT_CLEAN/)
  const json = spawnSync(process.execPath, [GATE_TOOL, '--environment', TEMPLATE, '--json'], { encoding: 'utf8' })
  assert.equal(json.status, 1)
  const parsed = JSON.parse(json.stdout)
  assert.equal(parsed.record, 'clean-run-gate')
  assert.equal(parsed.status, 'NOT_CLEAN')
  assert.match(json.stderr, /CLEAN_RUN_RESULT status=NOT_CLEAN/, 'the human lines go to stderr under --json')
  ok('H. CLI: --help exit 0, a missing --environment exits 2, the template exits 1, --json keeps stdout parseable')
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(`clean-run-harness-test ${checks}/${checks} PASS`)
