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
//    The claim "the executor emits this marker here" is PROBED, not asserted:
//    every emitter call site is searched in the source at run time and the line
//    it actually found is reported (a moved/renamed/removed emitter is a GAP, not
//    a stale file:line in a comment).
// 3. Materializes a synthetic single-run fixture (BOOT boundary + inventory
//    samples + the derived marker lines in the log; GENERATION_READY /
//    SYSTEM2_AUTHORITY_DECISION in runner.out; a source=jev decision in
//    decisions.jsonl) and invokes the REAL tools/m2-gate.mjs as a subprocess
//    with --run/--log/--snapshot-dir/--decisions/--runner-out. The rehearsal is
//    READY only when the real gate prints M2_RUN_RESULT status=PASS.
// 4. Asserts the negatives: a run that only INHERITS a portal (no build chain)
//    is UNKNOWN reason=inherited_portal, and a PORTAL_LIT without a dimension
//    can never PASS.
// 5. FRESH-RUN CAPABILITY (no hand-fed inventory): from an inventory that has NOT
//    finished the M2 prerequisites, asserts the chain's own gates - obsidian
//    mining is refused without a diamond pickaxe, the plan emits the diamond ->
//    diamond_pickaxe -> obsidian prerequisite order before build/light/verify, a
//    valid frame has exactly 10 placeable cells, and ignition is refused without
//    flint_and_steel. Its gate verdict must be UNKNOWN: the capability is proven,
//    the outcome is not, until a run really gathers the materials.
//
// The gate is never modified and no marker is invented: every synthetic line is
// rendered by the same formatter the executor calls, and a mismatch between the
// plan's real markers and the gate's requirements is the deliverable.
//
// WHAT THIS DOES NOT PROVE
// ------------------------
// Live obtainability. The positive case starts from the post-prerequisite
// inventory, and the fresh case starts from a fresh one: neither walks a world,
// finds an obsidian block, mines it, or places a frame. Those remain LIVE
// questions, and the fresh case names exactly which materials a fresh run must
// still gather.
//
// Exit: 0 = READY, 1 = GAP.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  planObsidianMining,
  planPortalIgnition,
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
  parsePortalChainLine,
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
 * The mapping plan step -> the gate stage it feeds. The marker line strings are
 * produced by the SAME functions the executor uses, so a rename/removal breaks
 * this harness.
 */
export const PLAN_STEP_GATE_STAGES = Object.freeze({
  build_portal_frame: 'portal_built',
  light_portal: 'portal_lit',
  verify_portal: 'portal_lit',
})

/**
 * The PRODUCTION emitters each derived marker must come from, as exact source
 * text. These are probed at run time (see `probeMarkerEmitters`): the file is
 * searched, the line actually found is reported, and a missing probe is a GAP.
 *
 * A hand-written `file:line` cannot stay true - the previous revision of this
 * harness claimed `executor.ts:825` for `placedFrameCellLine`, which is at
 * `executor.ts:1396` today. Searching for the CALL EXPRESSION (arguments
 * included) is the strongest claim that survives a move, and still breaks on a
 * rename or a changed call.
 *
 * The two `symbol` probes confirm the enclosing executor actions exist
 * (`runPlaceCells` builds the frame, `runIgnite` lights and verifies it); the
 * `call` probes confirm the marker formatters are invoked from the live path.
 */
export const MARKER_EMITTER_PROBES = Object.freeze({
  [PORTAL_BLOCK_PLACED]: Object.freeze([
    {
      id: 'block-placed-formatter',
      file: 'jev-agent/src/netherPortalPlan.ts',
      expect: 'call',
      text: 'export function formatPortalBlockPlaced(pos: PortalBlockPosition): string {',
    },
    {
      id: 'block-placed-executor-call',
      file: 'jev-agent/src/executor.ts',
      expect: 'call',
      text: 'return formatPortalBlockPlaced(at)',
    },
    {
      id: 'emit-frame-cell-action',
      file: 'jev-agent/src/executor.ts',
      expect: 'symbol',
      text: 'private emitFrameCell(',
    },
    {
      id: 'run-place-cells-action',
      file: 'jev-agent/src/executor.ts',
      expect: 'symbol',
      text: 'private async runPlaceCells(',
    },
  ]),
  [PORTAL_FRAME_READY]: Object.freeze([
    {
      id: 'frame-ready-formatter',
      file: 'jev-agent/src/netherPortalPlan.ts',
      expect: 'call',
      text: 'export function formatPortalFrameReady(validation: PortalFrameValidation): string {',
    },
    {
      id: 'frame-ready-executor-call',
      file: 'jev-agent/src/executor.ts',
      expect: 'call',
      text: 'const ready = formatPortalFrameReady(validation)',
    },
  ]),
  [PORTAL_LIT]: Object.freeze([
    {
      id: 'portal-lit-formatter',
      file: 'jev-agent/src/netherPortalPlan.ts',
      expect: 'call',
      text: 'export function formatPortalLit(position: PortalBlockPosition, dimension: string = OVERWORLD): string {',
    },
    {
      id: 'portal-lit-executor-call',
      file: 'jev-agent/src/executor.ts',
      expect: 'call',
      text: "this.logger.info('agent', formatPortalLit(target, dimension),",
    },
    {
      id: 'run-ignite-action',
      file: 'jev-agent/src/executor.ts',
      expect: 'symbol',
      text: 'private async runIgnite(',
    },
  ]),
  [PORTAL_VERIFIED]: Object.freeze([
    {
      id: 'verify-portal-formatter',
      file: 'jev-agent/src/netherPortalPlan.ts',
      expect: 'call',
      text: 'export function verifyPortal(input: VerifyPortalInput): VerifyPortalResult {',
    },
    {
      id: 'verified-executor-call',
      file: 'jev-agent/src/executor.ts',
      expect: 'call',
      text: "this.logger.info('agent', verifyPortal({ lit: true, portalBlockPresent: true, dimension }).line,",
    },
  ]),
})

/**
 * Search each claimed emitter in its file and report the line it was actually
 * found on. Deterministic, read-only, no cache: provenance is derived evidence,
 * never a remembered constant.
 */
export function probeMarkerEmitters({ root = REPO_ROOT } = {}) {
  const probes = []
  const cache = new Map()
  for (const [marker, list] of Object.entries(MARKER_EMITTER_PROBES)) {
    for (const probe of list) {
      const absolute = join(root, probe.file)
      if (!cache.has(absolute)) {
        cache.set(absolute, existsSync(absolute) ? readFileSync(absolute, 'utf8').split('\n') : null)
      }
      const lines = cache.get(absolute)
      const line = lines === null ? -1 : lines.findIndex((entry) => entry.includes(probe.text))
      probes.push({
        marker,
        id: probe.id,
        file: probe.file,
        expect: probe.expect,
        text: probe.text,
        line: line === -1 ? -1 : line + 1,
        ok: line !== -1,
        // A probe that matches twice is not precise enough to be provenance.
        matches: lines === null ? 0 : lines.filter((entry) => entry.includes(probe.text)).length,
      })
    }
  }
  return probes
}

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
// fresh-run capability (no hand-fed post-prerequisite inventory)
// ---------------------------------------------------------------------------

/** A fresh body: a stone pickaxe and no M2 material. */
export const M2_FRESH_INVENTORY = Object.freeze({ stone_pickaxe: 1, cobblestone: 16 })
/** PICKAXE_TIER0 stone = 2. */
export const M2_FRESH_TOOL_RANK = 2

/**
 * Prove the chain's OWN gates from a fresh inventory, so "a fresh run must first
 * gather 3 diamonds -> diamond_pickaxe -> 10 obsidian (+ flint_and_steel)" is a
 * measured statement rather than an assumption.
 *
 * Every assertion here is negative-first: what the chain REFUSES without the
 * material is as important as what it does with it.
 */
export function rehearseFreshRunChain({ inventory = M2_FRESH_INVENTORY, toolRank = M2_FRESH_TOOL_RANK } = {}) {
  const rankWithoutDiamond = planObsidianMining(toolRank, 10)
  const rankWithDiamond = planObsidianMining(M2_READY_TOOL_RANK, 10)

  const plan = planNetherPortal({ inventory, toolRank })
  const prerequisiteKinds = plan.prerequisites.map((step) => step.kind)
  const obsidianStep = plan.prerequisites.find((step) => step.kind === 'collect' && step.item === OBSIDIAN) ?? null
  const pickaxeStep = plan.prerequisites.find((step) => step.kind === 'craft' && step.item === DIAMOND_PICKAXE) ?? null
  const diamondStep = plan.prerequisites.find((step) => step.kind === 'collect' && step.item === DIAMOND) ?? null
  // Several prerequisites share a `kind` (collect raw_iron / flint / diamond /
  // obsidian), so the order is the step's own index - never indexOf(kind).
  const prerequisiteIndex = (step) => (step === null ? -1 : plan.prerequisites.indexOf(step))
  const diamondAt = prerequisiteIndex(diamondStep)
  const pickaxeAt = prerequisiteIndex(pickaxeStep)
  const obsidianAt = prerequisiteIndex(obsidianStep)
  const prerequisitesOrdered = diamondAt !== -1 && pickaxeAt > diamondAt && obsidianAt > pickaxeAt

  // The frame leg: a valid 4x5 frame is exactly 10 placeable obsidian cells and
  // its own validated marker, independent of where the obsidian came from.
  const layout = portalFrameLayout(M2_READY_FRAME_ORIGIN, 'x')
  const cells = orderedPlacementCells(layout.frame)
  const validation = validatePortalFrame({ blocks: layout.frame, widthAxis: 'x' })
  const placedLines = cells.map((cell) => placedFrameCellLine(OBSIDIAN, OBSIDIAN, cell))
  const frameLine = frameReadyLine(cells, 'x')

  // The ignition leg: refused without flint_and_steel, offered with it.
  const withoutSteel = planPortalIgnition({ frame: validation, hasFlintAndSteel: false })
  const withSteel = planPortalIgnition({ frame: validation, hasFlintAndSteel: true })

  return {
    inventory,
    toolRank,
    mining: {
      refused: rankWithoutDiamond.attempted === false,
      refusedLine: rankWithoutDiamond.line,
      allowedWithDiamond: rankWithDiamond.attempted === true,
      allowedLine: rankWithDiamond.line,
    },
    plan: {
      ready: plan.ready === true,
      prerequisiteKinds,
      prerequisitesOrdered,
      diamondIndex: diamondAt,
      pickaxeIndex: pickaxeAt,
      obsidianIndex: obsidianAt,
      diamondCount: diamondStep === null ? null : diamondStep.count ?? null,
      obsidianCount: obsidianStep === null ? null : obsidianStep.count ?? null,
      obsidianRequiredPickaxeRank: obsidianStep === null ? null : obsidianStep.requiredPickaxeRank ?? null,
      pickaxePostcondition: pickaxeStep === null ? null : pickaxeStep.postcondition?.kind ?? null,
      portalStepCount: plan.steps.length,
    },
    frame: {
      cells: cells.length,
      shape: validation.shape,
      blocks: validation.blocks,
      allCellsPlaceable: placedLines.every((line) => typeof line === 'string' && line.startsWith(PORTAL_BLOCK_PLACED)),
      frameLine,
      interiorCells: validation.interior.length,
    },
    ignition: {
      refusedWithoutSteel: withoutSteel.ok === false,
      refusalLine: withoutSteel.ok === false ? withoutSteel.line : null,
      offeredWithSteel: withSteel.ok === true,
      litLine: withSteel.ok === true ? withSteel.candidate.line : null,
    },
  }
}

// ---------------------------------------------------------------------------
// synthetic single-run fixture (log + runner.out + decisions + snapshot dir)
// ---------------------------------------------------------------------------

const RUN_ID = 'run-m2-rehearsal'
// Synthetic source identity for this offline fixture. It is deliberately an
// exact SHA-shaped value so the real gate exercises the same source grammar as
// a live BOOT; it does not claim to identify a production checkout.
const FIXTURE_SOURCE_SHA = 'a'.repeat(40)
const FIXTURE_GENERATION_ID = 'gen-m2-chain-fixture'
const FIXTURE_BUILD_HASH = 'c'.repeat(12)
const FIXTURE_SYSTEM2_PROVIDER = 'model-provider'
const FIXTURE_SYSTEM2_MODEL = 'model-v1'
const fixtureSystem2Identity =
  `generationId=${FIXTURE_GENERATION_ID} sourceSha=${FIXTURE_SOURCE_SHA} buildHash=${FIXTURE_BUILD_HASH} ` +
  `configuredProvider=${FIXTURE_SYSTEM2_PROVIDER} configuredModel=${FIXTURE_SYSTEM2_MODEL} trigger=queue_empty`

function stamp(seconds) {
  return new Date(Date.UTC(2026, 8, 20, 10, 0, seconds)).toISOString()
}

const BOOT_LINE = `[${stamp(0)}] BOOT pid=4242 runId=${RUN_ID} bundle=none source=${FIXTURE_SOURCE_SHA} worldEpoch=1`

/**
 * Materialize an offline fixture. `markerLines` are the plan-derived lines;
 * `portalTruthLine` is the optional inherited-portal observation (no chain);
 * `inventory` is emitted as the run's two inventory samples (default: the
 * post-prerequisite inventory; a fresh-run case passes one that is NOT ready).
 * Every case gets its own directory so evidence can never bleed across cases.
 */
export function materializeSyntheticRun({ caseName, markerLines, portalTruthLine = null, inventory = M2_READY_INVENTORY }) {
  const dir = mkdtempSync(join(tmpdir(), `m2-chain-${caseName}-`))
  const snapshotDir = join(dir, 'snapshots')
  mkdirSync(snapshotDir)
  const diamondSample = {
    [DIAMOND]: inventory[DIAMOND] ?? 0,
    [DIAMOND_PICKAXE]: inventory[DIAMOND_PICKAXE] ?? 0,
  }
  const materialsSample = {
    [FLINT_AND_STEEL]: inventory[FLINT_AND_STEEL] ?? 0,
    [OBSIDIAN]: inventory[OBSIDIAN] ?? 0,
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
    `[${stamp(1)}] GENERATION_READY id=${FIXTURE_GENERATION_ID} generationId=${FIXTURE_GENERATION_ID} sourceSha=${FIXTURE_SOURCE_SHA} buildHash=${FIXTURE_BUILD_HASH} system2ConfiguredProvider=${FIXTURE_SYSTEM2_PROVIDER} system2ConfiguredModel=${FIXTURE_SYSTEM2_MODEL} policy=typesafe model=typesafe-ai/jev planner=llm deterministicFallbackEnabled=false`,
    `[${stamp(1.5)}] SYSTEM2_AUTHORITY_INPUT ${fixtureSystem2Identity} provider=${FIXTURE_SYSTEM2_PROVIDER} model=${FIXTURE_SYSTEM2_MODEL}`,
    `[${stamp(2)}] SYSTEM2_AUTHORITY_DECISION ${fixtureSystem2Identity} provider=${FIXTURE_SYSTEM2_PROVIDER} model=${FIXTURE_SYSTEM2_MODEL} chosen=front_nether_portal goals=[front_nether_portal]`,
    `[${stamp(30)}] HOST_LOCK released pid=4242 runId=${RUN_ID}`,
  ]
  const decisionsLines = [
    JSON.stringify({
      record: 'decision',
      ts: stamp(3),
      runId: RUN_ID,
      generationId: FIXTURE_GENERATION_ID,
      sourceSha: FIXTURE_SOURCE_SHA,
      source: 'jev',
      kind: 'place',
      reason: 'fixture:model_authored_jev_decision',
    }),
    JSON.stringify({
      record: 'decision',
      ts: stamp(4),
      runId: RUN_ID,
      generationId: FIXTURE_GENERATION_ID,
      sourceSha: FIXTURE_SOURCE_SHA,
      source: 'jev',
      kind: 'place',
      reason: 'fixture:model_authored_jev_decision',
    }),
  ]
  writeFileSync(join(dir, 'buddy.log'), `${logLines.join('\n')}\n`)
  writeFileSync(join(dir, 'runner.out'), `${runnerOutLines.join('\n')}\n`)
  writeFileSync(join(dir, 'decisions.jsonl'), `${decisionsLines.join('\n')}\n`)
  // The same run in the DECLARED resident-tree layout (`--root <dir>`), so the
  // rehearsal can drive the real gate's OPERATOR surface as well as its
  // explicit-path surface. No control socket is created: the run stays offline.
  const homeDir = join(dir, 'buddy-driver')
  mkdirSync(join(homeDir, 'logs', 'jev'), { recursive: true })
  mkdirSync(join(homeDir, 'data', 'resident'), { recursive: true })
  writeFileSync(join(homeDir, 'buddy.log'), `${logLines.join('\n')}\n`)
  writeFileSync(join(homeDir, 'runner.out'), `${runnerOutLines.join('\n')}\n`)
  writeFileSync(join(homeDir, 'logs', 'jev', 'decisions.jsonl'), `${decisionsLines.join('\n')}\n`)
  return {
    dir,
    homeDir: dir,
    runId: RUN_ID,
    inventory,
    logPath: join(dir, 'buddy.log'),
    snapshotDir,
    decisionsPath: join(dir, 'decisions.jsonl'),
    runnerOutPath: join(dir, 'runner.out'),
    // Deliberately absent: forces the gate to use runner.out, keeping the run offline.
    controlSocketPath: join(dir, 'control.sock'),
  }
}

/**
 * Invoke the REAL tools/m2-gate.mjs as a subprocess and parse its verdict.
 * `mode: 'declared-root'` uses the operator surface (`--root <tree>`, no explicit
 * evidence paths), proving a run's evidence is reachable by declaration alone;
 * `mode: 'explicit'` (default) names every path, as the earlier cases do.
 */
export function runRealGate({
  fixture,
  gatePath = M2_CHAIN_GATE_PATH,
  runtime = process.execPath,
  mode = 'explicit',
} = {}) {
  const cmd =
    mode === 'declared-root'
      ? [runtime, gatePath, '--run', fixture.runId, '--root', fixture.homeDir ?? fixture.dir, '--no-discover']
      : [
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
  // The gate's ordered chain trace, parsed back through the gate's own parser.
  const chainLinks = stdout
    .split('\n')
    .filter((line) => line.startsWith('m2_chain:'))
    .map((line) => parsePortalChainLine(line))
    .filter((link) => link !== null)
  return {
    cmd,
    exitCode: proc.exitCode,
    stdout,
    stderr,
    resultLine,
    status,
    reason,
    chainLinks,
    statusLine: stdout.split('\n').find((line) => line.startsWith('portal_lit: ')) ?? null,
    evidenceRootsLine: stdout.split('\n').find((line) => line.startsWith('m2_evidence_roots: ')) ?? null,
    policyLine: stdout.split('\n').find((line) => line.startsWith('policy: ')) ?? null,
  }
}

/**
 * One-line rendering of the gate's parsed chain trace, for the rehearsal report.
 * Deterministic and source-ordered, so two runs of the rehearsal are comparable.
 */
export function formatChainTrace(links) {
  const list = Array.isArray(links) ? links : []
  if (list.length === 0) return 'trace=missing'
  return list
    .map(
      (link) =>
        `source=${link.source} built=${link.built} lit=${link.lit} verified=${link.verified} ` +
        `ordered=${link.ordered} overworld=${link.overworld === null ? 'unknown' : link.overworld} ` +
        `indices=${link.indices.placed},${link.indices.frame},${link.indices.lit},${link.indices.verified}`,
    )
    .join(' | ')
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
  for (const [step, gateStage] of Object.entries(PLAN_STEP_GATE_STAGES)) {
    const names = rehearsal.emittedSteps
      .filter((entry) => entry.kind === step)
      .flatMap((entry) => entry.markers.map((marker) => marker.name))
    write(`M2_CHAIN_REHEARSAL_MAPPING step=${step} gateStage=${gateStage} markers=${[...new Set(names)].join(',') || 'none'}`)
  }

  // --- the emitter claims are PROBED, never remembered -----------------------
  const probes = probeMarkerEmitters()
  details.probes = probes
  for (const probe of probes) {
    write(
      `M2_CHAIN_REHEARSAL_EMITTER marker=${probe.marker} probe=${probe.id} file=${probe.file}:${probe.line} ` +
        `expect=${probe.expect} ok=${probe.ok} matches=${probe.matches}`,
    )
    if (!probe.ok) missing.push(`emitter_probe_missing:${probe.marker}:${probe.id}:${probe.file}`)
    else if (probe.matches !== 1) missing.push(`emitter_probe_ambiguous:${probe.marker}:${probe.id}:${probe.file}:matches=${probe.matches}`)
  }

  write(`M2_CHAIN_REHEARSAL_ORDER emitted=${rehearsal.emittedStages.join('>')} required=${GATE_REQUIRED_MARKER_ORDER.join('>')}`)
  write(`M2_CHAIN_REHEARSAL_FRAME blocks=${rehearsal.frame.blocks} shape=${rehearsal.frame.shape} line="${rehearsal.frame.frameLine}"`)
  write(`M2_CHAIN_REHEARSAL_LIT line="${rehearsal.frame.litLine}"`)

  // --- fresh-run capability: what the chain needs and what it refuses --------
  const fresh = rehearseFreshRunChain()
  details.fresh = fresh
  if (!fresh.mining.refused) missing.push('fresh_mining_not_refused_without_diamond_pickaxe')
  if (!fresh.mining.allowedWithDiamond) missing.push('fresh_mining_not_allowed_with_diamond_pickaxe')
  if (!fresh.plan.prerequisitesOrdered) {
    missing.push(
      `fresh_prerequisites_unordered:diamond=${fresh.plan.diamondIndex} pickaxe=${fresh.plan.pickaxeIndex} obsidian=${fresh.plan.obsidianIndex}`,
    )
  }
  if (fresh.plan.obsidianRequiredPickaxeRank !== M2_READY_TOOL_RANK) {
    missing.push(`fresh_obsidian_rank=${fresh.plan.obsidianRequiredPickaxeRank} expected=${M2_READY_TOOL_RANK}`)
  }
  if (fresh.frame.cells !== 10 || fresh.frame.shape !== 'ok' || !fresh.frame.allCellsPlaceable) {
    missing.push(`fresh_frame:cells=${fresh.frame.cells} shape=${fresh.frame.shape} placeable=${fresh.frame.allCellsPlaceable}`)
  }
  if (!fresh.ignition.refusedWithoutSteel || !fresh.ignition.offeredWithSteel) {
    missing.push(`fresh_ignition:refused=${fresh.ignition.refusedWithoutSteel} offered=${fresh.ignition.offeredWithSteel}`)
  }
  write(
    `M2_CHAIN_REHEARSAL_FRESH inventory=${JSON.stringify(fresh.inventory)} toolRank=${fresh.toolRank} ` +
      `prerequisites=${fresh.plan.prerequisiteKinds.join('>')} ordered=${fresh.plan.prerequisitesOrdered} ` +
      `obsidianRank=${fresh.plan.obsidianRequiredPickaxeRank}`,
  )
  write(`M2_CHAIN_REHEARSAL_FRESH_MINING refused="${fresh.mining.refusedLine}" allowed="${fresh.mining.allowedLine}"`)
  write(
    `M2_CHAIN_REHEARSAL_FRESH_FRAME cells=${fresh.frame.cells} shape=${fresh.frame.shape} ` +
      `interior=${fresh.frame.interiorCells} placeable=${fresh.frame.allCellsPlaceable} line="${fresh.frame.frameLine}"`,
  )
  write(`M2_CHAIN_REHEARSAL_FRESH_IGNITION refused="${fresh.ignition.refusalLine}" lit="${fresh.ignition.litLine}"`)

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
  {
    // The gate's own ordered trace must name all three links PROVEN, from the
    // source that carried them, in order. A PASS whose trace cannot say that is a
    // GAP: the artifact would carry a verdict with no chain evidence.
    const link = positive.chainLinks.find((entry) => entry.source !== 'none') ?? null
    write(`M2_CHAIN_REHEARSAL_CHAIN case=chain ${formatChainTrace(positive.chainLinks)}`)
    if (link === null) {
      missing.push('chain_trace_missing:chain')
    } else {
      if (link.built !== 'PASS' || link.lit !== 'PASS' || link.verified !== 'PASS') {
        missing.push(`chain_trace_links:built=${link.built} lit=${link.lit} verified=${link.verified}`)
      }
      if (link.ordered !== true) missing.push('chain_trace_not_ordered')
      if (link.overworld !== true) missing.push(`chain_trace_overworld=${link.overworld}`)
      if (!(link.indices.placed < link.indices.frame && link.indices.frame < link.indices.lit && link.indices.lit < link.indices.verified)) {
        missing.push(`chain_trace_indices:${JSON.stringify(link.indices)}`)
      }
    }
  }

  // --- case a2: the SAME chain through the operator's declared-root surface ---
  // The rehearsal above names every path. The operator does not: they declare the
  // tree that produced the run (`--root <tree>`, the contract
  // tools/m3-acceptance-bundle.mjs documents). If the declared-root surface cannot
  // reach the chain the explicit surface just proved, a live run's evidence stays
  // unreachable in practice - so it is asserted, not assumed.
  const declaredFixture = materializeSyntheticRun({ caseName: 'declared-root', markerLines: rehearsal.emittedLines })
  let declared
  try {
    declared = runRealGate({ fixture: declaredFixture, mode: 'declared-root' })
  } finally {
    if (cleanup) rmSync(declaredFixture.dir, { recursive: true, force: true })
  }
  details.declaredRoot = declared
  write(`M2_CHAIN_REHEARSAL_GATE case=declared_root status=${declared.status} reason=${declared.reason} exit=${declared.exitCode}`)
  write(`M2_CHAIN_REHEARSAL_GATE_RESULT case=declared_root ${declared.resultLine ?? 'M2_RUN_RESULT missing'}`)
  write(`M2_CHAIN_REHEARSAL_EVIDENCE_ROOTS case=declared_root ${declared.evidenceRootsLine ?? 'm2_evidence_roots missing'}`)
  write(`M2_CHAIN_REHEARSAL_CHAIN case=declared_root ${formatChainTrace(declared.chainLinks)}`)
  if (declared.status !== 'PASS' || declared.exitCode !== 0) {
    missing.push(`declared_root_gate_not_pass:status=${declared.status} reason=${declared.reason} exit=${declared.exitCode}`)
  }
  {
    const link = declared.chainLinks.find((entry) => entry.source !== 'none') ?? null
    if (link === null || link.built !== 'PASS' || link.lit !== 'PASS' || link.verified !== 'PASS' || link.ordered !== true) {
      missing.push(`declared_root_chain_trace:${formatChainTrace(declared.chainLinks)}`)
    }
    if (declared.policyLine === null || !declared.policyLine.startsWith('policy: VERIFIED')) {
      missing.push(`declared_root_policy:${declared.policyLine ?? 'missing'}`)
    }
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
  {
    const link = inherited.chainLinks.find((entry) => entry.source !== 'none') ?? null
    write(`M2_CHAIN_REHEARSAL_CHAIN case=inherited ${formatChainTrace(inherited.chainLinks)}`)
    if (link === null) missing.push('chain_trace_missing:inherited')
    else if (link.built === 'PASS' || link.lit === 'PASS' || link.verified === 'PASS' || link.ordered) {
      missing.push(`inherited_chain_trace_claimed_links:${formatChainTrace(inherited.chainLinks)}`)
    }
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

  // --- case d: a FRESH run's own evidence never PASSes ----------------------
  // The fresh inventory cannot satisfy diamond_ready / portal_materials_ready, and
  // there is no chain: the gate must say UNKNOWN. This is the outcome half of the
  // fresh-run capability case above.
  const freshFixture = materializeSyntheticRun({
    caseName: 'fresh',
    markerLines: [],
    inventory: M2_FRESH_INVENTORY,
  })
  let freshGate
  try {
    freshGate = runRealGate({ fixture: freshFixture })
  } finally {
    if (cleanup) rmSync(freshFixture.dir, { recursive: true, force: true })
  }
  details.freshGate = freshGate
  write(`M2_CHAIN_REHEARSAL_GATE case=fresh status=${freshGate.status} reason=${freshGate.reason} exit=${freshGate.exitCode}`)
  write(`M2_CHAIN_REHEARSAL_GATE_RESULT case=fresh ${freshGate.resultLine ?? 'M2_RUN_RESULT missing'}`)
  write(`M2_CHAIN_REHEARSAL_CHAIN case=fresh ${formatChainTrace(freshGate.chainLinks)}`)
  if (freshGate.status === 'PASS' || freshGate.exitCode === 0) {
    missing.push(`fresh_negative:status=${freshGate.status} exit=${freshGate.exitCode}`)
  }
  if (freshGate.status !== 'UNKNOWN') missing.push(`fresh_not_unknown:status=${freshGate.status}`)
  {
    const link = freshGate.chainLinks.find((entry) => entry.source !== 'none') ?? null
    if (link === null) missing.push('chain_trace_missing:fresh')
    else if (link.built === 'PASS' || link.lit === 'PASS' || link.verified === 'PASS') {
      missing.push(`fresh_chain_trace_claimed_links:${formatChainTrace(freshGate.chainLinks)}`)
    }
  }

  const result = missing.length === 0 ? 'READY' : 'GAP'
  details.result = result
  details.missing = missing
  write(
    `M2_CHAIN_REHEARSAL result=${result} stages=${rehearsal.stepKinds.join('>')} ` +
      `markers=${rehearsal.emittedStages.join('>')} missing=${missing.length === 0 ? 'none' : missing.join(',')} ` +
      `gate=${positive.status ?? 'none'} inherited=${inherited.status ?? 'none'}/${inherited.reason ?? 'none'} ` +
      `lit_no_dimension=${noDimension.status ?? 'none'} fresh=${freshGate.status ?? 'none'} ` +
      `emitter_probes=${probes.filter((probe) => probe.ok).length}/${probes.length}`,
  )
  return details
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const report = runRehearsal({ write: (line) => process.stdout.write(`${line}\n`) })
  process.exitCode = report.result === 'READY' ? 0 : 1
}
