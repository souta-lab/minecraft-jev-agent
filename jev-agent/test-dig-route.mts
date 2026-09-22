// test-dig-route.mts - the general "no walkable route, so change the TERRAIN"
// affordance for a travel / enter / retrieve goal.
//
// MEASURED (run-muc9k936-1f3vb, main ebec6f2, m3-live): the body had climbed its
// own 1-wide shaft to y=66 and was sealed inside it while the KNOWN gate
// (portal_verified=true, (25,66,9)) sat ~21 blocks away behind ordinary stone:
//
//   offer cycle: ['ENTER:26,67,9','WAIT'] -> PATH_CALLBACK phase=failed
//                -> ROUTE_STAGE_FAILED kind=ENTER_PORTAL -> ROUTE_SPENT
//                -> ['WAIT','ESCALATE'] -> PLAN_THROTTLED reason=action_impossible
//                -> the route memory's 120 s TTL expires -> repeat
//   world truth (chunk (1,0) y60-72): stone 627 / dirt 584 / grass_block 253 -
//   i.e. ordinary DIGGABLE surface only 13 blocks east and 15 north
//
// The mechanical reason nothing was offered: `state.ts#buildTerrain` senses the
// standable set from a 5x5x3 window, so a 1-wide shaft yields exactly the body's
// own cell; `candidates.ts#travelApproachLeg` skips that cell by definition and
// returns nothing; every bounded recovery family (`DESCEND`, `STEP`, explore)
// moves the BODY to a cell the sensor already believes is standable, so all of
// them are starved at once.
//
// These fixtures prove, offline:
//   (a) the measured shape (body sealed at y=66, target 13 blocks east at the
//       same level, solid rock between): a grounded DIG route toward the target
//       is offered, it is presented by the affordance gate, the guard accepts it,
//       and the distance to the target STRICTLY decreases as the body advances;
//   (a2) the live bearings (11,66,24 -> 26,67,9, +1 y): same, and it is a
//       `shaft_exit` (the body's own cell is the only sensed standable cell);
//   (b) no tool for the intervening block: typed `no_tool` refusal and the
//       existing `all_routes_spent` escalation, never an invented route;
//   (c) hazard / unsupported floor in the bearing: typed refusal;
//   (d) a walkable route exists -> the MOVE/ACCESS/ENTER path is untouched and
//       no dig route is offered; when the route is spent the walk leg is still
//       the same candidate and still first;
//   (e) a genuine success clears the route budget exactly as today;
//   (f) the same affordance grounds for a remembered RESOURCE retrieve (no
//       portal/M3 branch in the mechanism).
//
// Run: bun jev-agent/test-dig-route.mts
import { readFileSync } from 'node:fs'
import {
  defaultCandidateOptions,
  entryCandidates,
  generateGroundedCandidates,
} from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import type { PortalEntryPlan } from './src/netherPortalPlan.ts'
import { NETHER, PORTAL_ENTERED_PREDICATE } from './src/netherPortalPlan.ts'
import { cellKey, clearZeroProgressStand, observeZeroProgressRoute, routeSignature } from './src/zeroProgressRoute.ts'
import { guardCandidate } from './src/policy.ts'
import type { GuardContext } from './src/policy.ts'
import { DIG_ROUTE_ARRIVE_DISTANCE, formatDigRoute, formatDigRouteRefused, planDigRoute } from './src/digRoute.ts'
import type { AgentSignals, DescentDir, DescentOption, DescentRefusalReason, InventoryState, SelfState, Vec3Json, WorldState } from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { descentPrimaryCell, distance } from './src/state.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const key = (p: Vec3Json): string => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
const round2 = (value: number): number => Math.round(value * 100) / 100

// ---------------------------------------------------------------------------
// the sensor's own cardinal step geometry (`state.ts#buildDescent`), for a body
// standing inside 1-wide solid rock: every cardinal wall/head/floor is diggable
// stone with solid support under the landing cell.
// ---------------------------------------------------------------------------
const DIRS: Array<{ dir: DescentDir; dx: number; dz: number }> = [
  { dir: 'E', dx: 1, dz: 0 },
  { dir: 'W', dx: -1, dz: 0 },
  { dir: 'N', dx: 0, dz: -1 },
  { dir: 'S', dx: 0, dz: 1 },
]

interface StepFault {
  reason: DescentRefusalReason
  /** the block name the sensor read (lava/water for `hazard`, bedrock for `unbreakable`) */
  block?: string
}

interface ShaftSpec {
  /** typed refusal per `dir:mode` (e.g. `E:level`), as `buildDescent` records it */
  faults?: Record<string, StepFault>
  /** block name of the dug cell, default stone */
  block?: string
  /** harvest tool of the dug cell, default pickaxe tier 0 (stone) */
  harvestTool?: string | null
  harvestTier?: number
}

/** One sensor option, shaped exactly like `state.ts#buildDescent` produces. */
function stepOption(feet: Vec3Json, dir: DescentDir, dx: number, dz: number, mode: 'down' | 'level', fault: StepFault | undefined, spec: ShaftSpec): DescentOption {
  const wall = { x: feet.x + dx, y: feet.y, z: feet.z + dz }
  const head = { x: feet.x + dx, y: feet.y + 1, z: feet.z + dz }
  const stepY = mode === 'down' ? feet.y - 1 : feet.y
  const step = { x: feet.x + dx, y: stepY, z: feet.z + dz }
  const floor = { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz }
  const support = { x: feet.x + dx, y: stepY - 1, z: feet.z + dz }
  const name = fault?.block ?? spec.block ?? 'stone'
  const harvestTool = spec.harvestTool === undefined ? 'pickaxe' : spec.harvestTool
  const harvestTier = spec.harvestTier ?? 0
  const primary = mode === 'down' ? floor : wall
  return {
    dir,
    mode,
    dx,
    dz,
    step,
    wall,
    head,
    floor,
    wallSolid: true,
    headSolid: true,
    floorSolid: true,
    supportSolid: true,
    hazardNearby: fault?.reason === 'hazard',
    digs: [
      { cell: wall, name: spec.block ?? 'stone', harvestTool, harvestTier, diggable: true },
      { cell: head, name: spec.block ?? 'stone', harvestTool, harvestTier, diggable: true },
    ],
    safe: fault === undefined,
    reason: fault === undefined ? 'safe' : `${name} refusal`,
    ...(fault === undefined ? {} : { refusal: fault.reason }),
    digName: name,
    digHarvestTool: harvestTool,
    digHarvestTier: harvestTier,
    diggable: fault?.reason !== 'unbreakable',
    ...(mode === 'down' ? { floorSolid: true } : {}),
    ...(primary.x === floor.x && primary.y === floor.y && primary.z === floor.z ? {} : {}),
  } as DescentOption
}

/** The four cardinal level steps + the four cardinal down steps, plus the own column. */
function shaftDescent(feet: Vec3Json, spec: ShaftSpec = {}): DescentOption[] {
  const out: DescentOption[] = []
  for (const { dir, dx, dz } of DIRS) {
    out.push(stepOption(feet, dir, dx, dz, 'level', spec.faults?.[`${dir}:level`], spec))
    out.push(stepOption(feet, dir, dx, dz, 'down', spec.faults?.[`${dir}:down`], spec))
  }
  // The own column digs the block under the feet; in a sealed shaft the landing
  // below is open ground and the sensor refuses it (`open_floor`).
  out.push(stepOption(feet, 'D', 0, 0, 'down', { reason: 'open_floor' }, spec))
  return out
}

// ---------------------------------------------------------------------------
// candidate-layer state
// ---------------------------------------------------------------------------
const OVERWORLD = 'minecraft:overworld'

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_DIG',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: OVERWORLD,
    isDay: true,
    heldItem: null,
  }
}

function inventory(counts: Record<string, number>): InventoryState {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0) }
}

function signals(extra: Partial<AgentSignals> = {}): AgentSignals {
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
    ...extra,
  }
}

const ENTER_CELL: Vec3Json = { x: 26, y: 67, z: 9 }

function entryPlanFor(enterCell: Vec3Json): PortalEntryPlan {
  return {
    ok: true,
    candidate: {
      id: `ENTER:${enterCell.x},${enterCell.y},${enterCell.z}`,
      portalCells: [
        { x: enterCell.x, y: enterCell.y, z: enterCell.z },
        { x: enterCell.x + 1, y: enterCell.y, z: enterCell.z },
      ],
      enterCell,
      dimension: NETHER,
      line: `PORTAL_ENTRY enter=${enterCell.x},${enterCell.y},${enterCell.z}`,
    },
  }
}

function queuedPlace(enterCell: Vec3Json): QueuedGoal {
  return {
    id: 'g-portal-entered',
    kind: 'place',
    description: 'portal_entered nether_portal',
    targetItem: 'nether_portal',
    requiredCount: 1,
    targetPredicate: PORTAL_ENTERED_PREDICATE,
    dimension: NETHER,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'mechanical',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function queuedCollect(item: string): QueuedGoal {
  return {
    id: `g-collect-${item}`,
    kind: 'collect',
    description: `collect 1 x ${item}`,
    targetItem: item,
    requiredCount: 1,
    targetPredicate: null,
    dimension: OVERWORLD,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'mechanical',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function queueWith(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

interface WorldSpec {
  feet: Vec3Json
  standable?: Vec3Json[]
  descent?: DescentOption[]
  counts?: Record<string, number>
  routes?: AgentSignals['zeroProgressRoutes']
  current?: QueuedGoal
  enterCell?: Vec3Json
  knownResources?: AgentSignals['knownResources']
}

function worldState(spec: WorldSpec): WorldState {
  const feet = spec.feet
  const current = spec.current ?? queuedPlace(spec.enterCell ?? ENTER_CELL)
  return {
    schemaVersion: 1,
    tick: 9,
    timestampMs: 1_700_000_000_000,
    self: self(feet),
    inventory: inventory(spec.counts ?? {}),
    entities: [],
    blocks: [],
    terrain: { standable: spec.standable ?? [feet] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    portalFrameSites: [],
    descent: spec.descent ?? [],
    stepCuts: [],
    headroomCuts: [],
    goal: {
      id: 'g',
      description: current.description,
      targetItem: current.targetItem ?? '',
      requiredCount: 1,
      startCount: 0,
      haveCount: 0,
      progress: 0,
      complete: false,
      startedAtMs: 0,
    },
    goalQueue: queueWith(current),
    recentEvents: [],
    signals: signals({
      ...(spec.routes === undefined ? {} : { zeroProgressRoutes: spec.routes }),
      ...(spec.knownResources === undefined ? {} : { knownResources: spec.knownResources }),
    }),
  }
}

function optionsFor(state: WorldSpec): CandidateOptions {
  return {
    ...defaultCandidateOptions,
    portalEntry: entryPlanFor(state.enterCell ?? ENTER_CELL),
    // The live affordance gate fact for a sealed body: the canDig=false
    // pathfinder finds no path to anything.
    reachability: { pathProbe: () => 'no_path' },
  }
}

/** The controller's own recording path for a settled path-stage failure. */
function spendEntryRoute(state: WorldState, options: CandidateOptions, enterCell: Vec3Json): AgentSignals['zeroProgressRoutes'] {
  const fresh = entryCandidates(state, options)
  const entry = fresh.candidates.find((candidate) => candidate.kind === 'ENTER_PORTAL') ?? fresh.candidates[0]
  if (entry === undefined) throw new Error('fixture: no ENTER candidate to spend')
  return observeZeroProgressRoute(undefined, {
    kind: 'ENTER_PORTAL',
    targetKey: cellKey(enterCell),
    standKey: cellKey(state.self.position),
    routeSig: routeSignature({ kind: entry.kind, id: entry.id, meta: entry.meta }),
    reason: 'path_no_path',
    nowMs: state.timestampMs,
  }).routes
}

function digCandidates(candidates: readonly Candidate[]): Candidate[] {
  return candidates.filter((candidate) => candidate.meta.digRoute === true)
}

// ---------------------------------------------------------------------------
// (a) THE MEASURED SHAPE: sealed 1-wide shaft at y=66, target 13 blocks EAST at
// the same level, solid rock between. A grounded DIG route must be offered and
// the distance to the target must strictly decrease as the body advances.
// ---------------------------------------------------------------------------
{
  const FEET: Vec3Json = { x: 11, y: 66, z: 24 }
  const TARGET: Vec3Json = { x: 24, y: 66, z: 24 }
  const counts = { wooden_pickaxe: 1 }
  const base = worldState({
    feet: FEET,
    descent: shaftDescent(FEET),
    counts,
    current: queuedPlace(TARGET),
    enterCell: TARGET,
  })
  const options = optionsFor({ ...base, feet: FEET, enterCell: TARGET } as WorldSpec)
  const spent = spendEntryRoute(base, options, TARGET)
  const sealed = worldState({ feet: FEET, descent: shaftDescent(FEET), counts, current: queuedPlace(TARGET), enterCell: TARGET, routes: spent })

  const offered = entryCandidates(sealed, options)
  const dig = offered.candidates.find((candidate) => candidate.meta.digRoute === true)
  const walkLeg = offered.candidates.find((candidate) => candidate.meta.approachLeg !== undefined)
  check(
    '(a) a sealed body with no sensed standable frontier grounds a DIG route toward the target',
    dig !== undefined &&
      walkLeg === undefined &&
      dig.kind === 'DESCEND' &&
      dig.meta.mode === 'level' &&
      dig.meta.dir === 'E' &&
      dig.meta.digRouteKind === 'shaft_exit' &&
      dig.target !== null &&
      key(dig.target) === '12,66,24',
    `offer=[${offered.candidates.map((candidate) => candidate.id).join(',')}] kind=${String(dig?.meta.digRouteKind)} dir=${String(dig?.meta.dir)} cell=${dig?.target === null || dig?.target === undefined ? 'none' : key(dig.target)}`,
  )
  check(
    '(a) the offered route claims a strict distance decrease (from_d > to_d) and names cell/block/kind',
    dig !== undefined &&
      typeof dig.meta.digRouteFrom === 'number' &&
      typeof dig.meta.digRouteTo === 'number' &&
      dig.meta.digRouteTo < dig.meta.digRouteFrom &&
      dig.meta.digRouteFrom === 13 &&
      dig.meta.digRouteTo === 12 &&
      dig.meta.digRouteBlock === 'stone' &&
      typeof dig.meta.digRouteLine === 'string' &&
      (dig.meta.digRouteLine as string).startsWith('DIG_ROUTE reason=no_walkable_route target=24,66,24 bearing=E cell=12,66,24 block=stone kind=shaft_exit'),
    `from=${String(dig?.meta.digRouteFrom)} to=${String(dig?.meta.digRouteTo)} block=${String(dig?.meta.digRouteBlock)} line=${String(dig?.meta.digRouteLine)}`,
  )

  // The affordance gate must PRESENT it (a DESCEND is grounded by the sensor's
  // own safety facts, not by a canDig=false path) and the guard must accept it.
  const grounded = generateGroundedCandidates(sealed, options)
  const presented = digCandidates(grounded.candidates)
  const guardContext: GuardContext = {
    phase: 'decision',
    candidateIds: new Set(grounded.candidates.map((candidate) => candidate.id)),
    inFlight: null,
    reach: options.reach,
    maxCandidateAgeTicks: 40,
  }
  const verdict = presented[0] === undefined ? null : guardCandidate(presented[0], sealed, guardContext)
  check(
    '(a) the gate presents the dig route (no walkable path needed) and the guard accepts it',
    presented.length === 1 &&
      grounded.withheld.every((entry) => entry.candidate.meta.digRoute !== true) &&
      verdict !== null &&
      verdict.ok === true,
    `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}] withheld=[${grounded.withheld.map((entry) => entry.candidate.id).join(',') || 'none'}] guard=${verdict === null ? 'none' : verdict.ok ? 'ok' : verdict.reason}`,
  )

  // Advance the body through the MEASURED offer cycle, re-sensing every tick:
  // the goal's own route is re-offered from each new stand cell, the executor
  // proves it dead (`path_no_path`) and the controller spends it, so the next
  // tick offers the dig route. The distance must STRICTLY decrease on every dig
  // step and the cycle must terminate (arrival: the ordinary walk owns the last
  // block).
  const distances: number[] = [distance(FEET, TARGET)]
  let cursor = FEET
  let routes = spent
  let digSteps = 0
  let terminated = false
  for (let guard = 0; guard < 60 && !terminated; guard += 1) {
    const tick = worldState({ feet: cursor, descent: shaftDescent(cursor), counts, current: queuedPlace(TARGET), enterCell: TARGET, routes })
    const stepOffer = entryCandidates(tick, options)
    const stepDig = stepOffer.candidates.find((candidate) => candidate.meta.digRoute === true)
    if (stepDig !== undefined && stepDig.target !== null) {
      const to = stepDig.target
      distances.push(distance(to, TARGET))
      cursor = to
      digSteps += 1
      continue
    }
    const entry = stepOffer.candidates.find((candidate) => candidate.kind === 'ENTER_PORTAL')
    if (entry !== undefined) {
      // The controller's own recording path for the settled path-stage failure.
      routes = observeZeroProgressRoute(routes, {
        kind: 'ENTER_PORTAL',
        targetKey: cellKey(entry.target ?? TARGET),
        standKey: cellKey(cursor),
        routeSig: routeSignature({ kind: entry.kind, id: entry.id, meta: entry.meta }),
        reason: 'path_no_path',
        nowMs: tick.timestampMs,
      }).routes
      continue
    }
    const decision = planDigRoute({ selfPosition: cursor, target: TARGET, descent: shaftDescent(cursor) })
    terminated = decision.kind === 'refuse' && decision.refusal.reason === 'arrived'
    break
  }
  const strictlyDecreasing = distances.every((value, index) => index === 0 || value < (distances[index - 1] ?? Number.POSITIVE_INFINITY))
  check(
    '(a) the distance to the target strictly decreases as the body advances, and the route terminates',
    strictlyDecreasing && terminated && digSteps === 12 && (distances[distances.length - 1] ?? 99) <= DIG_ROUTE_ARRIVE_DISTANCE,
    `dig_steps=${digSteps} distances=[${distances.map(round2).join(' -> ')}] terminated=${terminated}`,
  )
}

// ---------------------------------------------------------------------------
// (a2) THE LIVE BEARING: body (11.7,66,24.8) sealed, enter cell (26,67,9) - 13
// east, 15 north and one block up. The route must pick the direction that
// reduces the distance most and report the live `+1 y` target honestly.
// ---------------------------------------------------------------------------
{
  const FEET: Vec3Json = { x: 11, y: 66, z: 24 }
  const TARGET = ENTER_CELL
  const counts = { diamond_pickaxe: 1 }
  const base = worldState({ feet: FEET, descent: shaftDescent(FEET), counts, enterCell: TARGET })
  const options = optionsFor({ feet: FEET, enterCell: TARGET } as WorldSpec)
  const spent = spendEntryRoute(base, options, TARGET)
  const tick = worldState({ feet: { x: 11.7, y: 66, z: 24.8 }, descent: shaftDescent(FEET), counts, enterCell: TARGET, routes: spent })
  const offered = entryCandidates(tick, options)
  const dig = offered.candidates.find((candidate) => candidate.meta.digRoute === true)
  const from = typeof dig?.meta.digRouteFrom === 'number' ? dig.meta.digRouteFrom : Number.NaN
  const to = typeof dig?.meta.digRouteTo === 'number' ? dig.meta.digRouteTo : Number.NaN
  const liveDistance = distance(FEET, TARGET)
  check(
    '(a2) live bearing: a shaft_exit toward the gate strictly reduces the 3D distance',
    dig !== undefined &&
      dig.meta.digRouteKind === 'shaft_exit' &&
      dig.meta.digRouteTarget === '26,67,9' &&
      Number.isFinite(from) &&
      Number.isFinite(to) &&
      to < from &&
      from === round2(liveDistance) &&
      (dig.meta.digRouteBearing === 'N' || dig.meta.digRouteBearing === 'E'),
    `bearing=${String(dig?.meta.digRouteBearing)} from=${String(dig?.meta.digRouteFrom)} to=${String(dig?.meta.digRouteTo)} live=${round2(liveDistance)}`,
  )
  const placed = generateGroundedCandidates(tick, options)
  check(
    '(a2) the live-shape dig route is offered as a productive candidate (not withheld, not starved)',
    placed.candidates.some((candidate) => candidate.meta.digRoute === true) &&
      placed.candidates.some((candidate) => candidate.kind === 'DESCEND'),
    `presented=[${placed.candidates.map((candidate) => candidate.id).join(',')}]`,
  )
}

// ---------------------------------------------------------------------------
// (b) NO TOOL for the intervening block: the stone needs a pickaxe. The route is
// refused with the typed reason and the arm keeps its existing bounded
// escalation - no invented route, no substitute loop.
// ---------------------------------------------------------------------------
{
  const FEET: Vec3Json = { x: 11, y: 66, z: 24 }
  const TARGET: Vec3Json = { x: 24, y: 66, z: 24 }
  const base = worldState({ feet: FEET, descent: shaftDescent(FEET), counts: {}, enterCell: TARGET })
  const options = optionsFor({ feet: FEET, enterCell: TARGET } as WorldSpec)
  const spent = spendEntryRoute(base, options, TARGET)
  const tick = worldState({ feet: FEET, descent: shaftDescent(FEET), counts: {}, enterCell: TARGET, routes: spent })
  const offered = entryCandidates(tick, options)
  const grounded = generateGroundedCandidates(tick, options)
  const refusal = grounded.digRefusals.find((entry) => entry.reason === 'no_tool')
  check(
    '(b) no tool for the intervening stone: typed no_tool refusal and no invented dig route',
    refusal !== undefined &&
      refusal.block === 'stone' &&
      digCandidates(grounded.candidates).length === 0 &&
      digCandidates(offered.candidates).length === 0 &&
      offered.refusal?.reason === 'all_routes_spent',
    `refusals=[${grounded.digRefusals.map((entry) => `${entry.reason}:${entry.block ?? 'none'}`).join(',')}] offer=[${offered.candidates.map((candidate) => candidate.id).join(',')}] refusal=${offered.refusal?.line ?? 'none'}`,
  )
  check(
    '(b) the typed refusal line names the cause, the bearing and the target',
    refusal !== undefined &&
      formatDigRouteRefused(refusal).startsWith('DIG_ROUTE_REFUSED reason=no_tool target=24,66,24 bearing=E cell=12,66,24 block=stone'),
    refusal === undefined ? 'no refusal' : formatDigRouteRefused(refusal),
  )
}

// ---------------------------------------------------------------------------
// (c) HAZARD / OPEN FLOOR in the bearing: the sensor's own refusal is carried,
// never overridden by a dig the body cannot survive.
// ---------------------------------------------------------------------------
{
  const FEET: Vec3Json = { x: 11, y: 66, z: 24 }
  const TARGET: Vec3Json = { x: 24, y: 66, z: 24 }
  const counts = { diamond_pickaxe: 1 }
  const lava: ShaftSpec = { faults: { 'E:level': { reason: 'hazard', block: 'lava' }, 'E:down': { reason: 'hazard', block: 'lava' } } }
  const base = worldState({ feet: FEET, descent: shaftDescent(FEET, lava), counts, enterCell: TARGET })
  const options = optionsFor({ feet: FEET, enterCell: TARGET } as WorldSpec)
  const spent = spendEntryRoute(base, options, TARGET)
  const hazardTick = worldState({ feet: FEET, descent: shaftDescent(FEET, lava), counts, enterCell: TARGET, routes: spent })
  const hazardOffer = entryCandidates(hazardTick, options)
  const hazardGrounded = generateGroundedCandidates(hazardTick, options)
  check(
    '(c) lava in the bearing: typed hazard refusal, no dig route',
    hazardGrounded.digRefusals.some((entry) => entry.reason === 'hazard') &&
      digCandidates(hazardOffer.candidates).length === 0 &&
      hazardOffer.refusal?.reason === 'all_routes_spent',
    `refusals=[${hazardGrounded.digRefusals.map((entry) => entry.reason).join(',')}] refusal=${hazardOffer.refusal?.line ?? 'none'}`,
  )

  const openFloor: ShaftSpec = { faults: { 'E:level': { reason: 'no_support' }, 'E:down': { reason: 'open_floor' } } }
  const base2 = worldState({ feet: FEET, descent: shaftDescent(FEET, openFloor), counts, enterCell: TARGET })
  const spent2 = spendEntryRoute(base2, options, TARGET)
  const floorTick = worldState({ feet: FEET, descent: shaftDescent(FEET, openFloor), counts, enterCell: TARGET, routes: spent2 })
  const floorGrounded = generateGroundedCandidates(floorTick, options)
  check(
    '(c) an unsupported floor in the bearing: typed no_support refusal (a dig cannot create a floor)',
    floorGrounded.digRefusals.some((entry) => entry.reason === 'no_support'),
    `refusals=[${floorGrounded.digRefusals.map((entry) => `${entry.reason}:${entry.cell === null ? 'none' : key(entry.cell)}`).join(',')}]`,
  )
}

// ---------------------------------------------------------------------------
// (d) A WALKABLE ROUTE EXISTS: the MOVE/ACCESS/ENTER path is untouched and no
// dig route is offered. When the target's own route is spent, the walk leg is
// still the SAME candidate and still first.
// ---------------------------------------------------------------------------
{
  const FEET: Vec3Json = { x: 11, y: 66, z: 24 }
  const TARGET: Vec3Json = { x: 24, y: 66, z: 24 }
  const SIDE: Vec3Json = { x: 12, y: 66, z: 24 }
  const FRONTIER: Vec3Json = { x: 13, y: 66, z: 24 }
  const counts = { diamond_pickaxe: 1 }
  const walkable = [FEET, SIDE, FRONTIER]
  const base = worldState({ feet: FEET, descent: shaftDescent(FEET), counts, enterCell: TARGET, standable: walkable })
  const options = optionsFor({ feet: FEET, enterCell: TARGET } as WorldSpec)
  const fresh = entryCandidates(base, options)
  check(
    '(d) an unspent route with a walkable frontier is unchanged: exactly the ENTER candidate, no dig route',
    fresh.candidates.length === 1 &&
      fresh.candidates[0]?.kind === 'ENTER_PORTAL' &&
      digCandidates(fresh.candidates).length === 0,
    `offer=[${fresh.candidates.map((candidate) => candidate.id).join(',')}]`,
  )

  // The gate agrees while the walk is genuinely feasible: with a REACHABLE path
  // probe the entry is presented and no dig route is grounded at all.
  const walkableOptions: CandidateOptions = {
    ...defaultCandidateOptions,
    portalEntry: entryPlanFor(TARGET),
    reachability: { pathProbe: () => 'reachable' },
  }
  const walkableGrounded = generateGroundedCandidates(base, walkableOptions)
  check(
    '(d) a feasible walk presents the ENTER path and grounds no dig route (no terrain change needed)',
    walkableGrounded.candidates.some((candidate) => candidate.kind === 'ENTER_PORTAL') &&
      digCandidates(walkableGrounded.candidates).length === 0 &&
      walkableGrounded.digRefusals.length === 0,
    `presented=[${walkableGrounded.candidates.map((candidate) => candidate.id).join(',')}] refusals=${walkableGrounded.digRefusals.length}`,
  )

  const spent = spendEntryRoute(base, options, TARGET)
  const spentTick = worldState({ feet: FEET, descent: shaftDescent(FEET), counts, enterCell: TARGET, standable: walkable, routes: spent })
  const after = entryCandidates(spentTick, options)
  const leg = after.candidates[0]
  check(
    '(d) a spent route keeps the walk leg first and unchanged (the dig route never replaces it)',
    leg !== undefined &&
      leg.kind === 'MOVE' &&
      leg.id === 'MOVE:p13_66_24' &&
      leg.meta.approachLeg === 'route_spent' &&
      leg.target !== null &&
      key(leg.target) === key(FRONTIER),
    `offer=[${after.candidates.map((candidate) => candidate.id).join(',')}] first=${leg?.id ?? 'none'}`,
  )
  const tunnel = after.candidates.find((candidate) => candidate.meta.digRoute === true)
  check(
    '(d) with a standable frontier beyond its own cell the same step is spelled as a tunnel, still strictly closer',
    tunnel !== undefined &&
      tunnel.meta.digRouteKind === 'tunnel' &&
      typeof tunnel.meta.digRouteFrom === 'number' &&
      typeof tunnel.meta.digRouteTo === 'number' &&
      tunnel.meta.digRouteTo < tunnel.meta.digRouteFrom,
    `kind=${String(tunnel?.meta.digRouteKind)} from=${String(tunnel?.meta.digRouteFrom)} to=${String(tunnel?.meta.digRouteTo)}`,
  )
}

// ---------------------------------------------------------------------------
// (e) A GENUINE SUCCESS CLEARS THE BUDGET AS TODAY: a dig route that already
// proved zero observable change from this stand cell is withheld (typed
// `spent`), and the verified-success clear re-grounds it.
// ---------------------------------------------------------------------------
{
  const FEET: Vec3Json = { x: 11, y: 66, z: 24 }
  const TARGET: Vec3Json = { x: 24, y: 66, z: 24 }
  const counts = { diamond_pickaxe: 1 }
  const base = worldState({ feet: FEET, descent: shaftDescent(FEET), counts, enterCell: TARGET })
  const options = optionsFor({ feet: FEET, enterCell: TARGET } as WorldSpec)
  const spentEntry = spendEntryRoute(base, options, TARGET)
  const eLevel = shaftDescent(FEET).find((entry) => entry.mode === 'level' && entry.dir === 'E')
  const eDown = shaftDescent(FEET).find((entry) => entry.mode === 'down' && entry.dir === 'E')
  if (eLevel === undefined || eDown === undefined) throw new Error('fixture: no east steps')
  const spendDig = (
    routes: AgentSignals['zeroProgressRoutes'],
    step: DescentOption,
  ): AgentSignals['zeroProgressRoutes'] => {
    // The route identity is exactly the one the offer computes: the primary cell
    // (`descentPrimaryCell`) is the wall for a level step and the floor for a
    // down step.
    const primary = descentPrimaryCell(step)
    return observeZeroProgressRoute(routes, {
      kind: 'DESCEND',
      targetKey: cellKey(primary),
      standKey: cellKey(FEET),
      routeSig: routeSignature({
        kind: 'DESCEND',
        id: `DESCEND:${step.mode}:${step.dir}:b${primary.x}_${primary.y}_${primary.z}`,
        meta: { mode: step.mode, dir: step.dir, digX: primary.x, digY: primary.y, digZ: primary.z, stepX: step.step.x, stepY: step.step.y, stepZ: step.step.z },
      }),
      reason: 'path_stuck',
      nowMs: base.timestampMs,
    }).routes
  }
  // Both distance-reducing steps the sensor offers (the level tunnel and the
  // down staircase) proved zero observable change from this stand cell.
  const spentOne = spendDig(spentEntry, eLevel)
  const spentDig = spendDig(spentOne, eDown)
  const spentTick = worldState({ feet: FEET, descent: shaftDescent(FEET), counts, enterCell: TARGET, routes: spentDig })
  const after = entryCandidates(spentTick, options)
  const groundedAfter = generateGroundedCandidates(spentTick, options)
  check(
    '(e) every dig step that already proved zero change at this stand cell is withheld with the typed spent reason',
    digCandidates(after.candidates).length === 0 &&
      groundedAfter.digRefusals.some((entry) => entry.reason === 'spent') &&
      after.refusal?.reason === 'all_routes_spent',
    `offer=[${after.candidates.map((candidate) => candidate.id).join(',')}] refusals=[${groundedAfter.digRefusals.map((entry) => entry.reason).join(',')}]`,
  )

  // Exactly the clear the controller performs on a VERIFIED settle
  // (`controller-legacy.ts#recordZeroProgressOutcome` -> `clearZeroProgressStand`).
  const cleared = clearZeroProgressStand(spentDig, 'DESCEND', cellKey(FEET))
  const reopenedTick = worldState({ feet: FEET, descent: shaftDescent(FEET), counts, enterCell: TARGET, routes: cleared })
  const reopened = entryCandidates(reopenedTick, options)
  check(
    '(e) a genuine success clears the stand memory and the same dig route is offered again',
    digCandidates(reopened.candidates).length === 1,
    `offer=[${reopened.candidates.map((candidate) => candidate.id).join(',')}]`,
  )
}

// ---------------------------------------------------------------------------
// (f) NOT PORTAL-SPECIFIC: the same affordance grounds for a remembered RESOURCE
// retrieve whose route was spent, with no portal goal or M3 vocabulary anywhere.
// ---------------------------------------------------------------------------
{
  const FEET: Vec3Json = { x: 11, y: 40, z: 24 }
  const ORE: Vec3Json = { x: 24, y: 40, z: 24 }
  const counts = { diamond_pickaxe: 1 }
  const current = queuedCollect('raw_iron')
  const known: AgentSignals['knownResources'] = [{ name: 'iron_ore', position: ORE, kind: 'ore' }]
  const base = worldState({
    feet: FEET,
    descent: shaftDescent(FEET),
    counts,
    current,
    knownResources: known,
  })
  const wantState = worldState({
    feet: FEET,
    descent: shaftDescent(FEET),
    counts,
    current,
    knownResources: known,
  })
  const options: CandidateOptions = { ...defaultCandidateOptions, reachability: { pathProbe: () => 'no_path' } }
  // The retrieval route's IDENTITY is read with a feasible walk probe (it is the
  // same candidate either way); the spent state is then evaluated with the
  // `no_path` probe the live sealed body reports.
  const reachableOptions: CandidateOptions = {
    ...defaultCandidateOptions,
    reachability: { pathProbe: () => 'reachable' },
  }
  const fresh = generateGroundedCandidates(wantState, reachableOptions)
  const route = fresh.candidates.find((candidate) => candidate.kind === 'RETRIEVE')
  const routeSig =
    route === undefined ? 'none' : routeSignature({ kind: 'RETRIEVE', id: route.id, meta: route.meta })
  const spent = observeZeroProgressRoute(undefined, {
    kind: 'RETRIEVE',
    targetKey: cellKey(ORE),
    standKey: cellKey(FEET),
    routeSig,
    reason: 'path_stuck',
    nowMs: base.timestampMs,
  }).routes
  const spentState = worldState({
    feet: FEET,
    descent: shaftDescent(FEET),
    counts,
    current,
    knownResources: known,
    routes: spent,
  })
  const grounded = generateGroundedCandidates(spentState, options)
  const dig = digCandidates(grounded.candidates)[0]
  check(
    '(f) a spent remembered-resource route grounds the same dig route toward the ore (no portal branch)',
    route !== undefined &&
      dig !== undefined &&
      dig.kind === 'DESCEND' &&
      dig.meta.digRouteTarget === '24,40,24' &&
      dig.meta.digRouteKind === 'shaft_exit' &&
      typeof dig.meta.digRouteFrom === 'number' &&
      typeof dig.meta.digRouteTo === 'number' &&
      dig.meta.digRouteTo < dig.meta.digRouteFrom,
    `retrieve=${route?.id ?? 'none'} offer=[${grounded.candidates.map((candidate) => candidate.id).join(',')}] dig=${dig === undefined ? 'none' : String(dig.meta.digRouteLine)}`,
  )
}

// ---------------------------------------------------------------------------
// the marker vocabulary itself is stable and typed (the resident log is the
// evidence surface, so the exact line shape is part of the contract).
// ---------------------------------------------------------------------------
{
  const FEET: Vec3Json = { x: 11, y: 66, z: 24 }
  const TARGET: Vec3Json = { x: 24, y: 66, z: 24 }
  const decision = planDigRoute({ selfPosition: FEET, target: TARGET, descent: shaftDescent(FEET), sealed: true })
  const line = decision.kind === 'route' ? formatDigRoute(decision.route, 'no_walkable_route', TARGET) : 'none'
  check(
    '(markers) DIG_ROUTE carries reason/target/bearing/cell/block/kind/from_d/to_d',
    decision.kind === 'route' &&
      line === 'DIG_ROUTE reason=no_walkable_route target=24,66,24 bearing=E cell=12,66,24 block=stone kind=shaft_exit mode=level from_d=13 to_d=12',
    line,
  )
}

// ---------------------------------------------------------------------------
// the controller wiring: the markers must be reachable from the live loop, so
// the resident log can show the dig route, its typed refusal, and the measured
// distance gain (the measured run showed none of them).
// ---------------------------------------------------------------------------
{
  const source = readFileSync(new URL('./src/controller-legacy.ts', import.meta.url), 'utf8')
  const candidatesSource = readFileSync(new URL('./src/candidates.ts', import.meta.url), 'utf8')
  const checks: Array<[string, boolean]> = [
    ['DIG_ROUTE logged when selected', /if \(guarded\.candidate\.meta\.digRoute === true\) this\.logDigRoute\(guarded\.candidate\)/.test(source)],
    ['DIG_ROUTE_PROGRESS on a settled step', /if \(candidate\.meta\.digRoute === true\) this\.logDigRouteProgress\(result, candidate\)/.test(source)],
    ['DIG_ROUTE_REFUSED from the offer', /this\.logDigRouteRefusals\(grounded\.digRefusals\)/.test(source)],
    ['DIG_ROUTE mirrored', /const MIRRORED_MARKERS[\s\S]*?'DIG_ROUTE'/.test(source)],
    ['DIG_ROUTE_REFUSED mirrored', /const MIRRORED_MARKERS[\s\S]*?'DIG_ROUTE_REFUSED'/.test(source)],
    ['DIG_ROUTE_PROGRESS mirrored', /const MIRRORED_MARKERS[\s\S]*?'DIG_ROUTE_PROGRESS'/.test(source)],
    ['dig refusal reaches starvation evidence', /const digToken = `dig_route:\$\{refusal\.reason\}`/.test(source)],
    ['dig route grounded beside the spent route', /const legs = travelApproachLegs\(/.test(candidatesSource)],
    ['dig route withheld once spent', /isZeroProgressRouteRepeat\(state\.signals\.zeroProgressRoutes, \{\s*\n\s*kind: 'DESCEND',/.test(candidatesSource)],
    ['dig route offered to a withheld locomotion target', /reason: 'route_withheld'/.test(candidatesSource)],
  ]
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name)
  check(
    '(wiring) the controller and the offer are wired for DIG_ROUTE / DIG_ROUTE_REFUSED / DIG_ROUTE_PROGRESS',
    failed.length === 0,
    failed.length === 0 ? 'all markers wired' : `missing: ${failed.join(', ')}`,
  )
}

process.stdout.write(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURE(S)\n`)
process.exit(failures === 0 ? 0 : 1)
