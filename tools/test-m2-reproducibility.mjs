#!/usr/bin/env bun
// test-m2-reproducibility — the reproducibility harness's own acceptance.
//
// The claims this file proves (and the ones it deliberately does NOT):
//
//   A. seed + level-name derivation: deterministic, distinct per trial, valid
//      LEVEL_NAME_RE, never `world*`, never the live world's seed.
//   B. the window scanner attributes every line to the boot that owns it, using
//      the SAME rules tools/m2-gate.mjs uses (BOOT opens a run; a foreign runId
//      is never attributed), and agrees with the gate's own chain evaluator.
//   C. SPLIT: two BOOT runIds in one trial window is detected, and the split
//      chain is DIAGNOSTIC ONLY (never a pass, never a fail).
//   D. first-missing-link: my stage order agrees with the gate's `facts.missing`.
//   E. summarize(): rate = PASS/(PASS+FAIL+TIMEOUT) over live rows; SPLIT/INFRA/
//      STAGED_ONLY and every rehearsal row are excluded from the denominator.
//   F. the ledger is append-only and resumable: a finished trial is skipped, an
//      interrupted one is retried in a NEW attempt directory, and no earlier
//      attempt's evidence is overwritten.
//   G. the concurrency guards: a live campaign lock refuses a second campaign; a
//      lock whose pid is provably dead is reclaimed.
//   H. END-TO-END (rehearsal): the real staging path, a real supervisor, real
//      child processes, the real canonical gate, real teardown — for all four
//      outcomes PASS / FAIL / TIMEOUT / SPLIT, with the right row classification.
//   I. safety: no `rcon.password` material is persisted anywhere in the campaign
//      tree, the live container is refused for a rehearsal, and no world
//      directory is ever deleted.
//   J. the live path REFUSES while another resident/server is live.
//
// WHAT THIS FILE DOES NOT PROVE: that a real Minecraft world generates, that the
// real resident boots on it, or that any agent clears M2. Those need a live
// campaign (see the harness header and REPRODUCIBILITY-HARNESS.md).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PROTECTED_LEVEL_NAMES, levelNameProblems, loadCleanEnvironment, sha256Text, validateCleanEnvironment } from './clean-run-environment.mjs'
import { M2_DATAPACK_DIR, M2_DATAPACK_NAMESPACE, M2_RUN_DIR_NAME, planPrepare } from './clean-run-prepare.mjs'
import {
  M2_REQUIRED_STAGES,
  evaluateM2Gate,
  evaluatePortalChain,
  portalChainLink,
  readRunScopedM2Evidence,
} from './m2-gate.mjs'
import {
  CAMPAIGN_AMENDMENT_RECORD,
  CAMPAIGN_RECORD,
  LEDGER_NAME,
  LIVE_CONTAINER,
  TRIAL_RECORD,
  appendJsonl,
  campaignLockPath,
  campaignExitCode,
  campaignParameterMismatches,
  claimCampaignLock,
  createWindowScanner,
  deriveAttemptSeed,
  deriveSeed,
  dimensionIsOverworld,
  firstMissingChainLink,
  firstMissingLink,
  formatReport,
  parseArgs,
  parseSeedList,
  readJsonl,
  plannedTrialCount,
  releaseCampaignLock,
  summarize,
  inspectFrozenSource,
  buildBackend,
  rescanFinalBootWindow,
  trialLevelName,
  validateSeedList,
} from './m2-reproducibility.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(HERE)
const HARNESS = join(HERE, 'm2-reproducibility.mjs')
const TEMPLATE = join(HERE, 'fixtures', 'm2-repro-environment.json')
const SCRATCH = mkdtempSync(join(tmpdir(), 'm2-repro-test-'))
const FROZEN_SHA = 'a'.repeat(40)

let checks = 0
function ok(label) {
  checks += 1
  console.log(`  ok ${checks}. ${label}`)
}

function runCli(args, { env = {}, timeoutMs = 180000 } = {}) {
  const result = spawnSync(process.execPath, [HARNESS, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, M2_REPRO_LOCK: join(SCRATCH, 'machine.lock'), ...env },
  })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', signal: result.signal }
}

/** A scratch server container with a NON-SECRET server.properties. */
function scratchContainer(name) {
  const root = join(SCRATCH, name)
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, 'server.properties'),
    'level-name=world\nlevel-seed=2024\ndifficulty=normal\nspawn-monsters=true\ngamemode=survival\nlevel-type=minecraft\\:normal\nallow-nether=true\nserver-port=25565\nmotd=test-fixture-no-secrets\n',
    'utf8',
  )
  return root
}

const stamp = (seconds) => new Date(Date.UTC(2026, 8, 23, 10, 0, seconds)).toISOString()
const bootLine = (runId, extra = '') =>
  `[${stamp(0)}] BOOT pid=4242 runId=${runId} source=${FROZEN_SHA} runtime=bun runtimeVersion=1.4.2 bundle=none milestone=stone generations=1 reloads=0 contractVersion=3 schemaVersion=3 revision=1 worldEpoch=1 worldKey={"serverId":"127.0.0.1:25565","dimension":"minecraft:overworld","worldEpoch":1} frozen=false${extra}`
const inventoryLine = (items, seconds) => `[${stamp(seconds)}] INVENTORY items=${JSON.stringify(items)} pos=10,64,20`
const CHAIN = (seconds) => [
  `[${stamp(seconds)}] PORTAL_BLOCK_PLACED pos=10,64,20`,
  `[${stamp(seconds + 1)}] PORTAL_FRAME_READY blocks=10 shape=ok`,
  `[${stamp(seconds + 2)}] PORTAL_LIT pos=11,65,21 dimension=minecraft:overworld`,
  `[${stamp(seconds + 3)}] PORTAL_VERIFIED=true`,
]
const READY_INVENTORY = [
  inventoryLine({ diamond: 3, diamond_pickaxe: 1 }, 1),
  inventoryLine({ flint_and_steel: 1, obsidian: 10 }, 2),
]

function scanLines(lines, fromOffset = 0) {
  const dir = mkdtempSync(join(SCRATCH, 'scan-'))
  const path = join(dir, 'buddy.log')
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
  const scanner = createWindowScanner(fromOffset)
  scanner.pump(path)
  return { scanner, path, dir }
}

// ---------------------------------------------------------------------------
// A. derivation
// ---------------------------------------------------------------------------
{
  const a = deriveSeed('camp1', 0, 'base')
  const b = deriveSeed('camp1', 1, 'base')
  const again = deriveSeed('camp1', 0, 'base')
  assert.equal(a, again, 'the same trial must derive the same seed')
  assert.notEqual(a, b, 'different trials must derive different seeds')
  assert.notEqual(a, deriveSeed('camp2', 0, 'base'), 'different campaigns must derive different seeds')
  assert.notEqual(a, deriveSeed('camp1', 0, 'other'), 'a different seed base must derive a different seed')
  const retryA = deriveAttemptSeed({ campaignId: 'camp1', trialIndex: 0, attempt: 2, seedBase: 'base', usedSeeds: [a, b] })
  const retryAgain = deriveAttemptSeed({ campaignId: 'camp1', trialIndex: 0, attempt: 2, seedBase: 'base', usedSeeds: [a, b] })
  assert.equal(retryA, retryAgain, 'retry seed derivation must be reproducible')
  assert.notEqual(retryA, a, 'a retry must not reuse the first attempt\'s seed')
  assert.notEqual(retryA, b, 'a retry seed must not collide with another trial')
  assert.match(a, /^-?\d+$/, 'a seed must be a decimal integer string')
  const distinct = new Set(Array.from({ length: 200 }, (_, index) => deriveSeed('big', index, 'big')))
  assert.equal(distinct.size, 200, '200 trials must produce 200 distinct seeds')
  assert.equal(distinct.has('0'), false)
  assert.equal(distinct.has('2024'), false, "the live world's seed must never be derived")
  ok('A1. first and retry seeds are deterministic, distinct, decimal, and never 0 or the live seed 2024')

  const names = Array.from({ length: 200 }, (_, index) => trialLevelName('camp1', index, 'm2rep'))
  assert.equal(new Set(names).size, 200, 'every trial needs its own level name')
  assert.notEqual(trialLevelName('camp1', 7, 'm2rep', 1), trialLevelName('camp1', 7, 'm2rep', 2), 'every retry needs a fresh level name')
  for (const name of names) {
    assert.equal(levelNameProblems(name).length, 0, `levelNameProblems(${name}) must be empty`)
    assert.ok(name.length <= 32, `${name} must fit the 32 char level-name limit`)
    assert.equal(/^world/.test(name), false, `${name} must not be a world* name`)
    assert.equal(PROTECTED_LEVEL_NAMES.includes(name), false, `${name} must not be protected`)
  }
  assert.equal(trialLevelName('camp1', 7, 'm2rep'), trialLevelName('camp1', 7, 'm2rep'), 'level names must be deterministic')
  ok('A2. trialLevelName is deterministic, unique per trial, LEVEL_NAME_RE-valid, never world*/protected')
}

// ---------------------------------------------------------------------------
// A3. explicit seed-list contract and independent M2 environment staging
// ---------------------------------------------------------------------------
{
  assert.deepEqual(parseSeedList('11\n-12\n\n'), ['11', '-12'])
  assert.deepEqual(validateSeedList(['11', '-12'], 2), [])
  assert.ok(validateSeedList(['11'], 2).some((problem) => problem.includes('seed_list_length')))
  assert.ok(validateSeedList(['11', '11'], 2).some((problem) => problem.includes('seed_duplicate')))
  assert.ok(validateSeedList(['11', '2024'], 2).some((problem) => problem.includes('previous_world_seed')))
  assert.ok(validateSeedList(['01', '12'], 2).some((problem) => problem.includes('not_canonical_integer')))

  const loaded = loadCleanEnvironment(TEMPLATE)
  assert.ok(loaded.document, 'the independent M2 descriptor must load')
  const descriptor = loaded.document
  assert.equal(descriptor.cleanRun.milestone, 'M2')
  assert.equal(descriptor.values.difficulty, 'peaceful')
  assert.equal(descriptor.values.mobSpawning, true)
  assert.equal(descriptor.values.gamerules.spawn_mobs, true)
  assert.equal(descriptor.values.gamerules.spawn_monsters, true)
  assert.deepEqual(descriptor.assists.grantedItems, [])
  assert.deepEqual(descriptor.assists.summonedMobs, [])
  const pinned = structuredClone(descriptor)
  pinned.values.sourceSha = FROZEN_SHA
  pinned.cleanRun.sourceSha.state = 'FROZEN'
  const noWorlds = join(SCRATCH, 'no-worlds')
  assert.equal(validateCleanEnvironment(pinned, { expectedMilestone: 'M2', worldContainer: noWorlds }).status, 'CLEAN')
  assert.equal(validateCleanEnvironment(pinned, { expectedMilestone: 'M3', worldContainer: noWorlds }).status, 'NOT_CLEAN', 'the M2 peaceful contract must not validate as M3')

  const root = scratchContainer('m2-descriptor')
  const sharedProperties = join(root, 'server.properties')
  const before = readFileSync(sharedProperties)
  const beforeSha = sha256Text(before)
  const plan = planPrepare({
    descriptorPath: TEMPLATE,
    serverRoot: root,
    sourceSha: FROZEN_SHA,
    seed: '-7331849912',
    levelName: 'm2-policy-test',
    expectedMilestone: 'M2',
    overwriteProperties: false,
  })
  assert.equal(plan.status, 'PLANNED')
  assert.equal(plan.check.status, 'CLEAN')
  assert.equal(plan.launchIdentity, null, 'M2 staging does not require the M3 Leaf/JVM startup-attestation identity')
  assert.equal(plan.runDir, join(root, M2_RUN_DIR_NAME))
  assert.ok(plan.files.some((file) => file.path.includes(`${M2_DATAPACK_DIR}/data/${M2_DATAPACK_NAMESPACE}/function/set_gamerules.mcfunction`)))
  assert.ok(!plan.actions.some((action) => action.path === sharedProperties), 'M2 staging must not plan a shared properties write')
  const cleanProperties = plan.files.find((file) => file.path === join(plan.runDir, 'server.properties.clean'))
  assert.ok(cleanProperties)
  assert.match(cleanProperties.content, /level-seed=-7331849912/)
  assert.match(cleanProperties.content, /difficulty=peaceful/)
  assert.equal(sha256Text(readFileSync(sharedProperties)), beforeSha, 'planning cannot mutate shared server.properties')
  const defaultMilestone = planPrepare({ descriptorPath: TEMPLATE, serverRoot: root, sourceSha: FROZEN_SHA, seed: '-7331849913', levelName: 'm2-policy-default-must-refuse' })
  assert.equal(defaultMilestone.status, 'REFUSED', 'the M3 default must refuse an M2 descriptor unless the caller explicitly selects M2')
  const overwrite = planPrepare({ descriptorPath: TEMPLATE, serverRoot: root, sourceSha: FROZEN_SHA, seed: '-7331849913', levelName: 'm2-policy-test2', expectedMilestone: 'M2', overwriteProperties: true })
  assert.equal(overwrite.status, 'REFUSED', 'M2 must refuse a shared properties overwrite request')
  assert.ok(overwrite.refusals.some((entry) => entry.reason.includes('m2_shared_properties_mutation_forbidden')))
  assert.equal(sha256Text(readFileSync(sharedProperties)), beforeSha)
  ok('A3. seed lists are exact-length and unique; the separate M2 descriptor keeps peaceful/default mob gamerules and never mutates shared properties')
}

// ---------------------------------------------------------------------------
// A4. source-tree pinning and the child-only per-trial config binding
// ---------------------------------------------------------------------------
{
  const tree = join(SCRATCH, 'frozen-source')
  const driverDir = join(tree, 'buddy-driver')
  mkdirSync(driverDir, { recursive: true })
  writeFileSync(join(driverDir, 'agent-runner.mts'), 'export {}\n', 'utf8')
  const git = (args) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: tree })
    assert.equal(result.exitCode, 0, `git ${args.join(' ')}: ${result.stderr.toString()}`)
    return result.stdout.toString().trim()
  }
  git(['init', '-q'])
  git(['config', 'user.name', 'M2 Harness Test'])
  git(['config', 'user.email', 'm2-harness-test@example.invalid'])
  git(['add', 'buddy-driver/agent-runner.mts'])
  git(['commit', '-q', '-m', 'fixture'])
  const sha = git(['rev-parse', 'HEAD'])
  const clean = inspectFrozenSource({ frozenTree: tree, driverDir, frozenSha: sha })
  assert.deepEqual(clean.blockers, [])
  assert.equal(clean.observation.dirtyTree, false)
  const outside = inspectFrozenSource({ frozenTree: tree, driverDir: join(SCRATCH, 'outside-driver'), frozenSha: sha })
  assert.ok(outside.blockers.some((blocker) => blocker.includes('driver_dir_outside_frozen_tree')))
  writeFileSync(join(tree, 'untracked.ts'), 'dirty\n', 'utf8')
  const dirty = inspectFrozenSource({ frozenTree: tree, driverDir, frozenSha: sha })
  assert.ok(dirty.blockers.some((blocker) => blocker.includes('frozen_tree_dirty')))

  const serverRoot = scratchContainer('backend-path')
  const propertiesPath = join(serverRoot, M2_RUN_DIR_NAME, 'server.properties.clean')
  const sharedPropertiesHash = sha256Text(readFileSync(join(serverRoot, 'server.properties')))
  const backend = buildBackend({
    rehearse: false,
    driverDir: join(SCRATCH, 'backend-driver', 'buddy-driver'),
    frozenTree: tree,
    serverRoot,
    maxRestarts: 0,
    botUsername: 'AI_M2_TEST',
  }, {
    attemptDir: join(SCRATCH, 'backend-attempt'),
    trialDir: join(SCRATCH, 'backend-trial'),
    levelName: 'm2-backend-path',
    levelSeed: '-7711',
    serverPropertiesPath: propertiesPath,
  })
  const configArg = backend.serverCmd.indexOf('--config')
  assert.ok(configArg >= 0)
  assert.equal(backend.serverCmd[configArg + 1], propertiesPath, 'server receives the staged properties path actually hashed in identity')
  assert.equal(backend.residentEnv.BUDDY_SERVER_PROPERTIES_PATH, propertiesPath, 'only the trial resident subprocess gets the seed-attestation path')
  assert.equal(backend.serverEnv.BUDDY_SERVER_PROPERTIES_PATH, undefined)
  assert.equal(sha256Text(readFileSync(join(serverRoot, 'server.properties'))), sharedPropertiesHash)
  ok('A4. live measurement refuses dirty/out-of-tree source and binds the server plus child runner to one staged properties path')
}

// ---------------------------------------------------------------------------
// B. window scanner: boot attribution + the gate's own chain evaluator
// ---------------------------------------------------------------------------
{
  const { scanner } = scanLines([
    bootLine('run-a'),
    ...READY_INVENTORY,
    `[${stamp(3)}] HEARTBEAT pos=0,64,0 health=20 running=true rung=diamond_pickaxe inv={}`,
    `[${stamp(4)}] M2_SNAPSHOT marker=PORTAL_LIT runId=run-other`,
    ...CHAIN(5),
    `[${stamp(9)}] HEARTBEAT pos=11,65,21 health=20 running=true rung=nether_portal inv={"obsidian":10}`,
  ])
  assert.deepEqual(scanner.distinctRunIds(), ['run-a'], 'a foreign runId-bearing marker must not open a run')
  assert.deepEqual(scanner.foreignRunIds(), ['run-other'], 'the foreign run must be recorded, never attributed')
  assert.equal(scanner.boots().length, 1)
  assert.equal(scanner.boots()[0].source, FROZEN_SHA)
  assert.equal(scanner.lastRung().value, 'nether_portal')
  const { link, complete } = scanner.chain('run-a')
  assert.equal(link.built, 'PASS')
  assert.equal(link.lit, 'PASS')
  assert.equal(link.verified, 'PASS')
  assert.equal(link.ordered, true)
  assert.equal(link.overworld, true)
  assert.equal(link.blocks, 10)
  assert.equal(link.shape, 'ok')
  assert.equal(complete, true)

  // The gate's own chain evaluator must agree with the scanner's projection.
  const events = scanner.run('run-a').events
  const direct = portalChainLink({ name: 'window', chain: evaluatePortalChain(events), failure: null })
  assert.deepEqual(link, direct, 'the scanner must project the gate chain unchanged')
  ok('B1. the scanner attributes lines to the owning BOOT, records foreign runs, and matches the gate chain')

  // dimension normalisation: the stage condition the gate applies
  assert.equal(dimensionIsOverworld('minecraft:overworld'), true)
  assert.equal(dimensionIsOverworld('overworld'), true)
  assert.equal(dimensionIsOverworld('Overworld'), true)
  assert.equal(dimensionIsOverworld('minecraft:the_nether'), false)
  assert.equal(dimensionIsOverworld(null), false)

  // an incremental pump must not lose or duplicate a line split across reads
  const dir = mkdtempSync(join(SCRATCH, 'pump-'))
  const path = join(dir, 'buddy.log')
  // Write a partial final line (no newline yet): it must be buffered, not parsed.
  writeFileSync(path, `${bootLine('run-p')}\n${inventoryLine({ diamond: 3 }, 1)}`, 'utf8')
  const incremental = createWindowScanner(0)
  incremental.pump(path)
  assert.equal(incremental.boots().length, 1)
  assert.equal((incremental.run('run-p').inventories ?? []).length, 0, 'an unterminated line must not be parsed yet')
  appendFileSync(path, `\n${inventoryLine({ diamond_pickaxe: 1 }, 2)}\n`)
  incremental.pump(path)
  assert.equal(incremental.run('run-p').inventories.length, 2, 'the buffered line must be parsed exactly once when it completes')
  ok('B2. dimensionIsOverworld matches the gate stage condition and an incremental pump loses no line')

  const finalPath = join(dir, 'final-buddy.log')
  writeFileSync(finalPath, `${bootLine('run-before-stop')}\n`, 'utf8')
  const finalScanner = createWindowScanner(0)
  finalScanner.pump(finalPath)
  appendFileSync(finalPath, `${bootLine('run-during-stop', ' worldEpoch=2')}\n`, 'utf8')
  const final = rescanFinalBootWindow(finalScanner, finalPath, FROZEN_SHA)
  assert.deepEqual(final.runIds, ['run-before-stop', 'run-during-stop'])
  assert.equal(final.split, true, 'a distinct BOOT appended at shutdown must split the window')
  assert.deepEqual(final.sourceMismatches, [], 'every exact-source BOOT is accepted')
  const missingSource = createWindowScanner(0)
  writeFileSync(finalPath, `${bootLine('run-no-source').replace(`source=${FROZEN_SHA} `, '')}\n`, 'utf8')
  const noSource = rescanFinalBootWindow(missingSource, finalPath, FROZEN_SHA)
  assert.equal(noSource.sourceMismatches[0].source, null, 'missing source is a mismatch, not an allowed unknown')
  ok('B3. the final post-shutdown scan detects a late split BOOT and requires every BOOT source to equal the frozen SHA')
}

// ---------------------------------------------------------------------------
// C. SPLIT detection and its diagnostic-only chain
// ---------------------------------------------------------------------------
{
  const { scanner } = scanLines([
    bootLine('run-boot1'),
    ...READY_INVENTORY,
    ...CHAIN(3).slice(0, 2),
    bootLine('run-boot2', ' generations=2'),
    ...READY_INVENTORY,
    ...CHAIN(8),
  ])
  const runIds = scanner.distinctRunIds()
  assert.deepEqual(runIds, ['run-boot1', 'run-boot2'], 'a restart with a new runId must be visible as two boots')
  assert.equal(scanner.primaryRunId(), 'run-boot1')
  assert.equal(scanner.lastRunId(), 'run-boot2')
  assert.equal(scanner.chain('run-boot1').complete, false, 'boot1 alone must not be a complete chain')
  assert.equal(scanner.chain('run-boot2').complete, true, 'boot2 has a complete chain of its own')
  ok('C1. two BOOT runIds in one window are detected, and each boot is judged on its OWN evidence')
}

// ---------------------------------------------------------------------------
// D. first-missing-link agrees with the gate
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(SCRATCH, 'missing-'))
  const snapshotDir = join(dir, 'snap')
  mkdirSync(snapshotDir)
  const runId = 'run-missing'
  writeFileSync(join(dir, 'buddy.log'), `${[bootLine(runId), ...READY_INVENTORY, ...CHAIN(3).slice(0, 2)].join('\n')}\n`, 'utf8')
  writeFileSync(join(snapshotDir, `m2-snapshot-${runId}.json`), JSON.stringify({ record: 'm2-snapshot', runId, bootSourceSha: FROZEN_SHA, initialInventory: {}, markers: [], inventory: {} }))
  const evidence = await readRunScopedM2Evidence(runId, { logPath: join(dir, 'buddy.log'), snapshotDir })
  const verdict = evaluateM2Gate({ expectedRunId: runId, evidence, policy: null })
  const mine = firstMissingLink(verdict.conditions)
  assert.deepEqual(mine, verdict.facts.missing[0], 'my first missing link must equal the gate\u2019s first missing stage')
  assert.equal(mine, 'portal_lit', 'placed + shape=ok frame but no PORTAL_LIT yet')
  const link = firstMissingChainLink(verdict.facts.chain)
  assert.deepEqual(link, { link: 'lit', state: 'UNKNOWN' })
  assert.deepEqual(
    M2_REQUIRED_STAGES,
    ['diamond_ready', 'portal_materials_ready', 'portal_built', 'portal_lit'],
    'the stage order this file reports must be the contract order',
  )
  ok('D1. first-missing-link and first-missing-chain-link agree with the gate verdict on the same evidence')
}

// ---------------------------------------------------------------------------
// E. summarize(): the rate and what is excluded from it
// ---------------------------------------------------------------------------
{
  const rows = [
    { record: CAMPAIGN_RECORD, trials: 6 },
    { record: TRIAL_RECORD, terminal: true, evidenceClass: 'live', trialIndex: 0, attempt: 1, status: 'PASS', countable: true, firstMissingLink: null, run: { runId: 'r0', boots: [{}] }, identity: { levelName: 'l0' } },
    { record: TRIAL_RECORD, terminal: true, evidenceClass: 'live', trialIndex: 1, attempt: 1, status: 'PASS', countable: true, firstMissingLink: null, run: { runId: 'r1', boots: [{}] }, identity: { levelName: 'l1' } },
    { record: TRIAL_RECORD, terminal: true, evidenceClass: 'live', trialIndex: 2, attempt: 1, status: 'FAIL', countable: true, failureKind: 'capability', firstMissingLink: 'portal_built', run: { runId: 'r2', boots: [{}] }, identity: { levelName: 'l2' } },
    { record: TRIAL_RECORD, terminal: true, evidenceClass: 'live', trialIndex: 3, attempt: 1, status: 'TIMEOUT', countable: true, failureKind: 'deadline', firstMissingLink: 'diamond_ready', run: { runId: 'r3', boots: [{}] }, identity: { levelName: 'l3' } },
    { record: TRIAL_RECORD, terminal: true, evidenceClass: 'live', trialIndex: 4, attempt: 1, status: 'SPLIT', countable: false, failureKind: 'split_boots', firstMissingLink: 'portal_lit', run: { runId: 'r4', boots: [{}, {}] }, identity: { levelName: 'l4' } },
    { record: TRIAL_RECORD, terminal: true, evidenceClass: 'live', trialIndex: 5, attempt: 1, status: 'INFRA', countable: false, failureKind: 'server_not_ready', run: {}, identity: { levelName: 'l5' } },
    { record: TRIAL_RECORD, terminal: true, evidenceClass: 'rehearsal', trialIndex: 0, attempt: 1, status: 'PASS', countable: true, run: { runId: 'stub', boots: [{}] } },
    { record: TRIAL_RECORD, terminal: false, trialIndex: 6, attempt: 1 },
  ]
  const summary = summarize('c', rows)
  assert.equal(summary.rate.successes, 2)
  assert.equal(summary.rate.countable, 4, 'countable = PASS + FAIL + TIMEOUT over live rows only')
  assert.equal(summary.rate.value, 0.5)
  assert.equal(summary.statusCounts.SPLIT, 1)
  assert.equal(summary.uncountable.SPLIT.count, 1)
  assert.equal(summary.uncountable.INFRA.count, 1)
  assert.equal(summary.rows.length, 6, 'the live table must not contain the rehearsal row')
  assert.equal(summary.rehearsalRows.length, 1)
  assert.equal(summary.trials.rehearsal, 1)
  assert.equal(summary.trials.countable, 4)
  assert.equal(summary.trials.nonTerminalRecords, 1)
  assert.equal(summary.bottleneck.cleared, 2, 'the bottleneck histogram must count cleared trials')
  assert.equal(summary.bottleneck.portal_built, 1, 'and must say WHICH capability was the bottleneck')
  assert.equal(summary.rows.find((row) => row.trialIndex === 2).firstUnmetGateStage, 'portal_built')
  assert.equal(summary.rows.find((row) => row.trialIndex === 2).causalBlocker.status, 'UNKNOWN', 'an unmet gate stage is not a cause without a run-scoped failure event')
  assert.equal(summary.bottleneck.diamond_ready, 1)
  assert.equal(summary.bottleneck.portal_lit, undefined, 'a SPLIT trial must not enter the bottleneck histogram')
  assert.deepEqual(summary.failureKinds, { capability: 1, deadline: 1 }, 'SPLIT is not a failure kind of the countable set')

  const text = formatReport(summary)
  assert.match(text, /successes \/ countable = 2 \/ 4 = 0\.5000/)
  assert.match(text, /REPRODUCIBILITY BOTTLENECK/)
  assert.match(text, /portal_built\s+1/)
  assert.match(text, /firstUnmetGateStage is a stage label, not a causal blocker/)
  assert.match(text, /SPLIT and INFRA trials are excluded from the denominator/)
  assert.match(text, /rehearsal rows \(evidenceClass=rehearsal, NEVER counted\)/)

  const empty = summarize('c2', [{ record: CAMPAIGN_RECORD, trials: 3 }])
  assert.equal(empty.rate.value, null, 'no countable trial must be UNDEFINED, never 0 or 1')
  assert.match(formatReport(empty), /UNDEFINED \(no countable trial\)/)
  assert.equal(campaignExitCode(empty), 0, 'no countable outcome is UNDEFINED, not a zero rate')
  const allFailed = summarize('c3', [
    { record: CAMPAIGN_RECORD, trials: 1 },
    { record: TRIAL_RECORD, terminal: true, evidenceClass: 'live', status: 'FAIL' },
  ])
  assert.equal(campaignExitCode(allFailed), 1, 'a measured zero-pass campaign must exit nonzero')
  assert.deepEqual(campaignParameterMismatches({ seedBase: 'a' }, { seedBase: 'b' }), [
    'campaign_parameter_changed:seedBase:pinned="a":requested="b"',
  ])
  assert.equal(plannedTrialCount([
    { record: CAMPAIGN_RECORD, trials: 1 },
    { record: CAMPAIGN_AMENDMENT_RECORD, trials: 3 },
  ]), 3, 'the latest append-only amendment supplies the planned trial count')
  ok('E1. the rate counts PASS/(PASS+FAIL+TIMEOUT) over live rows; SPLIT/INFRA/rehearsal stay out of the denominator')
  ok('E2. the report names the first-missing-link bottleneck and says UNDEFINED when nothing is countable')
}

// ---------------------------------------------------------------------------
// F. ledger: append-only, resumable, never overwriting an attempt
// ---------------------------------------------------------------------------
{
  const root = scratchContainer('ledger')
  const trialsDir = join(root, 'runs')
  const args = [
    '--campaign', 'ledger', '--trials', '1', '--rehearse', '--rehearse-outcome', 'pass',
    '--server-root', root, '--trials-dir', trialsDir,
    '--deadline-ms', '20000', '--poll-ms', '500', '--settle-ms', '1500',
    '--boot-timeout-ms', '20000', '--server-ready-ms', '20000',
  ]
  const first = runCli(args)
  assert.equal(first.code, 0, `first rehearsal exit=${first.code} stderr=${first.stderr.slice(0, 400)}`)
  const ledgerPath = join(trialsDir, LEDGER_NAME)
  const afterFirst = readFileSync(ledgerPath, 'utf8')
  const firstRows = readJsonl(ledgerPath)
  assert.ok(firstRows.length >= 3, 'campaign + planned + terminal records')
  const attempt1 = join(trialsDir, 'trial-000', 'attempt-1')
  const outcome1 = readFileSync(join(attempt1, 'outcome.json'), 'utf8')
  const identity1 = readFileSync(join(attempt1, 'identity.json'), 'utf8')
  assert.equal(JSON.parse(outcome1).status, 'PASS')

  // a second run: the finished trial is skipped, the ledger only grows
  const second = runCli(args)
  assert.equal(second.code, 0)
  assert.match(second.stdout, /SKIP trial 0 already terminal \(PASS\)/)
  const afterSecond = readFileSync(ledgerPath, 'utf8')
  assert.ok(afterSecond.startsWith(afterFirst), 'the ledger must be append-only: every earlier byte is preserved')
  assert.equal(existsSync(join(trialsDir, 'trial-000', 'attempt-2')), false, 'a terminal trial must not be re-run')
  assert.equal(readFileSync(join(attempt1, 'outcome.json'), 'utf8'), outcome1, 'another trial\u2019s evidence must never be overwritten')
  assert.equal(readFileSync(join(attempt1, 'identity.json'), 'utf8'), identity1)

  const ledgerBeforeMismatch = readFileSync(ledgerPath, 'utf8')
  const changedSeedBase = runCli([...args, '--seed-base', 'different-base'])
  assert.equal(changedSeedBase.code, 1, 'resuming with another seed derivation must refuse')
  assert.match(changedSeedBase.stderr, /campaign_parameter_changed:seedBase/)
  assert.equal(readFileSync(ledgerPath, 'utf8'), ledgerBeforeMismatch, 'a campaign identity mismatch must not mutate its ledger')

  // an interrupted trial (a non-terminal record) is retried in a NEW attempt dir
  const resumed = JSON.parse(identity1)
  const interruptedTrialName = trialLevelName('ledger', 1, 'm2rep', 1)
  const interruptedTrialSeed = deriveSeed('ledger', 1, 'ledger')
  const interruptedAttemptDir = join(trialsDir, 'trial-001', 'attempt-1')
  mkdirSync(interruptedAttemptDir, { recursive: true })
  writeFileSync(join(interruptedAttemptDir, 'identity.json'), JSON.stringify({ ...resumed, trialIndex: 1, attempt: 1, levelName: interruptedTrialName, levelSeed: interruptedTrialSeed }), 'utf8')
  const interruptedWorld = join(root, interruptedTrialName)
  mkdirSync(interruptedWorld, { recursive: true })
  writeFileSync(join(interruptedWorld, 'level.dat'), 'generated before interruption\n', 'utf8')
  appendJsonl(ledgerPath, {
    record: TRIAL_RECORD, schemaVersion: 1, campaignId: 'ledger', evidenceClass: 'rehearsal',
    trialIndex: 1, attempt: 1, terminal: false, status: 'PLANNED', at: new Date().toISOString(),
    identity: { ...resumed, trialIndex: 1, attempt: 1, levelName: interruptedTrialName, levelSeed: interruptedTrialSeed },
  })
  const third = runCli([...args, '--trials', '2'])
  assert.equal(third.code, 0)
  assert.match(third.stdout, /RESUME .*interrupted record/)
  assert.match(third.stdout, /nothing is overwritten/)
  assert.ok(existsSync(join(trialsDir, 'trial-001', 'attempt-1')), 'the interrupted trial must be attempted')
  const rowsThird = readJsonl(ledgerPath)
  const terminalOne = rowsThird.filter((row) => row.record === TRIAL_RECORD && row.trialIndex === 1 && row.terminal === true)
  assert.equal(terminalOne.length, 1, 'exactly one terminal row for trial 1')
  assert.equal(terminalOne[0].status, 'PASS')
  assert.equal(readFileSync(join(attempt1, 'outcome.json'), 'utf8'), outcome1, 'trial 0 evidence still untouched after the resume')
  const attempt2 = join(trialsDir, 'trial-001', 'attempt-2')
  const retried = JSON.parse(readFileSync(join(attempt2, 'outcome.json'), 'utf8'))
  assert.equal(retried.status, 'PASS', 'the retry must stage and measure a fresh world')
  assert.notEqual(retried.identity.levelName, interruptedTrialName, 'the retry cannot reuse a generated level name')
  assert.notEqual(retried.identity.levelSeed, interruptedTrialSeed, 'the retry cannot reuse the interrupted seed')
  assert.equal(existsSync(join(interruptedWorld, 'level.dat')), true, 'the interrupted world remains preserved')
  ok('F1. the ledger is append-only; a finished trial is skipped and never overwritten')
  ok('F2. an interrupted trial is retried in a new attempt directory and reported on resume')

  // a stage-only row is recorded but never counted
  const summary = JSON.parse(readFileSync(join(trialsDir, 'summary.json'), 'utf8'))
  assert.equal(summary.trials.rehearsal, 2)
  assert.equal(summary.trials.planned, 2, 'the expansion is recorded as an append-only amendment')
  assert.equal(readJsonl(ledgerPath).filter((row) => row.record === CAMPAIGN_AMENDMENT_RECORD).length, 1)
  assert.equal(summary.rate.countable, 0, 'a rehearsal campaign can never produce a countable trial')
  const shrink = runCli(args)
  assert.equal(shrink.code, 1, 'a pinned campaign cannot silently shrink')
  assert.match(shrink.stderr, /campaign_trial_count_cannot_shrink/)
}

// ---------------------------------------------------------------------------
// G. locks
// ---------------------------------------------------------------------------
{
  const path = join(SCRATCH, 'lock-test.lock')
  const held = Bun.spawn(['sleep', '30'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  writeFileSync(path, `${JSON.stringify({ pid: held.pid, campaignId: 'holder' })}\n`)
  const refused = claimCampaignLock(path, { campaignId: 'other', trials: 1, frozenSha: FROZEN_SHA })
  assert.equal(refused.ok, false, 'a live holder must refuse a second campaign')
  assert.match(refused.reason, /another campaign is live/)
  assert.equal(existsSync(path), true, 'a refused claim must leave the holder\u2019s lock intact')
  process.kill(held.pid, 'SIGTERM')
  await held.exited
  const reclaimed = claimCampaignLock(path, { campaignId: 'other', trials: 1, frozenSha: FROZEN_SHA })
  assert.equal(reclaimed.ok, true, 'a lock whose pid is provably dead must be reclaimed')
  assert.equal(reclaimed.reclaimed, true)
  releaseCampaignLock(reclaimed.path)
  assert.equal(existsSync(path), false, 'release renames the lock away')
  assert.equal(campaignLockPath().endsWith('.campaign.lock'), true, 'the default lock is the machine-global one')
  ok('G1. a live campaign lock refuses a second campaign; a dead holder\u2019s lock is reclaimed; release is a rename')
}

// ---------------------------------------------------------------------------
// H. END-TO-END rehearsal for terminal outcomes and shutdown/source edge cases
// ---------------------------------------------------------------------------
{
  const expect = {
    pass: { status: 'PASS', countable: true, firstMissing: null, boots: 1 },
    fail: { status: 'FAIL', countable: true, firstMissing: 'portal_built', boots: 1 },
    timeout: { status: 'TIMEOUT', countable: true, firstMissing: 'portal_built', boots: 1 },
    split: { status: 'SPLIT', countable: false, firstMissing: 'portal_built', boots: 2 },
    'tail-boot': { status: 'SPLIT', countable: false, firstMissing: null, boots: 2 },
    'wrong-source': { status: 'INFRA', countable: false, firstMissing: null, boots: 1 },
  }
  for (const [outcome, wanted] of Object.entries(expect)) {
    const root = scratchContainer(`e2e-${outcome}`)
    const trialsDir = join(root, 'runs')
    const deadline = outcome === 'timeout' ? '9000' : '30000'
    const result = runCli([
      '--campaign', `e2e-${outcome}`, '--trials', '1', '--rehearse', '--rehearse-outcome', outcome,
      '--server-root', root, '--trials-dir', trialsDir,
      '--deadline-ms', deadline, '--poll-ms', '400', '--settle-ms', '1200',
      '--boot-timeout-ms', '20000', '--server-ready-ms', '20000',
    ])
    assert.equal(result.code, 0, `${outcome}: exit=${result.code} stderr=${result.stderr.slice(0, 400)}`)
    const attemptDir = join(trialsDir, 'trial-000', 'attempt-1')
    const row = JSON.parse(readFileSync(join(attemptDir, 'outcome.json'), 'utf8'))
    assert.equal(row.status, wanted.status, `${outcome}: status`)
    assert.equal(row.countable, wanted.countable, `${outcome}: countable`)
    assert.equal(row.firstMissingLink ?? null, wanted.firstMissing, `${outcome}: first missing link`)
    assert.equal(row.firstUnmetGateStage ?? null, wanted.firstMissing, `${outcome}: first unmet gate stage`)
    assert.equal(row.run.boots.length, wanted.boots, `${outcome}: boots`)
    assert.ok(row.run.boots.every((boot) => boot.runId.startsWith('run-')), `${outcome}: every boot is run-scoped`)
    assert.equal(typeof row.evidence.residentWindow.sha256, 'string', `${outcome}: the window excerpt is hashed`)
    assert.ok(row.evidence.residentWindow.bytes > 0, `${outcome}: the window excerpt is not empty`)
    assert.equal(row.teardown.worldsPreserved.worldDirStillPresent, true, `${outcome}: the world directory must survive`)
    assert.equal(row.teardown.worldsPreserved.note.includes('no world directory was deleted'), true)
    assert.equal(row.identity.levelName.includes('e2e'), true, `${outcome}: identity names the trial world`)
    assert.equal(row.identity.dirtyTree, null, `${outcome}: rehearsal is not a clean-source live measurement`)
    assert.equal(row.identity.serverProperties.path, join(root, M2_RUN_DIR_NAME, 'server.properties.clean'))
    assert.match(row.identity.serverProperties.sha256, /^[0-9a-f]{64}$/)
    assert.equal(row.run.finalBootRescannedAfterShutdown, true, `${outcome}: final BOOT state is recorded after shutdown`)
    assert.equal(readFileSync(join(root, 'server.properties'), 'utf8').includes('level-seed=2024'), true, `${outcome}: shared properties remain unchanged`)
    if (outcome === 'fail') {
      assert.equal(row.causalBlocker.status, 'OBSERVED')
      assert.equal(row.causalBlocker.value, 'portal_frame_shape_bad')
      assert.equal(row.causalBlocker.runId, 'run-m2repstub-a')
      assert.equal(row.causalBlocker.event, 'PORTAL_FRAME_READY')
      assert.match(row.causalBlocker.evidenceLine, /PORTAL_FRAME_READY blocks=7 shape=bad/)
    } else if (outcome !== 'fail') {
      assert.equal(row.causalBlocker.status, 'UNKNOWN', `${outcome}: gate stage alone must not claim a cause`)
    }
    if (outcome === 'pass') {
      assert.equal(row.gate.status, 'PASS')
      assert.match(row.chain.line, /^m2_chain: /)
      assert.match(row.chain.line, /built=PASS lit=PASS verified=PASS ordered=true/)
      assert.match(row.chain.line, /dimension=minecraft:overworld/)
      assert.match(row.chain.line, /blocks=10 shape=ok/)
      assert.deepEqual(row.teardown.quarantine.moved.map((entry) => entry.rel).sort(), ['buddy.log', 'data/resident', 'logs'])
      assert.equal(row.teardown.hostLockReleased, true)
      assert.equal(row.teardown.server.steps.some((step) => step.step === 'graceful-exit'), true, 'the server must stop on the stdin stop command')
      const gateText = readFileSync(join(attemptDir, 'evidence', 'm2-gate.txt'), 'utf8')
      assert.match(gateText, /M2_RUN_RESULT status=PASS/)
      assert.match(gateText, /m2_chain: source=snapshot built=PASS/)
      assert.equal(existsSync(join(attemptDir, 'evidence', 'm2-snapshot-run-m2repstub-a.json')), true, 'the run-scoped snapshot is copied into the trial evidence')
    }
    if (outcome === 'fail') {
      assert.equal(row.gate.status, 'FAIL')
      assert.equal(row.failureKind, 'capability')
      assert.match(row.chain.line, /built=FAIL/)
      assert.deepEqual(row.chain.firstMissingChainLink, { link: 'built', state: 'FAIL' })
    }
    if (outcome === 'timeout') {
      assert.equal(row.failureKind, 'deadline')
      assert.equal(row.lastObservedRung.value, 'diamond_pickaxe', 'a TIMEOUT must carry the last observed rung')
      assert.equal(typeof row.lastObservedRung.line, 'string', 'the rung must be quoted from a real log line')
      assert.match(row.lastObservedRung.line, /rung=diamond_pickaxe/)
    }
    if (outcome === 'split') {
      assert.equal(row.failureKind, 'split_boots')
      assert.equal(row.diagnosticOnly.note.includes('DIAGNOSTIC ONLY'), true)
      assert.deepEqual(row.diagnosticOnly.runIds, ['run-m2repstub-a', 'run-m2repstub-b'])
      assert.equal(row.diagnosticOnly.perBootChain[1].verified, 'PASS', 'the second boot DID reach the chain: the diagnostic shows it without counting it')
      assert.equal(row.gate.status, 'UNKNOWN', 'the SPLIT row is never upgraded to PASS by the diagnostic')
    }
    if (outcome === 'tail-boot') {
      assert.deepEqual(row.run.distinctRunIds, ['run-m2repstub-a', 'run-tailboot-stub'])
      assert.equal(row.diagnosticOnly.runIds.includes('run-tailboot-stub'), true, 'a shutdown BOOT remains diagnostic-only')
    }
    if (outcome === 'wrong-source') {
      assert.equal(row.failureKind, 'boot_source_mismatch')
      assert.ok(row.run.bootSourceProblems.some((entry) => entry.source === 'deadbeef'))
    }
    ok(`H.${outcome}. the real staging + supervisor + gate + teardown path classifies ${outcome} as ${wanted.status} (countable=${wanted.countable})`)
  }
}

// ---------------------------------------------------------------------------
// I. safety: secrets, live container, worlds
// ---------------------------------------------------------------------------
{
  const root = scratchContainer('safety')
  const trialsDir = join(root, 'runs')
  runCli([
    '--campaign', 'safety', '--trials', '1', '--rehearse', '--rehearse-outcome', 'pass',
    '--server-root', root, '--trials-dir', trialsDir, '--deadline-ms', '20000', '--poll-ms', '400', '--settle-ms', '1200',
  ])
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        const text = readFileSync(full, 'utf8')
        if (/rcon\.password\s*[=:]/i.test(text)) offenders.push(full)
      }
    }
  }
  walk(trialsDir)
  assert.deepEqual(offenders, [], `no rcon material may be persisted: ${offenders.join(', ')}`)
  const identity = JSON.parse(readFileSync(join(trialsDir, 'trial-000', 'attempt-1', 'identity.json'), 'utf8'))
  assert.equal(JSON.stringify(identity).includes('"content"'), false, 'the stager\u2019s file contents must never be persisted')
  assert.equal(identity.descriptor.templateSha256, sha256Text(readFileSync(TEMPLATE, 'utf8')), 'the identity must carry the descriptor template hash')
  assert.equal(identity.descriptor.resolvedSha256.length, 64, 'the resolved descriptor must be hashed per trial')
  assert.equal(identity.descriptor.cleanliness, 'CLEAN')
  assert.equal(identity.serverConfig.gameruleCount, 58, 'the identity must carry the staged server config')
  assert.equal(identity.levelDatPresentAtPrepare, false, 'freshness: no level.dat existed when the world was staged')
  assert.deepEqual(identity.assists.grantedItems, [])
  assert.deepEqual(identity.assists.summonedMobs, [])
  assert.deepEqual(identity.assists.prebuiltStructures, [])
  assert.deepEqual(identity.assists.operatorWorldEdits, [])

  const liveRehearsal = runCli(['--campaign', 'bad', '--trials', '1', '--rehearse', '--server-root', LIVE_CONTAINER])
  assert.equal(liveRehearsal.code, 1)
  assert.match(liveRehearsal.stderr, /must not stage into the live container/)
  const noSha = runCli(['--campaign', 'bad2', '--trials', '1', '--apply', '--live'])
  assert.equal(noSha.code, 2)
  assert.match(noSha.stderr, /--live requires --frozen-sha/)
  const usage = runCli(['--help'])
  assert.equal(usage.code, 0)
  assert.match(usage.stdout, /m2-reproducibility — measure the M2 rate/)
  const noCampaign = runCli(['--trials', '1'])
  assert.equal(noCampaign.code, 2)
  const unknown = runCli(['--campaign', 'x', '--nope'])
  assert.equal(unknown.code, 2)
  assert.match(unknown.stderr, /unknown argument: --nope/)
  assert.equal(parseArgs(['--trials', '5']).trials, 5)
  ok('I1. no rcon material and no stager file content is persisted; the identity carries the clean-run premise')
  ok('I2. the live container is refused for a rehearsal; --live without --frozen-sha exits 2; usage errors exit 2')
}

// ---------------------------------------------------------------------------
// J. the live path refuses while another resident/server is live
// ---------------------------------------------------------------------------
{
  const root = scratchContainer('liveguard')
  const result = runCli([
    '--campaign', 'liveguard', '--trials', '1', '--apply', '--live',
    '--frozen-sha', FROZEN_SHA, '--frozen-tree', REPO_ROOT,
    '--server-root', LIVE_CONTAINER, '--trials-dir', join(root, 'runs'),
  ])
  const live = (() => {
    try {
      return readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).some((pid) => {
        try {
          return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('agent-runner.mts')
        } catch {
          return false
        }
      })
    } catch {
      return false
    }
  })()
  if (live) {
    assert.equal(result.code, 1, `a live resident must make the campaign refuse (exit=${result.code})`)
    assert.match(result.stderr, /M2_REPRO_REFUSED/)
    assert.match(result.stderr, /resident_is_live/)
    assert.match(result.stderr, /operator decision \(root AGENTS\.md H4\)/)
    assert.equal(existsSync(join(root, 'runs', 'trial-000')), false, 'a refused campaign must not touch a trial directory')
    ok('J1. a live trial is never disturbed: the campaign refuses, names the reason, and creates no trial directory')
  } else {
    // No live resident on this machine: the precondition analysis must still run
    // and the frozen-sha format guard must bite.
    const badSha = runCli([
      '--campaign', 'liveguard2', '--trials', '1', '--apply', '--live',
      '--frozen-sha', 'not-a-sha', '--frozen-tree', REPO_ROOT,
      '--server-root', LIVE_CONTAINER, '--trials-dir', join(root, 'runs2'),
    ])
    assert.equal(badSha.code, 2)
    assert.match(badSha.stderr, /--live requires --frozen-sha <40hex>/)
    ok('J2. (no live resident) a malformed --frozen-sha is refused before any trial work')
  }
}

// ---------------------------------------------------------------------------
{
  const stat = statSync(SCRATCH)
  assert.ok(stat.isDirectory())
  rmSync(SCRATCH, { recursive: true, force: true })
  console.log(`m2-reproducibility-test ${checks}/${checks} PASS`)
}
