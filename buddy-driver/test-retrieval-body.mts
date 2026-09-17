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
import { defaultCandidateOptions, generateCandidates } from '../jev-agent/src/candidates.ts'
import type { Candidate } from '../jev-agent/src/candidates.ts'
import type { BlockState, GoalState, InventoryState, KnownResource, SelfState, Vec3Json, WorldState } from '../jev-agent/src/state.ts'
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

function worldState(overrides: {
  position: Vec3Json
  goalQueue: GoalQueueState
  goal?: GoalState
  inventory?: InventoryState
  blocks?: BlockState[]
  knownResources?: KnownResource[]
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
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 40, y: 59, z: -12 } }
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
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 40, y: 59, z: -12 } }
  const state = worldState({
    position: { x: 0, y: 60, z: 0 },
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
  const known: KnownResource = { name: 'oak_log', kind: 'log', position: { x: 6, y: 68, z: 0 } }
  const state = worldState({
    position: { x: 0, y: 60, z: 0 },
    goalQueue: queueWith(queuedGoal({ kind: 'smelt', targetItem: 'charcoal', description: 'smelt 1 x charcoal' })),
    goal: goal({ targetItem: 'charcoal', description: 'smelt 1 x charcoal' }),
    knownResources: [known],
  })
  const retrieve = generateCandidates(state, defaultCandidateOptions).find((candidate: Candidate) => candidate.kind === 'RETRIEVE')
  return {
    pass: retrieve !== undefined && retrieve.meta.retrieval === 'known' && retrieve.target?.x === 6 && retrieve.target?.y === 68,
    detail: retrieve === undefined ? 'no RETRIEVE' : `${retrieve.id} ${JSON.stringify(retrieve.meta)}`,
  }
})

addCase('a remembered log within proof distance but absent from the scan stays depleted', () => {
  const known: KnownResource = { name: 'oak_log', kind: 'log', position: { x: 3, y: 60, z: 0 } }
  const state = worldState({
    position: { x: 0, y: 60, z: 0 },
    goalQueue: queueWith(queuedGoal({ kind: 'smelt', targetItem: 'charcoal', description: 'smelt 1 x charcoal' })),
    goal: goal({ targetItem: 'charcoal', description: 'smelt 1 x charcoal' }),
    knownResources: [known],
  })
  const retrieve = generateCandidates(state, defaultCandidateOptions).find((candidate: Candidate) => candidate.kind === 'RETRIEVE')
  return { pass: retrieve === undefined, detail: retrieve === undefined ? 'suppressed (depleted)' : `${retrieve.id}` }
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
