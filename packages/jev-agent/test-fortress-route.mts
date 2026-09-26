// test-fortress-route.mts - M3 Nether-fortress structure route.
//
// #342 senses Nether-fortress fabric (`nether_bricks` / `_fence` / `_stairs`,
// `NETHER_STRUCTURE_BLOCK_NAMES`) and the host durably remembers a
// `nether_fortress` site. The candidate layer had no STRUCTURE concept:
// `retrievalWant` classified every name-scanned source as `ore`, so a
// `blaze_rod` goal's route to the remembered fortress was an ordinary ore trip
// and its kind was indistinguishable from an ore coordinate.
//
// A `blaze_rod` want is now typed `structure` and matches the durable site cell
// by `scannedBlockNames(focusItem)` (the Nether structure-fabric names). The
// body is offered `RETRIEVE:known:blaze_rod:<cell>` while the blaze kill / rod
// pickup stay in the existing combat/pickup machinery. This is route/CAN only:
// `nether_bricks` is NOT made to yield `blaze_rod` (`resourceMatches` stays
// exact), so no MINE is invented, and a sensed fortress body block cannot
// suppress the remembered-site route.
//
// The durable-site -> known-resource projection and the `KnownResource.kind`
// union live in files owned by other lanes (`buddy-driver/generation-entry.ts`,
// `jev-agent/src/state.ts`); this fixture feeds the documented envelope shape
// directly. The candidate-layer match is deliberately kind-agnostic by name, so
// it serves both the projected `structure` anchor and the `nether_bricks` cells
// #342 records as `ore`; dimension re-anchoring is what keeps an overworld
// sighting out.
//
// Run: bun test ./test-fortress-route.mts
import { createRequire } from 'node:module'
import { createRecipeIndex } from './src/crafting.ts'
import { defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import type { BlockState, GoalState, InventoryState, KnownResource, SelfState, Vec3Json, WorldState } from './src/state.ts'
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
/** The Nether fortress body cell a durable site would be projected from. */
const FORTRESS_CELL: Vec3Json = { x: 60, y: 62, z: 35 }

function selfState(dimension: string, position: Vec3Json = SELF): SelfState {
  return {
    username: 'AI_FORTRESS',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension,
    isDay: true,
    heldItem: null,
  }
}

function goalState(targetItem: string): GoalState {
  return {
    id: `collect:${targetItem}`,
    description: `collect 1 x ${targetItem}`,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(
  targetItem: string,
  strategy?: QueuedGoal['strategy'],
): QueuedGoal {
  return {
    id: `g3:collect:${targetItem}`,
    kind: 'collect',
    description: `collect 1 x ${targetItem}`,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
    ...(strategy === undefined ? {} : { strategy }),
  }
}

function queue(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

/**
 * The durable-site projection the host performs at injection: a
 * `KnownStructureSiteJson` (x,y,z,kind:'nether_fortress',dimension,worldEpoch)
 * becomes a known-resource entry named after the Nether structure fabric.
 */
function structureSite(position: Vec3Json, dimension: string, worldEpoch = 1): KnownResource {
  return {
    name: 'nether_bricks',
    kind: 'structure',
    position,
    dimension,
    worldEpoch,
  } as unknown as KnownResource
}

/** A sensed nether_bricks block, the shape #342 puts into `state.blocks`. */
function sensedBody(position: Vec3Json): BlockState {
  return {
    kind: 'ore',
    name: 'nether_bricks',
    position,
    distance: 1.5,
    diggable: true,
    inReach: true,
    hasAdjacentStandable: true,
    adjacentStandable: { x: position.x, y: position.y - 1, z: position.z },
    yield: 'nether_bricks',
    harvestTool: 'pickaxe',
    harvestTier: 4,
    visible: true,
  }
}

/** One safe level tunnel step for DEPTH-preserving exploration. */
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

/** Distinct frontier cells so exploration alternatives stay non-degenerate. */
const FRONTIER: Vec3Json[] = [
  SELF,
  { x: 3, y: 61, z: 0 },
  { x: 0, y: 61, z: 3 },
  { x: -3, y: 61, z: 0 },
  { x: 0, y: 61, z: -3 },
  { x: 3, y: 61, z: 3 },
]

function build(input: {
  dimension: string
  current: QueuedGoal
  known: KnownResource[]
  blocks?: BlockState[]
  withDescent?: boolean
}): WorldState {
  const inventory: InventoryState = { slots: [], counts: { diamond_pickaxe: 1 }, totalItems: 1 }
  const state: WorldState = {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: selfState(input.dimension),
    inventory,
    entities: [],
    blocks: input.blocks ?? [],
    terrain: { standable: FRONTIER },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goalState('blaze_rod'),
    goalQueue: queue(input.current),
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

// (a) a durable nether_fortress site + a blaze_rod goal in the Nether produces a
// DISTINCT structure-typed route.
addCase('(a) durable nether_fortress site yields a structure-typed blaze_rod RETRIEVE in the Nether', () => {
  const state = build({
    dimension: 'minecraft:the_nether',
    current: queuedGoal('blaze_rod'),
    known: [structureSite(FORTRESS_CELL, 'minecraft:the_nether')],
  })
  const route = offered(state).find((candidate) => candidate.id === retrievalId('blaze_rod', FORTRESS_CELL))
  return {
    pass: route !== undefined && route.kind === 'RETRIEVE' && route.meta.resourceKind === 'structure',
    detail: `route=${route?.id ?? 'none'} kind=${String(route?.meta.resourceKind ?? 'none')} offered=${ids(offered(state))}`,
  }
})

// (b) the SAME durable site in the overworld produces no structure route: the
// Nether cell is a different place, not a walkable overworld target.
addCase('(b) the same Nether site produces no structure route from the overworld', () => {
  const nether = build({
    dimension: 'minecraft:the_nether',
    current: queuedGoal('blaze_rod'),
    known: [structureSite(FORTRESS_CELL, 'minecraft:the_nether')],
  })
  const overworld = build({
    dimension: 'minecraft:overworld',
    current: queuedGoal('blaze_rod'),
    known: [structureSite(FORTRESS_CELL, 'minecraft:the_nether')],
  })
  const netherRoute = offered(nether).some((candidate) => candidate.kind === 'RETRIEVE')
  const overworldRoute = offered(overworld).some((candidate) => candidate.kind === 'RETRIEVE')
  return {
    pass: netherRoute && !overworldRoute,
    detail: `netherRoute=${netherRoute} overworldRoute=${overworldRoute} overworldOffered=${ids(offered(overworld))}`,
  }
})

// (c) nether_bricks is never treated as yielding blaze_rod: no MINE is invented
// for a sensed fortress body, and the structure route does not claim a yield.
addCase('(c) nether_bricks is not treated as yielding blaze_rod', () => {
  const state = build({
    dimension: 'minecraft:the_nether',
    current: queuedGoal('blaze_rod'),
    known: [structureSite(FORTRESS_CELL, 'minecraft:the_nether')],
    blocks: [sensedBody({ x: 1, y: 61, z: 0 })],
  })
  const all = offered(state)
  const mines = all.filter((candidate) => candidate.kind === 'MINE')
  const route = all.find((candidate) => candidate.id === retrievalId('blaze_rod', FORTRESS_CELL))
  const claimsYield = route !== undefined && (route.meta.yieldItem === 'blaze_rod' || route.itemName === 'blaze_rod')
  return {
    pass: mines.length === 0 && route !== undefined && !claimsYield,
    detail: `mines=${ids(mines)} route=${route?.id ?? 'none'} resourceKind=${String(route?.meta.resourceKind ?? 'none')} claimsYield=${claimsYield}`,
  }
})

// (d) the structure route does not collapse the presented set: with an
// exploration strategy the goal still has several grounded alternatives AND the
// sensor-derived descent step is NOT offered as a route to structure fabric.
// A blind stair/tunnel DESCEND cannot reach built terrain, so `descendCandidates`
// withholds it for a `structure` want (`meta.grounded=false` is not a route); the
// non-degeneracy contract is therefore >= 2 distinct REAL routes, not the old
// `>= 3` that counted the blind dig.
addCase('(d) the blaze_rod candidate set stays non-degenerate and offers no blind structure DESCEND', () => {
  const state = build({
    dimension: 'minecraft:the_nether',
    current: queuedGoal('blaze_rod', 'explore_cave'),
    known: [structureSite(FORTRESS_CELL, 'minecraft:the_nether')],
    withDescent: true,
  })
  const grounded = generateGroundedCandidates(state, OPTIONS)
  const actionable = grounded.candidates.filter((candidate) => candidate.kind !== 'WAIT')
  const distinct = new Set(actionable.map((candidate) => candidate.id))
  const hasStructureRoute = actionable.some(
    (candidate) =>
      candidate.id === retrievalId('blaze_rod', FORTRESS_CELL) && candidate.meta.resourceKind === 'structure',
  )
  const blindDescends = actionable.filter(
    (candidate) => candidate.kind === 'DESCEND' && candidate.meta.grounded !== true,
  )
  return {
    pass:
      hasStructureRoute &&
      actionable.length >= 2 &&
      distinct.size === actionable.length &&
      blindDescends.length === 0,
    detail: `actionable=${actionable.length} distinct=${distinct.size} structureRoute=${hasStructureRoute} blindDescends=${blindDescends.length} presented=${ids(grounded.candidates)}`,
  }
})

let failures = 0
process.stdout.write('M3 Nether-fortress structure route (grounded, route-only)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} fortress-route cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
