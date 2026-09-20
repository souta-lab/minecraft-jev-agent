// test-candidate-policy.mts - M2 heuristic audit: the candidate generator's
// retry limits are explicit fields of the `CandidateOptions` policy struct
// (moveFailureLimit=4, descendFailureLimit=3, placeSpotRetryLimit=2) instead of
// inline module constants, and the generator honors the configured value.
//
//   npm run candidate-policy-test
import { blockId, defaultCandidateOptions, generateCandidates, restrictCandidatesDuringImmediateThreat } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import type { AgentSignals, GoalState, InventoryState, SelfState, Vec3Json, WorldState } from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const SELF: Vec3Json = { x: 0.5, y: 10, z: 0.5 }
const EXPLORE_SPOT: Vec3Json = { x: 3, y: 10, z: 0 }

function selfState(position: Vec3Json): SelfState {
  return {
    username: 'AI_M2POL',
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

function goalState(): GoalState {
  return {
    id: 'collect:diamond',
    description: 'collect 1 x diamond',
    targetItem: 'diamond',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(): QueuedGoal {
  return {
    id: 'g1:collect:diamond',
    kind: 'collect',
    description: 'collect 1 x diamond',
    targetItem: 'diamond',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function queue(): GoalQueueState {
  const goal = queuedGoal()
  return { depth: 1, current: goal, empty: false, hasImpossible: false, done: 0, goals: [goal] }
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

function exploreState(failures: number): WorldState {
  const inventory: InventoryState = { slots: [], counts: {}, totalItems: 0 }
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: selfState(SELF),
    inventory,
    entities: [],
    blocks: [],
    terrain: { standable: [SELF, EXPLORE_SPOT] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goalState(),
    goalQueue: queue(),
    recentEvents: [],
    signals: signals({ failedCandidates: { [`MOVE:${blockId('p', EXPLORE_SPOT)}`]: failures } }),
  }
}

const moveIds = (state: WorldState, options = defaultCandidateOptions): string[] =>
  generateCandidates(state, options)
    .filter((candidate) => candidate.kind === 'MOVE')
    .map((candidate) => candidate.id)

function policyCandidate(id: string): Candidate {
  return {
    id,
    kind: 'MINE',
    label: `candidate ${id}`,
    targetName: 'dirt',
    target: { x: 0, y: 10, z: 0 },
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 1 },
  }
}

addCase('the generator policy struct carries the audited retry budgets explicitly', () => {
  const pass =
    defaultCandidateOptions.moveFailureLimit === 4 &&
    defaultCandidateOptions.descendFailureLimit === 3 &&
    defaultCandidateOptions.placeSpotRetryLimit === 2
  return {
    pass,
    detail: `move=${defaultCandidateOptions.moveFailureLimit} descend=${defaultCandidateOptions.descendFailureLimit} placeSpot=${defaultCandidateOptions.placeSpotRetryLimit}`,
  }
})

addCase('a spot with 2 failures is still offered under the default MOVE budget (4)', () => {
  const ids = moveIds(exploreState(2))
  const pass = ids.includes(`MOVE:${blockId('p', EXPLORE_SPOT)}`)
  return { pass, detail: `moveIds=[${ids.join(',')}]` }
})

addCase('the configured MOVE budget suppresses the same spot when set to 2', () => {
  const ids = moveIds(exploreState(2), { ...defaultCandidateOptions, moveFailureLimit: 2 })
  const pass = !ids.includes(`MOVE:${blockId('p', EXPLORE_SPOT)}`)
  return { pass, detail: `moveIds=[${ids.join(',')}]` }
})

addCase('an immediate hostile threat removes work actions but leaves Jev ATTACK/RETREAT authority', () => {
  const work: Candidate = { ...policyCandidate('MINE:work'), kind: 'MINE', label: 'mine unrelated dirt' }
  const attack: Candidate = { ...policyCandidate('ATTACK:e1'), kind: 'ATTACK', targetEntityId: 1, label: 'attack zombie' }
  const retreat: Candidate = { ...policyCandidate('RETREAT:p1'), kind: 'RETREAT', label: 'retreat to safety' }
  const kept = restrictCandidatesDuringImmediateThreat(
    { entities: [{ hostile: true, distance: 0.7 }] } as never,
    [work, attack, retreat],
  )
  const ids = kept.map((entry) => entry.id)
  const pass = ids.join('|') === 'ATTACK:e1|RETREAT:p1'
  return { pass, detail: `kept=[${ids.join(',')}]` }
})

let failures = 0
process.stdout.write('M2 heuristic audit - candidate retry policy is an explicit struct\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} candidate-policy cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
