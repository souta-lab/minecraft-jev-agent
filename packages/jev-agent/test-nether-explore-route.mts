// test-nether-explore-route.mts - general exploration for a declared producer.
//
// M3's remaining gap: the body must reach UNSENSED Nether terrain before the
// sensor can recognise a structure (or sense an enderman). A `blaze_rod` collect
// goal names a declared producer (`DIRECT_BLOCK_SOURCES.blaze_rod` -> the
// Nether-fortress fabric names; `MOB_DROP_PRODUCERS.blaze_rod` -> blaze), but
// with no sensed/remembered instance the candidate layer produced only a blind
// DESCEND + WAIT and the generic exploration arm was never offered.
//
// Root causes pinned here:
//   1. `descendCandidates` classified every focus with a `scannedBlockNames`
//      source as "underground", so a `structure` want emitted a blind staircase/
//      tunnel DESCEND (`meta.grounded=false`) that is not a route to built terrain;
//   2. the exploration-fallback trigger only recognised `want.kind === 'ore'`, so
//      a `structure` want (and any non-ore/non-log declared producer) never got
//      the generic exploration enumeration that `flint`/`obsidian` already had;
//   3. a no-route state was silent (`WAIT`) instead of a typed fact.
//
// The fix is producer-agnostic: any collect focus with a DECLARED producer (a
// name-scanned block source or a mob drop) and no grounded route gets the same
// generic exploration/locomotion arm used anywhere else, and a dead end is the
// typed `EXPLORE_ROUTE_BLOCKED reason=...` fact. No structure is named and no
// preference/ranking is added.
//
// Run: bun test ./test-nether-explore-route.mts
import { createRequire } from 'node:module'
import { createRecipeIndex } from './src/crafting.ts'
import { defaultCandidateOptions, formatExploreRouteBlocked, generateGroundedCandidates } from './src/candidates.ts'
import type { Candidate, ReachabilityGateOptions } from './src/candidates.ts'
import { scannedBlockNames } from './src/state.ts'
import type { BlockState, EntityState, GoalState, InventoryState, KnownResource, SelfState, Vec3Json, WorldState } from './src/state.ts'
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
const FORTRESS_CELL: Vec3Json = { x: 40, y: 62, z: 30 }
/** Inside `FAR_LEG_PROBE_RADIUS` (24m), so a `no_path` probe really withholds it. */
const FORTRESS_NEAR: Vec3Json = { x: 11, y: 62, z: 6 }

function selfState(dimension: string, position: Vec3Json = SELF): SelfState {
  return {
    username: 'AI_EXPLORE',
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
    description: `collect 7 x ${targetItem}`,
    targetItem,
    requiredCount: 7,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(targetItem: string): QueuedGoal {
  return {
    id: `g3:collect:${targetItem}`,
    kind: 'collect',
    description: `collect 7 x ${targetItem}`,
    targetItem,
    requiredCount: 7,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function queue(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

/** A sensed Nether-fortress body block, the shape the sensor puts in `state.blocks`. */
function sensedFortressBody(position: Vec3Json, name = 'nether_bricks'): BlockState {
  return {
    kind: 'ore',
    name,
    position,
    distance: 30,
    diggable: true,
    inReach: false,
    hasAdjacentStandable: true,
    adjacentStandable: { x: position.x, y: position.y - 1, z: position.z },
    yield: name,
    harvestTool: 'pickaxe',
    harvestTier: 4,
    visible: true,
  }
}

/**
 * The durable-site projection the host performs after sensing a body block
 * (`syncStructureSiteMemory` -> `structureSiteKnownResources`, tested end to end in
 * `buddy-driver/test-nether-structure.mts`): a `KnownStructureSiteJson` becomes a
 * known-resource entry named after the sensed fabric.
 */
function projectedSite(position: Vec3Json, dimension: string, name = 'nether_bricks'): KnownResource {
  return { name, kind: 'structure', position, dimension, worldEpoch: 1 } as unknown as KnownResource
}

function zombie(position: Vec3Json, distance: number): EntityState {
  return {
    id: 77,
    name: 'zombie',
    kind: 'hostile',
    username: null,
    position,
    distance,
    hostile: true,
    lineOfSight: true,
  }
}

/** One safe level tunnel step, the sensor-derived non-advancing step that used to hide exploration. */
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
    digName: 'netherrack',
    diggable: true,
    digHarvestTool: 'pickaxe',
    digHarvestTier: 0,
  }
}

/** Distinct frontier cells so the exploration enumeration stays non-degenerate. */
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
  known?: KnownResource[]
  blocks?: BlockState[]
  entities?: EntityState[]
  standable?: Vec3Json[]
  withDescent?: boolean
}): WorldState {
  const inventory: InventoryState = { slots: [], counts: { diamond_pickaxe: 1 }, totalItems: 1 }
  const state: WorldState = {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: selfState(input.dimension),
    inventory,
    entities: input.entities ?? [],
    blocks: input.blocks ?? [],
    terrain: { standable: input.standable ?? FRONTIER },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goalState(input.current.targetItem ?? 'blaze_rod'),
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
      knownResources: input.known ?? [],
    },
  }
  if (input.withDescent === true) state.descent = [descentStep()]
  return state
}

/** Reachable probe for the normal cases; `no_path` for the unreachable case. */
function options(pathProbe: ReachabilityGateOptions['pathProbe'] = () => 'reachable'): typeof defaultCandidateOptions & {
  recipes: ReturnType<typeof createRecipeIndex>
  reachability: ReachabilityGateOptions
} {
  return {
    ...defaultCandidateOptions,
    recipes: RECIPES,
    reachability: { memory: null, pathProbe },
  }
}

function offered(state: WorldState, gate = options()): Candidate[] {
  const grounded = generateGroundedCandidates(state, gate)
  return [...grounded.candidates, ...grounded.withheld.map((entry) => entry.candidate)]
}

/**
 * A MOVE that is a real exploration frontier, never a clearance dig, the body
 * cell, or a STRUCTURE APPROACH. A sensed fortress body now grounds its own
 * `MOVE:b<cell>` (`meta.structureApproach === true`, `resourceKind: structure`):
 * that is a route to the structure the goal's producer lives in - the same trip
 * the remembered-site `RETRIEVE:known:*` makes - not the generic exploration arm,
 * so it must not be counted as one here.
 */
function explorationMoves(candidates: readonly Candidate[], self: Vec3Json): Candidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.kind === 'MOVE' &&
      candidate.meta.clearance !== true &&
      candidate.meta.structureApproach !== true &&
      candidate.target !== null &&
      (candidate.target.x !== Math.floor(self.x) ||
        candidate.target.y !== Math.floor(self.y) ||
        candidate.target.z !== Math.floor(self.z)),
  )
}

const ids = (candidates: readonly Candidate[]): string => `[${candidates.map((c) => c.id).join(' ')}]`
const retrievalId = (item: string, position: Vec3Json): string =>
  `RETRIEVE:known:${item}:b${position.x}_${position.y}_${position.z}`

// (a) FAIL-BEFORE: in the Nether, a blaze_rod collect goal with no sensed/remembered
// fortress and a sensor-derived descent step offered only a blind DESCEND + WAIT.
// The generic exploration arm must put real frontier MOVEs on offer instead.
addCase('(a) Nether blaze_rod with no fortress gets grounded exploration routes, not only a blind dig/WAIT', () => {
  const state = build({ dimension: 'the_nether', current: queuedGoal('blaze_rod'), withDescent: true })
  const all = offered(state)
  const moves = explorationMoves(all, SELF)
  const descends = all.filter((candidate) => candidate.kind === 'DESCEND')
  return {
    pass: moves.length >= 2 && new Set(moves.map((c) => c.id)).size === moves.length,
    detail: `explorationMoves=${moves.length} descends=${descends.length} offered=${ids(all)}`,
  }
})

// (a2) enumeration only when needed: once the structure route is on offer the
// generic exploration arm is not duplicated, and the sensor-derived descent step
// is not offered as a route to structure fabric.
addCase('(a2) a present structure route is not duplicated by exploration and offers no blind DESCEND', () => {
  const state = build({
    dimension: 'the_nether',
    current: queuedGoal('blaze_rod'),
    blocks: [sensedFortressBody(FORTRESS_CELL)],
    known: [projectedSite(FORTRESS_CELL, 'the_nether')],
    withDescent: true,
  })
  const grounded = generateGroundedCandidates(state, options())
  const route = grounded.candidates.find((candidate) => candidate.id === retrievalId('blaze_rod', FORTRESS_CELL))
  const moves = explorationMoves(grounded.candidates, SELF)
  const descends = grounded.candidates.filter((candidate) => candidate.kind === 'DESCEND')
  return {
    pass:
      route !== undefined &&
      route.meta.resourceKind === 'structure' &&
      moves.length === 0 &&
      descends.length === 0 &&
      grounded.exploreRouteBlocked === null,
    detail: `route=${route?.id ?? 'none'} explorationMoves=${moves.length} descends=${descends.length} blocked=${grounded.exploreRouteBlocked === null ? 'none' : formatExploreRouteBlocked(grounded.exploreRouteBlocked)}`,
  }
})

// (a3) a remembered structure route the body cannot reach must not silently
// collapse to WAIT: the route is withheld AND the dead end is typed.
addCase('(a3) an unreachable remembered structure route is a typed blocked reason=unreachable', () => {
  const state = build({
    dimension: 'the_nether',
    current: queuedGoal('blaze_rod'),
    known: [projectedSite(FORTRESS_NEAR, 'the_nether')],
    withDescent: true,
  })
  const grounded = generateGroundedCandidates(state, options(() => 'no_path'))
  const withheldRoute = grounded.withheld.find(
    (entry) => entry.candidate.id === retrievalId('blaze_rod', FORTRESS_NEAR),
  )
  const blocked = grounded.exploreRouteBlocked
  return {
    pass:
      withheldRoute !== undefined &&
      blocked !== null &&
      blocked.reason === 'unreachable' &&
      grounded.candidates.every((candidate) => candidate.kind === 'WAIT' || candidate.kind === 'ESCALATE'),
    detail: `withheldRoute=${withheldRoute?.result.reason ?? 'none'} blocked=${blocked === null ? 'none' : formatExploreRouteBlocked(blocked)} offered=${ids(grounded.candidates)}`,
  }
})

// (b) FAIL-BEFORE (no marker/route plumbing): a SENSED fortress body block is the
// producer landmark, and the durable site projected from it yields the structure
// route. `nether_bricks` is never made to yield blaze_rod (no MINE is invented).
addCase('(b) a sensed fortress body block yields the structure route to it', () => {
  const body = sensedFortressBody(FORTRESS_CELL)
  const recognized = scannedBlockNames('blaze_rod')?.includes(body.name) ?? false
  const state = build({
    dimension: 'the_nether',
    current: queuedGoal('blaze_rod'),
    blocks: [body],
    known: [projectedSite(body.position, 'the_nether')],
  })
  const all = offered(state)
  const route = all.find((candidate) => candidate.id === retrievalId('blaze_rod', body.position))
  const mines = all.filter((candidate) => candidate.kind === 'MINE' && candidate.targetName === body.name)
  return {
    pass: recognized && route !== undefined && route.meta.resourceKind === 'structure' && mines.length === 0,
    detail: `recognizedScan=${recognized} route=${route?.id ?? 'none'} mines=${ids(mines)}`,
  }
})

// (c1) generality: the structure route matches the whole scanned fabric SET, not a
// literal `nether_bricks` string - a site recorded under another fortress fabric
// name is still a route.
addCase('(c1) a structure site recorded under a different fortress fabric name still routes', () => {
  const state = build({
    dimension: 'the_nether',
    current: queuedGoal('blaze_rod'),
    known: [projectedSite(FORTRESS_CELL, 'the_nether', 'nether_brick_stairs')],
  })
  const route = offered(state).find(
    (candidate) => candidate.id === retrievalId('blaze_rod', FORTRESS_CELL),
  )
  return {
    pass: route !== undefined && route.meta.resourceKind === 'structure',
    detail: `route=${route?.id ?? 'none'} offered=${ids(offered(state))}`,
  }
})

// (c2) FAIL-BEFORE: the SAME machinery covers a producer that is not a structure at
// all. `ender_pearl` (mob drop <- enderman) with no sensed enderman but a sensed
// non-producer hostile offered only combat/WAIT; the declared producer must still
// get the generic exploration arm.
addCase('(c2) the same exploration arm covers a non-structure producer (ender_pearl mob drop)', () => {
  const state = build({
    dimension: 'the_nether',
    current: queuedGoal('ender_pearl'),
    entities: [zombie({ x: 6, y: 61, z: 0 }, 6)],
    withDescent: true,
  })
  const all = offered(state)
  const moves = explorationMoves(all, SELF)
  const attacks = all.filter((candidate) => candidate.kind === 'ATTACK')
  return {
    pass: moves.length >= 2 && attacks.length > 0,
    detail: `explorationMoves=${moves.length} attacks=${ids(attacks)} offered=${ids(all)}`,
  }
})

// (d1) FAIL-BEFORE (silent WAIT): no standable frontier at all -> typed
// EXPlORE_ROUTE_BLOCKED, never a silent stall.
addCase('(d1) no standable frontier is a typed EXPLORE_ROUTE_BLOCKED reason=no_frontier', () => {
  const state = build({
    dimension: 'the_nether',
    current: queuedGoal('blaze_rod'),
    standable: [SELF],
  })
  const grounded = generateGroundedCandidates(state, options())
  const blocked = grounded.exploreRouteBlocked
  const line = blocked === null ? 'none' : formatExploreRouteBlocked(blocked)
  return {
    pass:
      blocked !== null &&
      blocked.reason === 'no_frontier' &&
      blocked.item === 'blaze_rod' &&
      grounded.candidates.every((c) => c.kind === 'WAIT' || c.kind === 'ESCALATE') &&
      line === 'EXPLORE_ROUTE_BLOCKED goal=collect:blaze_rod item=blaze_rod reason=no_frontier',
    detail: `blocked=${line} offered=${ids(grounded.candidates)}`,
  }
})

// (d2) FAIL-BEFORE (silent WAIT): frontier cells exist but every locomotion
// candidate is withheld -> typed reason=unreachable.
addCase('(d2) an enumerated-but-unreachable frontier is a typed EXPLORE_ROUTE_BLOCKED reason=unreachable', () => {
  const state = build({ dimension: 'the_nether', current: queuedGoal('blaze_rod') })
  const grounded = generateGroundedCandidates(state, options(() => 'no_path'))
  const blocked = grounded.exploreRouteBlocked
  const withheldMoves = grounded.withheld.filter((entry) => entry.candidate.kind === 'MOVE')
  return {
    pass: blocked !== null && blocked.reason === 'unreachable' && withheldMoves.length > 0,
    detail: `blocked=${blocked === null ? 'none' : formatExploreRouteBlocked(blocked)} withheldMoves=${withheldMoves.length} reason=${withheldMoves[0]?.result.reason ?? 'none'}`,
  }
})

// (d3) the marker is a dead-end fact only: a goal with a real route reports null.
addCase('(d3) a goal with a grounded route is not reported as explore-blocked', () => {
  const state = build({
    dimension: 'the_nether',
    current: queuedGoal('blaze_rod'),
    known: [projectedSite(FORTRESS_CELL, 'the_nether')],
  })
  const grounded = generateGroundedCandidates(state, options())
  return {
    pass: grounded.exploreRouteBlocked === null,
    detail: `blocked=${grounded.exploreRouteBlocked === null ? 'none' : formatExploreRouteBlocked(grounded.exploreRouteBlocked)} route=${ids(grounded.candidates)}`,
  }
})

let failures = 0
process.stdout.write('Nether declared-producer exploration route (general, no fortress planner)\n')
process.stdout.write('-'.repeat(80) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(80) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} nether-explore-route cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
