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
  planPortalEntry,
  portalFrameLayout,
} from './src/netherPortalPlan.ts'
import type { PortalEntryPlan, PortalFrameSite } from './src/netherPortalPlan.ts'
import { defaultCandidateOptions, entryCandidates, generateGroundedCandidates } from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import { Executor, ExecutorError, defaultExecutorOptions } from './src/executor.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { AgentSignals, InventoryState, SelfState, StepCut, Vec3Json, WorldState } from './src/state.ts'
import { isStandable } from './src/state.ts'
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
function installLocomotion(executor: Executor, fixture: FixtureBot, transfer: boolean): void {
  const pathTo = async (target: Vec3Json): Promise<void> => {
    fixture.pathCalls.push({ ...target })
    if (key(target) === key(ENTER_CELL)) {
      if (!canWalkIntoGate(fixture)) {
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

function worldState(bodyFeet: Vec3Json, stepCuts: StepCut[], counts: Record<string, number>): WorldState {
  const current = queuedPlace()
  return {
    schemaVersion: 1,
    tick: 9,
    timestampMs: 1_700_000_000_000,
    self: self(bodyFeet),
    inventory: inventory(counts),
    entities: [],
    blocks: [],
    terrain: { standable: [bodyFeet] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    portalFrameSites: [SITE],
    descent: [],
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
): Promise<{ status: string; failure: string | null; verified: boolean; messages: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'portal-entry-route-'))
  const logger = new EventLogger(new JsonlWriter(join(dir, 'agent.jsonl')), false)
  const executor = new Executor(fixture.bot, logger, { ...defaultExecutorOptions, actuation: 'packet', portalEnterTimeoutMs: 400 })
  installLocomotion(executor, fixture, transfer)
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

process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
if (failures > 0) process.exit(1)
