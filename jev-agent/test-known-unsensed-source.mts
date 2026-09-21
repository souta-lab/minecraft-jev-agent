// test-known-unsensed-source.mts - regression fixture for the #339 follow-up the
// owner recorded on main: a source DECLARED in a static scan table
// (`state.ts#DIRECT_BLOCK_SOURCES.flint = ['gravel']`) was treated as a usable
// route even when the world offered neither a sensed source block nor a
// remembered coordinate.
//
// Live freeze (source d428d1c + merged #341 fix, m3-live):
//
//   HEARTBEAT pos=120.8,67.0,-9.3 (frozen) rung=nether_portal queue=collect 1 x flint (from gravel)
//   CANDIDATE_STARVATION presented=1 productive=0 goal=collect:flint:1 blockedBy=no_productive_action
//   gravel has never been sensed; flint=0
//
// In the fixture shape (a safe descent step available) the focused pool is empty
// and `descendCandidates` emitted one blind level DESCEND purely because
// `scannedBlockNames('flint')` is defined. That lone non-advancing candidate made
// `candidates.length !== 0`, so the #339 multi-cell exploration fallback never
// fired and Jev saw `DESCEND + WAIT`.
//
// This fixture pins the fixed contract:
//
//   (a) flint, no sensed gravel, no remembered gravel, several frontier cells
//       -> >= 3 DISTINCT actionable candidates (grounded exploration), not a
//          WAIT-only or single-action set;
//   (b) flint, a sensed gravel block -> the MINE is offered and the set is not
//       exploration-only (a sensed source still mines);
//   (c) flint, a remembered gravel coordinate -> the RETRIEVE is offered (a
//       remembered coordinate still retrieves);
//   (d) raw_iron (an ORE source) with a sensed/no-sensed mix is unchanged: a
//       sensed ore MINEs, a remembered ore RETRIEVEs, and an ore goal with no
//       world evidence keeps its historical DESCEND (ores generate underground,
//       so a blind DESCEND is a grounded search for them, not a static-table
//       claim).
//
// Enumeration only: the fix never removes or ranks the DESCEND; it stops a
// static-table declaration from hiding the grounded alternatives.
//
// Run: bun test ./test-known-unsensed-source.mts
import { createRequire } from 'node:module'
import { createRecipeIndex } from './src/crafting.ts'
import { blockId, defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import type {
  BlockState,
  GoalState,
  InventoryState,
  KnownResource,
  SelfState,
  Vec3Json,
  WorldState,
} from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'

const require = createRequire(import.meta.url)
const RECIPES = createRecipeIndex(require('minecraft-data')('1.21.11') as unknown)

const SELF: Vec3Json = { x: 0.5, y: 61, z: 0.5 }
/** The remembered gravel cell for the RETRIEVE case (level, walkable). */
const GRAVEL_CELL: Vec3Json = { x: 9, y: 61, z: -4 }
/** The remembered iron-ore cell for the raw_iron RETRIEVE case (level, walkable). */
const IRON_CELL: Vec3Json = { x: 9, y: 61, z: -10 }

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

function selfState(position: Vec3Json): SelfState {
  return {
    username: 'AI_M3UNSENSED',
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

function goalState(targetItem: string, description: string): GoalState {
  return {
    id: `collect:${targetItem}`,
    description,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(kind: QueuedGoal['kind'], targetItem: string, description: string): QueuedGoal {
  return {
    id: `g1:${kind}:${targetItem}`,
    kind,
    description,
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

function queue(goal: QueuedGoal): GoalQueueState {
  return { depth: 1, current: goal, empty: false, hasImpossible: false, done: 0, goals: [goal] }
}

/**
 * A sensed scanned-source block exactly as `state.ts#buildScannedResourceBlocks`
 * emits it: `kind: 'ore'`, the REAL block name, and the REAL primary drop from
 * `resolveHarvest` (gravel drops gravel; flint is only a probabilistic drop).
 */
function sourceBlock(
  name: string,
  position: Vec3Json,
  yieldItem: string,
  harvestTool: BlockState['harvestTool'] = null,
  harvestTier: number | null = null,
): BlockState {
  return {
    kind: 'ore',
    name,
    position,
    distance: 1.5,
    diggable: true,
    inReach: true,
    hasAdjacentStandable: true,
    adjacentStandable: { x: position.x, y: position.y - 1, z: position.z },
    yield: yieldItem,
    harvestTool,
    harvestTier,
    visible: true,
  }
}

/** One safe level tunnel step, the shape the sensor's `state.descent` carries. */
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

/** Several distinct grounded frontier cells so exploration stays non-degenerate. */
const FRONTIER: Vec3Json[] = [
  SELF,
  { x: 3, y: 61, z: 0 },
  { x: 0, y: 61, z: 3 },
  { x: -3, y: 61, z: 0 },
  { x: 0, y: 61, z: -3 },
  { x: 3, y: 61, z: 3 },
]

function build(input: {
  kind?: QueuedGoal['kind']
  focus: string
  description?: string
  blocks?: BlockState[]
  known?: KnownResource[]
  frontier?: boolean
  withDescent?: boolean
}): WorldState {
  const kind = input.kind ?? 'collect'
  const description = input.description ?? `collect 1 x ${input.focus}`
  const inventory: InventoryState = { slots: [], counts: { wooden_pickaxe: 1 }, totalItems: 1 }
  const state: WorldState = {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: selfState(SELF),
    inventory,
    entities: [],
    blocks: input.blocks ?? [],
    terrain: { standable: input.frontier === false ? [SELF] : FRONTIER },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goalState(input.focus, description),
    goalQueue: queue(queuedGoal(kind, input.focus, description)),
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
      knownResources: input.known ?? [],
    },
  }
  if (input.withDescent === true) state.descent = [descentStep()]
  return state
}

const OPTIONS = { ...defaultCandidateOptions, recipes: RECIPES }

const ids = (candidates: readonly Candidate[]): string => `[${candidates.map((candidate) => candidate.id).join(' ')}]`

/** Actionable = everything Jev can pick that is not the explicit WAIT no-op. */
function actionable(state: WorldState): Candidate[] {
  return generateGroundedCandidates(state, OPTIONS).candidates.filter((candidate) => candidate.kind !== 'WAIT')
}

function isExploration(candidate: Candidate): boolean {
  return candidate.kind === 'MOVE' && candidate.targetName === null && candidate.itemName === null
}

// --- (a) declared-but-unsensed flint source defers to grounded exploration ------

addCase('(a) flint with no sensed/remembered gravel presents >=3 distinct grounded actions', () => {
  const state = build({ focus: 'flint', description: 'collect 1 x flint (from gravel)', withDescent: true })
  const all = actionable(state)
  const distinct = new Set(all.map((candidate) => candidate.id))
  const exploration = all.filter(isExploration)
  return {
    pass: all.length >= 3 && distinct.size === all.length && exploration.length >= 2,
    detail: `actionable=${all.length} distinct=${distinct.size} exploration=${exploration.length} ids=${ids(all)}`,
  }
})

addCase('(a) the declared-but-unsensed flint set offers no RETRIEVE and no invented MINE', () => {
  const state = build({ focus: 'flint', description: 'collect 1 x flint (from gravel)', withDescent: true })
  const all = actionable(state)
  return {
    pass: !all.some((candidate) => candidate.kind === 'RETRIEVE' || candidate.kind === 'MINE'),
    detail: `ids=${ids(all)}`,
  }
})

addCase('(a) a remembered stone level below does not re-hide the flint exploration fallback', () => {
  // Live shape: the body has tunnelled, so `signals.knownStoneY` is set below the
  // feet. A remembered STONE level is not a remembered GRAVEL coordinate, so it
  // must not make the blind DESCEND count as a route for the flint goal.
  const state = build({ focus: 'flint', description: 'collect 1 x flint (from gravel)', withDescent: true })
  state.signals.knownStoneY = 40
  const all = actionable(state)
  return {
    pass: all.length >= 3 && all.some(isExploration),
    detail: `actionable=${all.length} exploration=${all.filter(isExploration).length} ids=${ids(all)}`,
  }
})

// --- (b) a sensed source still mines -------------------------------------------

addCase('(b) a sensed gravel block yields the MINE for the flint goal', () => {
  // The real sensor shape: gravel's drop is `gravel`, not `flint`.
  const state = build({
    focus: 'flint',
    description: 'collect 1 x flint (from gravel)',
    blocks: [sourceBlock('gravel', { x: 1, y: 61, z: 0 }, 'gravel')],
    withDescent: true,
  })
  const grounded = generateGroundedCandidates(state, OPTIONS)
  const mine = grounded.candidates.find((candidate) => candidate.kind === 'MINE')
  return {
    pass: mine !== undefined && mine.targetName === 'gravel' && mine.target !== null,
    detail: `mine=${mine?.id ?? 'none'} presented=${ids(grounded.candidates)} withheld=${ids(grounded.withheld.map((entry) => entry.candidate))}`,
  }
})

addCase('(b) the sensed-gravel MINE is not exploration-only', () => {
  const state = build({
    focus: 'flint',
    description: 'collect 1 x flint (from gravel)',
    blocks: [sourceBlock('gravel', { x: 1, y: 61, z: 0 }, 'gravel')],
    withDescent: true,
  })
  const all = actionable(state)
  return {
    pass: all.some((candidate) => candidate.kind === 'MINE') && !all.some(isExploration),
    detail: `ids=${ids(all)}`,
  }
})

addCase('(b) a sensed mineable source suppresses the redundant remembered-gravel RETRIEVE', () => {
  const state = build({
    focus: 'flint',
    description: 'collect 1 x flint (from gravel)',
    blocks: [sourceBlock('gravel', { x: 1, y: 61, z: 0 }, 'gravel')],
    known: [{ name: 'gravel', kind: 'ore', position: GRAVEL_CELL, dimension: 'overworld', worldEpoch: 1 }],
    withDescent: true,
  })
  const all = actionable(state)
  return {
    pass: all.some((candidate) => candidate.kind === 'MINE') && !all.some((candidate) => candidate.kind === 'RETRIEVE'),
    detail: `ids=${ids(all)}`,
  }
})

// --- (c) a remembered coordinate still retrieves --------------------------------

addCase('(c) a remembered gravel coordinate yields the flint RETRIEVE', () => {
  const state = build({
    focus: 'flint',
    description: 'collect 1 x flint (from gravel)',
    known: [{ name: 'gravel', kind: 'ore', position: GRAVEL_CELL, dimension: 'overworld', worldEpoch: 1 }],
    withDescent: true,
  })
  const all = actionable(state)
  const retrieveId = `RETRIEVE:known:flint:${blockId('b', GRAVEL_CELL)}`
  return {
    pass: all.some((candidate) => candidate.id === retrieveId) && !all.some(isExploration),
    detail: `retrieve=${retrieveId} present=${all.some((candidate) => candidate.id === retrieveId)} ids=${ids(all)}`,
  }
})

// --- (d) an ORE source keeps its historical behaviour ---------------------------

addCase('(d) raw_iron still mines a sensed iron_ore and is not exploration-only', () => {
  const state = build({
    focus: 'raw_iron',
    blocks: [
      sourceBlock('iron_ore', { x: 1, y: 61, z: 0 }, 'raw_iron', 'pickaxe', 0),
      // A sensed stone block the focused pool must ignore.
      sourceBlock('stone', { x: 5, y: 61, z: 5 }, 'cobblestone', 'pickaxe', 0),
    ],
    withDescent: true,
  })
  const all = actionable(state)
  const mine = all.find((candidate) => candidate.kind === 'MINE')
  return {
    pass: mine !== undefined && mine.targetName === 'iron_ore' && !all.some(isExploration),
    detail: `mine=${mine?.id ?? 'none'} ids=${ids(all)}`,
  }
})

addCase('(d) raw_iron still retrieves a remembered ore coordinate', () => {
  const state = build({
    focus: 'raw_iron',
    known: [{ name: 'iron_ore', kind: 'ore', position: IRON_CELL, dimension: 'overworld', worldEpoch: 1 }],
    withDescent: true,
  })
  const all = actionable(state)
  const retrieveId = `RETRIEVE:known:raw_iron:${blockId('b', IRON_CELL)}`
  return {
    pass: all.some((candidate) => candidate.id === retrieveId) && !all.some(isExploration),
    detail: `retrieve=${retrieveId} ids=${ids(all)}`,
  }
})

addCase('(d) an unsensed ore goal keeps its historical blind DESCEND and no exploration', () => {
  // An ore source generates underground, so a blind DESCEND is a grounded search
  // for it even with no sensed block. The #339 fallback widening is scoped to
  // direct (non-ore) sources and must not change this.
  const state = build({ focus: 'raw_iron', withDescent: true })
  const all = actionable(state)
  return {
    pass: all.length === 1 && all[0]!.kind === 'DESCEND' && !all.some(isExploration),
    detail: `ids=${ids(all)}`,
  }
})

// --- never regress to WAIT-only -------------------------------------------------

addCase('(a) a flint goal with frontier cells never collapses to WAIT-only', () => {
  const state = build({ focus: 'flint', description: 'collect 1 x flint (from gravel)', withDescent: false })
  const grounded = generateGroundedCandidates(state, OPTIONS)
  const all = grounded.candidates.filter((candidate) => candidate.kind !== 'WAIT')
  return {
    pass: all.length >= 3,
    detail: `actionable=${all.length} ids=${ids(all)}`,
  }
})

let failures = 0
process.stdout.write('known-but-unsensed source: declared source is not a route\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} known-unsensed-source cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
