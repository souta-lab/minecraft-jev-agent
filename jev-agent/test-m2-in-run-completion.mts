// test-m2-in-run-completion.mts - bounded regressions for the three proved
// defects that kept the M2 chain from finishing inside ONE run
// (live run-mu8dbv0e-rv1v, RC ba3e379). No bot, no network.
//
// A. planner: `requiredCount` on the raw_iron/iron_ingot rungs and on
//    `smeltPriorityGoal` was the SHORTFALL (`3 - held`) while every consumer
//    (`goalAlreadyMet`, `smeltPreconditions`, `successForGoal`,
//    `smeltCandidates`) reads it as the TOTAL target. With `raw_iron:2` the
//    `collect 3 x raw_iron` goal was filtered as "already met" and dropped from
//    the plan, so the third ore was never collected; with `iron_ingot:2` the
//    `smelt 3 x iron_ingot` goal was dropped, so the third ingot was never
//    smelted. Live marker: `PRECONDITION_ALREADY_MET item=raw_iron have=2
//    goal=collect 3 x raw_iron ... action=skip` while the rung was UNSATISFIED.
//
// B. candidates: `retrievalNeeds` skipped a fuel need with
//    `fuelNeedSatisfiedByInventory` ("is ANY fuel held") without consulting the
//    goal's required count. The head `collect 2 x log (fuel)` held `oak_log:1`,
//    was skipped, and the generator fell through to the queued
//    `collect 3 x raw_iron` need, emitting `RETRIEVE:known:raw_iron` from the
//    FIRST action of the run (`CAUSAL optionId=collect:log
//    candidateId=RETRIEVE:known:raw_iron:b42_10_20`).
//
// C. controller: a known RETRIEVE that reported `hasObservableProgress` (a
//    vertical/pillar chunk) but did NOT arrive cleared the active-retrieval
//    stall track, so the distance-based retirement could never fire. Live
//    sequence: `PATH_CALLBACK phase=failed ... outcome=stuck` then
//    `CAUSAL ... verified=true status=done` then `MOVE_FAILMEM_RESET`, forever.
//
// Run: bun test-m2-in-run-completion.mts
import { RUNGS, filterAlreadyMet, smeltPriorityGoal } from '../buddy-driver/planner.ts'
import type { Counts } from '../buddy-driver/planner.ts'
import { defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import { shouldClearActiveRetrieval } from './src/controller.ts'
import type { QueuedGoal } from './src/goalQueue.ts'
import type { AgentSignals, BlockState, GoalState, InventoryState, KnownResource, Vec3Json, WorldState } from './src/state.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const WORLD: Parameters<(typeof RUNGS)[number]['goals']>[1] = { craftingTables: [], furnaces: [] } as never

// --- A. the planner counts the goal's TOTAL, not the shortfall ------------------

function rung(id: string) {
  const found = RUNGS.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`rung ${id} missing`)
  return found
}

addCase('A1: with raw_iron:2 the third-ore collect goal survives (not "already met")', () => {
  const counts: Counts = { raw_iron: 2 }
  const goals = rung('raw_iron').goals(counts, WORLD)
  const kept = filterAlreadyMet(goals, counts, 'raw_iron')
  const goal = kept[0]
  const pass =
    rung('raw_iron').satisfied(counts, WORLD) === false &&
    goal !== undefined &&
    goal.kind === 'collect' &&
    goal.targetItem === 'raw_iron' &&
    goal.requiredCount === 3
  return { pass, detail: `kept=${JSON.stringify(kept)} satisfied=${rung('raw_iron').satisfied(counts, WORLD)}` }
})

addCase('A2: with iron_ingot:2 the third-ingot smelt goal survives (not "already met")', () => {
  const counts: Counts = { iron_ingot: 2 }
  const goals = rung('iron_ingot').goals(counts, WORLD)
  const kept = filterAlreadyMet(goals, counts, 'iron_ingot')
  const goal = kept[0]
  const pass =
    rung('iron_ingot').satisfied(counts, WORLD) === false &&
    goal !== undefined &&
    goal.kind === 'smelt' &&
    goal.targetItem === 'iron_ingot' &&
    goal.requiredCount === 3
  return { pass, detail: `kept=${JSON.stringify(kept)} satisfied=${rung('iron_ingot').satisfied(counts, WORLD)}` }
})

addCase('A3: smeltPriorityGoal carries the total requiredCount (3), not the shortfall', () => {
  const priority = smeltPriorityGoal({ raw_iron: 2, iron_ingot: 2, charcoal: 1 })
  const pass = priority !== null && priority.requiredCount === 3 && priority.targetItem === 'iron_ingot'
  return { pass, detail: JSON.stringify(priority) }
})

// --- B. the fuel guard respects the head goal's required count -----------------

function self(position: Vec3Json): WorldState['self'] {
  return {
    username: 'AI_M2C',
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

function signals(known: KnownResource[]): AgentSignals {
  return {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastPathStatus: 'idle',
    stalledMs: 0,
    lastPolicyConfidence: null,
    maxConcurrentActions: 0,
    escalationRecommended: false,
    failedCandidates: {},
    knownResources: known,
  }
}

function queued(overrides: Partial<QueuedGoal>): QueuedGoal {
  return {
    id: 'g',
    kind: 'collect',
    description: 'x',
    targetItem: 'log',
    requiredCount: 2,
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

/** Head fuel-log goal + a queued iron goal with one remembered adjacent ore. */
function fuelLeakWorld(logCount: number): WorldState {
  const logGoal = queued({ id: 'g-log', description: 'collect 2 x log (fuel)', targetItem: 'log', requiredCount: 2, startCount: 1, haveCount: 1 })
  const ironGoal = queued({ id: 'g-iron', description: 'collect 3 x raw_iron', targetItem: 'raw_iron', requiredCount: 3, startCount: 2, haveCount: 2 })
  const goal: GoalState = {
    id: 'g-log',
    description: 'collect 2 x log (fuel)',
    targetItem: 'log',
    requiredCount: 2,
    startCount: 1,
    haveCount: 1,
    progress: 0.5,
    complete: false,
    startedAtMs: 0,
  }
  const ore: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 3, y: 60, z: 0 } }
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self({ x: 0, y: 60, z: 0 }),
    inventory: inventory({ oak_log: logCount, cobblestone: 4 }),
    entities: [],
    blocks: [],
    terrain: { standable: [{ x: 0, y: 60, z: 0 }, { x: 2, y: 66, z: 0 }] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal,
    goalQueue: { depth: 2, current: logGoal, empty: false, hasImpossible: false, done: 0, goals: [logGoal, ironGoal] },
    recentEvents: [],
    signals: signals([ore]),
  }
}

function retrieves(counts: number) {
  return generateGroundedCandidates(fuelLeakWorld(counts), defaultCandidateOptions).candidates.filter(
    (candidate) => candidate.kind === 'RETRIEVE',
  )
}

addCase('B1: oak_log:1 leaves the collect-2-log head retrievable and does NOT leak the ore retrieve', () => {
  const found = retrieves(1)
  const logRetrieve = found.find((candidate) => candidate.meta.resource === 'log')
  const leakedOre = found.find((candidate) => candidate.id.startsWith('RETRIEVE:known:raw_iron'))
  const pass = logRetrieve !== undefined && leakedOre === undefined
  return {
    pass,
    detail: `retrieves=${JSON.stringify(found.map((c) => ({ id: c.id, resource: c.meta.resource })))}`,
  }
})

addCase('B2: oak_log:2 still satisfies the head fuel goal (historical behaviour preserved)', () => {
  const found = retrieves(2)
  const logRetrieve = found.find((candidate) => candidate.meta.resource === 'log' && candidate.meta.retrieval === 'surface')
  const pass = logRetrieve === undefined
  return { pass, detail: `retrieves=${JSON.stringify(found.map((c) => ({ id: c.id, resource: c.meta.resource })))}` }
})

// --- C. an active raw-iron Option must not admit a queued future log route ---

function rawIronEnvelopeWorld(withRoute: boolean): WorldState {
  const rawIronGoal = queued({
    id: 'g-raw-iron',
    description: 'collect 3 x raw_iron',
    targetItem: 'raw_iron',
    requiredCount: 3,
  })
  const futureLogGoal = queued({
    id: 'g-future-log',
    description: 'collect 1 x log',
    targetItem: 'log',
    requiredCount: 1,
    status: 'pending',
  })
  const ore: BlockState = {
    kind: 'ore',
    name: 'iron_ore',
    position: { x: 4, y: 60, z: 0 },
    distance: 4,
    diggable: true,
    inReach: false,
    hasAdjacentStandable: true,
    adjacentStandable: { x: 3, y: 60, z: 0 },
    yield: 'raw_iron',
    harvestTool: 'pickaxe',
    harvestTier: 0,
    visible: true,
  }
  const knownLog: KnownResource = {
    name: 'birch_log',
    kind: 'log',
    position: { x: 12, y: 60, z: 0 },
  }
  const goal: GoalState = {
    id: 'g-raw-iron',
    description: 'collect 3 x raw_iron',
    targetItem: 'raw_iron',
    requiredCount: 3,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
  return {
    schemaVersion: 1,
    tick: 12,
    timestampMs: 1_700_000_000_000,
    self: self({ x: 0.5, y: 60, z: 0.5 }),
    inventory: inventory({ stone_pickaxe: 1 }),
    entities: [],
    blocks: withRoute ? [ore] : [],
    terrain: { standable: [{ x: 0.5, y: 60, z: 0.5 }, { x: 3, y: 60, z: 0 }] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal,
    goalQueue: {
      depth: 2,
      current: rawIronGoal,
      empty: false,
      hasImpossible: false,
      done: 0,
      goals: [rawIronGoal, futureLogGoal],
    },
    recentEvents: [],
    signals: signals([knownLog]),
  }
}

function rawIronCandidates(withRoute: boolean) {
  return generateGroundedCandidates(rawIronEnvelopeWorld(withRoute), defaultCandidateOptions).candidates
}

addCase('C1: active raw_iron route does not admit an unrelated queued log retrieve', () => {
  const found = rawIronCandidates(true)
  const rawRoute = found.find((candidate) => candidate.id === 'MOVE:b4_60_0')
  const leakedLog = found.find((candidate) => candidate.id.startsWith('RETRIEVE:known:log:'))
  const pass = rawRoute !== undefined && leakedLog === undefined
  return {
    pass,
    detail: `candidates=${JSON.stringify(found.map((candidate) => ({ id: candidate.id, kind: candidate.kind, resource: candidate.meta.resource ?? null })))}`,
  }
})

addCase('C2: queued log retrieval remains available when the active raw_iron route has no candidate', () => {
  const found = rawIronCandidates(false)
  const logRoute = found.find((candidate) => candidate.id.startsWith('RETRIEVE:known:log:'))
  const pass = logRoute !== undefined
  return {
    pass,
    detail: `candidates=${JSON.stringify(found.map((candidate) => ({ id: candidate.id, kind: candidate.kind, resource: candidate.meta.resource ?? null })))}`,
  }
})

// --- D. a stuck known retrieve keeps the stall track alive ----------------------

addCase('D1: a known retrieve that progressed but did NOT arrive keeps the stall track', () => {
  const held = shouldClearActiveRetrieval({ retrieval: 'known', hasObservableProgress: true, arrived: false })
  const arrived = shouldClearActiveRetrieval({ retrieval: 'known', hasObservableProgress: true, arrived: true })
  const noProgress = shouldClearActiveRetrieval({ retrieval: 'known', hasObservableProgress: false, arrived: false })
  const surface = shouldClearActiveRetrieval({ retrieval: 'surface', hasObservableProgress: true, arrived: false })
  const pass = held === false && arrived === true && noProgress === false && surface === false
  return {
    pass,
    detail: `held=${held} arrived=${arrived} noProgress=${noProgress} surface=${surface}`,
  }
})

let failures = 0
process.stdout.write('M2 in-run completion: planner counts, fuel-guard leak, stuck-retrieve escape\n')
process.stdout.write('-'.repeat(78) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(78) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} M2 in-run completion cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
