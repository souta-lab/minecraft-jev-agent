// Regression for the M2 prerequisite route: a craft goal may be blocked by a
// missing log even when the current goal is not itself `collect log`.  A
// remembered log whose ascent is impossible must not reduce the policy to
// WAIT; the grounded candidate layer should offer bounded exploration instead.

import { defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import type { AgentSignals, BlockState, GoalState, InventoryState, KnownResource, SelfState, StepCut, Vec3Json, WorldState } from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'

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

function world(): WorldState {
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
    inventory: inventory({ birch_planks: 2, stick: 2, cobblestone: 170, dirt: 37 }),
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
    signals: signals({ knownResources: [rememberedLog] }),
  }
}

const grounded = generateGroundedCandidates(world(), defaultCandidateOptions)
const ids = grounded.candidates.map((candidate) => candidate.id)
const logRoute = grounded.candidates.find((candidate) => candidate.meta.logRoute === 'explore')
const withheldLog = grounded.withheld.find((entry) => entry.candidate.meta.resourceKind === 'log')
const pass =
  logRoute !== undefined &&
  logRoute.kind === 'MOVE' &&
  logRoute.target?.x === 42 &&
  withheldLog !== undefined &&
  grounded.candidates.some((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')

process.stdout.write(
  `craft prerequisite log route: ${pass ? 'PASS' : 'FAIL'} candidates=[${ids.join(',')}] withheld=${withheldLog?.result.reason ?? 'none'}\n`,
)
if (!pass) process.exitCode = 1
