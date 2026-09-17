// test-vertical-plan.mts - issue #45 unit proof for the retrieval vertical leg
// and the stall escalation. No bot, no network.
//
// Run: npx tsx test-vertical-plan.mts
import { defaultCandidateOptions, generateCandidates } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { guardCandidate } from './src/policy.ts'
import type { GuardContext } from './src/policy.ts'
import { evaluateRetrievalProgress, planVerticalApproach } from './src/verticalPlan.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type {
  AgentSignals,
  DescentOption,
  GoalState,
  InventoryState,
  KnownResource,
  SelfState,
  Vec3Json,
  WorldState,
} from './src/state.ts'

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
    username: 'AI_M2V45',
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

function worldState(overrides: {
  position: Vec3Json
  goalQueue: GoalQueueState
  goal?: GoalState
  signals?: AgentSignals
  descent?: DescentOption[]
  inventory?: InventoryState
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position),
    inventory: overrides.inventory ?? inventory({ stone_pickaxe: 1 }),
    entities: [],
    blocks: [],
    terrain: { standable: [overrides.position] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: overrides.goal ?? goal({}),
    goalQueue: overrides.goalQueue,
    recentEvents: [],
    descent: overrides.descent,
    signals: overrides.signals ?? signals(),
  }
}

function downStep(dir: DescentOption['dir'], dx: number, dz: number, feet: Vec3Json): DescentOption {
  const step = { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz }
  return {
    dir,
    mode: 'down',
    dx,
    dz,
    step,
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

function retrieveOf(candidates: readonly Candidate[]): Candidate | null {
  return candidates.find((candidate) => candidate.kind === 'RETRIEVE') ?? null
}

function guardContext(candidateIds: string[]): GuardContext {
  return {
    phase: 'decision',
    candidateIds: new Set(candidateIds),
    inFlight: null,
    reach: 5,
    maxCandidateAgeTicks: 10,
  }
}

// --- vertical-plan generation ---------------------------------------------------

addCase('a target 8 blocks below yields an aligned downward staircase plan', () => {
  const feet = { x: 28, y: 57, z: 35 }
  const target = { x: 40, y: 49, z: 0 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target,
    tunnel: null,
    descent: [downStep('E', 1, 0, feet), downStep('N', 0, -1, feet)],
  })
  const pass =
    plan?.kind === 'staircase' &&
    plan.dir === 'E' &&
    plan.fromY === 57 &&
    plan.toY === 49 &&
    plan.step.y === 56 &&
    plan.dig.y === 56
  return { pass, detail: JSON.stringify(plan) }
})

addCase('a tunnel between the bot and a lower target is reused before digging', () => {
  const feet = { x: 28, y: 57, z: 35 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 25, y: 49, z: 36 },
    tunnel: { x: 27, y: 53, z: 35 },
    descent: [downStep('W', -1, 0, feet)],
  })
  const pass = plan?.kind === 'reuse' && plan.tunnel.x === 27 && plan.tunnel.y === 53
  return { pass, detail: JSON.stringify(plan) }
})

addCase('a tunnel pointing away from the target is ignored in favour of a staircase', () => {
  const feet = { x: 28, y: 57, z: 35 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 25, y: 49, z: 36 },
    tunnel: { x: 28, y: 61, z: 35 },
    descent: [downStep('W', -1, 0, feet)],
  })
  const pass = plan?.kind === 'staircase' && plan.toY === 49
  return { pass, detail: JSON.stringify(plan) }
})

addCase('an upward target with no safe upward primitive yields no staircase', () => {
  const feet = { x: 0, y: 57, z: 0 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 4, y: 66, z: 0 },
    tunnel: null,
    descent: [downStep('E', 1, 0, feet)],
  })
  return { pass: plan === null, detail: JSON.stringify(plan) }
})

addCase('a level target produces no vertical plan', () => {
  const feet = { x: 0, y: 57, z: 0 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 4, y: 58, z: 0 },
    tunnel: null,
    descent: [downStep('E', 1, 0, feet)],
  })
  return { pass: plan === null, detail: JSON.stringify(plan) }
})

// --- candidate wiring -----------------------------------------------------------

addCase('a below-level remembered ore emits a staircase retrieval candidate', () => {
  const feet = { x: 28, y: 57, z: 35 }
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 40, y: 49, z: 0 } }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({})),
    signals: signals({ knownResources: [known] }),
    descent: [downStep('E', 1, 0, feet)],
  })
  const retrieve = retrieveOf(generateCandidates(state, defaultCandidateOptions))
  const pass =
    retrieve !== null &&
    retrieve.meta.vertical === 'staircase' &&
    retrieve.meta.stairToY === 49 &&
    typeof retrieve.meta.stairDigX === 'number' &&
    retrieve.meta.stairDigY === 56
  return { pass, detail: retrieve === null ? 'no RETRIEVE' : JSON.stringify(retrieve.meta) }
})

addCase('a remembered tunnel turns the retrieval candidate into a reuse plan', () => {
  const feet = { x: 28, y: 57, z: 35 }
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 25, y: 49, z: 36 } }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({})),
    signals: signals({ knownResources: [known], lastTunnel: { x: 27, y: 53, z: 35 } }),
    descent: [downStep('W', -1, 0, feet)],
  })
  const retrieve = retrieveOf(generateCandidates(state, defaultCandidateOptions))
  const pass =
    retrieve !== null &&
    retrieve.meta.vertical === 'reuse' &&
    retrieve.meta.tunnelX === 27 &&
    retrieve.meta.tunnelY === 53
  return { pass, detail: retrieve === null ? 'no RETRIEVE' : JSON.stringify(retrieve.meta) }
})

// --- guard grounding ------------------------------------------------------------

addCase('the guard accepts a staircase retrieval grounded in the descent options', () => {
  const feet = { x: 28, y: 57, z: 35 }
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 40, y: 49, z: 0 } }
  const step = downStep('E', 1, 0, feet)
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({})),
    signals: signals({ knownResources: [known] }),
    descent: [step],
  })
  const candidate: Candidate = {
    id: 'RETRIEVE:known:raw_iron:b40_49_0',
    kind: 'RETRIEVE',
    label: 'retrieve',
    targetName: 'iron_ore',
    target: known.position,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: {
      tick: 7,
      retrieval: 'known',
      resource: 'raw_iron',
      vertical: 'staircase',
      stairDigX: step.floor.x,
      stairDigY: step.floor.y,
      stairDigZ: step.floor.z,
    },
  }
  const result = guardCandidate(candidate, state, guardContext([candidate.id]))
  return { pass: result.ok, detail: result.ok ? 'accepted' : result.code }
})

addCase('the guard rejects a staircase retrieval with no matching descent step', () => {
  const feet = { x: 28, y: 57, z: 35 }
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 40, y: 49, z: 0 } }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({})),
    signals: signals({ knownResources: [known] }),
    descent: [downStep('E', 1, 0, feet)],
  })
  const candidate: Candidate = {
    id: 'RETRIEVE:known:raw_iron:b40_49_0',
    kind: 'RETRIEVE',
    label: 'retrieve',
    targetName: 'iron_ore',
    target: known.position,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: {
      tick: 7,
      retrieval: 'known',
      resource: 'raw_iron',
      vertical: 'staircase',
      stairDigX: 999,
      stairDigY: 20,
      stairDigZ: 999,
    },
  }
  const result = guardCandidate(candidate, state, guardContext([candidate.id]))
  return { pass: !result.ok && result.code === 'NO_SUPPORT', detail: result.ok ? 'accepted' : result.code }
})

// --- stall escalation -----------------------------------------------------------

addCase('a decreasing retrieval distance counts as progress', () => {
  const decision = evaluateRetrievalProgress({
    previous: { best: 9, ticks: 3 },
    distance: 8.4,
    epsilon: 0.5,
    stallTicks: 6,
  })
  const pass = decision.outcome === 'progress' && decision.best === 8.4 && decision.ticks === 0
  return { pass, detail: JSON.stringify(decision) }
})

addCase('a flat retrieval distance increments the stall counter', () => {
  const decision = evaluateRetrievalProgress({
    previous: { best: 9, ticks: 2 },
    distance: 8.9,
    epsilon: 0.5,
    stallTicks: 6,
  })
  const pass = decision.outcome === 'tracking' && decision.best === 9 && decision.ticks === 3
  return { pass, detail: JSON.stringify(decision) }
})

addCase('a retrieval that stops closing distance for N ticks escalates', () => {
  let track = { best: 9, ticks: 0 }
  const outcomes: string[] = []
  for (let i = 0; i < 7; i += 1) {
    const decision = evaluateRetrievalProgress({
      previous: track,
      distance: 9,
      epsilon: 0.5,
      stallTicks: 6,
    })
    track = { best: decision.best, ticks: decision.ticks }
    outcomes.push(decision.outcome)
  }
  const pass = outcomes.join(',') === 'tracking,tracking,tracking,tracking,tracking,stalled,tracking'
  return { pass, detail: outcomes.join(',') }
})

let failures = 0
process.stdout.write('issue #45 - retrieval vertical plan and stall escalation\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} vertical-plan cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
