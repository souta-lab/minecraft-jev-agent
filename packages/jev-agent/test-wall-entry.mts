// test-wall-entry.mts - the general WALL ENTRY (`wallEntry.ts`) and the VERTICAL
// remedy (`candidates.ts#verticalRemedyCandidates`).
//
// MEASURED (the operator's flooded Nether arrival, run-muchajde-1qhat):
//
//   body pinned at (2.7,59,-2.5), alternating ENTER/WAIT, health 20, no deaths:
//     MOVE_LEG_STOPPED x4                                    every walk step refused
//     BRIDGE_REFUSED reason=no_verified_landing cell=3,59,-3  no verified far side
//     DIG_ROUTE_REFUSED x765 reason=hazard
//         target={0.87,64.66,1.65} bearing=SW cell={2,60,-2} block=air
//         detail=lava/water in the step column
//
//   Every refusal is correct and the body still cannot move, because nothing offered
//   the one thing a player does there: mine the solid block beside you. The sensor's
//   only hazard fact for a dig is a 3x3x3 PROXIMITY union (`state.ts#hazardsAround`),
//   so a dry wall two cells from a lava pocket was refused exactly like a wall the
//   lava would pour through.
//
// These fixtures prove, offline:
//   (i)   the measured precondition - every walk step hazard-refused, one adjacent
//         solid breakable wall - grounds a WALL ENTRY: the mined cell is solid and
//         non-fluid, the pocket is dry, the floor is pre-existing rock, and the step
//         strictly closes the distance to the target (the route is bounded);
//   (ii)  two grounded walls -> EVERY one is offered and the section 7 U3 boundary
//         names both: code chooses no direction;
//   (iii) a wall whose mining would pour a face-adjacent fluid into the pocket ->
//         typed `would_flood` refusal, the wall is NOT mined; while a fluid two cells
//         away (no flow path into the pocket) is ALLOWED - the whole capability;
//   (iv)  ordinary terrain -> no probe, no entry candidate, no marker;
//   (v)   hazard-refused with no openable wall anywhere -> typed
//         `no_grounded_route` with the per-direction ledger, never a candidate;
//   (vi)  the existing dig-route refusal shapes are byte-identical (`hazard`, the
//         measured line), so the guard that refused still refuses;
//   (vii) the pit (body y61, target y67, solid walls, no ramp) grounds the VERTICAL
//         remedy through the existing planner, with the walk family intact;
//   (viii) the `surface`/habitat arms keep their own gates (a body above the habitat
//         band still gets no habitat ascent).
//
// Run: bun jev-agent/test-wall-entry.mts
import { defaultCandidateOptions, entryCandidates, generateGroundedCandidates } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { MIRRORED_MARKERS } from './src/controller.ts'
import { DIG_ROUTE_MIN_ADVANCE, formatDigRouteRefused, planDigRoute } from './src/digRoute.ts'
import { guardCandidate } from './src/policy.ts'
import type { GuardContext } from './src/policy.ts'
import { buildWallProbes } from './src/state.ts'
import type { AgentSignals, DescentDir, DescentOption, InventoryState, SelfState, Vec3Json, WorldState } from './src/state.ts'
import { distance } from './src/state.ts'
import { floodEvidence, groundWallEntries, isTunnelFloodBlockName } from './src/wallEntry.ts'
import type { WallEntryRefusal, WallProbe } from './src/wallEntry.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { NETHER, PORTAL_ENTERED_PREDICATE } from './src/netherPortalPlan.ts'
import type { PortalEntryPlan } from './src/netherPortalPlan.ts'
import { cellKey, observeZeroProgressRoute, routeSignature } from './src/zeroProgressRoute.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const key = (p: Vec3Json): string => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
const OVERWORLD = 'minecraft:overworld'

// ---------------------------------------------------------------------------
// the world as a cell -> block-name map, read through a fake bot so the REAL
// sensor classification (`state.ts#buildWallProbes`) is what the fixtures exercise.
// ---------------------------------------------------------------------------
type Terrain = Map<string, string>

const SOLID = new Set(['netherrack', 'soul_soil', 'soul_sand', 'obsidian', 'cobblestone', 'stone', 'bedrock'])
const FLUIDS = new Set(['lava', 'water', 'flowing_lava', 'flowing_water'])

function terrain(entries: Array<[Vec3Json, string]>): Terrain {
  const map: Terrain = new Map()
  for (const [cell, name] of entries) map.set(key(cell), name)
  return map
}

function fill(map: Terrain, from: Vec3Json, to: Vec3Json, name: string): void {
  for (let x = from.x; x <= to.x; x += 1) {
    for (let y = from.y; y <= to.y; y += 1) {
      for (let z = from.z; z <= to.z; z += 1) map.set(key({ x, y, z }), name)
    }
  }
}

function nameAt(map: Terrain, cell: Vec3Json): string {
  return map.get(key(cell)) ?? 'air'
}

/** The block slice `buildWallProbes` reads: name, bounding box, hardness flag. */
function blockLike(name: string): { name: string; boundingBox: string; diggable: boolean } {
  const fluid = FLUIDS.has(name)
  return {
    name,
    boundingBox: name === 'air' || fluid ? 'empty' : 'block',
    diggable: name !== 'air' && name !== 'bedrock' && !fluid,
  }
}

interface FakeBot {
  entity: { position: { x: number; y: number; z: number; clone: () => { set: (x: number, y: number, z: number) => unknown } } }
  blockAt: (v: { x: number; y: number; z: number }) => { name: string; boundingBox: string; diggable: boolean } | null
}

function fakeBot(feet: Vec3Json, map: Terrain): FakeBot {
  const position = {
    x: feet.x + 0.5,
    y: feet.y,
    z: feet.z + 0.5,
    clone: () => self,
  }
  const scratch = { x: 0, y: 0, z: 0 }
  const self = {
    set: (x: number, y: number, z: number): typeof scratch => {
      scratch.x = x
      scratch.y = y
      scratch.z = z
      return scratch
    },
  }
  return {
    entity: { position },
    blockAt: (v: { x: number; y: number; z: number }) => blockLike(nameAt(map, v)),
  }
}

function selfState(position: Vec3Json): SelfState {
  return {
    username: 'AI_WALL',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'minecraft:nether',
    isDay: true,
    heldItem: null,
  }
}

const DIRS: Array<{ dir: DescentDir; dx: number; dz: number }> = [
  { dir: 'E', dx: 1, dz: 0 },
  { dir: 'W', dx: -1, dz: 0 },
  { dir: 'N', dx: 0, dz: -1 },
  { dir: 'S', dx: 0, dz: 1 },
]

/**
 * The sensor's own step vocabulary in the MEASURED shape: every cardinal step is
 * refused `hazard` by the 3x3x3 proximity rule (that is what the live run logged 765
 * times), and the own column is refused too. The dig profile / floor / support cells
 * are real, so `buildWallProbes` reads the live terrain for every fact it needs.
 */
function hazardRefusedDescent(feet: Vec3Json, map: Terrain): DescentOption[] {
  const out: DescentOption[] = []
  const option = (dir: DescentDir, mode: 'down' | 'level', dx: number, dz: number): DescentOption => {
    const wall = { x: feet.x + dx, y: feet.y, z: feet.z + dz }
    const head = { x: feet.x + dx, y: feet.y + 1, z: feet.z + dz }
    const stepY = mode === 'down' ? feet.y - 1 : feet.y
    const step = { x: feet.x + dx, y: stepY, z: feet.z + dz }
    const floor = { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz }
    const support = { x: feet.x + dx, y: stepY - 1, z: feet.z + dz }
    const wallName = nameAt(map, wall)
    const headName = nameAt(map, head)
    const floorName = nameAt(map, floor)
    const primary = mode === 'down' ? (SOLID.has(floorName) ? floor : wall) : SOLID.has(wallName) ? wall : head
    const digs = [wall, head, floor]
      .filter((cell, index) => index < 2 || mode === 'down')
      .filter((cell) => SOLID.has(nameAt(map, cell)))
      .map((cell) => ({
        cell,
        name: nameAt(map, cell),
        // netherrack / soul soil are hand-breakable in the fixture's tool gate: the
        // only tool fact the entry needs is `diggable`, which the gate reads.
        harvestTool: null,
        harvestTier: null,
        diggable: true,
      }))
    return {
      dir,
      mode,
      dx,
      dz,
      step,
      wall,
      head,
      floor,
      wallSolid: SOLID.has(wallName),
      headSolid: SOLID.has(headName),
      floorSolid: SOLID.has(floorName),
      supportSolid: SOLID.has(nameAt(map, support)),
      hazardNearby: true,
      digs,
      safe: false,
      reason: 'lava/water in the step column',
      refusal: 'hazard',
      digName: nameAt(map, primary),
      digHarvestTool: null,
      digHarvestTier: null,
      diggable: true,
    } as DescentOption
  }
  for (const { dir, dx, dz } of DIRS) {
    out.push(option(dir, 'level', dx, dz))
    out.push(option(dir, 'down', dx, dz))
  }
  out.push(option('D', 'down', 0, 0))
  return out
}

function probesFor(feet: Vec3Json, map: Terrain): WallProbe[] {
  const descent = hazardRefusedDescent(feet, map)
  return buildWallProbes(fakeBot(feet, map) as never, selfState(feet), descent)
}

// ---------------------------------------------------------------------------
// candidate-layer state (the same shape `test-dig-route.mts` uses)
// ---------------------------------------------------------------------------
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

function queuedPlace(target: Vec3Json): QueuedGoal {
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

function queueWith(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

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

interface WorldSpec {
  feet: Vec3Json
  target: Vec3Json
  map: Terrain
  standable?: Vec3Json[]
  counts?: Record<string, number>
  /** sense the real wall probes from `map` (the measured shape), or omit them */
  probe?: boolean
  stepCuts?: WorldState['stepCuts']
  /** the spent-route ledger: the arm only re-grounds once the goal's own route is spent */
  routes?: AgentSignals['zeroProgressRoutes']
}

function worldState(spec: WorldSpec): WorldState {
  const current = queuedPlace(spec.target)
  return {
    schemaVersion: 1,
    tick: 9,
    timestampMs: 1_700_000_000_000,
    self: selfState(spec.feet),
    inventory: inventory(spec.counts ?? { wooden_pickaxe: 1, cobblestone: 8 }),
    entities: [],
    blocks: [],
    terrain: { standable: spec.standable ?? [spec.feet] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    portalFrameSites: [],
    descent: hazardRefusedDescent(spec.feet, spec.map),
    ...(spec.probe === false ? {} : { wallProbes: probesFor(spec.feet, spec.map) }),
    stepCuts: spec.stepCuts ?? [],
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
    signals: signals({ ...(spec.routes === undefined ? {} : { zeroProgressRoutes: spec.routes }) }),
  }
}

/**
 * The controller's own recording path: the portal/enter route proved dead from this
 * stand cell (`path_no_path`), which is what makes the candidate layer re-ground the
 * same target from a different remedy (exactly the live offer cycle).
 */
function spendEntryRoute(state: WorldState, options: ReturnType<typeof optionsFor>, target: Vec3Json) {
  const fresh = entryCandidates(state, options)
  const entry = fresh.candidates.find((candidate) => candidate.kind === 'ENTER_PORTAL') ?? fresh.candidates[0]
  if (entry === undefined) throw new Error('fixture: no ENTER candidate to spend')
  return observeZeroProgressRoute(undefined, {
    kind: 'ENTER_PORTAL',
    targetKey: cellKey(target),
    standKey: cellKey(state.self.position),
    routeSig: routeSignature({ kind: entry.kind, id: entry.id, meta: entry.meta }),
    reason: 'path_no_path',
    nowMs: state.timestampMs,
  }).routes
}

/** A world state whose goal route is already spent, so the remedy arms re-ground. */
function spentState(spec: WorldSpec): WorldState {
  const options = optionsFor(spec)
  const first = worldState(spec)
  return worldState({ ...spec, routes: spendEntryRoute(first, options, spec.target) })
}

function optionsFor(spec: WorldSpec) {
  return {
    ...defaultCandidateOptions,
    portalEntry: entryPlanFor(spec.target),
    reachability: { pathProbe: () => 'no_path' as const },
  }
}

const entriesOf = (candidates: readonly Candidate[]): Candidate[] =>
  candidates.filter((candidate) => candidate.meta.digRouteEntry === true)
const ascentsOf = (candidates: readonly Candidate[]): Candidate[] =>
  candidates.filter((candidate) => typeof candidate.meta.ascentForLocomotionTarget === 'string')

// ---------------------------------------------------------------------------
// (i) THE MEASURED SHAPE: every walk step hazard-refused by a lava pocket near the
// wall, one adjacent SOLID netherrack wall EAST, and the pocket two cells behind the
// wall is dry. The wall entry must be grounded, bounded and dry-floored.
// ---------------------------------------------------------------------------
{
  const FEET: Vec3Json = { x: 2, y: 59, z: -2 }
  const TARGET: Vec3Json = { x: 12, y: 59, z: -2 }
  const map = terrain([])
  // the solid band the body stands on and the wall it will mine
  fill(map, { x: 0, y: 55, z: -6 }, { x: 12, y: 58, z: 2 }, 'soul_soil')
  fill(map, { x: 3, y: 59, z: -2 }, { x: 3, y: 60, z: -2 }, 'netherrack')
  // the operator's lava: BELOW and BEHIND the wall, two cells from the pocket, so it
  // is inside the sensor's 3x3x3 proximity union but has no face into the tunnel.
  map.set(key({ x: 4, y: 58, z: -2 }), 'lava')
  const state = spentState({ feet: FEET, target: TARGET, map })
  const probes = state.wallProbes ?? []
  const east = probes.find((probe) => probe.dir === 'E' && probe.mode === 'level')
  const refusals: Parameters<typeof entryCandidates>[2] = []
  const entryOffer = entriesOf(entryCandidates(state, optionsFor({ feet: FEET, target: TARGET, map }), refusals).candidates)
  const groundFloor = state.wallProbes?.find((probe) => probe.dir === 'E' && probe.mode === 'level')?.floor
  check(
    '(i) the measured shape grounds a WALL ENTRY east: the mined cell is solid, the pocket dry, the floor pre-existing rock',
    east !== undefined &&
      east.pocket[0].name === 'netherrack' &&
      east.pocket[0].solid &&
      east.pocket[0].breakable &&
      east.pocket[1].name === 'netherrack' &&
      !east.flood &&
      east.floor.name === 'soul_soil' &&
      east.floor.solid &&
      entryOffer.length === 1 &&
      entryOffer[0]?.kind === 'DESCEND' &&
      key(entryOffer[0]?.target ?? { x: 0, y: 0, z: 0 }) === '3,59,-2' &&
      groundFloor !== undefined,
    `probe=[cell=${east?.pocket[0].name}/${String(east?.pocket[0].solid)} head=${east?.pocket[1].name} floor=${east?.floor.name}/${String(east?.floor.solid)} flood=${String(east?.flood)}] offer=[${entryOffer.map((c) => c.id).join(',')}] refusals=[${refusals.map((r) => formatDigRouteRefused(r)).join(' | ')}]`,
  )
  const built = entryOffer[0]
  check(
    '(i) the entry is bounded: it strictly closes the distance to the target and the line names cell/floor/level/mode',
    built !== undefined &&
      typeof built.meta.digRouteFrom === 'number' &&
      typeof built.meta.digRouteTo === 'number' &&
      built.meta.digRouteTo < built.meta.digRouteFrom &&
      built.meta.digRouteFrom - built.meta.digRouteTo >= DIG_ROUTE_MIN_ADVANCE &&
      built.meta.digRouteEntryMode === 'level' &&
      built.meta.digRouteEntryLevel === 59 &&
      built.meta.digRouteEntryFloorBlock === 'soul_soil' &&
      typeof built.meta.digRouteLine === 'string' &&
      (built.meta.digRouteLine as string).includes('entry=true kind_detail=wall_entry') &&
      typeof built.meta.digRouteEntryLine === 'string' &&
      (built.meta.digRouteEntryLine as string).startsWith('DIG_ROUTE_ENTRY reason=no_walkable_route') &&
      built.kind === 'DESCEND',
    `from=${String(built?.meta.digRouteFrom)} to=${String(built?.meta.digRouteTo)} mode=${String(built?.meta.digRouteEntryMode)} level=${String(built?.meta.digRouteEntryLevel)} floor=${String(built?.meta.digRouteEntryFloorBlock)} line=${String(built?.meta.digRouteLine)}`,
  )
  // The gate must PRESENT it (a grounded DESCEND needs no walkable path) and the
  // guard must accept it.
  const grounded = generateGroundedCandidates(state, optionsFor({ feet: FEET, target: TARGET, map }))
  const presented = entriesOf(grounded.candidates)
  const guardContext: GuardContext = {
    phase: 'decision',
    candidateIds: new Set(grounded.candidates.map((candidate) => candidate.id)),
    inFlight: null,
    reach: 4.5,
    maxCandidateAgeTicks: 40,
  }
  const verdict = presented[0] === undefined ? null : guardCandidate(presented[0], state, guardContext)
  check(
    '(i) the affordance gate presents the entry and the guard accepts it',
    presented.length === 1 && verdict !== null && verdict.ok === true,
    `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}] guard=${verdict === null ? 'none' : verdict.ok ? 'ok' : verdict.reason}`,
  )
  // The one dive: the mine cell is solid and NOT a fluid (the mechanics truth the
  // whole rule exists for), read back from the sensor's own block slice.
  const cellBlock = blockLike(nameAt(map, { x: 3, y: 59, z: -2 }))
  check(
    '(i) the cell the entry mines is solid and non-fluid (never lava/water)',
    cellBlock.boundingBox === 'block' &&
      cellBlock.diggable &&
      !isTunnelFloodBlockName(cellBlock.name) &&
      floodEvidence([{ x: 3, y: 59, z: -2 }, { x: 3, y: 60, z: -2 }], (cell) => blockLike(nameAt(map, cell))) === null,
    `block=${cellBlock.name} bbox=${cellBlock.boundingBox} flood=${String(floodEvidence([{ x: 3, y: 59, z: -2 }, { x: 3, y: 60, z: -2 }], (cell) => blockLike(nameAt(map, cell))))}`,
  )
}

// ---------------------------------------------------------------------------
// (ii) TWO grounded walls: both are offered, the boundary names both, and no
// direction was chosen by code.
// ---------------------------------------------------------------------------
{
  const FEET: Vec3Json = { x: 2, y: 59, z: -2 }
  const TARGET: Vec3Json = { x: 12, y: 59, z: 8 }
  const map = terrain([])
  fill(map, { x: 0, y: 55, z: -6 }, { x: 12, y: 58, z: 10 }, 'soul_soil')
  fill(map, { x: 3, y: 59, z: -2 }, { x: 3, y: 60, z: -2 }, 'netherrack')
  fill(map, { x: 2, y: 59, z: -1 }, { x: 2, y: 60, z: -1 }, 'netherrack')
  map.set(key({ x: 4, y: 58, z: -2 }), 'lava')
  map.set(key({ x: 2, y: 58, z: 0 }), 'lava')
  const options = optionsFor({ feet: FEET, target: TARGET, map })
  const state = spentState({ feet: FEET, target: TARGET, map })
  const offered = entriesOf(entryCandidates(state, options).candidates)
  const boundary = offered.map((candidate) => candidate.meta.legPolicyBoundary).find((line) => typeof line === 'string')
  check(
    '(ii) two grounded walls -> BOTH are offered and the section 7 U3 boundary names both alternatives',
    offered.length === 2 &&
      offered.some((candidate) => candidate.meta.digRouteBearing === 'E') &&
      offered.some((candidate) => candidate.meta.digRouteBearing === 'S') &&
      typeof boundary === 'string' &&
      boundary.includes('SKILL_POLICY_BOUNDARY') &&
      boundary.includes('dig:wall_entry:E:level') &&
      boundary.includes('dig:wall_entry:S:level'),
    `offer=[${offered.map((c) => `${String(c.meta.digRouteBearing)}:${c.id}`).join(',')}] boundary=${String(boundary)}`,
  )
}

// ---------------------------------------------------------------------------
// (iii) FLOOD: a fluid face-adjacent to the pocket refuses the wall; the same fluid
// two cells away (no face into the pocket) is allowed.
// ---------------------------------------------------------------------------
{
  const FEET: Vec3Json = { x: 2, y: 59, z: -2 }
  const TARGET: Vec3Json = { x: 12, y: 59, z: -2 }
  const base = (): Terrain => {
    const map = terrain([])
    fill(map, { x: 0, y: 55, z: -6 }, { x: 12, y: 58, z: 2 }, 'soul_soil')
    fill(map, { x: 3, y: 59, z: -2 }, { x: 3, y: 60, z: -2 }, 'netherrack')
    return map
  }
  const floods = base()
  // the lava sits in the cell BEYOND the wall at the pocket's own level: mining the
  // wall opens a face onto it, so it pours in.
  floods.set(key({ x: 4, y: 59, z: -2 }), 'lava')
  const floodState = spentState({ feet: FEET, target: TARGET, map: floods })
  const floodOptions = optionsFor({ feet: FEET, target: TARGET, map: floods })
  const floodRefusals: Parameters<typeof entryCandidates>[2] = []
  const floodOffer = entriesOf(entryCandidates(floodState, floodOptions, floodRefusals).candidates)
  const floodLine = floodRefusals.map((refusal) => formatDigRouteRefused(refusal)).find((line) => line.includes('would_flood'))
  check(
    '(iii) a wall whose mining would pour lava into the pocket is REFUSED typed `would_flood`, never mined',
    floodOffer.length === 0 &&
      typeof floodLine === 'string' &&
      floodLine.includes('reason=would_flood') &&
      floodLine.includes('cell=4,59,-2') &&
      floodLine.includes('block=lava'),
    `offer=[${floodOffer.map((c) => c.id).join(',')}] refusal=${String(floodLine)}`,
  )
  const dry = base()
  dry.set(key({ x: 4, y: 58, z: -2 }), 'lava')
  const dryState = spentState({ feet: FEET, target: TARGET, map: dry })
  const dryOffer = entriesOf(entryCandidates(dryState, optionsFor({ feet: FEET, target: TARGET, map: dry })).candidates)
  check(
    '(iii) the SAME lava two cells away (behind the wall, below the pocket) is allowed - the flow rule, not proximity',
    dryOffer.length === 1 && dryState.wallProbes?.find((probe) => probe.dir === 'E' && probe.mode === 'level')?.flood === false,
    `offer=[${dryOffer.map((c) => c.id).join(',')}] flood=${String(dryState.wallProbes?.find((probe) => probe.dir === 'E' && probe.mode === 'level')?.flood)}`,
  )
  // The protected/live-structure rule still wins over any entry that would aim at it.
  const protectedRefusal: WallEntryRefusal | null = (() => {
    const decision = groundWallEntries({
      selfPosition: FEET,
      target: TARGET,
      walls: dryState.wallProbes ?? [],
      minAdvance: DIG_ROUTE_MIN_ADVANCE,
      isProtected: (cell) => key(cell) === '3,59,-2',
    })
    return decision.kind === 'refuse' ? decision.refusal : null
  })()
  check(
    '(iii) a protected cell in the profile is refused `protected` (never mined as a route)',
    protectedRefusal !== null && protectedRefusal.reason === 'protected',
    `refusal=${protectedRefusal === null ? 'none' : `${protectedRefusal.reason} ${protectedRefusal.detail}`}`,
  )
}

// ---------------------------------------------------------------------------
// (iv) ORDINARY TERRAIN: no refusal-shaped precondition, so no probe is sensed and
// the offer carries no entry candidate and no entry marker.
// ---------------------------------------------------------------------------
{
  const FEET: Vec3Json = { x: 2, y: 64, z: 2 }
  const TARGET: Vec3Json = { x: 12, y: 64, z: 2 }
  const map = terrain([])
  fill(map, { x: 0, y: 60, z: -4 }, { x: 14, y: 63, z: 8 }, 'stone')
  // ordinary terrain: the walls are open air at feet level, so the target is walkable
  // and the state carries no wall probe at all (the sensor gate).
  const state = worldState({ feet: FEET, target: TARGET, map, probe: false, standable: [FEET, { x: 3, y: 64, z: 2 }] })
  const offered = entryCandidates(state, optionsFor({ feet: FEET, target: TARGET, map })).candidates
  check(
    '(iv) ordinary terrain offers no entry candidate, no entry marker and no wall probe',
    state.wallProbes === undefined &&
      entriesOf(offered).length === 0 &&
      offered.every((candidate) => candidate.meta.digRouteEntryLine === undefined),
    `probes=${state.wallProbes === undefined ? 'none' : String(state.wallProbes.length)} offer=[${offered.map((c) => c.id).join(',')}]`,
  )
}

// ---------------------------------------------------------------------------
// (v) NO OPENABLE WALL: lava/void in every direction -> typed `no_grounded_route`
// with the per-direction ledger, never a candidate and never a hang.
// ---------------------------------------------------------------------------
{
  const FEET: Vec3Json = { x: 2, y: 59, z: -2 }
  const TARGET: Vec3Json = { x: 12, y: 59, z: -2 }
  const map = terrain([])
  fill(map, { x: -3, y: 55, z: -7 }, { x: 7, y: 60, z: 3 }, 'lava')
  const state = spentState({ feet: FEET, target: TARGET, map })
  const refusals: Parameters<typeof entryCandidates>[2] = []
  const offer = entriesOf(entryCandidates(state, optionsFor({ feet: FEET, target: TARGET, map }), refusals).candidates)
  const line = refusals.map((refusal) => formatDigRouteRefused(refusal)).find((entry) => entry.includes('no_grounded_route'))
  check(
    '(v) open lava on every side -> typed `no_grounded_route` with the ledger, no candidate',
    offer.length === 0 &&
      typeof line === 'string' &&
      line.includes('reason=no_grounded_route') &&
      line.includes('ledger:') &&
      line.includes('E=hazard'),
    `offer=[${offer.map((c) => c.id).join(',')}] refusal=${String(line)}`,
  )
}

// ---------------------------------------------------------------------------
// (vi) THE OLD REFUSAL SHAPES ARE UNCHANGED: a walk/dig shape the guard refused
// before still refuses with the same typed line (the measured live line verbatim).
// ---------------------------------------------------------------------------
{
  const FEET: Vec3Json = { x: 2, y: 59, z: -2 }
  const TARGET: Vec3Json = { x: 0.87, y: 64.66, z: 1.65 }
  const map = terrain([])
  fill(map, { x: 0, y: 55, z: -6 }, { x: 12, y: 58, z: 2 }, 'soul_soil')
  map.set(key({ x: 2, y: 59, z: -2 }), 'air')
  const decision = planDigRoute({
    selfPosition: FEET,
    target: TARGET,
    descent: hazardRefusedDescent(FEET, map),
  })
  const line = decision.kind === 'refuse' ? formatDigRouteRefused(decision.refusal) : 'route'
  check(
    '(vi) the existing dig-route refusal is byte-identical: reason=hazard target=0.87,64.66,1.65 bearing=SW',
    decision.kind === 'refuse' &&
      decision.refusal.reason === 'hazard' &&
      line.startsWith('DIG_ROUTE_REFUSED reason=hazard target=0,64,1 bearing=SW cell=') &&
      line.endsWith(' block=air detail=lava/water in the step column') &&
      !line.includes('entry='),
    `line=${line}`,
  )
  // The step-landing and env-hazard guards keep their own markers registered, and the
  // wall entry adds exactly one new mirrored marker.
  check(
    '(vi) MOVE_LEG_STOPPED / ENV_HAZARD / BRIDGE_REFUSED / DIG_ROUTE / DIG_ROUTE_REFUSED stay mirrored, plus DIG_ROUTE_ENTRY',
    ['MOVE_LEG_STOPPED', 'ENV_HAZARD', 'BRIDGE_REFUSED', 'DIG_ROUTE', 'DIG_ROUTE_REFUSED', 'DIG_ROUTE_ENTRY', 'SKILL_POLICY_BOUNDARY', 'SKILL_STEP'].every(
      (marker) => MIRRORED_MARKERS.has(marker),
    ),
    `mirrored=${MIRRORED_MARKERS.has('DIG_ROUTE_ENTRY')} size=${MIRRORED_MARKERS.size}`,
  )
}

// ---------------------------------------------------------------------------
// (vii) THE MEASURED PIT (overworld, body y61, target y67, solid walls, no ramp):
// the vertical remedy is grounded through the existing planner, with the walk family
// left intact.
// ---------------------------------------------------------------------------
{
  const FEET: Vec3Json = { x: 28, y: 61, z: 6 }
  const TARGET: Vec3Json = { x: 26, y: 67, z: 9 }
  const map = terrain([])
  // the shaft: x=27 solid at y62..66, x=28-30 air at y62..66, floor under the body
  fill(map, { x: 27, y: 61, z: 0 }, { x: 27, y: 66, z: 12 }, 'stone')
  fill(map, { x: 24, y: 62, z: 0 }, { x: 24, y: 66, z: 12 }, 'stone')
  fill(map, { x: 31, y: 62, z: 0 }, { x: 31, y: 66, z: 12 }, 'stone')
  fill(map, { x: 0, y: 60, z: -8 }, { x: 40, y: 60, z: 20 }, 'cobblestone')
  // the measured ledge: `step_up evidence=cell=29,62,6 ledge=29,61,6:solid` - a
  // standable cell one block UP and closer to the target, unreachable by level walks.
  fill(map, { x: 29, y: 61, z: 6 }, { x: 29, y: 61, z: 6 }, 'stone')
  const ledge: Vec3Json = { x: 29, y: 62, z: 6 }
  const state = spentState({ feet: FEET, target: TARGET, map, counts: { cobblestone: 8 }, standable: [FEET, ledge] })
  const options = optionsFor({ feet: FEET, target: TARGET, map })
  const offer = entryCandidates(state, options).candidates
  const ascents = ascentsOf(offer)
  check(
    '(vii) the measured pit grounds a VERTICAL remedy toward the target level, as an ordinary MOVE candidate',
    ascents.length >= 1 &&
      ascents[0]?.kind === 'MOVE' &&
      ascents[0]?.meta.ascentForLocomotionTarget === '26,67,9' &&
      typeof ascents[0]?.meta.ascentTargetY === 'number' &&
      (ascents[0]?.meta.ascentTargetY as number) === 67 &&
      typeof ascents[0]?.meta.vertical === 'string',
    `offer=[${offer.map((c) => c.id).join(',')}] vertical=${String(ascents[0]?.meta.vertical)} targetY=${String(ascents[0]?.meta.ascentTargetY)}`,
  )
  check(
    '(vii) the vertical remedy is ADDED: the walk leg and the step-up continuation stay in the offer',
    offer.some((candidate) => candidate.id === 'MOVE:p29_62_6') &&
      offer.some((candidate) => candidate.id === 'SKILL_STEP:step_up:p29_62_6') &&
      ascents.length === 1 &&
      offer.filter((candidate) => candidate.id === ascents[0]?.id).length === 1,
    `offer=[${offer.map((c) => c.id).join(',')}]`,
  )
  // A target at the SAME level grounds no ascent (the existing walk family owns it).
  const flat = spentState({ feet: FEET, target: { x: 26, y: 61, z: 9 }, map, counts: { cobblestone: 8 }, standable: [FEET, ledge] })
  const flatOffer = entryCandidates(flat, optionsFor({ feet: FEET, target: { x: 26, y: 61, z: 9 }, map })).candidates
  check(
    '(vii) a target at the body\'s own level grounds no ascent (no invented vertical remedy)',
    ascentsOf(flatOffer).length === 0,
    `offer=[${flatOffer.map((c) => c.id).join(',')}]`,
  )
}

// ---------------------------------------------------------------------------
// (viii) THE EXISTING GOAL-GATED ARMS KEEP THEIR OWN GATES: the habitat ascent still
// refuses at/above the animal-habitat band, so the new general path did not replace
// the measured behaviour of the food route.
// ---------------------------------------------------------------------------
{
  const source = await Bun.file(new URL('./src/candidates.ts', import.meta.url)).text()
  const habitatGate = source.indexOf('if (aboveBand && sealed === null) return { candidates: [], refusal: null }')
  const surfaceGate = source.indexOf("if (current?.kind !== 'surface' && searchTargetY === null) return { candidates: [], refusal: null }")
  check(
    '(viii) the surface/habitat arms keep their own gates (unchanged by the general remedy)',
    habitatGate > 0 && surfaceGate > 0,
    `habitatGate=${habitatGate} surfaceGate=${surfaceGate}`,
  )
}

process.stdout.write(`\nwall entry fixtures: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}\n`)
if (failures > 0) process.exit(1)
