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
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAcceptanceBundle } from './m3-acceptance-bundle.mjs'
import { runCleanRunGate, runCli as runGateCli } from './clean-run-gate.mjs'
import { checkConsoleGameruleEvidence, checkRunEvidence, loadCleanEnvironment, sha256Text, validateCleanEnvironment } from './clean-run-environment.mjs'
import { buildLeafStartupAttestation } from './clean-run-server-launch.mjs'
import { expectedLeafLaunchIdentity, expectedRuntimeServerProperties } from './clean-run-server-config.mjs'
import { expectedConsoleQueries } from './clean-run-console-capture.mjs'
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
const SYSTEM2_GENERATION_ID = 'gen-test-1'
const SYSTEM2_BUILD_HASH = 'e6be1812c804'
const SYSTEM2_TRIGGER = 'queue_empty'

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
        `GENERATION_READY runId=${runId} id=${SYSTEM2_GENERATION_ID} generationId=${SYSTEM2_GENERATION_ID} sourceSha=${source} buildHash=${SYSTEM2_BUILD_HASH} ` +
          'system2ConfiguredProvider=typesafe-ai system2ConfiguredModel=typesafe-ai/jev rungIndex=13 rungId=nether_portal ' +
          'policy=typesafe policyProvider=typesafe-ai model=typesafe-ai/jev policyModel=typesafe-ai/jev ' +
          'system2AuthorityStack={"provider":"hybrid","model":"typesafe-ai:typesafe-ai/jev"} ' +
          'system2LastAuthority={"provider":"none","model":"none"} deterministicFallbackEnabled=false ' +
          'planner=llm plannerModel=typesafe-ai/jev',
      ),
      line(1.5, `SYSTEM2_AUTHORITY_INPUT runId=${runId} requestId=clean-plan-${runId} generationId=${SYSTEM2_GENERATION_ID} sourceSha=${source} buildHash=${SYSTEM2_BUILD_HASH} configuredProvider=typesafe-ai configuredModel=typesafe-ai/jev trigger=${SYSTEM2_TRIGGER} provider=typesafe-ai model=typesafe-ai/jev`),
      line(2, `SYSTEM2_AUTHORITY_DECISION runId=${runId} requestId=clean-plan-${runId} generationId=${SYSTEM2_GENERATION_ID} sourceSha=${source} buildHash=${SYSTEM2_BUILD_HASH} configuredProvider=typesafe-ai configuredModel=typesafe-ai/jev trigger=${SYSTEM2_TRIGGER} provider=typesafe-ai model=typesafe-ai/jev chosen=front_nether_portal`),
      line(2.1, `SYSTEM2_PLAN_APPLIED runId=${runId} requestId=clean-plan-${runId} generationId=${SYSTEM2_GENERATION_ID} sourceSha=${source} buildHash=${SYSTEM2_BUILD_HASH} op=patch accepted=true applied=1`),
      line(3, `HOST_LOCK released runId=${runId}`),
    ].join('\n') + '\n'
  )
}

const decisionsFor = (runId, source = FIXTURE_SHA) => `${JSON.stringify({
  record: 'decision', ts: at(2), source: 'jev', runId,
  generationId: SYSTEM2_GENERATION_ID, sourceSha: source,
  jev: { provider: 'typesafe-ai', model: 'typesafe-ai/jev' }, action: 'GOTO:nether_portal',
})}\n`

function acceptanceRecord(runId, { levelName = CLEAN_LEVEL, seed = CLEAN_SEED, gitCommit = FIXTURE_SHA, startupMarker = null } = {}) {
  const worldIdentityEvidence = startupMarker === null ? null : {
    levelName: {
      source: 'verified-leaf-argv',
      runId,
      bootSourceSha: startupMarker.bootSourceSha,
      processLevelNameArg: startupMarker.process?.levelNameArg ?? null,
    },
    seed: {
      source: 'verified-leaf-startup-descriptor',
      runId,
      bootSourceSha: startupMarker.bootSourceSha,
      seed: String(startupMarker.world?.levelSeed ?? ''),
      runtimeConfirmationRequired: 'clean-run-console-capture',
    },
  }
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
    worldIdentityEvidence,
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

function initCleanFixtureGit(root) {
  // This nested checkout stands in for a frozen source tree. Runtime evidence
  // and the resolved run descriptor are deliberately ignored/untracked so the
  // source HEAD remains exact and clean while those external run artifacts are
  // gathered, just as a real checkout's ignored `runs/` data is.
  writeFileSync(
    join(root, '.gitignore'),
    [
      '/environment-resolved.json',
      '/manifest.json',
      '/gamerule-verification.txt',
      '/server.properties.clean',
      '/manifest.json',
      '/server-start-attestation.json',
      '/server-console/',
      '/gamerules-observed.json',
      '/buddy-driver/buddy.log',
      '/buddy-driver/runner.out',
      '/buddy-driver/logs/',
      '/buddy-driver/data/',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(join(root, 'fixture-marker.txt'), 'FIXTURE source checkout; not run evidence\n', 'utf8')
  const runGit = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
    return result.stdout.trim()
  }
  runGit(['init', '-q'])
  runGit(['config', 'user.email', 'fixture@example.invalid'])
  runGit(['config', 'user.name', 'fixture'])
  runGit(['add', '-A'])
  runGit(['commit', '-q', '-m', 'fixture source'])
  const head = runGit(['rev-parse', 'HEAD'])
  assert.ok(/^[0-9a-f]{40}$/.test(head), `fixture git HEAD=${head}`)
  return head
}

function writeFixture(root, runId, { logLines, source = FIXTURE_SHA, acceptance = true, acceptanceOptions = {}, decisions = null, descriptor = null } = {}) {
  const startupMarker = descriptor === null ? null : writeGameruleVerification(root, runId, descriptor, source)
  const attachMarker = (lines) => startupMarker === null
    ? lines
    : lines.map((entry) => /\bBOOT\b(?!_)/.test(entry) ? `${entry} cleanRunServerConfig=${JSON.stringify(startupMarker)}` : entry)
  writeFileSync(join(root, 'buddy-driver', 'buddy.log'), `${attachMarker(logLines).join('\n')}\n`, 'utf8')
  writeFileSync(join(root, 'buddy-driver', 'runner.out'), `${attachMarker(runnerOut(runId, source).trimEnd().split('\n')).join('\n')}\n`, 'utf8')
  writeFileSync(join(root, 'buddy-driver', 'logs', 'jev', 'decisions.jsonl'), decisions ?? decisionsFor(runId, source), 'utf8')
  const firstInventory = logLines.map((entry) => /\bINVENTORY items=(\{.*\})/.exec(entry)?.[1] ?? null).find((entry) => entry !== null)
  writeFileSync(
    join(root, 'buddy-driver', 'data', 'resident', `m2-snapshot-${runId}.json`),
    JSON.stringify({
      record: 'm2-snapshot',
      runId,
      generationId: SYSTEM2_GENERATION_ID,
      bootSourceSha: source,
      buildHash: SYSTEM2_BUILD_HASH,
      worldEpoch: 1,
      worldKey: '127.0.0.1:25565|minecraft:overworld|1',
      initialInventory: firstInventory === null ? {} : JSON.parse(firstInventory),
      initialInventoryObservation: {
        runId,
        atMs: Date.parse(at(0)),
        at: at(0),
        generationId: SYSTEM2_GENERATION_ID,
        bootSourceSha: source,
        buildHash: SYSTEM2_BUILD_HASH,
        worldEpoch: 1,
        worldKey: '127.0.0.1:25565|minecraft:overworld|1',
      },
      markers: [],
    }),
    'utf8',
  )
  if (acceptance) {
    writeFileSync(
      join(root, 'buddy-driver', 'data', 'resident', `acceptance-${runId}.json`),
      acceptanceRecord(runId, { gitCommit: source, ...acceptanceOptions, startupMarker }),
      'utf8',
    )
  }
}

/** A resolved (frozen) descriptor inside the fixture root. */
function resolvedDescriptor(root, { levelName = CLEAN_LEVEL, levelSeed = CLEAN_SEED, sourceSha = FIXTURE_SHA, mutate = null, container = null, withPreparationProof = true } = {}) {
  const template = JSON.parse(readFileSync(TEMPLATE, 'utf8'))
  template.values.levelName = levelName
  template.values.levelSeed = levelSeed
  template.values.sourceSha = sourceSha
  template.cleanRun.sourceSha.state = sourceSha === null ? 'UNSET' : 'FROZEN'
  template.cleanRun.worldContainer = container ?? join(SCRATCH, 'container')
  if (mutate !== null) mutate(template)
  const path = join(root, 'environment-resolved.json')
  writeFileSync(path, `${JSON.stringify(template, null, 2)}\n`, 'utf8')
  const loaded = loadCleanEnvironment(path)
  assert.equal(loaded.error, null, `fixture descriptor load: ${String(loaded.error)}`)
  if (!withPreparationProof) return { path, document: template }
  const preparedAt = at(-1)
  const worldContainer = template.cleanRun.worldContainer
  const worldDir = join(worldContainer, levelName)
  const attemptsPath = join(worldContainer, 'm3-clean-run', 'attempts.json')
  mkdirSync(dirname(attemptsPath), { recursive: true })
  const attemptsText = `${JSON.stringify({
    record: 'clean-run-attempts',
    schemaVersion: 1,
    attempts: [{ levelName, levelSeed, sourceSha, preparedAt, worldDir, levelDatPresentAtPrepare: false }],
    updatedAt: preparedAt,
  }, null, 2)}\n`
  writeFileSync(attemptsPath, attemptsText, 'utf8')
  const manifest = {
    record: 'clean-run-prepare',
    schemaVersion: 2,
    generatedAt: preparedAt,
    mode: 'apply',
    descriptor: { path, sha256: loaded.sha256 },
    resolved: { path, sha256: loaded.sha256, overrides: [] },
    target: { levelName, levelSeed, sourceSha, worldDir, container: worldContainer, levelDatPresentAtPrepare: false },
    attemptLedger: { path: attemptsPath, sha256: sha256Text(attemptsText) },
    files: [{ path, sha256: loaded.sha256 }],
  }
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { path, document: template, manifestPath: join(root, 'manifest.json'), attemptsPath }
}

function writeGameruleVerification(root, runId, descriptor, bootSourceSha) {
  const loaded = loadCleanEnvironment(descriptor.path)
  assert.equal(loaded.error, null, `fixture descriptor load: ${String(loaded.error)}`)
  const runDir = dirname(descriptor.path)
  const container = descriptor.document.cleanRun.worldContainer
  mkdirSync(container, { recursive: true })
  writeFileSync(join(container, descriptor.document.values.serverImplementation), 'fixture Leaf jar bytes')
  const propertiesPath = join(runDir, 'server.properties.clean')
  const properties = expectedRuntimeServerProperties(descriptor.document)
  let propertiesText = `${Object.entries(properties).map(([key, value]) => `${key}=${value}`).join('\n')}\n`
  propertiesText = propertiesText.replace('level-type=minecraft:normal', 'level-type=minecraft\\:normal')
  writeFileSync(propertiesPath, propertiesText, { encoding: 'utf8', mode: 0o600 })
  const propertiesSha256 = sha256Text(propertiesText)
  const manifestPath = join(runDir, 'manifest.json')
  const attemptsPath = join(container, 'm3-clean-run', 'attempts.json')
  const attemptsText = readFileSync(attemptsPath, 'utf8')
  const manifestText = `${JSON.stringify({
    record: 'clean-run-prepare',
    schemaVersion: 2,
    generatedAt: at(-1),
    mode: 'apply',
    descriptor: { path: descriptor.path, sha256: loaded.sha256 },
    resolved: { path: descriptor.path, sha256: loaded.sha256, overrides: [] },
    target: {
      levelName: descriptor.document.values.levelName,
      levelSeed: descriptor.document.values.levelSeed,
      sourceSha: descriptor.document.values.sourceSha,
      worldDir: join(container, descriptor.document.values.levelName),
      container,
      levelDatPresentAtPrepare: false,
    },
    attemptLedger: { path: attemptsPath, sha256: sha256Text(attemptsText) },
    files: [
      { path: descriptor.path, sha256: loaded.sha256, bytes: Buffer.byteLength(readFileSync(descriptor.path)), note: 'synthetic resolved descriptor' },
      { path: propertiesPath, sha256: propertiesSha256, bytes: Buffer.byteLength(propertiesText), note: 'synthetic test fixture only' },
    ],
    serverLaunch: expectedLeafLaunchIdentity(descriptor.document, container),
  }, null, 2)}\n`
  writeFileSync(manifestPath, manifestText, 'utf8')
  const manifestSha256 = sha256Text(manifestText)
  const consoleDir = join(runDir, 'server-console')
  mkdirSync(consoleDir, { mode: 0o700 })
  chmodSync(consoleDir, 0o700)
  const fifoPath = join(consoleDir, 'server-console.fifo')
  execFileSync('mkfifo', ['-m', '600', '--', fifoPath])
  const stdoutLogPath = join(consoleDir, 'leaf-server.log')
  writeFileSync(stdoutLogPath, '', { mode: 0o600 })
  const relayJournalPath = join(consoleDir, 'leaf-console-relay.jsonl')

  const pid = 4242
  const java = '/usr/lib/jvm/java-21-openjdk-amd64/bin/java'
  const args = [
    '-Xmx1G', '-Xms1G', '-DPaper.IgnoreJavaVersion=true', '-jar', descriptor.document.values.serverImplementation,
    '--nogui', '--config', propertiesPath, '--universe', container, '--level-name', descriptor.document.values.levelName,
  ]
  const procArgs = [java, ...args]
  const javaIdentity = expectedLeafLaunchIdentity(descriptor.document, container).java
  const startedAt = '2026-09-23T09:59:00.000Z'
  const startup = buildLeafStartupAttestation({
    descriptorPath: descriptor.path,
    descriptorText: readFileSync(descriptor.path, 'utf8'),
    descriptor: descriptor.document,
    propertiesPath,
    propertiesText,
    manifestPath,
    manifestText,
    consoleInputPath: fifoPath,
    stdoutLogPath,
    cwd: container,
    executable: java,
    args,
    pid,
    startedAt,
    procCmdline: procArgs,
    procExecutablePath: javaIdentity.realpath,
    procExecutableSha256: javaIdentity.sha256,
  })
  const startupPath = join(runDir, 'server-start-attestation.json')
  const startupText = `${JSON.stringify(startup, null, 2)}\n`
  writeFileSync(startupPath, startupText, { encoding: 'utf8', mode: 0o600 })
  const startupSha256 = sha256Text(startupText)
  const marker = {
    status: 'verified',
    runId,
    bootSourceSha,
    world: {
      levelName: descriptor.document.values.levelName,
      levelSeed: String(descriptor.document.values.levelSeed),
    },
    descriptorPath: descriptor.path,
    descriptorSha256: loaded.sha256,
    attestationPath: startupPath,
    attestationSha256: startupSha256,
    manifestPath,
    manifestSha256,
    process: {
      ...startup.process,
      commandLineSha256: sha256Text(procArgs.join('\0')),
    },
    runtime: startup.runtime,
    config: { path: propertiesPath, sha256: propertiesSha256, properties: startup.config.properties },
    console: startup.console,
    preparedManifest: { stagedPropertiesSha256: propertiesSha256 },
  }

  // These generated bytes simulate process stdout only inside this offline test.
  // Production capture uses the FIFO writer and the live Leaf stdout log.
  const { queries } = expectedConsoleQueries(descriptor.document)
  const bootTime = at(0)
  const capturedAt = at(36)
  let leafLog = Buffer.alloc(0)
  const appendResponse = (line) => {
    const bytes = Buffer.from(line, 'utf8')
    const byteStart = leafLog.length
    leafLog = Buffer.concat([leafLog, bytes, Buffer.from('\n')])
    return { line, byteStart, byteEnd: byteStart + bytes.length, lineSha256: sha256Text(bytes) }
  }
  const seed = { value: String(descriptor.document.values.levelSeed), ...appendResponse(`[Server thread/INFO]: Seed: [${descriptor.document.values.levelSeed}]`) }
  const responses = []
  const journal = []
  let relayJournalText = ''
  const appendRelay = (row) => { relayJournalText += `${JSON.stringify(row)}\n` }
  const relayCommands = ['seed', ...queries.map((query) => query.command)]
  appendRelay({ event: 'console-relay-start', leafPid: pid, launcherPid: 31337, expectedCommandCount: relayCommands.length, at: capturedAt })
  let relaySequence = 0
  const appendRelayCommand = (command) => {
    const relayOffsetBefore = Buffer.byteLength(relayJournalText)
    const commandBytes = Buffer.from(`${command}\n`)
    appendRelay({ event: 'console-relay-input', leafPid: pid, byteLength: commandBytes.length, sha256: sha256Text(commandBytes), at: capturedAt })
    appendRelay({ event: 'console-relay-forwarded', leafPid: pid, sequence: relaySequence, command, at: capturedAt })
    relaySequence += 1
    return relayOffsetBefore
  }
  const appendJournalPair = (query, response, { byteOffsetBefore, relayOffsetBefore, sequence }) => {
    const common = {
      runId,
      sourceSha: bootSourceSha,
      descriptorSha256: loaded.sha256,
      startupAttestationSha256: startupSha256,
      leafPid: pid,
      kind: query.kind,
      command: query.command,
      dimension: query.dimension ?? null,
      rule: query.rule ?? null,
      descriptorRule: query.descriptorRule ?? null,
      byteOffsetBefore,
      relayOffsetBefore,
      relaySequence: sequence,
    }
    journal.push({ ...common, event: 'console-query-attempt', at: capturedAt })
    journal.push({
      ...common,
      event: 'console-query-response',
      value: response.value,
      responseLine: response.line,
      byteStart: response.byteStart,
      byteEnd: response.byteEnd,
      responseByteStart: response.byteStart,
      responseByteEnd: response.byteEnd,
      responseLineSha256: response.lineSha256,
      completedAt: capturedAt,
    })
  }
  const seedRelayOffsetBefore = appendRelayCommand('seed')
  seed.byteOffsetBefore = 0
  seed.relaySequence = 0
  appendJournalPair({ kind: 'seed', command: 'seed' }, { ...seed, command: 'seed' }, { byteOffsetBefore: 0, relayOffsetBefore: seedRelayOffsetBefore, sequence: 0 })
  for (const [queryIndex, query] of queries.entries()) {
    const byteOffsetBefore = leafLog.length
    const relayOffsetBefore = appendRelayCommand(query.command)
    const response = {
      value: query.expected,
      ...appendResponse(`[Server thread/INFO]: Gamerule ${query.descriptorRule} is currently set to: ${String(query.expected)}`),
      command: query.command,
      byteOffsetBefore,
      relaySequence: queryIndex + 1,
    }
    responses.push({
      dimension: query.dimension,
      rule: query.rule,
      descriptorRule: query.descriptorRule,
      expected: query.expected,
      command: query.command,
      ...response,
    })
    appendJournalPair(query, response, { byteOffsetBefore, relayOffsetBefore, sequence: queryIndex + 1 })
  }
  writeFileSync(stdoutLogPath, leafLog, { mode: 0o600 })
  const commandJournalText = `${journal.map((entry) => JSON.stringify(entry)).join('\n')}\n`
  const commandTranscriptPath = join(consoleDir, 'commands.jsonl')
  writeFileSync(commandTranscriptPath, commandJournalText, { encoding: 'utf8', mode: 0o600 })
  writeFileSync(relayJournalPath, relayJournalText, { encoding: 'utf8', mode: 0o600 })
  const transcriptPath = join(runDir, 'gamerule-verification.txt')
  const transcriptLines = [
    'record=m3-clean-gamerule-verification',
    'schemaVersion=1',
    `runId=${runId}`,
    `descriptorSha256=${loaded.sha256}`,
    `levelName=${descriptor.document.values.levelName}`,
    `seed=${seed.value}`,
    `sourceSha=${bootSourceSha}`,
    `capturedAt=${capturedAt}`,
  ]
  for (const dimension of descriptor.document.cleanRun.gameruleScope.dimensions) {
    transcriptLines.push('', `[dimension=${dimension}]`)
    for (const response of responses.filter((entry) => entry.dimension === dimension)) transcriptLines.push(response.line)
  }
  const transcriptText = `${transcriptLines.join('\n')}\n`
  writeFileSync(transcriptPath, transcriptText, { encoding: 'utf8', mode: 0o600 })
  const capturePath = join(consoleDir, 'capture.json')
  const capture = {
    record: 'clean-run-console-capture',
    schemaVersion: 2,
    status: 'complete',
    runId,
    sourceSha: bootSourceSha,
    descriptor: { path: descriptor.path, sha256: loaded.sha256 },
    startupAttestation: { path: startupPath, sha256: startupSha256 },
    process: { pid, commandLineSha256: marker.process.commandLineSha256 },
    residentLog: { path: join(root, 'buddy-driver', 'buddy.log'), sourceSha: bootSourceSha },
    capturePath,
    console: {
      directory: consoleDir,
      stdoutLogPath,
      commandTranscriptPath,
      relayJournalPath,
      relayJournalSha256: sha256Text(relayJournalText),
      relayJournalBytes: Buffer.byteLength(relayJournalText),
      relayCommandCount: relayCommands.length,
    },
    commandTranscript: { path: commandTranscriptPath, sha256: sha256Text(commandJournalText), queryCount: queries.length + 1 },
    seed,
    requiredDimensions: descriptor.document.cleanRun.gameruleScope.dimensions,
    observedRuleCount: responses.length,
    excludedRules: Object.keys(descriptor.document.cleanRun.gamerulePolicy.notRegisteredInWorld ?? {}),
    responses,
    transcript: { path: transcriptPath, sha256: sha256Text(transcriptText) },
    capturedAt,
    bootTime,
  }
  writeFileSync(capturePath, `${JSON.stringify(capture, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return marker
}

async function buildBundle(
  root,
  runId,
  { environmentPath, evidenceClass = 'fixture', outName = 'bundle', sourceSha = FIXTURE_SHA, currentInventoryCounts = { ender_eye: 12 } } = {},
) {
  // Keep generated bundle/gate reports outside the frozen checkout so they do
  // not make `git status` dirty and invalidate the exact-source check.
  const outDir = join(SCRATCH, `${basename(root)}-${outName}`)
  const observedAt = at(35)
  const reportBinding = {
    runId,
    worldKey: { ...JSON.parse(WORLD_KEY), dimension: 'minecraft:the_nether' },
    currentInventoryObservation: {
      record: 'current-inventory-observation',
      schemaVersion: 1,
      runId,
      sourceSha,
      generationId: 'gen-test-1',
      observedAtMs: Date.parse(observedAt),
      observedAt,
      worldKey: { ...JSON.parse(WORLD_KEY), dimension: 'minecraft:the_nether' },
      dimension: 'minecraft:the_nether',
      counts: currentInventoryCounts,
    },
  }
  const result = await buildAcceptanceBundle({
    runId,
    root,
    outDir,
    evidenceClass,
    overrides: { environment: environmentPath },
    noControlSocket: false,
    // This is the explicit read-only control `report` fixture. It supplies the
    // acceptance-time inventory required by the canonical gate without opening
    // any real socket or treating log history as the final inventory.
    readSocket: async () => reportBinding,
    write: () => {},
  })
  return { ...result, outDir }
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
  const sourceSha = initCleanFixtureGit(root)
  const descriptor = resolvedDescriptor(root, { container, sourceSha })
  writeFixture(root, RUN, { source: sourceSha, descriptor, logLines: cleanLog(RUN, { source: sourceSha, settle: 'LADDER_INVENTORY_SETTLE reason=death readings=9 changed=false empty=true itemCount=0 waitedMs=1000 counts={}' }) })

  // the descriptor itself validates CLEAN against the container
  const check = validateCleanEnvironment(descriptor.document, { descriptorPath: descriptor.path, worldContainer: container })
  assert.equal(check.status, 'CLEAN', `descriptor check: ${check.failed.join(',')}`)

  const { bundle, exitCode, outDir } = await buildBundle(root, RUN, { environmentPath: descriptor.path, sourceSha })
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

  // The prepared world now has ordinary server-generated data. A descriptor-
  // only/pre-run judgement must still reject that state, while the final
  // run-scoped judgement proves freshness from the manifest written before BOOT.
  const generatedWorldDir = join(container, CLEAN_LEVEL)
  mkdirSync(generatedWorldDir, { recursive: true })
  writeFileSync(join(generatedWorldDir, 'level.dat'), 'fixture server-generated level data\n', 'utf8')
  const descriptorOnlyAfterBoot = await runCleanRunGate({ environment: descriptor.path, worldContainer: container })
  assert.equal(descriptorOnlyAfterBoot.status, 'NOT_CLEAN')
  assert.equal(condition(descriptorOnlyAfterBoot, 'descriptor.worldNotGenerated')?.verdict, 'FAIL')

  const verdict = await runCleanRunGate({ environment: descriptor.path, bundleDir: outDir, runId: RUN, out: outDir })
  assert.equal(verdict.status, 'CLEAN', `clean status=${verdict.status} failed=${verdict.failed.join(',')} unknown=${JSON.stringify(verdict.unknown ?? verdict.conditions ?? verdict)}`)
  for (const id of ['run.environmentRecordIsThisDescriptor', 'run.bootSourceSha', 'run.serverVersionMatchesDescriptor', 'run.acceptanceRecord', 'run.levelNameAttested', 'run.seedAttested', 'run.acceptanceWorldIdentity', 'run.finalInventoryWorldIdentity', 'run.preparationFreshness', 'run.serverConfigAttestation', 'run.consoleGamerulesVerified', 'run.gamerulesNotContradicted', 'run.noWorldChanges', 'run.bootInventoryEmpty', 'run.keepInventoryBehaviour', 'run.difficultyNotContradicted', 'run.mobSpawningNotContradicted']) {
    const row = runCondition(verdict, id)
    assert.ok(row !== null, `missing condition ${id}`)
    assert.equal(row.verdict, 'PASS', `${id} verdict=${row.verdict} reason=${row.reason}`)
  }
  assert.equal(condition(verdict, 'descriptor.worldNotGenerated')?.verdict, 'UNKNOWN')
  assert.equal(condition(verdict, 'descriptor.worldNotGenerated')?.required, false)
  assert.match(runCondition(verdict, 'run.preparationFreshness').reason, /recorded before BOOT/)
  const wrongInitialSource = JSON.parse(JSON.stringify(bundle.artifact.document))
  wrongInitialSource.inventory.bootEvidence.bootSourceSha = 'f'.repeat(40)
  const bootEvidenceChecks = checkRunEvidence({
    descriptor: descriptor.document,
    artifact: wrongInitialSource,
    logText: readFileSync(join(root, 'buddy-driver', 'buddy.log'), 'utf8'),
    runId: RUN,
    descriptorPath: descriptor.path,
    descriptorSha256: loadCleanEnvironment(descriptor.path).sha256,
  })
  const bootInventoryCondition = bootEvidenceChecks.find((entry) => entry.id === 'run.bootInventoryEmpty')
  assert.equal(bootInventoryCondition.verdict, 'UNKNOWN', 'a foreign-source generation-entry snapshot cannot certify a clean boot inventory')
  assert.match(bootInventoryCondition.reason, /not bound to this run's exact BOOT source/)
  const wrongVersion = JSON.parse(JSON.stringify(bundle.artifact.document))
  wrongVersion.run.serverVersion = '1.20.1'
  const wrongVersionConditions = checkRunEvidence({
    descriptor: descriptor.document,
    artifact: wrongVersion,
    runId: RUN,
    descriptorPath: descriptor.path,
    descriptorSha256: loadCleanEnvironment(descriptor.path).sha256,
  })
  assert.equal(wrongVersionConditions.find((entry) => entry.id === 'run.serverVersionMatchesDescriptor').verdict, 'FAIL')
  const wrongAcceptedServer = JSON.parse(JSON.stringify(bundle.artifact.document))
  wrongAcceptedServer.acceptance.record.serverId = '198.51.100.1:25565'
  const wrongAcceptedConditions = checkRunEvidence({
    descriptor: descriptor.document,
    artifact: wrongAcceptedServer,
    runId: RUN,
    descriptorPath: descriptor.path,
    descriptorSha256: loadCleanEnvironment(descriptor.path).sha256,
  })
  assert.equal(wrongAcceptedConditions.find((entry) => entry.id === 'run.acceptanceWorldIdentity').verdict, 'FAIL')
  assert.equal(wrongAcceptedConditions.find((entry) => entry.id === 'run.finalInventoryWorldIdentity').verdict, 'FAIL')
  const wrongFinalServer = JSON.parse(JSON.stringify(bundle.artifact.document))
  wrongFinalServer.inventory.final.worldKey.serverId = '198.51.100.2:25565'
  const wrongFinalConditions = checkRunEvidence({
    descriptor: descriptor.document,
    artifact: wrongFinalServer,
    runId: RUN,
    descriptorPath: descriptor.path,
    descriptorSha256: loadCleanEnvironment(descriptor.path).sha256,
  })
  assert.equal(wrongFinalConditions.find((entry) => entry.id === 'run.finalInventoryWorldIdentity').verdict, 'FAIL')
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
  rmSync(generatedWorldDir, { recursive: true, force: true })
  // The proof, printed: every verdict line of the offline acceptance path. This is
  // a FIXTURE judgement (evidenceClass=fixture), never live evidence.
  console.log('    --- full clean-run verdict lines for the CLEAN fixture (FIXTURE, not live evidence) ---')
  for (const entry of text.trimEnd().split('\n')) console.log(`    ${entry}`)
  ok('B. clean descriptor + fixture run: M3 gate PASS, clean CLEAN, combined NOT_ACCEPTED (fixture≠live), full verdict lines')
}

// B2. a documented pre-run configuration selection is run-bound and is not a
// post-creation world edit. `worldChanges` must stay empty for this new world.
{
  const root = makeRoot('clean-run-config-rationale')
  const container = join(SCRATCH, 'container')
  mkdirSync(container, { recursive: true })
  const sourceSha = initCleanFixtureGit(root)
  const rationale = {
    setting: 'values.difficulty',
    from: 'normal',
    to: 'easy',
    reason: 'Use the lowest non-peaceful difficulty for the unattended clean M3 attempt while retaining hostile mob spawns and drops.',
    expectedImpact: 'Reduces incoming hostile damage; enderman and blaze spawning/drop mechanics remain enabled, and no world terrain or inventory is pre-edited.',
  }
  const descriptor = resolvedDescriptor(root, {
    levelName: CLEAN_LEVEL,
    container,
    sourceSha,
    mutate: (doc) => {
      doc.values.difficulty = 'easy'
      doc.configurationChanges = [rationale]
    },
  })
  const descriptorSha256 = loadCleanEnvironment(descriptor.path).sha256
  writeFixture(root, RUN, {
    source: sourceSha,
    descriptor,
    logLines: cleanLog(RUN, {
      source: sourceSha,
      envMarker: 'ENVIRONMENT difficulty=easy spawnMonsters=true spawnAnimals=true advanceTime=true keepInventory=false spawnMobs=true',
    }),
  })
  const { bundle, exitCode, outDir } = await buildBundle(root, RUN, {
    environmentPath: descriptor.path,
    sourceSha,
    outName: 'bundle-config-rationale',
  })
  assert.equal(exitCode, 0, `documented config bundle exit=${exitCode} reason=${bundle.acceptanceVerdict.reason}`)
  const artifact = bundle.artifact.document
  assert.equal(artifact.environment.environmentFile.sha256, descriptorSha256)
  assert.deepEqual(artifact.environment.environmentFile.configurationChanges, [rationale])
  assert.deepEqual(artifact.environment.configurationChanges, {
    source: descriptor.path,
    descriptorSha256,
    runId: RUN,
    sourceSha,
    count: 1,
    changes: [rationale],
  })
  assert.equal(artifact.environment.worldChanges, null, 'a pre-run difficulty selection is not a world edit')

  const verdict = await runCleanRunGate({ environment: descriptor.path, bundleDir: outDir, runId: RUN })
  assert.equal(verdict.status, 'CLEAN', `documented config clean status=${verdict.status} failed=${verdict.failed.join(',')}`)
  assert.equal(runCondition(verdict, 'run.configurationChangesBound').verdict, 'PASS')
  assert.equal(runCondition(verdict, 'run.noWorldChanges').verdict, 'PASS')
  assert.deepEqual(runCondition(verdict, 'run.noWorldChanges').detail.worldChanges, null)

  const wrongRun = JSON.parse(JSON.stringify(artifact))
  wrongRun.environment.configurationChanges.runId = 'run-foreign-config'
  const wrongRunCheck = checkRunEvidence({
    descriptor: descriptor.document,
    artifact: wrongRun,
    runId: RUN,
    descriptorPath: descriptor.path,
    descriptorSha256,
  })
  assert.equal(wrongRunCheck.find((row) => row.id === 'run.configurationChangesBound').verdict, 'FAIL')
  const wrongDescriptorHash = JSON.parse(JSON.stringify(artifact))
  wrongDescriptorHash.environment.environmentFile.sha256 = 'f'.repeat(64)
  const wrongHashCheck = checkRunEvidence({
    descriptor: descriptor.document,
    artifact: wrongDescriptorHash,
    runId: RUN,
    descriptorPath: descriptor.path,
    descriptorSha256,
  })
  assert.equal(wrongHashCheck.find((row) => row.id === 'run.environmentRecordIsThisDescriptor').verdict, 'FAIL')

  const incomplete = JSON.parse(JSON.stringify(descriptor.document))
  incomplete.configurationChanges[0].expectedImpact = ''
  const incompleteCheck = validateCleanEnvironment(incomplete, { descriptorPath: descriptor.path, worldContainer: container })
  assert.equal(incompleteCheck.status, 'NOT_CLEAN')
  assert.equal(condition(incompleteCheck, 'descriptor.configurationChangesDocumented').verdict, 'FAIL')
  ok('B2. pre-run difficulty rationale/impact stays exact and run-bound; worldChanges remains empty')
}

// ---------------------------------------------------------------------------
// C. SIMULATED live signals (FIXTURE): the ACCEPTED branch is reachable only with
//    gate PASS + liveAcceptance=true + --evidence-class live
// ---------------------------------------------------------------------------
{
  const root = makeRoot('sim-live')
  const container = join(SCRATCH, 'sim-live-container')
  mkdirSync(container, { recursive: true })
  // a real exact source HEAD so the bundle's bootSourceMatchesTreeHead signal
  // can hold; simulated run evidence stays outside the source identity.
  const head = initCleanFixtureGit(root)

  const descriptor = resolvedDescriptor(root, { sourceSha: head, container })
  writeFixture(root, RUN, { source: head, descriptor, logLines: cleanLog(RUN, { source: head }) })
  // the third live signal: a HOST acceptance record (the fixture writes it; a real
  // run must refresh it through the read-only `acceptance` control query).
  writeFileSync(join(root, 'buddy-driver', 'data', 'resident', 'host.lock'), `${JSON.stringify({ pid: 4242, runId: RUN })}\n`, 'utf8')

  const { bundle, outDir } = await buildBundle(root, RUN, { environmentPath: descriptor.path, evidenceClass: 'live', outName: 'bundle-live', sourceSha: head })
  assert.equal(bundle.acceptanceVerdict.status, 'PASS')
  assert.equal(bundle.liveAcceptance, true, `live signals: ${JSON.stringify(bundle.liveSignals)}`)
  const verdict = await runCleanRunGate({ environment: descriptor.path, bundleDir: outDir, runId: RUN })
  assert.equal(verdict.status, 'CLEAN')
  assert.equal(verdict.acceptanceStatus, 'ACCEPTED', verdict.acceptanceReason)
  assert.equal(verdict.exitCode, 0)
  assert.equal(verdict.run.liveAcceptance, true)
  assert.equal(verdict.run.evidenceClass, 'live')
  assert.ok(verdict.failure === undefined)
  for (const id of ['run.serverConfigAttestation', 'run.consoleGamerulesVerified', 'run.serverVersionMatchesDescriptor', 'run.finalInventoryWorldIdentity']) {
    assert.equal(runCondition(verdict, id)?.verdict, 'PASS', `${id} must be run-bound before live acceptance`)
  }

  const bundlePath = join(outDir, 'bundle.json')
  const pristineBundleText = readFileSync(bundlePath, 'utf8')
  const missingStartup = JSON.parse(pristineBundleText)
  missingStartup.artifact.document.run.boot.cleanRunServerConfig = null
  writeFileSync(bundlePath, `${JSON.stringify(missingStartup, null, 2)}\n`, 'utf8')
  const noStartupAcceptance = await runCleanRunGate({ environment: descriptor.path, bundleDir: outDir, runId: RUN })
  assert.notEqual(noStartupAcceptance.acceptanceStatus, 'ACCEPTED')
  assert.equal(runCondition(noStartupAcceptance, 'run.serverConfigAttestation')?.verdict, 'UNKNOWN')
  writeFileSync(bundlePath, pristineBundleText, 'utf8')

  const capturePath = join(dirname(descriptor.path), 'server-console', 'capture.json')
  const captureText = readFileSync(capturePath, 'utf8')
  rmSync(capturePath)
  const noCaptureAcceptance = await runCleanRunGate({ environment: descriptor.path, bundleDir: outDir, runId: RUN })
  assert.notEqual(noCaptureAcceptance.acceptanceStatus, 'ACCEPTED')
  assert.equal(runCondition(noCaptureAcceptance, 'run.consoleGamerulesVerified')?.verdict, 'UNKNOWN')
  assert.equal(runCondition(noCaptureAcceptance, 'run.seedAttested')?.verdict, 'UNKNOWN', 'a descriptor seed cannot PASS without the same-run Leaf console capture')
  writeFileSync(capturePath, captureText, { encoding: 'utf8', mode: 0o600 })

  const nonConsoleGamerules = checkConsoleGameruleEvidence({
    descriptor: { cleanRun: { gameruleMechanism: { primary: 'datapack' } } },
    artifact: { record: 'milestone-run-artifact' },
  })
  assert.equal(nonConsoleGamerules.required, true)
  assert.equal(nonConsoleGamerules.verdict, 'UNKNOWN')
  ok('C. simulated live signals reach ACCEPTED only with BOOT-bound Leaf/JVM/config and machine-captured gamerule evidence')
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
  const sourceSha = initCleanFixtureGit(root)
  const descriptor = resolvedDescriptor(root, { container, sourceSha, mutate: (doc) => { doc.values.gamerules.keep_inventory = true } })
  writeFixture(root, RUN, { source: sourceSha, descriptor, logLines: cleanLog(RUN, { source: sourceSha }) })
  const { bundle, exitCode, outDir } = await buildBundle(root, RUN, { environmentPath: descriptor.path, sourceSha })
  assert.equal(exitCode, 0, `the M3 gate PASSes an assisted world (exit=${exitCode})`)
  assert.equal(bundle.gate.status, 'PASS')
  assert.equal(bundle.artifact.document.environment.environmentFile.values.gamerules.keep_inventory, true)
  const verdict = await runCleanRunGate({ environment: descriptor.path, bundleDir: outDir, runId: RUN })
  assert.equal(verdict.status, 'NOT_CLEAN')
  assert.equal(verdict.acceptanceStatus, 'NOT_ACCEPTED')
  assert.match(verdict.acceptanceReason, /keepInventory|gamerules/)
  // and the printed M3 line refuses it
  const printed = []
  await runGateCli({ argv: ['--environment', descriptor.path, '--bundle-dir', outDir, '--run', RUN], write: (entry) => printed.push(String(entry)), writeError: () => {} })
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
  const sourceSha = initCleanFixtureGit(root)
  const descriptor = resolvedDescriptor(root, { container, sourceSha })
  writeFixture(root, RUN, {
    source: sourceSha,
    logLines: cleanLog(RUN, { source: sourceSha, ...(variant.log ?? {}) }),
    acceptance: variant.acceptance !== false,
    acceptanceOptions: variant.acceptanceOptions ?? {},
    descriptor,
  })
  const { bundle, outDir } = await buildBundle(root, RUN, { environmentPath: descriptor.path, sourceSha })
  const verdict = await runCleanRunGate({ environment: descriptor.path, bundleDir: outDir, runId: RUN })
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
  const sourceSha = initCleanFixtureGit(root)
  const descriptor = resolvedDescriptor(root, { container, sourceSha })
  writeFixture(root, RUN, { source: sourceSha, descriptor, logLines: cleanLog(RUN, { source: sourceSha, settle: 'LADDER_INVENTORY_SETTLE reason=death readings=9 changed=false empty=true itemCount=0 waitedMs=998 counts={}' }) })
  const { outDir } = await buildBundle(root, RUN, { environmentPath: descriptor.path, sourceSha })
  const verdict = await runCleanRunGate({ environment: descriptor.path, bundleDir: outDir, runId: RUN })
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
  const operatorRoot = makeRoot('prepare-source')
  const prepareSourceSha = initCleanFixtureGit(operatorRoot)
  mkdirSync(container, { recursive: true })
  writeFileSync(
    join(container, 'server.properties'),
    'level-name=world\nlevel-seed=2024\ndifficulty=normal\nspawn-monsters=true\nspawn-animals=true\ngamemode=survival\nforce-gamemode=false\nhardcore=false\npvp=true\nenable-command-block=false\ngenerate-structures=true\nlevel-type=minecraft\\:normal\nallow-nether=true\nallow-flight=true\nspawn-protection=0\nwhite-list=false\nserver-port=25565\nmotd=fixture\n',
    'utf8',
  )

  writeFileSync(join(container, 'ops.json'), '[]', 'utf8')
  writeFileSync(join(container, 'leaf-1.21.11-178.jar'), 'clean-run prepare fixture Leaf identity')
  const descriptorPath = join(root, 'descriptor.json')
  const descriptorDoc = JSON.parse(readFileSync(TEMPLATE, 'utf8'))
  descriptorDoc.cleanRun.worldContainer = container
  descriptorDoc.cleanRun.gameruleMechanism.datapackFormat = { min: [94, 1], max: [94, 1] }
  writeFileSync(descriptorPath, `${JSON.stringify(descriptorDoc, null, 2)}\n`, 'utf8')
  const args = ['--environment', descriptorPath, '--server-root', container, '--root', operatorRoot, '--level-name', 'm3clean-prep', '--seed', '998877665544', '--source-sha', prepareSourceSha]

  // G1. dry-run writes NOTHING
  const planRun = planPrepare({ descriptorPath, serverRoot: container, root: operatorRoot, enforceOperatorTreeSource: true, levelName: 'm3clean-prep', seed: '998877665544', sourceSha: prepareSourceSha })
  assert.equal(planRun.status, 'PLANNED', `plan status=${planRun.status} refusals=${planRun.refusals.map((entry) => entry.reason).join('|')}`)
  assert.ok(planRun.actions.length >= 6)
  const before = readdirSync(container)
  const cli = await runPrepareCli({ argv: [...args, '--dry-run'], write: () => {}, writeError: () => {} })
  assert.equal(cli.exitCode, 0)
  assert.deepEqual(readdirSync(container), before, '--dry-run must not write anything into the server root')
  assert.equal(existsSync(join(container, 'm3-clean-run')), false)
  assert.equal(existsSync(join(container, 'm3clean-prep')), false)
  assert.equal(cli.plan.guards.find((guard) => guard.id === 'operator_tree_clean_checkout')?.verdict, 'PASS')
  const dirtySourceFile = join(operatorRoot, 'dirty-source-fixture.txt')
  writeFileSync(dirtySourceFile, 'uncommitted source\n', 'utf8')
  const dirtyCli = await runPrepareCli({ argv: [...args, '--dry-run'], write: () => {}, writeError: () => {} })
  assert.equal(dirtyCli.exitCode, 1)
  assert.equal(dirtyCli.plan.guards.find((guard) => guard.id === 'operator_tree_clean_checkout')?.verdict, 'FAIL')
  assert.ok(dirtyCli.plan.refusals.some((entry) => /operator_tree_dirty/.test(entry.reason)))
  rmSync(dirtySourceFile)
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
  const startupRecipe = readFileSync(join(planRun.runDir, 'operator-commands.txt'), 'utf8')
  assert.match(startupRecipe, /clean-run-server-launch\.mjs/)
  assert.match(startupRecipe, /--console-input/)
  assert.match(startupRecipe, /--stdout-log/)
  assert.match(startupRecipe, /--unit=ai-buddy-clean-leaf/)
  assert.match(startupRecipe, /--no-block/)
  assert.match(startupRecipe, /KillMode=mixed/)
  assert.ok(startupRecipe.includes(`'${process.execPath}'`), 'systemd-managed Leaf, resident, and evidence commands use the absolute Bun executable')
  assert.ok(startupRecipe.includes(`StandardOutput=append:${join(operatorRoot, 'buddy-driver', 'runner.out')}`), 'resident stdout appends to the exact bundle runner.out')
  assert.ok(startupRecipe.includes(`StandardError=append:${join(operatorRoot, 'buddy-driver', 'runner.out')}`), 'resident stderr appends to the same run-bound output artifact')
  assert.doesNotMatch(startupRecipe, /VERCEL_API_KEY=|API_KEY=.{12}/, 'provider secrets stay in the protected environment file and are not embedded in commands')
  assert.doesNotMatch(startupRecipe, /clean-run-server-launch\.mjs[^\n]*&/)
  assert.match(startupRecipe, /Never pass --bonusChest/)
  assert.doesNotMatch(startupRecipe, /<\/dev\/null|execute in minecraft:the_nether run gamerule/)
  assert.match(startupRecipe, /clean-run-console-capture\.mjs/)
  assert.match(startupRecipe, /clean-run-resident-control\.mjs/)
  assert.match(startupRecipe, /clean-run-acceptance-refresh\.mjs/)
  assert.match(startupRecipe, /clean-run-runner-output\.mjs/)
  assert.match(startupRecipe, /StandardOutput=append:[^\s']*buddy-driver\/runner\.out/)
  assert.match(startupRecipe, /StandardError=append:[^\s']*buddy-driver\/runner\.out/)
  assert.doesNotMatch(startupRecipe, /socat|UNIX-CONNECT|control-quit/)
  assert.match(startupRecipe, /descriptor\/run\/PID-bound commands\.jsonl, capture\.json/)
  assert.ok(startupRecipe.indexOf('clean-run-server-launch.mjs') < startupRecipe.indexOf('agent-runner.mts'))
  assert.ok(startupRecipe.indexOf('clean-run-runner-output.mjs') < startupRecipe.indexOf('agent-runner.mts'), 'runner.out must be created before systemd appends stdout/stderr')
  assert.ok(startupRecipe.indexOf('agent-runner.mts') < startupRecipe.indexOf('clean-run-console-capture.mjs'), 'capture must run after BOOT is possible')
  assert.doesNotMatch(startupRecipe, /setsid --fork nohup bun agent-runner|agent-runner\.mts <\/dev\/null/)
  const packMeta = readFileSync(join(container, 'm3clean-prep', 'datapacks', 'm3-clean-gamerules', 'pack.mcmeta'), 'utf8')
  assert.match(packMeta, /"min_format": \[\s*94,\s*1\s*\]/)
  assert.match(packMeta, /"max_format": \[\s*94,\s*1\s*\]/)
  assert.equal(/pack_format/.test(packMeta), false, 'since 1.21.9 a bare pack_format does not declare support: it must not be written')
  // gamerules are per-dimension: every rule is also asserted in the Nether and the End
  assert.match(mcfunction, /^execute in minecraft:the_nether run gamerule keep_inventory false$/m)
  assert.match(mcfunction, /^execute in minecraft:the_end run gamerule keep_inventory false$/m)
  const resolvedPath = join(planRun.runDir, 'environment-resolved.json')
  const resolved = JSON.parse(readFileSync(resolvedPath, 'utf8'))
  assert.equal(resolved.values.sourceSha, prepareSourceSha)
  assert.equal(resolved.cleanRun.sourceSha.state, 'FROZEN')
  assert.equal(resolved.values.levelName, 'm3clean-prep')
  assert.equal(resolved.cleanRun.worldContainer, container)
  const manifest = JSON.parse(readFileSync(planRun.manifestPath, 'utf8'))
  assert.equal(manifest.target.levelName, 'm3clean-prep')
  assert.equal(manifest.target.levelSeed, '998877665544')
  assert.equal(manifest.descriptor.sha256.length, 64)
  assert.equal(manifest.target.levelDatPresentAtPrepare, false)
  assert.equal(manifest.attemptLedger.path, planRun.attemptsPath)
  assert.equal(manifest.attemptLedger.sha256, sha256Text(readFileSync(planRun.attemptsPath, 'utf8')))
  assert.ok(manifest.files.length >= 5)
  const attempts = JSON.parse(readFileSync(planRun.attemptsPath, 'utf8'))
  assert.equal(attempts.attempts.length, 1)
  assert.match(readFileSync(planRun.propertiesChange.proposed, 'utf8'), /^level-name=m3clean-prep$/m)
  assert.equal(statSync(planRun.propertiesChange.proposed).mode & 0o777, 0o600, 'staged server properties may contain RCON material and stay owner-readable only')
  assert.match(readFileSync(join(planRun.runDir, 'server-properties.diff.txt'), 'utf8'), /level-seed: 2024 -> 998877665544/)
  const operatorCommands = readFileSync(join(planRun.runDir, 'operator-commands.txt'), 'utf8')
  assert.match(operatorCommands, /m3-acceptance-bundle\.mjs/)
  assert.match(operatorCommands, /systemd-run/)
  assert.match(operatorCommands, /Restart=no/)
  assert.match(operatorCommands, /agent-runner\.mts/)
  assert.doesNotMatch(operatorCommands, /resident-supervisor\.mjs|Restart=on-failure/)
  assert.ok(operatorCommands.indexOf('clean-run-resident-control.mjs') < operatorCommands.indexOf('clean-run-server-launch.mjs'), 'legacy resident shutdown must precede clean Leaf startup')
  const acceptanceRecipe = readFileSync(join(REPO_ROOT, 'CLEAN-RUN-ACCEPTANCE.md'), 'utf8')
  assert.match(acceptanceRecipe, /clean-run-resident-control\.mjs/)
  assert.match(acceptanceRecipe, /clean-run-acceptance-refresh\.mjs/)
  assert.match(acceptanceRecipe, /--unit=ai-buddy-clean-leaf/)
  assert.match(acceptanceRecipe, /StandardOutput=append:/)
  assert.doesNotMatch(acceptanceRecipe, /socat|UNIX-CONNECT|control-quit/)
  // the resolved descriptor is CLEAN and consumable by the canonical bundle
  const cleanCheck = validateCleanEnvironment(resolved, { descriptorPath: resolvedPath, worldContainer: container })
  assert.equal(cleanCheck.status, 'CLEAN', cleanCheck.failed.join(','))
  ok('G2. --apply stages the clean world dir + gamerule datapack + resolved descriptor + manifest + attempt ledger')

  // G3. idempotency
  const replan = planPrepare({ descriptorPath, serverRoot: container, root: operatorRoot, enforceOperatorTreeSource: true, levelName: 'm3clean-prep', seed: '998877665544', sourceSha: prepareSourceSha })
  const reapplied = applyPlan(replan)
  assert.equal(reapplied.status, 'IDEMPOTENT_NOOP')
  assert.deepEqual(reapplied.applied, [])
  assert.ok(reapplied.unchanged.length >= 4)
  assert.equal(JSON.parse(readFileSync(planRun.attemptsPath, 'utf8')).attempts.length, 1, 'a re-apply is not a new attempt')
  ok('G3. a second --apply is an IDEMPOTENT_NOOP (no rewrite, no new attempt)')

  // Symlink targets are rejected at planning time, and again immediately before
  // apply so a link created after a valid dry-run cannot redirect proof writes.
  function makeSymlinkContainer(name) {
    const path = join(root, name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'server.properties'), 'level-name=world\nlevel-seed=2024\ndifficulty=normal\nserver-port=25565\n', 'utf8')
    writeFileSync(join(path, 'leaf-1.21.11-178.jar'), 'symlink refusal Leaf identity fixture')
    return path
  }
  const symlinkContainer = makeSymlinkContainer('symlink-target-container')
  const symlinkPlan = planPrepare({ descriptorPath, serverRoot: symlinkContainer, root: operatorRoot, levelName: 'm3clean-symlink-target', seed: '998877665546', sourceSha: prepareSourceSha })
  mkdirSync(symlinkPlan.runDir, { recursive: true })
  const sentinel = join(root, 'symlink-target-sentinel.txt')
  writeFileSync(sentinel, 'must remain untouched\n', 'utf8')
  symlinkSync(sentinel, join(symlinkPlan.runDir, 'server.properties.clean'))
  const refusedSymlinkPlan = planPrepare({ descriptorPath, serverRoot: symlinkContainer, root: operatorRoot, levelName: 'm3clean-symlink-target', seed: '998877665546', sourceSha: prepareSourceSha })
  assert.equal(refusedSymlinkPlan.status, 'REFUSED')
  assert.ok(refusedSymlinkPlan.refusals.some((entry) => /symlinked_or_aliased_planned_path/.test(entry.reason)))
  assert.equal(refusedSymlinkPlan.guards.find((guard) => guard.id === 'no_symlinked_planned_paths')?.verdict, 'FAIL')
  assert.equal(readFileSync(sentinel, 'utf8'), 'must remain untouched\n')

  const hardlinkContainer = makeSymlinkContainer('hardlink-target-container')
  const hardlinkPlan = planPrepare({ descriptorPath, serverRoot: hardlinkContainer, root: operatorRoot, levelName: 'm3clean-hardlink-target', seed: '998877665549', sourceSha: prepareSourceSha })
  mkdirSync(hardlinkPlan.runDir, { recursive: true })
  const hardlinkSentinel = join(root, 'hardlink-target-sentinel.txt')
  writeFileSync(hardlinkSentinel, 'must remain untouched\n', 'utf8')
  linkSync(hardlinkSentinel, join(hardlinkPlan.runDir, 'server.properties.clean'))
  const refusedHardlinkPlan = planPrepare({ descriptorPath, serverRoot: hardlinkContainer, root: operatorRoot, levelName: 'm3clean-hardlink-target', seed: '998877665549', sourceSha: prepareSourceSha })
  assert.equal(refusedHardlinkPlan.status, 'REFUSED')
  assert.ok(refusedHardlinkPlan.refusals.some((entry) => /hardlinked_target/.test(entry.reason)))
  assert.equal(statSync(hardlinkSentinel).nlink, 2)
  assert.equal(readFileSync(hardlinkSentinel, 'utf8'), 'must remain untouched\n')

  const ancestorContainer = makeSymlinkContainer('symlink-ancestor-container')
  const ancestorPlan = planPrepare({ descriptorPath, serverRoot: ancestorContainer, root: operatorRoot, levelName: 'm3clean-symlink-ancestor', seed: '998877665548', sourceSha: prepareSourceSha })
  const outsideStageRoot = join(root, 'outside-stage-root')
  mkdirSync(outsideStageRoot)
  symlinkSync(outsideStageRoot, ancestorPlan.runRootDir, 'dir')
  const refusedAncestorPlan = planPrepare({ descriptorPath, serverRoot: ancestorContainer, root: operatorRoot, levelName: 'm3clean-symlink-ancestor', seed: '998877665548', sourceSha: prepareSourceSha })
  assert.equal(refusedAncestorPlan.status, 'REFUSED')
  assert.ok(refusedAncestorPlan.refusals.some((entry) => /symlinked_or_aliased_planned_path/.test(entry.reason)))
  assert.equal(readdirSync(outsideStageRoot).length, 0, 'a symlinked run-root ancestor is rejected before staging')

  const symlinkRaceContainer = makeSymlinkContainer('symlink-apply-race-container')
  const symlinkRacePlan = planPrepare({ descriptorPath, serverRoot: symlinkRaceContainer, root: operatorRoot, levelName: 'm3clean-symlink-race', seed: '998877665547', sourceSha: prepareSourceSha })
  assert.equal(symlinkRacePlan.status, 'PLANNED')
  mkdirSync(symlinkRacePlan.runDir, { recursive: true })
  const raceSentinel = join(root, 'symlink-race-sentinel.txt')
  writeFileSync(raceSentinel, 'must remain untouched\n', 'utf8')
  symlinkSync(raceSentinel, join(symlinkRacePlan.runDir, 'server.properties.clean'))
  const refusedRaceApply = applyPlan(symlinkRacePlan)
  assert.equal(refusedRaceApply.status, 'REFUSED')
  assert.equal(refusedRaceApply.applied, 0)
  assert.equal(refusedRaceApply.guards.find((guard) => guard.id === 'no_symlinked_planned_paths')?.verdict, 'FAIL')
  assert.equal(readFileSync(raceSentinel, 'utf8'), 'must remain untouched\n')
  assert.equal(existsSync(symlinkRacePlan.attemptsPath), false, 'the apply-time refusal must precede ledger writes')
  assert.equal(existsSync(symlinkRacePlan.manifestPath), false, 'the apply-time refusal must precede manifest writes')
  ok('G3b. symlink aliases and hard-linked targets fail during planning; apply-time recheck refuses new symlinks before ledger writes')

  // G3a. a different clean target gets a separate evidence directory; the
  // prior target's operator-filled transcript and manifest remain byte-identical.
  const firstTranscript = join(planRun.runDir, 'gamerule-verification.txt')
  const transcriptBefore = `${readFileSync(firstTranscript, 'utf8')}operatorEvidence=preserve-this-target\n`
  writeFileSync(firstTranscript, transcriptBefore, 'utf8')
  const secondPlan = planPrepare({
    descriptorPath,
    serverRoot: container,
    levelName: 'm3clean-prep-two',
    seed: '998877665545',
    root: operatorRoot,
    enforceOperatorTreeSource: true,
    sourceSha: prepareSourceSha,
  })
  assert.equal(secondPlan.status, 'PLANNED')
  assert.notEqual(secondPlan.runDir, planRun.runDir)
  assert.notEqual(secondPlan.manifestPath, planRun.manifestPath)
  assert.equal(secondPlan.attemptsPath, planRun.attemptsPath, 'the used-seed ledger spans target-scoped evidence directories')
  const secondApplied = applyPlan(secondPlan)
  assert.equal(secondApplied.status, 'APPLIED')
  assert.equal(readFileSync(firstTranscript, 'utf8'), transcriptBefore, 'a later target must not overwrite earlier run evidence')
  assert.match(readFileSync(join(secondPlan.runDir, 'gamerule-verification.txt'), 'utf8'), /levelName=m3clean-prep-two/)
  assert.equal(JSON.parse(readFileSync(planRun.attemptsPath, 'utf8')).attempts.length, 2)
  ok('G3a. distinct targets keep separate manifest, environment, and gamerule evidence while sharing the seed ledger')

  // G3b. M3 seeds are reserved across target names. The old b1 seed is rejected
  // under a different name, while the fresh active c1 seed remains admissible.
  const attemptsLedger = JSON.parse(readFileSync(planRun.attemptsPath, 'utf8'))
  attemptsLedger.attempts.push({ levelName: 'm3clean-b1', levelSeed: '-4187923615481', preparedAt: 'historical-b1-fixture' })
  writeFileSync(planRun.attemptsPath, `${JSON.stringify(attemptsLedger, null, 2)}\n`, 'utf8')
  const c1Descriptor = resolvedDescriptor(root, {
    levelName: 'm3clean-c1',
    levelSeed: '4500764503965322344',
    sourceSha: prepareSourceSha,
    container,
    withPreparationProof: false,
    mutate: (doc) => { delete doc.cleanRun.runtimePolicy },
  })
  const c1Plan = planPrepare({
    descriptorPath: c1Descriptor.path,
    serverRoot: container,
    root: operatorRoot,
    enforceOperatorTreeSource: true,
    sourceSha: prepareSourceSha,
  })
  assert.equal(c1Plan.status, 'PLANNED', `fresh c1 seed must be accepted: ${c1Plan.refusals.map((entry) => entry.reason).join('|')}`)
  assert.equal(c1Plan.levelName, 'm3clean-c1')
  assert.equal(c1Plan.levelSeed, '4500764503965322344')
  assert.equal(c1Plan.overridesApplied.some((entry) => entry.startsWith('cleanRun.runtimePolicy=derived from ')), true)
  const renamedB1 = planPrepare({
    descriptorPath: c1Descriptor.path,
    serverRoot: container,
    root: operatorRoot,
    enforceOperatorTreeSource: true,
    levelName: 'm3clean-c1-renamed',
    seed: '-4187923615481',
    sourceSha: prepareSourceSha,
  })
  assert.equal(renamedB1.status, 'REFUSED')
  assert.match(renamedB1.refusals.map((entry) => entry.reason).join(' | '), /seed_already_used:.*m3clean-b1.*all M3 target names/)
  ok('G3b. fresh c1 is accepted with derived runtime policy; the historical b1 seed is rejected across level names')

  // G4. refusals, each with the EXACT reason it must give
  const basePlan = { descriptorPath, serverRoot: container, root: operatorRoot, enforceOperatorTreeSource: true, levelName: 'm3clean-prep', seed: '998877665544', sourceSha: prepareSourceSha }
  const cases = [
    { id: 'world already generated', touchLevelDat: true, expect: /world already GENERATED|world_already_generated/ },
    { id: 'protected level name', over: { levelName: 'world' }, expect: /descriptor\.levelNameNew/ },
    { id: 'live seed 2024', over: { seed: '2024' }, expect: /descriptor\.levelSeedNew/ },
    { id: 'server-root is inside the target world dir', over: { serverRoot: join(container, 'm3clean-prep') }, expect: /server_root_inside_target_world/ },
    { id: 'unfrozen template (no --source-sha)', over: { descriptorPath: TEMPLATE, sourceSha: null, root: null, enforceOperatorTreeSource: false }, expect: /descriptor\.sourceSha/ },
    { id: 'a new seed reusing the staged level name', over: { seed: '112233445566' }, expect: /target_level_name_exists/ },
  ]
  for (const entry of cases) {
    if (entry.touchLevelDat === true) writeFileSync(join(container, 'm3clean-prep', 'level.dat'), 'fixture', 'utf8')
    const planned = planPrepare({ ...basePlan, ...(entry.over ?? {}) })
    assert.equal(planned.status, 'REFUSED', `refusal ${entry.id}: status=${planned.status}`)
    assert.match(planned.refusals.map((refusal) => refusal.reason).join(' | '), entry.expect, `refusal ${entry.id} reasons: ${planned.refusals.map((refusal) => refusal.reason).join(' | ')}`)
    if (entry.touchLevelDat === true) rmSync(join(container, 'm3clean-prep', 'level.dat'))
  }
  const changedSourceRetry = planPrepare({
    ...basePlan,
    root: null,
    enforceOperatorTreeSource: false,
    sourceSha: '2'.repeat(40),
  })
  assert.equal(changedSourceRetry.status, 'REFUSED')
  assert.match(changedSourceRetry.refusals.map((entry) => entry.reason).join(' | '), /seed_already_used/)
  // the SAME descriptor+name+seed on an ungenerated staged world is the
  // idempotent path, not a refusal (and it says so)
  const idempotent = planPrepare(basePlan)
  assert.equal(idempotent.status, 'PLANNED')
  assert.ok(idempotent.warnings.some((warning) => /idempotent no-op/.test(warning)))
  ok(`G4. ${cases.length} prepare refusal paths plus changed-source retry, each with its exact reason (generated world / protected name / live seed / server-root inside target / unfrozen template / level-name reuse)`)

  // A world can be generated after planning but before the write phase. The
  // apply-time guard must repeat the absence check so no manifest can falsely
  // claim that a pre-existing target was clean at preparation.
  const raceRoot = makeRoot('prepare-world-created-after-plan')
  const raceContainer = join(SCRATCH, 'prepare-world-created-after-plan-container')
  mkdirSync(raceContainer, { recursive: true })
  writeFileSync(join(raceContainer, 'leaf-1.21.11-178.jar'), 'fixture Leaf identity', 'utf8')
  const raceDescriptor = resolvedDescriptor(raceRoot, {
    levelName: 'm3clean-race',
    levelSeed: '998877665546',
    sourceSha: prepareSourceSha,
    container: raceContainer,
    withPreparationProof: false,
  })
  const racePlan = planPrepare({
    descriptorPath: raceDescriptor.path,
    serverRoot: raceContainer,
    sourceSha: prepareSourceSha,
    levelName: 'm3clean-race',
    seed: '998877665546',
  })
  assert.equal(racePlan.status, 'PLANNED', `race plan refusals=${racePlan.refusals.map((entry) => entry.reason).join(' | ')}`)
  const raceWorldDir = join(raceContainer, 'm3clean-race')
  mkdirSync(raceWorldDir, { recursive: true })
  writeFileSync(join(raceWorldDir, 'level.dat'), 'generated after planning\n', 'utf8')
  const raceApply = applyPlan(racePlan)
  assert.equal(raceApply.status, 'REFUSED')
  assert.match(raceApply.refusals.map((entry) => entry.reason).join(' | '), /target_world_generated_before_apply/)
  assert.equal(existsSync(racePlan.manifestPath ?? join(raceContainer, 'm3-clean-run', 'm3clean-race', 'manifest.json')), false)
  assert.equal(existsSync(join(raceWorldDir, 'level.dat')), true, 'the generated target remains untouched')
  ok('G4a. a target generated after planning is refused before any prepare manifest is written')
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
