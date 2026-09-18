// test-candidate-policy.mts - M2 heuristic audit: the candidate generator's
// retry limits are explicit fields of the `CandidateOptions` policy struct
// (moveFailureLimit=4, descendFailureLimit=3, placeSpotRetryLimit=2) instead of
// inline module constants, and the generator honors the configured value.
//
//   npm run candidate-policy-test
import { applyOptionSkillGate, blockId, defaultCandidateOptions, generateCandidates } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { logCandidates } from './src/decisionlog.ts'
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

function candidate(id: string, kind: Candidate['kind'], meta: Candidate['meta'] = {}): Candidate {
  return {
    id,
    kind,
    label: id,
    targetName: null,
    target: null,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta,
  }
}

function stateWithOption(kind: QueuedGoal['kind'], strategy?: QueuedGoal['strategy']): WorldState {
  const base = exploreState(0)
  const current = { ...base.goalQueue.current!, kind, ...(strategy === undefined ? {} : { strategy }) }
  return {
    ...base,
    goalQueue: { ...base.goalQueue, current, goals: [current] },
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

addCase('#56: compiler-disabled candidate generation is byte-compatible by id', () => {
  const source = [candidate('CRAFT:table', 'CRAFT'), candidate('SMELT:iron_ingot', 'SMELT'), candidate('WAIT', 'WAIT')]
  const scoped = applyOptionSkillGate(source, exploreState(0), null)
  const pass = scoped.map((entry) => entry.id).join('|') === source.map((entry) => entry.id).join('|') && scoped.every((entry) => entry.meta.optionSkill === undefined)
  return { pass, detail: `ids=[${scoped.map((entry) => entry.id).join(',')}]` }
})

addCase('#56: the integrated generator applies the active Option skill gate before affordance checks', () => {
  const branch = generateCandidates(exploreState(0), { ...defaultCandidateOptions, allowedSkills: ['BRANCH_MINE'] })
  const knownOnly = generateCandidates(exploreState(0), { ...defaultCandidateOptions, allowedSkills: ['RETURN_TO_KNOWN_ORE'] })
  const branchMove = branch.find((entry) => entry.kind === 'MOVE')
  const pass =
    branchMove?.meta.optionSkill === 'BRANCH_MINE' &&
    knownOnly.every((entry) => entry.kind !== 'MOVE') &&
    knownOnly.some((entry) => entry.kind === 'WAIT')
  return { pass, detail: `branch=[${branch.map((entry) => entry.id).join(',')}] knownOnly=[${knownOnly.map((entry) => entry.id).join(',')}]` }
})

addCase('#56: the collect Option keeps only its grounded skills plus control', () => {
  const state = stateWithOption('collect')
  const source = [
    candidate('MINE:b1_10_1', 'MINE'),
    candidate('RETRIEVE:known:iron_ore:b9_5_9', 'RETRIEVE'),
    candidate('CRAFT:wooden_pickaxe', 'CRAFT'),
    candidate('WAIT', 'WAIT'),
  ]
  const scoped = applyOptionSkillGate(source, state, ['BRANCH_MINE', 'RETURN_TO_KNOWN_ORE'])
  const pass =
    scoped.map((entry) => entry.id).join('|') === 'MINE:b1_10_1|RETRIEVE:known:iron_ore:b9_5_9|WAIT' &&
    scoped[0]?.meta.optionSkill === 'BRANCH_MINE' &&
    scoped[1]?.meta.optionSkill === 'RETURN_TO_KNOWN_ORE' &&
    scoped[2]?.meta.optionSkill === 'CONTROL'
  return { pass, detail: scoped.map((entry) => `${entry.id}:${String(entry.meta.optionSkill)}`).join(',') }
})

addCase('#56: parent craft skills retain deterministic station prerequisites', () => {
  const state = stateWithOption('craft')
  const source = [
    candidate('CRAFT:wooden_pickaxe', 'CRAFT'),
    candidate('PLACE:crafting_table:p1_10_1', 'PLACE', { prereqPath: 'craft_and_place' }),
    candidate('SMELT:iron_ingot', 'SMELT'),
    candidate('WAIT', 'WAIT'),
  ]
  const scoped = applyOptionSkillGate(source, state, ['CRAFT_AT_STATION'])
  const pass =
    scoped.map((entry) => entry.id).join('|') === 'CRAFT:wooden_pickaxe|PLACE:crafting_table:p1_10_1|WAIT' &&
    scoped[0]?.meta.optionSkill === 'CRAFT_AT_STATION' &&
    scoped[1]?.meta.optionSkill === 'PREREQUISITE' &&
    logCandidates(scoped, {})[1]?.optionSkill === 'PREREQUISITE'
  return { pass, detail: scoped.map((entry) => `${entry.id}:${String(entry.meta.optionSkill)}`).join(',') }
})

addCase('#56: strategy prefixes are attributed to the exact Option skill', () => {
  const branchState = stateWithOption('collect', 'branch_mine')
  const branch = applyOptionSkillGate(
    [candidate('BRANCH_MINE:MINE:b1_10_1', 'MINE'), candidate('MINE:b2_10_2', 'MINE'), candidate('WAIT', 'WAIT')],
    branchState,
    ['BRANCH_MINE'],
  )
  const caveState = stateWithOption('collect', 'explore_cave')
  const cave = applyOptionSkillGate(
    [candidate('EXPLORE_CAVE:p3_10_0', 'MOVE'), candidate('MOVE:p4_10_0', 'MOVE'), candidate('WAIT', 'WAIT')],
    caveState,
    ['EXPLORE_CAVE_FRONTIER'],
  )
  const pass =
    branch.map((entry) => entry.id).join('|') === 'BRANCH_MINE:MINE:b1_10_1|MINE:b2_10_2|WAIT' &&
    branch[0]?.meta.optionSkill === 'BRANCH_MINE' &&
    cave.map((entry) => entry.id).join('|') === 'EXPLORE_CAVE:p3_10_0|WAIT' &&
    cave[0]?.meta.optionSkill === 'EXPLORE_CAVE_FRONTIER'
  return {
    pass,
    detail: `branch=[${branch.map((entry) => entry.id).join(',')}] cave=[${cave.map((entry) => entry.id).join(',')}]`,
  }
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
