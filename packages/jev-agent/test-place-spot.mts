// test-place-spot.mts - held-table placement geometry: the M2 craft-deadlock fix.
//
// A bot that HOLDS a crafting_table and needs a 3x3 station must be able to place
// it from the terrain the sensor already knows, even when the live
// placement-spot scan is empty - the tunnel case, where the bot is boxed in and
// no strict placement cell sits in the scan volume.
//
// The solve is MECHANICAL: a standable cell the sensor already reported (air
// with 2-block clearance and solid support) is a placement cell unless the bot's
// own body intersects it or it is out of reach. When no placement is
// geometrically possible, the generator emits a TYPED refusal
// (`PLACE_REFUSED reason=no_support|no_clearance|out_of_reach cell=x,y,z`) plus
// the grounded alternative it can offer (approach MOVE / clear-headroom MINE) -
// never silence. The suite also proves a withheld candidate is never re-emitted
// (or re-evaluated) by the capability-acquisition pass, and that the fallback
// craft ladder offers the same placement step.
//
// Run: bun run place-spot-test
import { createRequire } from 'node:module'
import {
  applyReachabilityGate,
  blockId,
  defaultCandidateOptions,
  formatPlaceRefusal,
  generateGroundedCandidates,
  selfContainedCraftCandidates,
} from './src/candidates.ts'
import type { Candidate, CandidateOptions, PlaceRefusal } from './src/candidates.ts'
import { MIRRORED_MARKERS } from './src/controller.ts'
import { createRecipeIndex } from './src/crafting.ts'
import { guardCandidate } from './src/policy.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { AgentSignals, BlockState, GoalState, HeadroomCut, InventoryState, SelfState, Vec3Json, WorldState } from './src/state.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const require = createRequire(import.meta.url)
const recipeIndex = createRecipeIndex(require('minecraft-data')('1.21.11'))
const options: CandidateOptions = { ...defaultCandidateOptions, recipes: recipeIndex }

function self(position: Vec3Json, overrides: Partial<SelfState> = {}): SelfState {
  return {
    username: 'AI_PLACESPOT',
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
    ...overrides,
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

function goal(targetItem: string): GoalState {
  return {
    id: `craft:${targetItem}`,
    description: `craft 1 x ${targetItem}`,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function craftGoal(targetItem: string): QueuedGoal {
  return {
    id: `g-craft-${targetItem}`,
    kind: 'craft',
    description: `craft 1 x ${targetItem}`,
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

function queueWith(current: QueuedGoal | null): GoalQueueState {
  if (current === null) return emptyGoalQueueState()
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

function worldState(overrides: {
  position: Vec3Json
  inventory?: InventoryState
  signals?: AgentSignals
  standable?: Vec3Json[]
  placementSpots?: Vec3Json[]
  headroomCuts?: HeadroomCut[]
  blocks?: BlockState[]
  goalQueue?: GoalQueueState
  health?: number
  food?: number
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 9,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position, {
      ...(overrides.health === undefined ? {} : { health: overrides.health }),
      ...(overrides.food === undefined ? {} : { food: overrides.food }),
    }),
    inventory: overrides.inventory ?? inventory({}),
    entities: [],
    blocks: overrides.blocks ?? [],
    terrain: { standable: overrides.standable ?? [overrides.position] },
    craftingTables: [],
    furnaces: [],
    placementSpots: overrides.placementSpots ?? [],
    descent: [],
    stepCuts: [],
    headroomCuts: overrides.headroomCuts ?? [],
    goal: goal('stone_pickaxe'),
    goalQueue: overrides.goalQueue ?? queueWith(craftGoal('stone_pickaxe')),
    recentEvents: [],
    signals: overrides.signals ?? signals(),
  }
}

/** The M2 tunnel state: table held, live spot scan empty, known standable cells. */
function heldTableInTunnel(
  neighbours: Vec3Json[],
  extra: Partial<Parameters<typeof worldState>[0]> = {},
): WorldState {
  const feet: Vec3Json = { x: 0, y: 64, z: 0 }
  return worldState({
    position: { x: 0.5, y: 64, z: 0.5 },
    inventory: inventory({ cobblestone: 3, stick: 2, crafting_table: 1 }),
    standable: [feet, ...neighbours],
    placementSpots: [],
    ...extra,
  })
}

const placeIds = (candidates: readonly Candidate[]): string[] =>
  candidates.filter((candidate) => candidate.kind === 'PLACE').map((candidate) => candidate.id)

const productive = (candidates: readonly Candidate[]): Candidate[] =>
  candidates.filter((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')

// ---------------------------------------------------------------------------
// (1) held table + empty sensed placementSpots + known standable neighbour
// ---------------------------------------------------------------------------
{
  const feet: Vec3Json = { x: 0, y: 64, z: 0 }
  const neighbour: Vec3Json = { x: 2, y: 64, z: 0 }
  const state = heldTableInTunnel([neighbour])

  const ladder = selfContainedCraftCandidates(state, options)
  const expectedId = `PLACE:crafting_table:${blockId('p', neighbour)}`
  check(
    '(1) held table + empty placementSpots + standable neighbour: the self-contained ladder offers the placement',
    ladder.some((candidate) => candidate.id === expectedId),
    `ladder=[${ladder.map((candidate) => candidate.id).join(',')}] expected=${expectedId}`,
  )

  const grounded = generateGroundedCandidates(state, options)
  const place = grounded.candidates.find((candidate) => candidate.id === expectedId)
  check(
    '(1) the grounded set offers the same placement with no refusal',
    place !== undefined &&
      place.kind === 'PLACE' &&
      place.target?.x === neighbour.x &&
      place.target?.y === neighbour.y &&
      place.target?.z === neighbour.z &&
      grounded.placeRefusal === null,
    `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}] refusal=${JSON.stringify(grounded.placeRefusal)}`,
  )
  check(
    '(1) the tray stays off the feet cell (the bot body would intersect it)',
    !placeIds(grounded.candidates).includes(`PLACE:crafting_table:${blockId('p', feet)}`),
    `placeIds=[${placeIds(grounded.candidates).join(',')}]`,
  )
}

// ---------------------------------------------------------------------------
// (1a-floor) mandatory local station recovery survives the starvation floor
// ---------------------------------------------------------------------------
{
  const neighbour: Vec3Json = { x: 2, y: 64, z: 0 }
  const state = heldTableInTunnel([neighbour], { health: 1, food: 0 })
  const ladder = selfContainedCraftCandidates(state, options)
  const place = ladder.find((candidate) => candidate.kind === 'PLACE')
  const guard =
    place === undefined
      ? null
      : guardCandidate(place, state, {
          phase: 'decision',
          candidateIds: new Set([place.id]),
          inFlight: null,
          reach: options.reach,
          maxCandidateAgeTicks: 40,
        })
  check(
    '(1a-floor) health1/food0 mandatory self-contained table placement is typed and guard-admitted',
    place !== undefined &&
      place.meta.localMandatoryCraftRecovery === true &&
      guard !== null &&
      guard.ok === true,
    `place=${place?.id ?? 'none'} marker=${String(place?.meta.localMandatoryCraftRecovery ?? false)} guard=${guard === null ? 'none' : guard.ok ? 'ok' : guard.code}`,
  )

  const optional = craftGoal('stone_pickaxe')
  optional.optional = true
  const optionalState = heldTableInTunnel([neighbour], {
    health: 1,
    food: 0,
    goalQueue: queueWith(optional),
  })
  const optionalStep = selfContainedCraftCandidates(optionalState, options).find((candidate) => candidate.kind === 'PLACE')
  check(
    '(1a-floor) an optional craft does not receive the mandatory-recovery exemption',
    optionalStep === undefined || optionalStep.meta.localMandatoryCraftRecovery !== true,
    `optional=${optionalStep?.id ?? 'none'} marker=${String(optionalStep?.meta.localMandatoryCraftRecovery ?? false)}`,
  )
}

// ---------------------------------------------------------------------------
// (1b) the strict live-sensed spot keeps priority over the derived terrain
// ---------------------------------------------------------------------------
{
  const sensed: Vec3Json = { x: 0, y: 65, z: 2 }
  const neighbour: Vec3Json = { x: 2, y: 64, z: 0 }
  const state = heldTableInTunnel([neighbour], { placementSpots: [sensed] })
  const ladder = selfContainedCraftCandidates(state, options)
  check(
    '(1b) a live-sensed placement spot is used ahead of the derived standable cell',
    ladder.length === 1 && ladder[0]?.id === `PLACE:crafting_table:${blockId('p', sensed)}`,
    `ladder=[${ladder.map((candidate) => candidate.id).join(',')}]`,
  )
}

// ---------------------------------------------------------------------------
// (2a) no placement geometrically possible: out_of_reach -> typed refusal + move
// ---------------------------------------------------------------------------
{
  const far: Vec3Json = { x: 9, y: 64, z: 0 }
  const state = heldTableInTunnel([far])
  const grounded = generateGroundedCandidates(state, options)

  const expected: PlaceRefusal = { item: 'crafting_table', reason: 'out_of_reach', cell: far }
  check(
    '(2a) a valid but out-of-reach placement cell refuses with reason=out_of_reach and the exact cell',
    grounded.placeRefusal !== null &&
      grounded.placeRefusal.reason === expected.reason &&
      grounded.placeRefusal.cell.x === far.x &&
      grounded.placeRefusal.cell.y === far.y &&
      grounded.placeRefusal.cell.z === far.z,
    `refusal=${JSON.stringify(grounded.placeRefusal)}`,
  )
  const approach = productive(grounded.candidates).find((candidate) => candidate.kind === 'MOVE')
  check(
    '(2a) the refusal is never silent: a grounded approach MOVE is offered',
    approach !== undefined &&
      approach.target !== null &&
      approach.target.x === far.x &&
      approach.target.y === far.y &&
      approach.target.z === far.z,
    `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
  )
  check(
    '(2a) the refusal is rendered as the typed observability line',
    formatPlaceRefusal(expected) === `PLACE_REFUSED reason=out_of_reach cell=${far.x},${far.y},${far.z} item=crafting_table`,
    formatPlaceRefusal(expected),
  )
}

// ---------------------------------------------------------------------------
// (2b) the only placeable cell intersects the bot body: no_clearance + headroom
// ---------------------------------------------------------------------------
{
  const feet: Vec3Json = { x: 0, y: 64, z: 0 }
  const cut: HeadroomCut = { pos: { x: 0, y: 66, z: 0 }, name: 'stone', safe: true, reason: 'safe' }
  // The clearance MINE is the grounded alternative only while it can actually be
  // executed. The cell is `stone`, whose harvest requirement is a pickaxe, so the
  // body must hold one: the acquisition-route contract refuses a dig whose tool
  // the body lacks (`missing_tool` + the typed CRAFT/collect route) instead of
  // offering an undiggable lease that can only end in `dig_timeout`. This case
  // pins the REFUSAL-not-silent property, not a hand-diggable stone.
  const state = heldTableInTunnel([], {
    headroomCuts: [cut],
    inventory: inventory({ cobblestone: 3, stick: 2, crafting_table: 1, wooden_pickaxe: 1 }),
  })
  const grounded = generateGroundedCandidates(state, options)

  check(
    '(2b) only the body cell is placeable: reason=no_clearance names that cell',
    grounded.placeRefusal !== null &&
      grounded.placeRefusal.reason === 'no_clearance' &&
      grounded.placeRefusal.cell.x === feet.x &&
      grounded.placeRefusal.cell.y === feet.y &&
      grounded.placeRefusal.cell.z === feet.z,
    `refusal=${JSON.stringify(grounded.placeRefusal)}`,
  )
  const clear = productive(grounded.candidates).find((candidate) => candidate.kind === 'MINE' && candidate.target?.y === 66)
  check(
    '(2b) the grounded alternative is the clear-headroom MINE carrying the refusal token',
    clear !== undefined &&
      clear.meta.placeRefused === 'no_clearance' &&
      clear.meta.placeRefusedCell === blockId('p', feet),
    `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
  )
}

// ---------------------------------------------------------------------------
// (2c) no placeable terrain at all: reason=no_support, typed, never silent
// ---------------------------------------------------------------------------
{
  const state = heldTableInTunnel([], { standable: [] })
  const grounded = generateGroundedCandidates(state, options)
  const refusal = grounded.placeRefusal
  check(
    '(2c) no standable terrain in sensor range: reason=no_support at the unsupported head cell',
    refusal !== null &&
      refusal.reason === 'no_support' &&
      refusal.cell.x === 0 &&
      refusal.cell.y === 65 &&
      refusal.cell.z === 0,
    `refusal=${JSON.stringify(refusal)}`,
  )
  check(
    '(2c) the refusal survives even when no alternative candidate exists',
    grounded.candidates.some((candidate) => candidate.kind === 'WAIT') &&
      refusal !== null &&
      formatPlaceRefusal(refusal) === 'PLACE_REFUSED reason=no_support cell=0,65,0 item=crafting_table',
    `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
  )
}

// ---------------------------------------------------------------------------
// (3) the table-requiring craft becomes productive: PLACE is offered, no silence
// ---------------------------------------------------------------------------
{
  const neighbour: Vec3Json = { x: 2, y: 64, z: 0 }
  const state = heldTableInTunnel([neighbour])
  const grounded = generateGroundedCandidates(state, options)
  const place = productive(grounded.candidates).find((candidate) => candidate.kind === 'PLACE')
  check(
    '(3) craft 1 x stone_pickaxe with a held, placeable table is PRODUCTIVE (PLACE offered, not WAIT/ESCALATE)',
    place !== undefined &&
      place.id === `PLACE:crafting_table:${blockId('p', neighbour)}` &&
      grounded.placeRefusal === null &&
      placeIds(grounded.candidates).length === 1,
    `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
  )
}

// ---------------------------------------------------------------------------
// (4) withheld candidates are never re-emitted by capability acquisition
// ---------------------------------------------------------------------------
{
  const feet: Vec3Json = { x: 0, y: 64, z: 0 }
  const cutPos: Vec3Json = { x: 0, y: 66, z: 0 }
  const ceilingStone: BlockState = {
    kind: 'stone',
    name: 'stone',
    position: cutPos,
    distance: 2,
    diggable: true,
    inReach: true,
    hasAdjacentStandable: true,
    adjacentStandable: feet,
    yield: 'cobblestone',
    harvestTool: 'pickaxe',
    harvestTier: 0,
  }
  const state = worldState({
    position: { x: 0.5, y: 64, z: 0.5 },
    blocks: [ceilingStone],
    headroomCuts: [{ pos: cutPos, name: 'stone', safe: true, reason: 'safe' }],
    standable: [feet],
  })
  const mine: Candidate = {
    id: `MINE:${blockId('b', cutPos)}`,
    kind: 'MINE',
    label: 'mine the stone ceiling block',
    targetName: 'stone',
    target: cutPos,
    targetEntityId: null,
    itemName: null,
    requiresTool: true,
    toolName: 'pickaxe',
    toolTier: 0,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 9, x: cutPos.x, y: cutPos.y, z: cutPos.z },
  }
  const highCell: Vec3Json = { x: 0, y: 71, z: 0 }
  const moveHigh: Candidate = {
    id: `MOVE:${blockId('p', highCell)}`,
    kind: 'MOVE',
    label: 'walk to a cell 7 above (needs a pillar and headroom)',
    targetName: null,
    target: highCell,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: { tick: 9, x: highCell.x, y: highCell.y, z: highCell.z },
  }
  const gated = applyReachabilityGate([mine, moveHigh], state, options)
  const high = gated.withheld.find((entry) => entry.candidate.id === moveHigh.id)
  const mineRecords = gated.reachability.filter((entry) => entry.candidate.id === mine.id)
  check(
    '(4) the high MOVE is withheld for the headroom cell (the acquisition trigger fires)',
    high !== undefined && high.result.missingCapabilities.some((capability) => capability.kind === 'headroom'),
    high === undefined
      ? `withheld=[${gated.withheld.map((entry) => entry.candidate.id).join(',')}]`
      : `missing=[${high.result.missingCapabilities.map((capability) => capability.kind).join(',')}]`,
  )
  check(
    '(4) the withheld ceiling MINE is not re-emitted or re-evaluated by capability acquisition (id dedup)',
    mineRecords.length === 1 &&
      new Set(gated.reachability.map((entry) => entry.candidate.id)).size === gated.reachability.length,
    `reachability=[${gated.reachability.map((entry) => entry.candidate.id).join(',')}] withheld=[${gated.withheld.map((entry) => entry.candidate.id).join(',')}]`,
  )
}

// ---------------------------------------------------------------------------
// (5) observability: the markers are mirrored
// ---------------------------------------------------------------------------
{
  check(
    '(5) QUEUE_DEPTH and PLACE_REFUSED are mirrored markers',
    MIRRORED_MARKERS.has('QUEUE_DEPTH') && MIRRORED_MARKERS.has('PLACE_REFUSED'),
    `mirrored=${[...MIRRORED_MARKERS].filter((marker) => marker === 'QUEUE_DEPTH' || marker === 'PLACE_REFUSED').join(',') || 'none'}`,
  )
}

// ---------------------------------------------------------------------------
// (6) STARVING withholds the held-table placement at the offer side
// ---------------------------------------------------------------------------
{
  const feet: Vec3Json = { x: 0, y: 64, z: 0 }
  const neighbour: Vec3Json = { x: 2, y: 64, z: 0 }
  const placeGoal: QueuedGoal = {
    ...craftGoal('crafting_table'),
    id: 'g-place-crafting_table',
    kind: 'place',
    description: 'place 1 x crafting_table',
  }
  const state = heldTableInTunnel([neighbour], { goalQueue: queueWith(placeGoal) })
  state.self.health = 1
  state.self.food = 0

  const grounded = generateGroundedCandidates(state, options)
  check(
    '(6) starving + place goal: the station placement is withheld at the offer side (guard-mirrored)',
    placeIds(grounded.candidates).every((id) => !id.startsWith('PLACE:crafting_table')),
    `places=[${placeIds(grounded.candidates).join(',')}]`,
  )
}

process.stdout.write(`\n${failures === 0 ? 'OK' : 'FAILURES'}: ${failures} failing check(s)\n`)
if (failures > 0) process.exit(1)
