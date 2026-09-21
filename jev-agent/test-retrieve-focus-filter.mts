// test-retrieve-focus-filter.mts - slice 1: a known-resource RETRIEVE must not
// advance an item the ACTIVE focus does not need.
//
// Live defect (source 449cedd, m3-live): the active goal was
// `planId=g3:collect:flint`, but Jev kept selecting remembered-coordinate trips
// for other items:
//
//   last 20 chosen: RETRIEVE:known:raw_iron x9, DESCEND x7, RETRIEVE:known:obsidian x4
//   ACTION n=661 RETRIEVE:known:obsidian:b28_67_9 phase=pillaring   (obsidian y=67 -> pillars UP)
//   ACTION n=662 DESCEND:level:E:b124_67_-10 phase=digging
//   y: 64.2 -> 60.0 -> 65.0
//
// Every descent that could reach gravel was undone by a retrieval for an item the
// flint goal does not need, so flint stayed 0 and gravel was never sensed.
//
// Root cause (code path): `generateRawCandidates` -> `retrievalCandidates` walks
// `retrievalNeeds`, which is [active focus, `state.goal.targetItem`, ...queued].
// The focused need (`flint` -> scanned source `gravel`) has no remembered cell,
// so the loop fell through to the mission-level/queued need and offered
// `RETRIEVE:known:obsidian`. The MINE arm already had a CAN-only focus filter
// (`mineDropAdvancesFocus`, #339); the RETRIEVE arm had none.
//
// The fix reuses that exact predicate: a remembered trip is WITHHELD when it
// provably cannot advance the active focus. Withholding only - no ranking, no
// reordering - and class / null focuses keep the historical behaviour.
//
// Run: bun test ./test-retrieve-focus-filter.mts
import { createRequire } from 'node:module'
import { createRecipeIndex } from './src/crafting.ts'
import { defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import type { GoalState, InventoryState, KnownResource, SelfState, Vec3Json, WorldState } from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'

const require = createRequire(import.meta.url)
const RECIPES = createRecipeIndex(require('minecraft-data')('1.21.11') as unknown)

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const SELF: Vec3Json = { x: 0.5, y: 61, z: 0.5 }
/** The live obsidian cell (m3-live, b28_67_9): above the bot, hence `pillaring`. */
const OBSIDIAN_CELL: Vec3Json = { x: 28, y: 67, z: 9 }

function selfState(position: Vec3Json = SELF): SelfState {
  return {
    username: 'AI_RETRFOCUS',
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

function goalState(targetItem: string): GoalState {
  return {
    id: `collect:${targetItem}`,
    description: targetItem.length === 0 ? 'objective:advance the ladder' : `collect 1 x ${targetItem}`,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(targetItem: string | null): QueuedGoal {
  return {
    id: `g3:collect:${targetItem ?? 'none'}`,
    kind: 'collect',
    description: targetItem === null ? 'objective:advance the ladder' : `collect 1 x ${targetItem}`,
    targetItem,
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

function queue(goals: QueuedGoal[]): GoalQueueState {
  const current = goals[0] ?? null
  return { depth: goals.length, current, empty: current === null, hasImpossible: false, done: 0, goals }
}

/** One safe level tunnel step: the descending/search alternative a withholder must keep. */
function descentStep(): NonNullable<WorldState['descent']>[number] {
  return {
    dir: 'W',
    mode: 'level',
    dx: -1,
    dz: 0,
    step: { x: 0, y: 61, z: 0 },
    wall: { x: 0, y: 61, z: 0 },
    head: { x: 0, y: 62, z: 0 },
    floor: { x: 0, y: 60, z: 0 },
    wallSolid: true,
    headSolid: false,
    floorSolid: true,
    safe: true,
    reason: 'safe',
    digName: 'stone',
    diggable: true,
    digHarvestTool: 'pickaxe',
    digHarvestTier: 0,
  }
}

const FRONTIER: Vec3Json[] = [
  SELF,
  { x: 3, y: 61, z: 0 },
  { x: 0, y: 61, z: 3 },
  { x: -3, y: 61, z: 0 },
  { x: 0, y: 61, z: -3 },
]

function build(input: {
  current: QueuedGoal
  goalTarget: string
  known: KnownResource[]
  goals?: QueuedGoal[]
  withDescent?: boolean
}): WorldState {
  const inventory: InventoryState = { slots: [], counts: {}, totalItems: 0 }
  const state: WorldState = {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: selfState(),
    inventory,
    entities: [],
    blocks: [],
    terrain: { standable: FRONTIER },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goalState(input.goalTarget),
    goalQueue: queue(input.goals ?? [input.current]),
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
      knownResources: input.known,
    },
  }
  if (input.withDescent === true) state.descent = [descentStep()]
  return state
}

const OPTIONS = {
  ...defaultCandidateOptions,
  recipes: RECIPES,
  reachability: { memory: null, pathProbe: () => 'reachable' as const },
}

function offered(state: WorldState): Candidate[] {
  const grounded = generateGroundedCandidates(state, OPTIONS)
  return [...grounded.candidates, ...grounded.withheld.map((entry) => entry.candidate)]
}

const ids = (candidates: readonly Candidate[]): string => `[${candidates.map((c) => c.id).join(' ')}]`
const retrievalId = (item: string, position: Vec3Json): string =>
  `RETRIEVE:known:${item}:b${position.x}_${position.y}_${position.z}`

// (a) `collect flint` with a remembered obsidian site: no obsidian trip, and the
// DESCEND/search alternatives that can reach gravel remain.
addCase('(a) collect flint withholds the remembered obsidian RETRIEVE, keeps the search routes', () => {
  const state = build({
    current: queuedGoal('flint'),
    // Live shape: the active subgoal is flint while the mission target is obsidian.
    goalTarget: 'obsidian',
    known: [{ name: 'obsidian', kind: 'ore', position: OBSIDIAN_CELL }],
    withDescent: true,
  })
  const all = offered(state)
  const obsidianRoute = all.find((candidate) => candidate.id === retrievalId('obsidian', OBSIDIAN_CELL))
  const alternatives = all.filter((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'RETRIEVE')
  return {
    pass: obsidianRoute === undefined && alternatives.length > 0,
    detail: `obsidianRoute=${obsidianRoute?.id ?? 'none'} alternatives=${ids(alternatives)}`,
  }
})

// (b) `collect obsidian` (the portal step) keeps its own remembered trip.
addCase('(b) collect obsidian still offers the remembered obsidian RETRIEVE', () => {
  const state = build({
    current: queuedGoal('obsidian'),
    goalTarget: 'obsidian',
    known: [{ name: 'obsidian', kind: 'ore', position: OBSIDIAN_CELL }],
  })
  const route = offered(state).find((candidate) => candidate.id === retrievalId('obsidian', OBSIDIAN_CELL))
  return {
    pass: route !== undefined,
    detail: `route=${route?.id ?? 'none'} offered=${ids(offered(state))}`,
  }
})

// A recipe relation does not grant a FUTURE queue sibling authority over the
// active row. Dependency expansion must make `blaze_rod` active explicitly
// before its remembered route can enter pi.
addCase('(c) recipe-related future work does not cross the active queue boundary', () => {
  const current = queuedGoal('ender_eye')
  const future = { ...queuedGoal('blaze_rod'), id: 'g4:collect:blaze_rod', status: 'pending' as const }
  const state = build({
    current,
    goalTarget: 'ender_eye',
    known: [{ name: 'nether_bricks', kind: 'ore', position: { x: 90, y: 62, z: 40 } }],
    goals: [current, future],
  })
  const route = offered(state).find((candidate) => candidate.kind === 'RETRIEVE')
  return {
    pass: route === undefined,
    detail: `route=${route?.id ?? 'none'} offered=${ids(offered(state))}`,
  }
})

// Resource-class focus is not a license to execute arbitrary future work.
addCase('(d) resource-class focus does not admit a future obsidian RETRIEVE', () => {
  const logGoal = queuedGoal('log')
  const future = { ...queuedGoal('obsidian'), id: 'g4:collect:obsidian', status: 'pending' as const }
  const state = build({
    current: logGoal,
    goalTarget: 'log',
    known: [{ name: 'obsidian', kind: 'ore', position: OBSIDIAN_CELL }],
    goals: [logGoal, future],
  })
  const route = offered(state).find((candidate) => candidate.id === retrievalId('obsidian', OBSIDIAN_CELL))
  return {
    pass: route === undefined,
    detail: `route=${route?.id ?? 'none'} offered=${ids(offered(state))}`,
  }
})

let failures = 0
process.stdout.write('known-resource RETRIEVE feasibility filter (active-focus withholding)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} retrieve-focus cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
