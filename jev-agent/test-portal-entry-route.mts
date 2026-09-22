// test-portal-entry-route.mts - the ENTER_PORTAL approach must use the SAME
// bounded dig/vertical route machinery as every other "get to a cell" goal.
//
// LIVE WITNESS (run-mubj6ucc-si3e, source 52594db, m3-live): the ladder reached
// `enter_nether`, the ledger construction rows were retired, `nether_portal` was
// named, and the entry was offered and CHOSEN:
//
//   ACTION n=3939/3952 id=ENTER:26,67,9 kind=ENTER_PORTAL phase=pathing
//   PATH_CALLBACK phase=failed actionId=ENTER:26,67,9 outcome=noPath
//   PATH_CALLBACK phase=failed actionId=ENTER:26,67,9 outcome=stuck
//   HEARTBEAT pos=26.3,53.9,9.5 health=14 rung=enter_nether
//
// The gate was standing and lit (obsidian=10, nether_portal=6 in the z=9 plane,
// interior stand cells 26,67,9 / 27,67,9) and the body was ~14 blocks BELOW it
// inside dug-out terrain. The entry executor called
// `pathTo(enterCell, 'GoalBlock')` with no dig/vertical fallback, so a target
// above the body behind diggable rock reported `noPath`/`stuck` forever.
//
// This fixture proves, offline:
//   (w) BEFORE-WITNESS: an ENTER candidate for a body below the lit gate with a
//       diggable step between carries a grounded route (the same `vertical`
//       meta a MOVE candidate carries). Pre-fix it carries `vertical=none`.
//   (a) body below a lit gate with diggable terrain between: the executor digs
//       the step through the terrain, climbs, walks into the interior cell and
//       the dimension postcondition is reached.
//   (b) a route already exists (one-block step): unchanged behaviour, no
//       gratuitous digging, exactly one generic path call.
//   (c) a genuinely impossible obstruction (unbreakable face, nothing
//       placeable): ONE typed failure naming the obstruction, not an endless
//       `noPath` re-arm loop.
//
// Run: bun jev-agent/test-portal-entry-route.mts
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import {
  NETHER,
  NETHER_PORTAL,
  OVERWORLD,
  PORTAL_ENTERED_PREDICATE,
  PORTAL_ENTRY_UNVERIFIED,
  formatPortalEntryNoKnownSite,
  planPortalEntry,
  portalFrameLayout,
  serializePortalCells,
} from './src/netherPortalPlan.ts'
import type { PortalEntryPlan, PortalFrameSite } from './src/netherPortalPlan.ts'
import { defaultCandidateOptions, entryCandidates, generateGroundedCandidates } from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import { cellKey, observeZeroProgressRoute, routeSignature } from './src/zeroProgressRoute.ts'
import { Executor, ExecutorError, defaultExecutorOptions } from './src/executor.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { AgentSignals, DescentOption, InventoryState, SelfState, StepCut, Vec3Json, WorldState } from './src/state.ts'
import { isStandable } from './src/state.ts'
import { StateFingerprintMemory } from './src/moveFailMemory.ts'
import { EventLogger, JsonlWriter } from './src/jev.ts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const key = (p: Vec3Json): string => `${p.x},${p.y},${p.z}`

// ---------------------------------------------------------------------------
// the live gate geometry: frame origin (25,66,9), plane z=9, interior x 26..27
// y 67..69, stand rows 26,67,9 / 27,67,9. The body is BELOW it in a pit.
// ---------------------------------------------------------------------------
const ORIGIN: Vec3Json = { x: 25, y: 66, z: 9 }
const LAYOUT = portalFrameLayout(ORIGIN, 'x')
const ENTER_CELL: Vec3Json = { x: 26, y: 67, z: 9 }
const SITE: PortalFrameSite = { origin: ORIGIN, widthAxis: 'x', safe: true, reachable: true, existingFrame: LAYOUT.frame }

interface Cell {
  name: string
  boundingBox: string
}
function cell(name: string): Cell {
  return { name, boundingBox: name === 'air' || name === NETHER_PORTAL ? 'empty' : 'block' }
}

/** The gate itself: frame ring solid, interior lit, stand support under the enter cell. */
function gateGrid(): Map<string, Cell> {
  const grid = new Map<string, Cell>()
  for (const c of LAYOUT.frame) grid.set(key(c), cell('obsidian'))
  for (const c of LAYOUT.corners) grid.set(key(c), cell('cobblestone'))
  for (const c of LAYOUT.interior) grid.set(key(c), cell(NETHER_PORTAL))
  return grid
}

// ---------------------------------------------------------------------------
// a grid + dig + pathfinder bot. `pathTo` is the fixture's WORLD MODEL of the
// generic mover: the interior is reachable only once the body has climbed to
// the gate floor (feet y >= enterCell.y - 1) and is beside it. The vertical
// step targets are honored directly (they are the route the planner chose).
// ---------------------------------------------------------------------------
interface FixtureBot {
  bot: Bot
  position: Vec3
  grid: Map<string, Cell>
  digs: string[]
  pathCalls: Vec3Json[]
  legs: string[]
  /** mutable live inventory: a fixture can take the tool away after the plan was built */
  inventoryItems: Array<{ name: string; type: number; count: number }>
}

function makeBot(feet: Vec3Json, grid: Map<string, Cell>, hasPickaxe: boolean): FixtureBot {
  const position = new Vec3(feet.x + 0.5, feet.y, feet.z + 0.5)
  const digs: string[] = []
  const pathCalls: Vec3Json[] = []
  const legs: string[] = []
  const inventoryItems = hasPickaxe ? [{ name: 'diamond_pickaxe', type: registry.itemsByName.diamond_pickaxe.id as number, count: 1 }] : []
  const blockAt = (v: { x: number; y: number; z: number }) => {
    const found = grid.get(`${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`)
    if (found === undefined) return null
    return {
      name: found.name,
      boundingBox: found.boundingBox,
      diggable: found.name !== 'bedrock' && found.boundingBox === 'block',
      position: new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)),
    }
  }
  const listeners = new Map<string, Set<() => void>>()
  const bot = {
    registry,
    game: { dimension: OVERWORLD as string },
    entity: {
      position,
      yaw: 0,
      pitch: 0,
      onGround: true,
      width: 0.6,
      height: 1.8,
      velocity: new Vec3(0, 0, 0),
      offset: (x: number, y: number, z: number) => position.offset(x, y, z),
      clone: () => position.clone(),
      distanceTo: (other: { x: number; y: number; z: number }) => position.distanceTo(other as Vec3),
    },
    _client: { write: () => true },
    physicsEnabled: true,
    entities: {},
    inventory: {
      items: () => inventoryItems,
      count: () => 0,
    },
    heldItem: hasPickaxe ? inventoryItems[0] : null,
    blockAt,
    on: (event: string, listener: () => void) => {
      const set = listeners.get(event) ?? new Set<() => void>()
      set.add(listener)
      listeners.set(event, set)
    },
    removeListener: (event: string, listener: () => void) => {
      listeners.get(event)?.delete(listener)
    },
    setControlState: () => undefined,
    clearControlStates: () => undefined,
    canDigBlock: () => true,
    lookAt: async () => undefined,
    digTime: () => 50,
    dig: async (block: { position: Vec3Json; name: string }) => {
      const k = key({ x: Math.floor(block.position.x), y: Math.floor(block.position.y), z: Math.floor(block.position.z) })
      digs.push(`${block.name}@${k}`)
      grid.set(k, cell('air'))
    },
    stopDigging: () => undefined,
    equip: async () => undefined,
    pathfinder: {
      movements: null as unknown,
      setMovements: (movements: unknown) => {
        bot.pathfinder.movements = movements
      },
      setGoal: () => undefined,
      stop: () => undefined,
      getPathTo: () => ({ status: 'noPath', path: [] }),
    },
  }
  return { bot: bot as unknown as Bot, position, grid, digs, pathCalls, legs, inventoryItems }
}

function canWalkIntoGate(fixture: FixtureBot): boolean {
  const p = fixture.position
  return (
    Math.floor(p.y) >= ENTER_CELL.y - 1 &&
    Math.hypot(p.x - (ENTER_CELL.x + 0.5), p.z - (ENTER_CELL.z + 0.5)) <= 2.5
  )
}

/**
 * Install the fixture's world model on the executor's two locomotion seams.
 * `pathTo(step)` (a route-cell the planner chose) is honored; `pathTo(enterCell)`
 * succeeds only when the body has actually reached the gate floor beside it.
 */
function installLocomotion(
  executor: Executor,
  fixture: FixtureBot,
  transfer: boolean,
  strictGate = false,
): void {
  // `strictGate` models the real world: the interior cell is only walkable from
  // the gate's OWN floor level. The default (loose) model is the historical
  // fixture seam used by the ascent cases, where the body climbs to the gate
  // floor through the route leg before the walk is retried.
  const atGateLevel = (): boolean => !strictGate || Math.abs(fixture.position.y - ENTER_CELL.y) <= 1
  const pathTo = async (target: Vec3Json): Promise<void> => {
    fixture.pathCalls.push({ ...target })
    if (key(target) === key(ENTER_CELL)) {
      if (!canWalkIntoGate(fixture) || !atGateLevel()) {
        throw new ExecutorError('path_no_path', 'pathfinder GoalBlock -> noPath')
      }
      fixture.position.set(ENTER_CELL.x + 0.5, ENTER_CELL.y, ENTER_CELL.z + 0.5)
      if (transfer) (fixture.bot.game as unknown as { dimension: string }).dimension = NETHER
      return
    }
    // a planned vertical step cell: the generic mover climbs into it
    fixture.legs.push(key(target))
    fixture.position.set(target.x + 0.5, target.y, target.z + 0.5)
  }
  const pathToNear = async (target: Vec3Json): Promise<void> => {
    fixture.position.set(target.x + 0.5, target.y, target.z + 0.5)
  }
  ;(executor as unknown as { pathTo: typeof pathTo }).pathTo = pathTo
  ;(executor as unknown as { pathToNear: typeof pathToNear }).pathToNear = pathToNear
}

// ---------------------------------------------------------------------------
// candidate-layer state
// ---------------------------------------------------------------------------
function self(position: Vec3Json, dimension: string = OVERWORLD): SelfState {
  return {
    username: 'AI_ENTRY',
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

function inventory(counts: Record<string, number>): InventoryState {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0) }
}

function signals(): AgentSignals {
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
  }
}

function queuedPlace(): QueuedGoal {
  return {
    id: 'g-portal-entered',
    kind: 'place',
    description: 'portal_entered nether_portal',
    targetItem: NETHER_PORTAL,
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

function worldState(
  bodyFeet: Vec3Json,
  stepCuts: StepCut[],
  counts: Record<string, number>,
  descent: DescentOption[] = [],
  standable: Vec3Json[] = [bodyFeet],
): WorldState {
  const current = queuedPlace()
  return {
    schemaVersion: 1,
    tick: 9,
    timestampMs: 1_700_000_000_000,
    self: self(bodyFeet),
    inventory: inventory(counts),
    entities: [],
    blocks: [],
    terrain: { standable },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    portalFrameSites: [SITE],
    descent,
    stepCuts,
    headroomCuts: [],
    goal: {
      id: 'g',
      description: 'enter the lit nether portal',
      targetItem: NETHER_PORTAL,
      requiredCount: 1,
      startCount: 0,
      haveCount: 0,
      progress: 0,
      complete: false,
      startedAtMs: 0,
    },
    goalQueue: queueWith(current),
    recentEvents: [],
    signals: signals(),
  }
}

/** The gate's entry plan (lit interior + standable enter cell), from live world truth. */
function entryPlan(fixture: FixtureBot): PortalEntryPlan {
  const plan = planPortalEntry({
    site: SITE,
    self: { x: ENTER_CELL.x, y: ENTER_CELL.y - 1, z: ENTER_CELL.z - 1 },
    blockAt: (c) => fixture.bot.blockAt(new Vec3(c.x, c.y, c.z))?.name ?? null,
    isStandable: (c) => isStandable(fixture.bot, c),
    fromDimension: OVERWORLD,
    dimension: NETHER,
  })
  if (!plan.ok) throw new Error(`fixture: expected a grounded entry plan (${plan.line})`)
  return plan
}

function enterCandidate(fixture: FixtureBot, state: WorldState): Candidate {
  const options: CandidateOptions = { ...defaultCandidateOptions, portalEntry: entryPlan(fixture) }
  const result = entryCandidates(state, options)
  const candidate = result.candidates.find((entry) => entry.kind === 'ENTER_PORTAL')
  if (candidate === undefined) throw new Error('fixture: the candidate layer offered no ENTER_PORTAL candidate')
  return candidate
}

async function runEntry(
  fixture: FixtureBot,
  candidate: Candidate,
  transfer: boolean,
  strictGate = false,
  configure?: (executor: Executor) => void,
): Promise<{ status: string; failure: string | null; verified: boolean; messages: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'portal-entry-route-'))
  const logger = new EventLogger(new JsonlWriter(join(dir, 'agent.jsonl')), false)
  const executor = new Executor(fixture.bot, logger, { ...defaultExecutorOptions, actuation: 'packet', portalEnterTimeoutMs: 400 })
  installLocomotion(executor, fixture, transfer, strictGate)
  configure?.(executor)
  const result = await executor.claim(candidate).completion
  const messages = (await Bun.file(join(dir, 'agent.jsonl')).text())
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { message?: string }).message ?? '')
  return { status: result.status, failure: result.failure, verified: result.verified, messages }
}

const STONE_STEP: StepCut = {
  dir: 'W',
  dx: -1,
  dz: 0,
  cut: { x: 26, y: 66, z: 8 },
  step: { x: 26, y: 66, z: 8 },
  name: 'stone',
  safe: true,
  reason: 'safe',
}

// ---------------------------------------------------------------------------
// (w) BEFORE-WITNESS + (a) the body below the gate carries a grounded route and
// the executor digs through the terrain, climbs, walks in, and transfers.
// ---------------------------------------------------------------------------
{
  const grid = gateGrid()
  // the pit the body is in, and the diggable step between it and the gate floor
  grid.set('26,64,8', cell('stone'))
  grid.set('27,64,8', cell('stone'))
  grid.set('26,65,8', cell('stone'))
  grid.set('26,66,8', cell('stone'))
  const fixture = makeBot({ x: 27, y: 65, z: 8 }, grid, true)
  const state = worldState({ x: 27.5, y: 65, z: 8.5 }, [STONE_STEP], { diamond_pickaxe: 1, cobblestone: 32 })
  const candidate = enterCandidate(fixture, state)
  const vertical = typeof candidate.meta.vertical === 'string' ? candidate.meta.vertical : 'none'
  check(
    '(w) an ENTER candidate below the lit gate carries the same grounded `vertical` route a MOVE candidate carries',
    vertical === 'staircase-up' && candidate.meta.upDigY === 66,
    `vertical=${vertical} upDig=(${candidate.meta.upDigX ?? '-'},${candidate.meta.upDigY ?? '-'},${candidate.meta.upDigZ ?? '-'})`,
  )

  const result = await runEntry(fixture, candidate, true)
  const entered = result.messages.some((line) => line.startsWith('PORTAL_ENTERED'))
  check(
    '(a) body below a lit gate with diggable terrain between digs, climbs and enters (dimension postcondition reached)',
    result.status === 'done' &&
      result.verified === true &&
      result.failure === null &&
      fixture.digs.includes('stone@26,66,8') &&
      fixture.legs.includes('26,66,8') &&
      entered,
    `status=${result.status} verified=${result.verified} failure=${result.failure ?? 'none'} digs=[${fixture.digs.join(',')}] legs=[${fixture.legs.join(',')}] entered=${entered}`,
  )
}

// ---------------------------------------------------------------------------
// (b) a route already exists: unchanged behaviour, no gratuitous digging
// ---------------------------------------------------------------------------
{
  const grid = gateGrid()
  grid.set('26,65,8', cell('stone'))
  grid.set('26,66,8', cell('air'))
  const fixture = makeBot({ x: 26, y: 66, z: 8 }, grid, true)
  const state = worldState({ x: 26.5, y: 66, z: 8.5 }, [], { diamond_pickaxe: 1, cobblestone: 32 })
  const candidate = enterCandidate(fixture, state)
  const vertical = typeof candidate.meta.vertical === 'string' ? candidate.meta.vertical : 'none'
  const result = await runEntry(fixture, candidate, true)
  const enterCalls = fixture.pathCalls.filter((target) => key(target) === key(ENTER_CELL))
  check(
    '(b) a route that already exists is unchanged: one generic path call, no digging, transfer',
    result.status === 'done' &&
      result.verified === true &&
      fixture.digs.length === 0 &&
      fixture.legs.length === 0 &&
      enterCalls.length === 1 &&
      result.messages.some((line) => line.startsWith('PORTAL_ENTERED')),
    `vertical=${vertical} status=${result.status} verified=${result.verified} digs=${fixture.digs.length} legs=${fixture.legs.length} enterCalls=${enterCalls.length}`,
  )
}

// ---------------------------------------------------------------------------
// (c) a genuinely impossible obstruction: ONE typed failure, no endless loop
// ---------------------------------------------------------------------------
{
  const grid = gateGrid()
  grid.set('26,64,8', cell('stone'))
  grid.set('27,64,8', cell('stone'))
  grid.set('26,65,8', cell('stone'))
  // unbreakable face: no safe step cut, and nothing placeable (empty hands)
  grid.set('26,66,8', cell('bedrock'))
  const fixture = makeBot({ x: 27, y: 65, z: 8 }, grid, false)
  const state = worldState({ x: 27.5, y: 65, z: 8.5 }, [], {})
  const candidate = enterCandidate(fixture, state)
  const result = await runEntry(fixture, candidate, false)
  const enterCalls = fixture.pathCalls.filter((target) => key(target) === key(ENTER_CELL))
  const blockedLine = result.messages.find((line) => line.includes('PORTAL_ENTRY_ROUTE_BLOCKED'))
  check(
    '(c) an impossible obstruction fails ONCE with a typed reason naming the obstruction',
    result.status === 'failed' &&
      result.failure !== null &&
      enterCalls.length === 1 &&
      fixture.digs.length === 0 &&
      blockedLine !== undefined &&
      /PORTAL_ENTRY_ROUTE_BLOCKED reason=\S+/.test(blockedLine) &&
      blockedLine.includes('detail=no_placeable'),
    `status=${result.status} failure=${result.failure ?? 'none'} enterCalls=${enterCalls.length} digs=${fixture.digs.length} marker=[${blockedLine ?? 'none'}]`,
  )
}

// ---------------------------------------------------------------------------
// (d) a grounded leg that runs but cannot complete names ITS obstruction: the
// offering layer held the tool (so the route was offered), the tool is gone at
// execution time, so the marker carries the executed leg's own refusal instead
// of a generic path code.
// ---------------------------------------------------------------------------
{
  const grid = gateGrid()
  grid.set('26,64,8', cell('stone'))
  grid.set('27,64,8', cell('stone'))
  grid.set('26,65,8', cell('stone'))
  grid.set('26,66,8', cell('stone'))
  const fixture = makeBot({ x: 27, y: 65, z: 8 }, grid, true)
  const state = worldState({ x: 27.5, y: 65, z: 8.5 }, [STONE_STEP], { diamond_pickaxe: 1, cobblestone: 32 })
  const candidate = enterCandidate(fixture, state)
  // the route was planned with the pickaxe; execution time has empty hands
  fixture.inventoryItems.length = 0
  const result = await runEntry(fixture, candidate, false)
  const blockedLine = result.messages.find((line) => line.includes('PORTAL_ENTRY_ROUTE_BLOCKED'))
  check(
    '(d) a leg that cannot complete reports its own obstruction (dig_refused), not a generic path code',
    result.status === 'failed' &&
      blockedLine !== undefined &&
      blockedLine.includes('reason=route_blocked') &&
      blockedLine.includes('detail=dig_refused'),
    `status=${result.status} failure=${result.failure ?? 'none'} marker=[${blockedLine ?? 'none'}]`,
  )
}

// ---------------------------------------------------------------------------
// (g) the two halves agree: with a grounded route the reachability gate
// PRESENTS the entry (the route is its own path fact); with no route the same
// no_path probe WITHHOLDS it as a typed fact. So `ENTER:26,67,9` reappears in
// the offered set only when its destination is genuinely reachable.
// ---------------------------------------------------------------------------
{
  const withRoute = (() => {
    const grid = gateGrid()
    grid.set('26,64,8', cell('stone'))
    grid.set('27,64,8', cell('stone'))
    grid.set('26,65,8', cell('stone'))
    grid.set('26,66,8', cell('stone'))
    return {
      fixture: makeBot({ x: 27, y: 65, z: 8 }, grid, true),
      state: worldState({ x: 27.5, y: 65, z: 8.5 }, [STONE_STEP], { diamond_pickaxe: 1, cobblestone: 32 }),
    }
  })()
  const withoutRoute = (() => {
    const grid = gateGrid()
    grid.set('26,64,8', cell('stone'))
    grid.set('27,64,8', cell('stone'))
    grid.set('26,65,8', cell('stone'))
    grid.set('26,66,8', cell('bedrock'))
    return {
      fixture: makeBot({ x: 27, y: 65, z: 8 }, grid, false),
      state: worldState({ x: 27.5, y: 65, z: 8.5 }, [], {}),
    }
  })()
  const options = (fixture: FixtureBot): CandidateOptions => ({
    ...defaultCandidateOptions,
    portalEntry: entryPlan(fixture),
    // the live pathfinder fact for the elevated entry cell: no_path
    reachability: { pathProbe: () => 'no_path' },
  })
  const routed = generateGroundedCandidates(withRoute.state, options(withRoute.fixture))
  const blockedCandidates = generateGroundedCandidates(withoutRoute.state, options(withoutRoute.fixture))
  const hidden = blockedCandidates.withheld.find((entry) => entry.candidate.kind === 'ENTER_PORTAL')
  const presented = routed.candidates.some((candidate) => candidate.kind === 'ENTER_PORTAL')
  check(
    '(g) the gate presents the entry once a grounded route exists and withholds it typed when none does',
    presented &&
      hidden !== undefined &&
      hidden.result.reason === 'no_path' &&
      !blockedCandidates.candidates.some((candidate) => candidate.kind === 'ENTER_PORTAL'),
    `withRoute presented=${presented} withoutRoute withheld=${hidden !== undefined} reason=${hidden?.result.reason ?? 'none'}`,
  )
}

// ---------------------------------------------------------------------------
// (e) THE LIVE M3 SHAPE (run-muc3qbug-18vg3, main 35dfd29): the body stands on
// the surface ~96 blocks from its own lit gate, 8+ blocks ABOVE it, while
// `option=front_enter_nether` is active. `state.descent` is built from the
// body's own cardinal cells, so the surface cell carries no safe dig-down step.
// Pre-fix the gate withheld `ENTER:27,67,9` as `needs_descend`/`descend_plan`
// and then suppressed it forever, and the offer held only local MINE/MOVE - the
// body mined leaves under the enter-nether option.
// The general rule: a far target below is a TRAVEL leg (walk there, descend
// where the terrain allows), so its own grounded ENTER candidate stays offered.
// ---------------------------------------------------------------------------
{
  const LIVE_BODY: Vec3Json = { x: 123.5, y: 78, z: -6.7 }
  const LIVE_GATE: Vec3Json = { x: 27, y: 67, z: 9 }
  const frontier: Vec3Json[] = [
    LIVE_BODY,
    { x: 122, y: 78, z: -7 },
    { x: 118, y: 77, z: -8 },
    { x: 110, y: 76, z: -9 },
  ]
  // Every cardinal down step is refused by the absent landing support (the
  // canopy/ledge shape the live sensor reported).
  const refusedDown: DescentOption = {
    dir: 'W',
    mode: 'down',
    dx: -1,
    dz: 0,
    step: { x: 122, y: 77, z: -7 },
    wall: { x: 122, y: 78, z: -7 },
    head: { x: 122, y: 79, z: -7 },
    floor: { x: 122, y: 77, z: -7 },
    wallSolid: false,
    headSolid: true,
    floorSolid: true,
    safe: false,
    reason: 'no solid support at (122,76,-7)',
    refusal: 'no_support',
    digName: 'oak_leaves',
    digHarvestTool: null,
    digHarvestTier: null,
    diggable: true,
  }
  const fixture = makeBot({ x: 26, y: 66, z: 8 }, gateGrid(), true)
  const state = worldState(
    LIVE_BODY,
    [],
    { diamond_pickaxe: 1, cobblestone: 32 },
    [refusedDown],
    frontier,
  )
  const options: CandidateOptions = {
    ...defaultCandidateOptions,
    portalEntry: entryPlan(fixture),
    reachability: { memory: new StateFingerprintMemory({ maxEntries: 16 }), pathProbe: () => 'no_path' },
  }
  const grounded = generateGroundedCandidates(state, options)
  const entry = grounded.candidates.find((candidate) => candidate.kind === 'ENTER_PORTAL')
  const withheldEntry = grounded.withheld.find((entry) => entry.candidate.kind === 'ENTER_PORTAL')
  check(
    '(e) live shape: an enter candidate 8+ blocks below and ~96 blocks away is OFFERED, not withheld',
    entry !== undefined &&
      entry.id === `ENTER:${ENTER_CELL.x},${ENTER_CELL.y},${ENTER_CELL.z}` &&
      withheldEntry === undefined,
    `offered=[${grounded.candidates.map((candidate) => candidate.id).join(',')}] withheld=[${grounded.withheld.map((w) => `${w.candidate.id}:${w.result.reason}`).join(',') || 'none'}]`,
  )
  check(
    '(e) the offered entry is grounded in the gate geometry (never the bare portal item)',
    entry !== undefined &&
      entry.target?.x === ENTER_CELL.x &&
      entry.target?.y === ENTER_CELL.y &&
      entry.target?.z === ENTER_CELL.z &&
      entry.meta.entryUnverified === undefined &&
      entry.meta.portalCells === serializePortalCells(LAYOUT.interior) &&
      entry.meta.dimension === NETHER,
    entry === undefined ? 'no ENTER candidate' : `${entry.id} cells=${String(entry.meta.portalCells)}`,
  )
  check(
    '(e) the live gate origin is the SITE the offered entry is planned from',
    LIVE_GATE.x === ORIGIN.x + 2 && LIVE_GATE.y === ENTER_CELL.y && LIVE_GATE.z === ORIGIN.z,
    `gate=(${LIVE_GATE.x},${LIVE_GATE.y},${LIVE_GATE.z}) site=(${ORIGIN.x},${ORIGIN.y},${ORIGIN.z}) enter=(${ENTER_CELL.x},${ENTER_CELL.y},${ENTER_CELL.z})`,
  )
}

// ---------------------------------------------------------------------------
// (f) A REMEMBERED gate whose interior cannot be observed (the body is far
// enough that the chunks are unloaded) must still ground a ROUTE, and the
// refusal vocabulary must never assert a fact nobody checked: `portal_not_lit`
// only when the interior WAS observed and is not `nether_portal`.
// ---------------------------------------------------------------------------
{
  const unobserved = planPortalEntry({
    site: SITE,
    self: { x: 123, y: 78, z: -7 },
    // far from the gate: the chunks are not loaded, so every probe is null
    blockAt: () => null,
    isStandable: () => false,
    fromDimension: OVERWORLD,
    dimension: NETHER,
  })
  check(
    '(f) an unobserved remembered gate yields an UNVERIFIED route, never a fabricated portal_not_lit',
    unobserved.ok &&
      unobserved.candidate.unverified === true &&
      unobserved.candidate.line.startsWith(PORTAL_ENTRY_UNVERIFIED) &&
      unobserved.candidate.line.includes('reason=site_not_observed') &&
      unobserved.candidate.enterCell.y === ENTER_CELL.y,
    unobserved.ok ? unobserved.candidate.line : unobserved.line,
  )

  const noGeometry = planPortalEntry({
    site: { origin: ORIGIN, widthAxis: 'x', safe: true, reachable: true },
    self: { x: 123, y: 78, z: -7 },
    blockAt: () => null,
    isStandable: () => false,
    fromDimension: OVERWORLD,
    dimension: NETHER,
  })
  check(
    '(f) an unobserved site with no remembered geometry refuses with site_not_observed',
    !noGeometry.ok && noGeometry.reason === 'site_not_observed',
    noGeometry.ok ? 'ok' : noGeometry.line,
  )

  const noSite = formatPortalEntryNoKnownSite()
  check(
    '(f) with no site at all the marker names the missing affordance instead of portal=lit',
    noSite === 'PRECONDITION_MISSING portal=site reason=no_known_site' && !noSite.includes('portal=lit'),
    noSite,
  )
}

// ---------------------------------------------------------------------------
// (g) DESCENT ENTRY: the body stands 5 blocks ABOVE the lit gate with a safe
// dig-down step. The entry route must DESCEND (the same staircase mechanic, the
// other direction), and a durable descent chunk is progress - pre-fix the
// ascent-only progress test reported the descent as `no_route`.
// ---------------------------------------------------------------------------
{
  const grid = gateGrid()
  // the body's column: solid stone under the feet, and the step landing beside it
  grid.set('28,68,8', cell('stone'))
  grid.set('28,67,8', cell('stone'))
  const fixture = makeBot({ x: 28, y: 69, z: 9 }, grid, true)
  const down: DescentOption = {
    dir: 'N',
    mode: 'down',
    dx: 0,
    dz: -1,
    step: { x: 28, y: 68, z: 8 },
    wall: { x: 28, y: 69, z: 8 },
    head: { x: 28, y: 70, z: 8 },
    floor: { x: 28, y: 68, z: 8 },
    wallSolid: false,
    headSolid: false,
    floorSolid: true,
    safe: true,
    reason: 'safe',
    digName: 'stone',
    digHarvestTool: 'pickaxe',
    digHarvestTier: 0,
    diggable: true,
  }
  const state = worldState({ x: 28.5, y: 69, z: 9.5 }, [], { diamond_pickaxe: 1, cobblestone: 32 }, [down], [
    { x: 28, y: 69, z: 9 },
    { x: 28, y: 68, z: 8 },
  ])
  const candidate = enterCandidate(fixture, state)
  const vertical = typeof candidate.meta.vertical === 'string' ? candidate.meta.vertical : 'none'
  check(
    '(g) the entry candidate above the gate with a safe dig-down step carries the descending route',
    vertical === 'staircase' && candidate.meta.stairToY === ENTER_CELL.y && candidate.meta.stairDigY === 68,
    `vertical=${vertical} toY=${candidate.meta.stairToY ?? '-'} digY=${candidate.meta.stairDigY ?? '-'}`,
  )
  const result = await runEntry(fixture, candidate, true, true)
  const descended = result.messages.find((line) => line.startsWith('DESCEND_CHUNK'))
  check(
    '(g) the executor descends the chunk and then enters (dimension postcondition reached)',
    result.status === 'done' &&
      result.verified === true &&
      fixture.digs.includes('stone@28,68,8') &&
      result.messages.some((line) => line.startsWith('PORTAL_ENTERED')) &&
      !result.messages.some((line) => line.includes('PORTAL_ENTRY_ROUTE_BLOCKED')),
    `status=${result.status} verified=${result.verified} failure=${result.failure ?? 'none'} digs=[${fixture.digs.join(',')}] descent=${descended ?? 'none'}`,
  )
}

// ---------------------------------------------------------------------------
// (h) A descent chunk that does NOT yet reach the gate is durable progress: the
// action ends `done` with DESCEND_CHUNK and the next decision re-plans from the
// new Y. It must NOT be reported as an impossible route.
// ---------------------------------------------------------------------------
{
  const grid = gateGrid()
  grid.set('29,71,9', cell('stone'))
  grid.set('29,70,9', cell('stone'))
  const fixture = makeBot({ x: 28, y: 72, z: 9 }, grid, true)
  const down: DescentOption = {
    dir: 'E',
    mode: 'down',
    dx: 1,
    dz: 0,
    step: { x: 29, y: 71, z: 9 },
    wall: { x: 29, y: 72, z: 9 },
    head: { x: 29, y: 73, z: 9 },
    floor: { x: 29, y: 71, z: 9 },
    wallSolid: false,
    headSolid: false,
    floorSolid: true,
    safe: true,
    reason: 'safe',
    digName: 'stone',
    digHarvestTool: 'pickaxe',
    digHarvestTier: 0,
    diggable: true,
  }
  const state = worldState({ x: 28.5, y: 72, z: 9.5 }, [], { diamond_pickaxe: 1, cobblestone: 32 }, [down], [
    { x: 28, y: 72, z: 9 },
    { x: 29, y: 71, z: 9 },
  ])
  const candidate = enterCandidate(fixture, state)
  const result = await runEntry(fixture, candidate, false, true)
  const descended = result.messages.find((line) => line.includes('DESCENT_CHUNK'))
  check(
    '(h) a descent chunk that has not reached the gate is DONE progress, not a blocked route',
    result.status === 'done' &&
      result.verified === false &&
      descended !== undefined &&
      descended.includes('from_y=72') &&
      descended.includes('to_y=71') &&
      descended.includes('target_y=67') &&
      !result.messages.some((line) => line.includes('PORTAL_ENTRY_ROUTE_BLOCKED')),
    `status=${result.status} verified=${result.verified} marker=[${descended ?? 'none'}]`,
  )
}

// ---------------------------------------------------------------------------
// (h2) A path failure followed by a typed vertical-leg failure must preserve
// the FINAL mechanical failure. Calling it `path_no_path` spends the wrong
// route stage and hides the pillar/place root cause from #435.
// ---------------------------------------------------------------------------
{
  const fixture = makeBot({ x: 11, y: 66, z: 24 }, gateGrid(), true)
  const state = worldState({ x: 11.5, y: 66, z: 24.5 }, [], { diamond_pickaxe: 1, cobblestone: 32 })
  const base = enterCandidate(fixture, state)
  const candidate: Candidate = {
    ...base,
    meta: { ...base.meta, vertical: 'pillar', verticalFromY: 66, verticalToY: 67, pillarPlaceName: 'cobblestone', pillarSteps: 1 },
  }
  const result = await runEntry(fixture, candidate, false, true, (executor) => {
    ;(executor as unknown as {
      runEntryRouteLeg: () => Promise<{ progressed: boolean; error: ExecutorError | null; activeVertical: string; obstruction: string | null }>
    }).runEntryRouteLeg = async () => ({
      progressed: false,
      error: new ExecutorError('place_refused', 'server refused placement; block still air'),
      activeVertical: 'pillar',
      obstruction: 'refused',
    })
  })
  check(
    '(h2) a vertical place refusal survives ENTER failure attribution instead of becoming path_no_path',
    result.status === 'failed' && result.failure === 'place_refused',
    `status=${result.status} failure=${result.failure ?? 'none'} markers=[${result.messages.filter((line) => line.includes('PORTAL_ENTRY_ROUTE_BLOCKED')).join('|')}]`,
  )
}

// ---------------------------------------------------------------------------
// (i) THE MEASURED FREEZE (run-muc620xb-1d312, gen-muc8zwpv-ddlzrh): the body
// stood at 10,54,25, the lit gate at 26,67,9, and `ENTER:26,67,9` was offered
// and re-issued 669 times while every attempt settled
// `PATH_CALLBACK phase=failed outcome=noPath|stuck`. The route memory DID record
// the route (`ACTION_ZERO_PROGRESS ... kind=ENTER_PORTAL retry=1..20`), but
// nothing consumed it for the entry arm, and there was no bounded escalation.
//
// After the fix:
//   (i-1) a spent ENTER route is NOT re-offered: the arm offers the grounded
//         approach leg that changes the stand cell instead;
//   (i-2) a body that actually walked the approach leg is offered the entry
//         again (no premature permanent suppression);
//   (i-3) when no closer standable cell exists, the entry is withheld and the
//         goal reports the typed `ROUTE_ESCALATE ... reason=all_routes_spent`
//         refusal (bounded: one spent route is enough - there is nothing left
//         to ground), never `(failing route, WAIT)`.
// ---------------------------------------------------------------------------
{
  const CLOSER: Vec3Json = { x: 26, y: 66, z: 8 }
  const withRoutes = (state: WorldState, routes: ReturnType<typeof observeZeroProgressRoute>['routes']): WorldState => ({
    ...state,
    signals: { ...state.signals, zeroProgressRoutes: routes },
  })
  const fixture = makeBot({ x: 27, y: 65, z: 8 }, gateGrid(), true)
  const options: CandidateOptions = { ...defaultCandidateOptions, portalEntry: entryPlan(fixture) }
  const state = worldState({ x: 27.5, y: 65, z: 8.5 }, [], { diamond_pickaxe: 1, cobblestone: 32 }, [], [
    { x: 27, y: 65, z: 8 },
    CLOSER,
  ])
  const fresh = entryCandidates(state, options)
  const entry = fresh.candidates.find((candidate) => candidate.kind === 'ENTER_PORTAL')
  const routeSig =
    entry === undefined ? 'none' : routeSignature({ kind: 'ENTER_PORTAL', id: entry.id, meta: entry.meta })
  // The controller's own recording path for a settled path-stage failure.
  const routes = observeZeroProgressRoute(undefined, {
    kind: 'ENTER_PORTAL',
    targetKey: cellKey(entry?.target ?? ENTER_CELL),
    standKey: cellKey(state.self.position),
    routeSig,
    reason: 'path_no_path',
    nowMs: state.timestampMs,
  }).routes
  const afterSpent = entryCandidates(withRoutes(state, routes), options)
  const leg = afterSpent.candidates.find((candidate) => candidate.meta.approachLeg === 'route_spent')
  check(
    '(i-1) a spent ENTER route is replaced by a grounded approach leg (never re-offered unchanged)',
    entry !== undefined &&
      fresh.candidates.filter((candidate) => candidate.kind === 'ENTER_PORTAL').length === 1 &&
      afterSpent.candidates.every((candidate) => candidate.kind !== 'ENTER_PORTAL') &&
      leg !== undefined &&
      leg.kind === 'MOVE' &&
      leg.target?.x === CLOSER.x &&
      leg.target?.y === CLOSER.y &&
      leg.target?.z === CLOSER.z &&
      afterSpent.refusal === null,
    `fresh=[${fresh.candidates.map((candidate) => candidate.id).join(',')}] afterSpent=[${afterSpent.candidates.map((candidate) => candidate.id).join(',')}] refusal=${afterSpent.refusal?.line ?? 'none'}`,
  )

  const movedState = worldState(CLOSER, [], { diamond_pickaxe: 1, cobblestone: 32 }, [], [
    CLOSER,
    { x: 27, y: 65, z: 8 },
  ])
  const reoffered = entryCandidates(withRoutes(movedState, routes), options)
  check(
    '(i-2) after the approach leg the entry is offered again from the new stand cell',
    reoffered.candidates.some((candidate) => candidate.kind === 'ENTER_PORTAL') && reoffered.refusal === null,
    `offered=[${reoffered.candidates.map((candidate) => candidate.id).join(',')}] refusal=${reoffered.refusal?.line ?? 'none'}`,
  )

  const boxed = worldState({ x: 27.5, y: 65, z: 8.5 }, [], { diamond_pickaxe: 1, cobblestone: 32 }, [], [
    { x: 27, y: 65, z: 8 },
  ])
  const boxedAfter = entryCandidates(withRoutes(boxed, routes), options)
  check(
    '(i-3) with no grounded alternative the entry is withheld and the goal says ROUTE_ESCALATE reason=all_routes_spent',
    boxedAfter.candidates.length === 0 &&
      boxedAfter.refusal?.reason === 'all_routes_spent' &&
      boxedAfter.refusal.line ===
        'ROUTE_ESCALATE goal=g-portal-entered reason=all_routes_spent routes=1',
    `offered=[${boxedAfter.candidates.map((candidate) => candidate.id).join(',')}] refusal=${boxedAfter.refusal?.line ?? 'none'}`,
  )
}

process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
if (failures > 0) process.exit(1)
