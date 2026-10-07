// test-descent-transit-head.mts - a `down` descent step must declare the
// front-column HEAD cell in its dig plan whenever that cell is solid.
//
// Measured live (portal-p27.12, gen-muxqidfj, source 66d3e277): the body's
// `WALL_ENTRY:down:E` dug wall (y54) + floor (y53) exactly as `digs` declared,
// then `PATH_CALLBACK outcome=noPath`, the control-walk ray hit the untouched
// solid at (y55) - the head cell above the wall - and the step ended
// `packet locomotion blocked` / `path_stuck`. The `down` step physically
// ENTERS the front column at feet level before the drop, so the body's upper
// half transits `head` even though it never stands there; a solid head cell
// left out of `digs` makes the step un-enterable.
//
// The doc claim "the body never stands at the current feet level inside the
// front column" was true of the LANDING and wrong about the TRANSIT.
//
// Run: bun ./test-descent-transit-head.mts
import { createRequire } from 'node:module'
import { buildWorldState, defaultSensorOptions, makeGoal, descentDigPlan } from './src/state.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { AgentSignals, Vec3Json, WorldState } from './src/state.ts'

const require = createRequire(import.meta.url)
const Vec3 = require('vec3')
const registry = require('minecraft-data')('1.21.11')

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const BLOCKS: Record<string, { boundingBox: string; diggable: boolean }> = {
  air: { boundingBox: 'empty', diggable: false },
  dirt: { boundingBox: 'block', diggable: true },
  grass_block: { boundingBox: 'block', diggable: true },
  stone: { boundingBox: 'block', diggable: true },
  sand: { boundingBox: 'block', diggable: true },
}

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`
const nameAt = (grid: Map<string, string>, x: number, y: number, z: number): string =>
  grid.get(key(x, y, z)) ?? 'air'

type Bot = Parameters<typeof buildWorldState>[0]

function gridBot(grid: Map<string, string>, position: Vec3Json): Bot {
  const pos = new Vec3(position.x, position.y, position.z)
  const blockAt = (point: { x: number; y: number; z: number }) => {
    const x = Math.floor(point.x)
    const y = Math.floor(point.y)
    const z = Math.floor(point.z)
    const name = nameAt(grid, x, y, z)
    const shape = BLOCKS[name] ?? BLOCKS.air
    return { name, ...shape, position: new Vec3(x, y, z) }
  }
  return {
    username: 'AI_TRANSIT',
    entity: { id: 1, position: pos, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 20,
    food: 20,
    game: { gameMode: 'survival', dimension: 'minecraft:overworld', minY: -64, height: 384 },
    time: { isDay: true },
    registry,
    entities: {},
    inventory: { items: () => [] },
    blockAt,
    canSeeBlock: () => true,
    findBlocks: () => [],
  } as never
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

function perceive(grid: Map<string, string>, position: Vec3Json): WorldState {
  return buildWorldState(gridBot(grid, position), {
    tick: 1,
    goal: makeGoal('cobblestone', 1),
    goalQueue: emptyGoalQueueState(),
    focusItem: null,
    recentEvents: [],
    signals: signals(),
  }, defaultSensorOptions)
}

const cell = (x: number, y: number, z: number): string => `${x},${y},${z}`

/**
 * The live shape: body at (10,70,10) on a dirt floor; the east front column is
 * a dirt face at y70 (wall), y69 (floor, diggable stone below for support is
 * irrelevant - the floor cell is dug to open the drop) with support at y68.
 * The head cell above the wall (10+1, 71) is ALSO solid dirt - the measured
 * failure geometry. A `down` step must declare wall + head + floor.
 */
function wallWithSolidHead(): Map<string, string> {
  const grid = new Map<string, string>()
  for (let dx = -3; dx <= 3; dx += 1) {
    for (let dz = -3; dz <= 3; dz += 1) {
      for (let y = 66; y <= 69; y += 1) grid.set(key(10 + dx, y, 10 + dz), 'dirt')
    }
  }
  // East column face: solid at wall (y70) and head (y71); the floor cell (y69)
  // and support (y68) are the same dirt column - the descent digs the floor to
  // open the drop and lands on y68.
  for (let y = 66; y <= 71; y += 1) grid.set(key(11, y, 10), 'dirt')
  return grid
}

const feet = { x: 10, y: 70, z: 10 }
const state = perceive(wallWithSolidHead(), feet)
const east = (state.descent ?? []).find((option) => option.dir === 'E' && option.mode === 'down')
const digCellSet = east === undefined ? new Set<string>() : new Set(descentDigPlan(east).map((req) => cell(req.cell.x, req.cell.y, req.cell.z)))

check(
  '(a1) a down-step with a solid head cell declares wall+head+floor in digs',
  east !== undefined &&
    east.safe === true &&
    digCellSet.has(cell(11, 70, 10)) &&
    digCellSet.has(cell(11, 71, 10)) &&
    digCellSet.has(cell(11, 69, 10)),
  `east down-step: safe=${east?.safe} reason="${east?.reason}" digs=[${east?.digs?.map((req) => `${req.cell.x},${req.cell.y},${req.cell.z}`).join(' ')}] plan=[${[...digCellSet].join(' ')}]`,
)

/**
 * Same face with the head cell already open: the step stays safe and digs
 * only wall + floor - no cell is dug that need not be.
 */
function wallWithOpenHead(): Map<string, string> {
  const grid = wallWithSolidHead()
  grid.delete(key(11, 71, 10))
  return grid
}

const openState = perceive(wallWithOpenHead(), feet)
const openEast = (openState.descent ?? []).find((option) => option.dir === 'E' && option.mode === 'down')
const openDigSet = openEast === undefined ? new Set<string>() : new Set(descentDigPlan(openEast).map((req) => cell(req.cell.x, req.cell.y, req.cell.z)))

check(
  '(a2) a down-step with an open head cell digs only wall+floor (no wasted dig)',
  openEast !== undefined &&
    openEast.safe === true &&
    digCellSet.size > 0 &&
    openDigSet.has(cell(11, 70, 10)) &&
    !openDigSet.has(cell(11, 71, 10)) &&
    openDigSet.has(cell(11, 69, 10)),
  `east down-step: digs=[${openEast?.digs?.map((req) => `${req.cell.x},${req.cell.y},${req.cell.z}`).join(' ')}]`,
)

/**
 * Digging `head` exposes the cell above it: a faller at head+1 drops into the
 * opened transit column the moment `head` is cleared - the same measured-death
 * class the cut pool already guards. A sand cell over the diggable head must
 * refuse the whole step.
 */
function wallWithFallerAboveHead(): Map<string, string> {
  const grid = wallWithSolidHead()
  grid.set(key(11, 72, 10), 'sand')
  return grid
}

const fallerState = perceive(wallWithFallerAboveHead(), feet)
const fallerEast = (fallerState.descent ?? []).find((option) => option.dir === 'E' && option.mode === 'down')

check(
  '(a3) a faller above the newly-dug head cell refuses the down-step',
  fallerEast !== undefined && fallerEast.safe === false && fallerEast.refusal === 'hazard',
  `east down-step: safe=${fallerEast?.safe} refusal=${fallerEast?.refusal} reason="${fallerEast?.reason}"`,
)

if (failures > 0) {
  process.stdout.write(`${failures} FAIL\n`)
  process.exit(1)
}
process.stdout.write('ALL PASS\n')
