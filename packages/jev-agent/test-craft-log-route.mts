// Regression for the M2 prerequisite route: a craft goal may be blocked by a
// missing log even when the current goal is not itself `collect log`.
//
// The craft prerequisite is owned by the RECIPE layer: `craftCandidates` ->
// `craftIngredientRoute` descends the recipe chain of the first missing
// ingredient to its raw producer and offers that route (the same producer
// `completeStartablePrerequisites` names). These cases therefore pass the real
// recipe index, exactly as production always does (`candidateOptions` in
// controller-legacy.ts builds it from `bot.registry`).
//
// History: cases (1)/(2) used to call `generateGroundedCandidates` with
// `defaultCandidateOptions` (`recipes: null`). In that degraded shape
// `craftCandidates` returns early and the log route could only come from
// `retrievalNeeds` exposing the unresolved QUEUED `collect log` row. #341
// deliberately removed that generic queued-row fallback (`ce83ba7`, and its
// sibling `test-retrieve-focus-filter` case (c) now pins that a future queue
// sibling must not cross the active row). A queued row is not a substitute for
// the recipe-owned prerequisite expansion, so the fixture now supplies recipes.
//
// A safe step cut is preferred over pillar-up when available. Without one, a
// held placeable block grounds the pillar route and no block leaves a typed
// needs_ascend refusal plus sensed/exploration recovery. A separate case pins
// the no-placeable safe staircase introduced by #462.

import { craftStationGap, defaultCandidateOptions, formatCraftStationGap, generateGroundedCandidates, logRouteOf, optionsWithWithheldStationRetirements } from './src/candidates.ts'
import { createRequire } from 'node:module'
import { createRecipeIndex } from './src/crafting.ts'
import type { AgentSignals, BlockState, GoalState, InventoryState, KnownResource, SelfState, StepCut, Vec3Json, WorldState } from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'

const require = createRequire(import.meta.url)
const recipes = createRecipeIndex(require('minecraft-data')('1.21.11') as unknown)

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_CRAFT_LOG_ROUTE',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'overworld',
    isDay: true,
    heldItem: null,
  }
}

function inventory(counts: Record<string, number>): InventoryState {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, count) => sum + count, 0) }
}

function signals(overrides: Partial<AgentSignals> = {}): AgentSignals {
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
    ...overrides,
  }
}

function queuedGoal(overrides: Partial<QueuedGoal>): QueuedGoal {
  return {
    id: 'g-craft-wooden-pickaxe',
    kind: 'craft',
    description: 'craft 1 x wooden_pickaxe',
    targetItem: 'wooden_pickaxe',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'bootstrap',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
    ...overrides,
  }
}

function queue(current: QueuedGoal, ...goals: QueuedGoal[]): GoalQueueState {
  return {
    depth: 1 + goals.length,
    current,
    empty: false,
    hasImpossible: false,
    done: 0,
    goals: [current, ...goals],
  }
}

function world(
  inventoryCounts: Record<string, number> = { birch_planks: 2, stick: 2, cobblestone: 170, dirt: 37 },
  withSensedLog = true,
  extraStandable: Vec3Json[] = [],
  withSafeUpStep = false,
): WorldState {
  const position = { x: 39, y: 11, z: 32 }
  const current = queuedGoal({})
  const logGoal = queuedGoal({
    id: 'g-collect-log',
    kind: 'collect',
    description: 'collect 1 x log',
    targetItem: 'log',
    origin: 'mechanical',
  })
  const rememberedLog: KnownResource = {
    name: 'oak_log',
    kind: 'log', dimension: 'minecraft:overworld',
    position: { x: 27, y: 65, z: 19 },
  }
  const rememberedTable: KnownResource = {
    name: 'crafting_table',
    kind: 'station', dimension: 'minecraft:overworld',
    position: { x: 39, y: 3, z: 32 },
  }
  const blockingStone: BlockState = {
    kind: 'stone',
    name: 'stone',
    position: { x: 39, y: 12, z: 31 },
    distance: 1,
    diggable: true,
    inReach: false,
    hasAdjacentStandable: true,
    adjacentStandable: position,
    yield: 'cobblestone',
    harvestTool: 'pickaxe',
    harvestTier: 0,
    visible: true,
  }
  const blockedStep: StepCut = {
    dir: 'N',
    dx: 0,
    dz: -1,
    cut: { x: 39, y: 12, z: 31 },
    step: { x: 39, y: 12, z: 31 },
    name: 'stone',
    safe: true,
    reason: 'safe',
  }
  const sensedLog: BlockState = {
    kind: 'log',
    name: 'oak_log',
    position: { x: 50, y: 11, z: 32 },
    distance: 11,
    diggable: true,
    inReach: false,
    hasAdjacentStandable: true,
    adjacentStandable: { x: 49, y: 11, z: 32 },
    yield: 'oak_log',
    harvestTool: null,
    harvestTier: null,
    visible: true,
  }
  const goal: GoalState = {
    id: current.id,
    description: current.description,
    targetItem: current.targetItem ?? 'wooden_pickaxe',
    requiredCount: current.requiredCount,
    startCount: current.startCount,
    haveCount: current.haveCount,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
  return {
    schemaVersion: 1,
    tick: 41,
    timestampMs: 1_700_000_000_000,
    self: self(position),
    inventory: inventory(inventoryCounts),
    entities: [],
    blocks: withSensedLog ? [blockingStone, sensedLog] : [blockingStone],
    terrain: {
      standable: [position, { x: 41, y: 11, z: 32 }, { x: 42, y: 11, z: 32 }, ...extraStandable],
    },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: [],
    stepCuts: withSafeUpStep ? [blockedStep] : [],
    headroomCuts: [],
    goal,
    goalQueue: queue(current, logGoal),
    recentEvents: [],
    signals: signals({ knownResources: [rememberedLog, rememberedTable] }),
  }
}

// (0) A remembered table below the current level must not starve a craft goal.
// A withdrawn station retrieve is a cell that CANNOT be reached this decision, so
// it is not usable and no longer suppresses the local 2x2 table craft: the gate
// offers `CRAFT:crafting_table` (materials held) while the station keeps its own
// typed withholding (`needs_descend`). This restores the local-table recovery for
// the retired-station case (live: run-mubobiq6-12onv idled with table materials
// in hand; pinned by test-tool-recovery).
{
  const grounded = generateGroundedCandidates(
    world({ birch_planks: 4, stick: 2 }),
    { ...defaultCandidateOptions, recipes },
  )
  const duplicateCraft = grounded.candidates.find((candidate) => candidate.id === 'CRAFT:crafting_table')
  const withheldStation = grounded.withheld.find((entry) => entry.candidate.meta.resourceKind === 'station')
  const gap = craftStationGap(
    world({ birch_planks: 4, stick: 2 }),
    optionsWithWithheldStationRetirements({ ...defaultCandidateOptions, recipes }, grounded.withheld),
  )
  const gapLine = gap === null ? 'none' : formatCraftStationGap(gap)
  const pass =
    duplicateCraft !== undefined &&
    withheldStation !== undefined &&
    withheldStation.result.reason === 'needs_descend' &&
    gap === null
  process.stdout.write(
    `craft station recovery for an unreachable remembered table: ${pass ? 'PASS' : 'FAIL'} ` +
      `candidates=[${grounded.candidates.map((candidate) => candidate.id).join(',')}] ` +
      `withheld=${withheldStation?.result.reason ?? 'none'} duplicate=${duplicateCraft?.id ?? 'none'} gap=${gapLine}\n`,
  )
  if (!pass) process.exitCode = 1
}

// (1) The pillar route remains available when geometry has no safe stair cut.
{
  const grounded = generateGroundedCandidates(world(), { ...defaultCandidateOptions, recipes })
  const ids = grounded.candidates.map((candidate) => candidate.id)
  const retrieve = grounded.candidates.find((candidate) => candidate.id === 'RETRIEVE:known:log:b27_65_19')
  const withheldLog = grounded.withheld.find((entry) => entry.candidate.meta.resourceKind === 'log')
  const pass =
    retrieve !== undefined &&
    retrieve.affordance?.feasible === true &&
    retrieve.meta.vertical === 'pillar' &&
    retrieve.meta.pillarPlaceName === 'cobblestone' &&
    withheldLog === undefined &&
    grounded.candidates.some((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')

  process.stdout.write(
    `craft prerequisite log route (placeable held): ${pass ? 'PASS' : 'FAIL'} candidates=[${ids.join(',')}] ` +
      `vertical=${String(retrieve?.meta.vertical ?? 'none')} place=${String(retrieve?.meta.pillarPlaceName ?? 'none')} ` +
      `withheld=${withheldLog?.result.reason ?? 'none'}\n`,
  )
  if (!pass) process.exitCode = 1
}

// (2) Without a placeable block or a safe stair cut, the remembered ascent is
// truthfully withheld; the sensed log is still a grounded craft-prerequisite route.
{
  const grounded = generateGroundedCandidates(
    world({ birch_planks: 2, stick: 2 }),
    { ...defaultCandidateOptions, recipes },
  )
  const ids = grounded.candidates.map((candidate) => candidate.id)
  const route = logRouteOf(grounded.candidates)
  const withheldLog = grounded.withheld.find((entry) => entry.candidate.meta.resourceKind === 'log')
  const pass =
    route !== null &&
    route.mode === 'mine_sensed' &&
    withheldLog !== undefined &&
    withheldLog.result.reason === 'needs_ascend' &&
    grounded.candidates.some((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')

  process.stdout.write(
    `craft prerequisite log route (no placeable): ${pass ? 'PASS' : 'FAIL'} candidates=[${ids.join(',')}] ` +
      `mode=${route?.mode ?? 'none'} withheld=${withheldLog?.result.reason ?? 'none'}\n`,
  )
  if (!pass) process.exitCode = 1
}

// (3) With no placeable, sensed log, or safe stair cut, the remembered log
// route is withheld and bounded exploration points toward the log bearing.
{
  const grounded = generateGroundedCandidates(
    world({ birch_planks: 2, stick: 2 }, false, [{ x: 36, y: 11, z: 32 }]),
    { ...defaultCandidateOptions, recipes },
  )
  const ids = grounded.candidates.map((candidate) => candidate.id)
  const route = logRouteOf(grounded.candidates)
  const withheldLog = grounded.withheld.find((entry) => entry.candidate.meta.resourceKind === 'log')
  const pass =
    route !== null &&
    route.mode === 'explore' &&
    route.target.x === 36 &&
    withheldLog !== undefined &&
    withheldLog.result.reason === 'needs_ascend' &&
    grounded.candidates.some((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')

  process.stdout.write(
    `craft prerequisite log route (no placeable, no sensed log): ${pass ? 'PASS' : 'FAIL'} ` +
      `candidates=[${ids.join(',')}] mode=${route?.mode ?? 'none'} target=${route === null ? 'none' : `${route.target.x},${route.target.y},${route.target.z}`} ` +
      `withheld=${withheldLog?.result.reason ?? 'none'}\n`,
  )
  if (!pass) process.exitCode = 1
}

// (4) #462 separates clearing a known blocker from harvesting its drop. A safe
// stone cut can be punched by hand, so a placeable block is not required for
// this grounded staircase-up retrieval. This keeps the old ascent refusal test
// honest without accidentally classifying mechanically valid step geometry as
// an unavailable route.
{
  const grounded = generateGroundedCandidates(
    world({ birch_planks: 2, stick: 2 }, true, [], true),
    { ...defaultCandidateOptions, recipes },
  )
  const retrieve = grounded.candidates.find((candidate) => candidate.id === 'RETRIEVE:known:log:b27_65_19')
  const withheldLog = grounded.withheld.find((entry) => entry.candidate.meta.resourceKind === 'log')
  const pass =
    retrieve?.affordance?.feasible === true &&
    retrieve.meta.vertical === 'staircase-up' &&
    retrieve.meta.logRoute === 'ascend_then_mine' &&
    withheldLog === undefined
  process.stdout.write(
    `craft prerequisite log route (safe step cut, no placeable): ${pass ? 'PASS' : 'FAIL'} ` +
      `candidates=[${grounded.candidates.map((candidate) => candidate.id).join(',')}] ` +
      `vertical=${String(retrieve?.meta.vertical ?? 'none')} withheld=${withheldLog?.result.reason ?? 'none'}\n`,
  )
  if (!pass) process.exitCode = 1
}
