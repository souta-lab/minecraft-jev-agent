// Regression for the M2 prerequisite route: a craft goal may be blocked by a
// missing log even when the current goal is not itself `collect log`.
//
// The craft prerequisite is owned by the RECIPE layer: `craftCandidates` ->
// `craftIngredientRoute` descends the recipe chain of the first missing
// ingredient to its raw producer and offers that route (the same producer
// `completeStartablePrerequisites` names). These cases therefore pass the real
// recipe index, exactly as production always does (`candidateOptions` in
// controller.ts builds it from `bot.registry`).
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
import { routeScaffoldCounts, selectPlaceableBlock } from './src/pillarSearch.ts'
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

// (5) portal-p22: a route never spends the active collect goal's own target as
// scaffolding. Live: under `collect log` the body pillared with its only
// jungle_log, then mined the placed block back (both SUCCESS) for 8+ cycles.
// The collect target is withheld from the route's placeable; another held
// placeable still grounds the pillar; a non-collect goal keeps p21.6 log footing.
{
  const collectLog = queuedGoal({
    id: 'g-collect-log',
    kind: 'collect',
    description: 'collect 3 x log',
    targetItem: 'log',
    requiredCount: 3,
  })
  const asCollect = (state: WorldState): WorldState => ({ ...state, goalQueue: queue(collectLog) })
  const routeOf = (state: WorldState) =>
    generateGroundedCandidates(state, { ...defaultCandidateOptions, recipes }).candidates.find(
      (candidate) => candidate.id === 'RETRIEVE:known:log:b27_65_19',
    )
  const onlyTargetGrounded = generateGroundedCandidates(asCollect(world({ jungle_log: 1 }, false)), { ...defaultCandidateOptions, recipes })
  const spendsTarget = onlyTargetGrounded.candidates.some((candidate) =>
    Object.values(candidate.meta).includes('jungle_log') && candidate.kind !== 'MINE',
  )
  const onlyTargetWithheld = onlyTargetGrounded.withheld.find((entry) => entry.candidate.id === 'RETRIEVE:known:log:b27_65_19')
  const withDirt = routeOf(asCollect(world({ jungle_log: 1, dirt: 3 }, false)))
  // Non-collect goals (and an empty queue) keep the p21.6 log footing.
  const craftGoal = selectPlaceableBlock(routeScaffoldCounts({ oak_log: 5 }, queue(queuedGoal({}))))?.name ?? 'none'
  const noGoal = selectPlaceableBlock(routeScaffoldCounts({ oak_log: 5 }, null))?.name ?? 'none'
  const collectStone = selectPlaceableBlock(
    routeScaffoldCounts({ cobblestone: 9, oak_log: 2 }, queue(queuedGoal({ kind: 'collect', targetItem: 'cobblestone' }))),
  )?.name ?? 'none'
  const pass =
    !spendsTarget &&
    onlyTargetWithheld?.result.reason === 'needs_ascend' &&
    withDirt?.meta.vertical === 'pillar' &&
    withDirt.meta.pillarPlaceName === 'dirt' &&
    craftGoal === 'oak_log' &&
    noGoal === 'oak_log' &&
    collectStone === 'oak_log'
  process.stdout.write(
    `collect target is never route scaffolding: ${pass ? 'PASS' : 'FAIL'} ` +
      `onlyTarget=spends:${spendsTarget}/withheld:${onlyTargetWithheld?.result.reason ?? 'none'} ` +
      `withDirt=${String(withDirt?.meta.pillarPlaceName ?? 'none')} craftGoal=${craftGoal} noGoal=${noGoal} collectStone=${collectStone}\n`,
  )
  if (!pass) process.exitCode = 1
}

// portal-p23 regression: the p22.1 protection covered only the collect target,
// so a live DESCEND spent `craft:furnace`'s cobblestone feedstock as route
// scaffolding (10 -> 3, measured). The spendable view now withholds every item
// the ACTIVE goal still requires - craft materials (recursively, through the
// variant `planNextCraftStep` would take), smelt input + enough of the best
// held fuel, and the place payload - while the verified surplus above the
// requirement stays spendable.
{
  const countsFor = (held: Record<string, number>, goal: QueuedGoal) =>
    routeScaffoldCounts(held, queue(goal), recipes)

  // Direct ingredient: 8 cobblestone for one furnace -> surplus 2 spends, dirt is free.
  const furnace = countsFor(
    { cobblestone: 10, dirt: 4 },
    queuedGoal({ id: 'g-craft-furnace', kind: 'craft', targetItem: 'furnace', requiredCount: 1 }),
  )
  const furnaceOk = furnace['cobblestone'] === 2 && furnace['dirt'] === 4

  // Recursive + cumulative earmark: a pickaxe needs 3 planks and 2 sticks;
  // with nothing held, the logs for BOTH branches are withheld.
  const pick = countsFor(
    { oak_log: 2, dirt: 4 },
    queuedGoal({ kind: 'craft', targetItem: 'wooden_pickaxe', requiredCount: 1 }),
  )
  const pickOk = (pick['oak_log'] ?? 0) === 0 && pick['dirt'] === 4

  // Held units are earmarked once across branches: 3 held planks cover the
  // pickaxe head, so the stick chain still needs planks -> logs stay withheld.
  const pickPartial = countsFor(
    { oak_log: 2, oak_planks: 3 },
    queuedGoal({ kind: 'craft', targetItem: 'wooden_pickaxe', requiredCount: 1 }),
  )
  const pickPartialOk = (pickPartial['oak_log'] ?? 0) === 1

  // Outstanding semantics: held product shrinks the material requirement;
  // a satisfied craft goal withholds nothing.
  const furnaceTwo = countsFor(
    { furnace: 1, cobblestone: 10 },
    queuedGoal({ kind: 'craft', targetItem: 'furnace', requiredCount: 2 }),
  )
  const furnaceDone = countsFor(
    { furnace: 1, cobblestone: 10 },
    queuedGoal({ kind: 'craft', targetItem: 'furnace', requiredCount: 1 }),
  )
  const outstandingOk = furnaceTwo['cobblestone'] === 2 && furnaceDone['cobblestone'] === 10

  // Smelt: outstanding input units plus enough of the best held fuel; the
  // surplus fuel and unrelated items stay spendable.
  const smelt = countsFor(
    { raw_iron: 2, coal: 2, stick: 4, dirt: 3 },
    queuedGoal({ kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 2 }),
  )
  const smeltOk =
    (smelt['raw_iron'] ?? 0) === 0 && smelt['coal'] === 1 && smelt['stick'] === 4 && smelt['dirt'] === 3

  // Place: the held payload IS the goal - surplus above want spends, want does not.
  const placeSurplus = countsFor(
    { furnace: 2, dirt: 3 },
    queuedGoal({ kind: 'place', targetItem: 'furnace', requiredCount: 1 }),
  )
  const placeExact = countsFor(
    { furnace: 1, dirt: 3 },
    queuedGoal({ kind: 'place', targetItem: 'furnace', requiredCount: 1 }),
  )
  const placeOk = placeSurplus['furnace'] === 1 && (placeExact['furnace'] ?? 0) === 0 && placeExact['dirt'] === 3

  // recipes=null degrades to collect-only protection (fixture/production parity).
  const degraded = routeScaffoldCounts({ cobblestone: 10 }, queue(queuedGoal({ kind: 'craft', targetItem: 'furnace' })))
  const degradedOk = degraded['cobblestone'] === 10

  const pass =
    furnaceOk && pickOk && pickPartialOk && outstandingOk && smeltOk && placeOk && degradedOk
  process.stdout.write(
    `active-goal materials are never route scaffolding: ${pass ? 'PASS' : 'FAIL'} ` +
      `furnace=${JSON.stringify(furnace)} pick=${JSON.stringify(pick)} pickPartial=${JSON.stringify(pickPartial)} ` +
      `furnaceTwo=${JSON.stringify(furnaceTwo)} smelt=${JSON.stringify(smelt)} ` +
      `place=${JSON.stringify(placeSurplus)}/${JSON.stringify(placeExact)} degraded=${JSON.stringify(degraded)}\n`,
  )
  if (!pass) process.exitCode = 1
}
