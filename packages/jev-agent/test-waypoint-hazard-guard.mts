// test-waypoint-hazard-guard.mts - the locomotion leg must not STEP off the world.
//
// FINAL LIVE CAUSAL CHAIN (`run-mucecx3h-1ljqz`, main 93030d2, Nether fortress;
// the earlier reconstruction `run-mucdemk5-1kg6b` is the same shape):
//
//   07:48:52 HEARTBEAT pos=30.2,55.9,-20.1   <- standing ON the fortress walkway,
//                                               on a RETRIEVE:known:blaze_rod:b37_55_-25 leg
//   <2 s later the body's own cell reads (32,30,-22)   <- a ~26-block drop INSIDE that leg
//   07:48:57 DEATH pos=32.3,28.3,-20.8       <- the lava lake under the fortress
//   08:14:07 ENV_HAZARD kind=lava / ENV_HAZARD_NO_EXIT kind=lava
//   08:14:10 DEATH                            <- typed hazard, correctly-refused reflex,
//                                               and the body still burned: the FALL killed it
//
// Every basin MOVE had ALREADY been withheld `CANDIDATE_WITHHELD ... reason=hazard_blocked`
// and the ascents were `needs_ascend ["safe_column:no_clearance@..."]`, so the body was
// never OFFERED a move into the lava. The fall happened while FOLLOWING the committed leg:
// `policy.ts guardMove` validates only the FINAL target cell (`nearestHazardTo` over
// `state.blocks` + the 5x5x3 `state.terrain.standable` window) and the per-tick actuators
// validated only headroom / face geometry - never the LANDING of the step they were about
// to take. `stepLanding.ts` now owns that question, asked once per step.
//
// Cases (charter):
//   (i)   walkway edge above lava / above the void -> the leg STOPS with the typed
//         `hazard_between` / `unsafe_landing`, the body does NOT step, the decision
//         returns to the policy (typed executor failure, charged as a movement failure);
//   (ii)  ordinary flat + 1-block step-up terrain -> byte-identical control trace
//         (guarded vs guard-stubbed), no marker, arrival unchanged;
//   (iii) a safe 1-block dip / gap crossing with verified solid support -> unchanged;
//   (iv)  a hazard block occupying the landing cell -> typed refusal;
//   (v)   an unloaded/unobserved landing -> NOT a hazard: byte-identical, the body steps;
//   plus the rule-level table, the mirrored-marker contract, the failure-code contract
//   and the "no A* re-run" bound.
//
// Run: bun ./test-waypoint-hazard-guard.mts
import { mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import type { Candidate } from './src/candidates.ts'
import { Executor, defaultExecutorOptions } from './src/executor.ts'
import { mirroredEventToken, moveFailureReason, MIRRORED_MARKERS } from './src/controller-legacy.ts'
import {
  classifyStepLanding,
  formatMoveLegStopped,
  isStepHazardBlock,
  MOVE_LEG_STOPPED,
  STEP_SUPPORT_NONE,
  STEP_SUPPORT_UNKNOWN,
} from './src/stepLanding.ts'
import type { StepLandingBlock, StepLandingReads } from './src/stepLanding.ts'
import { EventLogger, JsonlWriter } from './src/jev.ts'
import type { Vec3Json } from './src/state.ts'
import { fixtureClaim } from './test-claim-context.mts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const cellKey = (p: Vec3Json): string => `${p.x},${p.y},${p.z}`

// ---------------------------------------------------------------------------
// rule-level table: the pure classifier, no world, no bot
// ---------------------------------------------------------------------------
function block(name: string, boundingBox: string): StepLandingBlock {
  return { name, boundingBox }
}
const AIR = block('air', 'empty')
const STONE = block('stone', 'block')
const LEAVES = block('oak_leaves', 'block')
const LAVA = block('lava', 'empty')
const FIRE = block('fire', 'empty')
const WATER = block('water', 'empty')
const MAGMA = block('magma_block', 'block')
const window = (...cells: Array<StepLandingBlock | null>): StepLandingReads => ({
  landing: cells[0] ?? null,
  head: cells[1] ?? null,
  below: cells.slice(2),
})

{
  const flat = classifyStepLanding(window(AIR, AIR, STONE))
  check(
    '(rule) a flat step with real support one block down is legal (no marker, no refusal)',
    flat.reason === null && flat.support === 'stone',
    `reason=${flat.reason ?? 'none'} support=${flat.support}`,
  )
  const stepUp = classifyStepLanding(window(STONE, AIR, AIR))
  check(
    '(rule) a COLLIDABLE landing cell is a step-up/face, not a fall: existing climb logic owns it',
    stepUp.reason === null,
    `reason=${stepUp.reason ?? 'none'} support=${stepUp.support}`,
  )
  const deep = classifyStepLanding(window(AIR, AIR, AIR, AIR, AIR, STONE))
  check(
    '(rule) a 3-block drop onto solid ground is legal (the planner plans up to maxDropDown)',
    deep.reason === null && deep.support === 'stone',
    `reason=${deep.reason ?? 'none'} support=${deep.support}`,
  )
  const dip = classifyStepLanding(window(AIR, AIR, AIR, STONE))
  check(
    '(rule) a 1-block dip / gap crossing with verified solid support is legal',
    dip.reason === null && dip.support === 'stone',
    `reason=${dip.reason ?? 'none'} support=${dip.support}`,
  )
  const voidStep = classifyStepLanding(window(AIR, AIR, AIR, AIR, AIR, AIR))
  check(
    '(rule) a landing column with no support in the whole bounded window is `unsafe_landing`',
    voidStep.reason === 'unsafe_landing' && voidStep.support === STEP_SUPPORT_NONE,
    `reason=${voidStep.reason ?? 'none'} block=${voidStep.block ?? 'none'} support=${voidStep.support}`,
  )
  const landingHazard = classifyStepLanding(window(LAVA, AIR, STONE))
  check(
    '(rule) a hazard block OCCUPYING the landing cell is `hazard_between` (lava on a ledge)',
    landingHazard.reason === 'hazard_between' && landingHazard.block === 'lava',
    `reason=${landingHazard.reason ?? 'none'} block=${landingHazard.block ?? 'none'}`,
  )
  const headHazard = classifyStepLanding(window(AIR, FIRE, STONE))
  check(
    '(rule) a hazard at the landing head cell is `hazard_between` (the body would stand in fire)',
    headHazard.reason === 'hazard_between' && headHazard.block === 'fire',
    `reason=${headHazard.reason ?? 'none'} block=${headHazard.block ?? 'none'}`,
  )
  const fallHazard = classifyStepLanding(window(AIR, AIR, AIR, AIR, AIR, LAVA, STONE))
  check(
    '(rule) a hazard anywhere in the fall path under the landing is `hazard_between` (the measured walkway)',
    fallHazard.reason === 'hazard_between' && fallHazard.block === 'lava' && fallHazard.support === STEP_SUPPORT_NONE,
    `reason=${fallHazard.reason ?? 'none'} block=${fallHazard.block ?? 'none'} support=${fallHazard.support}`,
  )
  const magma = classifyStepLanding(window(AIR, AIR, MAGMA, STONE))
  check(
    '(rule) a collidable hazard (magma_block) is a hazard first, a floor second',
    magma.reason === 'hazard_between' && magma.block === 'magma_block',
    `reason=${magma.reason ?? 'none'} block=${magma.block ?? 'none'}`,
  )
  const unknownLanding = classifyStepLanding(window(null, AIR, STONE))
  check(
    '(rule) UNKNOWN is not false: an unloaded landing cell is never a refusal',
    unknownLanding.reason === null && unknownLanding.support === STEP_SUPPORT_UNKNOWN,
    `reason=${unknownLanding.reason ?? 'none'} support=${unknownLanding.support}`,
  )
  const unknownBelow = classifyStepLanding(window(AIR, AIR, null, null, LAVA))
  check(
    '(rule) UNKNOWN is not false: an unloaded cell under the landing ends the scan (no refusal)',
    unknownBelow.reason === null && unknownBelow.support === STEP_SUPPORT_UNKNOWN,
    `reason=${unknownBelow.reason ?? 'none'} support=${unknownBelow.support}`,
  )
  const water = classifyStepLanding(window(AIR, AIR, WATER))
  check(
    '(rule) water ends the fall and is NOT this guard\'s question (submersion owns it)',
    water.reason === null && water.support === 'water',
    `reason=${water.reason ?? 'none'} support=${water.support}`,
  )
  const canopy = classifyStepLanding(window(AIR, AIR, LEAVES))
  check(
    '(rule) a leaf canopy is a legal landing (locomotion truth: a treetop is walkable)',
    canopy.reason === null && canopy.support === 'oak_leaves',
    `reason=${canopy.reason ?? 'none'} support=${canopy.support}`,
  )
  check(
    '(rule) the hazard vocabulary is the sensor\'s own (PROBE_HAZARDS)',
    isStepHazardBlock('lava') && isStepHazardBlock('fire') && !isStepHazardBlock('water') && !isStepHazardBlock(null),
    `lava=${isStepHazardBlock('lava')} fire=${isStepHazardBlock('fire')} water=${isStepHazardBlock('water')}`,
  )
}

// ---------------------------------------------------------------------------
// marker contract: the exact line AND the host-sink mapping
// ---------------------------------------------------------------------------
{
  const line = formatMoveLegStopped({
    reason: 'hazard_between',
    from: { x: 30, y: 55, z: -20 },
    to: { x: 31, y: 55, z: -20 },
    block: 'lava',
    support: STEP_SUPPORT_NONE,
  })
  check(
    '(marker) the exact `MOVE_LEG_STOPPED` line names the reason, both cells, the block and the support',
    line === 'MOVE_LEG_STOPPED reason=hazard_between from=30,55,-20 to=31,55,-20 block=lava support=none',
    `line="${line}"`,
  )
  check(
    '(marker) the line is a MIRRORED host event (the live sink would otherwise drop it)',
    MIRRORED_MARKERS.has(MOVE_LEG_STOPPED) && mirroredEventToken(line) === MOVE_LEG_STOPPED,
    `registered=${MIRRORED_MARKERS.has(MOVE_LEG_STOPPED)} token=${mirroredEventToken(line) ?? 'dropped'}`,
  )
  check(
    '(contract) both typed reasons are executor FailureCodes and charge the movement memory boundedly',
    moveFailureReason('hazard_between') === 'no_progress' && moveFailureReason('unsafe_landing') === 'no_progress',
    `hazard_between=${moveFailureReason('hazard_between')} unsafe_landing=${moveFailureReason('unsafe_landing')}`,
  )
  const executorSource = readFileSync(join(import.meta.dir, 'src', 'executor.ts'), 'utf8')
  const guardStart = executorSource.indexOf('private moveStepLandingWindow(')
  const guardEnd = executorSource.indexOf('\n  private ', executorSource.indexOf('private guardStepLanding(') + 1)
  // code only: the doc comments of the neighbouring methods are prose, not calls
  const guardBody = executorSource
    .slice(guardStart, guardEnd === -1 ? guardStart + 3000 : guardEnd)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  check(
    '(bound) the guard re-plans nothing: no A* call and no route choice inside it',
    executorSource.includes("| 'hazard_between'") &&
      executorSource.includes("| 'unsafe_landing'") &&
      !/getPathTo|setGoal|getPathFromTo/.test(guardBody),
    `codes=${executorSource.includes("| 'hazard_between'")}/${executorSource.includes("| 'unsafe_landing'")} astarInGuard=${/getPathTo|setGoal|getPathFromTo/.test(guardBody)}`,
  )
  const landingSource = readFileSync(join(import.meta.dir, 'src', 'stepLanding.ts'), 'utf8')
  check(
    '(bound) the verdict module is pure: no pathfinder/A* import at all',
    !/pathfinder|getPathTo|setGoal/.test(landingSource),
    `pure=${!/pathfinder|getPathTo|setGoal/.test(landingSource)}`,
  )
}

// ---------------------------------------------------------------------------
// a grid + control-state bot whose world model is the FORTRESS WALKWAY.
// ---------------------------------------------------------------------------
interface GridCell {
  name: string
  boundingBox: string
}
type Grid = Map<string, GridCell>

function solid(name: string): GridCell {
  return { name, boundingBox: name === 'air' || name === 'lava' || name === 'fire' || name === 'water' ? 'empty' : 'block' }
}
function fill(grid: Grid, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, name: string): void {
  for (let x = x0; x <= x1; x += 1) {
    for (let y = y0; y <= y1; y += 1) {
      for (let z = z0; z <= z1; z += 1) grid.set(`${x},${y},${z}`, solid(name))
    }
  }
}

interface Fixture {
  bot: Bot
  position: Vec3
  trace: string[]
  pathCalls: () => number
  grid: Grid
}

/** One forward push of the control walk (the packet/control cadence's step). */
const STEP = 0.25

function makeBot(feet: Vec3Json, grid: Grid): Fixture {
  const position = new Vec3(feet.x + 0.5, feet.y, feet.z + 0.5)
  const trace: string[] = []
  let pathCalls = 0
  let heading = { x: 0, z: 0 }
  const at = (x: number, y: number, z: number): GridCell | null => grid.get(`${x},${y},${z}`) ?? null
  const open = (x: number, y: number, z: number): boolean => {
    const found = at(x, y, z)
    return found === null || found.boundingBox === 'empty'
  }
  const blockAt = (v: { x: number; y: number; z: number }) => {
    const found = at(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z))
    if (found === null) return null
    return {
      name: found.name,
      boundingBox: found.boundingBox,
      diggable: false,
      position: new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)),
    }
  }
  const listeners = new Map<string, Set<() => void>>()
  const bot = {
    registry,
    game: { dimension: 'minecraft:overworld' as string },
    physicsEnabled: true,
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
    entities: {},
    inventory: { items: () => [], count: () => 0 },
    heldItem: null,
    blockAt,
    on: (event: string, listener: () => void) => {
      const set = listeners.get(event) ?? new Set<() => void>()
      set.add(listener)
      listeners.set(event, set)
    },
    removeListener: (event: string, listener: () => void) => {
      listeners.get(event)?.delete(listener)
    },
    setControlState: (control: string, state: boolean) => {
      if (!state) return
      trace.push(control)
      const feetY = Math.floor(position.y + 0.1)
      if (control === 'jump') {
        // a vanilla 1-block step-up lands ON TOP of the rise in front
        const cx = Math.floor(position.x + heading.x)
        const cz = Math.floor(position.z + heading.z)
        const ahead = at(cx, feetY, cz)
        if (ahead !== null && ahead.boundingBox !== 'empty' && open(cx, feetY + 1, cz) && open(cx, feetY + 2, cz)) {
          position.y = feetY + 1
        }
        return
      }
      if (control !== 'forward' && control !== 'back') return
      const sign = control === 'forward' ? 1 : -1
      const nx = position.x + heading.x * STEP * sign
      const nz = position.z + heading.z * STEP * sign
      const cx = Math.floor(nx)
      const cz = Math.floor(nz)
      if (control === 'forward') {
        const ahead = at(cx, feetY, cz)
        if (ahead !== null && ahead.boundingBox !== 'empty' && open(cx, feetY + 1, cz) && open(cx, feetY + 2, cz)) {
          position.y = feetY + 1
        } else if (open(cx, feetY, cz) && open(cx, feetY - 1, cz)) {
          const floor = at(cx, feetY - 2, cz)
          if (floor !== null && floor.boundingBox !== 'empty') position.y = feetY - 1
        }
      }
      position.x = nx
      position.z = nz
    },
    clearControlStates: () => undefined,
    canDigBlock: () => false,
    lookAt: async (point: { x: number; z: number }) => {
      const dx = point.x - position.x
      const dz = point.z - position.z
      const length = Math.hypot(dx, dz) || 1
      heading = { x: dx / length, z: dz / length }
    },
    digTime: () => 50,
    dig: async () => undefined,
    stopDigging: () => undefined,
    equip: async () => undefined,
    pathfinder: {
      movements: null as unknown,
      setMovements: (movements: unknown) => {
        bot.pathfinder.movements = movements
      },
      setGoal: () => undefined,
      stop: () => undefined,
      // the measured leg's own plan stage: `noPath` (canDig=false) hands the leg
      // to the control walker, which is where the body fell
      getPathTo: () => {
        pathCalls += 1
        return { status: 'noPath', path: [] }
      },
    },
  }
  return { bot: bot as unknown as Bot, position, trace, pathCalls: () => pathCalls, grid }
}

const TARGET: Vec3Json = { x: 38, y: 55, z: -20 }

function retrieveCandidate(target: Vec3Json): Candidate {
  return {
    id: `RETRIEVE:known:blaze_rod:b${target.x}_${target.y}_${target.z}`,
    kind: 'RETRIEVE',
    label: `retrieve the remembered blaze rod at (${target.x},${target.y},${target.z})`,
    targetName: 'blaze_rod',
    target,
    targetEntityId: null,
    itemName: 'blaze_rod',
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: {},
  }
}

interface LegRun {
  status: string
  failure: string | null
  verified: boolean
  moved: number
  trace: string[]
  pathCalls: number
  messages: string[]
  stopLines: string[]
}

/**
 * Drive ONE committed RETRIEVE approach leg (`runRetrieve` -> `pathToNear` ->
 * `walkByControls`) over the fixture's world model. `stubGuard` reproduces the
 * PRE-FIX actuator (the guard method replaced by a no-op) so the same scenario
 * can be compared with and without the guard.
 */
async function runLeg(feet: Vec3Json, grid: Grid, stubGuard = false): Promise<LegRun> {
  const dir = mkdtempSync(join(tmpdir(), 'waypoint-hazard-guard-'))
  const fixture = makeBot(feet, grid)
  const logger = new EventLogger(new JsonlWriter(join(dir, 'agent.jsonl')), false)
  const executor = new Executor(fixture.bot, logger, {
    ...defaultExecutorOptions,
    actuation: 'packet',
    packetStepMs: 1,
  })
  if (stubGuard) {
    ;(executor as unknown as { guardStepLanding: () => void }).guardStepLanding = () => undefined
  }
  const start = fixture.position.clone()
  const result = await fixtureClaim(executor, retrieveCandidate(TARGET)).completion
  const messages = (await Bun.file(join(dir, 'agent.jsonl')).text())
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { message?: string }).message ?? '')
  return {
    status: result.status,
    failure: result.failure,
    verified: result.verified,
    moved: fixture.position.distanceTo(start),
    trace: fixture.trace,
    pathCalls: fixture.pathCalls(),
    messages,
    stopLines: messages.filter((line) => line.startsWith(MOVE_LEG_STOPPED)),
  }
}

/** The walkway the body stands on: stone floor at y=54 for x 26..30, air above. */
function walkway(): Grid {
  const grid: Grid = new Map()
  fill(grid, 26, 30, 54, 54, -21, -19, 'stone')
  fill(grid, 26, 30, 55, 58, -21, -19, 'air')
  return grid
}

const FEET: Vec3Json = { x: 30, y: 55, z: -20 }

// ---------------------------------------------------------------------------
// (i-a) THE MEASURED SHAPE: the walkway edge above the fortress lava lake.
// ---------------------------------------------------------------------------
{
  const grid = walkway()
  // the lava lake under the fortress, 5 blocks below the walkway lip
  fill(grid, 31, 40, 46, 50, -21, -19, 'lava')
  fill(grid, 31, 40, 51, 58, -21, -19, 'air')
  const guarded = await runLeg(FEET, grid)
  const stop = guarded.stopLines[0] ?? ''
  check(
    '(i-a) the walkway edge above lava: the leg STOPS typed, the body does not step, the decision returns to policy',
    guarded.status === 'failed' &&
      guarded.failure === 'hazard_between' &&
      stop === 'MOVE_LEG_STOPPED reason=hazard_between from=30,55,-20 to=31,55,-20 block=lava support=none' &&
      guarded.trace.length === 0 &&
      guarded.moved < 0.001,
    `status=${guarded.status} failure=${guarded.failure ?? 'none'} controls=[${guarded.trace.join(',')}] moved=${guarded.moved.toFixed(3)} stop=[${stop}]`,
  )
  check(
    '(i-a) the stop adds NO A*: only the walker\'s own two probes ran (entry plan + first replan)',
    guarded.pathCalls === 2,
    `getPathTo calls=${guarded.pathCalls}`,
  )
  const unguarded = await runLeg(FEET, grid, true)
  check(
    '(i-a BEFORE-WITNESS) with the guard stubbed out the SAME fixture pushes the body forward off the edge - the measured defect',
    unguarded.trace.includes('forward') && unguarded.moved > 0.5 && unguarded.stopLines.length === 0,
    `controls=[${unguarded.trace.join(',')}] moved=${unguarded.moved.toFixed(2)} stops=${unguarded.stopLines.length}`,
  )
}

// ---------------------------------------------------------------------------
// (i-b) the same edge above an OBSERVED VOID (no hazard, no support at all).
// ---------------------------------------------------------------------------
{
  const grid = walkway()
  fill(grid, 31, 40, 45, 58, -21, -19, 'air')
  const guarded = await runLeg(FEET, grid)
  const stop = guarded.stopLines[0] ?? ''
  check(
    '(i-b) the walkway edge above the void: the leg STOPS `unsafe_landing`, the body does not step',
    guarded.status === 'failed' &&
      guarded.failure === 'unsafe_landing' &&
      stop === 'MOVE_LEG_STOPPED reason=unsafe_landing from=30,55,-20 to=31,55,-20 block=air support=none' &&
      guarded.trace.length === 0 &&
      guarded.moved < 0.001,
    `status=${guarded.status} failure=${guarded.failure ?? 'none'} controls=[${guarded.trace.join(',')}] stop=[${stop}]`,
  )
}

// ---------------------------------------------------------------------------
// (iv) a hazard block OCCUPYING the landing cell (lava on a solid ledge).
// ---------------------------------------------------------------------------
{
  const grid = walkway()
  fill(grid, 31, 40, 54, 54, -21, -19, 'stone')
  fill(grid, 31, 40, 55, 58, -21, -19, 'air')
  fill(grid, 31, 31, 55, 55, -20, -20, 'lava')
  const guarded = await runLeg(FEET, grid)
  const stop = guarded.stopLines[0] ?? ''
  check(
    '(iv) a hazard in the landing cell refuses the step typed, before any control state',
    guarded.status === 'failed' &&
      guarded.failure === 'hazard_between' &&
      stop.includes('to=31,55,-20 block=lava') &&
      guarded.trace.length === 0,
    `status=${guarded.status} failure=${guarded.failure ?? 'none'} controls=[${guarded.trace.join(',')}] stop=[${stop}]`,
  )
}

// ---------------------------------------------------------------------------
// (ii) ordinary flat + 1-block step-up terrain: byte-identical, no marker.
// ---------------------------------------------------------------------------
{
  const grid = new Map<string, GridCell>()
  fill(grid, 26, 33, 54, 54, -21, -19, 'stone')
  fill(grid, 26, 33, 55, 58, -21, -19, 'air')
  fill(grid, 34, 40, 55, 55, -21, -19, 'stone') // the 1-block rise
  fill(grid, 34, 40, 56, 59, -21, -19, 'air')
  const guarded = await runLeg(FEET, grid)
  const unguarded = await runLeg(FEET, grid, true)
  check(
    '(ii) ordinary flat + step-up terrain: the guarded control trace is byte-identical to the pre-fix actuator',
    guarded.trace.length > 0 && guarded.trace.join(',') === unguarded.trace.join(','),
    `guarded=[${guarded.trace.join(',')}] unguarded=[${unguarded.trace.join(',')}]`,
  )
  check(
    '(ii) ordinary terrain emits NO stop marker and still arrives',
    guarded.stopLines.length === 0 &&
      guarded.messages.every((line) => !line.startsWith(MOVE_LEG_STOPPED)) &&
      guarded.status === 'done' &&
      guarded.verified === true &&
      guarded.moved > 5,
    `stops=${guarded.stopLines.length} status=${guarded.status} verified=${guarded.verified} moved=${guarded.moved.toFixed(2)}`,
  )
  check(
    '(ii) the step-up was actually climbed by the body (the trace carries the jump, the body rose)',
    guarded.trace.includes('jump') && guarded.trace.join(',') === unguarded.trace.join(','),
    `jumps=${guarded.trace.filter((control) => control === 'jump').length} controls=[${guarded.trace.join(',')}]`,
  )
}

// ---------------------------------------------------------------------------
// (iii) a safe 1-block dip / gap crossing with verified solid support.
// ---------------------------------------------------------------------------
{
  const grid = new Map<string, GridCell>()
  fill(grid, 26, 30, 54, 54, -21, -19, 'stone')
  fill(grid, 26, 30, 55, 58, -21, -19, 'air')
  // a TWO-wide missing floor whose support is one block down: a gap crossing
  fill(grid, 31, 32, 53, 53, -21, -19, 'stone')
  fill(grid, 31, 32, 54, 58, -21, -19, 'air')
  fill(grid, 33, 40, 54, 54, -21, -19, 'stone')
  fill(grid, 33, 40, 55, 58, -21, -19, 'air')
  const guarded = await runLeg(FEET, grid)
  const unguarded = await runLeg(FEET, grid, true)
  check(
    '(iii) a 1-block dip / 2-wide gap crossing with solid support is unchanged: same trace, no marker, arrival',
    guarded.stopLines.length === 0 &&
      guarded.status === 'done' &&
      guarded.trace.length > 0 &&
      guarded.trace.join(',') === unguarded.trace.join(','),
    `stops=${guarded.stopLines.length} status=${guarded.status} guarded=[${guarded.trace.join(',')}] unguarded=[${unguarded.trace.join(',')}]`,
  )
}

// ---------------------------------------------------------------------------
// (v) an unloaded / unobserved landing: NOT a hazard, byte-identical.
// ---------------------------------------------------------------------------
{
  const grid = new Map<string, GridCell>()
  fill(grid, 26, 30, 54, 54, -21, -19, 'stone')
  fill(grid, 26, 30, 55, 58, -21, -19, 'air')
  // x >= 31 is NOT in the grid: `blockAt` answers null (unloaded chunk)
  const guarded = await runLeg(FEET, grid)
  const unguarded = await runLeg(FEET, grid, true)
  check(
    '(v) an unloaded landing is NOT a hazard: the body steps, no marker, byte-identical trace',
    guarded.stopLines.length === 0 &&
      guarded.trace.length > 0 &&
      guarded.trace.includes('forward') &&
      guarded.trace.join(',') === unguarded.trace.join(','),
    `stops=${guarded.stopLines.length} moved=${guarded.moved.toFixed(2)} guarded=[${guarded.trace.join(',')}] unguarded=[${unguarded.trace.join(',')}]`,
  )
}

process.stdout.write('------------------------------------------------------------------------\n')
process.stdout.write(`waypoint hazard guard cases: ${failures === 0 ? 'all passed' : `${failures} failed`}\n`)
if (failures > 0) process.exit(1)
