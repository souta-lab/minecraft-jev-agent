// test-retrieval-body.mts - issue #43 follow-up + #14/#29 regression.
//
// Proves, with no bot and no network:
//  - inventory-first planning skips a fuel/production goal already in the live
//    inventory and logs PRECONDITION_ALREADY_MET, advancing the rung;
//  - a missing furnace becomes a craft+place prerequisite instead of a WAIT;
//  - a WAIT_LIMIT replan produces a body-changing plan (descent/ore retrieval);
//  - different advisor strategies compile to different goal bodies (#29);
//  - KNOWN_RESOURCE coordinates are recorded with the worldEpoch namespace (#14);
//  - known-resource retrieval candidates are grounded and visible blocks win.
import { defaultCandidateOptions, generateCandidates, generateGroundedCandidates } from '../jev-agent/src/candidates.ts'
import type { Candidate } from '../jev-agent/src/candidates.ts'
import { PILLAR_UP_STEP_CAP } from '../jev-agent/src/verticalPlan.ts'
import type { BlockState, GoalState, InventoryState, KnownResource, SelfState, StepCut, Vec3Json, WorldState } from '../jev-agent/src/state.ts'
import { emptyGoalQueueState } from '../jev-agent/src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from '../jev-agent/src/goalQueue.ts'
import { mergeKnownResources } from './generation-entry.ts'
import {
  buildBodyChangeOption,
  buildLadder,
  buildPlanOptions,
  goalSignature,
  goalsForStrategy,
} from './planner.ts'
import { emptyWorldMemory } from './resident-types.ts'
import type { ResidentWorldMemory } from './resident-types.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

interface LogEntry {
  event: string
  detail: Record<string, unknown> | undefined
}

const world = (over: Partial<ResidentWorldMemory> = {}): ResidentWorldMemory => ({ ...emptyWorldMemory(), ...over })

const M2_BASE = {
  stone_pickaxe: 1,
  crafting_table: 0,
  cobblestone: 0,
}

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_M2R29',
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

function goal(overrides: Partial<GoalState>): GoalState {
  return {
    id: 'collect:raw_iron',
    description: 'collect 3 x raw_iron',
    targetItem: 'raw_iron',
    requiredCount: 3,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
    ...overrides,
  }
}

function queuedGoal(overrides: Partial<QueuedGoal>): QueuedGoal {
  return {
    id: 'g1',
    kind: 'collect',
    description: 'collect 3 x raw_iron',
    targetItem: 'raw_iron',
    requiredCount: 3,
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
  return { ...emptyGoalQueueState(), depth: 1, current, empty: false, goals: [current] }
}

function oreBlock(position: Vec3Json, name = 'iron_ore', drop = 'raw_iron'): BlockState {
  return {
    kind: 'ore',
    name,
    position,
    distance: 2,
    diggable: true,
    inReach: true,
    hasAdjacentStandable: true,
    adjacentStandable: { x: position.x, y: position.y + 1, z: position.z },
    yield: drop,
    harvestTool: 'pickaxe',
    harvestTier: 2,
  }
}

function hazardBlock(position: Vec3Json, name = 'lava'): BlockState {
  return {
    kind: 'hazard',
    name,
    position,
    distance: 1,
    diggable: false,
    inReach: true,
    hasAdjacentStandable: false,
    adjacentStandable: null,
  }
}

function worldState(overrides: {
  position: Vec3Json
  goalQueue: GoalQueueState
  goal?: GoalState
  inventory?: InventoryState
  blocks?: BlockState[]
  knownResources?: KnownResource[]
  stepCuts?: StepCut[]
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position),
    inventory: overrides.inventory ?? inventory({}),
    entities: [],
    blocks: overrides.blocks ?? [],
    terrain: { standable: [overrides.position] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: overrides.goal ?? goal({}),
    goalQueue: overrides.goalQueue,
    recentEvents: [],
    stepCuts: overrides.stepCuts,
    signals: {
      consecutiveFailures: 0,
      lastFailureCode: null,
      lastPathStatus: 'idle',
      stalledMs: 0,
      lastPolicyConfidence: null,
      maxConcurrentActions: 0,
      escalationRecommended: false,
      failedCandidates: {},
      knownResources: overrides.knownResources ?? [],
    },
  }
}

// --- inventory-first planning --------------------------------------------------

addCase('a fuel goal already satisfied by planks is skipped and logged (#43)', () => {
  const counts = { ...M2_BASE, oak_planks: 2 }
  const log: LogEntry[] = []
  const ladder = buildLadder(
    counts,
    world({ craftingTables: [{ x: 1, y: 64, z: 1 }], furnaces: [{ x: 1, y: 64, z: 2 }] }),
    (event, detail) => log.push({ event, detail }),
    { placedFurnacesNear: 1 },
  )
  const skip = log.find((entry) => entry.event === 'PRECONDITION_ALREADY_MET' && entry.detail?.item === 'log')
  const noFuelGoal = !ladder.goals.some((entry) => entry.targetItem === 'log')
  const charcoal = ladder.goals.some((entry) => entry.targetItem === 'charcoal')
  return {
    pass: skip !== undefined && skip.detail?.have === 2 && noFuelGoal && charcoal && ladder.rungId === 'charcoal',
    detail: `skip=${JSON.stringify(skip?.detail)} fuelGoal=${!noFuelGoal} charcoal=${charcoal} rung=${ladder.rungId}`,
  }
})

addCase('held charcoal advances past the charcoal rung and logs the skip (#43)', () => {
  const counts = { ...M2_BASE, charcoal: 1 }
  const log: LogEntry[] = []
  const ladder = buildLadder(
    counts,
    world({ craftingTables: [{ x: 1, y: 64, z: 1 }], furnaces: [{ x: 1, y: 64, z: 2 }] }),
    (event, detail) => log.push({ event, detail }),
    { placedFurnacesNear: 1 },
  )
  const skip = log.find((entry) => entry.event === 'PRECONDITION_ALREADY_MET' && entry.detail?.item === 'charcoal')
  const advanced = ladder.rungId === 'raw_iron'
  const ore = ladder.goals.some((entry) => entry.targetItem === 'raw_iron')
  return {
    pass: skip !== undefined && skip.detail?.have === 1 && advanced && ore,
    detail: `skip=${JSON.stringify(skip?.detail)} rung=${ladder.rungId} ore=${ore}`,
  }
})

addCase('missing placed furnace becomes craft+place (with held stone), not a WAIT', () => {
  const counts = { ...M2_BASE, cobblestone: 20, oak_log: 2 }
  const goals = buildLadder(counts, world({ craftingTables: [{ x: 1, y: 64, z: 1 }], furnaces: [{ x: 60, y: 64, z: 60 }] }), undefined, {
    placedFurnacesNear: 0,
  }).goals
  const craft = goals.findIndex((entry) => entry.kind === 'craft' && entry.targetItem === 'furnace')
  const place = goals.findIndex((entry) => entry.kind === 'place' && entry.targetItem === 'furnace')
  const smelt = goals.findIndex((entry) => entry.targetItem === 'charcoal')
  return {
    pass: craft >= 0 && place > craft && smelt > place,
    detail: `order=[${goals.map((entry) => `${entry.kind}:${entry.targetItem}`).join(',')}]`,
  }
})

// --- body-changing replan (#43 follow-up, #29) ---------------------------------

addCase('a WAIT_LIMIT body-change plan starts at a descent/ore goal, not the blocked front', () => {
  const counts = { ...M2_BASE, cobblestone: 27, oak_log: 2 }
  const memory = world({ craftingTables: [{ x: 1, y: 64, z: 1 }], furnaces: [{ x: 60, y: 64, z: 60 }] })
  const front = buildPlanOptions(counts, memory, { placedFurnacesNear: 0 })[0]
  const body = buildBodyChangeOption(counts, memory, { placedFurnacesNear: 0 })
  const first = body.goals[0]
  const positional = first?.targetItem === 'cobblestone' || first?.targetItem === 'raw_iron'
  const differs = front !== undefined && goalSignature(body.goals) !== goalSignature(front.goals)
  return {
    pass: positional && differs,
    detail: `front=[${front?.goals.map((entry) => entry.targetItem).join(',')}] body=[${body.goals.map((entry) => entry.targetItem).join(',')}]`,
  }
})

addCase('explore_cave / branch_mine / return_to_known_ore compile to different bodies (#29)', () => {
  const counts = { ...M2_BASE }
  const memory = world()
  const signatures = (['explore_cave', 'branch_mine', 'return_to_known_ore'] as const).map((strategy) =>
    goalSignature(goalsForStrategy(strategy, counts, memory)),
  )
  const distinct = new Set(signatures).size === signatures.length
  return { pass: distinct, detail: signatures.join('  ||  ') }
})

// --- known-resource coordinates (#14) ------------------------------------------

addCase('KNOWN_RESOURCE logs the remembered coordinate with its worldEpoch (#14)', () => {
  const target: Array<{ name: string; kind: 'ore' | 'log' | 'station'; x: number; y: number; z: number }> = []
  const log: LogEntry[] = []
  const found = [{ name: 'iron_ore', kind: 'ore' as const, x: 1.4, y: 59.6, z: -3.2 }]
  const first = mergeKnownResources(target, found, (event, detail) => log.push({ event, detail }), 7)
  const second = mergeKnownResources(target, found, (event, detail) => log.push({ event, detail }), 7)
  const entry = log[0]
  const pass =
    first === 1 &&
    second === 0 &&
    target.length === 1 &&
    target[0]?.x === 1 &&
    target[0]?.y === 60 &&
    target[0]?.z === -3 &&
    entry?.event === 'KNOWN_RESOURCE' &&
    entry.detail?.item === 'iron_ore' &&
    entry.detail?.at === '1,60,-3' &&
    entry.detail?.worldEpoch === 7
  return { pass, detail: `added=${first},${second} target=${JSON.stringify(target)} log=${JSON.stringify(entry?.detail)}` }
})

// --- retrieval candidate selection (#14) ---------------------------------------

addCase('an ore goal with no visible ore emits a grounded RETRIEVE to the remembered cell', () => {
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 40, y: 59, z: -12 }, dimension: 'minecraft:overworld' }
  const state = worldState({
    position: { x: 0, y: 60, z: 0 },
    goalQueue: queueWith(queuedGoal({})),
    knownResources: [known],
  })
  const found = generateCandidates(state, defaultCandidateOptions).find((candidate: Candidate) => candidate.kind === 'RETRIEVE')
  const pass =
    found !== undefined &&
    found.meta.retrieval === 'known' &&
    found.meta.resourceKind === 'ore' &&
    found.target?.x === 40 &&
    found.target?.y === 59 &&
    found.target?.z === -12
  return { pass, detail: found === undefined ? 'no RETRIEVE' : `${found.id} ${JSON.stringify(found.meta)}` }
})

addCase('a visible matching ore suppresses retrieval so MINE keeps priority', () => {
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 40, y: 59, z: -12 }, dimension: 'minecraft:overworld' }
  const state = worldState({
    // 60368f50 tightened the collect-MINE pickup envelope to 1.3 horizontal; from
    // (0,60,0) this block's centre is 1.58 away, so MINE is (correctly) withheld and
    // the case would measure the approach route instead of MINE priority.
    position: { x: 0.5, y: 60, z: 0.5 },
    goalQueue: queueWith(queuedGoal({})),
    knownResources: [known],
    blocks: [oreBlock({ x: 1, y: 60, z: 0 })],
    inventory: inventory({ stone_pickaxe: 1 }),
  })
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const retrieve = candidates.find((candidate: Candidate) => candidate.kind === 'RETRIEVE')
  const mine = candidates.find((candidate: Candidate) => candidate.kind === 'MINE')
  return { pass: retrieve === undefined && mine !== undefined, detail: candidates.map((candidate) => candidate.id).join(',') }
})

addCase('a remembered surface log beyond reach grounds a RETRIEVE for the charcoal goal (#44)', () => {
  const known: KnownResource = { name: 'oak_log', kind: 'log', position: { x: 6, y: 68, z: 0 }, dimension: 'minecraft:overworld' }
  const state = worldState({
    position: { x: 0, y: 60, z: 0 },
    goalQueue: queueWith(queuedGoal({ kind: 'smelt', targetItem: 'charcoal', description: 'smelt 1 x charcoal' })),
    goal: goal({ targetItem: 'charcoal', description: 'smelt 1 x charcoal' }),
    knownResources: [known],
    // the 8-block climb is presented only with a mechanically available ascend
    // plan; without a placeable block the affordance gate withholds it.
    inventory: inventory({ cobblestone: 4 }),
  })
  const retrieve = generateCandidates(state, defaultCandidateOptions).find((candidate: Candidate) => candidate.kind === 'RETRIEVE')
  return {
    pass: retrieve !== undefined && retrieve.meta.retrieval === 'known' && retrieve.target?.x === 6 && retrieve.target?.y === 68,
    detail: retrieve === undefined ? 'no RETRIEVE' : `${retrieve.id} ${JSON.stringify(retrieve.meta)}`,
  }
})

addCase('a remembered log within proof distance but absent from the scan stays depleted', () => {
  const known: KnownResource = { name: 'oak_log', kind: 'log', position: { x: 3, y: 60, z: 0 }, dimension: 'minecraft:overworld' }
  const state = worldState({
    position: { x: 0, y: 60, z: 0 },
    goalQueue: queueWith(queuedGoal({ kind: 'smelt', targetItem: 'charcoal', description: 'smelt 1 x charcoal' })),
    goal: goal({ targetItem: 'charcoal', description: 'smelt 1 x charcoal' }),
    knownResources: [known],
  })
  const retrieve = generateCandidates(state, defaultCandidateOptions).find((candidate: Candidate) => candidate.kind === 'RETRIEVE')
  return { pass: retrieve === undefined, detail: retrieve === undefined ? 'suppressed (depleted)' : `${retrieve.id}` }
})

addCase('a remembered ore far above the resident grounds a bounded pillar-up retrieval (#45 up)', () => {
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 40, y: 61, z: 0 }, dimension: 'minecraft:overworld' }
  const state = worldState({
    position: { x: 39, y: 31, z: 33 },
    goalQueue: queueWith(queuedGoal({})),
    knownResources: [known],
    inventory: inventory({ cobblestone: 119, stone_pickaxe: 1 }),
  })
  const retrieve = generateCandidates(state, defaultCandidateOptions).find((candidate: Candidate) => candidate.kind === 'RETRIEVE')
  const steps = retrieve?.meta.pillarSteps
  const pass =
    retrieve !== undefined &&
    retrieve.meta.vertical === 'pillar' &&
    retrieve.meta.pillarPlaceName === 'cobblestone' &&
    typeof steps === 'number' &&
    steps >= 1 &&
    steps <= PILLAR_UP_STEP_CAP &&
    retrieve.meta.verticalToY === 31 + steps
  return { pass, detail: retrieve === undefined ? 'no RETRIEVE' : JSON.stringify(retrieve.meta) }
})

addCase('a station 56 blocks above sustains pillar chunks across decisions (#45 up)', () => {
  const target: Vec3Json = { x: 22, y: 66, z: 29 }
  const chunks: Array<{ fromY: number; steps: number; toY: number }> = []
  for (const y of [10, 34, 58]) {
    const state = worldState({
      position: { x: 39, y, z: 33 },
      goalQueue: queueWith(
        queuedGoal({ kind: 'smelt', targetItem: 'charcoal', description: 'smelt 1 x charcoal' }),
      ),
      goal: goal({ targetItem: 'charcoal', description: 'smelt 1 x charcoal' }),
      knownResources: [{ name: 'furnace', kind: 'station', position: target, dimension: 'minecraft:overworld' }],
      inventory: inventory({ cobblestone: 119, stone_pickaxe: 1 }),
    })
    const retrieve = generateCandidates(state, defaultCandidateOptions).find(
      (candidate: Candidate) => candidate.kind === 'RETRIEVE',
    )
    if (retrieve === undefined || retrieve.meta.vertical !== 'pillar') {
      return { pass: false, detail: `y=${y} vertical=${retrieve?.meta.vertical ?? 'no RETRIEVE'}` }
    }
    chunks.push({
      fromY: y,
      steps: Number(retrieve.meta.pillarSteps),
      toY: Number(retrieve.meta.verticalToY),
    })
  }
  const last = chunks[chunks.length - 1]
  const pass =
    PILLAR_UP_STEP_CAP > 8 &&
    chunks.length === 3 &&
    chunks.every((chunk) => chunk.steps >= 1 && chunk.steps <= PILLAR_UP_STEP_CAP) &&
    chunks[0]?.steps === PILLAR_UP_STEP_CAP &&
    last?.toY === target.y
  return { pass, detail: JSON.stringify(chunks) }
})

addCase('a hazard in the resident column refuses the station pillar plan (#45 up)', () => {
  const state = worldState({
    position: { x: 39, y: 10, z: 33 },
    goalQueue: queueWith(
      queuedGoal({ kind: 'smelt', targetItem: 'charcoal', description: 'smelt 1 x charcoal' }),
    ),
    goal: goal({ targetItem: 'charcoal', description: 'smelt 1 x charcoal' }),
    knownResources: [{ name: 'furnace', kind: 'station', position: { x: 22, y: 66, z: 29 }, dimension: 'minecraft:overworld' }],
    inventory: inventory({ cobblestone: 119, stone_pickaxe: 1 }),
    blocks: [hazardBlock({ x: 39, y: 11, z: 33 })],
  })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const retrieve = grounded.candidates.find((candidate: Candidate) => candidate.kind === 'RETRIEVE')
  const withheld = grounded.withheld.find((entry) => entry.candidate.id.includes('station:furnace'))
  const pass =
    retrieve === undefined &&
    withheld !== undefined &&
    withheld.result.reason === 'needs_ascend' &&
    withheld.result.missingCapabilities.some((capability) => capability.kind === 'safe_column')
  return {
    pass,
    detail: `presented=${retrieve !== undefined} withheld=${withheld?.result.reason ?? 'none'} missing=${JSON.stringify(withheld?.result.missingCapabilities ?? [])}`,
  }
})

addCase('a safe step-cut above the resident grounds an up-staircase retrieval (#45 up)', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const cut: StepCut = {
    dir: 'E',
    dx: 1,
    dz: 0,
    cut: { x: feet.x + 1, y: feet.y + 1, z: feet.z },
    step: { x: feet.x + 1, y: feet.y + 1, z: feet.z },
    name: 'cobblestone',
    safe: true,
    reason: 'safe',
  }
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 60, y: 55, z: 33 }, dimension: 'minecraft:overworld' }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({})),
    knownResources: [known],
    inventory: inventory({ cobblestone: 119, stone_pickaxe: 1 }),
    stepCuts: [cut],
  })
  const retrieve = generateCandidates(state, defaultCandidateOptions).find((candidate: Candidate) => candidate.kind === 'RETRIEVE')
  const pass =
    retrieve !== undefined &&
    retrieve.meta.vertical === 'staircase-up' &&
    retrieve.meta.upDir === 'E' &&
    retrieve.meta.upDigY === 32
  return { pass, detail: retrieve === undefined ? 'no RETRIEVE' : JSON.stringify(retrieve.meta) }
})

let failures = 0
process.stdout.write('inventory-first planning + known-resource retrieval (#43/#14/#29)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} retrieval/body cases passed\n`)
if (failures > 0) process.exit(1)
