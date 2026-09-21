#!/usr/bin/env bun
// m2-chain-rehearsal: offline, server-less rehearsal of the REAL M2 portal chain.
//
// WHY
// ---
// M2 acceptance is judged by tools/m2-gate.mjs --run <runId>, which needs ONE
// source to carry the ordered chain
//
//   PORTAL_BLOCK_PLACED
//     -> PORTAL_FRAME_READY blocks>=10 shape=ok
//       -> PORTAL_LIT dimension=minecraft:overworld
//         -> PORTAL_VERIFIED=true
//
// plus flint_and_steel>=1 / obsidian>=10 inventory samples and real model
// authority. The live resident is gathering exactly those materials. Nobody had
// proven, offline, that the resident's own deterministic portal plan
// (jev-agent/src/netherPortalPlan.ts) actually emits that marker order and would
// satisfy the gate. A marker-order or reachability bug would only surface at the
// very end of a long live run.
//
// WHAT THIS DOES (no Minecraft server, no network)
// -----------------------------------------------
// 1. Drives the REAL deterministic plan for the exact inventory of a resident
//    that just finished the M2 prerequisites:
//      netherPortalRungGoals / planNetherPortal / portalStepsToPlannedGoals /
//      portalStepToPlannedGoal.
// 2. Projects each typed plan step onto the marker the real executor emits for
//    it, reading the names from the executor/plan definitions (not guessing),
//    and asserts the projected order equals the gate's required order. A
//    missing, reordered, or renamed stage FAILs with a precise diff.
// 3. Materializes a synthetic single-run fixture (BOOT boundary + inventory
//    samples + the derived marker lines in the log; GENERATION_READY /
//    SYSTEM2_AUTHORITY_DECISION in runner.out; a source=jev decision in
//    decisions.jsonl) and invokes the REAL tools/m2-gate.mjs as a subprocess
//    with --run/--log/--snapshot-dir/--decisions/--runner-out. The rehearsal is
//    READY only when the real gate prints M2_RUN_RESULT status=PASS.
// 4. Asserts the negatives: a run that only INHERITS a portal (no build chain)
//    is UNKNOWN reason=inherited_portal, and a PORTAL_LIT without a dimension
//    can never PASS.
//
// The gate is never modified and no marker is invented: every synthetic line is
// rendered by the same formatter the executor calls, and a mismatch between the
// plan's real markers and the gate's requirements is the deliverable.
//
// Exit: 0 = READY, 1 = GAP.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  DIAMOND,
  DIAMOND_PICKAXE,
  FLINT_AND_STEEL,
  OBSIDIAN,
  OVERWORLD,
  PORTAL_BLOCK_PLACED,
  PORTAL_FRAME_READY,
  PORTAL_LIT,
  PORTAL_VERIFIED,
  formatPortalFrameReady,
  formatPortalLit,
  netherPortalRungGoals,
  orderedPlacementCells,
  planNetherPortal,
  portalFrameLayout,
  portalStepToPlannedGoal,
  portalStepsToPlannedGoals,
  validatePortalFrame,
  verifyPortal,
} from '../jev-agent/src/netherPortalPlan.ts'
import { placedFrameCellLine, frameReadyLine } from '../jev-agent/src/executor.ts'
import {
  INHERITED_PORTAL_REASON,
  evaluatePortalChain,
  parsePortalMarker,
} from './m2-gate.mjs'

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(TOOLS_DIR)
export const M2_CHAIN_GATE_PATH = join(TOOLS_DIR, 'm2-gate.mjs')

/** The real inventory shape at the moment the M2 prerequisites are complete. */
export const M2_READY_INVENTORY = Object.freeze({
  [DIAMOND]: 3,
  [DIAMOND_PICKAXE]: 1,
  [FLINT_AND_STEEL]: 1,
  [OBSIDIAN]: 10,
})

/** PICKAXE_TIER0 diamond = 4 (netherPortalPlan.ts:97). */
export const M2_READY_TOOL_RANK = 4

/** A grounded frame origin; geometry comes from portalFrameLayout(), not a guess. */
export const M2_READY_FRAME_ORIGIN = Object.freeze({ x: 10, y: 64, z: 20 })

/**
 * The gate's required marker order, read from tools/m2-gate.mjs:247-270
 * (`evaluatePortalChain`: placed -> frame(shape=ok, blocks>=10) -> lit -> verified)
 * combined with tools/m2-gate.mjs:378-380 (lit must report minecraft:overworld).
 * The names themselves are the plan's own exported constants.
 */
export const GATE_REQUIRED_MARKER_ORDER = Object.freeze([
  PORTAL_BLOCK_PLACED,
  PORTAL_FRAME_READY,
  PORTAL_LIT,
  PORTAL_VERIFIED,
])

/**
 * The mapping plan step -> executor emission. Each entry names the exact code
 * path the marker comes from. The marker line strings are produced by the SAME
 * functions the executor uses, so a rename/removal breaks this harness.
 */
export const PLAN_STEP_MARKER_SOURCES = Object.freeze({
  build_portal_frame: Object.freeze({
    gateStage: 'portal_built',
    emission: [
      'executor.ts:3824 runPlaceCells -> executor.ts:4103 emitFrameCell -> executor.ts:825 placedFrameCellLine -> netherPortalPlan.ts:501 formatPortalBlockPlaced (one PORTAL_BLOCK_PLACED per verified obsidian cell)',
      'executor.ts:3885 formatPortalFrameReady(validation) -> netherPortalPlan.ts:497 (only when validatePortalFrame reports shape=ok)',
    ],
  }),
  light_portal: Object.freeze({
    gateStage: 'portal_lit',
    emission: [
      'executor.ts:4202 formatPortalLit(target, dimension) -> netherPortalPlan.ts:701 (after the ignite post-condition holds at every interior cell)',
    ],
  }),
  verify_portal: Object.freeze({
    gateStage: 'portal_lit',
    emission: [
      'executor.ts:4203 verifyPortal({lit:true, portalBlockPresent:true}).line -> netherPortalPlan.ts:718',
      'light_portal and verify_portal compile to the SAME `place nether_portal` goal carrying PORTAL_LIT_PREDICATE (netherPortalPlan.ts:1018-1085), so the GoalQueue dedups them into ONE runIgnite action that emits both markers.',
    ],
  }),
})

/**
 * Precise order diff. `missing` lists required markers absent from the emitted
 * sequence; `problems` lists out-of-order or unexpected marker names.
 */
export function diffMarkerOrder(emitted, required) {
  const seq = Array.isArray(emitted) ? emitted : []
  const want = Array.isArray(required) ? required : []
  const missing = []
  const problems = []
  let cursor = 0
  for (const name of want) {
    const at = seq.indexOf(name, cursor)
    if (at !== -1) {
      cursor = at + 1
      continue
    }
    const anywhere = seq.indexOf(name)
    if (anywhere === -1) missing.push(name)
    else problems.push(`out_of_order:${name}@${anywhere} (already consumed; expected after ${seq[cursor - 1] ?? 'start'})`)
  }
  for (const name of seq) if (!want.includes(name)) problems.push(`unexpected_marker:${name}`)
  return { ok: missing.length === 0 && problems.length === 0, missing, problems }
}

/** Collapse consecutive duplicates (10 frame cells -> one build stage). */
function collapseConsecutive(names) {
  const out = []
  for (const name of names) if (out.at(-1) !== name) out.push(name)
  return out
}

/**
 * Drive the real plan for `inventory` and project it onto the real executor's
 * marker emissions. Pure and deterministic; no world, no clock, no server.
 */
export function rehearsePlanChain({
  inventory = M2_READY_INVENTORY,
  toolRank = M2_READY_TOOL_RANK,
  dimension = OVERWORLD,
  origin = M2_READY_FRAME_ORIGIN,
} = {}) {
  const plan = planNetherPortal({ inventory, toolRank, dimension })
  const rungGoals = netherPortalRungGoals(inventory, toolRank, dimension, 0)
  const goalsFromSteps = portalStepsToPlannedGoals(plan.steps)
  const perStepGoals = plan.steps.map((step) => ({ kind: step.kind, goal: portalStepToPlannedGoal(step) }))

  // A grounded site makes the build step carry its executable placementCells.
  const grounded = planNetherPortal({
    inventory,
    toolRank,
    dimension,
    sites: [{ position: origin, safe: true, reachable: true }],
    self: { x: origin.x, y: origin.y, z: origin.z },
  })

  const layout = portalFrameLayout(origin, 'x')
  const cells = orderedPlacementCells(layout.frame)
  const validation = validatePortalFrame({ blocks: layout.frame, widthAxis: 'x' })

  const placedLines = cells.map((cell) => placedFrameCellLine(OBSIDIAN, OBSIDIAN, cell))
  if (placedLines.some((line) => line === null)) {
    throw new Error('placedFrameCellLine refused a verified obsidian frame cell')
  }
  const frameLine = frameReadyLine(cells, 'x')
  if (frameLine === null) throw new Error('frameReadyLine refused a validated 4x5 frame')
  const litLine = formatPortalLit(validation.lightPosition, dimension)
  const verifiedLine = verifyPortal({ lit: true, portalBlockPresent: true, dimension }).line

  const linesByStep = {
    build_portal_frame: [...placedLines, frameLine],
    light_portal: [litLine],
    verify_portal: [verifiedLine],
  }

  const emittedLines = []
  const emittedSteps = []
  const unmappedStepKinds = []
  for (const step of plan.steps) {
    const lines = linesByStep[step.kind]
    if (lines === undefined) {
      // A prerequisite step (collect/craft/smelt) emits no portal marker; it is
      // recorded so runRehearsal() reports the unexpected prerequisite as a GAP
      // instead of crashing or silently dropping it.
      unmappedStepKinds.push(step.kind)
      emittedSteps.push({ kind: step.kind, markers: [] })
      continue
    }
    emittedSteps.push({ kind: step.kind, markers: lines.map((line) => parsePortalMarker(line)) })
    emittedLines.push(...lines)
  }

  const emittedMarkers = emittedLines.map((line) => parsePortalMarker(line)?.name ?? null)
  if (emittedMarkers.some((name) => name === null)) {
    throw new Error('a derived marker line is not recognized by tools/m2-gate.mjs parsePortalMarker')
  }
  const emittedStages = collapseConsecutive(emittedMarkers)
  const order = diffMarkerOrder(emittedStages, GATE_REQUIRED_MARKER_ORDER)

  const events = emittedLines.map((line) => parsePortalMarker(line))
  const chain = evaluatePortalChain(events)
  const gateChainErrors = []
  if (!chain.frameVerified) gateChainErrors.push('gate evaluatePortalChain: frameVerified=false')
  if (!chain.litVerified) gateChainErrors.push('gate evaluatePortalChain: litVerified=false')
  const indices = [chain.indices.placed, chain.indices.frame, chain.indices.lit, chain.indices.verified]
  for (let i = 1; i < indices.length; i += 1) {
    if (!(indices[i] > indices[i - 1])) gateChainErrors.push(`gate evaluatePortalChain: index ${i} not strictly increasing (${indices[i - 1]} -> ${indices[i]})`)
  }

  return {
    inventory,
    toolRank,
    dimension,
    plan,
    rungGoals,
    goalsFromSteps,
    perStepGoals,
    grounded,
    stepKinds: plan.steps.map((step) => step.kind),
    operationKinds: plan.operations.map((step) => step.kind),
    prerequisiteKinds: plan.prerequisites.map((step) => step.kind),
    unmappedStepKinds,
    groundedBuildPlacementCells: grounded.goals[grounded.prerequisites.length]?.placementCells?.length ?? 0,
    frame: {
      origin,
      axis: 'x',
      cells: cells.length,
      blocks: validation.blocks,
      shape: validation.shape,
      lightPosition: validation.lightPosition,
      authoritativeFrameLine: formatPortalFrameReady(validation),
      frameLine,
      litLine,
      verifiedLine,
    },
    emittedSteps,
    emittedLines,
    emittedMarkers,
    emittedStages,
    order,
    chain,
    gateChainErrors,
  }
}

// ---------------------------------------------------------------------------
// synthetic single-run fixture (log + runner.out + decisions + snapshot dir)
// ---------------------------------------------------------------------------

const RUN_ID = 'run-m2-rehearsal'

function stamp(seconds) {
  return new Date(Date.UTC(2026, 8, 20, 10, 0, seconds)).toISOString()
}

const BOOT_LINE = `[${stamp(0)}] BOOT pid=4242 runId=${RUN_ID} bundle=none source=deadbeef worldEpoch=1`

/**
 * Materialize an offline fixture. `markerLines` are the plan-derived lines;
 * `portalTruthLine` is the optional inherited-portal observation (no chain).
 * Every case gets its own directory so evidence can never bleed across cases.
 */
export function materializeSyntheticRun({ caseName, markerLines, portalTruthLine = null }) {
  const dir = mkdtempSync(join(tmpdir(), `m2-chain-${caseName}-`))
  const snapshotDir = join(dir, 'snapshots')
  mkdirSync(snapshotDir)
  const diamondSample = {
    [DIAMOND]: M2_READY_INVENTORY[DIAMOND],
    [DIAMOND_PICKAXE]: M2_READY_INVENTORY[DIAMOND_PICKAXE],
  }
  const materialsSample = {
    [FLINT_AND_STEEL]: M2_READY_INVENTORY[FLINT_AND_STEEL],
    [OBSIDIAN]: M2_READY_INVENTORY[OBSIDIAN],
  }
  const logLines = [
    BOOT_LINE,
    `[${stamp(1)}] INVENTORY items=${JSON.stringify(diamondSample)} pos=10,64,20`,
    `[${stamp(2)}] INVENTORY items=${JSON.stringify(materialsSample)} pos=10,64,20`,
    ...(portalTruthLine === null ? [] : [portalTruthLine]),
    ...markerLines,
  ]
  // Same single-run boundary in runner.out, plus the authority lines the gate's
  // m2-policy-evidence reader requires. HOST_LOCK released bounds the run window.
  const runnerOutLines = [
    BOOT_LINE,
    `[${stamp(1)}] GENERATION_READY generation=1 policy=typesafe model=typesafe-ai/jev planner=llm deterministicFallbackEnabled=false`,
    `[${stamp(2)}] SYSTEM2_AUTHORITY_DECISION provider=deepseek model=deepseek-v4.1-flash chosen=front_nether_portal goals=[front_nether_portal]`,
    `[${stamp(30)}] HOST_LOCK released pid=4242 runId=${RUN_ID}`,
  ]
  const decisionsLines = [
    JSON.stringify({
      record: 'decision',
      ts: stamp(3),
      runId: RUN_ID,
      source: 'jev',
      kind: 'place',
      reason: 'fixture:model_authored_jev_decision',
    }),
    JSON.stringify({
      record: 'decision',
      ts: stamp(4),
      runId: RUN_ID,
      source: 'jev',
      kind: 'place',
      reason: 'fixture:model_authored_jev_decision',
    }),
  ]
  writeFileSync(join(dir, 'buddy.log'), `${logLines.join('\n')}\n`)
  writeFileSync(join(dir, 'runner.out'), `${runnerOutLines.join('\n')}\n`)
  writeFileSync(join(dir, 'decisions.jsonl'), `${decisionsLines.join('\n')}\n`)
  return {
    dir,
    runId: RUN_ID,
    inventory: M2_READY_INVENTORY,
    logPath: join(dir, 'buddy.log'),
    snapshotDir,
    decisionsPath: join(dir, 'decisions.jsonl'),
    runnerOutPath: join(dir, 'runner.out'),
    // Deliberately absent: forces the gate to use runner.out, keeping the run offline.
    controlSocketPath: join(dir, 'control.sock'),
  }
}

/** Invoke the REAL tools/m2-gate.mjs as a subprocess and parse its verdict. */
export function runRealGate({
  fixture,
  gatePath = M2_CHAIN_GATE_PATH,
  runtime = process.execPath,
} = {}) {
  const cmd = [
    runtime,
    gatePath,
    '--run',
    fixture.runId,
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
  ]
  const proc = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' })
  const stdout = proc.stdout.toString('utf8')
  const stderr = proc.stderr.toString('utf8')
  const resultLine = stdout.split('\n').find((line) => line.startsWith('M2_RUN_RESULT ')) ?? null
  const status = resultLine === null ? null : /\bstatus=(\S+)/.exec(resultLine)?.[1] ?? null
  const reason = resultLine === null ? null : /\breason=(\S+)/.exec(resultLine)?.[1] ?? null
  return {
    cmd,
    exitCode: proc.exitCode,
    stdout,
    stderr,
    resultLine,
    status,
    reason,
    statusLine: stdout.split('\n').find((line) => line.startsWith('portal_lit: ')) ?? null,
  }
}

// ---------------------------------------------------------------------------
// full rehearsal
// ---------------------------------------------------------------------------

/**
 * Run the whole rehearsal. Returns a structured report; `report.missing` empty
 * and every gate/negative assertion true means READY.
 */
export function runRehearsal({ write = () => {}, cleanup = true } = {}) {
  const missing = []
  const details = {}

  const rehearsal = rehearsePlanChain()
  details.rehearsal = rehearsal

  if (rehearsal.plan.ready !== true) missing.push(`plan.ready=${rehearsal.plan.ready}`)
  if (rehearsal.prerequisiteKinds.length !== 0) {
    missing.push(`unexpected_prerequisites:${rehearsal.prerequisiteKinds.join(',')}`)
  }
  if (JSON.stringify(rehearsal.goalsFromSteps) !== JSON.stringify(rehearsal.plan.goals)) {
    missing.push('goal_projection_mismatch:portalStepsToPlannedGoals!=planNetherPortal.goals')
  }
  if (JSON.stringify(rehearsal.rungGoals) !== JSON.stringify(rehearsal.plan.goals)) {
    missing.push('rung_goal_mismatch:netherPortalRungGoals!=planNetherPortal.goals')
  }
  if (JSON.stringify(rehearsal.perStepGoals.map((entry) => entry.goal)) !== JSON.stringify(rehearsal.plan.goals)) {
    missing.push('per_step_goal_mismatch:portalStepToPlannedGoal!=portalStepsToPlannedGoals')
  }
  if (rehearsal.groundedBuildPlacementCells !== rehearsal.frame.cells) {
    missing.push(`grounded_placement_cells=${rehearsal.groundedBuildPlacementCells} expected=${rehearsal.frame.cells}`)
  }
  if (rehearsal.frame.shape !== 'ok' || rehearsal.frame.blocks < 10) {
    missing.push(`frame_shape=${rehearsal.frame.shape} blocks=${rehearsal.frame.blocks}`)
  }
  if (rehearsal.order.ok !== true) {
    for (const name of rehearsal.order.missing) missing.push(`missing_marker:${name}`)
    for (const problem of rehearsal.order.problems) missing.push(`order:${problem}`)
  }
  for (const error of rehearsal.gateChainErrors) missing.push(error)

  write(`M2_CHAIN_REHEARSAL_PLAN steps=${rehearsal.stepKinds.join('>')} operations=${rehearsal.operationKinds.join('>')} prerequisites=${rehearsal.prerequisiteKinds.length} ready=${rehearsal.plan.ready}`)
  for (const entry of rehearsal.perStepGoals) {
    const goal = entry.goal
    write(
      `M2_CHAIN_REHEARSAL_GOAL step=${entry.kind} kind=${goal.kind} targetItem=${goal.targetItem ?? 'null'} ` +
        `requiredCount=${goal.requiredCount ?? 'null'} predicate=${goal.targetPredicate ?? 'none'} dimension=${goal.dimension ?? 'none'}`,
    )
  }
  for (const [step, mapping] of Object.entries(PLAN_STEP_MARKER_SOURCES)) {
    const names = rehearsal.emittedSteps
      .filter((entry) => entry.kind === step)
      .flatMap((entry) => entry.markers.map((marker) => marker.name))
    write(`M2_CHAIN_REHEARSAL_MAPPING step=${step} gateStage=${mapping.gateStage} markers=${[...new Set(names)].join(',') || 'none'}`)
    for (const source of mapping.emission) write(`M2_CHAIN_REHEARSAL_MAPPING_SOURCE ${source}`)
  }
  write(`M2_CHAIN_REHEARSAL_ORDER emitted=${rehearsal.emittedStages.join('>')} required=${GATE_REQUIRED_MARKER_ORDER.join('>')}`)
  write(`M2_CHAIN_REHEARSAL_FRAME blocks=${rehearsal.frame.blocks} shape=${rehearsal.frame.shape} line="${rehearsal.frame.frameLine}"`)
  write(`M2_CHAIN_REHEARSAL_LIT line="${rehearsal.frame.litLine}"`)

  // --- case a: the plan-derived chain must satisfy the real gate -------------
  const positiveFixture = materializeSyntheticRun({ caseName: 'chain', markerLines: rehearsal.emittedLines })
  let positive
  try {
    positive = runRealGate({ fixture: positiveFixture })
  } finally {
    if (cleanup) rmSync(positiveFixture.dir, { recursive: true, force: true })
  }
  details.positive = positive
  write(`M2_CHAIN_REHEARSAL_GATE case=chain status=${positive.status} reason=${positive.reason} exit=${positive.exitCode}`)
  write(`M2_CHAIN_REHEARSAL_GATE_RESULT case=chain ${positive.resultLine ?? 'M2_RUN_RESULT missing'}`)
  if (positive.status !== 'PASS' || positive.exitCode !== 0) {
    missing.push(`gate_not_pass:status=${positive.status} reason=${positive.reason} exit=${positive.exitCode}`)
  }

  // --- case b: inherited portal (no build chain) is a named UNKNOWN ----------
  const truthLine = `[${stamp(2)}] PORTAL_TRUTH verified=true reason=status source=live-world`
  const inheritedFixture = materializeSyntheticRun({ caseName: 'inherited', markerLines: [], portalTruthLine: truthLine })
  let inherited
  try {
    inherited = runRealGate({ fixture: inheritedFixture })
  } finally {
    if (cleanup) rmSync(inheritedFixture.dir, { recursive: true, force: true })
  }
  details.inherited = inherited
  write(`M2_CHAIN_REHEARSAL_GATE case=inherited status=${inherited.status} reason=${inherited.reason} exit=${inherited.exitCode}`)
  write(`M2_CHAIN_REHEARSAL_GATE_RESULT case=inherited ${inherited.resultLine ?? 'M2_RUN_RESULT missing'}`)
  if (inherited.status !== 'UNKNOWN' || inherited.reason !== INHERITED_PORTAL_REASON || inherited.exitCode !== 2) {
    missing.push(`inherited_negative:status=${inherited.status} reason=${inherited.reason} exit=${inherited.exitCode}`)
  }

  // --- case c: PORTAL_LIT without a dimension must not PASS ------------------
  // Derived by stripping the dimension field from the real formatPortalLit line.
  const noDimensionLitLine = rehearsal.frame.litLine.replace(/\s+dimension=\S+/, '')
  const noDimensionLines = rehearsal.emittedLines.map((line) =>
    parsePortalMarker(line)?.name === PORTAL_LIT ? noDimensionLitLine : line,
  )
  const noDimensionFixture = materializeSyntheticRun({ caseName: 'lit-no-dimension', markerLines: noDimensionLines })
  let noDimension
  try {
    noDimension = runRealGate({ fixture: noDimensionFixture })
  } finally {
    if (cleanup) rmSync(noDimensionFixture.dir, { recursive: true, force: true })
  }
  details.noDimension = noDimension
  write(`M2_CHAIN_REHEARSAL_GATE case=lit_no_dimension status=${noDimension.status} reason=${noDimension.reason} exit=${noDimension.exitCode} lit=${noDimension.statusLine ?? 'n/a'}`)
  write(`M2_CHAIN_REHEARSAL_GATE_RESULT case=lit_no_dimension ${noDimension.resultLine ?? 'M2_RUN_RESULT missing'}`)
  if (noDimension.status === 'PASS' || noDimension.exitCode === 0) {
    missing.push(`lit_no_dimension_negative:status=${noDimension.status} exit=${noDimension.exitCode}`)
  }

  const result = missing.length === 0 ? 'READY' : 'GAP'
  details.result = result
  details.missing = missing
  write(
    `M2_CHAIN_REHEARSAL result=${result} stages=${rehearsal.stepKinds.join('>')} ` +
      `markers=${rehearsal.emittedStages.join('>')} missing=${missing.length === 0 ? 'none' : missing.join(',')} ` +
      `gate=${positive.status ?? 'none'} inherited=${inherited.status ?? 'none'}/${inherited.reason ?? 'none'} ` +
      `lit_no_dimension=${noDimension.status ?? 'none'}`,
  )
  return details
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const report = runRehearsal({ write: (line) => process.stdout.write(`${line}\n`) })
  process.exitCode = report.result === 'READY' ? 0 : 1
}
