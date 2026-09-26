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
  generateCandidates,
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
  /** the front cell at feet level is open (a hole/dip in front, not a wall) */
  wallSolid?: boolean
  /** the head cell above the front cell is open */
  headSolid?: boolean
}

interface ShaftSpec {
  /** typed refusal per `dir:mode` (e.g. `E:level`), as `buildDescent` records it */
  faults?: Record<string, StepFault>
  /** block name of the dug cell, default stone */
  block?: string
  /** harvest tool of the dug cell, default pickaxe tier 0 (stone) */
  harvestTool?: string | null
  harvestTier?: number
  /** per-direction overrides (e.g. the gate's own obsidian column on `E`) */
  dirSpec?: Record<string, { block?: string; harvestTool?: string | null; harvestTier?: number }>
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
    wallSolid: fault?.wallSolid ?? true,
    headSolid: fault?.headSolid ?? true,
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
    const merged: ShaftSpec = { ...spec, ...(spec.dirSpec?.[dir] ?? {}) }
    out.push(stepOption(feet, dir, dx, dz, 'level', spec.faults?.[`${dir}:level`], merged))
    out.push(stepOption(feet, dir, dx, dz, 'down', spec.faults?.[`${dir}:down`], merged))
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
  /** the controller's move-failure memory seed (live `MOVE_FAILMEM key=... attempts=n`) */
  failedCandidates?: Record<string, number>
  /** live-structure member cells (the #436 U5 protected-resource fact) */
  liveStructureMembers?: NonNullable<WorldState['liveStructureMembers']>
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
    ...(spec.liveStructureMembers === undefined ? {} : { liveStructureMembers: spec.liveStructureMembers }),
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
      ...(spec.failedCandidates === undefined ? {} : { failedCandidates: spec.failedCandidates }),
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
  const counts = {}
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
// (b) A route clears intervening stone without requiring the drops. Resource
// mining remains strict elsewhere; this candidate only changes terrain.
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
  const route = digCandidates(offered.candidates)[0]
  check(
    '(b) the stone route is offered as clearance without a pickaxe drop gate',
    route !== undefined &&
      route.meta.clearance === true &&
      route.requiresTool === false &&
      route.toolName === null &&
      digCandidates(grounded.candidates).some((candidate) => candidate.meta.clearance === true),
    `refusals=[${grounded.digRefusals.map((entry) => `${entry.reason}:${entry.block ?? 'none'}`).join(',')}] offer=[${offered.candidates.map((candidate) => candidate.id).join(',')}]`,
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
  // #14: remembered cells name the world they were recorded in; this fixture body
  // is in the overworld (an un-attributed row is refused in every world).
  const known: AgentSignals['knownResources'] = [{ name: 'iron_ore', position: ORE, kind: 'ore', dimension: 'minecraft:overworld' }]
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
// (i) THE MEASURED POCKET CONTINUATION (run-mucbyro1-1hqhm). World truth (chunk
// (1,0) y63-69, tools/world-truth-plane.mjs): body (24,67,9) feet y=67 on
// cobblestone; E (25,67,9) = the gate's own obsidian column; S (24,67,10) air
// over (24,66,10) air over (24,65,10) grass = a 1-block HOLE; the waypoint
// (26,67,10) is standable over the dirt at (25,66,10). A walk-only BFS over that
// grid reaches the interior in 4 moves with NO dig and NO placement:
//   (24,67,9) -drop S-> (24,66,10) -step up E onto (25,66,10)-> (25,67,10)
//   -> (26,67,10) -> (26,67,9)
// `MOVE:p26_67_10` therefore carries the continuation as the SAME
// `vertical=staircase-up` contract the up-staircase uses, instead of failing
// `outcome=stuck` with an empty contract.
// ---------------------------------------------------------------------------
{
  const FEET: Vec3Json = { x: 24, y: 67, z: 9 }
  const TARGET: Vec3Json = { x: 26, y: 67, z: 9 }
  // The live state: the ordinary leg was tried and exhausted
  // (`MOVE_FAILMEM actionId=MOVE:p26_67_10 key=overworld:26,67,10 attempts=8
  // reason=stuck`), which is why the continuation has to exist at all.
  const exhausted = { 'MOVE:p26_67_10': 8 }
  const VIA: Vec3Json = { x: 24, y: 66, z: 10 }
  const LANDING: Vec3Json = { x: 25, y: 67, z: 10 }
  const WAYPOINT: Vec3Json = { x: 26, y: 67, z: 10 }
  const counts = { wooden_pickaxe: 1, cobblestone: 402 }
  const spec: ShaftSpec = {
    dirSpec: { E: { block: 'obsidian', harvestTier: 4 } },
    // the south column is a HOLE: the front/head cells are open and the sensor
    // refuses the level step as `no_support` while the drop onto the grass floor
    // below is a controlled one-block fall (`open_floor` + solid support).
    faults: {
      'S:level': { reason: 'no_support' },
      'S:down': { reason: 'open_floor', wallSolid: false, headSolid: false },
    },
  }
  const descent = shaftDescent(FEET, spec)
  const standable = [FEET, VIA, LANDING, WAYPOINT]
  const portalMembers = [
    { kind: 'nether_portal' as const, position: { x: 25, y: 67, z: 9 } },
    { kind: 'nether_portal' as const, position: { x: 25, y: 68, z: 9 } },
  ]
  const current = queuedPlace(TARGET)
  const base = worldState({ feet: FEET, descent, counts, current, enterCell: TARGET, standable, liveStructureMembers: portalMembers })
  const options = optionsFor({ feet: FEET, enterCell: TARGET } as WorldSpec)
  const spent = spendEntryRoute(base, options, TARGET)
  const tick = worldState({
    feet: FEET,
    descent,
    counts,
    current,
    enterCell: TARGET,
    standable,
    routes: spent,
    failedCandidates: exhausted,
    liveStructureMembers: portalMembers,
  })
  const offered = entryCandidates(tick, options)
  const cont = offered.candidates.find((candidate) => candidate.meta.legContinuation === true)
  check(
    '(i1) the measured pocket grounds the step-over first leg into the hole floor, naming the ledge it opens',
    cont !== undefined &&
      cont.kind === 'MOVE' &&
      cont.meta.legContinuationAction === 'step_over' &&
      cont.meta.legContinuationVia === '24,66,10' &&
      cont.meta.legContinuationLanding === '25,67,10' &&
      cont.meta.legContinuationLedge === '25,66,10' &&
      cont.meta.legContinuationDir === 'E' &&
      cont.meta.vertical === 'none' &&
      cont.target !== null &&
      key(cont.target) === '24,66,10',
    `offer=[${offered.candidates.map((candidate) => candidate.id).join(',')}] target=${cont?.target === null || cont?.target === undefined ? 'none' : key(cont.target)} via=${String(cont?.meta.legContinuationVia)} landing=${String(cont?.meta.legContinuationLanding)} ledge=${String(cont?.meta.legContinuationLedge)}`,
  )
  check(
    '(i1) the unique continuation emits the #436 REFLEX (landed shape) with the block-truth evidence',
    cont !== undefined &&
      typeof cont.meta.legReflex === 'string' &&
      (cont.meta.legReflex as string).startsWith(
        'REFLEX ownerSkill=ENTER_PORTAL(portalSite) reason=unique_binding_prerequisite action=step_over evidence=cell=24,66,10 via=24,66,10 ledge=25,66,10 hole_floor@24,66,10:standable+support_solid;ledge@25,66,10:solid;d=2->1.41',
      ),
    String(cont?.meta.legReflex ?? 'none'),
  )
  check(
    '(i1) the mechanical step marker names the cell, the via, the landing and the ledge',
    cont !== undefined &&
      String(cont.meta.legContinuationLine) ===
        'SKILL_STEP skill=ENTER_PORTAL(portalSite) step=step_over authority=MECHANICAL_CONTINUATION ' +
          'evidence=cell=24,66,10 via=24,66,10 landing=25,67,10 ledge=25,66,10 vertical=none ' +
          'envelope=movement-only(no_dig,no_place) worldDelta=none',
    String(cont?.meta.legContinuationLine ?? 'none'),
  )
  // The continuation strictly closes the distance to the WAYPOINT and, through it,
  // to the interior: the body drops to the hole floor (farther) and the step-up
  // lands strictly closer, so the route as a whole converges.
  const fromD = Math.round(distance(FEET, TARGET) * 100) / 100
  const waypointD = Math.round(distance(FEET, WAYPOINT) * 100) / 100
  const landingD = Math.round(distance(LANDING, TARGET) * 100) / 100
  const viaWaypointD = Math.round(distance(VIA, WAYPOINT) * 100) / 100
  const landingWaypointD = Math.round(distance(LANDING, WAYPOINT) * 100) / 100
  check(
    '(i1) the continuation strictly decreases the distance to the interior (2 -> 1.41)',
    cont !== undefined &&
      typeof cont.meta.legContinuationToD === 'number' &&
      (cont.meta.legContinuationToD as number) < fromD - 0.25 &&
      landingD === 1.41 &&
      viaWaypointD === waypointD &&
      landingWaypointD < viaWaypointD - 0.25,
    `interior ${fromD} -> ${landingD}; waypoint ${waypointD} -> via ${viaWaypointD} -> landing ${landingWaypointD}`,
  )

  // (i2) DEAD END: the same hole, but its floor is NOT a sensed stand (a deep
  // pit) -> no continuation, no invented leg, the existing typed escalation.
  const deepPit = worldState({
    feet: FEET,
    descent,
    counts,
    current,
    enterCell: TARGET,
    // the hole floor is deliberately absent from the sensed standable set
    standable: [FEET, LANDING, WAYPOINT],
    routes: spent,
    failedCandidates: exhausted,
  })
  const pitOffer = entryCandidates(deepPit, options)
  const pitGrounded = generateGroundedCandidates(deepPit, options)
  check(
    '(i2) an unstandable hole floor grounds no continuation: nothing is invented',
    pitOffer.candidates.every((candidate) => candidate.meta.legContinuation !== true) &&
      pitGrounded.candidates.every((candidate) => candidate.meta.legContinuation !== true),
    `offer=[${pitOffer.candidates.map((candidate) => candidate.id).join(',')}] refusal=${pitOffer.refusal?.line ?? 'none'}`,
  )

  // (i3) SEVERAL MEANINGFUL CONTINUATIONS -> both offered, no REFLEX (Jev's WHICH).
  // The hole floor has TWO improving step-up landings, so nothing is picked in code.
  const twoLandings = [FEET, VIA, { x: 25, y: 67, z: 10 }, { x: 24, y: 67, z: 11 }]
  const twoTarget: Vec3Json = { x: 26, y: 67, z: 11 }
  const twoBase = worldState({
    feet: FEET,
    descent,
    counts,
    current: queuedPlace(twoTarget),
    enterCell: twoTarget,
    standable: twoLandings,
  })
  const twoOptions = optionsFor({ feet: FEET, enterCell: twoTarget } as WorldSpec)
  const twoSpent = spendEntryRoute(twoBase, twoOptions, twoTarget)
  const twoTick = worldState({
    feet: FEET,
    descent,
    counts,
    current: queuedPlace(twoTarget),
    enterCell: twoTarget,
    standable: twoLandings,
    routes: twoSpent,
    // the ordinary leg to the new waypoint is exhausted too, so only the two
    // continuations are on offer
    failedCandidates: { 'MOVE:p26_67_11': 8 },
  })
  const twoOffer = entryCandidates(twoTick, twoOptions)
  const conts = twoOffer.candidates.filter((candidate) => candidate.meta.legContinuation === true)
  check(
    '(i3) two meaningful continuations are both offered as ordinary candidates, with no REFLEX',
    conts.length === 2 &&
      conts.every((candidate) => candidate.meta.legReflex === undefined) &&
      conts.filter((candidate) => candidate.meta.legContinuationAction === 'step_over').length === 2,
    `continuations=[${conts.map((candidate) => `${candidate.id}->${candidate.target === null ? 'none' : key(candidate.target)}`).join(',')}] reflex=${conts.map((candidate) => String(candidate.meta.legReflex ?? 'none')).join('|')}`,
  )

  // (i5) THE SITE MATTERS (parent's item 1): the continuation must attach where the
  // entry lane grounds the open face, not only in the generic MOVE arm. In the live
  // chain the entry skill refused `PORTAL_APPROACH_REFUSED ... faces=1` because the
  // unique open face was standable but not walk-reachable, while the generic arm
  // never saw the pocket. Both the unspent and the spent entry offer must carry it.
  const face = WAYPOINT
  const entryState = worldState({
    feet: FEET,
    descent,
    counts,
    current,
    enterCell: TARGET,
    standable,
    liveStructureMembers: portalMembers,
  })
  const normal = entryCandidates(entryState, options)
  const faceLeg = normal.candidates.find((candidate) => candidate.meta.approachLeg === 'portal_open_face')
  const faceCont = normal.candidates.find((candidate) => candidate.meta.legContinuation === true)
  const spentCont = offered.candidates.find((candidate) => candidate.meta.legContinuation === true)
  check(
    '(i5) the open-face site carries the continuation (unspent entry: [ENTER, face leg, continuation])',
    normal.candidates.some((candidate) => candidate.kind === 'ENTER_PORTAL') &&
      faceLeg !== undefined &&
      faceLeg.target !== null &&
      key(faceLeg.target) === key(face) &&
      faceCont !== undefined &&
      faceCont.meta.approachLeg === 'portal_open_face' &&
      faceCont.target !== null &&
      key(faceCont.target) === '24,66,10' &&
      typeof faceCont.meta.legReflex === 'string' &&
      (faceCont.meta.legReflex as string).startsWith(
        'REFLEX ownerSkill=enter_portal reason=unique_binding_prerequisite action=step_over evidence=cell=24,66,10',
      ) &&
      spentCont !== undefined,
    `offer=[${normal.candidates.map((candidate) => candidate.id).join(',')}] faceLeg=${faceLeg === undefined ? 'none' : `${faceLeg.id}->${faceLeg.target === null ? 'none' : key(faceLeg.target)}`} cont=${faceCont === undefined ? 'none' : String(faceCont.id)} reflex=${String(faceCont?.meta.legReflex ?? 'none')}`,
  )

  // (i6) #436 section 19 (8)+(28): THE WALL PRESENTS TWO NON-EQUIVALENT RECOVERIES.
  // The terrain offers a DIG route (a stone tunnel toward the target) AND a
  // MOVEMENT continuation (a verified hole with a step-up landing). Code must not
  // rank them: both are on offer, the boundary is stated with the alternatives, and
  // no REFLEX is emitted (nothing is unique).
  {
    const digTarget: Vec3Json = { x: 26, y: 67, z: 10 }
    const bothCounts = { diamond_pickaxe: 1 }
    const bothBase = worldState({
      feet: FEET,
      descent,
      counts: bothCounts,
      current: queuedPlace(digTarget),
      enterCell: digTarget,
      standable,
    })
    const bothOptions = optionsFor({ feet: FEET, enterCell: digTarget } as WorldSpec)
    const bothSpent = spendEntryRoute(bothBase, bothOptions, digTarget)
    const both = worldState({
      feet: FEET,
      descent,
      counts: bothCounts,
      current: queuedPlace(digTarget),
      enterCell: digTarget,
      standable,
      routes: bothSpent,
      failedCandidates: exhausted,
    })
    const bothOffer = entryCandidates(both, bothOptions)
    const bothDig = bothOffer.candidates.find((candidate) => candidate.meta.digRoute === true)
    const bothCont = bothOffer.candidates.find((candidate) => candidate.meta.legContinuation === true)
    const boundary = bothCont?.meta.legPolicyBoundary ?? bothDig?.meta.legPolicyBoundary
    check(
      '(i6) a wall presenting dig vs step-over offers BOTH and states the policy boundary, never a pick',
      bothDig !== undefined &&
        bothCont !== undefined &&
        typeof boundary === 'string' &&
        (boundary as string).startsWith('SKILL_POLICY_BOUNDARY skill=ENTER_PORTAL(portalSite) reason=multiple_non_equivalent_recoveries alternatives=[') &&
        (boundary as string).includes('dig:route') &&
        (boundary as string).includes('movement:step_over') &&
        bothDig.meta.legReflex === undefined &&
        bothCont.meta.legReflex === undefined,
      `offer=[${bothOffer.candidates.map((candidate) => candidate.id).join(',')}] boundary=${String(boundary ?? 'none')}`,
    )
  }

  // (i7) #436 U5: THE FRAME'S OWN OBSIDIAN IS NEVER MINED. The east dig step runs
  // through a cell the world model holds as a LIVE structure member (the portal
  // frame), so it is refused `protected` even with a pickaxe that could break it.
  {
    const frameColumn = worldState({
      feet: FEET,
      descent,
      counts: { diamond_pickaxe: 1 },
      current,
      enterCell: TARGET,
      standable: [FEET],
      routes: spent,
      failedCandidates: exhausted,
      liveStructureMembers: [
        { kind: 'nether_portal', position: { x: 25, y: 67, z: 9 } },
        { kind: 'nether_portal', position: { x: 25, y: 68, z: 9 } },
      ],
    })
    const frameOffer = entryCandidates(frameColumn, options)
    const frameGrounded = generateGroundedCandidates(frameColumn, options)
    const protectedRefusal = frameGrounded.digRefusals.find((entry) => entry.reason === 'protected')
    check(
      '(i7) a dig step through a live-structure frame cell is refused protected, whatever the tool gate says',
      protectedRefusal !== undefined &&
        frameOffer.candidates.every((candidate) => candidate.meta.digRoute !== true) &&
        protectedRefusal.block === 'obsidian',
      `refusals=[${frameGrounded.digRefusals.map((entry) => `${entry.reason}:${entry.block ?? 'none'}`).join(',')}] offer=[${frameOffer.candidates.map((candidate) => candidate.id).join(',')}]`,
    )
  }

  // (i4) A WALK-REACHABLE WAYPOINT IS UNTOUCHED: the ordinary leg keeps exactly
  // the meta it had (no `vertical`, no continuation, no reflex).
  const walkable = [FEET, WAYPOINT]
  const walkBase = worldState({ feet: FEET, descent, counts, current, enterCell: TARGET, standable: walkable, liveStructureMembers: portalMembers })
  const walkOptions = optionsFor({ feet: FEET, enterCell: TARGET } as WorldSpec)
  const walkSpent = spendEntryRoute(walkBase, walkOptions, TARGET)
  const walkTick = worldState({ feet: FEET, descent, counts, current, enterCell: TARGET, standable: walkable, routes: walkSpent, liveStructureMembers: portalMembers })
  const walkOffer = entryCandidates(walkTick, walkOptions)
  const walkLeg = walkOffer.candidates.find((candidate) => candidate.meta.approachLeg !== undefined)
  check(
    '(i4) a walk-reachable waypoint leaves the ordinary MOVE byte-identical (no contract attached)',
    walkLeg !== undefined &&
      walkLeg.id === 'MOVE:p26_67_10' &&
      walkLeg.meta.vertical === undefined &&
      walkLeg.meta.legContinuation === undefined &&
      walkLeg.meta.legReflex === undefined,
    `offer=[${walkOffer.candidates.map((candidate) => candidate.id).join(',')}] meta=${walkLeg === undefined ? 'none' : JSON.stringify(Object.keys(walkLeg.meta).sort())}`,
  )
}

// ---------------------------------------------------------------------------
// (g) DETOUR: the step that closes the bearing best is refused, and the terrain
// offers another SAFE step that still strictly reduces the distance. That step is
// a valid route - a path may step aside first. The refusal of the best-closing
// step is retained in the marker as the reason it was skipped.
// ---------------------------------------------------------------------------
{
  const FEET: Vec3Json = { x: 11, y: 66, z: 24 }
  // 13 east and 6 south: BOTH the east step (-> 13.42) and the south step
  // (-> 13.93) strictly reduce the 14.32m distance; east closes the bearing best.
  const TARGET: Vec3Json = { x: 24, y: 66, z: 30 }
  const counts = { wooden_pickaxe: 1 }
  const spec: ShaftSpec = { dirSpec: { E: { block: 'obsidian', harvestTier: 4 } } }
  const descent = shaftDescent(FEET, spec)
  const protectedE = [
    { kind: 'nether_portal' as const, position: { x: 12, y: 66, z: 24 } },
    { kind: 'nether_portal' as const, position: { x: 12, y: 67, z: 24 } },
  ]
  // The planner is pure: the tool feasibility of a step arrives as the caller's
  // probe (the same gate `digRouteCandidate` injects in production).
  const probe = (
    step: DescentOption,
  ): { dir: DescentOption['dir']; mode: 'down' | 'level'; reason: 'no_tool' | 'protected'; block: string | null; detail: string } | null =>
    step.digName === 'obsidian'
      ? { dir: step.dir, mode: step.mode, reason: 'protected', block: step.digName, detail: 'live structure member' }
      : null
  const decision = planDigRoute({ selfPosition: FEET, target: TARGET, descent, sealed: false, stepRefusal: probe })
  const route = decision.kind === 'route' ? decision.route : null
  const from = route?.fromDistance ?? Number.NaN
  const to = route?.toDistance ?? Number.NaN
  check(
    '(g) a refused best-closing step yields the next-best strictly-reducing SAFE step as a detour',
    route !== null &&
      route.detour === true &&
      route.skipped !== null &&
      route.skipped.dir === 'E' &&
      route.skipped.reason === 'protected' &&
      route.dir === 'S' &&
      route.mode === 'level' &&
      to < from &&
      formatDigRoute(route, 'no_walkable_route', TARGET).endsWith(' detour=true skipped=E:protected'),
    route === null
      ? `refused=${decision.kind === 'refuse' ? decision.refusal.reason : 'none'}`
      : `dir=${route.dir} from=${round2(route.fromDistance)} to=${round2(route.toDistance)} skipped=${String(route.skipped?.dir)}:${String(route.skipped?.reason)} line=${formatDigRoute(route, 'no_walkable_route', TARGET)}`,
  )
  // The arm grounds it end to end, with the detour facts on the candidate meta.
  const base = worldState({
    feet: FEET,
    descent,
    counts,
    current: queuedPlace(TARGET),
    enterCell: TARGET,
    standable: [FEET, { x: 11, y: 66, z: 22 }],
    liveStructureMembers: protectedE,
  })
  const options = optionsFor({ feet: FEET, enterCell: TARGET } as WorldSpec)
  const spent = spendEntryRoute(base, options, TARGET)
  const tick = worldState({
    feet: FEET,
    descent,
    counts,
    current: queuedPlace(TARGET),
    enterCell: TARGET,
    standable: [FEET, { x: 11, y: 66, z: 22 }],
    routes: spent,
    liveStructureMembers: protectedE,
  })
  const offered = entryCandidates(tick, options)
  const dig = digCandidates(offered.candidates)[0]
  const grounded = generateGroundedCandidates(tick, options)
  check(
    '(g) the arm offers the detour with its skipped primary on the candidate meta',
    dig !== undefined &&
      dig.meta.digRouteDetour === true &&
      dig.meta.digRouteSkipped === 'E:protected' &&
      dig.meta.dir === 'S' &&
      dig.meta.digRouteKind === 'tunnel' &&
      typeof dig.meta.digRouteFrom === 'number' &&
      typeof dig.meta.digRouteTo === 'number' &&
      (dig.meta.digRouteTo as number) < (dig.meta.digRouteFrom as number) &&
      grounded.candidates.some((candidate) => candidate.meta.digRoute === true),
    `offer=[${offered.candidates.map((candidate) => candidate.id).join(',')}] detour=${String(dig?.meta.digRouteDetour)} skipped=${String(dig?.meta.digRouteSkipped)} line=${String(dig?.meta.digRouteLine)}`,
  )
}

// ---------------------------------------------------------------------------
// (h) THE MEASURED M3 POCKET (measured with tools/world-truth-plane.mjs, chunk
// (1,0) y63-69): the body stands on cobblestone at (24,66,9) in a 1-deep pocket,
// feet y=67; EAST is the gate's own obsidian column (25,67,9)+(25,68,9) and the
// interior (26,67,9) is behind it; the only standable open face is SOUTH at
// (26,67,10) over dirt; (24,67,10) has no floor at all (air at y=66).
//
// (h1) LIVE STRUCTURE SAFETY: the east step closes the bearing through the frame's
// own obsidian, so it is protected regardless of the fact that bare-hand clearance
// could remove it without yielding obsidian.
// ---------------------------------------------------------------------------
{
  const FEET: Vec3Json = { x: 24, y: 67, z: 9 }
  const TARGET: Vec3Json = { x: 26, y: 67, z: 9 }
  const counts = { wooden_pickaxe: 1 }
  const spec: ShaftSpec = {
    dirSpec: { E: { block: 'obsidian', harvestTier: 4 } },
    faults: { 'S:level': { reason: 'no_support' } },
  }
  const descent = shaftDescent(FEET, spec)
  const options = optionsFor({ feet: FEET, enterCell: TARGET } as WorldSpec)
  const unprotectedBase = worldState({
    feet: FEET,
    descent,
    counts,
    current: queuedPlace(TARGET),
    enterCell: TARGET,
  })
  const unprotectedRoutes = spendEntryRoute(unprotectedBase, options, TARGET)
  const unprotected = worldState({
    feet: FEET,
    descent,
    counts,
    current: queuedPlace(TARGET),
    enterCell: TARGET,
    routes: unprotectedRoutes,
  })
  const unprotectedOffer = entryCandidates(unprotected, options)
  const unprotectedDig = digCandidates(unprotectedOffer.candidates)[0]
  check(
    '(h0) known obsidian may be cleared without its diamond-pickaxe drop requirement',
    unprotectedDig !== undefined &&
      unprotectedDig.meta.clearance === true &&
      unprotectedDig.requiresTool === false &&
      unprotectedDig.meta.digRouteBlock === 'obsidian',
    `offer=[${unprotectedOffer.candidates.map((candidate) => candidate.id).join(',')}] dig=${unprotectedDig?.id ?? 'none'} clearance=${unprotectedDig?.meta.clearance}`,
  )
  const frameMembers = [
    { kind: 'nether_portal' as const, position: { x: 25, y: 67, z: 9 } },
    { kind: 'nether_portal' as const, position: { x: 25, y: 68, z: 9 } },
  ]
  const base = worldState({
    feet: FEET,
    descent,
    counts,
    current: queuedPlace(TARGET),
    enterCell: TARGET,
    liveStructureMembers: frameMembers,
  })
  const spent = spendEntryRoute(base, options, TARGET)
  const tick = worldState({
    feet: FEET,
    descent,
    counts,
    current: queuedPlace(TARGET),
    enterCell: TARGET,
    routes: spent,
    liveStructureMembers: frameMembers,
  })
  const offered = entryCandidates(tick, options)
  const grounded = generateGroundedCandidates(tick, options)
  const refusal = grounded.digRefusals.find((entry) => entry.reason === 'protected')
  check(
    '(h1) measured pocket frame cells are refused as protected even without a diamond pickaxe',
    digCandidates(offered.candidates).length === 0 &&
      refusal !== undefined &&
      refusal.block === 'obsidian' &&
      refusal.cell !== null &&
      key(refusal.cell) === '25,67,9' &&
      offered.refusal?.reason === 'all_routes_spent',
    `offer=[${offered.candidates.map((candidate) => candidate.id).join(',')}] refusal=${refusal === undefined ? 'none' : formatDigRouteRefused(refusal)}`,
  )
  check(
    '(h1) the typed refusal identifies the protected obsidian frame member',
    refusal !== undefined &&
      formatDigRouteRefused(refusal).startsWith(
        'DIG_ROUTE_REFUSED reason=protected target=26,67,9 bearing=E cell=25,67,9 block=obsidian',
      ),
    refusal === undefined ? 'no refusal' : formatDigRouteRefused(refusal),
  )

  // (h2) THE APPROACH LEG: the interior cell is itself sensed standable (obsidian
  // floor under the portal blocks), so before this fix the spent entry's approach
  // leg was the interior ITSELF - the very cell whose route just failed (live
  // `MOVE:p26_67_9 phase=pathing` fail). An approach leg must be a different cell.
  const standable = [FEET, TARGET, { x: 25, y: 67, z: 10 }, { x: 26, y: 67, z: 10 }]
  const walkable = worldState({
    feet: FEET,
    descent,
    counts,
    current: queuedPlace(TARGET),
    enterCell: TARGET,
    standable,
    liveStructureMembers: frameMembers,
  })
  const spentWalk = spendEntryRoute(walkable, options, TARGET)
  const walkTick = worldState({
    feet: FEET,
    descent,
    counts,
    current: queuedPlace(TARGET),
    enterCell: TARGET,
    standable,
    routes: spentWalk,
    liveStructureMembers: frameMembers,
  })
  const after = entryCandidates(walkTick, options)
  const leg = after.candidates.find((candidate) => candidate.meta.approachLeg !== undefined)
  check(
    '(h2) the approach leg is the standable OPEN FACE, never the destination cell whose route just failed',
    leg !== undefined &&
      leg.kind === 'MOVE' &&
      leg.id === 'MOVE:p26_67_10' &&
      leg.target !== null &&
      key(leg.target) === '26,67,10' &&
      after.candidates.every((candidate) => candidate.id !== 'MOVE:p26_67_9'),
    `offer=[${after.candidates.map((candidate) => candidate.id).join(',')}] leg=${leg === undefined ? 'none' : `${leg.id}->${leg.target === null ? 'none' : key(leg.target)}`}`,
  )

  // (h3) When the destination is the ONLY improving standable cell, the arm must
  // NOT re-offer it as its own leg: it keeps the typed escalation instead.
  const onlyTarget = worldState({
    feet: FEET,
    descent,
    counts,
    current: queuedPlace(TARGET),
    enterCell: TARGET,
    standable: [FEET, TARGET],
    liveStructureMembers: frameMembers,
  })
  const spentOnly = spendEntryRoute(onlyTarget, options, TARGET)
  const onlyTick = worldState({
    feet: FEET,
    descent,
    counts,
    current: queuedPlace(TARGET),
    enterCell: TARGET,
    standable: [FEET, TARGET],
    routes: spentOnly,
    liveStructureMembers: frameMembers,
  })
  const onlyOffer = entryCandidates(onlyTick, options)
  check(
    '(h3) with the destination as the only improving cell the arm escalates instead of re-offering the same walk',
    onlyOffer.candidates.length === 0 && onlyOffer.refusal?.reason === 'all_routes_spent',
    `offer=[${onlyOffer.candidates.map((candidate) => candidate.id).join(',')}] refusal=${onlyOffer.refusal?.line ?? 'none'}`,
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
  const source =
    readFileSync(new URL('./src/controller-legacy.ts', import.meta.url), 'utf8') +
    readFileSync(new URL('./src/legacy/candidate-diagnostics.ts', import.meta.url), 'utf8')
  const candidatesSource = readFileSync(new URL('./src/candidates.ts', import.meta.url), 'utf8')
  const executorSource = readFileSync(new URL('./src/executor.ts', import.meta.url), 'utf8')
  const checks: Array<[string, boolean]> = [
    ['DIG_ROUTE logged when selected', /if \(guarded\.candidate\.meta\.digRoute === true\) \{\s*\n\s*this\.logDigRoute\(guarded\.candidate\)/.test(source)],
    ['dig route selection is a canonical SKILL_STEP', /'dig_route',\s*\n\s*formatSkillStepAuthority\(\s*\n\s*'MECHANICAL_CONTINUATION'/.test(source)],
    ['policy boundary logged', /private logSkillPolicyBoundaries/.test(source) && /SKILL_POLICY_BOUNDARY/.test(source)],
    ['DIG_ROUTE_PROGRESS on a settled step', /if \(candidate\.meta\.digRoute === true\) this\.logDigRouteProgress\(result, candidate\)/.test(source)],
    ['DIG_ROUTE_REFUSED from the offer', /this\.logDigRouteRefusals\(grounded\.digRefusals\)/.test(source)],
    ['DIG_ROUTE mirrored', /const MIRRORED_MARKERS[\s\S]*?'DIG_ROUTE'/.test(source)],
    ['DIG_ROUTE_REFUSED mirrored', /const MIRRORED_MARKERS[\s\S]*?'DIG_ROUTE_REFUSED'/.test(source)],
    ['DIG_ROUTE_PROGRESS mirrored', /const MIRRORED_MARKERS[\s\S]*?'DIG_ROUTE_PROGRESS'/.test(source)],
    ['dig refusal reaches starvation evidence', /const digToken = `dig_route:\$\{refusal\.reason\}`/.test(source)],
    ['dig route grounded beside the spent route', /const legs = travelApproachLegs\(/.test(candidatesSource)],
    ['dig route withheld once spent', /isZeroProgressRouteRepeat\(state\.signals\.zeroProgressRoutes, \{\s*\n\s*kind: 'DESCEND',/.test(candidatesSource)],
    ['dig route offered to a withheld locomotion target', /reason: 'route_withheld'/.test(candidatesSource)],
    // The detour rule and the approach-leg exclusion are part of the contract.
    ['tool gate feeds the planner as a step probe', /stepRefusal: \(step\) => \{/.test(candidatesSource)],
    ['detour facts on the candidate meta', /digRouteDetour: true/.test(candidatesSource)],
    ['skipped primary on the candidate meta', /digRouteSkipped: `\$\{route\.skipped\.dir\}:\$\{route\.skipped\.reason\}`/.test(candidatesSource)],
    ['detour telemetry', /detour: candidate\.meta\.digRouteDetour === true/.test(source)],
    ['an approach leg is never the destination', /if \(cellKey\(spot\) === targetKey\) continue/.test(candidatesSource)],
    // The pocket continuation: grounded at the open-face site, and executed by the
    // entry skill inside the same lease when it is the unique binding prerequisite.
    ['continuation attached at the open-face site', /const continuations = pocketContinuations\(state, target\)/.test(candidatesSource)],
    ['level-walk reachability gates the continuation', /const walkable = best !== null && levelWalkReachable\(state, best\)/.test(candidatesSource)],
    ['remedy classes enumerated, never ranked', /reason: 'multiple_non_equivalent_recoveries'/.test(candidatesSource)],
    ['executor step-over probe', /private portalFaceStepOverVia\(face: Vec3Json\)/.test(executorSource)],
    ['executor runs the step-over in-skill', /'step_over',\n\s+formatSkillStepAuthority\(\s*\n\s*'MANDATORY_PREREQUISITE'/.test(executorSource)],
    ['executor states the boundary with several floors', /formatSkillPolicyBoundary\(\{/.test(executorSource)],
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
