#!/usr/bin/env bun
// m3-chain-rehearsal: offline, server-less rehearsal of the REAL M3 endgame chain.
//
// WHY
// ---
// M3 acceptance is judged by tools/m3-gate.mjs --run <runId>, whose terminal
// predicate is ONE inventory threshold: `ender_eye >= 12`. The live resident can
// only reach that threshold after a long run: the Nether trip, a fortress, 7
// blaze rods and 12 ender pearls. tools/m2-chain-rehearsal.mjs (PR #340) proved
// offline that the resident's OWN portal plan emits exactly the marker order the
// M2 gate requires. Nothing equivalent existed for M3, so a threshold, ordering
// or item-id bug in the 12-eye endgame would only surface at the very end of
// that run.
//
// WHAT THIS DOES (no Minecraft server or external network)
// -----------------------------------------------
// 1. Drives the REAL terminal craft path -- the same entry points the controller
//    uses, `generateGroundedCandidates` (jev-agent/src/candidates.ts) and
//    `planNextCraftStep` (jev-agent/src/crafting.ts), imported verbatim -- for the
//    exact endgame inventory: `ender_pearl: 12`, `blaze_rod: 7`, no eyes. It
//    applies only the recipe's own mechanical effect and records the emitted
//    candidate sequence until no CRAFT candidate remains.
// 2. Asserts the path emits `CRAFT:ender_eye` repeatedly until 12 eyes are held
//    and then STOPS (WAIT only), and that the multi-count `want` threading fixed
//    in 30dec38 is what keeps a partial count offered. The exact sequence is
//    reported (see M3_CHAIN_REHEARSAL_EYES).
// 3. Cross-checks the real ladder rung (buddy-driver/planner-legacy.ts), the real
//    planner and the real gate on the SAME threshold (12 eyes / 7 rods / 12
//    powder). Any disagreement is reported with file:line on both sides.
// 4. Materializes a synthetic single-run fixture (BOOT boundary + INVENTORY
//    samples taken from the real path's own trace + the GENERATION_READY /
//    decisions / HOST_LOCK authority lines the gate needs, mirroring
//    m2-chain-rehearsal.mjs) and invokes the REAL tools/m3-gate.mjs as a
//    subprocess. READY requires M3_RUN_RESULT status=PASS and exit 0.
// 5. Asserts the negatives against that same real subprocess: 11 eyes -> FAIL
//    (never PASS); no --run -> UNKNOWN/exit 2; inputs with no eyes -> never PASS;
//    a foreign run's eyes are never attributable to R; mixed-run evidence is not
//    joinable; eyes without model authority are UNKNOWN.
//
// The gate is never modified and no marker is invented: every synthetic line
// uses the same field names the runtime writes, and a mismatch between the real
// terminal path and the real gate is the deliverable, not something to paper
// over.
//
// Exit: 0 = READY, 1 = GAP.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { RUNGS } from '../buddy-driver/planner-legacy.ts'
import { defaultCandidateOptions, generateGroundedCandidates } from '../jev-agent/src/candidates.ts'
import { createRecipeIndex, planNextCraftStep } from '../jev-agent/src/crafting.ts'
import { loadGameData } from '../jev-agent/src/gameData.ts'
import {
  BLAZE_POWDER,
  BLAZE_POWDER_REQUIRED,
  BLAZE_ROD,
  BLAZE_ROD_REQUIRED,
  ENDER_EYE,
  ENDER_EYE_REQUIRED,
  ENDER_PEARL,
  ENDER_PEARL_REQUIRED,
  M3_REQUIRED_CONDITIONS,
  M3_RUN_RESULT,
} from './m3-gate.mjs'

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url))
export const M3_CHAIN_GATE_PATH = join(TOOLS_DIR, 'm3-gate.mjs')

// Synthetic source identity for offline gate fixtures. Every stream in each
// synthetic run writes this same exact SHA; it is not presented as live-source
// provenance.
const FIXTURE_SOURCE_SHA = 'b'.repeat(40)

// The real gate asks the HOST control socket for acceptance-time inventory.
// This fixture-only process speaks its read-only report protocol over a
// temporary Unix socket, with runId and sourceSha bound to the synthetic BOOT.
const REPORT_SOCKET_SERVER_SOURCE = `
const net = require('node:net')
const socketPath = process.env.M3_FIXTURE_SOCKET_PATH
const report = JSON.parse(process.env.M3_FIXTURE_REPORT_JSON)
const server = net.createServer((socket) => {
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    const newline = buffer.indexOf('\\n')
    if (newline < 0) return
    let request = {}
    try { request = JSON.parse(buffer.slice(0, newline)) } catch {}
    socket.end(JSON.stringify({ id: request.id ?? null, data: report }) + '\\n', () => {
      server.close(() => process.exit(0))
    })
  })
})
server.on('error', () => process.exit(1))
server.listen(socketPath)
`

/** 1 blaze_rod -> 2 blaze_powder (pinned by jev-agent/test-m3-terminal-craft.mts). */
export const POWDER_PER_ROD = 2

/** The exact endgame inventory: the ladder's `blaze_rods` rung + 12 pearls. */
export const M3_ENDGAME_INVENTORY = Object.freeze({
  [ENDER_PEARL]: ENDER_PEARL_REQUIRED,
  [BLAZE_ROD]: BLAZE_ROD_REQUIRED,
})

/**
 * The same inventory after ALL 7 rods are milled (7 -> 14 powder). Used to
 * isolate the eye stage: no rod descent is needed, so the path must emit twelve
 * `CRAFT:ender_eye` steps and then stop.
 */
export const M3_POST_POWDER_INVENTORY = Object.freeze({
  [ENDER_PEARL]: ENDER_PEARL_REQUIRED,
  [BLAZE_POWDER]: BLAZE_ROD_REQUIRED * POWDER_PER_ROD,
})

/** The real terminal rung's goal, read from the ladder (`planner-legacy.ts:685-689`). */
export const M3_TERMINAL_GOAL = Object.freeze({
  kind: 'craft',
  targetItem: ENDER_EYE,
  requiredCount: ENDER_EYE_REQUIRED,
})

/**
 * The exact code sites this rehearsal binds. Runtime checks are value-based; these
 * strings exist so a GAP can name BOTH sides with file:line instead of a guess.
 *
 * Line numbers re-measured against main `877c3ac` (2026-09-23). They had drifted
 * by 200+ lines on the ladder side, so a GAP report named the wrong sites - a
 * methodology/evidence-integrity defect (#63): a citation that no longer resolves
 * is worse than no citation, because it reads as verified.
 */
export const M3_CHAIN_SOURCES = Object.freeze({
  ladder_blaze_rods:
    'buddy-driver/planner-legacy.ts:675-679 id=blaze_rods satisfied blaze_rod>=7 / goals collect 7 x blaze_rod',
  ladder_ender_pearls:
    'buddy-driver/planner-legacy.ts:680-684 id=ender_pearls satisfied ender_pearl>=12 / goals collect 12 x ender_pearl',
  ladder_ender_eyes:
    'buddy-driver/planner-legacy.ts:685-689 id=ender_eyes satisfied ender_eye>=12 / goals craft 12 x ender_eye',
  terminal_goal_want:
    'jev-agent/src/candidates.ts:5920-5924 craftGoalRequirement(current.requiredCount) -> planNextCraftStep want',
  planner_want_check:
    'jev-agent/src/crafting.ts:201-208 planNextCraftStep(... want) + have(item, want)',
  gate_eye_threshold:
    'tools/milestone-predicates.mjs:43-44 ENDER_EYE=ender_eye ENDER_EYE_REQUIRED=12 (imported by tools/m3-gate.mjs:54-63)',
  gate_pearl_threshold:
    'tools/milestone-predicates.mjs:45-46 ENDER_PEARL=ender_pearl ENDER_PEARL_REQUIRED=12',
  gate_rod_threshold: 'tools/milestone-predicates.mjs:47-48 BLAZE_ROD=blaze_rod BLAZE_ROD_REQUIRED=7',
  gate_powder_threshold:
    'tools/milestone-predicates.mjs:49-50 BLAZE_POWDER=blaze_powder BLAZE_POWDER_REQUIRED=12',
  gate_eye_predicate:
    'tools/m3-gate.mjs:103-116 evaluateEnderEyes (ender_eye>=12; eye_of_ender is never an item)',
  /**
   * The two ACQUISITION steps this rehearsal deliberately does NOT model, named
   * so its coverage claim is honest: the endgame inventory is SEEDED with
   * `{ender_pearl: 12, blaze_rod: 7}`, so neither the kill nor the
   * drop->inventory pickup is exercised here. `jev-agent/test-eye-chain.mts` owns
   * those (a sensed dropped item entity is offered as a grounded `PICKUP` and
   * verified by the inventory delta), and `tools/m3-gate.mjs#evaluateEnderEyes`
   * observes ONLY inventory samples - it cannot see a kill or a pickup at all.
   */
  not_modelled_acquisition:
    'jev-agent/src/candidates.ts:10320-10365 pickupCandidates (dropped-item route NOT rehearsed here; endgame inventory is seeded) + jev-agent/test-eye-chain.mts:1 (owns the kill/drop/pickup shapes)',
})

/** One shared, read-only recipe index built from the pinned minecraft-data registry. */
const RECIPES = createRecipeIndex(loadGameData())

// ---------------------------------------------------------------------------
// the REAL craft path (the controller's own entry points)
// ---------------------------------------------------------------------------

function selfState(position) {
  return {
    username: 'M3_CHAIN_REHEARSAL',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'the_nether',
    isDay: false,
    heldItem: null,
  }
}

function inventoryState(counts) {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, count) => sum + count, 0) }
}

function emptySignals() {
  return {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastPathStatus: 'idle',
    stalledMs: 0,
    lastPolicyConfidence: null,
    maxConcurrentActions: 0,
    escalationRecommended: false,
    failedCandidates: {},
    knownResources: [],
  }
}

/** The world the controller would hand `generateGroundedCandidates` for `goal`. */
export function terminalWorldState(counts, goal = M3_TERMINAL_GOAL) {
  const position = { x: 0, y: 64, z: 0 }
  const haveCount = counts[goal.targetItem] ?? 0
  const current = {
    id: `g-${goal.targetItem}`,
    kind: goal.kind,
    description: `${goal.kind} ${goal.requiredCount} x ${goal.targetItem}`,
    targetItem: goal.targetItem,
    requiredCount: goal.requiredCount,
    startCount: 0,
    haveCount,
    status: 'active',
    origin: 'bootstrap',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
  const goalState = {
    id: current.id,
    description: current.description,
    targetItem: goal.targetItem,
    requiredCount: goal.requiredCount,
    startCount: 0,
    haveCount,
    progress: Math.min(1, haveCount / Math.max(1, goal.requiredCount)),
    complete: haveCount >= goal.requiredCount,
    startedAtMs: 0,
  }
  return {
    schemaVersion: 1,
    tick: 1,
    timestampMs: 1_700_000_000_000,
    self: selfState(position),
    inventory: inventoryState(counts),
    entities: [],
    blocks: [],
    terrain: { standable: [position] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: [],
    stepCuts: [],
    headroomCuts: [],
    goal: goalState,
    goalQueue: { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] },
    recentEvents: [],
    signals: emptySignals(),
  }
}

/**
 * The mechanical effect of one emitted craft, taken from the recipe index -- NOT
 * re-derived from the plan. `planNextCraftStep` returns only (item, count); the
 * executor consumes the recipe's ingredients, so that is what the rehearsal
 * applies. Ambiguity is reported, never guessed.
 */
export function craftEffect(item, resultCount) {
  const variants = RECIPES.recipesFor(item)
  if (variants.length === 0) return { ok: false, reason: `no_recipe item=${item}` }
  const matching = variants.filter((variant) => variant.resultCount === resultCount)
  if (matching.length !== 1) {
    return {
      ok: false,
      reason: `ambiguous_recipe item=${item} result=${resultCount} variants=${variants.length} matching=${matching.length}`,
    }
  }
  return { ok: true, variant: matching[0], consumes: matching[0].ingredients }
}

/**
 * Drive the REAL terminal craft path for `inventory` until no CRAFT candidate is
 * emitted (the stop) or `maxSteps` is hit. Pure and deterministic: no world, no
 * clock, no server, no network. Returns the full per-step trace.
 */
export function rehearseTerminalCraft({ inventory: startInventory, goal = M3_TERMINAL_GOAL, maxSteps = 64 } = {}) {
  const counts = { ...startInventory }
  const goalItem = goal.targetItem
  const steps = []
  const errors = []
  let stopped = false
  for (let index = 0; index < maxSteps; index += 1) {
    const have = counts[goalItem] ?? 0
    const state = terminalWorldState(counts, goal)
    const grounded = generateGroundedCandidates(state, { ...defaultCandidateOptions, recipes: RECIPES })
    const candidateIds = grounded.candidates.map((candidate) => candidate.id)
    // Independent second entry point: the controller's craft planner is asked the
    // same question for the SAME goal item, so ladder/planner/gate agree on want.
    const rootPlan = planNextCraftStep(RECIPES, goalItem, counts, false, goal.requiredCount)
    const craft = grounded.candidates.find((candidate) => candidate.kind === 'CRAFT') ?? null
    const step = {
      index,
      have,
      counts: { ...counts },
      candidateIds,
      craftId: craft?.id ?? null,
      craftItem: craft === null ? null : String(craft.meta?.craftItem ?? ''),
      craftCount: craft === null ? null : Number(craft.meta?.craftCount ?? 0),
      rootPlanOp: rootPlan.op,
      rootPlanReason: rootPlan.reason,
    }
    steps.push(step)
    if (craft === null) {
      stopped = true
      break
    }
    const item = step.craftItem
    const count = step.craftCount
    // The emitted candidate must BE the planner's own step (one implementation).
    if (rootPlan.op === null || rootPlan.op.type !== 'craft' || rootPlan.op.item !== item) {
      errors.push(`candidate_planner_disagreement step=${index} candidate=${craft.id} rootPlan=${JSON.stringify(rootPlan.op)}`)
      break
    }
    const effect = craftEffect(item, count)
    if (!effect.ok) {
      errors.push(`craft_effect_unresolved step=${index} ${effect.reason}`)
      break
    }
    for (const ingredient of effect.consumes) {
      counts[ingredient.item] = (counts[ingredient.item] ?? 0) - ingredient.count
      if (counts[ingredient.item] < 0) errors.push(`negative_inventory step=${index} item=${ingredient.item}`)
    }
    counts[item] = (counts[item] ?? 0) + count
  }
  if (!stopped && errors.length === 0) errors.push(`craft_path_did_not_stop steps=${maxSteps}`)

  const craftSteps = steps.filter((step) => step.craftItem !== null)
  const craftSequence = craftSteps.map((step) => `${step.craftItem}x${step.craftCount}`)
  const stageOrder = []
  const stageSet = []
  for (const step of craftSteps) if (stageOrder.at(-1) !== step.craftItem) stageOrder.push(step.craftItem)
  for (const step of craftSteps) if (!stageSet.includes(step.craftItem)) stageSet.push(step.craftItem)
  const eyeSteps = steps.filter((step) => step.craftItem === goalItem)
  const eyes = counts[goalItem] ?? 0
  const eyesTrace = [
    ...eyeSteps.map((step) => `${step.have}->craft`),
    `${eyes}->${stopped ? 'stop' : 'cap'}`,
  ].join(' ')
  return {
    goal,
    startInventory: { ...startInventory },
    steps,
    errors,
    stopped,
    finalInventory: { ...counts },
    inventoryTrace: steps.map((step) => ({ ...step.counts })).concat([{ ...counts }]),
    craftSequence,
    stageOrder,
    stageSet,
    craftCount: craftSteps.length,
    enderEyeCrafts: eyeSteps.length,
    eyes,
    eyesTrace,
    powderCrafts: craftSteps.filter((step) => step.craftItem === BLAZE_POWDER).length,
    rodsConsumed: (startInventory[BLAZE_ROD] ?? 0) - (counts[BLAZE_ROD] ?? 0),
  }
}

// ---------------------------------------------------------------------------
// synthetic single-run fixture (log + runner.out + decisions + snapshot dir)
// ---------------------------------------------------------------------------

const RUN_ID = 'run-m3-rehearsal'
const OTHER_RUN_ID = 'run-m3-foreign'
const FIXTURE_PID = 4242

function stamp(seconds) {
  return new Date(Date.UTC(2026, 8, 21, 10, 0, seconds)).toISOString()
}

/**
 * Materialize one offline fixture directory.
 *
 * `runs` is an ordered list of `{ runId, samples }`: each entry opens a BOOT
 * boundary and writes its INVENTORY samples (attributed to that run by the real
 * gate's `scanRunLines`). With `includeAuthority`, runner.out gets the exact
 * GENERATION_READY / HOST_LOCK facts the policy reader brackets and
 * decisions.jsonl gets `source=jev` records inside each window. Every case gets
 * its own directory so evidence can never bleed across cases.
 */
export function materializeSyntheticRun({ caseName, runs, includeAuthority = true }) {
  const dir = mkdtempSync(join(tmpdir(), `m3-chain-${caseName}-`))
  const snapshotDir = join(dir, 'snapshots')
  mkdirSync(snapshotDir)
  const logLines = []
  const runnerOutLines = []
  const decisionsLines = []
  runs.forEach((run, index) => {
    const base = index * 10
    const bootLine = `[${stamp(base)}] BOOT pid=${FIXTURE_PID} runId=${run.runId} bundle=none source=${FIXTURE_SOURCE_SHA} worldEpoch=1`
    logLines.push(bootLine)
    runnerOutLines.push(bootLine)
    if (includeAuthority) {
      runnerOutLines.push(
        `[${stamp(base + 1)}] GENERATION_READY generation=${index + 1} policy=typesafe model=typesafe-ai/jev ` +
          `planner=llm deterministicFallbackEnabled=false`,
      )
    }
    run.samples.forEach((sample, sampleIndex) => {
      logLines.push(`[${stamp(base + 2 + sampleIndex)}] INVENTORY items=${JSON.stringify(sample)} pos=10,64,20`)
    })
    // M3 requires live proof of Nether arrival (`nether_reached`), so every modelled run records the
    // dimension it observed. The default is the Nether because this fixture IS the M3 endgame scenario;
    // a case that wants the "twelve eyes but never left the overworld" negative sets
    // `dimension: 'minecraft:overworld'` on its run and must then expect UNKNOWN, not PASS.
    logLines.push(
      `[${stamp(base + 2 + run.samples.length)}] DIMENSION_OBSERVED dimension=${run.dimension ?? 'minecraft:the_nether'} runId=${run.runId}`,
    )
    if (includeAuthority) {
      decisionsLines.push(
        JSON.stringify({
          record: 'decision',
          ts: stamp(base + 3),
          runId: run.runId,
          source: 'jev',
          kind: 'craft',
          reason: 'fixture:model_authored_jev_decision',
        }),
      )
      decisionsLines.push(
        JSON.stringify({
          record: 'decision',
          ts: stamp(base + 4),
          runId: run.runId,
          source: 'jev',
          kind: 'craft',
          reason: 'fixture:model_authored_jev_decision',
        }),
      )
    }
  })
  if (includeAuthority) {
    runnerOutLines.push(
      `[${stamp(runs.length * 10 + 5)}] HOST_LOCK released pid=${FIXTURE_PID} runId=${runs[runs.length - 1].runId}`,
    )
  }
  writeFileSync(join(dir, 'buddy.log'), `${logLines.join('\n')}\n`)
  writeFileSync(join(dir, 'runner.out'), `${runnerOutLines.join('\n')}\n`)
  writeFileSync(join(dir, 'decisions.jsonl'), `${decisionsLines.join('\n')}\n`)
  return {
    dir,
    runId: runs[0].runId,
    runs,
    logPath: join(dir, 'buddy.log'),
    snapshotDir,
    decisionsPath: join(dir, 'decisions.jsonl'),
    runnerOutPath: join(dir, 'runner.out'),
    // runRealGate starts a one-shot fixture HOST report responder at this local socket path.
    controlSocketPath: join(dir, 'control.sock'),
  }
}

/**
 * Invoke the REAL tools/m3-gate.mjs as a subprocess and parse its verdict.
 * `expectedRunId: null` omits `--run` (the no-scope negative) and
 * `dropRunIdEnv: true` removes the M3_RUN_ID fallback so that negative is
 * deterministic even if the caller's shell exported one.
 */
export function runRealGate({
  fixture,
  expectedRunId = fixture.runId,
  gatePath = M3_CHAIN_GATE_PATH,
  runtime = process.execPath,
  dropRunIdEnv = false,
} = {}) {
  const fixtureRuns = Array.isArray(fixture.runs) ? fixture.runs : []
  const boundRun = expectedRunId === null ? null : fixtureRuns.find((run) => run.runId === expectedRunId) ?? null
  const terminalInventory = boundRun === null
    ? null
    : boundRun.terminalInventory ?? boundRun.samples.at(-1) ?? {}
  const dimension = boundRun?.dimension ?? 'minecraft:the_nether'
  const observedAt = stamp(50 + Math.max(0, fixtureRuns.indexOf(boundRun)) * 10)
  const report = boundRun === null
    ? null
    : {
        runId: boundRun.runId,
        currentInventoryObservation: {
          record: 'current-inventory-observation',
          schemaVersion: 1,
          runId: boundRun.runId,
          sourceSha: FIXTURE_SOURCE_SHA,
          generationId: 'fixture-' + boundRun.runId,
          observedAtMs: Date.parse(observedAt),
          observedAt,
          worldKey: { serverId: 'fixture:offline', dimension, worldEpoch: 1 },
          dimension,
          counts: terminalInventory,
        },
      }
  let reportServer = null
  if (report !== null) {
    const socketEnv = {
      ...process.env,
      M3_FIXTURE_SOCKET_PATH: fixture.controlSocketPath,
      M3_FIXTURE_REPORT_JSON: JSON.stringify(report),
    }
    reportServer = Bun.spawn({
      cmd: [runtime, '-e', REPORT_SOCKET_SERVER_SOURCE],
      env: socketEnv,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    for (let attempt = 0; attempt < 100 && !existsSync(fixture.controlSocketPath); attempt += 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
    if (!existsSync(fixture.controlSocketPath)) {
      reportServer.kill()
      throw new Error('fixture report socket failed to start for ' + boundRun.runId)
    }
  }
  const cmd = [runtime, gatePath]
  if (expectedRunId !== null) cmd.push('--run', expectedRunId)
  cmd.push(
    '--log',
    fixture.logPath,
    '--snapshot-dir',
    fixture.snapshotDir,
    '--decisions',
    fixture.decisionsPath,
    '--runner-out',
    fixture.runnerOutPath,
    '--control-socket',
    fixture.controlSocketPath,
  )
  const env = { ...process.env }
  if (dropRunIdEnv) {
    delete env.M3_RUN_ID
    delete env.M2_RUN_ID
  }
  let proc
  try {
    proc = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe', env })
  } finally {
    if (reportServer !== null && reportServer.exitCode === null) reportServer.kill()
  }
  const stdout = proc.stdout.toString('utf8')
  const stderr = proc.stderr.toString('utf8')
  const resultLine = stdout.split('\n').find((line) => line.startsWith(`${M3_RUN_RESULT} `)) ?? null
  return {
    cmd,
    exitCode: proc.exitCode,
    stdout,
    stderr,
    resultLine,
    status: resultLine === null ? null : /\bstatus=(\S+)/.exec(resultLine)?.[1] ?? null,
    reason: resultLine === null ? null : /\breason=(\S+)/.exec(resultLine)?.[1] ?? null,
    conditionLines: stdout
      .split('\n')
      .filter((line) => M3_REQUIRED_CONDITIONS.some((condition) => line.startsWith(`${condition}: `))),
  }
}

function gateCase({ missing, write, caseName, runs, expectedRunId, includeAuthority = true, dropRunIdEnv = false, expect }) {
  const fixture = materializeSyntheticRun({ caseName, runs, includeAuthority })
  let result
  try {
    result = runRealGate({ fixture, expectedRunId, dropRunIdEnv })
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true })
  }
  write(
    `M3_CHAIN_REHEARSAL_GATE case=${caseName} expected=${expectedRunId ?? 'none'} status=${result.status} ` +
      `reason=${result.reason} exit=${result.exitCode} conditions=[${result.conditionLines.join(' ')}]`,
  )
  write(`M3_CHAIN_REHEARSAL_GATE_RESULT case=${caseName} ${result.resultLine ?? `${M3_RUN_RESULT} missing`}`)
  const problems = expect(result)
  for (const problem of problems) missing.push(`${caseName}:${problem}`)
  return result
}

// ---------------------------------------------------------------------------
// ladder / planner / gate threshold agreement
// ---------------------------------------------------------------------------

/**
 * Cross-check the REAL ladder rung, the REAL planner and the REAL gate on the
 * same endgame numbers. Returns `{ errors, facts }`; every error names both
 * sides with the source table above.
 */
export function checkThresholdsAndRungs() {
  const errors = []
  const facts = {}

  const blazeRodsRung = RUNGS.find((rung) => rung.id === 'blaze_rods')
  const enderPearlsRung = RUNGS.find((rung) => rung.id === 'ender_pearls')
  const enderEyesRung = RUNGS.find((rung) => rung.id === 'ender_eyes')
  if (blazeRodsRung === undefined) errors.push(`ladder_rung_missing id=blaze_rods (${M3_CHAIN_SOURCES.ladder_blaze_rods})`)
  if (enderPearlsRung === undefined) errors.push(`ladder_rung_missing id=ender_pearls (${M3_CHAIN_SOURCES.ladder_ender_pearls})`)
  if (enderEyesRung === undefined) errors.push(`ladder_rung_missing id=ender_eyes (${M3_CHAIN_SOURCES.ladder_ender_eyes})`)

  const noWorld = {}
  const eyesGoals = enderEyesRung?.goals({}, noWorld) ?? []
  const eyesGoal = eyesGoals[0] ?? null
  const rodsGoals = blazeRodsRung?.goals({}, noWorld) ?? []
  const rodsGoal = rodsGoals[0] ?? null
  const pearlsGoals = enderPearlsRung?.goals({}, noWorld) ?? []
  const pearlsGoal = pearlsGoals[0] ?? null

  facts.ladderEnderEyesGoal = eyesGoal
  facts.ladderBlazeRodsGoal = rodsGoal
  facts.ladderEnderPearlsGoal = pearlsGoal

  if (eyesGoal?.kind !== 'craft' || eyesGoal?.targetItem !== ENDER_EYE) {
    errors.push(
      `ladder_vs_gate_item disagreement ladder=${JSON.stringify(eyesGoal)} (${M3_CHAIN_SOURCES.ladder_ender_eyes}) ` +
        `gate=${ENDER_EYE} (${M3_CHAIN_SOURCES.gate_eye_threshold})`,
    )
  }
  if (eyesGoal?.requiredCount !== ENDER_EYE_REQUIRED) {
    errors.push(
      `ladder_vs_gate_threshold disagreement ladder_requiredCount=${String(eyesGoal?.requiredCount)} ` +
        `(${M3_CHAIN_SOURCES.ladder_ender_eyes}) gate_ENDER_EYE_REQUIRED=${ENDER_EYE_REQUIRED} (${M3_CHAIN_SOURCES.gate_eye_threshold})`,
    )
  }
  if (enderEyesRung?.satisfied({ [ENDER_EYE]: ENDER_EYE_REQUIRED - 1 }, noWorld) !== false) {
    errors.push(`ladder_satisfied_at_${ENDER_EYE_REQUIRED - 1} must be false (${M3_CHAIN_SOURCES.ladder_ender_eyes})`)
  }
  if (enderEyesRung?.satisfied({ [ENDER_EYE]: ENDER_EYE_REQUIRED }, noWorld) !== true) {
    errors.push(`ladder_satisfied_at_${ENDER_EYE_REQUIRED} must be true (${M3_CHAIN_SOURCES.ladder_ender_eyes})`)
  }
  if (rodsGoal?.kind !== 'collect' || rodsGoal?.targetItem !== BLAZE_ROD || rodsGoal?.requiredCount !== BLAZE_ROD_REQUIRED) {
    errors.push(
      `ladder_vs_gate_rod_goal disagreement ladder=${JSON.stringify(rodsGoal)} (${M3_CHAIN_SOURCES.ladder_blaze_rods}) ` +
        `gate BLAZE_ROD_REQUIRED=${BLAZE_ROD_REQUIRED} (${M3_CHAIN_SOURCES.gate_rod_threshold})`,
    )
  }
  if (blazeRodsRung?.satisfied({ [BLAZE_ROD]: BLAZE_ROD_REQUIRED - 1 }, noWorld) !== false) {
    errors.push(`ladder_blaze_rods_satisfied_at_${BLAZE_ROD_REQUIRED - 1} must be false (${M3_CHAIN_SOURCES.ladder_blaze_rods})`)
  }
  if (blazeRodsRung?.satisfied({ [BLAZE_ROD]: BLAZE_ROD_REQUIRED }, noWorld) !== true) {
    errors.push(`ladder_blaze_rods_satisfied_at_${BLAZE_ROD_REQUIRED} must be true (${M3_CHAIN_SOURCES.ladder_blaze_rods})`)
  }
  if (pearlsGoal?.targetItem !== ENDER_PEARL || pearlsGoal?.requiredCount !== ENDER_PEARL_REQUIRED) {
    errors.push(
      `ladder_vs_gate_pearl_goal disagreement ladder=${JSON.stringify(pearlsGoal)} (${M3_CHAIN_SOURCES.ladder_ender_pearls}) ` +
        `gate ENDER_PEARL_REQUIRED=${ENDER_PEARL_REQUIRED} (${M3_CHAIN_SOURCES.gate_pearl_threshold})`,
    )
  }

  // Arithmetic: 12 eyes need 12 powder; 1 rod -> 2 powder; the rung's 7 rods are
  // a deliberate surplus. A gate/powder mismatch here would be an off-by-one.
  const powderNeeded = ENDER_EYE_REQUIRED
  const rodsExact = Math.ceil(powderNeeded / POWDER_PER_ROD)
  facts.powderNeeded = powderNeeded
  facts.rodsExact = rodsExact
  facts.rodSurplus = BLAZE_ROD_REQUIRED - rodsExact
  facts.powderYield = BLAZE_ROD_REQUIRED * POWDER_PER_ROD
  if (powderNeeded !== BLAZE_POWDER_REQUIRED) {
    errors.push(
      `gate_eye_vs_powder_threshold disagreement eyes=${ENDER_EYE_REQUIRED} (${M3_CHAIN_SOURCES.gate_eye_threshold}) ` +
        `powder=${BLAZE_POWDER_REQUIRED} (${M3_CHAIN_SOURCES.gate_powder_threshold})`,
    )
  }
  if (facts.powderYield < powderNeeded) {
    errors.push(
      `ladder_rod_threshold_undersupplies rods=${BLAZE_ROD_REQUIRED} yield=${facts.powderYield} needed=${powderNeeded} ` +
        `(${M3_CHAIN_SOURCES.ladder_blaze_rods}) (${M3_CHAIN_SOURCES.gate_powder_threshold})`,
    )
  }

  // Recipe truth: 1 pearl + 1 powder -> 1 eye; 1 rod -> 2 powder.
  const eyeVariants = RECIPES.recipesFor(ENDER_EYE)
  const powderVariants = RECIPES.recipesFor(BLAZE_POWDER)
  const eyeVariant = eyeVariants[0]
  const powderVariant = powderVariants[0]
  facts.eyeRecipe = eyeVariant === undefined ? null : {
    resultCount: eyeVariant.resultCount,
    requiresTable: eyeVariant.requiresTable,
    ingredients: eyeVariant.ingredients,
  }
  facts.powderRecipe = powderVariant === undefined ? null : {
    resultCount: powderVariant.resultCount,
    requiresTable: powderVariant.requiresTable,
    ingredients: powderVariant.ingredients,
  }
  const eyePearl = eyeVariant?.ingredients.find((entry) => entry.item === ENDER_PEARL)?.count ?? 0
  const eyePowder = eyeVariant?.ingredients.find((entry) => entry.item === BLAZE_POWDER)?.count ?? 0
  if (eyeVariants.length !== 1 || eyeVariant?.resultCount !== 1 || eyePearl !== 1 || eyePowder !== 1) {
    errors.push(
      `recipe_truth_ender_eye disagreement variants=${eyeVariants.length} result=${String(eyeVariant?.resultCount)} ` +
        `pearl=${eyePearl} powder=${eyePowder} (${M3_CHAIN_SOURCES.gate_eye_predicate})`,
    )
  }
  const rodIngredient = powderVariant?.ingredients.find((entry) => entry.item === BLAZE_ROD)?.count ?? 0
  if (powderVariants.length !== 1 || powderVariant?.resultCount !== POWDER_PER_ROD || rodIngredient !== 1) {
    errors.push(
      `recipe_truth_blaze_powder disagreement variants=${powderVariants.length} result=${String(powderVariant?.resultCount)} ` +
        `rod=${rodIngredient} expected result=${POWDER_PER_ROD} (${M3_CHAIN_SOURCES.gate_powder_threshold})`,
    )
  }

  return { errors, facts }
}

// ---------------------------------------------------------------------------
// full rehearsal
// ---------------------------------------------------------------------------

/**
 * Run the whole rehearsal. Returns a structured report; `report.missing` empty
 * and `report.result === 'READY'` means the real path and the real gate agree.
 */
export function runRehearsal({ write = () => {}, cleanup = true } = {}) {
  const missing = []
  const details = {}

  // --- 1/2. the real terminal craft path -----------------------------------
  const endgame = rehearseTerminalCraft({ inventory: M3_ENDGAME_INVENTORY })
  const postPowder = rehearseTerminalCraft({ inventory: M3_POST_POWDER_INVENTORY })
  details.endgame = endgame
  details.postPowder = postPowder

  write(
    `M3_CHAIN_REHEARSAL_CRAFT case=endgame_rods7 start=${JSON.stringify(endgame.startInventory)} ` +
      `sequence=${endgame.craftSequence.join(' ') || 'none'}`,
  )
  write(
    `M3_CHAIN_REHEARSAL_EYES case=endgame_rods7 trace=${endgame.eyesTrace} ` +
      `ender_eye_crafts=${endgame.enderEyeCrafts} powder_crafts=${endgame.powderCrafts} stopped=${endgame.stopped}`,
  )
  write(
    `M3_CHAIN_REHEARSAL_FINAL case=endgame_rods7 inventory=${JSON.stringify(endgame.finalInventory)} ` +
      `rods_consumed=${endgame.rodsConsumed} powder_produced=${endgame.rodsConsumed * POWDER_PER_ROD}`,
  )
  write(
    `M3_CHAIN_REHEARSAL_CRAFT case=post_powder_14 start=${JSON.stringify(postPowder.startInventory)} ` +
      `sequence=${postPowder.craftSequence.join(' ') || 'none'}`,
  )
  write(
    `M3_CHAIN_REHEARSAL_EYES case=post_powder_14 trace=${postPowder.eyesTrace} ` +
      `ender_eye_crafts=${postPowder.enderEyeCrafts} stopped=${postPowder.stopped}`,
  )

  if (endgame.errors.length > 0) for (const error of endgame.errors) missing.push(`endgame_path:${error}`)
  if (postPowder.errors.length > 0) for (const error of postPowder.errors) missing.push(`post_powder_path:${error}`)

  // The exact endgame inventory must FIRST descend to blaze_powder (the ladder
  // supplies rods, not powder), then craft eyes, and stop at 12.
  if (endgame.stageOrder[0] !== BLAZE_POWDER) {
    missing.push(
      `endgame_first_stage=${endgame.stageOrder[0] ?? 'none'} expected=${BLAZE_POWDER} ` +
        `(ladder supplies rods: ${M3_CHAIN_SOURCES.ladder_blaze_rods}; recipe: ${M3_CHAIN_SOURCES.gate_powder_threshold})`,
    )
  }
  if (!endgame.stageOrder.includes(ENDER_EYE)) {
    missing.push(`endgame_never_crafts_${ENDER_EYE} (${M3_CHAIN_SOURCES.ladder_ender_eyes})`)
  }
  if (endgame.enderEyeCrafts !== ENDER_EYE_REQUIRED) {
    missing.push(`endgame_ender_eye_crafts=${endgame.enderEyeCrafts} expected=${ENDER_EYE_REQUIRED} (${M3_CHAIN_SOURCES.gate_eye_threshold})`)
  }
  if (endgame.eyes !== ENDER_EYE_REQUIRED || endgame.stopped !== true) {
    missing.push(`endgame_terminal eyes=${endgame.eyes} stopped=${endgame.stopped} expected=${ENDER_EYE_REQUIRED}/true`)
  }
  const lastEndgameStep = endgame.steps.at(-1)
  if (lastEndgameStep === undefined || lastEndgameStep.craftId !== null) {
    missing.push(`endgame_does_not_stop candidate=${lastEndgameStep?.craftId ?? 'none'}`)
  }

  // The isolated eye stage: 12 powder crafts' worth pre-supplied, 12 eyes, stop.
  if (postPowder.craftCount !== ENDER_EYE_REQUIRED || postPowder.stageOrder.join('>') !== ENDER_EYE) {
    missing.push(
      `post_powder_sequence=${postPowder.craftSequence.join(' ') || 'none'} expected=${ENDER_EYE_REQUIRED} x ${ENDER_EYE}`,
    )
  }
  if (postPowder.eyes !== ENDER_EYE_REQUIRED || postPowder.stopped !== true) {
    missing.push(`post_powder_terminal eyes=${postPowder.eyes} stopped=${postPowder.stopped}`)
  }

  // --- 3. the 30dec38 regression: want must be the ABSOLUTE required count ---
  const partialInventory = {
    [ENDER_EYE]: 1,
    [ENDER_PEARL]: ENDER_EYE_REQUIRED - 1,
    [BLAZE_POWDER]: ENDER_EYE_REQUIRED - 1,
  }
  const wantRequired = planNextCraftStep(RECIPES, ENDER_EYE, partialInventory, false, ENDER_EYE_REQUIRED)
  const wantOne = planNextCraftStep(RECIPES, ENDER_EYE, partialInventory, false, 1)
  details.wantThreading = { wantRequired: wantRequired.op, wantOne: wantOne.op, reasonRequired: wantRequired.reason, reasonOne: wantOne.reason }
  write(
    `M3_CHAIN_REHEARSAL_WANT eyes=1 want=${ENDER_EYE_REQUIRED} op=${JSON.stringify(wantRequired.op)} ` +
      `want=1 op=${JSON.stringify(wantOne.op)}`,
  )
  if (wantRequired.op === null || wantRequired.op.type !== 'craft' || wantRequired.op.item !== ENDER_EYE) {
    missing.push(
      `want_threading_missing want=${ENDER_EYE_REQUIRED} op=${JSON.stringify(wantRequired.op)} ` +
        `(${M3_CHAIN_SOURCES.terminal_goal_want})`,
    )
  }
  if (wantOne.op !== null) {
    // Not a defect, but it would mean want=1 is also sufficient and the rehearsal's
    // regression guard no longer distinguishes the fix.
    write(`M3_CHAIN_REHEARSAL_WANT_NOTE want=1 also offers ${JSON.stringify(wantOne.op)} (guard is not discriminating)`)
  }

  // --- 4. ladder / planner / gate threshold agreement -----------------------
  const thresholds = checkThresholdsAndRungs()
  details.thresholds = thresholds
  write(
    `M3_CHAIN_REHEARSAL_THRESHOLDS eyes=${ENDER_EYE_REQUIRED} rods=${BLAZE_ROD_REQUIRED} ` +
      `powder=${BLAZE_POWDER_REQUIRED} rods_exact=${thresholds.facts.rodsExact} rod_surplus=${thresholds.facts.rodSurplus} ` +
      `powder_yield=${thresholds.facts.powderYield}`,
  )
  write(`M3_CHAIN_REHEARSAL_SOURCE ladder_ender_eyes: ${M3_CHAIN_SOURCES.ladder_ender_eyes}`)
  write(`M3_CHAIN_REHEARSAL_SOURCE gate_eye_threshold: ${M3_CHAIN_SOURCES.gate_eye_threshold}`)
  write(`M3_CHAIN_REHEARSAL_SOURCE terminal_goal_want: ${M3_CHAIN_SOURCES.terminal_goal_want}`)
  for (const error of thresholds.errors) missing.push(`thresholds:${error}`)

  // --- 5. the REAL gate on a synthetic single-run fixture -------------------
  const terminalSample = { ...endgame.finalInventory }
  // The fixture carries the path's own per-step trace, plus the equivalent
  // all-rods-milled observation (7 rods -> 14 powder) that the isolated eye stage
  // starts from. Both are real inventories of the same entry points, so the gate
  // sees `blaze_powder: 14` as well as the rods>=7 form of material completeness.
  const positiveSamples = [...endgame.inventoryTrace, { ...M3_POST_POWDER_INVENTORY }]
  const positiveResult = gateCase({
    missing,
    write,
    caseName: 'positive',
    runs: [{ runId: RUN_ID, samples: positiveSamples, terminalInventory: terminalSample }],
    expectedRunId: RUN_ID,
    expect: (result) => {
      const problems = []
      if (result.exitCode !== 0) problems.push(`exit=${result.exitCode} expected=0`)
      if (result.status !== 'PASS') problems.push(`status=${result.status} expected=PASS reason=${result.reason}`)
      for (const condition of M3_REQUIRED_CONDITIONS) {
        if (!result.conditionLines.some((line) => line === `${condition}: PASS`)) {
          problems.push(`condition_${condition}_not_PASS`)
        }
      }
      return problems
    },
  })
  details.positive = positiveResult

  // --- 6. negatives, all against the real gate subprocess -------------------
  const eyes11 = gateCase({
    missing,
    write,
    caseName: 'eyes11',
    runs: [
      {
        runId: RUN_ID,
        samples: [
          { [ENDER_PEARL]: ENDER_PEARL_REQUIRED, [BLAZE_ROD]: BLAZE_ROD_REQUIRED },
          { [ENDER_PEARL]: 1, [BLAZE_ROD]: BLAZE_ROD_REQUIRED, [BLAZE_POWDER]: BLAZE_ROD_REQUIRED * POWDER_PER_ROD, [ENDER_EYE]: ENDER_EYE_REQUIRED - 1 },
        ],
      },
    ],
    expectedRunId: RUN_ID,
    expect: (result) => {
      const problems = []
      if (result.status === 'PASS' || result.exitCode === 0) problems.push(`status=${result.status} exit=${result.exitCode} must never PASS`)
      if (result.status !== 'FAIL' || result.exitCode !== 1) problems.push(`status=${result.status} exit=${result.exitCode} expected=FAIL/1`)
      if (result.reason !== 'ender_eyes_short_with_crafting_materials') problems.push(`reason=${result.reason}`)
      return problems
    },
  })
  details.eyes11 = eyes11

  const noRunId = gateCase({
    missing,
    write,
    caseName: 'no_run_id',
    runs: [{ runId: RUN_ID, samples: endgame.inventoryTrace }],
    expectedRunId: null,
    dropRunIdEnv: true,
    expect: (result) => {
      const problems = []
      if (result.status === 'PASS' || result.exitCode === 0) problems.push(`status=${result.status} exit=${result.exitCode} must never PASS`)
      if (result.status !== 'UNKNOWN' || result.exitCode !== 2) problems.push(`status=${result.status} exit=${result.exitCode} expected=UNKNOWN/2`)
      if (result.reason !== 'exact_run_scope_required') problems.push(`reason=${result.reason}`)
      return problems
    },
  })
  details.noRunId = noRunId

  const noEyes = gateCase({
    missing,
    write,
    caseName: 'inputs_no_eyes',
    runs: [{ runId: RUN_ID, samples: [{ [ENDER_PEARL]: ENDER_PEARL_REQUIRED, [BLAZE_ROD]: BLAZE_ROD_REQUIRED }] }],
    expectedRunId: RUN_ID,
    expect: (result) => {
      const problems = []
      if (result.status === 'PASS' || result.exitCode === 0) problems.push(`status=${result.status} exit=${result.exitCode} must never PASS`)
      if (result.status !== 'FAIL' && result.status !== 'UNKNOWN') problems.push(`status=${result.status} expected FAIL|UNKNOWN`)
      return problems
    },
  })
  details.noEyes = noEyes

  // The M3 definition requires live proof of Nether arrival, so the same endgame inventory with the run's
  // only observed dimension the OVERWORLD must never PASS: twelve eyes are not a milestone by themselves.
  const noNether = gateCase({
    missing,
    write,
    caseName: 'eyes_without_nether',
    runs: [{ runId: RUN_ID, samples: endgame.inventoryTrace, dimension: 'minecraft:overworld' }],
    expectedRunId: RUN_ID,
    expect: (result) => {
      const problems = []
      if (result.status === 'PASS' || result.exitCode === 0) {
        problems.push(`status=${result.status} exit=${result.exitCode} must never PASS`)
      }
      if (result.status !== 'UNKNOWN') problems.push(`status=${result.status} expected UNKNOWN`)
      if (!String(result.reason ?? '').includes('nether_reached')) {
        problems.push(`reason=${result.reason} must name nether_reached`)
      }
      return problems
    },
  })
  details.noNether = noNether
  // The real path's terminal inventory must itself carry the contract count; the
  // 11-eye negative above is that same shape with exactly one eye removed.
  if ((terminalSample[ENDER_EYE] ?? 0) !== ENDER_EYE_REQUIRED) missing.push(`terminal_sample_eyes=${terminalSample[ENDER_EYE] ?? 0}`)

  // The item-id trap the terminal predicate must never fall for: `eye_of_ender`
  // is the thrown projectile ENTITY, never an item (jev-agent/test-m3-terminal-craft.mts).
  const wrongItemName = gateCase({
    missing,
    write,
    caseName: 'projectile_item_name',
    runs: [
      {
        runId: RUN_ID,
        samples: [{ [ENDER_PEARL]: ENDER_PEARL_REQUIRED, [BLAZE_ROD]: BLAZE_ROD_REQUIRED, eye_of_ender: ENDER_EYE_REQUIRED }],
      },
    ],
    expectedRunId: RUN_ID,
    expect: (result) => {
      const problems = []
      if (result.status === 'PASS' || result.exitCode === 0) problems.push(`status=${result.status} exit=${result.exitCode} eye_of_ender is not an item and must never satisfy M3`)
      if (result.status !== 'FAIL' && result.status !== 'UNKNOWN') problems.push(`status=${result.status} expected FAIL|UNKNOWN`)
      return problems
    },
  })
  details.wrongItemName = wrongItemName

  const foreign = gateCase({
    missing,
    write,
    caseName: 'foreign_run',
    runs: [{ runId: OTHER_RUN_ID, samples: endgame.inventoryTrace }],
    expectedRunId: RUN_ID,
    expect: (result) => {
      const problems = []
      if (result.status === 'PASS' || result.exitCode === 0) problems.push(`status=${result.status} exit=${result.exitCode} foreign eyes must never be attributed`)
      if (result.status !== 'UNKNOWN' || result.exitCode !== 2) problems.push(`status=${result.status} exit=${result.exitCode} expected=UNKNOWN/2`)
      return problems
    },
  })
  details.foreign = foreign

  const mixedRuns = [
    { runId: RUN_ID, samples: [{ [ENDER_PEARL]: ENDER_PEARL_REQUIRED }] },
    { runId: OTHER_RUN_ID, samples: endgame.inventoryTrace },
  ]
  const mixedAsRun = gateCase({
    missing,
    write,
    caseName: 'mixed_as_run',
    runs: mixedRuns,
    expectedRunId: RUN_ID,
    expect: (result) => {
      const problems = []
      if (result.status === 'PASS' || result.exitCode === 0) problems.push(`status=${result.status} exit=${result.exitCode} cross-run join must never PASS`)
      return problems
    },
  })
  details.mixedAsRun = mixedAsRun
  const mixedAsForeign = gateCase({
    missing,
    write,
    caseName: 'mixed_as_foreign',
    runs: mixedRuns,
    expectedRunId: OTHER_RUN_ID,
    expect: (result) => {
      const problems = []
      if (result.exitCode !== 0 || result.status !== 'PASS') problems.push(`status=${result.status} exit=${result.exitCode} the foreign run's own evidence must still PASS`)
      return problems
    },
  })
  details.mixedAsForeign = mixedAsForeign

  const noAuthority = gateCase({
    missing,
    write,
    caseName: 'no_authority',
    runs: [{ runId: RUN_ID, samples: endgame.inventoryTrace }],
    expectedRunId: RUN_ID,
    includeAuthority: false,
    expect: (result) => {
      const problems = []
      if (result.status === 'PASS' || result.exitCode === 0) problems.push(`status=${result.status} exit=${result.exitCode} eyes without authority must never PASS`)
      if (result.status !== 'UNKNOWN' || result.exitCode !== 2) problems.push(`status=${result.status} exit=${result.exitCode} expected=UNKNOWN/2`)
      return problems
    },
  })
  details.noAuthority = noAuthority

  const negatives = [
    `11eyes:${eyes11.status}`,
    `norun:${noRunId.status}`,
    `noeyes:${noEyes.status}`,
    `nonether:${noNether.status}`,
    `nonether_reason:${noNether.reason ?? 'none'}`,
    `wrongitem:${wrongItemName.status}`,
    `foreign:${foreign.status}`,
    `mixed:${mixedAsRun.status}`,
    `mixed_own:${mixedAsForeign.status}`,
    `noauth:${noAuthority.status}`,
  ].join(',')

  const result = missing.length === 0 ? 'READY' : 'GAP'
  details.result = result
  details.missing = missing
  write(
    `M3_CHAIN_REHEARSAL result=${result} stages=${endgame.stageSet.join('>') || 'none'} eyes=${endgame.eyes} ` +
      `missing=${missing.length === 0 ? 'none' : missing.join(',')} gate=${positiveResult.status ?? 'none'} negatives=${negatives}`,
  )
  return details
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const report = runRehearsal({ write: (line) => process.stdout.write(`${line}\n`) })
  process.exitCode = report.result === 'READY' ? 0 : 1
}
