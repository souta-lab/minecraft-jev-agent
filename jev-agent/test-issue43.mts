// test-issue43.mts - unit proof for issue #43: a WAIT on one goal becomes a
// bounded replan (never an infinite WAIT), and a resource that cannot exist at
// the current depth yields a grounded RETRIEVE candidate. No bot, no network.
//
// Run: npx tsx test-issue43.mts  (wired as `npm run issue43-test`)
import { defaultCandidateOptions, generateCandidates } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { evaluateWaitWedge } from './src/controller.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { guardCandidate } from './src/policy.ts'
import type { GuardContext } from './src/policy.ts'
import type { AgentSignals, BlockState, GoalState, InventoryState, KnownResource, SelfState, StationEntry, Vec3Json, WorldState } from './src/state.ts'

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
    username: 'AI_M2W43',
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
    id: 'chop:oak_log',
    description: 'collect 2 x oak_log',
    targetItem: 'oak_log',
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
    description: 'collect 2 x oak_log',
    targetItem: 'oak_log',
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

function queueWith(current: QueuedGoal | null): GoalQueueState {
  if (current === null) return emptyGoalQueueState()
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

function worldState(overrides: {
  position: Vec3Json
  goal: GoalState
  goalQueue: GoalQueueState
  signals: AgentSignals
  inventory?: InventoryState
  blocks?: BlockState[]
  standable?: Vec3Json[]
  furnaces?: StationEntry[]
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position),
    inventory: overrides.inventory ?? inventory({}),
    entities: [],
    blocks: overrides.blocks ?? [],
    terrain: { standable: overrides.standable ?? [overrides.position] },
    craftingTables: [],
    furnaces: overrides.furnaces ?? [],
    placementSpots: [],
    goal: overrides.goal,
    goalQueue: overrides.goalQueue,
    recentEvents: [],
    signals: overrides.signals,
  }
}

function retrievalCandidate(candidates: readonly Candidate[]): Candidate | null {
  return candidates.find((candidate) => candidate.kind === 'RETRIEVE') ?? null
}

function retrieveCandidate(id: string, target: Vec3Json, surface: boolean): Candidate {
  return {
    id,
    kind: 'RETRIEVE',
    label: 'retrieve',
    targetName: surface ? null : 'oak_log',
    target,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: { tick: 7, retrieval: surface ? 'surface' : 'known', resource: 'oak_log', surface },
  }
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

// --- WAIT limit -----------------------------------------------------------------

addCase('WAIT replans on the 3rd consecutive WAIT on the same goal', () => {
  const collected: string[] = []
  let streak = 0
  let previousGoalKey: string | null = null
  for (let i = 0; i < 3; i += 1) {
    const decision = evaluateWaitWedge({
      actionId: 'WAIT',
      goalKey: 'collect:oak_log:2',
      previousGoalKey,
      streak,
      waitLimit: 3,
      replans: 0,
      replanLimit: 4,
    })
    collected.push(decision.outcome)
    streak = decision.streak
    previousGoalKey = decision.goalKey
  }
  const pass = collected.join(',') === 'below-limit,below-limit,replan'
  return { pass, detail: collected.join(',') }
})

addCase('a goal change resets the WAIT streak', () => {
  const first = evaluateWaitWedge({
    actionId: 'WAIT',
    goalKey: 'collect:oak_log:2',
    previousGoalKey: null,
    streak: 0,
    waitLimit: 3,
    replans: 0,
    replanLimit: 4,
  })
  const second = evaluateWaitWedge({
    actionId: 'WAIT',
    goalKey: 'collect:oak_log:2',
    previousGoalKey: first.goalKey,
    streak: first.streak,
    waitLimit: 3,
    replans: 0,
    replanLimit: 4,
  })
  const changed = evaluateWaitWedge({
    actionId: 'WAIT',
    goalKey: 'smelt:charcoal:1',
    previousGoalKey: second.goalKey,
    streak: second.streak,
    waitLimit: 3,
    replans: 0,
    replanLimit: 4,
  })
  const pass = changed.outcome === 'below-limit' && changed.n === 1 && changed.streak === 1
  return { pass, detail: JSON.stringify({ second: second.outcome, changed: changed.outcome, n: changed.n }) }
})

addCase('exhausted replans turn a repeated WAIT into a wedge', () => {
  const decision = evaluateWaitWedge({
    actionId: 'WAIT',
    goalKey: 'collect:oak_log:2',
    previousGoalKey: 'collect:oak_log:2',
    streak: 2,
    waitLimit: 3,
    replans: 4,
    replanLimit: 4,
  })
  return { pass: decision.outcome === 'wedge' && decision.n === 3, detail: decision.outcome }
})

// --- known-resource retrieval ---------------------------------------------------

addCase('underground log goal emits a RETRIEVE toward the remembered coordinate', () => {
  const known: KnownResource = { name: 'oak_log', kind: 'log', position: { x: 40, y: 70, z: 40 } }
  const state = worldState({
    position: { x: 0, y: 60, z: 0 },
    goal: goal({}),
    goalQueue: queueWith(queuedGoal({})),
    signals: signals({ knownResources: [known] }),
    // a placeable block makes the 10-block climb mechanically reachable; the
    // affordance gate withholds an un-climbable target (see test-reachability.mts).
    inventory: inventory({ cobblestone: 4 }),
  })
  const found = retrievalCandidate(generateCandidates(state, defaultCandidateOptions))
  const pass =
    found !== null &&
    found.meta.retrieval === 'known' &&
    found.target?.x === 40 &&
    found.target?.y === 70 &&
    found.target?.z === 40
  return { pass, detail: found === null ? 'no RETRIEVE' : `${found.id} ${JSON.stringify(found.meta)}` }
})

addCase('surface-only log goal falls back to a surface-ward RETRIEVE when nothing is remembered', () => {
  const state = worldState({
    position: { x: 0, y: 60, z: 0 },
    goal: goal({}),
    goalQueue: queueWith(queuedGoal({})),
    signals: signals(),
    // the 6-block climb needs a mechanically available ascend plan (placeable
    // block), otherwise the affordance gate withholds the surface trip.
    inventory: inventory({ cobblestone: 4 }),
    standable: [
      { x: 0, y: 60, z: 0 },
      { x: 2, y: 66, z: 0 },
    ],
  })
  const found = retrievalCandidate(generateCandidates(state, defaultCandidateOptions))
  const pass =
    found !== null &&
    found.meta.retrieval === 'surface' &&
    found.target?.y === 66 &&
    found.label.includes('surface')
  return { pass, detail: found === null ? 'no RETRIEVE' : `${found.id} target=${JSON.stringify(found.target)}` }
})

addCase('a visible log suppresses retrieval (normal mining keeps priority)', () => {
  const logBlock: BlockState = {
    kind: 'log',
    name: 'oak_log',
    position: { x: 1, y: 60, z: 0 },
    distance: 1.5,
    diggable: true,
    inReach: true,
    hasAdjacentStandable: true,
    adjacentStandable: { x: 0, y: 60, z: 0 },
    yield: 'oak_log',
    harvestTool: null,
  }
  const state = worldState({
    position: { x: 0, y: 60, z: 0 },
    goal: goal({}),
    goalQueue: queueWith(queuedGoal({})),
    signals: signals({ knownResources: [{ name: 'oak_log', kind: 'log', position: { x: 40, y: 70, z: 40 } }] }),
    blocks: [logBlock],
  })
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const pass = retrievalCandidate(candidates) === null && candidates.some((candidate) => candidate.kind === 'MINE')
  return { pass, detail: candidates.map((candidate) => candidate.id).join(',') }
})

addCase('a depleted remembered log does not trigger a retrieve loop', () => {
  const state = worldState({
    position: { x: 0, y: 60, z: 0 },
    goal: goal({}),
    goalQueue: queueWith(queuedGoal({})),
    signals: signals({ knownResources: [{ name: 'oak_log', kind: 'log', position: { x: 5, y: 60, z: 0 } }] }),
  })
  const found = retrievalCandidate(generateCandidates(state, defaultCandidateOptions))
  return { pass: found === null, detail: found === null ? 'no RETRIEVE' : found.id }
})

addCase('an underground ore goal emits a RETRIEVE toward the remembered ore coordinate', () => {
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 40, y: 59, z: 40 } }
  const oreGoal = queuedGoal({ kind: 'collect', description: 'collect 3 x raw_iron', targetItem: 'raw_iron', requiredCount: 3 })
  const state = worldState({
    position: { x: 0, y: 60, z: 0 },
    goal: goal({ targetItem: 'raw_iron', description: 'collect 3 x raw_iron', requiredCount: 3 }),
    goalQueue: queueWith(oreGoal),
    signals: signals({ knownResources: [known] }),
  })
  const found = retrievalCandidate(generateCandidates(state, defaultCandidateOptions))
  const pass = found !== null && found.meta.retrieval === 'known' && found.meta.resourceKind === 'ore'
  return { pass, detail: found === null ? 'no RETRIEVE' : `${found.id} ${JSON.stringify(found.meta)}` }
})

// --- inventory-aware fuel -------------------------------------------------------

addCase('a non-oak held log is accepted as charcoal fuel instead of waiting', () => {
  const smeltGoal = queuedGoal({ kind: 'smelt', description: 'smelt 1 x charcoal', targetItem: 'charcoal', requiredCount: 1 })
  const state = worldState({
    position: { x: 0, y: 60, z: 0 },
    goal: goal({ targetItem: 'charcoal', requiredCount: 1, description: 'smelt 1 x charcoal' }),
    goalQueue: queueWith(smeltGoal),
    signals: signals(),
    inventory: inventory({ spruce_log: 2, spruce_planks: 1 }),
    furnaces: [{ x: 1, y: 60, z: 0, source: 'sensed' }],
  })
  const smelt = generateCandidates(state, defaultCandidateOptions).find((candidate) => candidate.kind === 'SMELT')
  const fuel = smelt === undefined ? '' : String(smelt.meta.fuelItem)
  const pass = smelt !== undefined && (fuel.endsWith('_log') || fuel.endsWith('_planks'))
  return { pass, detail: smelt === undefined ? 'no SMELT' : `fuel=${fuel} input=${String(smelt.meta.inputItem)}` }
})

// --- guard grounding ------------------------------------------------------------

addCase('the guard accepts a retrieval grounded in knownResources', () => {
  const known: KnownResource = { name: 'oak_log', kind: 'log', position: { x: 40, y: 70, z: 40 } }
  const state = worldState({
    position: { x: 0, y: 60, z: 0 },
    goal: goal({}),
    goalQueue: queueWith(queuedGoal({})),
    signals: signals({ knownResources: [known] }),
  })
  const candidate = retrieveCandidate('RETRIEVE:known:oak_log:b40_70_40', known.position, false)
  const result = guardCandidate(candidate, state, guardContext([candidate.id]))
  return { pass: result.ok, detail: result.ok ? 'accepted' : result.code }
})

addCase('the guard rejects a retrieval whose coordinate is not remembered', () => {
  const known: KnownResource = { name: 'oak_log', kind: 'log', position: { x: 40, y: 70, z: 40 } }
  const state = worldState({
    position: { x: 0, y: 60, z: 0 },
    goal: goal({}),
    goalQueue: queueWith(queuedGoal({})),
    signals: signals({ knownResources: [known] }),
  })
  const candidate = retrieveCandidate('RETRIEVE:known:oak_log:b99_70_99', { x: 99, y: 70, z: 99 }, false)
  const result = guardCandidate(candidate, state, guardContext([candidate.id]))
  return { pass: !result.ok && result.code === 'TARGET_GONE', detail: result.ok ? 'accepted' : result.code }
})

let failures = 0
process.stdout.write('issue #43 - WAIT limit and known-resource retrieval\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} issue #43 cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
