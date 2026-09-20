// test-frame-build.mts - issue: the executor can only ever place ONE block at a
// sensed `placementSpots` cell, and `build_portal_frame` miscompiles to
// `{kind:'place', targetItem:'nether_portal'}` (a non-item). This suite proves the
// multi-cell frame-build lane end-to-end, offline (no live bot, no clock):
//
//   (1) `portalStepToPlannedGoal(build_portal_frame)` targets OBSIDIAN cells, one
//       per `portalFrameLayout` edge cell - never the non-item `nether_portal`.
//   (2) the generic `planBlockPlacements` emits an executable, support-first
//       sequence for any "place N blocks of item X at specified cells" goal.
//   (3) a `place` goal carrying `placementCells` produces a PLACE candidate whose
//       `placementCells` are the geometry cells (not one `placementSpots` cell).
//   (4) the per-cell marker is durable and gated by the REAL post-condition
//       (`isPlacePostconditionMet`); the frame marker is gated by
//       `validatePortalFrame` (red before: no multi-cell path existed).
//   (5) the real Executor, driven over a structural fake bot, places every obsidian
//       cell, emits PORTAL_BLOCK_PLACED per verified cell + PORTAL_FRAME_READY, and
//       emits NOTHING when the post-condition is unmet.
//
// Red-first: this file is added before the source changes and fails (missing
// exports / unmet assertions), then passes.
//
// Run: npm run frame-build-test
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import {
  OBSIDIAN,
  NETHER_PORTAL,
  PORTAL_BLOCK_PLACED,
  PORTAL_FRAME_READY,
  formatPortalBlockPlaced,
  formatPortalFrameReady,
  orderedPlacementCells,
  planBlockPlacements,
  planNetherPortal,
  groundPortalFrame,
  portalFrameLayout,
  portalFramePlacementSteps,
  portalStepToPlannedGoal,
  validatePortalFrame,
} from './src/netherPortalPlan.ts'
import type { QueuedGoal } from './src/goalQueue.ts'
import type { GoalQueueState } from './src/goalQueue.ts'
import type { WorldState, Vec3Json, SelfState, InventoryState, AgentSignals } from './src/state.ts'
import type { PortalFrameSite } from './src/netherPortalPlan.ts'
import { defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import { Executor } from './src/executor.ts'
import {
  FRAME_PLACE_ITEMS,
  defaultExecutorOptions,
  frameReadyLine,
  placedFrameCellLine,
} from './src/executor.ts'
import { EventLogger, JsonlWriter } from './src/jev.ts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')

let failures = 0
async function check(label: string, ok: boolean, detail: string): Promise<void> {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const ORIGIN: Vec3Json = { x: 5, y: 64, z: 0 }
const LAYOUT = portalFrameLayout(ORIGIN, 'x')
const FRAME_CELLS = LAYOUT.frame
const ORDERED_FRAME = orderedPlacementCells(FRAME_CELLS)

const key = (p: Vec3Json): string => `${p.x},${p.y},${p.z}`
const cellSet = (cells: readonly Vec3Json[]): Set<string> => new Set(cells.map(key))

// ---------------------------------------------------------------------------
// (1) the miscompile: build_portal_frame targets obsidian CELLS, not nether_portal
// ---------------------------------------------------------------------------
{
  const step = planNetherPortal({
    inventory: { diamond_pickaxe: 1, flint_and_steel: 1, obsidian: 10 },
    toolRank: 4,
    sites: [{ position: ORIGIN, safe: true, reachable: true }],
    self: { x: 6, y: 64, z: -2 },
  }).steps.find((entry) => entry.kind === 'build_portal_frame')
  const goal = step === undefined ? null : portalStepToPlannedGoal({
    ...step,
    origin: ORIGIN,
    widthAxis: 'x',
  } as typeof step)

  const pass =
    goal !== null &&
    goal.kind === 'place' &&
    goal.targetItem === OBSIDIAN &&
    String(goal.targetItem ?? '') !== NETHER_PORTAL &&
    goal.placementCells !== undefined &&
    cellSet(goal.placementCells).size === 10 &&
    [...cellSet(goal.placementCells)].every((cell) => cellSet(FRAME_CELLS).has(cell)) &&
    goal.requiredCount === 10
  process.stdout.write(
    `${pass ? 'PASS' : 'FAIL'}  (1) build_portal_frame compiles to a place goal over obsidian cells\n` +
      `      kind=${goal?.kind} targetItem=${goal?.targetItem} cells=${goal?.placementCells?.length ?? 0} required=${goal?.requiredCount}\n`,
  )
  if (!pass) failures += 1
}

// ---------------------------------------------------------------------------
// (2) the generic placement sequence: geometry-driven, support-first
// ---------------------------------------------------------------------------
{
  const steps = portalFramePlacementSteps(ORIGIN, 'x')
  const generic = planBlockPlacements(OBSIDIAN, FRAME_CELLS)
  const bottomUp = ORDERED_FRAME.every((cell, index) => {
    const next = ORDERED_FRAME[index + 1]
    if (next === undefined) return true
    return cell.y <= next.y
  })
  const pass =
    steps.length === 10 &&
    steps.every((entry) => entry.item === OBSIDIAN) &&
    cellSet(steps.map((entry) => entry.cell)).size === 10 &&
    [...cellSet(steps.map((entry) => entry.cell))].every((cell) => cellSet(FRAME_CELLS).has(cell)) &&
    generic.length === 10 &&
    generic[0]?.cell !== undefined &&
    generic[0]?.item === OBSIDIAN &&
    bottomUp &&
    ORDERED_FRAME[0]?.y === 64
  process.stdout.write(
    `${pass ? 'PASS' : 'FAIL'}  (2) planBlockPlacements emits the geometry sequence bottom-up\n` +
      `      steps=${steps.length} first=${JSON.stringify(ORDERED_FRAME[0])} last=${JSON.stringify(ORDERED_FRAME[ORDERED_FRAME.length - 1])} bottomUp=${bottomUp}\n`,
  )
  if (!pass) failures += 1
}

// ---------------------------------------------------------------------------
// (3) the candidate generator consumes a `place` goal with placementCells
// ---------------------------------------------------------------------------
function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_FRAMEBUILD',
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

function goal(targetItem: string, cells: readonly Vec3Json[]): WorldState['goal'] & { placementCells?: readonly Vec3Json[] } {
  return {
    id: `place:${targetItem}`,
    description: `place ${cells.length} x ${targetItem} at specified cells`,
    targetItem,
    requiredCount: cells.length,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedPlace(item: string, cells: readonly Vec3Json[]): QueuedGoal {
  return {
    id: `g-place-${item}`,
    kind: 'place',
    description: `place ${cells.length} x ${item} at specified cells`,
    targetItem: item,
    requiredCount: cells.length,
    placementCells: cells,
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

function worldState(overrides: {
  position: Vec3Json
  inventory?: InventoryState
  goalQueue: GoalQueueState
  portalFrameSites?: PortalFrameSite[]
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 9,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position),
    inventory: overrides.inventory ?? inventory({ obsidian: 10 }),
    entities: [],
    blocks: [],
    terrain: { standable: [overrides.position] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    portalFrameSites: overrides.portalFrameSites,
    descent: [],
    stepCuts: [],
    headroomCuts: [],
    goal: goal(OBSIDIAN, FRAME_CELLS),
    goalQueue: overrides.goalQueue,
    recentEvents: [],
    signals: signals(),
  }
}

{
  const groundedSite: PortalFrameSite = { origin: { x: 20, y: 64, z: 3 }, widthAxis: 'z', safe: true, reachable: true }
  const state = worldState({
    position: { x: 6.5, y: 64, z: -1.5 },
    goalQueue: queueWith({
      ...queuedPlace(OBSIDIAN, []),
      placementCells: undefined,
      requiredCount: 10,
    }),
    // The old single-cell list points elsewhere; a complete portal site must
    // be the source of frame geometry when the sensor has one.
    portalFrameSites: [groundedSite],
  })
  const grounding = groundPortalFrame([groundedSite], state.self.position)
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const place = grounded.candidates.find((candidate) => candidate.kind === 'PLACE')
  const expected = portalFrameLayout(groundedSite.origin, groundedSite.widthAxis).frame
  const pass =
    grounding?.origin.x === groundedSite.origin.x &&
    grounding?.origin.y === groundedSite.origin.y &&
    grounding?.origin.z === groundedSite.origin.z &&
    grounding?.widthAxis === 'z' &&
    place?.placementAxis === 'z' &&
    place?.placementCells?.length === 10 &&
    cellSet(place.placementCells).size === cellSet(expected).size &&
    [...cellSet(place.placementCells)].every((cell) => cellSet(expected).has(cell))
  process.stdout.write(
    `${pass ? 'PASS' : 'FAIL'}  (3a) a complete live-grounded portal site outranks the legacy single placement list\n` +
      `      site=${JSON.stringify(grounding)} candidate=${place?.id ?? 'none'} axis=${place?.placementAxis ?? 'none'}\n`,
  )
  if (!pass) failures += 1
}

{
  const existing = ORDERED_FRAME.slice(0, 7)
  const partialSite: PortalFrameSite = {
    origin: ORIGIN,
    widthAxis: 'x',
    safe: true,
    reachable: true,
    existingFrame: existing,
  }
  const state = worldState({
    position: { x: 6.5, y: 64, z: -1.5 },
    inventory: inventory({ obsidian: 3 }),
    goalQueue: queueWith({
      ...queuedPlace(OBSIDIAN, []),
      placementCells: undefined,
      requiredCount: 10,
    }),
    portalFrameSites: [partialSite],
  })
  const grounding = groundPortalFrame([partialSite], state.self.position)
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const place = grounded.candidates.find((candidate) => candidate.kind === 'PLACE')
  const missing = FRAME_CELLS.filter((cell) => !cellSet(existing).has(key(cell)))
  const pass =
    grounding !== null &&
    place?.placementCells !== undefined &&
    place.placementCells.length === 3 &&
    cellSet(place.placementCells).size === 3 &&
    cellSet(place.placementCells).size === cellSet(missing).size &&
    [...cellSet(place.placementCells)].every((cell) => cellSet(missing).has(cell))
  process.stdout.write(
    `${pass ? 'PASS' : 'FAIL'}  (3b) a partial live frame yields only its missing obsidian cells\n` +
      `      existing=${existing.length} missing=${missing.length} candidate=${place?.id ?? 'none'} cells=${place?.placementCells?.length ?? 0}\n`,
  )
  if (!pass) failures += 1
}

{
  const advancedSite: PortalFrameSite = {
    origin: { x: 20, y: 64, z: 0 },
    widthAxis: 'x',
    safe: true,
    reachable: true,
    existingFrame: ORDERED_FRAME.slice(0, 7).map((cell) => ({ ...cell, x: cell.x + 15 })),
  }
  const nearbySite: PortalFrameSite = {
    origin: { x: 6, y: 64, z: 0 },
    widthAxis: 'x',
    safe: true,
    reachable: true,
    existingFrame: [{ x: 6, y: 64, z: 0 }],
  }
  const state = worldState({
    position: { x: 6.5, y: 64, z: -1.5 },
    inventory: inventory({ obsidian: 10 }),
    goalQueue: queueWith({
      ...queuedPlace(OBSIDIAN, []),
      placementCells: undefined,
      requiredCount: 10,
    }),
    portalFrameSites: [nearbySite, advancedSite],
  })
  const grounding = groundPortalFrame([nearbySite, advancedSite], state.self.position)
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const place = grounded.candidates.find((candidate) => candidate.kind === 'PLACE')
  const advancedMissing = portalFrameLayout(advancedSite.origin, advancedSite.widthAxis).frame.filter(
    (cell) => !(advancedSite.existingFrame ?? []).some((existing) => key(existing) === key(cell)),
  )
  const pass =
    grounding?.origin.x === advancedSite.origin.x &&
    grounding?.origin.y === advancedSite.origin.y &&
    grounding?.origin.z === advancedSite.origin.z &&
    place?.placementCells?.length === advancedMissing.length &&
    [...cellSet(place?.placementCells ?? [])].every((cell) => cellSet(advancedMissing).has(cell))
  process.stdout.write(
    (pass ? 'PASS' : 'FAIL') + '  (3c) a more-complete continuation site outranks a nearby partial site\n' +
      '      selected=' + JSON.stringify(grounding) + ' advanced=' + (advancedSite.existingFrame?.length ?? 0) +
      ' nearby=' + (nearbySite.existingFrame?.length ?? 0) + ' candidateCells=' + (place?.placementCells?.length ?? 0) + '\n',
  )
  if (!pass) failures += 1
}

{
  const state = worldState({
    position: { x: 6.5, y: 64, z: -1.5 },
    goalQueue: queueWith(queuedPlace(OBSIDIAN, ORDERED_FRAME)),
  })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const place = grounded.candidates.find((candidate) => candidate.kind === 'PLACE')
  const pass =
    place !== undefined &&
    place.itemName === OBSIDIAN &&
    place.placementCells !== undefined &&
    place.placementCells.length === 10 &&
    cellSet(place.placementCells).size === 10 &&
    [...cellSet(place.placementCells)].every((cell) => cellSet(FRAME_CELLS).has(cell)) &&
    place.target !== null &&
    key(place.target) === key(ORDERED_FRAME[0] ?? { x: 0, y: 0, z: 0 }) &&
    place.placementAxis === 'x'
  process.stdout.write(
    `${pass ? 'PASS' : 'FAIL'}  (3) a place goal with placementCells yields a multi-cell PLACE candidate\n` +
      `      id=${place?.id ?? 'none'} target=${JSON.stringify(place?.target)} cells=${place?.placementCells?.length ?? 0} axis=${place?.placementAxis}\n`,
  )
  if (!pass) failures += 1
}

// ---------------------------------------------------------------------------
// (4) the durable markers are gated by the real post-conditions
// ---------------------------------------------------------------------------
{
  const first = ORDERED_FRAME[0] ?? { x: 0, y: 0, z: 0 }
  const verified = placedFrameCellLine(OBSIDIAN, OBSIDIAN, first)
  const absent = placedFrameCellLine(OBSIDIAN, null, first)
  const wrong = placedFrameCellLine(OBSIDIAN, 'stone', first)
  const notFrameItem = placedFrameCellLine('dirt', 'dirt', first)
  const ready = frameReadyLine(FRAME_CELLS, 'x')
  const malformed = frameReadyLine(FRAME_CELLS.slice(0, FRAME_CELLS.length - 1), 'x')
  const pass =
    FRAME_PLACE_ITEMS.has(OBSIDIAN) &&
    verified === formatPortalBlockPlaced(first) &&
    verified.startsWith(`${PORTAL_BLOCK_PLACED} pos=${first.x},${first.y},${first.z}`) &&
    absent === null &&
    wrong === null &&
    notFrameItem === null &&
    ready === formatPortalFrameReady(validatePortalFrame({ blocks: FRAME_CELLS, widthAxis: 'x' })) &&
    ready === `${PORTAL_FRAME_READY} blocks=10 shape=ok` &&
    malformed === null
  process.stdout.write(
    `${pass ? 'PASS' : 'FAIL'}  (4) PORTAL_BLOCK_PLACED-per-cell + PORTAL_FRAME_READY gated by real post-conditions\n` +
      `      verified=[${verified}] absent=${absent} wrong=${wrong} ready=[${ready}] malformed=${malformed}\n`,
  )
  if (!pass) failures += 1
}

// ---------------------------------------------------------------------------
// (5) the real Executor places every cell and emits the durable markers
// ---------------------------------------------------------------------------
class P {
  x: number
  y: number
  z: number
  constructor(x: number, y: number, z: number) {
    this.x = x
    this.y = y
    this.z = z
  }
  clone(): P {
    return new P(this.x, this.y, this.z)
  }
  set(x: number, y: number, z: number): P {
    this.x = x
    this.y = y
    this.z = z
    return this
  }
  offset(x: number, y: number, z: number): P {
    return new P(this.x + x, this.y + y, this.z + z)
  }
  distanceTo(other: { x: number; y: number; z: number }): number {
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
  }
}

interface FakeBlock {
  name: string
  boundingBox: 'block' | 'empty'
  position: P
}

/**
 * A structural bot with just what the PLACE path reads. The frame plane is at
 * z=0; the bot stands in front of it at z=-1.5. The four optional frame corners
 * are pre-existing obsidian (a real site may already carry them), which supports
 * the side columns the minimal 10-edge frame leaves disconnected.
 */
function makePlaceBot(
  feet: Vec3Json,
  placeCells: readonly Vec3Json[],
  failPlacements: boolean,
  equipFailures = 0,
  preexistingCorners = true,
  preexistingFrame: readonly Vec3Json[] = [],
) {
  const grid = new Map<string, string>()
  for (let x = ORIGIN.x - 1; x <= ORIGIN.x + 4; x += 1) {
    for (let z = -1; z <= 1; z += 1) grid.set(`${x},${ORIGIN.y - 1},${z}`, 'stone')
  }
  if (preexistingCorners) {
    for (const corner of LAYOUT.corners) grid.set(key(corner), OBSIDIAN)
  }
  for (const cell of preexistingFrame) grid.set(key(cell), OBSIDIAN)
  const blockAt = (v: { x: number; y: number; z: number }): FakeBlock | null => {
    const name = grid.get(`${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`)
    if (name === undefined) return null
    return {
      name,
      boundingBox: name === 'air' ? 'empty' : 'block',
      position: new P(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)),
    }
  }
  const position = new P(feet.x, feet.y, feet.z)
  const obsidianId = (registry.itemsByName as Record<string, { id: number }>).obsidian?.id ?? 0
  const placeCalls: Array<{ x: number; y: number; z: number }> = []
  let heldName: string | null = null
  const bot = {
    registry,
    entity: {
      position,
      yaw: 0,
      pitch: 0,
      onGround: true,
      width: 0.6,
      height: 1.8,
      offset: (x: number, y: number, z: number) => position.offset(x, y, z),
      clone: () => position.clone(),
      distanceTo: (other: { x: number; y: number; z: number }) => position.distanceTo(other),
    },
    _client: { write: () => true },
    physicsEnabled: true,
    entities: {},
    inventory: {
      count: (id: number) => (id === obsidianId ? 10 : 0),
      items: (): Array<{ name: string; type: number; count: number }> => [
        { name: OBSIDIAN, type: obsidianId, count: 10 },
        ...(preexistingCorners ? [] : [{ name: 'cobblestone', type: registry.itemsByName.cobblestone.id, count: 1 }]),
      ],
    },
    get heldItem(): { name: string } | null {
      return heldName === null ? null : { name: heldName }
    },
    blockAt,
    on: () => undefined,
    removeListener: () => undefined,
    setControlState: () => undefined,
    lookAt: async () => undefined,
    equip: async (item: { name: string }) => {
      if (equipFailures > 0) {
        equipFailures -= 1
        return
      }
      heldName = item.name
    },
    canDigBlock: () => true,
    dig: async () => undefined,
    placeBlock: async (block: FakeBlock, face: { x: number; y: number; z: number }): Promise<void> => {
      if (heldName !== OBSIDIAN && heldName !== 'cobblestone') throw new Error(`wrong held item: ${heldName ?? 'empty'}`)
      const target = {
        x: block.position.x + face.x,
        y: block.position.y + face.y,
        z: block.position.z + face.z,
      }
      placeCalls.push(target)
      if (failPlacements && placeCells.some((cell) => key(cell) === key(target))) {
        // The server rejected the placement: the block never appears.
        return
      }
      grid.set(key(target), heldName ?? OBSIDIAN)
    },
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
  return { bot: bot as unknown as Bot, grid, placeCalls }
}

function placeFrameCandidate(cells: readonly Vec3Json[], item: string) {
  return {
    id: `PLACE:${item}:build:${cells.length}`,
    kind: 'PLACE' as const,
    label: `place the ${cells.length}-cell ${item} frame`,
    targetName: item,
    target: cells[0] ?? null,
    targetEntityId: null,
    itemName: item,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    placementCells: [...cells],
    placementAxis: 'x' as const,
    meta: { tick: 9 },
  }
}

async function runFrameBuild(failPlacements: boolean, equipFailures = 0) {
  const fixture = makePlaceBot({ x: 6.5, y: 64, z: -1.5 }, ORDERED_FRAME, failPlacements, equipFailures)
  const dir = mkdtempSync(join(tmpdir(), 'frame-build-'))
  const logPath = join(dir, 'agent.jsonl')
  const logger = new EventLogger(new JsonlWriter(logPath), false)
  const executor = new Executor(fixture.bot, logger, { ...defaultExecutorOptions, actuation: 'packet' })
  const result = await executor.claim(placeFrameCandidate(ORDERED_FRAME, OBSIDIAN)).completion
  const lines = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { message?: string; detail?: Record<string, unknown> })
  const messages = lines.map((entry) => entry.message ?? '')
  return { fixture, result, messages }
}

async function runMinimalFrameBuild() {
  const fixture = makePlaceBot({ x: 6.5, y: 64, z: -1.5 }, ORDERED_FRAME, false, 0, false)
  const dir = mkdtempSync(join(tmpdir(), 'frame-build-minimal-'))
  const logPath = join(dir, 'agent.jsonl')
  const logger = new EventLogger(new JsonlWriter(logPath), false)
  const executor = new Executor(fixture.bot, logger, { ...defaultExecutorOptions, actuation: 'packet' })
  const result = await executor.claim(placeFrameCandidate(ORDERED_FRAME, OBSIDIAN)).completion
  const lines = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((entry) => JSON.parse(entry) as { message?: string })
  return { fixture, result, messages: lines.map((entry) => entry.message ?? '') }
}

async function runPartialFrameBuild() {
  const missing = [
    { x: ORIGIN.x + 3, y: ORIGIN.y + 3, z: ORIGIN.z },
    { x: ORIGIN.x + 1, y: ORIGIN.y + 4, z: ORIGIN.z },
    { x: ORIGIN.x + 2, y: ORIGIN.y + 4, z: ORIGIN.z },
  ]
  const missingKeys = new Set(missing.map(key))
  const existing = FRAME_CELLS.filter((cell) => !missingKeys.has(key(cell)))
  const fixture = makePlaceBot({ x: 6.5, y: 64, z: -1.5 }, missing, false, 0, false, existing)
  const dir = mkdtempSync(join(tmpdir(), 'frame-build-partial-'))
  const logPath = join(dir, 'agent.jsonl')
  const logger = new EventLogger(new JsonlWriter(logPath), false)
  const executor = new Executor(fixture.bot, logger, { ...defaultExecutorOptions, actuation: 'packet' })
  const result = await executor.claim(placeFrameCandidate(missing, OBSIDIAN)).completion
  const lines = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((entry) => JSON.parse(entry) as { message?: string })
  return { fixture, result, messages: lines.map((entry) => entry.message ?? ''), missing, existing }
}

async function runReferenceApproachBuild() {
  const target = { x: ORIGIN.x, y: ORIGIN.y + 1, z: 0 }
  const fixture = makePlaceBot({ x: 30.5, y: 64, z: 30.5 }, [target], false, 0, false)
  for (let x = ORIGIN.x - 2; x <= ORIGIN.x + 2; x += 1) {
    for (let z = -2; z <= 2; z += 1) {
      fixture.grid.set(String(x) + ',' + String(ORIGIN.y - 2) + ',' + String(z), 'air')
      fixture.grid.set(String(x) + ',' + String(ORIGIN.y - 1) + ',' + String(z), 'air')
      fixture.grid.set(String(x) + ',' + String(ORIGIN.y) + ',' + String(z), 'air')
      fixture.grid.set(String(x) + ',' + String(ORIGIN.y + 1) + ',' + String(z), 'air')
      fixture.grid.set(String(x) + ',' + String(ORIGIN.y + 2) + ',' + String(z), 'air')
      fixture.grid.set(String(x) + ',' + String(ORIGIN.y - 3) + ',' + String(z), 'stone')
    }
  }
  fixture.grid.set(String(ORIGIN.x) + ',' + String(ORIGIN.y) + ',0', OBSIDIAN)
  const dir = mkdtempSync(join(tmpdir(), 'frame-build-reference-'))
  const logPath = join(dir, 'agent.jsonl')
  const logger = new EventLogger(new JsonlWriter(logPath), false)
  const executor = new Executor(fixture.bot, logger, { ...defaultExecutorOptions, actuation: 'packet' })
  const approaches: Vec3Json[] = []
  const internals = executor as unknown as {
    pathToNear: (position: Vec3Json, range: number, epoch: number, signal: AbortSignal) => Promise<void>
  }
  internals.pathToNear = async (position) => {
    approaches.push({ ...position })
    ;(fixture.bot.entity as unknown as { position: P }).position.set(position.x, position.y, position.z)
  }
  const result = await executor.claim(placeFrameCandidate([target], 'cobblestone')).completion
  const lines = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((entry) => JSON.parse(entry) as { message?: string })
  return { fixture, result, approaches, messages: lines.map((entry) => entry.message ?? '') }
}

{
  const { fixture, result, messages } = await runFrameBuild(false)
  const placed = messages.filter((line) => line.startsWith(PORTAL_BLOCK_PLACED))
  const ready = messages.filter((line) => line.startsWith(PORTAL_FRAME_READY))
  const placedCells = placed.map((line) => line.slice(`${PORTAL_BLOCK_PLACED} pos=`.length))
  const pass =
    result.status === 'done' &&
    result.verified === true &&
    placed.length === 10 &&
    ready.length === 1 &&
    ready[0] === `${PORTAL_FRAME_READY} blocks=10 shape=ok` &&
    new Set(placedCells).size === 10 &&
    ORDERED_FRAME.every((cell) => placedCells.includes(key(cell))) &&
    ORDERED_FRAME.every((cell) => fixture.grid.get(key(cell)) === OBSIDIAN) &&
    placeCallsPlacedEveryCell(fixture.placeCalls, ORDERED_FRAME)
  process.stdout.write(
    `${pass ? 'PASS' : 'FAIL'}  (5a) the Executor places all 10 cells and emits per-cell + frame-ready markers\n` +
      `      status=${result.status} verified=${result.verified} placed=${placed.length} ready=[${ready[0] ?? 'none'}] calls=${fixture.placeCalls.length}\n`,
  )
  if (!pass) failures += 1
}

{
  const { fixture, result, messages } = await runMinimalFrameBuild()
  const placed = messages.filter((line) => line.startsWith(PORTAL_BLOCK_PLACED))
  const ready = messages.filter((line) => line.startsWith(PORTAL_FRAME_READY))
  const support = messages.filter((line) => line.startsWith('PORTAL_SUPPORT_PLACED'))
  const scaffoldCorners = LAYOUT.corners.filter(
    (corner) => fixture.grid.get(`${corner.x},${corner.y},${corner.z}`) === 'cobblestone',
  )
  const pass =
    result.status === 'done' &&
    result.verified === true &&
    placed.length === 10 &&
    ready.length === 1 &&
    support.length === 3 &&
    scaffoldCorners.length === 3
  process.stdout.write(
    `${pass ? 'PASS' : 'FAIL'}  (5a-minimal) the 10-edge frame adds one mechanical corner scaffold and still verifies\n` +
      `      status=${result.status} placed=${placed.length} support=${support.length} corners=${scaffoldCorners.length} failure=${result.failure ?? 'none'} detail=${result.detail} ready=${ready[0] ?? 'none'}\n`,
  )
  if (!pass) failures += 1
}

{
  const { fixture, result, messages, missing, existing } = await runPartialFrameBuild()
  const placed = messages.filter((line) => line.startsWith(PORTAL_BLOCK_PLACED))
  const ready = messages.filter((line) => line.startsWith(PORTAL_FRAME_READY))
  const support = messages.filter((line) => line.startsWith('PORTAL_SUPPORT_PLACED'))
  const pass =
    result.status === 'done' &&
    result.verified === true &&
    placed.length === missing.length &&
    ready.length === 1 &&
    support.length === 1 &&
    existing.every((cell) => fixture.grid.get(key(cell)) === OBSIDIAN) &&
    missing.every((cell) => fixture.grid.get(key(cell)) === OBSIDIAN)
  process.stdout.write(
    `${pass ? 'PASS' : 'FAIL'}  (5a-partial) a sensed 7/10 frame continues with adjacent top-edge scaffolding\n` +
      `      status=${result.status} placed=${placed.length} support=${support.length} ready=${ready[0] ?? 'none'} failure=${result.failure ?? 'none'}\n`,
  )
  if (!pass) failures += 1
}

{
  const target = { x: ORIGIN.x, y: ORIGIN.y + 1, z: 0 }
  const { fixture, result, approaches, messages } = await runReferenceApproachBuild()
  const pass =
    result.status === 'done' &&
    result.verified === true &&
    fixture.grid.get(key(target)) === 'cobblestone' &&
    approaches.length === 1 &&
    approaches[0]?.y === ORIGIN.y - 2 &&
    messages.some((line) => line === 'PLACE_APPROACH target=5,65,0 reference=5,64,0 stand=4,62,0')
  process.stdout.write(
    (pass ? 'PASS' : 'FAIL') + '  (5a-approach) an out-of-reach placement walks to a lower supported reference stand\n' +
      '      status=' + result.status + ' verified=' + result.verified + ' approaches=' + JSON.stringify(approaches) + ' failure=' + (result.failure ?? 'none') + '\n',
  )
  if (!pass) failures += 1
}

{
  const { fixture, result } = await runFrameBuild(false, 1)
  const pass = result.status === 'done' && result.verified === true && fixture.placeCalls.length === 10
  process.stdout.write(
    `${pass ? 'PASS' : 'FAIL'}  (5a-equip) placement verifies the live held item and retries a lagging equip\n` +
      `      status=${result.status} failure=${result.failure} calls=${fixture.placeCalls.length}\n`,
  )
  if (!pass) failures += 1
}

function placeCallsPlacedEveryCell(calls: readonly Vec3Json[], cells: readonly Vec3Json[]): boolean {
  const called = new Set(calls.map(key))
  return cells.every((cell) => called.has(key(cell)))
}

{
  const { result, messages } = await runFrameBuild(true)
  const placed = messages.filter((line) => line.startsWith(PORTAL_BLOCK_PLACED))
  const ready = messages.filter((line) => line.startsWith(PORTAL_FRAME_READY))
  const pass =
    result.status === 'failed' &&
    result.verified === false &&
    placed.length === 0 &&
    ready.length === 0
  process.stdout.write(
    `${pass ? 'PASS' : 'FAIL'}  (5b) an unmet place post-condition emits NO markers and fails the action\n` +
      `      status=${result.status} failure=${result.failure} placed=${placed.length} ready=${ready.length}\n`,
  )
  if (!pass) failures += 1
}

{
  const fixture = makePlaceBot({ x: 6.5, y: 64, z: -1.5 }, [], false)
  const pathfinder = fixture.bot.pathfinder as unknown as {
    getPathTo: (...args: unknown[]) => { status: string; path: P[] }
  }
  pathfinder.getPathTo = () => ({
    status: 'success',
    path: [new P(8.5, 69, -8.5), new P(7.5, 70, -7.5), new P(8.5, 71, -6.5)],
  })
  const executor = new Executor(fixture.bot, new EventLogger(new JsonlWriter(join(mkdtempSync(join(tmpdir(), 'frame-build-waypoint-')), 'agent.jsonl')), false), {
    ...defaultExecutorOptions,
    actuation: 'pathfinder',
  })
  const internals = executor as unknown as {
    planWaypoints: (target: Vec3Json, range: number) => Vec3Json[]
  }
  const waypoints = internals.planWaypoints({ x: 9, y: 70, z: -4 }, 1)
  const pass = JSON.stringify(waypoints) === JSON.stringify([
    { x: 7, y: 70, z: -8 },
    { x: 8, y: 71, z: -7 },
  ])
  process.stdout.write(
    `${pass ? 'PASS' : 'FAIL'}  (5c) packet waypoints normalize pathfinder center coordinates to block origins\n` +
      `      waypoints=${JSON.stringify(waypoints)}\n`,
  )
  if (!pass) failures += 1
}

process.stdout.write(`\n${failures === 0 ? 'OK' : 'FAILURES'}: ${failures} failing check(s)\n`)
if (failures > 0) process.exit(1)
