// test-predicate-goal.mts - Issue #41 unit proof for predicate-based goals:
// success evaluation, predicate derivation and the ore-descent plan target.
// No bot, no network.
//
// Run: npx tsx test-predicate-goal.mts
import {
  describeSpatialPredicate,
  evaluateSpatialPredicate,
  levelAtMost,
  oreDescentTargetY,
  predicateForGoal,
} from './src/predicateGoal.ts'
import { defaultCandidateOptions, generateCandidates } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { AgentSignals, DescentOption, GoalState, InventoryState, SelfState, Vec3Json, WorldState } from './src/state.ts'

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
    username: 'AI_M2PD',
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

function goal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    id: 'descend:raw_iron',
    description: 'descend_to:Y=47',
    targetItem: 'raw_iron',
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
    id: 'g1',
    kind: 'descend',
    description: 'descend_to:Y=47',
    targetItem: 'raw_iron',
    requiredCount: 1,
    targetY: 47,
    dimension: 'minecraft:overworld',
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

function downStep(dir: DescentOption['dir'], dx: number, dz: number, feet: Vec3Json): DescentOption {
  return {
    dir,
    mode: 'down',
    dx,
    dz,
    step: { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz },
    wall: { x: feet.x + dx, y: feet.y, z: feet.z + dz },
    head: { x: feet.x + dx, y: feet.y + 1, z: feet.z + dz },
    floor: { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz },
    wallSolid: false,
    headSolid: false,
    floorSolid: true,
    safe: true,
    reason: 'safe',
    digName: 'stone',
    digHarvestTool: 'pickaxe',
    digHarvestTier: 1,
    diggable: true,
  }
}

function levelStep(dir: DescentOption['dir'], dx: number, dz: number, feet: Vec3Json): DescentOption {
  return { ...downStep(dir, dx, dz, feet), mode: 'level', step: { x: feet.x + dx, y: feet.y, z: feet.z + dz } }
}

function worldState(overrides: {
  position: Vec3Json
  goalQueue: GoalQueueState
  goal?: GoalState
  signals?: AgentSignals
  descent?: DescentOption[]
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position),
    inventory: inventory({ stone_pickaxe: 1 }),
    entities: [],
    blocks: [],
    terrain: { standable: [overrides.position] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: overrides.goal ?? goal(),
    goalQueue: overrides.goalQueue,
    recentEvents: [],
    descent: overrides.descent,
    stepCuts: [],
    headroomCuts: [],
    signals: overrides.signals ?? signals(),
  }
}

// --- predicate success evaluation ------------------------------------------------

addCase('levelAtMost is satisfied at or below the target Y', () => {
  const at = evaluateSpatialPredicate(levelAtMost(47), { position: { x: 0, y: 47, z: 0 }, dimension: 'overworld' })
  const below = evaluateSpatialPredicate(levelAtMost(47), { position: { x: 0, y: 40, z: 0 }, dimension: 'overworld' })
  const above = evaluateSpatialPredicate(levelAtMost(47), { position: { x: 0, y: 48, z: 0 }, dimension: 'overworld' })
  return {
    pass: at.satisfied && at.y === 47 && below.satisfied && !above.satisfied,
    detail: `at=${at.satisfied} below=${below.satisfied} above=${above.satisfied}`,
  }
})

addCase('a dimension-qualified predicate fails in the wrong dimension', () => {
  const right = evaluateSpatialPredicate(levelAtMost(47, 'minecraft:overworld'), { position: { x: 0, y: 47, z: 0 }, dimension: 'overworld' })
  const wrong = evaluateSpatialPredicate(levelAtMost(47, 'minecraft:overworld'), { position: { x: 0, y: 47, z: 0 }, dimension: 'the_nether' })
  return {
    pass: right.satisfied && right.dimensionOk && !wrong.satisfied && wrong.dimensionOk === false,
    detail: `right=${right.satisfied}/${right.dimensionOk} wrong=${wrong.satisfied}/${wrong.dimensionOk}`,
  }
})

addCase('a null position or null dimension is handled without satisfying the predicate', () => {
  const noPos = evaluateSpatialPredicate(levelAtMost(47), { position: null, dimension: 'overworld' })
  const noDim = evaluateSpatialPredicate(levelAtMost(47, 'minecraft:overworld'), { position: { x: 0, y: 47, z: 0 }, dimension: null })
  const anyDim = evaluateSpatialPredicate(levelAtMost(47), { position: { x: 0, y: 47, z: 0 }, dimension: null })
  return {
    pass: !noPos.satisfied && !noDim.satisfied && anyDim.satisfied,
    detail: `noPos=${noPos.satisfied} noDim=${noDim.satisfied} anyDim=${anyDim.satisfied} :: ${noPos.detail}`,
  }
})

addCase('predicateForGoal derives a descend predicate only from a descend goal with a targetY', () => {
  const descend = predicateForGoal({ kind: 'descend', targetY: 47, dimension: 'minecraft:overworld' })
  const noTarget = predicateForGoal({ kind: 'descend' })
  const collect = predicateForGoal({ kind: 'collect', targetY: 47 })
  return {
    pass:
      descend !== null &&
      describeSpatialPredicate(descend) === 'descend_to:Y=47' &&
      descend.dimension === 'minecraft:overworld' &&
      noTarget === null &&
      collect === null,
    detail: `descend=${descend === null ? 'null' : describeSpatialPredicate(descend)} noTarget=${noTarget} collect=${collect}`,
  }
})

// --- plan generation -------------------------------------------------------------

addCase('oreDescentTargetY picks the deepest known ore minus the margin', () => {
  const known = [
    { name: 'iron_ore', y: 49, dimension: 'minecraft:overworld' },
    { name: 'iron_ore', y: 56, dimension: 'minecraft:overworld' },
  ]
  const target = oreDescentTargetY('raw_iron', known, 'minecraft:overworld')
  return { pass: target === 47, detail: `targetY=${target}` }
})

addCase('oreDescentTargetY ignores coordinates from another dimension and falls back to the ore band', () => {
  const nether = [{ name: 'iron_ore', y: 30, dimension: 'minecraft:the_nether' }]
  const fallbackIron = oreDescentTargetY('raw_iron', nether, 'minecraft:overworld')
  const fallbackDiamond = oreDescentTargetY('diamond', [], 'minecraft:overworld')
  const clamped = oreDescentTargetY('raw_iron', [{ name: 'iron_ore', y: -70, dimension: 'minecraft:overworld' }], 'minecraft:overworld')
  return {
    pass: fallbackIron === 32 && fallbackDiamond === 8 && clamped === -59,
    detail: `iron=${fallbackIron} diamond=${fallbackDiamond} clamped=${clamped}`,
  }
})

addCase('a descend goal below the bot emits a downward DESCEND candidate naming the predicate', () => {
  const feet = { x: 0, y: 55, z: 0 }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({ targetY: 47 })),
    descent: [downStep('E', 1, 0, feet), levelStep('N', 0, -1, feet)],
  })
  const descend = generateCandidates(state, defaultCandidateOptions).find((candidate: Candidate) => candidate.kind === 'DESCEND')
  const pass =
    descend !== undefined &&
    descend.meta.mode === 'down' &&
    descend.meta.predicate === 'descend_to:Y=47' &&
    descend.meta.descendTargetY === 47
  return { pass, detail: descend === undefined ? 'no DESCEND' : `${descend.id} meta=${JSON.stringify(descend.meta)}` }
})

addCase('at/below the descend target no downward step is offered, only a level branch step', () => {
  const feet = { x: 0, y: 46, z: 0 }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({ targetY: 47 })),
    descent: [downStep('E', 1, 0, feet), levelStep('N', 0, -1, feet)],
  })
  const generated = generateCandidates(state, defaultCandidateOptions).filter((candidate: Candidate) => candidate.kind === 'DESCEND')
  const anyDown = generated.some((candidate) => candidate.meta.mode === 'down')
  const level = generated.find((candidate) => candidate.meta.mode === 'level')
  return {
    pass: !anyDown && level !== undefined && level.meta.predicate === 'descend_to:Y=47',
    detail: generated.map((candidate) => `${candidate.id}:${String(candidate.meta.predicate)}`).join(',') || 'none',
  }
})

addCase('a collect goal with no descend target keeps the old candidate behaviour (no forced down)', () => {
  const feet = { x: 0, y: 55, z: 0 }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({ kind: 'collect', targetY: null, targetItem: 'raw_iron', description: 'collect 3 x raw_iron' })),
    descent: [downStep('E', 1, 0, feet), levelStep('N', 0, -1, feet)],
  })
  const generated = generateCandidates(state, defaultCandidateOptions).filter((candidate: Candidate) => candidate.kind === 'DESCEND')
  const anyDown = generated.some((candidate) => candidate.meta.mode === 'down')
  return { pass: !anyDown, detail: generated.map((candidate) => candidate.id).join(',') || 'none' }
})

let failures = 0
process.stdout.write('predicate-based descend goal (#41)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} predicate-goal cases passed\n`)
if (failures > 0) process.exit(1)
