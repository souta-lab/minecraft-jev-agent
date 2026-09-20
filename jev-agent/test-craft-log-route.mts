// Regression for the M2 prerequisite route: a craft goal may be blocked by a
// missing log even when the current goal is not itself `collect log`.
//
// (1) With a placeable block held (the measured d54d9a8 live shape), the ascent
// is feasible via the no-pickaxe pillar-up mechanic, so the prerequisite is the
// direct RETRIEVE route.
// (2) Without any placeable block the ascent is truthfully impossible and the
// withheld log route must not reduce the policy to WAIT; the grounded candidate
// layer should offer bounded exploration instead.

import { defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
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

function world(inventoryCounts: Record<string, number> = { birch_planks: 2, stick: 2, cobblestone: 170, dirt: 37 }): WorldState {
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
    kind: 'log',
    position: { x: 27, y: 65, z: 19 },
  }
  const rememberedTable: KnownResource = {
    name: 'crafting_table',
    kind: 'station',
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
    blocks: [blockingStone, sensedLog],
    terrain: { standable: [position, { x: 41, y: 11, z: 32 }, { x: 42, y: 11, z: 32 }] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: [],
    stepCuts: [blockedStep],
    headroomCuts: [],
    goal,
    goalQueue: queue(current, logGoal),
    recentEvents: [],
    signals: signals({ knownResources: [rememberedLog, rememberedTable] }),
  }
}

// (0) A remembered table below the current level is not allowed to starve a
// craft goal when the same inventory can make a table in the 2x2 grid. The
// retrieval is withheld by the affordance gate, while the prerequisite craft
// remains available for Jev to choose.
{
  const grounded = generateGroundedCandidates(
    world({ birch_planks: 4, stick: 2 }),
    { ...defaultCandidateOptions, recipes },
  )
  const fallback = grounded.candidates.find((candidate) => candidate.id === 'CRAFT:crafting_table')
  const withheldStation = grounded.withheld.find((entry) => entry.candidate.meta.resourceKind === 'station')
  const pass =
    fallback?.kind === 'CRAFT' &&
    withheldStation !== undefined &&
    withheldStation.result.reason === 'needs_descend'
  process.stdout.write(
    `craft station fallback (unreachable remembered table): ${pass ? 'PASS' : 'FAIL'} ` +
      `candidates=[${grounded.candidates.map((candidate) => candidate.id).join(',')}] ` +
      `withheld=${withheldStation?.result.reason ?? 'none'}\n`,
  )
  if (!pass) process.exitCode = 1
}

// (1) The repaired live shape (FIRST_FAILED_BOUNDARY, RC d54d9a8): the same
// underground body holds cobblestone 170, so the pillar-up mechanic reaches the
// remembered log at (27,65,19) without a pickaxe. The craft prerequisite is a
// direct body-moving RETRIEVE instead of a needs_ascend refusal.
{
  const grounded = generateGroundedCandidates(world(), defaultCandidateOptions)
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

// (2) Without any placeable block the ascent is truthfully impossible: the log
// route is withheld as needs_ascend and the bounded exploration MOVE keeps the
// policy off WAIT (the regression this file originally pinned).
{
  const grounded = generateGroundedCandidates(
    world({ birch_planks: 2, stick: 2 }),
    defaultCandidateOptions,
  )
  const ids = grounded.candidates.map((candidate) => candidate.id)
  const logRoute = grounded.candidates.find((candidate) => candidate.meta.logRoute === 'explore')
  const withheldLog = grounded.withheld.find((entry) => entry.candidate.meta.resourceKind === 'log')
  const pass =
    logRoute !== undefined &&
    logRoute.kind === 'MOVE' &&
    logRoute.target?.x === 42 &&
    withheldLog !== undefined &&
    withheldLog.result.reason === 'needs_ascend' &&
    grounded.candidates.some((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')

  process.stdout.write(
    `craft prerequisite log route (no placeable): ${pass ? 'PASS' : 'FAIL'} candidates=[${ids.join(',')}] withheld=${withheldLog?.result.reason ?? 'none'}\n`,
  )
  if (!pass) process.exitCode = 1
}
