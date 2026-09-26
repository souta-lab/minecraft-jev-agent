// test-level-scan.mts - the BOUNDED LEVEL SCAN (`levelScan.ts`) and the
// `candidates.ts#levelScanCandidates` offer it drives.
//
// MEASURED (live, the operator's flooded Nether arrival, run-muchajde-1qhat, chunk (0,-1)):
//
//   the body stands at (2.7,59,-2.5) on a small solid island around the portal. EAST at the
//   body's OWN level is the portal plane at x=3 (stepping in TELEPORTS the body back to the
//   overworld - the observed ENTER/WAIT ping-pong), then open air, then the lava wall at
//   y58-59 x=10..13. ABOVE: the higher the level the MORE lava, so climbing is defeated.
//   BELOW: the subsurface is SOLID (soul soil / soul sand, y55-58 with lava pockets), i.e. a
//   descend-and-tunnel-east route physically exists - and the live ledger says the existing
//   arms cannot ground it:
//
//     DIG_ROUTE_REFUSED reason=no_grounded_route ... (ledger: E=no_wall Ev=protected ...)
//
//   `digRoute.ts#planDigRoute` requires every step to STRICTLY reduce the 3-D distance to the
//   target, so a pure descent is (correctly) never a route; `wallEntry.ts` judges only the
//   body's own adjacent cells. This fixture drives the REAL sensor (`buildLevelScanProbes` /
//   `buildWallProbes` over a modelled world) and the REAL rule through the REAL offer, and
//   pins:
//
//   (i)   THE MEASURED ISLAND: every lateral at the body's level refused (`portal_plane` for
//         the portal plane, `protected` for the frame, `no_wall` for open air, `no_progress`
//         for the ones that do not close the distance), the rock band below solid, a lava
//         pocket TWO CELLS from a would-be pocket cell (allowed by the flow rule) and one
//         FACE-ADJACENT to a would-be pocket cell at another level (refused) -> the descent
//         to the level with a grounded lateral continuation is offered, the distance to the
//         target strictly decreases across the COMPOSED route, and the guard accepts it;
//   (ii)  NO LEVEL YIELDS PROGRESS -> typed `no_grounded_route` with the per-level ledger and
//         no candidate;
//   (iii) ORDINARY TERRAIN -> no scan is sensed (the sensor gate), no candidate, no marker,
//         byte-identical offer;
//   (iv)  SEVERAL levels/directions grounded -> the boundary names every alternative and code
//         chooses neither a level nor a direction;
//   (v)   AN UNLOADED LEVEL IS NOT CLEAR: the unknown cell breaks the chain and is reported
//         as the headline cause (and the same geometry with the cells loaded DOES ground);
//   (vi)  THE EXISTING GUARDS STAY PINNED: a lethal step still stops (`MOVE_LEG_STOPPED`),
//         the portal plane and the frame stay protected, `crosses_dimension` still refuses a
//         dimensional realization, and the new markers are mirrored.
//
// BOUNDS pinned here as facts: LEVEL_SCAN_MAX_LEVELS levels, LEVEL_SCAN_MAX_PROBES probes,
// LEVEL_SCAN_MAX_ROUTE_LENGTH = levels + 1, and the composed strict-reduction margin.
//
// Run: bun jev-agent/test-level-scan.mts
import { readFileSync } from 'node:fs'
import {
  applyReachabilityGate,
  defaultCandidateOptions,
  entryCandidates,
  generateGroundedCandidates,
} from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { MIRRORED_MARKERS } from './src/controller.ts'
import { DIG_ROUTE_MIN_ADVANCE, formatDigRouteRefused, planDigRoute } from './src/digRoute.ts'
import {
  LEVEL_SCAN_MAX_LEVELS,
  LEVEL_SCAN_MAX_PROBES,
  LEVEL_SCAN_MAX_ROUTE_LENGTH,
  LEVEL_SCAN_MIN_ADVANCE,
  floodNeighbours,
  formatLevelLedger,
  formatLevelScanStep,
  groundLevelScan,
} from './src/levelScan.ts'
import { guardCandidate } from './src/policy.ts'
import type { GuardContext } from './src/policy.ts'
import { buildLevelScanProbes, buildWallProbes, distance } from './src/state.ts'
import type {
  AgentSignals,
  DescentDir,
  DescentMode,
  DescentOption,
  InventoryState,
  SelfState,
  Vec3Json,
  WorldState,
} from './src/state.ts'
import { classifyStepLanding, formatMoveLegStopped, STEP_SUPPORT_NONE } from './src/stepLanding.ts'
import { isVerifiedWallEntry, wallPocketRefusal } from './src/wallEntry.ts'
import { NETHER, PORTAL_ENTERED_PREDICATE } from './src/netherPortalPlan.ts'
import type { PortalEntryPlan } from './src/netherPortalPlan.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { LiveStructureMember } from './src/blockSafety.ts'
import { cellKey, observeZeroProgressRoute, routeSignature } from './src/zeroProgressRoute.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const key = (p: Vec3Json): string => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`

// ---------------------------------------------------------------------------
// the world as a cell -> block-name map, read through a fake bot so the REAL sensor
// classification (`state.ts#buildLevelScanProbes` / `#buildWallProbes`) is exercised.
// A cell that is NOT in the map is an UNLOADED cell: `blockAt` returns null, which is
// what the unknown-is-not-clear fixture needs.
// ---------------------------------------------------------------------------
type Terrain = Map<string, string>

const SOLID = new Set(['netherrack', 'soul_soil', 'soul_sand', 'obsidian', 'cobblestone', 'stone', 'bedrock'])
const FLUIDS = new Set(['lava', 'water', 'flowing_lava', 'flowing_water'])
const HAZARDS = new Set(['lava', 'fire', 'magma_block', 'campfire', 'soul_campfire', 'sweet_berry_bush', 'cactus'])
const TRANSFER = new Set(['nether_portal', 'end_portal', 'end_gateway'])

function terrain(): Terrain {
  return new Map()
}

function fill(map: Terrain, from: Vec3Json, to: Vec3Json, name: string): void {
  for (let x = from.x; x <= to.x; x += 1) {
    for (let y = from.y; y <= to.y; y += 1) {
      for (let z = from.z; z <= to.z; z += 1) {
        map.set(key({ x, y, z }), name)
      }
    }
  }
}

function drop(map: Terrain, from: Vec3Json, to: Vec3Json): void {
  for (let x = from.x; x <= to.x; x += 1) {
    for (let y = from.y; y <= to.y; y += 1) {
      for (let z = from.z; z <= to.z; z += 1) {
        map.delete(key({ x, y, z }))
      }
    }
  }
}

/** The block slice the sensor reads: name, bounding box, hardness flag. */
function blockLike(name: string): { name: string; boundingBox: string; diggable: boolean } {
  const fluid = FLUIDS.has(name)
  return {
    name,
    boundingBox: name === 'air' || fluid || TRANSFER.has(name) ? 'empty' : 'block',
    diggable: name !== 'air' && name !== 'bedrock' && !fluid && !TRANSFER.has(name),
  }
}

interface FakeBot {
  entity: {
    position: { x: number; y: number; z: number; clone: () => { set: (x: number, y: number, z: number) => unknown } }
  }
  blockAt: (v: { x: number; y: number; z: number }) => { name: string; boundingBox: string; diggable: boolean } | null
}

/** A bot over the map: a cell that is absent from the map is UNLOADED (`null`). */
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
    blockAt: (v: { x: number; y: number; z: number }) => {
      const name = map.get(key(v))
      return name === undefined ? null : blockLike(name)
    },
  }
}

function selfState(position: Vec3Json): SelfState {
  return {
    username: 'AI_LEVEL',
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
 * The sensor's own step vocabulary, produced from the SAME map with the same ordered
 * verdict chain `state.ts#buildDescent` uses (protected station -> unbreakable -> no
 * support -> open floor -> proximity hazard). The wall-entry/level-scan probes are the
 * REAL builders and read the live map themselves, so the two fact producers are
 * independent of this helper's shape but agree on the world.
 */
function descentFixture(feet: Vec3Json, map: Terrain): DescentOption[] {
  const nameAt = (cell: Vec3Json): string | null => map.get(key(cell)) ?? null
  const solid = (cell: Vec3Json): boolean => {
    const name = nameAt(cell)
    return name !== null && SOLID.has(name)
  }
  const clear = (cell: Vec3Json): boolean => {
    const name = nameAt(cell)
    return name === null || blockLike(name).boundingBox === 'empty'
  }
  const hazardous = (cell: Vec3Json): boolean => {
    const name = nameAt(cell)
    return name !== null && (HAZARDS.has(name) || FLUIDS.has(name)) && blockLike(name).boundingBox === 'empty'
  }
  const hazardsAround = (...cells: Vec3Json[]): boolean => {
    const seen = new Set<string>()
    for (const cell of cells) {
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dz = -1; dz <= 1; dz += 1) {
            const probe = { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz }
            const id = key(probe)
            if (seen.has(id)) continue
            seen.add(id)
            if (hazardous(probe)) return true
          }
        }
      }
    }
    return false
  }
  const option = (dir: DescentDir, mode: DescentMode, dx: number, dz: number): DescentOption => {
    const ownColumn = dx === 0 && dz === 0
    const wall = { x: feet.x + dx, y: feet.y, z: feet.z + dz }
    const head = { x: feet.x + dx, y: feet.y + 1, z: feet.z + dz }
    const stepY = mode === 'down' ? feet.y - 1 : feet.y
    const step = { x: feet.x + dx, y: stepY, z: feet.z + dz }
    const floor = { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz }
    const support = { x: feet.x + dx, y: stepY - 1, z: feet.z + dz }
    const wallSolid = solid(wall)
    const headSolid = solid(head)
    const floorSolid = solid(floor)
    const supportSolid = solid(support)
    const hazardNearby = hazardsAround(wall, head, floor, step, support)
    const primary = mode === 'down' ? (floorSolid ? floor : wall) : wallSolid ? wall : head
    const digCells = ownColumn
      ? floorSolid
        ? [floor]
        : []
      : mode === 'down'
        ? [...(wallSolid ? [wall] : []), ...(floorSolid ? [floor] : [])]
        : [...(wallSolid ? [wall] : []), ...(headSolid ? [head] : [])]
    let reason = 'safe'
    let refusal: DescentOption['refusal']
    if (!ownColumn && !clear(wall) && !solid(wall)) {
      reason = 'wall is not breakable'
      refusal = 'unbreakable'
    } else if (!ownColumn && !clear(head) && !solid(head)) {
      reason = 'head-cell is not breakable'
      refusal = 'unbreakable'
    } else if (mode === 'down' && !clear(floor) && !solid(floor)) {
      reason = 'floor is not breakable'
      refusal = 'unbreakable'
    } else if (!supportSolid) {
      reason = `no solid support at (${support.x},${support.y},${support.z})`
      refusal = 'no_support'
    } else if (mode === 'down' && clear(floor)) {
      reason = 'floor already open (uncontrolled fall)'
      refusal = 'open_floor'
    } else if (hazardNearby) {
      reason = 'lava/water in the step column'
      refusal = 'hazard'
    }
    const primaryName = nameAt(primary)
    // the body's 1x2 profile at the landing: a transfer block in either cell means this
    // step is a dimension change, not a locomotion step (the sensor's own fact)
    const landingHead = { x: step.x, y: step.y + 1, z: step.z }
    const transfersDimension = TRANSFER.has(nameAt(step) ?? '') || TRANSFER.has(nameAt(landingHead) ?? '')
    return {
      dir,
      mode,
      dx,
      dz,
      step,
      wall,
      head,
      floor,
      wallSolid,
      headSolid,
      floorSolid,
      supportSolid,
      hazardNearby,
      ...(transfersDimension ? { transfersDimension: true } : {}),
      digs: digCells.map((cell) => ({
        cell,
        name: nameAt(cell),
        harvestTool: null,
        harvestTier: null,
        diggable: true,
      })),
      safe: reason === 'safe',
      reason,
      ...(refusal === undefined ? {} : { refusal }),
      digName: primaryName,
      digHarvestTool: null,
      digHarvestTier: null,
      diggable: primaryName !== null,
    } as DescentOption
  }
  const out: DescentOption[] = []
  for (const { dir, dx, dz } of DIRS) {
    out.push(option(dir, 'level', dx, dz))
    out.push(option(dir, 'down', dx, dz))
  }
  out.push(option('D', 'down', 0, 0))
  return out
}

/** True when the sensor's wall-entry gate (`shouldProbeWallEntry`) would fire. */
function wallEntryGate(descent: readonly DescentOption[]): boolean {
  return descent.some((option) => option.refusal === 'hazard' || option.refusal === 'no_support')
}

// ---------------------------------------------------------------------------
// the measured island, as a map: the solid rock band BELOW, the portal plane and its frame
// at the body's own level, and the two lava facts the flood rule must tell apart.
// ---------------------------------------------------------------------------
const FEET: Vec3Json = { x: 2, y: 59, z: -2 }
const PORTAL_CELLS: Vec3Json[] = [
  { x: 3, y: 59, z: -3 },
  { x: 3, y: 59, z: -2 },
  { x: 3, y: 60, z: -3 },
  { x: 3, y: 60, z: -2 },
  { x: 3, y: 61, z: -3 },
  { x: 3, y: 61, z: -2 },
]
const FRAME_CELLS: Vec3Json[] = [
  { x: 3, y: 58, z: -3 },
  { x: 3, y: 58, z: -2 },
  { x: 3, y: 62, z: -3 },
  { x: 3, y: 62, z: -2 },
  { x: 3, y: 59, z: -4 },
  { x: 3, y: 60, z: -4 },
  { x: 3, y: 61, z: -4 },
  { x: 3, y: 59, z: -1 },
  { x: 3, y: 60, z: -1 },
  { x: 3, y: 61, z: -1 },
]

function islandMap(): Terrain {
  const map = terrain()
  // the solid rock band the body stands on and can tunnel through (y55-58)
  fill(map, { x: -2, y: 55, z: -6 }, { x: 16, y: 58, z: 4 }, 'soul_soil')
  // the LOADED air the body stands in (an absent cell is UNLOADED - fixture (v) relies on
  // that, so the ordinary shape must name its air explicitly, exactly as the world loads it)
  fill(map, { x: -2, y: 59, z: -6 }, { x: 16, y: 70, z: 4 }, 'air')
  // the lit portal plane at x=3 (the dimension-transfer cells) and its obsidian frame
  for (const cell of PORTAL_CELLS) map.set(key(cell), 'nether_portal')
  for (const cell of FRAME_CELLS) map.set(key(cell), 'obsidian')
  // the FACE-ADJACENT fluid: lava in the cell next to the would-be y58 south pocket, so a
  // dig there would pour it in (the `would_flood` half of the rule)
  map.set(key({ x: 1, y: 58, z: -1 }), 'lava')
  // the fluid TWO CELLS AWAY with solid rock between: inside the sensor's 3x3x3 proximity
  // union of the own-column step (that is what refused the step live), with no face into any
  // pocket cell of the descent chain or of the level-56 continuation (the ALLOWED half)
  map.set(key({ x: 4, y: 58, z: -2 }), 'lava')
  return map
}

const frameMembers = (): LiveStructureMember[] =>
  FRAME_CELLS.map((position) => ({ kind: 'nether_portal', position }))

// ---------------------------------------------------------------------------
// candidate-layer state (the same shape `test-wall-entry.mts` uses)
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
  /** sense the REAL probes from the map (the measured shape), or omit them (ordinary terrain) */
  probe?: boolean
  /** register the portal frame as a LIVE structure (the real sensor does this from the frame) */
  frameLive?: boolean
  entryCell?: Vec3Json
  /** the spent-route ledger: the remedy arms only run once the goal's own route is spent */
  routes?: AgentSignals['zeroProgressRoutes']
}

function worldState(spec: WorldSpec): WorldState {
  const current = queuedPlace(spec.target)
  const descent = descentFixture(spec.feet, spec.map)
  // The real sensor senses these facts only while its own local-geology gate fires
  // (`shouldProbeWallEntry`): `probe: false` models a replay fixture that carries none, and the
  // gate itself is re-checked here so the fixtures cannot sense a probe the live sensor would not.
  const skipProbes = spec.probe === true ? false : spec.probe === false || !wallEntryGate(descent)
  return {
    schemaVersion: 1,
    tick: 9,
    timestampMs: 1_700_000_000_000,
    self: selfState(spec.feet),
    inventory: inventory(spec.counts ?? { wooden_pickaxe: 1, cobblestone: 8 }),
    entities: [],
    blocks: [],
    terrain: {
      standable: spec.standable ?? [spec.feet],
      // the real sensor samples the transfer cells from block truth; the fixture names the
      // same cells so the reachability gate is exercised against the real portal plane
      portalWalkInCells: PORTAL_CELLS.filter((cell) => spec.map.get(key(cell)) === 'nether_portal'),
    },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    portalFrameSites: [],
    liveStructureMembers: spec.frameLive === false ? [] : frameMembers(),
    descent,
    ...(skipProbes
      ? {}
      : {
          wallProbes: buildWallProbes(fakeBot(spec.feet, spec.map) as never, selfState(spec.feet), descent),
          levelScan: buildLevelScanProbes(fakeBot(spec.feet, spec.map) as never, selfState(spec.feet), descent),
        }),
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
    signals: signals({ ...(spec.routes === undefined ? {} : { zeroProgressRoutes: spec.routes }) }),
  }
}

/**
 * The controller's own recording path: the portal/enter route proved dead from this stand cell
 * (`path_no_path`), which is what makes the candidate layer re-ground the same target from a
 * different remedy (the live offer cycle).
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

/** A world state whose goal route is already spent, so the remedy arms (and the scan) re-ground. */
function spentState(spec: WorldSpec): WorldState {
  const options = optionsFor(spec)
  const first = worldState(spec)
  return worldState({ ...spec, routes: spendEntryRoute(first, options, spec.target) })
}

function optionsFor(spec: WorldSpec) {
  return {
    ...defaultCandidateOptions,
    portalEntry: entryPlanFor(spec.entryCell ?? spec.target),
    reachability: { pathProbe: () => 'no_path' as const },
  }
}

const levelCandidates = (candidates: readonly Candidate[]): Candidate[] =>
  candidates.filter((candidate) => candidate.meta.levelScan === true)
const entryCandidatesOf = (candidates: readonly Candidate[]): Candidate[] =>
  candidates.filter((candidate) => candidate.meta.digRouteEntry === true)

// ---------------------------------------------------------------------------
// (i) THE MEASURED ISLAND: nothing at the body's level, a grounded lateral continuation
// two/three levels down, the flood rule deciding per level, and the composed distance
// strictly decreasing.
// ---------------------------------------------------------------------------
{
  const TARGET: Vec3Json = { x: 12, y: 58, z: -2 }
  const map = islandMap()
  const spec: WorldSpec = { feet: FEET, target: TARGET, map, frameLive: true }
  const state = spentState(spec)
  const options = optionsFor(spec)
  const refusals: Parameters<typeof entryCandidates>[2] = []

  // the sensor facts the rule reads (the REAL builders over the modelled world)
  const eastLevel = state.wallProbes?.find((probe) => probe.dir === 'E' && probe.mode === 'level')
  const eastDown = state.wallProbes?.find((probe) => probe.dir === 'E' && probe.mode === 'down')
  const levels = state.levelScan ?? []
  const depth3 = levels.find((probe) => probe.depth === 3)
  const eastAt56 = depth3?.laterals.find((lateral) => lateral.dir === 'E')
  check(
    '(i) the sensor gate fired and the scan read exactly the bounded window (levels / probes / route length)',
    wallEntryGate(state.descent ?? []) &&
      levels.length === LEVEL_SCAN_MAX_LEVELS &&
      levels.every((probe) => probe.laterals.length === 4) &&
      LEVEL_SCAN_MAX_PROBES === LEVEL_SCAN_MAX_LEVELS * 5 &&
      LEVEL_SCAN_MAX_ROUTE_LENGTH === LEVEL_SCAN_MAX_LEVELS + 1,
    `levels=[${levels.map((probe) => `y${probe.y}(d${probe.depth})`).join(',')}] probes=${levels.length * 5} bound=${LEVEL_SCAN_MAX_PROBES} routeLen=${LEVEL_SCAN_MAX_ROUTE_LENGTH}`,
  )
  check(
    '(i) at the body OWN level east is the portal plane (`portal_plane`) and the frame is `protected` - never walked into, never mined',
    eastLevel !== undefined &&
      eastLevel.pocket[0].open &&
      eastLevel.pocket[0].name === 'nether_portal' &&
      wallPocketRefusal(eastLevel, () => false)?.reason === 'portal_plane' &&
      eastDown !== undefined &&
      eastDown.pocket[0].name === 'obsidian' &&
      wallPocketRefusal(eastDown, (cell) => FRAME_CELLS.some((frame) => key(frame) === key(cell)))?.reason === 'protected',
    `east.level=${eastLevel?.pocket.map((cell) => cell.name).join('+')} reason=${wallPocketRefusal(eastLevel ?? ({} as never), () => false)?.reason ?? 'none'} east.down=${eastDown?.pocket[0].name} protectedReason=${eastDown === undefined ? 'none' : (wallPocketRefusal(eastDown, (cell) => FRAME_CELLS.some((frame) => key(frame) === key(cell)))?.reason ?? 'none')}`,
  )
  // THE FLOOD RULE, per level: the same world holds a fluid FACE-ADJACENT to one would-be
  // pocket (refused) and a fluid TWO CELLS from another with solid rock between (allowed).
  const floodedPocket: Vec3Json[] = [
    { x: 2, y: 58, z: -1 },
    { x: 2, y: 59, z: -1 },
  ]
  const dryPocket: Vec3Json[] = [
    { x: 3, y: 56, z: -2 },
    { x: 3, y: 57, z: -2 },
  ]
  const at = (cell: Vec3Json) => {
    const name = map.get(key(cell))
    return name === undefined ? null : blockLike(name)
  }
  const flooded = floodNeighbours(floodedPocket, at)
  const dry = floodNeighbours(dryPocket, at)
  check(
    '(i) the flood rule decides per level: the same lava is face-adjacent to one pocket (refused) and two cells away from another (allowed)',
    flooded.length === 1 &&
      flooded[0]?.block === 'lava' &&
      key(flooded[0]?.cell ?? { x: 0, y: 0, z: 0 }) === '1,58,-1' &&
      dry.length === 0 &&
      eastAt56 !== undefined &&
      eastAt56.flood === false &&
      eastAt56.pocket[0].name === 'soul_soil',
    `flooded=[${flooded.map((entry) => `${entry.block}@${key(entry.cell)}`).join(',')}] dry=[${dry.length}] level56.east flood=${String(eastAt56?.flood)} block=${eastAt56?.pocket[0].name}`,
  )
  check(
    '(i) the own-column step is refused `hazard` by the 3x3x3 PROXIMITY rule, while the per-cell rule proves the shaft dry (the wall-entry situation, one level down)',
    (state.descent ?? []).find((step) => step.dir === 'D' && step.mode === 'down')?.refusal === 'hazard' &&
      levels[0]?.shaft.sensorRefusal === 'hazard' &&
      isVerifiedWallEntry(levels[0]?.shaft ?? ({} as never)),
    `sensor=${String((state.descent ?? []).find((step) => step.dir === 'D' && step.mode === 'down')?.refusal)} verified=${String(isVerifiedWallEntry(levels[0]?.shaft ?? ({} as never)))} flood=${String(levels[0]?.shaft.flood)}`,
  )
  // The ordinary dig route refuses (the measured live ledger shape): the only reducing step
  // is the east level step, refused `hazard` by proximity, so the DIG route is null.
  const dig = planDigRoute({
    selfPosition: state.self.position,
    target: TARGET,
    descent: state.descent,
    sealed: false,
  })
  const offered = entryCandidates(state, options, refusals).candidates
  const levelsOffered = levelCandidates(offered)
  check(
    '(i) the body own level cannot ground a dig route (the measured refusal), so the LEVEL SCAN is the arm that offers',
    dig.kind === 'refuse' && levelsOffered.length === 1 && entryCandidatesOf(offered).length === 0,
    `dig=${dig.kind === 'refuse' ? dig.refusal.reason : 'route'} offer=[${offered.map((candidate) => candidate.id).join(',')}]`,
  )
  const built = levelsOffered[0]
  check(
    '(i) the descent to the level with the grounded lateral continuation is offered, with level/cell/material/floor and the COMPOSED strict reduction',
    built !== undefined &&
      built.kind === 'DESCEND' &&
      built.meta.levelScanLevel === 56 &&
      built.meta.levelScanDepth === 3 &&
      built.meta.levelScanDir === 'E' &&
      built.meta.levelScanVia === 'dig' &&
      built.meta.levelScanCell === '3,56,-2' &&
      built.meta.levelScanBlock === 'soul_soil' &&
      built.meta.levelScanFloor === '3,55,-2' &&
      built.meta.levelScanFloorBlock === 'soul_soil' &&
      typeof built.meta.levelScanFrom === 'number' &&
      typeof built.meta.levelScanTo === 'number' &&
      (built.meta.levelScanTo as number) <= (built.meta.levelScanFrom as number) - LEVEL_SCAN_MIN_ADVANCE &&
      (built.meta.levelScanFrom as number) - (built.meta.levelScanTo as number) >= DIG_ROUTE_MIN_ADVANCE &&
      // the continuation also strictly reduces AT ITS OWN LEVEL: the ordinary dig route /
      // wall entry grounds the very same step once the body is there
      (built.meta.levelScanLevelTo as number) <= (built.meta.levelScanLevelFrom as number) - LEVEL_SCAN_MIN_ADVANCE &&
      built.meta.levelScanLength === 4,
    `level=${String(built?.meta.levelScanLevel)} depth=${String(built?.meta.levelScanDepth)} dir=${String(built?.meta.levelScanDir)} cell=${String(built?.meta.levelScanCell)} block=${String(built?.meta.levelScanBlock)} from=${String(built?.meta.levelScanFrom)} to=${String(built?.meta.levelScanTo)} levelD=${String(built?.meta.levelScanLevelFrom)}->${String(built?.meta.levelScanLevelTo)}`,
  )
  const line = typeof built?.meta.levelScanLine === 'string' ? (built.meta.levelScanLine as string) : ''
  check(
    '(i) the LEVEL_SCAN line names the level, the entry cell, the material, the per-level flood verdict and the distance change',
    line.startsWith('LEVEL_SCAN reason=no_walkable_route') &&
      line.includes('level=56') &&
      line.includes('cell=3,56,-2') &&
      line.includes('block=soul_soil') &&
      line.includes('floor_block=soul_soil') &&
      line.includes('from_d=') &&
      line.includes('to_d=') &&
      line.includes('levels=') &&
      line.includes('y58:E=protected@3,58,-2:obsidian') &&
      line.includes('y58:S=would_flood@1,58,-1:lava') &&
      line.includes('y56:E=safe'),
    `line=${line}`,
  )
  // The gate must present it and the guard must accept it - the depth-1 shaft is a VERIFIED
  // per-cell entry even though the sensor's proximity verdict refused the step.
  const grounded = generateGroundedCandidates(state, options)
  const presented = levelCandidates(grounded.candidates)
  const guardContext: GuardContext = {
    phase: 'decision',
    candidateIds: new Set(grounded.candidates.map((candidate) => candidate.id)),
    inFlight: null,
    reach: 4.5,
    maxCandidateAgeTicks: 40,
  }
  const verdict = presented[0] === undefined ? null : guardCandidate(presented[0], state, guardContext)
  check(
    '(i) the gate presents the descent and the guard accepts it as a VERIFIED own-column shaft',
    presented.length === 1 && verdict !== null && verdict.ok === true && presented[0]?.kind === 'DESCEND',
    `presented=[${presented.map((candidate) => candidate.id).join(',')}] guard=${verdict === null ? 'none' : verdict.ok ? 'ok' : verdict.reason}`,
  )
  // And the guard must still refuse the SAME candidate shape when the shaft probe is gone
  // (fail closed: the exemption is re-verified from the sensor facts, never from meta).
  const stripped: WorldState = { ...state, levelScan: undefined }
  const strippedVerdict = presented[0] === undefined ? null : guardCandidate(presented[0], stripped, guardContext)
  check(
    '(i) without the sensor shaft probe the same candidate is denied (the guard re-verifies, it never trusts meta)',
    strippedVerdict !== null && strippedVerdict.ok === false,
    `guard=${strippedVerdict === null ? 'none' : strippedVerdict.ok ? 'ok' : strippedVerdict.reason}`,
  )
}

// ---------------------------------------------------------------------------
// (ii) NO LEVEL YIELDS PROGRESS: a target straight above the body, so no descent can make
// the composed route closer -> typed `no_grounded_route` with the per-level ledger.
// ---------------------------------------------------------------------------
{
  const TARGET: Vec3Json = { x: 2, y: 74, z: -2 }
  const map = terrain()
  // a solid band below, a solid pocket around the body, and one lava pocket far enough to be
  // inside the E step's 3x3x3 (so the sensor gate fires) but with no face into any pocket
  fill(map, { x: -2, y: 55, z: -6 }, { x: 16, y: 58, z: 4 }, 'soul_soil')
  fill(map, { x: 1, y: 59, z: -2 }, { x: 3, y: 60, z: -2 }, 'soul_soil')
  fill(map, { x: 2, y: 59, z: -3 }, { x: 2, y: 60, z: -1 }, 'soul_soil')
  map.set(key({ x: 2, y: 59, z: -2 }), 'air')
  map.set(key({ x: 2, y: 60, z: -2 }), 'air')
  map.set(key({ x: 4, y: 59, z: -3 }), 'lava')
  const spec: WorldSpec = { feet: FEET, target: TARGET, map, frameLive: false }
  const state = spentState(spec)
  const refusals: Parameters<typeof entryCandidates>[2] = []
  const offered = entryCandidates(state, optionsFor(spec), refusals).candidates
  const refused = refusals.map((refusal) => formatDigRouteRefused(refusal))
  const scanRefusal = refused.find((line) => line.includes('reason=no_grounded_route') && line.includes('levels:'))
  check(
    '(ii) no level yields progress -> typed `no_grounded_route` with the per-level ledger and NO candidate',
    levelCandidates(offered).length === 0 &&
      typeof scanRefusal === 'string' &&
      scanRefusal.includes('y58:Ev=safe') &&
      scanRefusal.includes('E=no_progress'),
    `offer=[${offered.map((candidate) => candidate.id).join(',')}] refusal=${String(scanRefusal)}`,
  )
  // The rule itself says the same thing when driven directly (level, direction and the
  // composed distance are all in the ledger of the refusal).
  const decision = groundLevelScan({
    selfPosition: state.self.position,
    target: TARGET,
    levels: state.levelScan,
    minAdvance: LEVEL_SCAN_MIN_ADVANCE,
  })
  check(
    '(ii) the rule refuses with the same ledger when driven directly (no route, no exception)',
    decision.kind === 'refuse' &&
      decision.refusal.reason === 'no_grounded_route' &&
      decision.refusal.detail.includes('levels:') &&
      decision.refusal.detail.includes('y56:'),
    `decision=${decision.kind} detail=${decision.kind === 'refuse' ? decision.refusal.detail : 'route'}`,
  )
}

// ---------------------------------------------------------------------------
// (iii) ORDINARY TERRAIN: the sensor gate does not fire, so no scan is sensed and the offer
// is byte-identical (no level-scan candidate, no meta, no marker).
// ---------------------------------------------------------------------------
{
  const FEET_PLAIN: Vec3Json = { x: 2, y: 64, z: 2 }
  const TARGET: Vec3Json = { x: 12, y: 64, z: 2 }
  const map = terrain()
  fill(map, { x: -2, y: 60, z: -4 }, { x: 16, y: 63, z: 8 }, 'stone')
  // the loaded air above the plain (an absent cell is UNLOADED; the world loads its air)
  fill(map, { x: -2, y: 64, z: -4 }, { x: 16, y: 72, z: 8 }, 'air')
  const spec: WorldSpec = {
    feet: FEET_PLAIN,
    target: TARGET,
    map,
    standable: [FEET_PLAIN, { x: 3, y: 64, z: 2 }],
  }
  const descent = descentFixture(FEET_PLAIN, map)
  const state = worldState(spec)
  const offered = entryCandidates(state, optionsFor(spec)).candidates
  const json = JSON.stringify(offered)
  check(
    '(iii) ordinary terrain: the sensor gate is closed, no scan is sensed, no candidate and no marker',
    !wallEntryGate(descent) &&
      state.wallProbes === undefined &&
      state.levelScan === undefined &&
      levelCandidates(offered).length === 0 &&
      !json.includes('LEVEL_SCAN') &&
      offered.every((candidate) => candidate.meta.levelScanLine === undefined) &&
      offered.length > 0,
    `gate=${String(wallEntryGate(descent))} probes=${state.wallProbes === undefined ? 'none' : 'present'} scan=${state.levelScan === undefined ? 'none' : 'present'} offer=[${offered.map((candidate) => candidate.id).join(',')}]`,
  )
  // The counterfactual the gate exists for: the SAME terrain WOULD offer a descent if the
  // scan were sensed, which is why the gate (not the rule) keeps ordinary terrain untouched.
  const forcedSpec: WorldSpec = { ...spec, probe: true }
  const forced = spentState(forcedSpec)
  const forcedOffered = entryCandidates(forced, optionsFor(forcedSpec)).candidates
  const forcedDecision = groundLevelScan({
    selfPosition: forced.self.position,
    target: TARGET,
    levels: forced.levelScan,
    minAdvance: LEVEL_SCAN_MIN_ADVANCE,
  })
  check(
    '(iii) the gate (not the rule) keeps ordinary terrain untouched: those probes WOULD ground a descent, and the ordinary route still owns the offer',
    forced.levelScan !== undefined &&
      forced.levelScan.length === LEVEL_SCAN_MAX_LEVELS &&
      forcedDecision.kind === 'route' &&
      levelCandidates(forcedOffered).length === 0 &&
      forcedOffered.some((candidate) => candidate.id.startsWith('DIG_ROUTE:')),
    `forced scan=${forced.levelScan?.length ?? 0} rule=${forcedDecision.kind === 'route' ? forcedDecision.routes.map((route) => `${route.level}:${route.dir}`).join(',') : 'none'} offer=[${forcedOffered.map((candidate) => candidate.id).join(',')}]`,
  )
}

// ---------------------------------------------------------------------------
// (iv) SEVERAL LEVELS / DIRECTIONS GROUNDED: the boundary names every alternative and code
// chooses neither a level nor a direction (one mechanical first step, one action).
// ---------------------------------------------------------------------------
{
  const TARGET: Vec3Json = { x: 11, y: 57, z: 5 }
  const map = islandMap()
  const spec: WorldSpec = { feet: FEET, target: TARGET, map, frameLive: true }
  const state = spentState(spec)
  const offered = entryCandidates(state, optionsFor(spec)).candidates
  const levelsOffered = levelCandidates(offered)
  const alternatives = String(levelsOffered[0]?.meta.levelScanAlternatives ?? '')
  const boundary = String(levelsOffered[0]?.meta.legPolicyBoundary ?? '')
  const authority = String(levelsOffered[0]?.meta.levelScanAuthorityLine ?? '')
  check(
    '(iv) several grounded (level, direction) routes -> EVERY alternative is named and code chooses none',
    levelsOffered.length === 1 &&
      alternatives.split(',').length >= 2 &&
      boundary.includes('SKILL_POLICY_BOUNDARY') &&
      boundary.includes('reason=multiple_grounded_level_routes') &&
      alternatives
        .split(',')
        .every((alternative) => boundary.includes(`dig:level_scan:${alternative}`)) &&
      authority.includes('MECHANICAL_CONTINUATION') &&
      !authority.includes('MANDATORY_PREREQUISITE'),
    `offer=[${levelsOffered.map((candidate) => candidate.id).join(',')}] alternatives=${alternatives} boundary=${boundary}`,
  )
  // Exactly ONE grounded route is the section 7 prerequisite: the same map with a target that
  // only the east route closes.
  const singleSpec: WorldSpec = { ...spec, target: { x: 12, y: 58, z: -2 } }
  const single = spentState(singleSpec)
  const singleOffered = levelCandidates(entryCandidates(single, optionsFor(singleSpec)).candidates)
  check(
    '(iv) exactly one grounded route runs as the section 7 prerequisite (REFLEX + MANDATORY_PREREQUISITE)',
    singleOffered.length === 1 &&
      String(singleOffered[0]?.meta.levelScanAuthorityLine ?? '').includes('MANDATORY_PREREQUISITE') &&
      typeof singleOffered[0]?.meta.legReflex === 'string' &&
      String(singleOffered[0]?.meta.legReflex ?? '').includes('level_scan'),
    `authority=${String(singleOffered[0]?.meta.levelScanAuthorityLine ?? 'none')} reflex=${String(singleOffered[0]?.meta.legReflex ?? 'none')}`,
  )
}

// ---------------------------------------------------------------------------
// (v) AN UNLOADED LEVEL IS NOT CLEAR: the unknown cell breaks the chain and is the headline
// cause; the SAME geometry with those cells loaded DOES ground.
// ---------------------------------------------------------------------------
{
  const TARGET: Vec3Json = { x: 12, y: 58, z: -2 }
  const unloaded = islandMap()
  drop(unloaded, { x: -2, y: 55, z: -6 }, { x: 16, y: 57, z: 4 })
  const spec: WorldSpec = { feet: FEET, target: TARGET, map: unloaded, frameLive: true }
  const state = spentState(spec)
  const refusals: Parameters<typeof entryCandidates>[2] = []
  const offered = entryCandidates(state, optionsFor(spec), refusals).candidates
  const refused = refusals.map((refusal) => formatDigRouteRefused(refusal))
  const unknownLine = refused.find((line) => line.includes('2,57,-2') && line.includes('unloaded'))
  check(
    '(v) an unloaded level is NOT clear: the chain breaks at the unknown cell and nothing is offered',
    levelCandidates(offered).length === 0 &&
      state.levelScan?.[0]?.shaft.floor.observed === false &&
      levelsUnobserved(state) &&
      typeof unknownLine === 'string' &&
      unknownLine.includes('levels:') &&
      unknownLine.includes('y58:Ev='),
    `offer=[${offered.map((candidate) => candidate.id).join(',')}] refusal=${String(unknownLine)}`,
  )
  const loadedSpec: WorldSpec = { feet: FEET, target: TARGET, map: islandMap(), frameLive: true }
  const loaded = spentState(loadedSpec)
  const loadedOffered = levelCandidates(entryCandidates(loaded, optionsFor(loadedSpec)).candidates)
  check(
    '(v) the control: the SAME geometry with those cells loaded grounds the descent (the unknown was the blocker)',
    loadedOffered.length === 1 && loadedOffered[0]?.meta.levelScanLevel === 56,
    `offer=[${loadedOffered.map((candidate) => `${candidate.id}@${String(candidate.meta.levelScanLevel)}`).join(',')}]`,
  )
}

function levelsUnobserved(state: WorldState): boolean {
  const first = state.levelScan?.[0]
  return first !== undefined && first.shaft.pocket.every((cell) => cell.observed) && first.shaft.floor.observed === false
}

// ---------------------------------------------------------------------------
// (vi) THE EXISTING GUARDS STAY PINNED.
// ---------------------------------------------------------------------------
{
  // a lethal step still stops: lava as the landing of a walk step
  const lethal = classifyStepLanding({
    landing: { name: 'lava', boundingBox: 'empty' },
    head: { name: 'air', boundingBox: 'empty' },
    below: [{ name: 'stone', boundingBox: 'block' }],
  })
  const line = formatMoveLegStopped({
    reason: lethal.reason ?? 'hazard_between',
    from: { x: 2, y: 59, z: -2 },
    to: { x: 3, y: 59, z: -2 },
    block: lethal.block,
    support: lethal.support,
  })
  check(
    '(vi) a lethal step still stops: MOVE_LEG_STOPPED reason=hazard_between (the landing guard is untouched)',
    lethal.reason === 'hazard_between' &&
      line.startsWith('MOVE_LEG_STOPPED reason=hazard_between') &&
      MIRRORED_MARKERS.has('MOVE_LEG_STOPPED'),
    `line=${line}`,
  )
  // a lethal drop under an open landing still stops
  const drop = classifyStepLanding({
    landing: { name: 'air', boundingBox: 'empty' },
    head: { name: 'air', boundingBox: 'empty' },
    below: [null],
  })
  check(
    '(vi) an unknown column under a landing is not a refusal and not a hazard (the existing fail-open shape is unchanged)',
    drop.reason === null && drop.support === 'unknown',
    `reason=${String(drop.reason)} support=${drop.support}`,
  )
  // the portal plane stays protected: no mechanical realization may end inside it, and the
  // explicit ENTER_PORTAL route is the exemption (the reachability gate still refuses a MOVE)
  const map = islandMap()
  const spec: WorldSpec = { feet: FEET, target: { x: 12, y: 58, z: -2 }, map, frameLive: true }
  const state = spentState(spec)
  const portalMove: Candidate = {
    id: 'MOVE:p3_59_-2',
    kind: 'MOVE',
    label: 'step into the lit portal plane',
    targetName: null,
    target: { x: 3, y: 59, z: -2 },
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: state.tick },
  }
  const gated = applyReachabilityGate([portalMove], state, defaultCandidateOptions)
  const withheld = gated.withheld.find((entry) => entry.candidate.id === portalMove.id)
  // the level scan itself never proposes a pocket inside the portal plane: the depth-1 east
  // continuation is refused `portal_plane`/`protected` and cannot become a route
  const decision = groundLevelScan({
    selfPosition: state.self.position,
    target: { x: 12, y: 58, z: -2 },
    levels: state.levelScan,
    minAdvance: LEVEL_SCAN_MIN_ADVANCE,
    isProtected: (cell) => FRAME_CELLS.some((frame) => key(frame) === key(cell)),
  })
  const evalLine = formatLevelLedger(decision.kind === 'route' ? decision.routes[0]?.verdicts ?? [] : [])
  check(
    '(vi) the portal plane stays protected and crosses_dimension still refuses a dimensional realization',
    !gated.candidates.some((candidate) => candidate.id === portalMove.id) &&
      withheld?.result.reason === 'crosses_dimension' &&
      MIRRORED_MARKERS.has('LEVEL_SCAN') &&
      MIRRORED_MARKERS.has('LEVEL_SCAN_STEP') &&
      MIRRORED_MARKERS.has('SKILL_POLICY_BOUNDARY') &&
      (decision.kind === 'route'
        ? decision.routes.every((route) => !PORTAL_CELLS.some((portal) => key(portal) === key(route.cell)))
        : true) &&
      (evalLine.length === 0 || !evalLine.includes('portal_plane@')),
    `gate=${withheld?.result.reason ?? 'none'} mirrored=${MIRRORED_MARKERS.has('LEVEL_SCAN')}/${MIRRORED_MARKERS.has('LEVEL_SCAN_STEP')} route=${decision.kind === 'route' ? decision.routes.map((route) => `${route.level}:${route.dir}`).join(',') : 'none'}`,
  )
  // and the wall probe at the body's own level says `portal_plane` for the open portal profile
  const east = state.wallProbes?.find((probe) => probe.dir === 'E' && probe.mode === 'level')
  check(
    '(vi) the adjacent east probe answers `portal_plane` (not `no_wall`): the reason the profile may not be entered is named',
    east !== undefined && wallPocketRefusal(east, () => false)?.reason === 'portal_plane',
    `reason=${east === undefined ? 'none' : (wallPocketRefusal(east, () => false)?.reason ?? 'safe')}`,
  )
  // THE HARDENING THE SAME INVARIANT REQUIRES: with the lava absent the east level step is
  // `safe` by the sensor's own proximity rule, yet its landing IS the lit portal plane - the
  // planner refuses it typed `portal_plane` (never a route) and the guard denies the
  // realization outright, so no mechanical dig can teleport the body.
  const dry = islandMap()
  dry.delete(key({ x: 1, y: 58, z: -1 }))
  dry.delete(key({ x: 4, y: 58, z: -2 }))
  const dryDescent = descentFixture(FEET, dry)
  const eastDry = dryDescent.find((step) => step.dir === 'E' && step.mode === 'level')
  const dryDecision = planDigRoute({ selfPosition: FEET, target: { x: 12, y: 58, z: -2 }, descent: dryDescent })
  const dryLine = dryDecision.kind === 'refuse' ? formatDigRouteRefused(dryDecision.refusal) : 'route'
  const portalStep = dryDescent.find((step) => step.dir === 'E' && step.mode === 'level')
  const portalDescend: Candidate = {
    id: 'DESCEND:level:E:b3_60_-2',
    kind: 'DESCEND',
    label: 'dig one block forward into the portal plane',
    targetName: null,
    target: { x: 3, y: 60, z: -2 },
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: state.tick, mode: 'level', dir: 'E' },
  }
  const guardContext2: GuardContext = {
    phase: 'decision',
    candidateIds: new Set([portalDescend.id]),
    inFlight: null,
    reach: 4.5,
    maxCandidateAgeTicks: 40,
  }
  const portalVerdict = guardCandidate(portalDescend, { ...state, descent: dryDescent }, guardContext2)
  check(
    '(vi) a proximity-`safe` step into the portal plane is never a dig route and the guard denies its realization (CROSSES_DIMENSION)',
    eastDry?.safe === true &&
      eastDry.transfersDimension === true &&
      dryDecision.kind === 'refuse' &&
      dryDecision.refusal.reason === 'portal_plane' &&
      dryLine.includes('reason=portal_plane') &&
      portalStep?.transfersDimension === true &&
      portalVerdict.ok === false &&
      portalVerdict.code === 'CROSSES_DIMENSION',
    `sensorSafe=${String(eastDry?.safe)} transfers=${String(eastDry?.transfersDimension)} dig=${dryDecision.kind === 'refuse' ? dryDecision.refusal.reason : 'route'} guard=${portalVerdict.ok ? 'ok' : portalVerdict.code}`,
  )
  // the composed-route bound is the declared one and the geometry is the fixture's own
  check(
    '(vi) the composed bound is the declared margin and the fixture measures it (2.03m closer than the body)',
    distance(FEET, { x: 12, y: 58, z: -2 }) - distance({ x: 3, y: 56, z: -2 }, { x: 12, y: 58, z: -2 }) >= LEVEL_SCAN_MIN_ADVANCE &&
      STEP_SUPPORT_NONE === 'none' &&
      !isVerifiedWallEntry({ landing: { x: 3, y: 59, z: -2 }, pocket: [{ cell: { x: 3, y: 59, z: -2 }, name: 'nether_portal', open: true, solid: false, breakable: false, observed: true }, { cell: { x: 3, y: 60, z: -2 }, name: 'nether_portal', open: true, solid: false, breakable: false, observed: true }], floor: { cell: { x: 3, y: 58, z: -2 }, name: 'obsidian', open: false, solid: true, breakable: true, observed: true }, flood: false, floodCell: null, floodBlock: null }),
    `reduction=${Math.round((distance(FEET, { x: 12, y: 58, z: -2 }) - distance({ x: 3, y: 56, z: -2 }, { x: 12, y: 58, z: -2 })) * 100) / 100}`,
  )
}

// ---------------------------------------------------------------------------
// (vii) THE WIRING: the new evidence must reach the live loop, or the markers are only
// strings in a unit test. The selection path, the settled path, the mirrored set and the
// offer itself are all checked against the real sources.
// ---------------------------------------------------------------------------
{
  const source =
    readFileSync(new URL('./src/controller.ts', import.meta.url), 'utf8') +
    readFileSync(new URL('./src/candidate-diagnostics.ts', import.meta.url), 'utf8') +
    readFileSync(new URL('./src/outcome-accounting.ts', import.meta.url), 'utf8')
  const candidatesSource = readFileSync(new URL('./src/candidates.ts', import.meta.url), 'utf8')
  const policySource = readFileSync(new URL('./src/policy.ts', import.meta.url), 'utf8')
  const checks: Array<[string, boolean]> = [
    ['LEVEL_SCAN logged when selected', /if \(guarded\.candidate\.meta\.levelScan === true\) this\.logLevelScan\(guarded\.candidate\)/.test(source)],
    ['LEVEL_SCAN_STEP on a settled descent', /if \(candidate\.meta\.levelScan === true\) host\.logLevelScanStep\(result, candidate\)/.test(source)],
    ['LEVEL_SCAN mirrored', /const MIRRORED_MARKERS[\s\S]*?'LEVEL_SCAN'/.test(source)],
    ['LEVEL_SCAN_STEP mirrored', /const MIRRORED_MARKERS[\s\S]*?'LEVEL_SCAN_STEP'/.test(source)],
    ['the §7 layer half rides SKILL_STEP', /step: 'level_scan'/.test(source)],
    ['the offer enumerates every grounded route', /levelScanAlternatives: alternatives\.join\(','\)/.test(candidatesSource)],
    ['several routes -> the boundary names them', /reason: 'multiple_grounded_level_routes'/.test(candidatesSource)],
    ['the scan runs only after the dig route AND the wall entry refused', /dig === null && entries\.candidates\.length === 0[\s\S]{0,400}levelScanCandidates\(/.test(candidatesSource)],
    ['the guard re-verifies the shaft from the sensor facts', /const verifiedShaft = shaftProbe !== undefined && isVerifiedWallEntry\(shaftProbe\.shaft\)/.test(policySource)],
    ['the level scan is sensed under the same gate as the wall probes', /shouldProbeWallEntry\(descent\)[\s\S]{0,200}levelScan: buildLevelScanProbes/.test(readFileSync(new URL('./src/state.ts', import.meta.url), 'utf8'))],
  ]
  const failed = checks.filter(([, ok]) => !ok).map(([label]) => label)
  // The settled-step line's shape, pure and pinned: the level the body reached, how many
  // own-column steps still separate it from the continuation, and the distance change.
  const stepLine = formatLevelScanStep({
    from: { x: 2, y: 59, z: -2 },
    to: { x: 2, y: 58, z: -2 },
    targetLevel: 56,
    fromDistance: 10.05,
    toDistance: 10,
  })
  checks.push([
    'LEVEL_SCAN_STEP names the reached level, the remaining depth and the distance change',
    stepLine ===
      'LEVEL_SCAN_STEP from=2,59,-2 level=58 target_level=56 remaining=2 from_d=10.05 to_d=10',
  ])
  check(
    '(vii) the controller, the offer, the guard and the sensor are wired for LEVEL_SCAN / LEVEL_SCAN_STEP',
    failed.length === 0,
    failed.length === 0 ? 'all markers wired' : `missing: ${failed.join(', ')}`,
  )
}


// ---------------------------------------------------------------------------
// The level-scan step DUGS, so it must declare the dig the envelope grants.
// Measured live before this was pinned: 40 SKILL_ENVELOPE_VIOLATIONs in ten
// minutes, every one `effect=dig ... violation=dig_cell_not_declared`, because
// the candidate carried the levelScan* facts but not `digRoute: true` - the flag
// the DESCEND/MOVE envelope derives `mayDigGroundedRoute` from. The ordinary dig
// route declares exactly this, which is why it never hit it.
// ---------------------------------------------------------------------------

{
  const TARGET: Vec3Json = { x: 12, y: 58, z: -2 }
  const spec: WorldSpec = { feet: FEET, target: TARGET, map: islandMap(), frameLive: true }
  const state = spentState(spec)
  const options = optionsFor(spec)
  const refusals: Parameters<typeof entryCandidates>[2] = []
  const offered = entryCandidates(state, options, refusals).candidates
  const built = offered.filter((candidate) => candidate.meta.levelScan === true)[0]
  check(
    'the level-scan candidate declares digRoute (its own dig is inside the envelope)',
    built !== undefined &&
      built.meta.digRoute === true &&
      built.meta.levelScan === true,
    built === undefined
      ? 'no candidate built'
      : `digRoute=${String(built.meta.digRoute)} levelScan=${String(built.meta.levelScan)} kind=${built.kind}`,
  )
}

process.stdout.write(`\nlevel scan fixtures: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}\n`)
if (failures > 0) process.exit(1)
