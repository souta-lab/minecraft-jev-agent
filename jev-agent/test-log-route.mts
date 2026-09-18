// test-log-route.mts - M2 log-route regression: a `collect 1 x log` goal must
// always hold a candidate that moves the body toward/ascends to a log, or
// explores - never a stationary MINE that cannot yield a log.
//
// Live shape this locks (main 7acd849, run 04:25): the bot at (30.0,33.0,35.3)
// underground, 8 sensed surface logs (y 65-71) all out of reach with no walk-up
// access, remembered logs at the surface, stone pickaxe held. The only
// productive candidate was the stone ceiling clearance MINE b30_35_35, chosen
// 25x, `dig_timeout` 30x, inventory frozen, no log gained.
//
//   npm run log-route-test
import { applyReachabilityGate, blockId, defaultCandidateOptions, formatLogRoute, generateGroundedCandidates, logCollectGoal, logRouteOf } from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import { MIRRORED_MARKERS } from './src/controller.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { AgentSignals, BlockState, GoalState, HeadroomCut, InventoryState, KnownResource, SelfState, Vec3Json, WorldState } from './src/state.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_LOG_ROUTE',
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
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0) }
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

function goal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    id: 'collect:log',
    description: 'collect 1 x log',
    targetItem: 'log',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
    ...overrides,
  }
}

function queuedGoal(overrides: Partial<QueuedGoal> = {}): QueuedGoal {
  return {
    id: 'g5088:collect:log',
    kind: 'collect',
    description: 'collect 1 x log',
    targetItem: 'log',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
    ...overrides,
  }
}

function queueWith(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

interface WorldInput {
  position: Vec3Json
  inventory?: InventoryState
  signals?: AgentSignals
  standable?: Vec3Json[]
  headroomCuts?: HeadroomCut[]
  blocks?: BlockState[]
  goal?: GoalState
  goalQueue?: GoalQueueState
}

function worldState(input: WorldInput): WorldState {
  const current = input.goalQueue?.current ?? null
  return {
    schemaVersion: 1,
    tick: 41,
    timestampMs: 1_700_000_000_000,
    self: self(input.position),
    inventory: input.inventory ?? inventory({}),
    entities: [],
    blocks: input.blocks ?? [],
    terrain: { standable: input.standable ?? [input.position] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: [],
    stepCuts: [],
    headroomCuts: input.headroomCuts ?? [],
    goal: input.goal ?? goal(),
    goalQueue: input.goalQueue ?? (current === null ? emptyGoalQueueState() : queueWith(current)),
    recentEvents: [],
    signals: input.signals ?? signals(),
  }
}

function logBlock(position: Vec3Json, overrides: Partial<BlockState> = {}): BlockState {
  return {
    kind: 'log',
    name: 'oak_log',
    position,
    distance: Math.hypot(position.x, position.y, position.z),
    diggable: true,
    inReach: false,
    hasAdjacentStandable: false,
    adjacentStandable: null,
    yield: 'oak_log',
    harvestTool: null,
    harvestTier: null,
    visible: false,
    ...overrides,
  }
}

function stoneBlock(position: Vec3Json, overrides: Partial<BlockState> = {}): BlockState {
  return {
    kind: 'stone',
    name: 'stone',
    position,
    distance: 2,
    diggable: true,
    inReach: true,
    hasAdjacentStandable: true,
    adjacentStandable: { x: position.x, y: position.y - 1, z: position.z },
    yield: 'cobblestone',
    harvestTool: 'pickaxe',
    harvestTier: 0,
    visible: true,
    ...overrides,
  }
}

function options(): CandidateOptions {
  return { ...defaultCandidateOptions }
}

const LIVE_FEET: Vec3Json = { x: 30, y: 33, z: 35 }
const LIVE_REMEMBERED_LOG: KnownResource = { name: 'oak_log', kind: 'log', position: { x: 34, y: 65, z: 35 } }
const LIVE_CEILING: BlockState = stoneBlock({ x: 30, y: 35, z: 35 })
const LIVE_CUT: HeadroomCut = { pos: { x: 30, y: 35, z: 35 }, name: 'stone', safe: true, reason: 'safe' }

function liveSurfaceLogs(): BlockState[] {
  const positions: Vec3Json[] = [
    { x: 34, y: 65, z: 35 },
    { x: 34, y: 66, z: 35 },
    { x: 33, y: 65, z: 34 },
    { x: 32, y: 65, z: 33 },
    { x: 31, y: 67, z: 32 },
    { x: 30, y: 68, z: 30 },
    { x: 28, y: 70, z: 29 },
    { x: 27, y: 71, z: 28 },
  ]
  return positions.map((position) =>
    logBlock(position, { distance: Math.hypot(position.x - LIVE_FEET.x, position.y - LIVE_FEET.y, position.z - LIVE_FEET.z) }),
  )
}

function liveWorld(overrides: Partial<WorldInput> = {}): WorldState {
  return worldState({
    position: LIVE_FEET,
    inventory: inventory({ birch_planks: 2, stick: 2, cobblestone: 167, dirt: 37, leaf_litter: 4, stone_pickaxe: 1 }),
    signals: signals({ knownResources: [LIVE_REMEMBERED_LOG] }),
    standable: [LIVE_FEET, { x: 28, y: 33, z: 35 }, { x: 32, y: 33, z: 35 }],
    headroomCuts: [LIVE_CUT],
    blocks: [...liveSurfaceLogs(), LIVE_CEILING],
    goalQueue: queueWith(queuedGoal({})),
    ...overrides,
  })
}

const ROUTE_LINE = /^LOG_ROUTE mode=(ascend_then_mine|retrieve_known|explore|mine_sensed) target=-?\d+,-?\d+,-?\d+$/

// (0) the marker is mirrored and its format is the audited one --------------------
addCase('the LOG_ROUTE marker is mirrored and renders mode + target', () => {
  const line = formatLogRoute({
    mode: 'ascend_then_mine',
    target: { x: 34, y: 65, z: 35 },
    candidateId: 'RETRIEVE:known:log:b34_65_35',
  })
  const pass =
    line === 'LOG_ROUTE mode=ascend_then_mine target=34,65,35' && ROUTE_LINE.test(line) && MIRRORED_MARKERS.has('LOG_ROUTE')
  return { pass, detail: `line="${line}" mirrored=${MIRRORED_MARKERS.has('LOG_ROUTE')}` }
})

// (1) a remembered log above with a feasible ascent -> ascend_then_mine ----------
addCase('a remembered log above with a feasible ascent presents the ascend route', () => {
  const feet: Vec3Json = { x: 0, y: 60, z: 0 }
  const rememberedLog: KnownResource = { name: 'oak_log', kind: 'log', position: { x: 0, y: 70, z: 0 } }
  const state = worldState({
    position: feet,
    inventory: inventory({ cobblestone: 16, stone_pickaxe: 1 }),
    signals: signals({ knownResources: [rememberedLog] }),
    standable: [feet, { x: 2, y: 60, z: 0 }],
    goalQueue: queueWith(queuedGoal({})),
  })
  const grounded = generateGroundedCandidates(state, options())
  const id = `RETRIEVE:known:log:b${rememberedLog.position.x}_${rememberedLog.position.y}_${rememberedLog.position.z}`
  const retrieve = grounded.candidates.find((candidate) => candidate.id === id)
  const route = logRouteOf(grounded.candidates)
  const vertical = retrieve?.meta.vertical
  const pass =
    retrieve !== undefined &&
    retrieve.affordance?.feasible === true &&
    retrieve.meta[`logRoute`] === 'ascend_then_mine' &&
    (vertical === 'pillar' || vertical === 'staircase-up') &&
    route !== null &&
    route.mode === 'ascend_then_mine' &&
    route.target.y === 70 &&
    route.candidateId === id
  return {
    pass,
    detail: `route=${route === null ? 'none' : formatLogRoute(route)} vertical=${String(vertical)} affordance=${JSON.stringify(retrieve?.affordance ?? null)}`,
  }
})

// (2) no log sensed and no remembered route -> the explore fallback --------------
addCase('a log outside sensor range with no route falls back to exploration', () => {
  const feet: Vec3Json = { x: 0, y: 60, z: 0 }
  const state = worldState({
    position: feet,
    standable: [feet, { x: 3, y: 60, z: 0 }],
    goalQueue: queueWith(queuedGoal({})),
  })
  const grounded = generateGroundedCandidates(state, options())
  const route = logRouteOf(grounded.candidates)
  const explore = grounded.candidates.find((candidate) => candidate.meta.logRoute === 'explore')
  const pass =
    route !== null &&
    route.mode === 'explore' &&
    explore !== undefined &&
    explore.kind === 'MOVE' &&
    grounded.candidates.every((candidate) => candidate.kind !== 'MINE')
  return {
    pass,
    detail: `route=${route === null ? 'none' : formatLogRoute(route)} candidates=[${grounded.candidates.map((c) => c.id).join(',')}]`,
  }
})

// (3) a sensed log in reach -> mine_sensed, no exploration on top -----------------
addCase('a sensed log in reach presents mine_sensed', () => {
  const feet: Vec3Json = { x: 0, y: 60, z: 0 }
  const sensed = logBlock({ x: 1, y: 60, z: 0 }, { inReach: true, visible: true, distance: 1, adjacentStandable: feet })
  const state = worldState({
    position: feet,
    standable: [feet, { x: 3, y: 60, z: 0 }],
    blocks: [sensed],
    goalQueue: queueWith(queuedGoal({})),
  })
  const grounded = generateGroundedCandidates(state, options())
  const mine = grounded.candidates.find((candidate) => candidate.id === `MINE:${blockId('b', sensed.position)}`)
  const route = logRouteOf(grounded.candidates)
  const pass =
    mine !== undefined &&
    mine.affordance?.feasible === true &&
    mine.meta.logRoute === 'mine_sensed' &&
    route !== null &&
    route.mode === 'mine_sensed' &&
    grounded.candidates.every((candidate) => candidate.meta.logRoute !== 'explore')
  return {
    pass,
    detail: `route=${route === null ? 'none' : formatLogRoute(route)} candidates=[${grounded.candidates.map((c) => c.id).join(',')}]`,
  }
})

// (4) an unreachable MINE for a log is never presented ---------------------------
addCase('an out-of-reach log never yields a MINE candidate', () => {
  const feet: Vec3Json = { x: 0, y: 60, z: 0 }
  const farLog = logBlock({ x: 0, y: 110, z: 0 }, { distance: 50 })
  const state = worldState({
    position: feet,
    standable: [feet, { x: 3, y: 60, z: 0 }],
    blocks: [farLog],
    goalQueue: queueWith(queuedGoal({})),
  })
  const grounded = generateGroundedCandidates(state, options())
  const mined = grounded.candidates.some((candidate) => candidate.kind === 'MINE')
  return {
    pass: !mined && grounded.candidates.every((candidate) => candidate.id !== `MINE:${blockId('b', farLog.position)}`),
    detail: `candidates=[${grounded.candidates.map((c) => c.id).join(',')}]`,
  }
})

addCase('the gate withholds a log MINE whose block is not in the sensed world', () => {
  const feet: Vec3Json = { x: 0, y: 60, z: 0 }
  const state = worldState({ position: feet, goalQueue: queueWith(queuedGoal({})), standable: [feet] })
  const stale: Candidate = {
    id: 'MINE:b0_70_0',
    kind: 'MINE',
    label: 'mine oak_log',
    targetName: 'oak_log',
    target: { x: 0, y: 70, z: 0 },
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: state.tick, yieldItem: 'oak_log' },
  }
  const gated = applyReachabilityGate([stale], state, options())
  const withheld = gated.withheld.find((entry) => entry.candidate.id === stale.id)
  return {
    pass:
      gated.candidates.every((candidate) => candidate.id !== stale.id) &&
      withheld !== undefined &&
      withheld.result.reason === 'out_of_reach',
    detail: `presented=[${gated.candidates.map((c) => c.id).join(',')}] withheld=${withheld?.result.reason ?? 'none'}`,
  }
})

addCase('the gate withholds a log MINE whose block is sensed but out of reach', () => {
  const feet: Vec3Json = { x: 0, y: 60, z: 0 }
  const farLog = logBlock({ x: 0, y: 70, z: 0 }, { distance: 10 })
  const state = worldState({ position: feet, goalQueue: queueWith(queuedGoal({})), standable: [feet], blocks: [farLog] })
  const mine: Candidate = {
    id: `MINE:${blockId('b', farLog.position)}`,
    kind: 'MINE',
    label: 'mine oak_log',
    targetName: 'oak_log',
    target: farLog.position,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: false,
    meta: { tick: state.tick, yieldItem: 'oak_log' },
  }
  const gated = applyReachabilityGate([mine], state, options())
  const withheld = gated.withheld.find((entry) => entry.candidate.id === mine.id)
  return {
    pass: gated.candidates.every((candidate) => candidate.id !== mine.id) && withheld?.result.reason === 'out_of_reach',
    detail: `presented=[${gated.candidates.map((c) => c.id).join(',')}] withheld=${withheld?.result.reason ?? 'none'}`,
  }
})

// (5) the live shape: the log goal always holds a moving route --------------------
addCase('the live y=33 shape routes the log goal to a body change, never a stationary MINE', () => {
  const state = liveWorld()
  const grounded = generateGroundedCandidates(state, options())
  const route = logRouteOf(grounded.candidates)
  const routeCandidate = grounded.candidates.find((candidate) => candidate.id === route?.candidateId)
  const moving =
    routeCandidate !== undefined && (routeCandidate.kind === 'MOVE' || routeCandidate.kind === 'RETRIEVE')
  const line = route === null ? null : formatLogRoute(route)
  const pass =
    route !== null &&
    moving &&
    line !== null &&
    ROUTE_LINE.test(line) &&
    grounded.candidates.some((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')
  return {
    pass,
    detail: `route=${line ?? 'none'} kind=${routeCandidate?.kind ?? 'none'} candidates=[${grounded.candidates.map((c) => `${c.id}:${String(c.meta.logRoute ?? '-')}`).join(',')}] withheld=[${grounded.withheld.map((entry) => `${entry.candidate.id}:${entry.result.reason}`).join(',')}]`,
  }
})

addCase('the clearance MINE stops being re-offered once its retries are exhausted', () => {
  const state = liveWorld({ signals: signals({ knownResources: [LIVE_REMEMBERED_LOG], failedCandidates: { 'MINE:b30_35_35': 5 } }) })
  const grounded = generateGroundedCandidates(state, options())
  const route = logRouteOf(grounded.candidates)
  const pass =
    grounded.candidates.every((candidate) => candidate.id !== 'MINE:b30_35_35') &&
    route !== null &&
    route.mode === 'explore'
  return {
    pass,
    detail: `route=${route === null ? 'none' : formatLogRoute(route)} candidates=[${grounded.candidates.map((c) => c.id).join(',')}]`,
  }
})

// (6) the measured live state (decisions.jsonl tick 31, source=fallback):
//     candidates were exactly [MINE:b30_35_35 failedCount=23, MINE:b29_34_34
//     failedCount=6] - two stationary stone clearance MINEs and nothing else.
//     This fixture copies the recorded facts: self (30,33,35.32), 0 remembered
//     logs, sensed surface logs out of reach, 8 safe stone headroom cuts,
//     standable [(30,32,35),(31,32,37)], the two failed clearance MINEs.
addCase('the measured live candidate set becomes a moving log route', () => {
  const cutPositions: Vec3Json[] = [
    { x: 30, y: 35, z: 35 },
    { x: 29, y: 34, z: 34 },
    { x: 29, y: 35, z: 34 },
    { x: 29, y: 34, z: 35 },
    { x: 29, y: 35, z: 35 },
    { x: 29, y: 34, z: 36 },
    { x: 29, y: 35, z: 36 },
    { x: 30, y: 34, z: 34 },
  ]
  const cuts: HeadroomCut[] = cutPositions.map((pos) => ({ pos, name: 'stone', safe: true, reason: 'safe' }))
  const state = worldState({
    position: { x: 30.01, y: 33, z: 35.32 },
    inventory: inventory({ birch_planks: 2, stick: 2, cobblestone: 167, dirt: 37, leaf_litter: 4, stone_pickaxe: 1 }),
    signals: signals({
      failedCandidates: { 'MINE:b30_35_35': 24, 'MINE@10,11,11': 24, 'MINE:b29_34_34': 5, 'MINE@9,11,11': 5 },
    }),
    standable: [
      { x: 30, y: 32, z: 35 },
      { x: 31, y: 32, z: 37 },
    ],
    headroomCuts: cuts,
    blocks: [
      logBlock({ x: 27, y: 65, z: 19 }, { adjacentStandable: { x: 26, y: 64, z: 19 }, hasAdjacentStandable: true, distance: 35.8 }),
      logBlock({ x: 20, y: 65, z: 22 }, { adjacentStandable: { x: 19, y: 64, z: 22 }, hasAdjacentStandable: true, distance: 35.9 }),
      logBlock({ x: 26, y: 68, z: 26 }, { distance: 36.6 }),
      ...cutPositions.map((pos) => stoneBlock(pos, { adjacentStandable: { x: pos.x, y: pos.y - 1, z: pos.z } })),
    ],
    goalQueue: queueWith(queuedGoal({})),
  })
  const grounded = generateGroundedCandidates(state, options())
  const route = logRouteOf(grounded.candidates)
  const routeCandidate = grounded.candidates.find((candidate) => candidate.id === route?.candidateId)
  const pass =
    grounded.candidates.every((candidate) => candidate.kind !== 'MINE') &&
    route !== null &&
    route.mode === 'explore' &&
    routeCandidate !== undefined &&
    routeCandidate.kind === 'MOVE' &&
    routeCandidate.id.startsWith('MOVE:p')
  return {
    pass,
    detail: `route=${route === null ? 'none' : formatLogRoute(route)} candidates=[${grounded.candidates.map((c) => `${c.id}:${c.kind}`).join(',')}] withheld=[${grounded.withheld.map((entry) => `${entry.candidate.id}:${entry.result.reason}`).join(',')}]`,
  }
})

addCase('a smelt goal that needs a log input does not receive the log explore route', () => {
  const feet: Vec3Json = { x: 0, y: 60, z: 0 }
  const smelt = queuedGoal({
    id: 'g-charcoal',
    kind: 'smelt',
    description: 'smelt 1 x charcoal',
    targetItem: 'charcoal',
    requiredCount: 1,
  })
  const state = worldState({
    position: feet,
    standable: [feet, { x: 3, y: 60, z: 0 }],
    goal: goal({ id: 'smelt:charcoal', description: 'smelt 1 x charcoal', targetItem: 'charcoal', requiredCount: 1 }),
    goalQueue: queueWith(smelt),
  })
  const grounded = generateGroundedCandidates(state, options())
  return {
    pass: logCollectGoal(state) === false && logRouteOf(grounded.candidates) === null,
    detail: `logCollectGoal=${logCollectGoal(state)} route=${logRouteOf(grounded.candidates) === null ? 'none' : 'set'}`,
  }
})

let failures = 0
process.stdout.write('M2 log route - collect log always holds a body-moving route\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} log-route cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
