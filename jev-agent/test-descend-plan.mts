// test-descend-plan.mts - Issue #41 unit proof that a `descend_to:Y=<n>` goal
// produces an executable descend candidate (never a WAIT-only list) and that a
// stalled descend escalates. No bot, no network.
//
// Run: bun test-descend-plan.mts
import {
  evaluateDescendProgress,
  formatDescendProgress,
  formatDescendStalled,
  isStraightDown,
  pickBestDescendStep,
  resolveDescendStallTicks,
} from './src/descendPlan.ts'
import type { DescendScoreInput } from './src/descendPlan.ts'
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
    username: 'AI_M1D41',
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

function goal(): GoalState {
  return {
    id: 'descend:raw_iron',
    description: 'descend_to:Y=46',
    targetItem: 'raw_iron',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(overrides: Partial<QueuedGoal> = {}): QueuedGoal {
  return {
    id: 'g1',
    kind: 'descend',
    description: 'descend_to:Y=46',
    targetItem: 'raw_iron',
    requiredCount: 1,
    targetY: 46,
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

function worldState(overrides: {
  position: Vec3Json
  goalQueue: GoalQueueState
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
    goal: goal(),
    goalQueue: overrides.goalQueue,
    recentEvents: [],
    descent: overrides.descent,
    stepCuts: [],
    headroomCuts: [],
    signals: overrides.signals ?? signals(),
  }
}

function scoreInput(overrides: Partial<DescendScoreInput> = {}): DescendScoreInput {
  return {
    wantDown: true,
    hasTunnelTarget: false,
    predicateDescend: true,
    target: { x: 25, y: 49, z: 36 },
    feet: { x: 0, y: 55, z: 0 },
    ...overrides,
  }
}

// --- progress assertion ----------------------------------------------------------

addCase('a whole-block drop is progress and re-arms the stall counter', () => {
  const decision = evaluateDescendProgress({ previous: { bestY: 55, ticks: 19 }, y: 54, stallTicks: 20 })
  return {
    pass: decision.outcome === 'progress' && decision.bestY === 54 && decision.ticks === 0,
    detail: `${decision.outcome} bestY=${decision.bestY} ticks=${decision.ticks}`,
  }
})

addCase('no vertical movement tracks, then stalls at the window and re-arms', () => {
  let state = { bestY: 55, ticks: 0 }
  const outcomes: string[] = []
  for (let i = 0; i < 21; i += 1) {
    const decision = evaluateDescendProgress({ previous: state, y: 55, stallTicks: 20 })
    outcomes.push(decision.outcome)
    state = { bestY: decision.bestY, ticks: decision.ticks }
  }
  return {
    pass: outcomes[0] === 'tracking' && outcomes[19] === 'stalled' && outcomes[20] === 'tracking',
    detail: `first=${outcomes[0]} tick20=${outcomes[19]} tick21=${outcomes[20]}`,
  }
})

addCase('the exact DESCEND_STALLED / DESCEND_PROGRESS marker lines are stable', () => {
  const stalled = formatDescendStalled(55, 46, 20)
  const progress = formatDescendProgress(50, 46, 5.5, 0)
  return {
    pass:
      stalled === 'DESCEND_STALLED y=55 target_y=46 ticks=20' &&
      progress === 'DESCEND_PROGRESS y=50 target_y=46 delta=5.5 ticks=0',
    detail: `${stalled} | ${progress}`,
  }
})

addCase('invalid BUDDY_DESCEND_STALL_TICKS falls back to the default', () => {
  const fallback = resolveDescendStallTicks({ BUDDY_DESCEND_STALL_TICKS: 'nope' })
  const override = resolveDescendStallTicks({ BUDDY_DESCEND_STALL_TICKS: '3' })
  return { pass: fallback === 20 && override === 3, detail: `fallback=${fallback} override=${override}` }
})

// --- candidate selection ---------------------------------------------------------

addCase('an aligned cardinal staircase beats digging straight down', () => {
  const feet = { x: 0, y: 55, z: 0 }
  const straight = downStep('D', 0, 0, feet)
  const aligned = downStep('E', 1, 0, feet)
  const best = pickBestDescendStep([straight, aligned], scoreInput())
  return {
    pass: best === aligned && !isStraightDown(best),
    detail: `best=${best?.dir ?? 'none'} straight=${isStraightDown(straight)}`,
  }
})

addCase('digging straight down is chosen when it is the only safe step', () => {
  const feet = { x: 0, y: 55, z: 0 }
  const straight = downStep('D', 0, 0, feet)
  const best = pickBestDescendStep([straight], scoreInput())
  return { pass: best === straight && isStraightDown(straight), detail: `best=${best?.dir ?? 'none'}` }
})

addCase('an empty pool yields no step', () => {
  return { pass: pickBestDescendStep([], scoreInput()) === null, detail: 'empty pool -> null' }
})

// --- candidate generation (the measured stall) ----------------------------------

addCase('a latched descend budget still yields a DESCEND candidate for a predicate goal', () => {
  const feet = { x: 0, y: 55, z: 0 }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({ targetY: 46 })),
    signals: signals({ descendLimitReached: true }),
    descent: [downStep('D', 0, 0, feet)],
  })
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const descend = candidates.find((candidate: Candidate) => candidate.kind === 'DESCEND')
  return {
    pass:
      descend !== undefined &&
      descend.meta.mode === 'down' &&
      descend.meta.predicate === 'descend_to:Y=46' &&
      descend.meta.dir === 'D' &&
      candidates.some((candidate: Candidate) => candidate.kind === 'WAIT'),
    detail: descend === undefined ? 'no DESCEND' : `${descend.id} dir=${String(descend.meta.dir)}`,
  }
})

addCase('a latched item-goal descent budget preserves safe lateral search', () => {
  const feet = { x: 0, y: 55, z: 0 }
  const lateral = {
    ...downStep('E', 1, 0, feet),
    mode: 'level' as const,
    step: { x: 1, y: 55, z: 0 },
    floor: { x: 1, y: 54, z: 0 },
    wall: { x: 1, y: 55, z: 0 },
    head: { x: 1, y: 56, z: 0 },
  }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(
      queuedGoal({ kind: 'collect', targetY: undefined, description: 'collect raw iron' }),
    ),
    signals: signals({ descendLimitReached: true }),
    descent: [lateral],
  })
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const descend = candidates.find((candidate: Candidate) => candidate.kind === 'DESCEND')
  return {
    pass: descend !== undefined && descend.meta.mode === 'level' && descend.meta.dir === 'E',
    detail: descend === undefined ? 'no lateral DESCEND' : `${descend.id} mode=${String(descend.meta.mode)}`,
  }
})

addCase('a predicate goal with only unsafe steps has no DESCEND candidate (escalation path)', () => {
  const feet = { x: 0, y: 55, z: 0 }
  const unsafe = { ...downStep('D', 0, 0, feet), safe: false, reason: 'lava/water in the step column' }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({ targetY: 46 })),
    descent: [unsafe],
  })
  const descend = generateCandidates(state, defaultCandidateOptions).filter(
    (candidate: Candidate) => candidate.kind === 'DESCEND',
  )
  return { pass: descend.length === 0, detail: descend.map((candidate) => candidate.id).join(',') || 'none' }
})

addCase('the straight-down candidate records the exact predicate target in its meta', () => {
  const feet = { x: 0, y: 55, z: 0 }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({ targetY: 46 })),
    descent: [downStep('D', 0, 0, feet)],
  })
  const descend = generateCandidates(state, defaultCandidateOptions).find(
    (candidate: Candidate) => candidate.kind === 'DESCEND',
  )
  const target = descend?.target
  return {
    pass:
      descend !== undefined &&
      target !== null &&
      target !== undefined &&
      target.x === 0 &&
      target.y === 54 &&
      target.z === 0,
    detail: descend === undefined ? 'no DESCEND' : `target=${JSON.stringify(descend.target)}`,
  }
})

let failures = 0
process.stdout.write('descend plan (#41): candidate generation + stall escalation\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} descend-plan cases passed\n`)
if (failures > 0) process.exit(1)
