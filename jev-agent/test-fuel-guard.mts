// test-fuel-guard.mts - unit proof for issue #43 follow-up: fuel satisfaction
// from the live inventory (no surface trip for fuel already held) and the
// unreachable-move guard (a target above the climb limit is logged and retired).
// No bot, no network.
//
// Run: bun test-fuel-guard.mts
import { defaultCandidateOptions, formatFuelSatisfied, fuelSatisfaction, generateCandidates, generateGroundedCandidates, goalCollectsFuel, goalWantsFuel } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { formatMoveUnreachable, MOVE_VERTICAL_GAP_LIMIT, unreachableMove } from './src/policy.ts'
import { findInventoryFuel } from './src/resourceClass.ts'
import type { QueuedGoal } from './src/goalQueue.ts'
import type { AgentSignals, BlockState, GoalState, InventoryState, Vec3Json, WorldState } from './src/state.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

function self(position: Vec3Json): WorldState['self'] {
  return {
    username: 'AI_M1F43',
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

function goal(overrides: Partial<GoalState>): GoalState {
  return {
    id: 'g1',
    description: 'collect 2 x log (fuel)',
    targetItem: 'log',
    requiredCount: 2,
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
    description: 'collect 2 x log (fuel)',
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

function worldState(overrides: {
  position: Vec3Json
  goal: GoalState
  current: QueuedGoal
  inventory: InventoryState
  standable?: Vec3Json[]
  blocks?: BlockState[]
  failedCandidates?: Record<string, number>
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position),
    inventory: overrides.inventory,
    entities: [],
    blocks: overrides.blocks ?? [],
    terrain: { standable: overrides.standable ?? [overrides.position] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: overrides.goal,
    goalQueue: { depth: 1, current: overrides.current, empty: false, hasImpossible: false, done: 0, goals: [overrides.current] },
    recentEvents: [],
    signals: signals(overrides.failedCandidates === undefined ? {} : { failedCandidates: overrides.failedCandidates }),
  }
}

function retrieval(candidates: readonly Candidate[]): Candidate | null {
  return candidates.find((candidate) => candidate.kind === 'RETRIEVE') ?? null
}

function moveCandidate(id: string, target: Vec3Json): Candidate {
  return {
    id,
    kind: 'MOVE',
    label: 'move',
    targetName: null,
    target,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: { tick: 7, x: target.x, y: target.y, z: target.z },
  }
}

// --- fuel satisfaction from live inventory --------------------------------------

addCase('a collect 2 x log (fuel) goal is satisfied by held planks: no retrieval', () => {
  const state = worldState({
    position: { x: 0, y: 60, z: 0 },
    goal: goal({}),
    current: queuedGoal({}),
    inventory: inventory({ oak_planks: 2 }),
    standable: [
      { x: 0, y: 60, z: 0 },
      { x: 2, y: 66, z: 0 },
    ],
  })
  const found = retrieval(generateCandidates(state, defaultCandidateOptions))
  const fuel = fuelSatisfaction(state)
  const line = formatFuelSatisfied(fuel?.item ?? 'none', fuel?.count ?? 0)
  const pass =
    found === null &&
    fuel?.item === 'oak_planks' &&
    fuel?.count === 2 &&
    line === 'FUEL_SATISFIED item=oak_planks have=2 -> skip' &&
    goalWantsFuel(state.goalQueue.current) === true
  return { pass, detail: `retrieve=${found?.id ?? 'none'} fuel=${JSON.stringify(fuel)} line=${line}` }
})

addCase('a held oak_log satisfies the smelt-charcoal fuel need (measured case)', () => {
  const smelt = queuedGoal({ kind: 'smelt', description: 'smelt 1 x charcoal', targetItem: 'charcoal', requiredCount: 1 })
  const state = worldState({
    position: { x: 25, y: 52, z: 36 },
    goal: goal({ description: 'smelt 1 x charcoal', targetItem: 'charcoal', requiredCount: 1 }),
    current: smelt,
    inventory: inventory({ oak_log: 2 }),
    standable: [
      { x: 25, y: 52, z: 36 },
      { x: 33, y: 68, z: 27 },
    ],
  })
  const found = retrieval(generateCandidates(state, defaultCandidateOptions))
  const fuel = fuelSatisfaction(state)
  const pass = found === null && fuel?.item === 'oak_log' && goalWantsFuel(smelt) === true
  return { pass, detail: `retrieve=${found?.id ?? 'none'} fuel=${JSON.stringify(fuel)}` }
})

addCase('a held log plus non-log fuel also suppresses the charcoal log retrieval', () => {
  const smelt = queuedGoal({ kind: 'smelt', description: 'smelt 1 x charcoal', targetItem: 'charcoal', requiredCount: 1 })
  const state = worldState({
    position: { x: 0, y: 60, z: 0 },
    goal: goal({ description: 'smelt 1 x charcoal', targetItem: 'charcoal', requiredCount: 1 }),
    current: smelt,
    inventory: inventory({ coal: 1, oak_log: 1 }),
    standable: [
      { x: 0, y: 60, z: 0 },
      { x: 2, y: 66, z: 0 },
    ],
  })
  const found = retrieval(generateCandidates(state, defaultCandidateOptions))
  const pass = found === null && fuelSatisfaction(state)?.item === 'coal'
  return { pass, detail: `retrieve=${found?.id ?? 'none'} fuel=${JSON.stringify(fuelSatisfaction(state))}` }
})

addCase('without held fuel the surface retrieval is still emitted', () => {
  const state = worldState({
    position: { x: 0, y: 60, z: 0 },
    goal: goal({}),
    current: queuedGoal({}),
    // a placeable block makes the 6-block climb mechanically reachable, so the
    // affordance gate presents the retrieval (needs_ascend otherwise).
    inventory: inventory({ cobblestone: 4 }),
    standable: [
      { x: 0, y: 60, z: 0 },
      { x: 2, y: 66, z: 0 },
    ],
  })
  const found = retrieval(generateCandidates(state, defaultCandidateOptions))
  const pass = found !== null && found.meta.retrieval === 'surface' && fuelSatisfaction(state) === null
  return { pass, detail: found === null ? 'no RETRIEVE' : `${found.id} meta=${JSON.stringify(found.meta)}` }
})

addCase('blaze_rod is an accepted fuel', () => {
  const fuel = findInventoryFuel({ blaze_rod: 1, stick: 4 })
  const pass = fuel?.item === 'blaze_rod' && fuel.count === 1
  return { pass, detail: JSON.stringify(fuel) }
})

addCase('a smelt goal needs fuel as a precondition but never completes on it', () => {
  const smelt = queuedGoal({ kind: 'smelt', description: 'smelt 1 x charcoal', targetItem: 'charcoal', requiredCount: 1 })
  const log = queuedGoal({ kind: 'collect', description: 'collect 3 x log', targetItem: 'log', requiredCount: 3 })
  const pass = goalWantsFuel(smelt) === true && goalCollectsFuel(smelt) === false && goalCollectsFuel(log) === false
  return { pass, detail: `smelt wants=${goalWantsFuel(smelt)} collects=${goalCollectsFuel(smelt)} woodCollects=${goalCollectsFuel(log)}` }
})

// --- unreachable-move guard -----------------------------------------------------

addCase('the surface MOVE is unreachable with a 16-block vertical gap', () => {
  const state = worldState({
    position: { x: 25, y: 52, z: 36 },
    goal: goal({}),
    current: queuedGoal({}),
    inventory: inventory({ oak_log: 2 }),
  })
  const candidate = moveCandidate('MOVE:b33_68_27', { x: 33, y: 68, z: 27 })
  const reason = unreachableMove(candidate, state)
  const pass =
    reason !== null &&
    reason.dy === 16 &&
    formatMoveUnreachable(reason.target, reason.dy) === 'MOVE_UNREACHABLE target=33,68,27 dy=16'
  return { pass, detail: reason === null ? 'reachable' : formatMoveUnreachable(reason.target, reason.dy) }
})

addCase('a vertical-plan surface MOVE is not retired by the horizontal gap guard', () => {
  const state = worldState({
    position: { x: 25, y: 52, z: 36 },
    goal: goal({}),
    current: queuedGoal({}),
    inventory: inventory({ cobblestone: 12 }),
  })
  const candidate = {
    ...moveCandidate('MOVE:b33_68_27', { x: 33, y: 68, z: 27 }),
    meta: {
      ...moveCandidate('MOVE:b33_68_27', { x: 33, y: 68, z: 27 }).meta,
      vertical: 'pillar',
      pillarToY: 68,
      pillarSteps: 16,
      pillarPlaceName: 'cobblestone',
    },
  }
  const reason = unreachableMove(candidate, state, () => false)
  return { pass: reason === null, detail: reason === null ? 'vertical plan preserved' : formatMoveUnreachable(reason.target, reason.dy) }
})

addCase('a one-block step is reachable and an explicit no-path is rejected', () => {
  const state = worldState({
    position: { x: 0, y: 64, z: 0 },
    goal: goal({}),
    current: queuedGoal({}),
    inventory: inventory({}),
  })
  const near = moveCandidate('MOVE:b1_65_0', { x: 1, y: 65, z: 0 })
  const far = moveCandidate('MOVE:b1_66_0', { x: 1, y: 66, z: 0 })
  const nearReason = unreachableMove(near, state)
  const noPathReason = unreachableMove(far, state, () => false)
  const pass = nearReason === null && noPathReason !== null && noPathReason.dy === 2 && MOVE_VERTICAL_GAP_LIMIT === 4
  return {
    pass,
    detail: `near=${JSON.stringify(nearReason)} noPath=${JSON.stringify(noPathReason)} limit=${MOVE_VERTICAL_GAP_LIMIT}`,
  }
})

function surfaceLog(): BlockState {
  return {
    kind: 'log',
    name: 'oak_log',
    position: { x: 33, y: 68, z: 27 },
    distance: 20,
    diggable: true,
    inReach: false,
    hasAdjacentStandable: true,
    adjacentStandable: { x: 33, y: 68, z: 28 },
    yield: 'oak_log',
    harvestTool: null,
  }
}

addCase('the unreachable surface MOVE is withheld by the affordance gate instead of retried', () => {
  const base = {
    position: { x: 25, y: 52, z: 36 } as Vec3Json,
    goal: goal({}),
    current: queuedGoal({}),
    inventory: inventory({ oak_log: 2 }),
    blocks: [surfaceLog()],
  }
  const grounded = generateGroundedCandidates(worldState(base), defaultCandidateOptions)
  const withheld = grounded.withheld.find((entry) => entry.candidate.id === 'MOVE:b33_68_27')
  const reason = withheld === undefined ? null : unreachableMove(withheld.candidate, worldState(base))
  const pass =
    !grounded.candidates.some((entry) => entry.id === 'MOVE:b33_68_27') &&
    withheld !== undefined &&
    withheld.result.reason === 'needs_ascend' &&
    reason !== null &&
    reason.dy === 16
  return {
    pass,
    detail: `presented=${grounded.candidates.some((entry) => entry.id === 'MOVE:b33_68_27')} withheld=${withheld?.result.reason ?? 'none'} dy=${reason?.dy ?? 'none'}`,
  }
})

addCase('a reachable surface MOVE is still retired at the failure limit', () => {
  const base = {
    position: { x: 33, y: 67, z: 36 } as Vec3Json,
    goal: goal({}),
    current: queuedGoal({}),
    inventory: inventory({ oak_log: 2 }),
    blocks: [surfaceLog()],
  }
  const fresh = generateCandidates(worldState(base), defaultCandidateOptions)
  const retired = generateCandidates(
    worldState({ ...base, failedCandidates: { 'MOVE:b33_68_27': 4 } }),
    defaultCandidateOptions,
  )
  const pass =
    fresh.some((entry) => entry.id === 'MOVE:b33_68_27') &&
    !retired.some((entry) => entry.id === 'MOVE:b33_68_27')
  return {
    pass,
    detail: `generated=${fresh.some((entry) => entry.id === 'MOVE:b33_68_27')} retired=${!retired.some((entry) => entry.id === 'MOVE:b33_68_27')}`,
  }
})

let failures = 0
process.stdout.write('issue #43 follow-up - fuel satisfaction and unreachable-move guard\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} fuel/unreachable cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
