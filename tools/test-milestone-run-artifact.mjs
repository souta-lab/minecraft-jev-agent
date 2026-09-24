#!/usr/bin/env bun
// test-milestone-run-artifact: offline fixtures for tools/milestone-run-artifact.mjs.
//
// Every fixture below is a synthetic resident tree (buddy-driver/buddy.log,
// buddy-driver/logs/jev/decisions.jsonl, buddy-driver/runner.out and
// buddy-driver/data/resident/acceptance-<runId>.json). No live resident, socket,
// or network is used. Positive M3 cases inject an explicitly synthetic,
// same-run acceptance-time report through buildRunArtifact's readSocket seam;
// `--no-control-socket` cases deliberately have no terminal report.
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
//   V. a run superseded by a host restart still resolves its window from the
//      append-only buddy.log (runner.out is truncated), with both attempts recorded
//   W. a FROZEN host's socket hash names the STAGED candidate, never the executing
//      source (the last committed reload stays effective)
//
// Usage: bun tools/test-milestone-run-artifact.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attributeRunLines, buildRunArtifact, coercePropertyValue, parseKeyValues, readEnvironmentFile, readServerProperties, runCli } from './milestone-run-artifact.mjs'
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
const SYSTEM2_BUILD_HASH = 'e6be1812c804'
const WORLD_KEY = '{"serverId":"127.0.0.1:25565","dimension":"minecraft:overworld","worldEpoch":1}'

{
  const startup = { status: 'verified', runtime: { java: { version: '21.0.13-ea', versionOutput: { stderr: 'version output with spaces' } } }, process: { argv: ['java', '-Xmx1G', '-jar', 'leaf.jar'], nested: { detail: 'JSON key=value text must stay nested' } } }
  const parsed = parseKeyValues(`BOOT runId=run-parser-fixture cleanRunServerConfig=${JSON.stringify(startup)} frozen=true`)
  assert.deepEqual(parsed.cleanRunServerConfig, startup)
  assert.equal(parsed.frozen, 'true')
  assert.equal(parsed.version, undefined)
  ok('BOOT key/value parser retains nested startup JSON and continues with following fields')
}

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
  let system2Configured = null
  if (stack !== null) {
    try {
      const parsed = JSON.parse(stack)
      if (typeof parsed?.provider === 'string' && typeof parsed?.model === 'string') system2Configured = parsed
    } catch {
      // Keep an invalid configured stack visible in the marker, but do not
      // synthesize valid generation-lineage fields for it.
    }
  }
  const configuredLineage = system2Configured === null
    ? ''
    : `system2ConfiguredProvider=${system2Configured.provider} system2ConfiguredModel=${system2Configured.model} `
  if (build !== null) {
    lines.push(line(offsetSec + 0.5, `BUILD hash=${build} bytes=6181238 ms=51 outfile=/fixture/data/resident/gen-${build}`))
  }
  if (ready) {
    lines.push(
      line(
        offsetSec + 1,
        `GENERATION_READY runId=${runId} id=gen-test-1 rungIndex=13 rungId=nether_portal ` +
          'goals=["verify the lit nether_portal block in the overworld","enter the lit nether_portal"] ' +
          'policy=typesafe policyProvider=typesafe-ai model=typesafe-ai/jev policyModel=typesafe-ai/jev ' +
          `generationId=gen-test-1 sourceSha=${sourceSha} buildHash=${SYSTEM2_BUILD_HASH} ` + configuredLineage +
          (stack === null ? '' : `system2AuthorityStack=${stack} `) +
          'system2LastAuthority={"provider":"none","model":"none"} deterministicFallbackEnabled=false ' +
          'planner=llm plannerModel=typesafe-ai/jev',
      ),
    )
  }
  for (const [index, decision] of decisions.entries()) {
    const requestId = `artifact-plan-${runId}-${index}`
    const provider = /\bprovider=(\S+)/.exec(decision)?.[1]
    const model = /\bmodel=(\S+)/.exec(decision)?.[1]
    if (provider !== undefined && model !== undefined && system2Configured !== null) {
      const identity =
        `runId=${runId} requestId=${requestId} generationId=gen-test-1 sourceSha=${sourceSha} buildHash=${SYSTEM2_BUILD_HASH} ` +
        `configuredProvider=${system2Configured.provider} configuredModel=${system2Configured.model} trigger=run_artifact_fixture `
      lines.push(line(offsetSec + 1.5 + index * 0.1, `SYSTEM2_AUTHORITY_INPUT provider=${provider} model=${model} ${identity}`))
      lines.push(line(offsetSec + 2 + index * 0.1, `${decision} ${identity}`))
      const op = /\bop=(\S+)/.exec(decision)?.[1] ?? 'patch'
      lines.push(line(offsetSec + 2.05 + index * 0.1, `SYSTEM2_PLAN_APPLIED ${identity} op=${op} accepted=true applied=${op === 'patch' || op === 'replace' ? 1 : 0}`))
    } else {
      lines.push(line(offsetSec + 2 + index * 0.1, decision))
    }
  }
  if (released) lines.push(line(offsetSec + 3 + decisions.length * 0.1, `HOST_LOCK released runId=${runId}`))
  const extras = [
    ...resumes.map((resume) => ({ sec: resume.sec, body: `RESUME ok=${resume.ok === false ? 'false' : 'true'} reconnect=false` })),
    ...reloads.map((reload) => ({ sec: reload.sec, body: reload.body })),
  ].sort((left, right) => left.sec - right.sec)
  for (const extra of extras) lines.push(line(extra.sec, extra.body))
  return lines.join('\n') + '\n'
}

const decisionsFor = (runId, sourceSha = SOURCE_SHA, sec = 2) => `${JSON.stringify({
  record: 'decision', ts: at(sec), source: 'jev', runId,
  generationId: 'gen-test-1', sourceSha,
  jev: { provider: 'typesafe-ai', model: 'typesafe-ai/jev' }, action: 'GOTO:nether_portal',
})}\n`

const ACCEPTANCE = (runId) =>
  JSON.stringify({
    record: 'acceptance',
    runId,
    ts: at(40),
    gitCommit: SOURCE_SHA,
    checkoutHead: SOURCE_SHA,
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

function writeFixture(root, runId, { logLines, acceptance = true, runner = {}, initialSnapshot = false }) {
  writeFileSync(join(root, 'buddy-driver', 'buddy.log'), `${logLines.join('\n')}\n`, 'utf8')
  writeFileSync(join(root, 'buddy-driver', 'runner.out'), runnerOut(runId, runner), 'utf8')
  writeFileSync(
    join(root, 'buddy-driver', 'logs', 'jev', 'decisions.jsonl'),
    decisionsFor(runId, runner.sourceSha ?? SOURCE_SHA, (runner.offsetSec ?? 0) + 2),
    'utf8',
  )
  if (initialSnapshot) {
    const scoped = attributeRunLines(runId, logLines)
    const bootSourceSha = /\bsource=([a-f0-9]{40})/i.exec(scoped.bootLines[0]?.line ?? '')?.[1] ?? null
    const initialInventory = scoped.inventorySamples[0]?.counts ?? {}
    const buildHash = runner.build ?? SYSTEM2_BUILD_HASH
    writeFileSync(
      join(root, 'buddy-driver', 'data', 'resident', `m2-snapshot-${runId}.json`),
      JSON.stringify({
        record: 'm2-snapshot',
        runId,
        generationId: 'gen-test-1',
        bootSourceSha,
        buildHash,
        worldEpoch: 1,
        worldKey: '127.0.0.1:25565|minecraft:overworld|1',
        initialInventory,
        initialInventoryObservation: {
          runId,
          atMs: Date.parse(at(0)),
          at: at(0),
          generationId: 'gen-test-1',
          bootSourceSha,
          buildHash,
          worldEpoch: 1,
          worldKey: '127.0.0.1:25565|minecraft:overworld|1',
        },
        inventory: initialInventory,
        markers: [],
      }),
      'utf8',
    )
  }
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
    line(19, 'DIMENSION_TRANSITION from=minecraft:overworld to=minecraft:the_nether dimension=minecraft:the_nether reason=live-change source=live-world'),
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

/**
 * An offline HOST report fixture, bound to the requested run and BOOT source.
 * This is test evidence only: it enters through the injected readSocket seam,
 * never through a production fallback or a real control socket.
 */
function currentInventoryObservation(runId, counts, { dimension = 'minecraft:the_nether', sourceSha = SOURCE_SHA } = {}) {
  const observedAt = at(41)
  return {
    record: 'current-inventory-observation',
    schemaVersion: 1,
    runId,
    sourceSha,
    generationId: 'gen-test-1',
    observedAtMs: Date.parse(observedAt),
    observedAt,
    worldKey: { serverId: '127.0.0.1:25565', dimension, worldEpoch: 1 },
    dimension,
    counts,
  }
}

async function cliWithReport(args, { runId, counts, dimension } = {}) {
  let stdout = ''
  let stderr = ''
  const result = await runCli({
    argv: args,
    write: (chunk) => { stdout += chunk },
    writeError: (chunk) => { stderr += chunk },
    build: ({ runId: requestedRunId, root, overrides = {} }) => buildRunArtifact({
      runId: requestedRunId,
      root,
      overrides: { ...overrides, controlSocketPath: '/fixture/control.sock' },
      readSocket: async () => ({
        runId,
        worldKey: { serverId: '127.0.0.1:25565', dimension: dimension ?? 'minecraft:the_nether', worldEpoch: 1 },
        policyKind: 'typesafe',
        policyModel: 'typesafe-ai/jev',
        generationId: 'gen-test-1',
        frozen: false,
        currentInventoryObservation: currentInventoryObservation(runId, counts, { dimension }),
      }),
    }),
  })
  return {
    code: result.exitCode,
    stdout,
    stderr,
    json: () => result.artifact,
  }
}

const RUN_PASS = 'run-fixture-pass'
const RUN_FAIL = 'run-fixture-fail'

// ---------------------------------------------------------------------------
// A. PASS-shaped run
// ---------------------------------------------------------------------------
const passRoot = makeRoot('pass')
writeFixture(passRoot, RUN_PASS, { logLines: fullLog(RUN_PASS, { terminalEye: 12 }), initialSnapshot: true })
const pass = await cliWithReport(['--run', RUN_PASS, '--root', passRoot, '--json'], {
  runId: RUN_PASS,
  counts: { diamond: 3, diamond_pickaxe: 1, ender_eye: 12, ender_pearl: 0, blaze_rod: 0, blaze_powder: 0 },
})
assert.equal(pass.code, 0, `PASS fixture exit=${pass.code} stderr=${pass.stderr}`)
const passArtifact = pass.json()
assert.equal(passArtifact.status, 'PASS')
assert.equal(passArtifact.complete, true)
assert.deepEqual(passArtifact.missingEvidence, [])
assert.equal(passArtifact.verdicts.M2.status, 'PASS')
assert.equal(passArtifact.verdicts.M3.status, 'PASS')
assert.equal(passArtifact.run.runId, RUN_PASS)
assert.equal(passArtifact.run.boot.sourceSha, SOURCE_SHA)
assert.equal(passArtifact.authority.system2.identityStatus, 'verified')
assert.equal(passArtifact.authority.system2.effectiveProvider, 'typesafe-ai')
assert.equal(passArtifact.authority.system2.effectiveModel, 'typesafe-ai/jev')
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
assert.equal(passArtifact.inventory.boot.source, 'snapshot')
assert.equal(passArtifact.inventory.bootEvidence.status, 'verified')
assert.equal(passArtifact.inventory.latest.counts.ender_eye, 12)
assert.equal(passArtifact.inventory.final.status, 'PRESENT')
assert.equal(passArtifact.inventory.final.source, 'control.report')
assert.equal(passArtifact.inventory.final.runId, RUN_PASS)
assert.equal(passArtifact.inventory.final.sourceSha, SOURCE_SHA)
assert.equal(passArtifact.inventory.final.counts.ender_eye, 12)
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

// The initial inventory is generation-entry evidence and must be tied to BOOT's
// exact source. A same-run snapshot with a foreign or missing source binding
// cannot be replaced by the first periodic INVENTORY row.
for (const [label, snapshotSource] of [['foreign', 'f'.repeat(40)], ['missing', null]]) {
  const runId = `run-fixture-inventory-snapshot-${label}`
  const root = makeRoot(`inventory-snapshot-${label}`)
  const logs = [
    boot(0, runId),
    spawnLine(1),
    line(10, 'INVENTORY items={"diamond":3,"ender_eye":12} pos=0.5,64.0,0.5'),
    line(20, 'INVENTORY items={} pos=0.5,64.0,0.5'),
  ]
  writeFixture(root, runId, { logLines: logs })
  const snapshot = {
    record: 'm2-snapshot', runId,
    generationId: 'gen-test-1', buildHash: SYSTEM2_BUILD_HASH, worldEpoch: 1,
    worldKey: '127.0.0.1:25565|minecraft:overworld|1',
    initialInventory: {}, inventory: {},
    initialInventoryObservation: {
      runId, atMs: Date.parse(at(0)), at: at(0), generationId: 'gen-test-1',
      bootSourceSha: snapshotSource, buildHash: SYSTEM2_BUILD_HASH, worldEpoch: 1,
      worldKey: '127.0.0.1:25565|minecraft:overworld|1',
    },
  }
  if (snapshotSource !== null) snapshot.bootSourceSha = snapshotSource
  writeFileSync(join(root, 'buddy-driver', 'data', 'resident', `m2-snapshot-${runId}.json`), JSON.stringify(snapshot), 'utf8')
  const artifact = cli(['--run', runId, '--root', root, '--json', '--no-control-socket']).json()
  assert.equal(artifact.inventory.boot, null)
  assert.equal(artifact.inventory.bootEvidence.status, 'unknown')
  assert.equal(artifact.inventory.milestoneItems.ender_eye.boot, null)
  assert.ok(artifact.missingEvidence.includes('inventory.boot'))
  assert.equal(artifact.status, 'UNKNOWN')
  assert.match(artifact.inventory.bootEvidence.reason, snapshotSource === null ? /snapshot_boot_source_sha_missing/ : /snapshot_boot_source_sha_mismatch/)
  ok(`${label} snapshot source binding leaves inventory.boot UNKNOWN despite a later nonempty periodic sample`)
}

// The active BOOT owns untagged and exact-run observations only. A foreign
// explicit runId on a transition must be excluded and surfaced by the reader vs
// gate scanner cross-check, so it cannot authenticate Nether arrival here.
{
  const runId = 'run-fixture-foreign-dimension-marker'
  const root = makeRoot('foreign-dimension-marker')
  const lines = [
    boot(0, runId),
    spawnLine(1),
    line(2, 'DIMENSION_TRANSITION from=minecraft:overworld to=minecraft:the_nether dimension=minecraft:the_nether runId=run-fixture-foreign-dimension reason=live-change source=live-world'),
    line(3, `DIMENSION_TRANSITION from=minecraft:overworld to=minecraft:the_end dimension=minecraft:the_end runId=${runId} reason=live-change source=live-world`),
  ]
  writeFixture(root, runId, { logLines: lines })
  const artifact = cli(['--run', runId, '--root', root, '--json', '--no-control-socket']).json()
  const attributed = attributeRunLines(runId, lines)
  assert.deepEqual(attributed.dimensionObservations.map((entry) => entry.dimension), ['minecraft:overworld', 'minecraft:the_end'])
  assert.ok(attributed.foreignRuns.includes('run-fixture-foreign-dimension'))
  assert.deepEqual(artifact.environment.dimensions.observed, ['minecraft:overworld', 'minecraft:the_end'])
  assert.ok(!artifact.missingEvidence.includes('attribution:gate_cross_check'))
  assert.equal(artifact.status, 'UNKNOWN')
ok('foreign runId dimension markers are excluded consistently by the artifact and gate scanner')
}

// Same synthetic run evidence, without a HOST report, must remain UNKNOWN even
// though the historical log reaches 12 eyes. This keeps fixture-only report
// injection explicit and guards the acceptance-time inventory boundary.
{
  const runId = 'run-fixture-missing-current-inventory-report'
  const root = makeRoot('missing-current-inventory-report')
  writeFixture(root, runId, { logLines: fullLog(runId, { terminalEye: 12 }) })
  const missingReport = cli(['--run', runId, '--root', root, '--json', '--no-control-socket'])
  assert.equal(missingReport.code, 2)
  const artifact = missingReport.json()
  assert.equal(artifact.status, 'UNKNOWN')
  assert.equal(artifact.verdicts.M3.status, 'UNKNOWN')
  assert.equal(artifact.verdicts.M3.conditions.ender_eye_ready, 'UNKNOWN')
  assert.equal(artifact.inventory.final.status, 'MISSING')
  assert.ok(artifact.missingEvidence.includes('inventory.final'))
  assert.ok(artifact.missingEvidence.includes('verdict:M3'))
}
ok('12 historical eyes without a same-run acceptance-time HOST report stay UNKNOWN')

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
  assert.equal(byId('nether_reached').source, 'log:DIMENSION_TRANSITION:dimension')
  assert.deepEqual(byId('nether_reached').evidence.transition, {
    from: 'minecraft:overworld',
    to: 'minecraft:the_nether',
    dimension: 'minecraft:the_nether',
    atMs: T0 + 19000,
    source: 'live-world',
    runId: RUN_PASS,
    sourceSha: SOURCE_SHA,
  })
  assert.equal(byId('ender_eyes').source, 'log:INVENTORY')
}
ok('PASS fixture carries a first-class, run-scoped milestone predicate section')

// A host observation for this run must be merged into the artifact section and
// upgrade the delegated M3 verdict only because it is truly observed.
{
  const runId = 'run-fixture-host'
  const hostRoot = makeRoot('host')
  writeFixture(hostRoot, runId, { logLines: fullLog(runId, { terminalEye: 0 }), initialSnapshot: true })
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
  const hosted = await cliWithReport(['--run', runId, '--root', hostRoot, '--json'], {
    runId,
    counts: { diamond: 3, diamond_pickaxe: 1, ender_eye: 12, ender_pearl: 0, blaze_rod: 0, blaze_powder: 0 },
  })
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
  writeFixture(mismatchRoot, runId, { logLines: fullLog(runId, { terminalEye: 0 }), initialSnapshot: true })
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
  const mismatched = await cliWithReport(['--run', runId, '--root', mismatchRoot, '--json'], {
    runId,
    counts: { diamond: 3, diamond_pickaxe: 1, ender_eye: 12, ender_pearl: 0, blaze_rod: 0, blaze_powder: 0 },
  })
  const mismatchedArtifact = mismatched.json()
  assert.equal(mismatchedArtifact.milestonePredicates.predicates.find((predicate) => predicate.id === 'ender_eyes').satisfied, false)
  assert.equal(mismatchedArtifact.milestonePredicates.mismatches.length, 1)
  assert.ok(mismatchedArtifact.missingEvidence.includes('milestonePredicate:source_mismatch'))
  assert.equal(mismatchedArtifact.verdicts.M3.status, 'PASS', 'the independent current-inventory report still proves the eyes')
  assert.notEqual(mismatchedArtifact.status, 'PASS', 'the rejected source-bound predicate keeps the full artifact incomplete')
}
ok('a run-scoped host observation upgrades a predicate; a sourceSha mismatch is rejected and surfaced')


// ---------------------------------------------------------------------------
// A2. the M2 chain is carried per link WITH the source that proved each link
// ---------------------------------------------------------------------------
// The delegated gate's stage conditions say WHAT passed; they cannot say WHICH
// evidence source proved each link, and its structured `facts` object is not part
// of the artifact. The gate's `m2_chain:` line is the ordered trace, and the
// artifact must carry it as `verdicts.M2.chain` with built/lit/verified.
{
  assert.equal(passArtifact.schemaVersion, 9)
  const chain = passArtifact.verdicts.M2.chain
  assert.ok(chain !== null && typeof chain === 'object', `M2 chain missing: ${JSON.stringify(passArtifact.verdicts.M2)}`)
  assert.equal(chain.ordered, true)
  assert.deepEqual(chain.sources, ['snapshot', 'log'])
  // built: the validated frame, with the frame's OWN blocks/shape and its index.
  assert.equal(chain.built.status, 'PASS')
  assert.equal(chain.built.source, 'log')
  assert.equal(chain.built.blocks, 10)
  assert.equal(chain.built.shape, 'ok')
  assert.equal(chain.placedIndex, 0)
  assert.ok(chain.built.index > chain.placedIndex, 'the frame must come after the first placed block')
  // lit: the PORTAL_LIT in the overworld.
  assert.equal(chain.lit.status, 'PASS')
  assert.equal(chain.lit.source, 'log')
  assert.equal(chain.lit.dimension, 'minecraft:overworld')
  assert.equal(chain.lit.overworld, true)
  // verified: PORTAL_VERIFIED=true AFTER the light.
  assert.equal(chain.verified.status, 'PASS')
  assert.equal(chain.verified.source, 'log')
  assert.ok(chain.verified.index > chain.lit.index, 'verification must come after the light')
  assert.ok(chain.lit.index > chain.built.index, 'the light must come after the frame')
  ok('the artifact carries built/lit/verified in order, each with its evidence source')

  // The raw gate line is still kept verbatim beside the parsed facts.
  assert.ok(
    passArtifact.verdicts.M2.lines.some((entry) => /^m2_chain: source=log built=PASS lit=PASS verified=PASS ordered=true\b/.test(entry)),
    passArtifact.verdicts.M2.lines.join('\n'),
  )
  ok('the raw m2_chain: gate line is preserved in verdicts.M2.lines')
}

{
  // NEGATIVE: a built-but-unlit frame. The artifact must carry `built` PASS while
  // `lit`/`verified` are UNKNOWN - the chain records the gap instead of filling it.
  const unlitRun = 'run-fixture-unlit'
  const unlitRoot = makeRoot('unlit')
  const unlitLog = [
    boot(0, unlitRun),
    spawnLine(1),
    line(10, 'INVENTORY items={"diamond":3,"diamond_pickaxe":1,"flint_and_steel":1,"obsidian":10} pos=0.5,64.0,0.5'),
    ...PORTAL_CHAIN.slice(0, 3).map((body, index) => line(11 + index, body)),
  ]
  writeFixture(unlitRoot, unlitRun, { logLines: unlitLog, acceptance: false, runner: { released: true } })
  const unlit = cli(['--run', unlitRun, '--root', unlitRoot, '--json', '--no-control-socket'])
  const unlitArtifact = unlit.json()
  assert.notEqual(unlitArtifact.verdicts.M2.status, 'PASS')
  assert.equal(unlitArtifact.verdicts.M2.conditions.portal_built, 'PASS')
  assert.equal(unlitArtifact.verdicts.M2.conditions.portal_lit, 'UNKNOWN')
  const unlitChain = unlitArtifact.verdicts.M2.chain
  assert.equal(unlitChain.ordered, false)
  assert.equal(unlitChain.built.status, 'PASS')
  assert.equal(unlitChain.lit.status, 'UNKNOWN')
  assert.equal(unlitChain.verified.status, 'UNKNOWN')
  assert.equal(unlitChain.lit.index, -1)
  assert.equal(unlitChain.verified.index, -1)
  ok('a built-but-unlit portal is carried as built=PASS lit=UNKNOWN (never a chain)')
}

{
  // NEGATIVE: a chain-less PORTAL_VERIFIED=true (the inherited-gate shape) must
  // never produce a PASS link, even though the strongest single fact is true.
  const inheritedRun = 'run-fixture-inherited'
  const inheritedRoot = makeRoot('inherited')
  const inheritedLog = [
    boot(0, inheritedRun),
    spawnLine(1),
    line(10, 'INVENTORY items={"diamond":3,"diamond_pickaxe":1,"flint_and_steel":1,"obsidian":10} pos=0.5,64.0,0.5'),
    line(11, 'PORTAL_TRUTH verified=true reason=status source=live-world'),
  ]
  writeFixture(inheritedRoot, inheritedRun, { logLines: inheritedLog, acceptance: false, runner: { released: true } })
  const inherited = cli(['--run', inheritedRun, '--root', inheritedRoot, '--json', '--no-control-socket'])
  const inheritedArtifact = inherited.json()
  const inheritedChain = inheritedArtifact.verdicts.M2.chain
  assert.equal(inheritedArtifact.verdicts.M2.reason, 'inherited_portal')
  assert.equal(inheritedChain.ordered, false)
  // No source proved any link, so no link fact exists at all (null, never a PASS).
  for (const link of ['built', 'lit', 'verified']) {
    assert.equal(inheritedChain[link], null, `${link} must not exist without a chain`)
  }
  assert.deepEqual(inheritedChain.sources, ['log'])
  assert.equal(inheritedChain.links.length, 1)
  assert.equal(inheritedChain.links[0].source, 'log')
  assert.equal(inheritedChain.links[0].built, 'UNKNOWN')
  ok('an inherited portal carries no PASS link (the chain is the only source of built/lit/verified)')
}

// ---------------------------------------------------------------------------
// B. FAIL-shaped run (materials complete, eyes short)
// ---------------------------------------------------------------------------
const failRoot = makeRoot('fail')
writeFixture(failRoot, RUN_FAIL, { logLines: fullLog(RUN_FAIL, { terminalEye: 0 }), initialSnapshot: true })
const fail = await cliWithReport(['--run', RUN_FAIL, '--root', failRoot, '--json'], {
  runId: RUN_FAIL,
  counts: { diamond: 3, diamond_pickaxe: 1, ender_eye: 0, ender_pearl: 0, blaze_rod: 0, blaze_powder: 0 },
})
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
    overrides: { controlSocketPath: '/fixture/control.sock' },
    readSocket: async () => ({
      runId: RUN_PASS,
      worldKey: { serverId: '127.0.0.1:25565', dimension: 'minecraft:the_nether', worldEpoch: 1 },
      currentInventoryObservation: currentInventoryObservation(RUN_PASS, { ender_eye: 12 }),
    }),
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
  const written = await cliWithReport(
    ['--run', RUN_PASS, '--root', passRoot, '--out', outPath],
    { runId: RUN_PASS, counts: { diamond: 3, diamond_pickaxe: 1, ender_eye: 12 } },
  )
  assert.equal(written.code, 0)
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
  const result = await cliWithReport(['--run', runId, '--root', root, '--json'], {
    runId,
    dimension: 'minecraft:overworld',
    counts: { diamond: 3, diamond_pickaxe: 1, ender_eye: 12 },
  })
  const artifact = result.json()
  const nether = artifact.milestonePredicates.predicates.find((predicate) => predicate.id === 'nether_reached')
  assert.equal(nether.satisfied, null, 'a run with no transition observation must not claim the predicate')
  assert.equal(nether.source, null)
  assert.equal(nether.evidence.rejected, 'body_dimension_transition_missing')
  assert.ok(artifact.milestonePredicates.missing.includes('nether_reached'))
  assert.equal(artifact.verdicts.M3.conditions.nether_reached, 'UNKNOWN')
  assert.equal(artifact.verdicts.M3.conditions.ender_eye_ready, 'PASS', 'the eyes are still proven')
  assert.notEqual(artifact.status, 'PASS')
  assert.notEqual(result.code, 0)
}
ok('a run with 12 eyes but no Nether transition: nether_reached UNKNOWN, artifact not PASS')

// A run/source-matching observe-loop predicate can still be stale or derived
// from a portal projection; only the body transition line may populate this row.
{
  const runId = 'run-fixture-injected-nether'
  const root = makeRoot('injected-nether')
  const lines = fullLog(runId, { terminalEye: 0 }).filter((entry) => !entry.includes('DIMENSION_TRANSITION'))
  writeFixture(root, runId, { logLines: lines })
  writeFileSync(
    join(root, 'buddy-driver', 'data', 'resident', `milestone-predicates-${runId}.json`),
    JSON.stringify({
      record: 'milestone-predicates',
      schemaVersion: 1,
      runId,
      sourceSha: SOURCE_SHA,
      generationId: 'gen-injected-nether',
      observationCount: 1,
      updatedAt: at(20),
      predicates: [{
        id: 'nether_reached',
        satisfied: true,
        observedAtMs: T0 + 19000,
        observedAt: at(19),
        source: 'host-observe:rung:enter_nether',
        evidence: { dimension: 'minecraft:the_nether', source: 'PORTAL_LIT' },
      }],
    }),
  )
  const result = await cliWithReport(['--run', runId, '--root', root, '--json'], {
    runId,
    counts: { diamond: 3, diamond_pickaxe: 1, ender_eye: 12 },
  })
  const artifact = result.json()
  const nether = artifact.milestonePredicates.predicates.find((predicate) => predicate.id === 'nether_reached')
  assert.equal(nether.satisfied, null)
  assert.equal(nether.source, null)
  assert.equal(nether.evidence.rejected, 'body_dimension_transition_missing')
  assert.ok(artifact.milestonePredicates.mismatches.includes('unverified_nether_predicate_source_ignored'))
  assert.equal(artifact.verdicts.M3.conditions.nether_reached, 'UNKNOWN')
  assert.notEqual(artifact.status, 'PASS')
}
ok('an exact-run/source observe-loop PORTAL_LIT claim cannot manufacture a Nether BODY transition')

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
    line(19, 'DIMENSION_TRANSITION from=minecraft:overworld to=minecraft:the_nether dimension=minecraft:the_nether reason=live-change source=live-world'),
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

  // A decision for ANOTHER run never applies to this one - and (schema 5) that fact
  // is now VISIBLE per run instead of leaving the verdict with no explanation.
  // A run that inherits a portal it did not build, while the recorded decision is
  // scoped to a DIFFERENT runId: the exact GAP-1 situation.
  const OTHER_RUN = 'run-fixture-unrelated'
  const otherRoot = makeRoot('inherited-other-run')
  writeFixture(otherRoot, OTHER_RUN, {
    logLines: [
      boot(0, OTHER_RUN),
      line(10, 'INVENTORY items={"ender_pearl":0,"blaze_rod":0,"blaze_powder":0,"ender_eye":0} pos=0.5,64.0,0.5'),
      line(11, 'PORTAL_VERIFIED=true'),
      line(19, 'DIMENSION_TRANSITION from=minecraft:overworld to=minecraft:the_nether dimension=minecraft:the_nether reason=live-change source=live-world'),
    ],
  })
  const other = cli(['--run', OTHER_RUN, '--root', otherRoot, '--json', '--no-control-socket', '--operator-decisions', decisionsPath])
  const otherArtifact = other.json()
  assert.equal(otherArtifact.verdicts.M2.operatorDecision, null)
  const premise = otherArtifact.verdicts.M2.operatorDecisionPremise
  assert.equal(premise.present, true)
  assert.equal(premise.thisRunInherits, false)
  assert.equal(premise.thisRunMust, 'build')
  assert.equal(premise.decisions[0].appliesToThisRun, false)
  assert.equal(premise.decisions[0].outcome, 'scoped_to_another_run')
  assert.equal(premise.decisions[0].runScope, runId)
  assert.equal(otherArtifact.operatorDecisions.considered.length, 1)
  assert.equal(otherArtifact.operatorDecisions.considered[0].outcome, 'scoped_to_another_run')
  assert.equal(typeof otherArtifact.operatorDecisions.sha256, 'string')
  assert.equal(otherArtifact.operatorDecisions.sha256.length, 64)
  // The verdict itself is untouched: the gate still says UNKNOWN inherited_portal.
  assert.equal(otherArtifact.verdicts.M2.status, 'UNKNOWN')
  assert.equal(otherArtifact.verdicts.M2.reason, 'inherited_portal')
  // schema 5: the STRUCTURED gate facts behind the premise (not a regex over lines).
  const gateFacts = premise.gateFacts
  assert.equal(gateFacts.available, true)
  assert.equal(gateFacts.framePass, false)
  assert.equal(gateFacts.litPass, false)
  assert.equal(gateFacts.inheritedPortal.detected, true)
  assert.ok(gateFacts.inheritedPortal.observations.some((observation) => observation.kind === 'live_world_truth' || observation.kind === 'runtime_verified_without_build_chain'))
  assert.deepEqual(gateFacts.conditions, otherArtifact.verdicts.M2.conditions)
  // The relevant-premise gap appears on the run that must build the premise.
  assert.ok(otherArtifact.missingEvidence.includes('premise:M2'))
  // A decision that applies to this run states inherit instead.
  assert.equal(appliedArtifact.verdicts.M2.operatorDecisionPremise.thisRunInherits, true)
  assert.equal(appliedArtifact.verdicts.M2.operatorDecisionPremise.thisRunMust, 'inherit')
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
  const result = await cliWithReport(['--run', runId, '--root', root, '--json'], {
    runId,
    counts: { diamond: 3, diamond_pickaxe: 1, ender_eye: 12, ender_pearl: 0, blaze_rod: 0, blaze_powder: 0 },
  })
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
  assert.equal(artifact.authority.system2.identityStatus, 'unknown')
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
  // schema 5: the evidence CLASS is stated, and what the record does/does not assert.
  assert.equal(artifact.acceptance.evidenceClass.status, 'PRESENT')
  assert.equal(artifact.acceptance.evidenceClass.kind, 'host-lifecycle-attestation')
  assert.equal(artifact.acceptance.evidenceClass.blocksMilestoneVerdict, false)
  assert.equal(artifact.acceptance.evidenceClass.fabricatable, false)
  assert.ok(artifact.acceptance.evidenceClass.attests.length >= 4)
  assert.ok(artifact.acceptance.evidenceClass.safeTriggers.some((entry) => /control command `acceptance`/.test(entry)))
  assert.match(artifact.acceptance.evidenceClass.milestoneQuestionAnsweredBy, /milestoneAcceptance/)
  const acceptanceClass = artifact.evidenceClasses.find((entry) => entry.id === 'acceptance')
  assert.equal(acceptanceClass.status, 'PRESENT')
  assert.equal(artifact.milestoneAcceptance.status, 'INCOMPLETE')
  assert.deepEqual(artifact.milestoneAcceptance.incompleteMilestones, ['M3'])
  assert.deepEqual(artifact.milestoneAcceptance.milestones.M3.unmetConditions, [])
  assert.deepEqual(artifact.milestoneAcceptance.milestones.M3.unknownConditions, ['ender_eye_ready'])
  assert.notEqual(artifact.status, 'PASS')
  assert.notEqual(result.code, 0)

  // The same run with no record: still INCOMPLETE, and the gap names the writer.
  const bareRoot = makeRoot('incomplete-acceptance-missing')
  writeFixture(bareRoot, runId, { logLines: fullLog(runId, { terminalEye: 0 }), acceptance: false })
  const bare = cli(['--run', runId, '--root', bareRoot, '--json', '--no-control-socket']).json()
  assert.equal(bare.acceptance.present, false)
  assert.equal(bare.milestoneAcceptance.status, 'INCOMPLETE')
  assert.deepEqual(bare.milestoneAcceptance.milestones.M3.unmetConditions, [])
  assert.deepEqual(bare.milestoneAcceptance.milestones.M3.unknownConditions, ['ender_eye_ready'])
  const gap = bare.missingEvidenceDetail.find((entry) => entry.field === 'acceptance')
  assert.ok(gap, 'an absent acceptance record must stay a reasoned gap')
  assert.match(gap.reason, /writeAcceptance\(\)/)
  assert.match(gap.reason, /generation-reload-commit/)
  // schema 5: which evidence class, why, and that it is never fabricated.
  assert.equal(bare.acceptance.evidenceClass.status, 'MISSING')
  assert.equal(bare.acceptance.evidenceClass.reason, 'acceptance_artifact_missing')
  assert.equal(bare.acceptance.evidenceClass.fabricatable, false)
  assert.ok(bare.acceptance.evidenceClass.safeTriggers.length >= 3)
  assert.equal(bare.evidenceClasses.find((entry) => entry.id === 'acceptance').status, 'MISSING')
  assert.equal(bare.evidenceClasses.find((entry) => entry.id === 'acceptance').reason, 'acceptance_artifact_missing')
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
    initialSnapshot: true,
    runner: {
      stack: '{"provider":"hybrid","model":"typesafe-ai:typesafe-ai/jev|muse-spark:meta/muse-spark-1.3-contributor"}',
      decisions: ['SYSTEM2_AUTHORITY_DECISION provider=muse-spark model=meta/muse-spark-1.3-contributor chosen=front_nether_portal'],
    },
  })
  const result = await cliWithReport(['--run', runId, '--root', root, '--json'], {
    runId,
    counts: { diamond: 3, diamond_pickaxe: 1, ender_eye: 12, ender_pearl: 0, blaze_rod: 0, blaze_powder: 0 },
  })
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
  assert.equal(artifact.authority.fallback.unclassifiableCount, 0)
  // acceptance record present and the milestone genuinely complete
  assert.equal(artifact.acceptance.present, true)
  assert.equal(artifact.milestoneAcceptance.status, 'COMPLETE')
  assert.deepEqual(artifact.milestoneAcceptance.incompleteMilestones, [])
  assert.deepEqual(artifact.milestoneAcceptance.milestones.M3.unmetConditions, [])
  assert.deepEqual(artifact.milestoneAcceptance.milestones.M3.unknownConditions, [])
}
ok('a synthetic complete run answers source SHA, env, inventory, transitions, predicates, authority and fallback absence')

{
  const runId = 'run-fixture-acceptance-source-mismatch'
  const root = makeRoot('acceptance-source-mismatch')
  writeFixture(root, runId, { logLines: fullLog(runId, { terminalEye: 12 }) })
  const acceptancePath = join(root, 'buddy-driver', 'data', 'resident', `acceptance-${runId}.json`)
  writeFileSync(
    acceptancePath,
    JSON.stringify({ record: 'acceptance', runId, gitCommit: 'f'.repeat(40), checkoutHead: SOURCE_SHA }),
  )
  const artifact = cli(['--run', runId, '--root', root, '--json', '--no-control-socket']).json()
  assert.equal(artifact.status, 'UNKNOWN')
  assert.equal(artifact.run.source.exactGitSource.status, 'unknown')
  assert.match(artifact.run.source.exactGitSource.reason, /acceptance_git_commit_mismatch/)
  assert.ok(artifact.missingEvidence.includes('run.source:exact_git_sha'))
  assert.equal(artifact.verdicts.M3.status, 'UNKNOWN')
  ok('a run-scoped acceptance gitCommit mismatch is surfaced and rejected by M3')
}

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
  const result = await cliWithReport(['--run', runId, '--root', root, '--json'], {
    runId,
    counts: { diamond: 3, diamond_pickaxe: 1, ender_eye: 12, ender_pearl: 0, blaze_rod: 0, blaze_powder: 0 },
  })
  // Bundle hashes identify generations, not source commits. A source-changing
  // reload has no exact Git SHA, so this run remains UNKNOWN at acceptance.
  assert.equal(result.code, 2, `reload fixture must remain UNKNOWN: ${result.stderr}`)
  const artifact = result.json()
  assert.ok(artifact.missingEvidence.includes('run.source:exact_git_sha'))
  assert.equal(artifact.status, 'UNKNOWN')
  assert.equal(artifact.verdicts.M3.status, 'UNKNOWN')
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
  assert.equal(source.exactGitSource.status, 'unknown')
  assert.equal(source.exactGitSource.reason, 'source_changing_reload_has_no_exact_git_sha')
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
  writeFixture(cleanRoot, cleanId, { logLines: fullLog(cleanId, { terminalEye: 12 }), initialSnapshot: true, runner: { build: 'boot11112222' } })
  const clean = await cliWithReport(['--run', cleanId, '--root', cleanRoot, '--json'], {
    runId: cleanId,
    counts: { diamond: 3, diamond_pickaxe: 1, ender_eye: 12, ender_pearl: 0, blaze_rod: 0, blaze_powder: 0 },
  })
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
// V. the window survives a host restart in buddy.log (runner.out is truncated)
// ---------------------------------------------------------------------------
{
  const runId = 'run-fixture-window-in-log'
  const successor = 'run-fixture-window-successor'
  const root = makeRoot('window-in-log')
  // The live shape: the resident restarted, so runner.out carries ONLY the new run
  // while the append-only buddy.log still holds the requested run's whole window.
  writeFileSync(join(root, 'buddy-driver', 'runner.out'), runnerOut(successor, { offsetSec: 200, build: 'bootSuccessor1' }), 'utf8')
  writeFileSync(
    join(root, 'buddy-driver', 'buddy.log'),
    `${fullLog(runId, { terminalEye: 12 }).join('\n')}\n` +
      `${line(60, 'RELOAD ok=true trigger=source-changed ms=1240 hash=logOnly33333 id=gen-log generations=2')}\n` +
      `${line(61, 'RELOAD ok=true trigger=source-changed deferred=frozen ms=900 hash=staged444444 contractVersion=3')}\n` +
      `${boot(200, successor)}\n`,
    'utf8',
  )
  writeFileSync(join(root, 'buddy-driver', 'logs', 'jev', 'decisions.jsonl'), decisionsFor(runId), 'utf8')
  writeFileSync(join(root, 'buddy-driver', 'data', 'resident', `acceptance-${runId}.json`), ACCEPTANCE(runId), 'utf8')

  const result = cli(['--run', runId, '--root', root, '--json', '--no-control-socket'])
  const artifact = result.json()
  const source = artifact.run.source
  assert.equal(source.window.status, 'valid', 'the window is found in the log stream')
  assert.equal(source.window.path, join(root, 'buddy-driver', 'buddy.log'))
  assert.deepEqual(
    source.window.attempts,
    [
      { path: join(root, 'buddy-driver', 'runner.out'), status: 'unknown', reason: `run_boundary_missing runId=${runId}` },
      { path: join(root, 'buddy-driver', 'buddy.log'), status: 'valid', reason: null },
    ],
    'both stream attempts are recorded, in order',
  )
  assert.equal(source.provenance, 'reload')
  assert.equal(source.effectiveSourceSha, 'logOnly33333')
  assert.equal(source.reloadCount, 2)
  // The frozen candidate the restart never committed stays staged, never effective.
  assert.equal(source.unmatchedDeferred.hash, 'staged444444')
  assert.equal(source.latestSourceReload.hash, 'logOnly33333')
  assert.equal(source.window.closedByRunId, successor)
  assert.ok(!artifact.missingEvidence.includes('run.source:reload_window'))
}
ok('a superseded run resolves from the append-only log when runner.out no longer holds its BOOT window')

// ---------------------------------------------------------------------------
// W. a FROZEN host's socket hash names the STAGED candidate, not the running source
// ---------------------------------------------------------------------------
{
  const runId = 'run-fixture-frozen-socket'
  const root = makeRoot('frozen-socket')
  writeFixture(root, runId, {
    logLines: fullLog(runId, { terminalEye: 12 }),
    runner: {
      build: 'boot11112222',
      reloads: [
        { sec: 50, body: 'RELOAD ok=true trigger=source-changed ms=100 hash=liveabc12345 id=gen-live generations=2' },
        { sec: 60, body: 'RELOAD ok=true trigger=source-changed deferred=frozen ms=1247 hash=staged999999 contractVersion=3' },
      ],
    },
  })
  const { artifact } = await buildRunArtifact({
    runId,
    root,
    overrides: { controlSocketPath: '/fixture/control.sock' },
    readSocket: async () => ({
      runId,
      policyKind: 'typesafe',
      policyModel: 'typesafe-ai/jev',
      generationHash: 'staged999999',
      generationId: null,
      frozen: true,
    }),
  })
  const source = artifact.run.source
  assert.equal(source.unmatchedDeferred.hash, 'staged999999')
  assert.equal(source.crossCheck.frozen, true)
  assert.equal(source.crossCheck.stagedCandidateHash, 'staged999999')
  assert.equal(source.crossCheck.frozenExplainsSocket, true)
  assert.match(source.crossCheck.note, /FROZEN/)
  assert.match(source.crossCheck.note, /STAGED deferred candidate/)
  // The disagreement is still recorded, but the EXECUTING source is the committed one.
  assert.equal(source.crossCheck.agrees, false)
  assert.equal(source.disagreements.length, 1)
  assert.match(source.disagreements[0], /control_socket_generationHash=staged999999/)
  assert.match(source.disagreements[0], /file_latest_source_reload_hash=liveabc12345/)
  assert.equal(source.effectiveSourceSha, 'liveabc12345')
  assert.equal(source.provenance, 'reload')
}
ok('a frozen host cannot make its staged candidate look like the executing source')

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

// System2 identity is computed by the policy-evidence reader and carried through
// the artifact together with the raw per-generation markers. This fixture uses
// a controlled loader only to isolate the artifact's serialization/merge path;
// the raw runner.out still supplies every event that is asserted below.
{
  const runId = 'run-fixture-system2-lineage'
  const root = makeRoot('system2-lineage')
  const generationId = 'gen-lineage-2'
  const buildHash = 'abc123def456'
  const configuredProvider = 'hybrid'
  const configuredModel = 'typesafe-ai:typesafe-ai/jev'
  const actualProvider = 'typesafe-ai'
  const actualModel = 'typesafe-ai/jev'
  const inputTsMs = Date.parse(at(2))
  const decisionTsMs = Date.parse(at(3))
  writeFixture(root, runId, { logLines: fullLog(runId, { terminalEye: 12 }), initialSnapshot: true })
  writeFileSync(
    join(root, 'buddy-driver', 'runner.out'),
    [
      boot(0, runId),
      line(1, `GENERATION_READY runId=${runId} id=${generationId} generationId=${generationId} sourceSha=${SOURCE_SHA} buildHash=${buildHash} system2ConfiguredProvider=${configuredProvider} system2ConfiguredModel=${configuredModel} policy=typesafe policyProvider=typesafe-ai policyModel=typesafe-ai/jev planner=llm plannerModel=typesafe-ai/jev deterministicFallbackEnabled=false system2AuthorityStack={"provider":"hybrid","model":"typesafe-ai:typesafe-ai/jev"}`),
      line(2, `SYSTEM2_AUTHORITY_INPUT runId=${runId} requestId=request-lineage-1 generationId=${generationId} sourceSha=${SOURCE_SHA} buildHash=${buildHash} provider=${actualProvider} model=${actualModel} configuredProvider=${configuredProvider} configuredModel=${configuredModel} trigger=queue_empty`),
      line(3, `SYSTEM2_AUTHORITY_DECISION runId=${runId} requestId=request-lineage-1 generationId=${generationId} sourceSha=${SOURCE_SHA} buildHash=${buildHash} provider=${actualProvider} model=${actualModel} configuredProvider=${configuredProvider} configuredModel=${configuredModel} trigger=queue_empty chosen=front_nether_portal`),
      line(3.1, `SYSTEM2_PLAN_APPLIED runId=${runId} requestId=request-lineage-1 generationId=${generationId} sourceSha=${SOURCE_SHA} buildHash=${buildHash} op=patch accepted=true applied=1`),
      line(4, `HOST_LOCK released runId=${runId}`),
    ].join('\n') + '\n',
    'utf8',
  )
  const baseEntry = {
    runId,
    requestId: 'request-lineage-1',
    tsMs: inputTsMs,
    generationId,
    sourceSha: SOURCE_SHA,
    buildHash,
    provider: actualProvider,
    model: actualModel,
    configuredProvider,
    configuredModel,
    trigger: 'queue_empty',
  }
  const policySystem2 = {
    runId,
    source: 'fixture:verified-system2-lineage',
    count: 1,
    modelCount: 1,
    ineligibleModelCount: 0,
    portalPlanCount: 1,
    identityStatus: 'verified',
    identityReason: null,
    identityIssues: [],
    effectiveProvider: actualProvider,
    effectiveModel: actualModel,
    configuredProvider,
    configuredModel,
    sourceSha: SOURCE_SHA,
    generationIds: [generationId],
    generationCount: 1,
    inputCount: 1,
    applicationCount: 1,
    appliedDecisionCount: 1,
    inputs: [{ ...baseEntry, tsMs: inputTsMs }],
    decisions: [{ ...baseEntry, tsMs: decisionTsMs, chosen: 'front_nether_portal', portalPlan: true }],
    applications: [{ ...baseEntry, tsMs: Date.parse(at(3.1)), op: 'patch', accepted: true, applied: 1 }],
  }
  const built = await buildRunArtifact({
    runId,
    root,
    overrides: { controlSocketPath: null },
    readSocket: async () => null,
    loadPolicy: async () => ({
      reason: null,
      window: { startMs: Date.parse(at(0)), endMs: Date.parse(at(10)), bounded: true },
      generation: {
        runId,
        source: 'fixture:generation',
        policyKind: 'typesafe',
        policyModel: 'typesafe-ai/jev',
        plannerMode: 'llm',
        deterministicFallbackEnabled: false,
      },
      decisions: {
        runId,
        source: 'fixture:decision-sources',
        jevCount: 1,
        fallbackCount: 0,
        otherCount: 0,
        unclassifiableCount: 0,
      },
      system2: policySystem2,
    }),
  })
  const { system2 } = built.artifact.authority
  assert.equal(system2.identityStatus, 'verified')
  assert.equal(system2.identityReason, null)
  assert.deepEqual(system2.identityIssues, [])
  assert.equal(system2.effectiveProvider, actualProvider)
  assert.equal(system2.effectiveModel, actualModel)
  assert.equal(system2.configuredProvider, configuredProvider)
  assert.equal(system2.configuredModel, configuredModel)
  assert.equal(system2.sourceSha, SOURCE_SHA)
  assert.deepEqual(system2.generationIds, [generationId])
  assert.equal(system2.generations[0].sourceSha, SOURCE_SHA)
  assert.equal(system2.generations[0].buildHash, buildHash)
  assert.equal(system2.generations[0].system2ConfiguredProvider, configuredProvider)
  assert.equal(system2.generations[0].system2ConfiguredModel, configuredModel)
  assert.equal(system2.inputs[0].generationId, generationId)
  assert.equal(system2.inputs[0].sourceSha, SOURCE_SHA)
  assert.equal(system2.inputs[0].buildHash, buildHash)
  assert.equal(system2.inputs[0].provider, actualProvider)
  assert.equal(system2.inputs[0].configuredProvider, configuredProvider)
  assert.equal(system2.decisions[0].generationId, generationId)
  assert.equal(system2.decisions[0].sourceSha, SOURCE_SHA)
  assert.equal(system2.decisions[0].buildHash, buildHash)
  assert.equal(system2.decisions[0].provider, actualProvider)
  assert.equal(system2.decisions[0].model, actualModel)
  assert.equal(system2.decisions[0].configuredProvider, configuredProvider)
  assert.equal(system2.decisions[0].chosen, 'front_nether_portal')
  assert.ok(system2.lineageEvents.some((event) => event.event === 'SYSTEM2_AUTHORITY_INPUT' && event.generationId === generationId))
}
ok('artifact preserves verified System2 identity plus exact per-generation and per-decision lineage fields')

for (const root of ROOTS) rmSync(root, { recursive: true, force: true })
console.log(`\ntest-milestone-run-artifact: ${checks} checks passed`)

// ---------------------------------------------------------------------------
// Environment CHANGES (not just config) must survive into the artifact: the
// operator's M3 rules require a change to be recorded with its reason and its
// effect on the run, and a world edit is not a config value.
// ---------------------------------------------------------------------------

{
  const dir = mkdtempSync(join(tmpdir(), 'm3-env-'))
  const withChange = join(dir, 'env-change.json')
  writeFileSync(
    withChange,
    JSON.stringify({
      values: { difficulty: 'normal', gamerules: { keep_inventory: true } },
      worldChanges: [
        {
          at: '2026-09-23T09:40Z',
          by: 'operator',
          what: 'lava poured across the portal-to-fortress route',
          reason: 'deliberate generality test',
          effectOnRuns: 'the first causal blocker becomes the crossing',
        },
      ],
    }),
  )
  const loaded = readEnvironmentFile(withChange)
  assert.equal(loaded.worldChanges.length, 1)
  assert.match(loaded.worldChanges[0].reason, /generality test/)
  assert.equal(loaded.values.difficulty, 'normal')

  // No change recorded -> no key at all (an absent record is not a claim that nothing changed).
  const withoutChange = join(dir, 'env-plain.json')
  writeFileSync(withoutChange, JSON.stringify({ values: { difficulty: 'normal' } }))
  assert.equal('worldChanges' in readEnvironmentFile(withoutChange), false)
  rmSync(dir, { recursive: true, force: true })
}
ok('an environment CHANGE is carried verbatim into the artifact, and its absence adds no key')
