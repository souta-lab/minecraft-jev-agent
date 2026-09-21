// test-surface-ascent.mts - measured surface-ascent dead end:
// the live goal `recover vertical access to y>=86 and collect 1 x log`
// (`kind: 'surface'`, `strategy: 'return_to_surface'`, targetY from
// `deriveUpperAccessTargetY`) ran for 48 minutes with the body at (3.5, 67,
// 18.5): 144 x level `MOVE:p3_6*` candidates, EAT, WAIT - and ZERO
// ASCENT/PILLAR/VERTICAL markers. Nothing enumerated the vertical leg the goal
// exists for, so the Option could never satisfy and the body shuffled inside
// the only set it was given (1533 blocks travelled, 0.815 net, ~0.05%
// efficiency).
//
// Owning-layer cause: `generateRawCandidates` routes a `surface` goal through
// `mineCandidates` (empty log pool when no log is sensed) and
// `retrievalCandidates`, whose `surfaceSpot` can only name a standable cell the
// sensor saw - never above `floor(self.y) + 1` (`buildTerrain` scans dy in
// [-1, +1]). `surfaceAscentCandidates` now enumerates the same grounded
// vertical route the MINE/RETRIEVE paths already attach to an above target
// (reuse tunnel / up-staircase / pillar), or returns a typed
// `SURFACE_ASCENT_REFUSED` instead of silence.
//
// This fixture is pure: no bot, no network. Run: bun test ./test-surface-ascent.mts
import {
  defaultCandidateOptions,
  generateCandidates,
  generateGroundedCandidates,
} from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
// The new marker is read through the namespace so this fixture still RUNS (and
// fails semantically) against the pre-fix module, where the export does not
// exist yet; a static named import would abort the whole run with a SyntaxError
// and hide the before/after diff.
import * as candidatesModule from './src/candidates.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { selectPlaceableBlock } from './src/pillarSearch.ts'
import type {
  AgentSignals,
  BlockState,
  GoalState,
  InventoryState,
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

/** The measured shape: feet (3,67,18), goal `recover vertical access to y>=86`. */
const BODY_FEET: Vec3Json = { x: 3, y: 67, z: 18 }
/** A second level standable cell, so the level-move family is non-empty (live shape). */
const LEVEL_SPOT: Vec3Json = { x: 5, y: 67, z: 18 }
const GOAL_TARGET_Y = 86
const GAP = GOAL_TARGET_Y - BODY_FEET.y

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_SURFACEASCENT',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'overworld',
    isDay: false,
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

function surfaceGoal(targetY: number): GoalState {
  return {
    id: 'surface:log:1',
    description: `recover vertical access to y>=${targetY} and collect 1 x log`,
    targetItem: 'log',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedSurface(targetY: number): QueuedGoal {
  return {
    id: 'surface:log:1',
    kind: 'surface',
    description: `recover vertical access to y>=${targetY} and collect 1 x log`,
    targetItem: 'log',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
    targetY,
    dimension: 'overworld',
  }
}

function queueWith(current: QueuedGoal): GoalQueueState {
  return { ...emptyGoalQueueState(), depth: 1, current, empty: false, goals: [current] }
}

function hazardBlock(position: Vec3Json): BlockState {
  return {
    kind: 'hazard',
    name: 'lava',
    position,
    distance: 1,
    diggable: false,
    inReach: false,
    hasAdjacentStandable: false,
    adjacentStandable: null,
  }
}

/**
 * A surface goal in an open column: the sensor knows only the bot's own
 * standable cell, so no level/walk route can reach the goal's Y (this is the
 * measured shape - the only alternatives are level moves or WAIT).
 */
function surfaceWorld(
  counts: Record<string, number>,
  targetY = GOAL_TARGET_Y,
  blocks: BlockState[] = [],
  extraStandable = true,
): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(BODY_FEET),
    inventory: inventory(counts),
    entities: [],
    blocks,
    // The measured pocket: the body's own cell plus one level standable cell
    // more than 1.5 m away - exactly the shape that offered the 144 level
    // `MOVE:p3_6*` candidates while the surface goal sat 19 blocks up.
    terrain: { standable: extraStandable ? [BODY_FEET, LEVEL_SPOT] : [BODY_FEET] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: surfaceGoal(targetY),
    goalQueue: queueWith(queuedSurface(targetY)),
    recentEvents: [],
    descent: [],
    stepCuts: [],
    signals: signals(),
  }
}

interface SurfaceAscentRefusalLike {
  reason: string
  goalId: string
  fromY: number
  toY: number
  cell: Vec3Json
}

/** Read the typed refusal whether or not the running module already has it. */
function refusalOf(grounded: { surfaceAscentRefusal?: SurfaceAscentRefusalLike | null }): SurfaceAscentRefusalLike | null {
  return grounded.surfaceAscentRefusal ?? null
}

const formatSurfaceAscentRefusedMaybe = (
  candidatesModule as unknown as { formatSurfaceAscentRefused?: (refusal: SurfaceAscentRefusalLike) => string }
).formatSurfaceAscentRefused

const surfaceAscentRoutelessMaybe = (
  candidatesModule as unknown as { surfaceAscentRouteless?: (candidates: readonly Candidate[]) => boolean }
).surfaceAscentRouteless

function routeless(candidates: readonly Candidate[]): boolean | null {
  return surfaceAscentRoutelessMaybe === undefined ? null : surfaceAscentRoutelessMaybe(candidates)
}

function formatRefusal(refusal: SurfaceAscentRefusalLike | null): string {
  if (refusal === null) return 'null'
  return formatSurfaceAscentRefusedMaybe === undefined
    ? 'SURFACE_ASCENT_REFUSED_MARKER_MISSING'
    : formatSurfaceAscentRefusedMaybe(refusal)
}

function ascentOf(candidates: readonly Candidate[]): Candidate | null {
  return candidates.find((candidate) => candidate.meta.surfaceAscent === true) ?? null
}

// --- 1. a held placeable enumerates the pillar route ---------------------------

addCase('a surface goal 19 blocks above the body with a held placeable enumerates a pillar ascent', () => {
  const candidates = generateCandidates(surfaceWorld({ diamond_pickaxe: 1, dirt: 1 }), defaultCandidateOptions)
  const ascent = ascentOf(candidates)
  const pass =
    GAP > 1 &&
    ascent !== null &&
    ascent.kind === 'MOVE' &&
    ascent.id.startsWith('ASCEND:surface:') &&
    ascent.meta.vertical === 'pillar' &&
    ascent.meta.pillarSteps === 1 &&
    ascent.meta.pillarPlaceCount === 1 &&
    ascent.meta.pillarToY === BODY_FEET.y + 1 &&
    ascent.meta.ascentTargetY === GOAL_TARGET_Y
  return { pass, detail: ascent === null ? `no ascent candidate (${candidates.length} offered)` : JSON.stringify(ascent.meta) }
})

addCase('a full stack of placeable climbs the whole gap to the goal targetY', () => {
  const candidates = generateCandidates(
    surfaceWorld({ diamond_pickaxe: 1, cobblestone: 64 }),
    defaultCandidateOptions,
  )
  const ascent = ascentOf(candidates)
  const steps = typeof ascent?.meta.pillarSteps === 'number' ? ascent.meta.pillarSteps : null
  const placeCount = typeof ascent?.meta.pillarPlaceCount === 'number' ? ascent.meta.pillarPlaceCount : null
  const pass =
    ascent !== null &&
    ascent.meta.vertical === 'pillar' &&
    ascent.meta.pillarToY === GOAL_TARGET_Y &&
    steps !== null &&
    placeCount !== null &&
    steps <= placeCount &&
    ascent.target?.y === GOAL_TARGET_Y
  return { pass, detail: ascent === null ? 'no ascent candidate' : JSON.stringify(ascent.meta) }
})

// --- 2. the ascent candidate is a real CAN route, offered alongside others -----

addCase('the ascent candidate survives the reachability gate as a feasible route', () => {
  const grounded = generateGroundedCandidates(
    surfaceWorld({ diamond_pickaxe: 1, cobblestone: 64 }),
    defaultCandidateOptions,
  )
  const ascent = ascentOf(grounded.candidates)
  const withheld = grounded.withheld.some((entry) => entry.candidate.meta.surfaceAscent === true)
  const pass = ascent !== null && !withheld && ascent.affordance?.feasible === true && ascent.affordance.reason === 'reachable'
  return {
    pass,
    detail:
      ascent === null
        ? `withheld=${withheld} presented=${grounded.candidates.length}`
        : JSON.stringify(ascent.affordance),
  }
})

addCase('the ascent is offered alongside WAIT and the level moves, never as an override', () => {
  const candidates = generateCandidates(surfaceWorld({ diamond_pickaxe: 1, dirt: 1 }), defaultCandidateOptions)
  const ascent = ascentOf(candidates)
  const wait = candidates.some((candidate) => candidate.kind === 'WAIT')
  const levelMoves = candidates.filter((candidate) => candidate.kind === 'MOVE' && candidate.meta.surfaceAscent !== true)
  const pass = ascent !== null && wait && levelMoves.length > 0
  return {
    pass,
    detail: `ascent=${ascent !== null} wait=${wait} levelMoves=${levelMoves.length} total=${candidates.length}`,
  }
})

// --- 3. an impossible ascent is a TYPED refusal, not silence --------------------

addCase('no placeable names SURFACE_ASCENT_REFUSED reason=no_placeable and offers no ascent', () => {
  const grounded = generateGroundedCandidates(
    surfaceWorld({ diamond_pickaxe: 1 }),
    defaultCandidateOptions,
  )
  const refusal = refusalOf(grounded)
  const pass =
    refusal !== null &&
    refusal.reason === 'no_placeable' &&
    refusal.goalId === 'surface:log:1' &&
    refusal.fromY === BODY_FEET.y &&
    refusal.toY === GOAL_TARGET_Y &&
    ascentOf(grounded.candidates) === null
  return {
    pass,
    detail: `refusal=${formatRefusal(refusal)} ascent=${ascentOf(grounded.candidates) !== null}`,
  }
})

addCase('the refusal marker carries the reason, the goal id and both Ys', () => {
  const grounded = generateGroundedCandidates(surfaceWorld({ diamond_pickaxe: 1 }), defaultCandidateOptions)
  const refusal = refusalOf(grounded)
  const line = refusal === null ? 'NO_REFUSAL' : formatRefusal(refusal)
  const pass = line === `SURFACE_ASCENT_REFUSED reason=no_placeable goal=surface:log:1 from_y=67 to_y=86 cell=3,67,18`
  return { pass, detail: line }
})

addCase('a hazard in the ascent column names SURFACE_ASCENT_REFUSED reason=unsafe_column', () => {
  const grounded = generateGroundedCandidates(
    surfaceWorld({ diamond_pickaxe: 1, cobblestone: 64 }, GOAL_TARGET_Y, [hazardBlock({ x: 3, y: 68, z: 18 })]),
    defaultCandidateOptions,
  )
  const refusal = refusalOf(grounded)
  const pass = refusal !== null && refusal.reason === 'unsafe_column' && ascentOf(grounded.candidates) === null
  return {
    pass,
    detail: `refusal=${formatRefusal(refusal)} ascent=${ascentOf(grounded.candidates) !== null}`,
  }
})

// --- 4. no false positives ------------------------------------------------------

addCase('a surface target one block above the body needs no ascent route', () => {
  const grounded = generateGroundedCandidates(
    surfaceWorld({ diamond_pickaxe: 1 }, BODY_FEET.y + 1),
    defaultCandidateOptions,
  )
  const refusal = refusalOf(grounded)
  const pass = refusal === null && ascentOf(grounded.candidates) === null
  return {
    pass,
    detail: `refusal=${refusal === null ? 'null' : refusal.reason} ascent=${ascentOf(grounded.candidates) !== null}`,
  }
})

addCase('a non-surface goal never produces a surface ascent or refusal', () => {
  const world = surfaceWorld({ diamond_pickaxe: 1 })
  const collect: QueuedGoal = { ...queuedSurface(GOAL_TARGET_Y), id: 'collect:log:1', kind: 'collect' }
  const state: WorldState = { ...world, goalQueue: queueWith(collect) }
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const refusal = refusalOf(grounded)
  const pass = refusal === null && ascentOf(grounded.candidates) === null
  return {
    pass,
    detail: `refusal=${refusal === null ? 'null' : refusal.reason} ascent=${ascentOf(grounded.candidates) !== null}`,
  }
})

addCase('selectPlaceableBlock agrees with the enumerated plan (cobblestone is placeable)', () => {
  const placeable = selectPlaceableBlock({ cobblestone: 64 })
  const candidates = generateCandidates(surfaceWorld({ diamond_pickaxe: 1, cobblestone: 64 }), defaultCandidateOptions)
  const ascent = ascentOf(candidates)
  const pass = placeable !== null && ascent !== null && ascent.meta.pillarPlaceName === placeable.name
  return { pass, detail: `placeable=${JSON.stringify(placeable)} meta=${ascent === null ? 'no ascent' : ascent.meta.pillarPlaceName}` }
})

// --- 5. the deterministic "no route at all" fact (controller impossible gate) ---

addCase('a pocket with a level alternative is NOT routeless (a refused pillar never erases it)', () => {
  const candidates = generateCandidates(surfaceWorld({ diamond_pickaxe: 1 }), defaultCandidateOptions)
  const observed = routeless(candidates)
  const pass = observed === false
  return { pass, detail: `routeless=${observed} kinds=[${candidates.map((c) => c.kind).join(',')}]` }
})

addCase('a 1x1 shaft with no placeable and no level move IS routeless (the impossible fact)', () => {
  const grounded = generateGroundedCandidates(
    surfaceWorld({ diamond_pickaxe: 1 }, GOAL_TARGET_Y, [], false),
    defaultCandidateOptions,
  )
  const observed = routeless(grounded.candidates)
  const pass =
    observed === true &&
    refusalOf(grounded)?.reason === 'no_placeable' &&
    ascentOf(grounded.candidates) === null
  return {
    pass,
    detail: `routeless=${observed} kinds=[${grounded.candidates.map((c) => c.kind).join(',')}] refusal=${formatRefusal(refusalOf(grounded))}`,
  }
})

addCase('a 1x1 shaft that holds a placeable is NOT routeless (the ascent is a route)', () => {
  const grounded = generateGroundedCandidates(
    surfaceWorld({ diamond_pickaxe: 1, dirt: 1 }, GOAL_TARGET_Y, [], false),
    defaultCandidateOptions,
  )
  const observed = routeless(grounded.candidates)
  const pass = observed === false && ascentOf(grounded.candidates) !== null && refusalOf(grounded) === null
  return {
    pass,
    detail: `routeless=${observed} kinds=[${grounded.candidates.map((c) => c.kind).join(',')}]`,
  }
})

let failures = 0
process.stdout.write(`surface ascent: y=${BODY_FEET.y} -> goal targetY>=${GOAL_TARGET_Y} (gap ${GAP})\n`)
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} surface-ascent cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
