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
  PORTAL_APPROACH_LEG,
  PORTAL_APPROACH_REFUSED,
  PORTAL_ENTER_SKILL,
  REFLEX,
  SKILL_END,
  SKILL_INTERRUPT,
  SKILL_POLICY_BOUNDARY,
  SKILL_START,
  SKILL_STEP,
  PORTAL_WALK_IN,
  PORTAL_WALK_IN_REFUSED,
  PORTAL_WALK_IN_LEVEL_TOLERANCE,
  PORTAL_ENTRY_CLIMB,
  PORTAL_ENTRY_CLIMB_REFUSED,
  PORTAL_ENTRY_CROSS,
  formatPortalEntryNoKnownSite,
  planPortalEntry,
  portalFrameLayout,
  serializePortalCells,
} from './src/netherPortalPlan.ts'
import type { PortalEntryPlan, PortalFrameSite } from './src/netherPortalPlan.ts'
import { defaultCandidateOptions, entryCandidates, generateGroundedCandidates } from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import { cellKey, observeZeroProgressRoute, routeSignature } from './src/zeroProgressRoute.ts'
import { BRIDGE_DIRS, BRIDGE_META, BRIDGE_PLACE_META } from './src/bridgeRoute.ts'
import { probeBridgeDirection } from './src/state.ts'
import type { BridgeProbe } from './src/bridgeRoute.ts'
import { guardCandidate } from './src/policy.ts'
import { Executor, ExecutorError, defaultExecutorOptions } from './src/executor.ts'
import { MIRRORED_MARKERS } from './src/controller.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { AgentSignals, DescentOption, InventoryState, SelfState, StepCut, Vec3Json, WorldState } from './src/state.ts'
import { isStandable } from './src/state.ts'
import { PILLAR_LANDING_Y_TOLERANCE } from './src/pillarApex.ts'
import { StateFingerprintMemory } from './src/moveFailMemory.ts'
import { EventLogger, JsonlWriter } from './src/jev.ts'
import { fixtureClaim } from './test-claim-context.mts'

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
  /** the walk model reached a standable OPEN face of the portal */
  movedToFace: boolean
  /** which placement entry point each pillar packet went through, in order */
  placePaths: string[]
  /** the live vanilla jump impulse, applied by the engine's own tick */
  launchJump: () => void
  /** stop this fixture's engine loop */
  stop: () => void
}

// ---------------------------------------------------------------------------
// THE LIVE ENGINE. A pillar step is an ENGINE act, not a locomotion-model act:
// its placement is authorised by the body's OCCUPANCY across the actuator's
// declared gap (`pillarPlaceCellCleared`), which reads the body's real
// `entity.velocity` over the arc. The fixture must therefore integrate the same
// arc prismarine-physics does, and emit the same `physicsTick` the apex window
// counts - otherwise it is not modelling the act it claims to reproduce.
//
// The values are the engine's own expressions, pinned exactly as the pillar
// lane's `test-pillar-place-attempt.mts` pins them (prismarine-physics
// index.js:62-63 `gravity: 0.08` / `airdrag: Math.fround(1 - 0.02)`, applied at
// index.js:601-603 as `vel.y -= gravity` then `vel.y *= airdrag`), plus the
// vanilla jump impulse `Math.fround(0.42)`.
//
// WHY THIS EXISTS: the fake bot's `entity.velocity` used to be a frozen
// `new Vec3(0, 0, 0)`, a "jump" was a discrete `position.y += 1` teleport, and
// nothing ever emitted `physicsTick`. Under the merged pillar contract that
// combination is unsatisfiable and unreadable at once: the teleport leaves
// `velocity.y === 0`, so the occupancy predicate can never clear the cell, and
// with no tick event the apex window ends on its deadline with
// `apexTicks === 0` and reports the typed `physics_stalled` - i.e. "the physics
// loop is idle", which is a LIVE-IMPOSSIBLE reading. The merged live run
// measured the same act as
// `PILLAR_UP_STEP ... apexRise=1.2522 samples=24 attemptFeetY=67.001
// attemptCellTop=67 attemptClearance=0`, a real arc with a real velocity.
// ---------------------------------------------------------------------------
/** mineflayer's physics cadence: one integration per 50 ms frame (physics.js). */
const PHYSICS_FRAME_MS = 50
const GRAVITY_PER_TICK = 0.08
const DRAG_PER_TICK = Math.fround(1 - 0.02)
const JUMP_IMPULSE_VY = Math.fround(0.42)

function makeBot(
  feet: Vec3Json,
  grid: Map<string, Cell>,
  hasPickaxe: boolean,
  carried: Record<string, number> = {},
): FixtureBot {
  const position = new Vec3(feet.x + 0.5, feet.y, feet.z + 0.5)
  const digs: string[] = []
  const pathCalls: Vec3Json[] = []
  const legs: string[] = []
  /** which placement entry point each pillar packet went through, in order */
  const placePaths: string[] = []
  const inventoryItems = hasPickaxe ? [{ name: 'diamond_pickaxe', type: registry.itemsByName.diamond_pickaxe.id as number, count: 1 }] : []
  // The blocks the route DECLARED (the crossing's `bridgeBlock`): the body really
  // carries them, so `equipPlacementItem` + `placeBlock` can consume them exactly
  // as the live actuator does.
  for (const [name, count] of Object.entries(carried)) {
    const type = registry.itemsByName[name]?.id
    if (typeof type !== 'number') throw new Error(`fixture: unknown item ${name}`)
    inventoryItems.push({ name, type, count })
  }
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
  /** The one placement rule both mineflayer entry points share. */
  const placeAt = (reference: { position: Vec3 }, face: { x: number; y: number; z: number }): void => {
    const target = {
      x: Math.floor(reference.position.x) + face.x,
      y: Math.floor(reference.position.y) + face.y,
      z: Math.floor(reference.position.z) + face.z,
    }
    const held = (bot.heldItem as { name: string } | null)?.name ?? 'cobblestone'
    grid.set(`${target.x},${target.y},${target.z}`, cell(held))
  }
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
    // mineflayer's equip makes the item the HELD one, and the executor's
    // `equipPlacementItem` requires exactly that reflection before it places.
    equip: async (item: { name: string; type: number; count: number }) => {
      bot.heldItem = item
    },
    // The server's own placement rule, modelled: the block lands in the cell the
    // clicked face points at, and it is the HELD item that goes in (mineflayer's
    // generic_place sends the held stack).
    placeBlock: async (reference: { position: Vec3 }, face: { x: number; y: number; z: number }) => {
      placeAt(reference, face)
    },
    // mineflayer's OWN internal placement entry. A LIVE bot has it, and the executor
    // reads its presence to declare the SAME-TICK actuator
    // (`executor.ts#pillarPlaceHandshakeTicks`); without it a pillar placement is
    // judged against the pessimistic look-handshake budget, so a genuinely cleared
    // apex is reported `apex_timeout`. The fixture models the live method and places
    // exactly as `placeBlock` does.
    // THE LIVE PLACEMENT ENTRY POINT. `Executor.placePillarBlock` prefers this
    // mineflayer API with `{ forceLook: 'ignore', swingArm: 'right' }`, and
    // `Executor.pillarPlaceHandshakeTicks()` reads the SAME fact to declare the
    // gap: because the entry point skips the asynchronous look handshake, the
    // packet is written inside the clearance sample's own tick, so the declared
    // gap is `PILLAR_PLACE_SAME_TICK` and the contract collapses to the exact
    // occupancy predicate the server applies.
    //
    // Omitting it made the fixture declare the pessimistic 4-tick look bound and
    // take the `bot.placeBlock` fallback - a configuration the live bot is not
    // in, and (per the contract's own comment, executor.ts:5146-5149) one in
    // which a one-block pillar step is legitimately refused before any attempt.
    // The merged live run went through THIS entry point.
    _placeBlockWithOptions: async (
      reference: { position: Vec3 },
      face: { x: number; y: number; z: number },
      options: { forceLook?: string } = {},
    ) => {
      placePaths.push(options.forceLook === 'ignore' ? 'forceLook:ignore' : `forceLook:${options.forceLook ?? 'handshake'}`)
      await bot.placeBlock(reference, face)
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

  // ---- the live physics loop ---------------------------------------------
  // One prismarine-physics integration per 50 ms frame, emitting the same
  // `physicsTick` mineflayer's `tickPhysics` emits after each `simulatePlayer`.
  //
  // The floor is the top of the highest solid block strictly BELOW the feet cell:
  // that is the block the body stands ON, and it is what an engine may land on.
  // Scanning the feet cell itself (as `correctStandingOnGround` does for the
  // executor's grounding, where a slab or snow layer can live in that cell) would
  // let this loop teleport a body UP a block whenever it moved into a solid
  // column - a step-up no engine performs, and one the locomotion model owns.
  const floorTopAt = (x: number, z: number, fromFeetY: number): number | null => {
    const column = { x: Math.floor(x), z: Math.floor(z) }
    for (let y = Math.floor(fromFeetY) - 1; y >= Math.floor(fromFeetY) - 4; y -= 1) {
      const block = grid.get(`${column.x},${y},${column.z}`)
      if (block === undefined || block.boundingBox !== 'block') continue
      return y + 1
    }
    return null
  }
  const physicsStep = (): void => {
    const velocity = bot.entity.velocity as unknown as { y: number }
    const before = position.y
    position.y += velocity.y
    const floorTop = floorTopAt(position.x, position.z, before)
    if (floorTop !== null && position.y < floorTop) {
      // the engine's landing: the block top under the body is the floor it stands on
      position.y = floorTop
      velocity.y = 0
      bot.entity.onGround = true
    } else {
      bot.entity.onGround = false
    }
    velocity.y = (velocity.y - GRAVITY_PER_TICK) * DRAG_PER_TICK
    for (const listener of listeners.get('physicsTick') ?? []) listener()
  }
  // prismarine-physics applies the vanilla impulse on the first tick after the
  // jump control is set (`entity.onGround && control.jump`), never on the client
  // side of `setControlState`.
  const launchJump = (): void => {
    if (!bot.entity.onGround) return
    ;(bot.entity.velocity as unknown as { y: number }).y = JUMP_IMPULSE_VY
    bot.entity.onGround = false
  }
  const physicsTimer = setInterval(() => {
    if (bot.physicsEnabled !== true) return
    physicsStep()
  }, PHYSICS_FRAME_MS)
  // Never let the engine loop hold the process open.
  ;(physicsTimer as unknown as { unref?: () => void }).unref?.()

  return {
    bot: bot as unknown as Bot,
    position,
    grid,
    digs,
    pathCalls,
    legs,
    inventoryItems,
    movedToFace: false,
    placePaths,
    launchJump,
    stop: () => {
      clearInterval(physicsTimer)
    },
  }
  // A clientbound position correction is delivered as `forcedMove` by a live bot.
  // A LIVE body emits `physicsTick` (~20/s) and `forcedMove` (on clientbound position
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
// the measured live approach (run-muc9k936-1f3vb): a floor one block BELOW the
// gate threshold, so the frame's bottom row tops out at the interior's y and the
// body must step up onto it. `pathTo` reports the measured path-stage failure.
// ---------------------------------------------------------------------------
function measuredApproachGrid(): Map<string, Cell> {
  const grid = gateGrid()
  for (const x of [24, 25, 26, 27, 28]) for (const z of [10, 11, 12]) grid.set(`${x},65,${z}`, cell('stone'))
  return grid
}

const MEASURED_STAND: Vec3Json = { x: 25.7, y: 66, z: 10.95 }

/** Replace the locomotion seam with the MEASURED `path_stuck` path stage. */
function stubStuckPath(fixture: FixtureBot): (executor: Executor) => void {
  return (executor) => {
    ;(executor as unknown as { pathTo: (target: Vec3Json) => Promise<void> }).pathTo = async (target: Vec3Json) => {
      fixture.pathCalls.push({ ...target })
      throw new ExecutorError('path_stuck', 'pathfinder GoalBlock -> stuck')
    }
  }
}

/** The standable level of a column near `aroundY`: solid support + 2 passable cells. */
function standableLevelAt(grid: Map<string, Cell>, x: number, z: number, aroundY: number): number | null {
  for (let y = Math.floor(aroundY) + 2; y >= Math.floor(aroundY) - 4; y -= 1) {
    const block = grid.get(`${x},${y},${z}`)
    if (block === undefined || block.boundingBox !== 'block') continue
    const feet = grid.get(`${x},${y + 1},${z}`)
    const head = grid.get(`${x},${y + 2},${z}`)
    const passable = (cell: Cell | undefined): boolean => cell === undefined || cell.boundingBox === 'empty'
    if (!passable(feet) || !passable(head)) return null
    return y + 1
  }
  return null
}

/**
 * The fixture's PATHFINDER model: a small BFS over standable cells, so a leg that
 * must route around the frame column is planned (the live `unreachable` came from
 * a straight bearing into that column; the real pathfinder routes it).
 */
function routeTo(fixture: FixtureBot, goal: Vec3Json): Vec3Json[] {
  const startLevel = Math.floor(fixture.position.y)
  const start = { x: Math.floor(fixture.position.x), z: Math.floor(fixture.position.z) }
  const startKey = `${start.x},${startLevel},${start.z}`
  const queue: Array<{ x: number; y: number; z: number }> = [{ x: start.x, y: startLevel, z: start.z }]
  const previous = new Map<string, string | null>([[startKey, null]])
  const nodes = new Map<string, { x: number; y: number; z: number }>([[startKey, queue[0] ?? { x: start.x, y: startLevel, z: start.z }]])
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    if (current.x === goal.x && current.y === goal.y && current.z === goal.z) {
      const path: Vec3Json[] = []
      let key: string | null = `${current.x},${current.y},${current.z}`
      while (key !== null) {
        const node = nodes.get(key)
        if (node !== undefined) path.unshift({ x: node.x, y: node.y, z: node.z })
        key = previous.get(key) ?? null
      }
      return path
    }
    for (const dir of [
      { x: 1, z: 0 },
      { x: -1, z: 0 },
      { x: 0, z: 1 },
      { x: 0, z: -1 },
    ]) {
      const level = standableLevelAt(fixture.grid, current.x + dir.x, current.z + dir.z, current.y)
      if (level === null || Math.abs(level - current.y) > 1) continue
      const key = `${current.x + dir.x},${level},${current.z + dir.z}`
      if (previous.has(key)) continue
      previous.set(key, `${current.x},${current.y},${current.z}`)
      const node = { x: current.x + dir.x, y: level, z: current.z + dir.z }
      nodes.set(key, node)
      queue.push(node)
    }
  }
  return []
}

/** The top of the solid column at (x,z) near `aroundY`, or null when unsupported. */
function surfaceTopAt(grid: Map<string, Cell>, x: number, z: number, aroundY: number): number | null {
  const column = { x: Math.floor(x), z: Math.floor(z) }
  for (let y = Math.floor(aroundY) + 2; y >= Math.floor(aroundY) - 4; y -= 1) {
    const block = grid.get(`${column.x},${y},${column.z}`)
    if (block === undefined || block.boundingBox !== 'block') continue
    return y + 1
  }
  return null
}

interface WalkModel {
  /** every control state the executor turned ON, in order */
  controls: string[]
  /** horizontal distance the body actually travelled */
  travelled: () => number
}

/**
 * The fixture's control-state movement model for the direct walk: the body's own
 * mechanism (forward pushes + a hop onto the one-block frame threshold) on the
 * measured geometry. `blocked` models a WALL: the forward push slides the body
 * sideways (no approach progress at all) and the hop never lands, so only the
 * walk's own no-progress bound can end it. `transfer` flips the fake dimension
 * the moment the body's own cell space becomes the interior.
 */
function installWalkModel(
  fixture: FixtureBot,
  options: {
    transfer: boolean
    blocked?: boolean
    vanishFace?: boolean
    /**
     * The measured PATH-stage failure (`PATH_CALLBACK phase=failed
     * outcome=noPath`): the pathfinder cannot own this cell, so the leg falls
     * back to the direct control walk - exactly the shape the step-over
     * continuation exists for.
     */
    noPath?: boolean
    /**
     * The measured straight-push failure: while the body still stands at
     * `stance`, a push aimed at `face` makes NO approach progress (the live body
     * slid along the frame column corner and the leg reported `unreachable` for
     * a face the mechanical continuation reaches). Every other push - including
     * the one into the verified hole floor - moves normally through the same
     * collision model.
     */
    stepOver?: { stance: Vec3Json; face: Vec3Json }
  },
): WalkModel {
  const bot = fixture.bot as unknown as { game: { dimension: string } }
  const controls: string[] = []
  const start = fixture.position.clone()
  let moved = 0
  let jumped = false
  let vanished = false
  const stanceKey = options.stepOver === undefined ? null : key(options.stepOver.stance)
  // the real actuator faces its target with `lookAt` and then pushes forward, so
  // the model walks the body along the LAST faced direction (one step per push)
  let heading = { x: 0, z: 0 }
  const openFaces = new Set<string>()
  for (const interior of [ENTER_CELL, { x: ENTER_CELL.x + 1, y: ENTER_CELL.y, z: ENTER_CELL.z }]) {
    for (const level of [interior.y - 1, interior.y, interior.y + 1]) {
      for (const dir of [
        { x: 1, z: 0 },
        { x: -1, z: 0 },
        { x: 0, z: 1 },
        { x: 0, z: -1 },
      ]) {
        openFaces.add(`${interior.x + dir.x},${level},${interior.z + dir.z}`)
      }
    }
  }
  const bodyCell = (): string =>
    `${Math.floor(fixture.position.x)},${Math.floor(fixture.position.y)},${Math.floor(fixture.position.z)}`
  const inside = (): boolean =>
    Math.hypot(fixture.position.x - (ENTER_CELL.x + 0.5), fixture.position.z - (ENTER_CELL.z + 0.5)) <= 0.5 &&
    Math.abs(fixture.position.y - ENTER_CELL.y) <= 1.05
  ;(fixture.bot as unknown as {
    pathfinder: {
      getPathTo: (movements: unknown, goal: { x: number; y: number; z: number }) => { status: string; path: Vec3Json[] }
    }
  }).pathfinder.getPathTo = (_movements, goal) => {
    if (options.noPath === true) return { status: 'noPath', path: [] }
    if (goal.x === ENTER_CELL.x && goal.y === ENTER_CELL.y && goal.z === ENTER_CELL.z) {
      return { status: 'noPath', path: [] }
    }
    const route = routeTo(fixture, { x: goal.x, y: goal.y, z: goal.z })
    return route.length > 0 ? { status: 'found', path: route } : { status: 'noPath', path: [] }
  }
  let lookTarget = { x: fixture.position.x, z: fixture.position.z }
  ;(fixture.bot as unknown as { lookAt: (point: { x: number; z: number }) => Promise<void> }).lookAt = async (point) => {
    const dx = point.x - fixture.position.x
    const dz = point.z - fixture.position.z
    const length = Math.hypot(dx, dz) || 1
    heading = { x: dx / length, z: dz / length }
    // `walkByControls` faces `position.offset(dx, 0, dz)`, i.e. the target centre:
    // the body decelerates into it instead of overrunning it
    lookTarget = { x: point.x, z: point.z }
  }
  ;(fixture.bot as unknown as { setControlState: (control: string, state: boolean) => void }).setControlState = (
    control,
    state,
  ) => {
    if (state) controls.push(control)
    if (!state) return
    if (control === 'jump') {
      jumped = true
      // ONE vanilla jump clears one block: the body rises a level when the space it
      // would occupy is free. This is the SAME single mechanic the direct walk's hop
      // onto the frame threshold and a PILLAR step's place-then-land cycle both use,
      // so the fixture models one physics rule instead of one special case per
      // caller. A wall stops it (`blocked`).
      //
      // The rise is the ENGINE's, not a teleport: `setControlState('jump')` arms
      // the vanilla impulse and the 50 ms physics loop integrates the arc (see
      // `makeBot`). A discrete `position.y += 1` left `velocity.y === 0`, which
      // is not a state the live engine can be in mid-jump and which the merged
      // pillar contract reads directly (`pillarPlaceCellCleared`).
      if (options.blocked !== true) {
        const cellName = (x: number, y: number, z: number): string | undefined =>
          fixture.grid.get(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`)?.boundingBox
        if (cellName(fixture.position.x, fixture.position.y + 1, fixture.position.z) !== 'block' &&
            cellName(fixture.position.x, fixture.position.y + 2, fixture.position.z) !== 'block') {
          fixture.launchJump()
        }
      }
      return
    }
    if (control !== 'forward') return
    if (
      stanceKey !== null &&
      options.stepOver !== undefined &&
      bodyCell() === stanceKey &&
      Math.floor(lookTarget.x) === options.stepOver.face.x &&
      Math.floor(lookTarget.z) === options.stepOver.face.z
    ) {
      // The measured straight push: no approach progress at all toward the face
      // from the original stance. The bounded continuation has to drop into the
      // verified hole floor first, and only then does the same face become
      // mechanically reachable (below).
      return
    }
    if (options.blocked === true) {
      // a wall: the push slides the body along it (no approach progress)
      fixture.position.x += 0.15
      moved += 0.15
      return
    }
    // Vanilla collision resolution: the push moves along the axes that are free,
    // so a body walking diagonally into a wall SLIDES along it (the measured live
    // body slid along the frame column). A step higher than the feet needs a jump;
    // anything more than one block is a wall.
    const remaining = Math.min(0.25, Math.hypot(lookTarget.x - fixture.position.x, lookTarget.z - fixture.position.z))
    const stepX = heading.x * remaining
    const stepZ = heading.z * remaining
    const blocked = (toX: number, toZ: number): boolean => {
      const landing = surfaceTopAt(fixture.grid, toX, toZ, fixture.position.y)
      if (landing === null) return false
      if (landing > fixture.position.y + 1) return true
      return landing > fixture.position.y + 0.05 && !jumped
    }
    let movedThisPush = false
    if (!blocked(fixture.position.x + stepX, fixture.position.z + stepZ)) {
      fixture.position.x += stepX
      fixture.position.z += stepZ
      movedThisPush = true
    } else if (Math.abs(stepX) > 0 && !blocked(fixture.position.x + stepX, fixture.position.z)) {
      fixture.position.x += stepX
      movedThisPush = true
    } else if (Math.abs(stepZ) > 0 && !blocked(fixture.position.x, fixture.position.z + stepZ)) {
      fixture.position.z += stepZ
      movedThisPush = true
    }
    if (!movedThisPush) return
    const landing = surfaceTopAt(fixture.grid, fixture.position.x, fixture.position.z, fixture.position.y)
    if (vanished === false && landing !== null && landing <= fixture.position.y + 1) fixture.position.y = landing
    jumped = false
    moved = Math.hypot(fixture.position.x - start.x, fixture.position.z - start.z)
    if (openFaces.has(bodyCell())) {
      fixture.movedToFace = true
      if (options.vanishFace === true && vanished === false) {
        // the postcondition disappears under the body: the support is gone, and
        // the body stays where it arrived so ONLY the re-observation decides
        fixture.position.y = ENTER_CELL.y
        fixture.grid.set(
          `${Math.floor(fixture.position.x)},${ENTER_CELL.y - 1},${Math.floor(fixture.position.z)}`,
          cell('air'),
        )
        vanished = true
      }
    }
    if (inside() && options.transfer) bot.game.dimension = NETHER
  }
  return { controls, travelled: () => moved }
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
  /**
   * The sensor's own bounded forward probes (`state.ts#buildBridgeProbes`). A
   * fixture that grounds a crossing must feed the REAL `probeBridgeDirection`
   * output, because the self-landing rule is grounded on the pocket's own
   * face-adjacency flood read, which only the sensor fills.
   */
  bridgeProbes?: BridgeProbe[],
  /** the LIVE structures of the world model (the portal frame + interior) */
  liveStructures: Vec3Json[] = [],
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
    ...(bridgeProbes === undefined ? {} : { bridgeProbes }),
    ...(liveStructures.length === 0
      ? {}
      : { liveStructureMembers: liveStructures.map((position) => ({ kind: 'nether_portal', position })) }),
  }
}

/** The gate's entry plan (lit interior + standable enter cell), from live world truth. */
function entryPlan(
  fixture: FixtureBot,
  self: Vec3Json = { x: ENTER_CELL.x, y: ENTER_CELL.y - 1, z: ENTER_CELL.z - 1 },
): PortalEntryPlan {
  const plan = planPortalEntry({
    site: SITE,
    self,
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
): Promise<{ status: string; failure: string | null; verified: boolean; detail: string; messages: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'portal-entry-route-'))
  const logger = new EventLogger(new JsonlWriter(join(dir, 'agent.jsonl')), false)
  const executor = new Executor(fixture.bot, logger, { ...defaultExecutorOptions, actuation: 'packet', portalEnterTimeoutMs: 400 })
  installLocomotion(executor, fixture, transfer, strictGate)
  configure?.(executor)
  const result = await fixtureClaim(executor, candidate).completion
  const messages = (await Bun.file(join(dir, 'agent.jsonl')).text())
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { message?: string }).message ?? '')
  return { status: result.status, failure: result.failure, verified: result.verified, detail: result.detail, messages }
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
// offering layer saw a clearable step, then the live block changed to bedrock
// before execution. The stale offer must fail with the live leg's refusal rather
// than claim a climb or return a generic path code.
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
  // The live target changed after the candidate was grounded. Stone could be
  // cleared by hand, so use bedrock to model a real mechanical refusal.
  fixture.grid.set(key(STONE_STEP.cut), cell('bedrock'))
  const result = await runEntry(fixture, candidate, false)
  const blockedLine = result.messages.find((line) => line.includes('PORTAL_ENTRY_ROUTE_BLOCKED'))
  check(
    '(d) a stale vertical offer whose live step became unbreakable reports that refusal, not a generic path code',
    result.status === 'failed' &&
      blockedLine !== undefined &&
      blockedLine.includes('reason=route_blocked') &&
      blockedLine.includes('detail=dig_refused:not_diggable') &&
      fixture.digs.length === 0,
    `status=${result.status} failure=${result.failure ?? 'none'} marker=[${blockedLine ?? 'none'}]`,
  )
}

// A missing harvest tool does not make a mechanically diggable clearance
// impossible. Route cuts do not need drops, so the same generic clearance rule
// may choose a slower hand break and still complete the entry.
{
  const grid = gateGrid()
  grid.set('26,64,8', cell('stone'))
  grid.set('27,64,8', cell('stone'))
  grid.set('26,65,8', cell('stone'))
  grid.set('26,66,8', cell('stone'))
  const fixture = makeBot({ x: 27, y: 65, z: 8 }, grid, false)
  const state = worldState({ x: 27.5, y: 65, z: 8.5 }, [STONE_STEP], {})
  const candidate = enterCandidate(fixture, state)
  const result = await runEntry(fixture, candidate, true)
  const climb = result.messages.find((line) => line.startsWith('PORTAL_ENTRY_CLIMB')) ?? ''
  check(
    '(d2) a stone route cut remains clearable by hand when no harvest pickaxe is carried',
    candidate.meta.vertical === 'staircase-up' &&
      result.status === 'done' &&
      result.verified === true &&
      fixture.digs.includes('stone@26,66,8') &&
      climb.includes('outcome=climbed'),
    `vertical=${String(candidate.meta.vertical)} status=${result.status} verified=${result.verified} digs=[${fixture.digs.join(',')}] climb=[${climb}]`,
  )
}

// ---------------------------------------------------------------------------
// (n) THE OPERATOR'S TRIAL - a floated gate the body cannot enter.
//
// LIVE WITNESS (run.jsonl 2026-09-22T15:47:37.705Z, generation gen-mucud8sw-i0mumn,
// source sha 3002d847): the operator floated the Nether portal in the air, its
// interior (27,67,9) five blocks above a body on the ground. The entry was offered
// and CHOSEN, and the route it was offered with carried a grounded climb:
//
//   ROUTE_PLACE_DECLARED actionId=ENTER:27,67,9 skill=ENTER_PORTAL blocks=cobblestone
//     source=fallbackPillarPlaceName carried=cobblestone
//   phase=vertical -> REUSE_TUNNEL at=-7,66,9      <-- the primary leg: a tunnel 34 blocks west
//   PATH_CALLBACK phase=failed target={"x":-7,"y":66,"z":9} outcome=stuck
//   MOVE_LEG_STOPPED reason=unsafe_landing from=26,62,8 to=26,62,9 block=air support=none
//   PORTAL_WALK_IN_REFUSED cell=27,67,9 from_d=0.93 reason=not_level     <-- dy = +5
//   PORTAL_APPROACH_REFUSED target=27,67,9 from_d=0.93 reason=no_open_face
//   SKILL_POLICY_BOUNDARY reason=no_in_envelope_remedy alternatives=[vertical:reuse(spent)]
//   PORTAL_ENTRY_ROUTE_BLOCKED reason=route_blocked entry=27,67,9 from_y=62 to_y=67 detail=unsafe_landing
//   ROUTE_SPENT ... routeSig=ENTER_PORTAL:reuse:unknown:62->67:dig=-7,66,9:step=none:pillar=0:fallback=pillar
//
// The pillar fallback EXISTED and was declared; it was never executed, because
// `runVerticalContract` reaches `fallbackVertical` only on the reuse leg's typed
// `refused` outcome and this leg STALLED instead. The walk-in then refused
// `not_level` (more than one block from the feet) and the entry route's only
// remaining leg was the HORIZONTAL step-aside, which cannot change Y at all.
//
// (n-1) proves the OFFER is byte-identical to that live route (same routeSig,
//       same declared fallback block) and that the fallback climbs to the
//       INTERIOR'S LEVEL, not merely one block up.
// (n-2) proves the composed EXECUTION: the primary leg runs and stalls, the
//       grounded fallback leg runs in the SAME commitment, the body reaches the
//       interior's level, and the ordinary verified walk-in then transfers.
// ---------------------------------------------------------------------------
const TUNNEL: Vec3Json = { x: -7, y: 66, z: 9 }

/** The operator's trial geometry: a pit under the gate, a remembered far tunnel. */
function trialFixture(): { fixture: FixtureBot; state: WorldState } {
  const grid = gateGrid()
  grid.set('26,64,8', cell('stone'))
  grid.set('27,64,8', cell('stone'))
  grid.set('26,65,8', cell('stone'))
  grid.set('26,66,8', cell('stone'))
  // the remembered tunnel entry is REAL (observably air + supported) - only its
  // approach is gone, which is exactly what makes the reuse leg STALL (the live
  // `PATH_CALLBACK ... outcome=stuck`) instead of refusing typed. `passableAt` is
  // fail-closed on an unknown cell, so the tunnel's two body rows are written as
  // explicit air.
  grid.set('-7,65,9', cell('stone'))
  grid.set('-7,66,9', cell('air'))
  grid.set('-7,67,9', cell('air'))
  const fixture = makeBot({ x: 27, y: 65, z: 8 }, grid, true)
  const state = worldState({ x: 27.5, y: 65, z: 8.5 }, [STONE_STEP], { diamond_pickaxe: 1, cobblestone: 32 })
  state.signals.lastTunnel = { ...TUNNEL }
  return { fixture, state }
}

{
  const { fixture, state } = trialFixture()
  const candidate = enterCandidate(fixture, state)
  const sig = routeSignature({ kind: candidate.kind, id: candidate.id, meta: candidate.meta })
  check(
    '(n-1) the trial OFFER is byte-identical to the live route: reuse primary at the far tunnel, pillar fallback to the INTERIOR level',
    candidate.meta.vertical === 'reuse' &&
      candidate.meta.tunnelX === TUNNEL.x &&
      candidate.meta.tunnelY === TUNNEL.y &&
      candidate.meta.tunnelZ === TUNNEL.z &&
      candidate.meta.fallbackVertical === 'staircase-up' &&
      sig === 'ENTER_PORTAL:reuse:unknown:65->67:dig=-7,66,9:step=none:pillar=0:fallback=staircase-up',
    `vertical=${String(candidate.meta.vertical)} tunnel=${String(candidate.meta.tunnelX)},${String(candidate.meta.tunnelY)},${String(candidate.meta.tunnelZ)} fallback=${String(candidate.meta.fallbackVertical)} routeSig=${sig}`,
  )
}

{
  // The same offer where the remembered tunnel has NO usable dig either: the
  // fallback is the own-column PILLAR, grounded to the interior's level, and its
  // declared place block is what the entry consumes (the live
  // `source=fallbackPillarPlaceName` shape).
  const grid = gateGrid()
  grid.set('26,64,8', cell('stone'))
  grid.set('27,64,8', cell('stone'))
  grid.set('26,65,8', cell('stone'))
  grid.set('-7,65,9', cell('stone'))
  grid.set('-7,66,9', cell('air'))
  grid.set('-7,67,9', cell('air'))
  const fixture = makeBot({ x: 27, y: 65, z: 8 }, grid, true)
  const state = worldState({ x: 27.5, y: 65, z: 8.5 }, [], { diamond_pickaxe: 1, cobblestone: 32 })
  state.signals.lastTunnel = { ...TUNNEL }
  const candidate = enterCandidate(fixture, state)
  const sig = routeSignature({ kind: candidate.kind, id: candidate.id, meta: candidate.meta })
  check(
    '(n-1) the live pillar fallback: grounded by the same planner to the interior level, with the block it consumes named',
    candidate.meta.vertical === 'reuse' &&
      candidate.meta.fallbackVertical === 'pillar' &&
      candidate.meta.fallbackPillarToY === ENTER_CELL.y &&
      candidate.meta.fallbackPillarSteps === 2 &&
      candidate.meta.fallbackPillarPlaceName === 'cobblestone' &&
      sig === 'ENTER_PORTAL:reuse:unknown:65->67:dig=-7,66,9:step=none:pillar=0:fallback=pillar',
    `fallback=${String(candidate.meta.fallbackVertical)} toY=${String(candidate.meta.fallbackPillarToY)} steps=${String(candidate.meta.fallbackPillarSteps)} place=${String(candidate.meta.fallbackPillarPlaceName)} routeSig=${sig}`,
  )
}

/** The trial's two live path facts: the far tunnel is unreachable, the interior is not a walk target. */
function trialPathFacts(fixture: FixtureBot, executor: Executor, alsoBlockEntry: boolean): void {
  const near = (executor as unknown as { pathToNear: (target: Vec3Json) => Promise<void> }).pathToNear
  ;(executor as unknown as { pathToNear: (target: Vec3Json) => Promise<void> }).pathToNear = async (
    target: Vec3Json,
  ) => {
    // The remembered tunnel is 33 blocks west: its approach path is GONE - the live
    // `PATH_CALLBACK phase=failed target={"x":-7,"y":66,"z":9} outcome=stuck`.
    if (key(target) === key(TUNNEL)) throw new ExecutorError('path_stuck', 'pathfinder -> stuck')
    await near(target)
  }
  if (!alsoBlockEntry) return
  // The interior cell is non-solid, so the stock actuator refuses its plan node
  // outright (`path_stuck` with the body moved zero blocks, executor.ts:8228).
  const toCell = (executor as unknown as { pathTo: (target: Vec3Json) => Promise<void> }).pathTo
  ;(executor as unknown as { pathTo: (target: Vec3Json) => Promise<void> }).pathTo = async (
    target: Vec3Json,
  ) => {
    if (key(target) === key(ENTER_CELL)) throw new ExecutorError('path_stuck', 'pathfinder GoalBlock -> stuck')
    await toCell(target)
  }
}

{
  // (n-2a) the composed climb itself: the primary leg stalls, the grounded
  // fallback leg runs IN THE SAME COMMITMENT, and the body reaches the interior's
  // LEVEL. The result is a bounded climb chunk - never a claimed entry.
  const { fixture, state } = trialFixture()
  const candidate = enterCandidate(fixture, state)
  const result = await runEntry(fixture, candidate, true, false, (executor) =>
    trialPathFacts(fixture, executor, true),
  )
  const legs = result.messages.filter((line) => line.startsWith(PORTAL_ENTRY_CLIMB))
  const primary = legs.find((line) => line.includes('leg=primary')) ?? ''
  const fallback = legs.find((line) => line.includes('leg=fallback')) ?? ''
  check(
    '(n-2a) the composed route: the primary leg stalls, the grounded fallback climbs in the SAME commitment to the interior level',
    primary.includes('climb=reuse') &&
      primary.includes('outcome=failed') &&
      primary.includes('detail=path_stuck') &&
      fallback.includes('climb=staircase-up') &&
      fallback.includes('plan=kind=staircase-up,to_y=67') &&
      fallback.includes('outcome=climbed') &&
      fixture.digs.includes('stone@26,66,8') &&
      fixture.position.y > 65 &&
      ENTER_CELL.y - Math.floor(fixture.position.y) <= PORTAL_WALK_IN_LEVEL_TOLERANCE &&
      ENTER_CELL.y - Math.floor(fixture.position.y) > 0 &&
      result.messages.every((line) => !line.startsWith(PORTAL_ENTRY_CLIMB_REFUSED)) &&
      result.messages.every((line) => !line.startsWith('PORTAL_ENTERED')) &&
      result.verified === false,
    `legs=${legs.length} bodyY=${fixture.position.y} dyLeft=${ENTER_CELL.y - Math.floor(fixture.position.y)} digs=[${fixture.digs.join(',')}] status=${result.status} verified=${result.verified} primary=[${primary}] fallback=[${fallback}]`,
  )
}

{
  // (n-2b) with the climb done, the ordinary route owns the last block at the
  // interior's level - the same generic mover every other MOVE uses - and the
  // entry is VERIFIED by the dimension change, not by the body motion.
  const { fixture, state } = trialFixture()
  const candidate = enterCandidate(fixture, state)
  const result = await runEntry(fixture, candidate, true, false, (executor) =>
    trialPathFacts(fixture, executor, false),
  )
  const legs = result.messages.filter((line) => line.startsWith(PORTAL_ENTRY_CLIMB))
  const entered = result.messages.find((line) => line.startsWith('PORTAL_ENTERED')) ?? ''
  check(
    '(n-2b) the composed route ends in the VERIFIED entry: dimension change observed at the interior cell',
    result.status === 'done' &&
      result.verified === true &&
      result.failure === null &&
      legs.length === 2 &&
      entered.includes(`pos=${ENTER_CELL.x},${ENTER_CELL.y},${ENTER_CELL.z}`) &&
      Math.floor(fixture.position.y) === ENTER_CELL.y,
    `status=${result.status} verified=${result.verified} legs=${legs.length} bodyY=${fixture.position.y} entered=[${entered}]`,
  )
}

// ---------------------------------------------------------------------------
// (o) BYTE-IDENTICAL for a LEVEL gate and for a ONE-BLOCK step-up.
//
// Both are the cases the composition must not touch: a level gate needs no climb
// at all, and a one-block rise is the frame threshold the bounded walk-in already
// steps onto. The proof is that the candidate carries NO fallback key and that no
// `PORTAL_ENTRY_CLIMB*` line and no `climb=` field is ever emitted.
// ---------------------------------------------------------------------------
{
  const grid = gateGrid()
  const fixture = makeBot({ x: 25, y: 67, z: 10 }, grid, true)
  // a same-level open face beside the interior, and the stand cell
  grid.set('25,66,10', cell('stone'))
  const state = worldState({ x: 25.5, y: 67, z: 10.5 }, [], { diamond_pickaxe: 1, cobblestone: 32 })
  const candidate = enterCandidate(fixture, state)
  const result = await runEntry(fixture, candidate, true)
  check(
    '(o) a LEVEL gate is untouched: vertical=none, no fallback key, no crossing key, no climb marker, the walk-in transfers',
    candidate.meta.vertical === 'none' &&
      candidate.meta.fallbackVertical === undefined &&
      candidate.meta[BRIDGE_META] === undefined &&
      candidate.meta[BRIDGE_PLACE_META] === undefined &&
      result.status === 'done' &&
      result.verified === true &&
      !result.messages.some((line) => line.startsWith(PORTAL_ENTRY_CLIMB)) &&
      !result.messages.some((line) => line.includes('climb=')),
    `vertical=${String(candidate.meta.vertical)} fallback=${String(candidate.meta.fallbackVertical)} bridge=${String(candidate.meta[BRIDGE_META])} status=${result.status} verified=${result.verified}`,
  )
}

{
  // the existing one-block step-up shape (case (b)): the walk-in's own hop owns it
  const grid = gateGrid()
  grid.set('26,65,8', cell('stone'))
  grid.set('26,66,8', cell('air'))
  const fixture = makeBot({ x: 26, y: 66, z: 8 }, grid, true)
  const state = worldState({ x: 26.5, y: 66, z: 8.5 }, [], { diamond_pickaxe: 1, cobblestone: 32 })
  const candidate = enterCandidate(fixture, state)
  const result = await runEntry(fixture, candidate, true)
  check(
    '(o) a ONE-BLOCK step-up is untouched: vertical=pillar steps=1 with NO fallback/crossing key, no climb marker, transfer',
    candidate.meta.vertical === 'pillar' &&
      candidate.meta.pillarSteps === 1 &&
      candidate.meta.pillarToY === ENTER_CELL.y &&
      candidate.meta.fallbackVertical === undefined &&
      candidate.meta[BRIDGE_META] === undefined &&
      result.status === 'done' &&
      result.verified === true &&
      !result.messages.some((line) => line.startsWith(PORTAL_ENTRY_CLIMB)) &&
      !result.messages.some((line) => line.includes('climb=')),
    `vertical=${String(candidate.meta.vertical)} steps=${String(candidate.meta.pillarSteps)} fallback=${String(candidate.meta.fallbackVertical)} bridge=${String(candidate.meta[BRIDGE_META])} status=${result.status} verified=${result.verified}`,
  )
}

// ---------------------------------------------------------------------------
// (p) NO GROUNDED CLIMB: the typed refusal names the interior's height, the
// missing climb and why the only sensor step is mechanically unbreakable.
// ---------------------------------------------------------------------------
{
  const grid = gateGrid()
  grid.set('26,64,8', cell('stone'))
  grid.set('27,64,8', cell('stone'))
  grid.set('26,65,8', cell('stone'))
  grid.set('26,66,8', cell('stone'))
  const fixture = makeBot({ x: 27, y: 65, z: 8 }, grid, true)
  // Bedrock cannot be cleared even with a harvest tool; with no placeable block,
  // the otherwise safe-shaped step cannot realize the climb.
  fixture.grid.set(key(STONE_STEP.cut), cell('bedrock'))
  const bedrockStep: StepCut = { ...STONE_STEP, name: 'bedrock' }
  const state = worldState({ x: 27.5, y: 65, z: 8.5 }, [bedrockStep], {})
  const candidate = enterCandidate(fixture, state)
  const result = await runEntry(fixture, candidate, true, false, stubStuckPath(fixture))
  const refused = result.messages.find((line) => line.startsWith(PORTAL_ENTRY_CLIMB_REFUSED)) ?? ''
  const blocked = result.messages.find((line) => line.startsWith('PORTAL_ENTRY_ROUTE_BLOCKED')) ?? ''
  check(
    '(p) no grounded climb: the typed refusal names dy, climb=none, fallback=none and the offering reason',
    candidate.meta.vertical === 'none' &&
      refused.includes(`cell=${ENTER_CELL.x},${ENTER_CELL.y},${ENTER_CELL.z}`) &&
      refused.includes('from_y=65') &&
      refused.includes('to_y=67') &&
      refused.includes('dy=2') &&
      refused.includes('climb=none') &&
      refused.includes('fallback=none') &&
      refused.includes('reason=no_grounded_climb') &&
      refused.includes('detail=no_placeable') &&
      result.status === 'failed' &&
      blocked.includes('detail=no_placeable') &&
      !result.messages.some((line) => line.startsWith(`${PORTAL_WALK_IN} `)),
    `vertical=${String(candidate.meta.vertical)} status=${result.status} refused=[${refused}] blocked=[${blocked}]`,
  )
}

{
  // Grounded climbs EXIST and RAN and none raised the body: the refusal names the
  // executed legs' own cause instead of a bare "no route".
  const grid = gateGrid()
  grid.set('26,64,8', cell('stone'))
  grid.set('27,64,8', cell('stone'))
  grid.set('26,65,8', cell('stone'))
  grid.set('26,66,8', cell('stone'))
  grid.set('-7,65,9', cell('stone'))
  grid.set('-7,66,9', cell('air'))
  grid.set('-7,67,9', cell('air'))
  const fixture = makeBot({ x: 27, y: 65, z: 8 }, grid, true)
  const state = worldState({ x: 27.5, y: 65, z: 8.5 }, [], { diamond_pickaxe: 1, cobblestone: 32 })
  state.signals.lastTunnel = { ...TUNNEL }
  const candidate = enterCandidate(fixture, state)
  // both legs fail: the tunnel approach is gone AND the pillar's block is gone
  const result = await runEntry(fixture, candidate, true, false, (executor) => {
    fixture.inventoryItems.length = 0
    ;(executor as unknown as { pathToNear: (target: Vec3Json) => Promise<void> }).pathToNear = async (
      target: Vec3Json,
    ) => {
      if (key(target) === key(TUNNEL)) throw new ExecutorError('path_stuck', 'pathfinder -> stuck')
    }
  })
  const refused = result.messages.find((line) => line.startsWith(PORTAL_ENTRY_CLIMB_REFUSED)) ?? ''
  const blocked = result.messages.find((line) => line.startsWith('PORTAL_ENTRY_ROUTE_BLOCKED')) ?? ''
  check(
    '(p) a climb that ran and did not rise is typed: climb_no_rise with the executed legs named in climb=',
    refused.includes('climb=reuse') &&
      refused.includes('fallback=pillar') &&
      refused.includes('reason=climb_no_rise') &&
      blocked.includes('climb=primary=reuse:failed:path_stuck,fallback=pillar:no_rise:no_place_item') &&
      result.status === 'failed',
    `status=${result.status} refused=[${refused}] blocked=[${blocked}]`,
  )
}

{
  // (p) THE PILLAR SAFETY RULE STILL APPLIES to the composed fallback: a fluid
  // that could pour onto the body refuses the pillar leg in the executor
  // (`pillarColumnUnsafe`), the body does not rise, and the entry reports the
  // typed `unsafe_column` rather than a silent no-op. The sensor-side plan is
  // still OFFERED (its `state.blocks` carry no hazard), which is exactly the live
  // order: the offering layer grounds the climb, the executor owns the live veto.
  const grid = gateGrid()
  grid.set('26,64,8', cell('stone'))
  grid.set('27,64,8', cell('stone'))
  grid.set('26,65,8', cell('stone'))
  grid.set('-7,65,9', cell('stone'))
  grid.set('-7,66,9', cell('air'))
  grid.set('-7,67,9', cell('air'))
  // water in the body's own column, two above the feet (dy = +2)
  grid.set('27,67,8', cell('water'))
  const fixture = makeBot({ x: 27, y: 65, z: 8 }, grid, true)
  // the body really HOLDS the pillar block (the live bot carried 205 cobblestone),
  // so the refusal is the live-column veto and not a missing item
  fixture.inventoryItems.push({
    name: 'cobblestone',
    type: registry.itemsByName.cobblestone.id as number,
    count: 32,
  })
  const state = worldState({ x: 27.5, y: 65, z: 8.5 }, [], { diamond_pickaxe: 1, cobblestone: 32 })
  state.signals.lastTunnel = { ...TUNNEL }
  const candidate = enterCandidate(fixture, state)
  const startY = fixture.position.y
  const result = await runEntry(fixture, candidate, true, false, (executor) =>
    trialPathFacts(fixture, executor, true),
  )
  const refused = result.messages.find((line) => line.startsWith(PORTAL_ENTRY_CLIMB_REFUSED)) ?? ''
  const fallback = result.messages.filter((line) => line.startsWith(PORTAL_ENTRY_CLIMB)).find((line) => line.includes('leg=fallback')) ?? ''
  check(
    '(p) a fluid that could pour onto the body refuses the composed pillar leg typed (unsafe_column), with zero rise',
    candidate.meta.fallbackVertical === 'pillar' &&
      fallback.includes('climb=pillar') &&
      fallback.includes('outcome=no_rise') &&
      fallback.includes('detail=unsafe_column') &&
      refused.includes('reason=climb_no_rise') &&
      refused.includes('detail=unsafe_column') &&
      result.status === 'failed' &&
      fixture.position.y === startY &&
      !result.messages.some((line) => line.startsWith('PORTAL_ENTERED')),
    `status=${result.status} feetY=${fixture.position.y} fallback=[${fallback}] refused=[${refused}]`,
  )
}

// ---------------------------------------------------------------------------
// (q) BOUNDS AND PROTECTION.
//
// (q-1) the portal PLANE is never mined: the composed climb's own-column fallback
//       is a PLACE route (`pillar`), and no dig of a frame or interior cell ever
//       appears - the frame is the protected structure the entry may not open.
// (q-2) the cross-dimension refusal is unchanged: only the explicit ENTER_PORTAL
//       candidate may cross, so the entry stays the one exempt semantic disengage
//       and no mechanical realisation of this route gains that authority.
// ---------------------------------------------------------------------------
{
  const { fixture, state } = trialFixture()
  const candidate = enterCandidate(fixture, state)
  const result = await runEntry(fixture, candidate, true, false, (executor) => {
    ;(executor as unknown as { pathToNear: (target: Vec3Json) => Promise<void> }).pathToNear = async (
      target: Vec3Json,
    ) => {
      if (key(target) === key(TUNNEL)) throw new ExecutorError('path_stuck', 'pathfinder -> stuck')
    }
  })
  const protectedCells = new Set([...LAYOUT.frame, ...LAYOUT.interior].map((c) => key(c)))
  const mined = fixture.digs
    .map((entry) => entry.slice(entry.indexOf('@') + 1))
    .filter((cellKey) => protectedCells.has(cellKey))
  check(
    '(q-1) the portal plane is never mined: the composed climb digs the terrain step only, never a frame or interior cell',
    result.status === 'done' &&
      mined.length === 0 &&
      fixture.digs.includes('stone@26,66,8') &&
      !result.messages.some((line) => line.includes('protected:portal_structure') && line.startsWith('LOCAL_CLEAR')),
    `digs=[${fixture.digs.join(',')}] minedPortalPlane=[${mined.join(',')}]`,
  )
}

{
  // The dimension-transfer guard is the policy layer's, and this lane does not
  // touch it: a non-ENTER_PORTAL candidate at the SAME interior cell is denied.
  const fixture = trialFixture().fixture
  const likeEntry: Candidate = {
    id: 'STEP:p26_67_9',
    kind: 'STEP',
    label: 'step into the portal interior as an ordinary locomotion step',
    targetName: NETHER_PORTAL,
    target: { x: ENTER_CELL.x, y: ENTER_CELL.y, z: ENTER_CELL.z },
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 9 },
  }
  const state = worldState({ x: 26.5, y: 66, z: 9.5 }, [], { diamond_pickaxe: 1, cobblestone: 32 })
  const verdict = guardCandidate(likeEntry, state, {
    phase: 'decision',
    candidateIds: new Set([likeEntry.id, 'ENTER:26,67,9']),
    inFlight: null,
    reach: 4.5,
    maxCandidateAgeTicks: 200,
    canComputePath: () => true,
  })
  check(
    '(q-2) the cross-dimension refusal still covers every mechanical realisation: an ordinary STEP into the interior is denied',
    verdict.ok === false && String(verdict.code).length > 0,
    `ok=${verdict.ok} code=${verdict.ok ? 'none' : String(verdict.code)} reason=${verdict.ok ? 'none' : verdict.reason}`,
  )
}

// ---------------------------------------------------------------------------
// (r) NO CODE RANKING: the composed route is OFFERED alongside the ordinary
// alternatives in discovery order, and the executor runs the legs in the order
// the candidate declared them - it never compares two climbs to pick one.
// ---------------------------------------------------------------------------
{
  const { fixture, state } = trialFixture()
  // a spent route from this stand cell makes the candidate layer enumerate the
  // approach alternatives too; the ENTER candidate stays FIRST, unranked.
  const options: CandidateOptions = { ...defaultCandidateOptions, portalEntry: entryPlan(fixture) }
  const offered = entryCandidates(state, options)
  const ids = offered.candidates.map((candidate) => candidate.id)
  const grounded = generateGroundedCandidates(state, options)
  check(
    '(r) the entry is offered first, together with its alternatives, in discovery order',
    ids[0] === 'ENTER:26,67,9' &&
      grounded.candidates.some((candidate) => candidate.id === 'ENTER:26,67,9') &&
      offered.candidates.filter((candidate) => candidate.kind === 'ENTER_PORTAL').length === 1,
    `offered=[${ids.join(',')}] grounded=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
  )
}

{
  // The legs run in the DECLARED order (primary then the grounded fallback), and
  // the order is the candidate's own, not a comparison of the two plans.
  const { fixture, state } = trialFixture()
  const candidate = enterCandidate(fixture, state)
  const result = await runEntry(fixture, candidate, true, false, (executor) => {
    ;(executor as unknown as { pathToNear: (target: Vec3Json) => Promise<void> }).pathToNear = async (
      target: Vec3Json,
    ) => {
      if (key(target) === key(TUNNEL)) throw new ExecutorError('path_stuck', 'pathfinder -> stuck')
    }
  })
  const climbLines = result.messages.filter((line) => line.startsWith(PORTAL_ENTRY_CLIMB))
  const order = climbLines.map((line) => (/leg=(\w+)/.exec(line)?.[1] ?? '?'))
  check(
    '(r) the composed legs run in declared order (primary, then the grounded fallback) - no code ranking',
    order.length === 2 && order[0] === 'primary' && order[1] === 'fallback',
    `order=[${order.join(',')}] lines=${climbLines.length}`,
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

// ---------------------------------------------------------------------------
// (j) THE MEASURED FREEZE (run-muc9k936-1f3vb, main 4794ef7): the body stood
// 1.9 blocks from a LIT gate at its own floor level, and the interior cell is
// NON-SOLID, so the stock actuator refused to execute the plan node at all:
//
//   ACTION ... phase=pathing pos=25.7,66.8,11.0
//   PATH_CALLBACK phase=failed actionId=ENTER:26,67,9 outcome=stuck   (x2)
//   ROUTE_STAGE_FAILED ... stage=path failure=path_stuck
//   stand={"x":25.7,"y":66.796...,"z":10.947...}
//
// The offline replay of the real mineflayer-pathfinder planner/physics on this
// exact geometry (see `walkIntoPortalEntry`) measured why: the interior cell IS
// a valid A* node and is `safe`, but canStraightLine/canSprintJump/canWalkJump
// all refuse it, so index.js zeroes `forward` and the 3.5s futility watchdog
// reports `path_reset reason=stuck`. The bounded direct walk (face the cell
// CENTRE, hold forward, hop pre-emptively) enters the same geometry in 21 ticks.
//
// Fixtures: (a) the walk transfers; (b1) a walk that cannot get in ends inside
// its budget and keeps the existing route-stage failure; (b2) a body that IS in
// the cell without a server transfer is never a fake success; (c) a body 20+
// blocks away never triggers the walk; (d) an observed-not-lit interior still
// refuses BEFORE any movement; (e) a hazard on the approach refuses typed.
// ---------------------------------------------------------------------------
function measuredFixture(): FixtureBot {
  return makeBot({ x: MEASURED_STAND.x - 0.5, y: MEASURED_STAND.y, z: MEASURED_STAND.z - 0.5 }, measuredApproachGrid(), true)
}

function measuredCandidate(fixture: FixtureBot, stand: Vec3Json = MEASURED_STAND): Candidate {
  const state = worldState(stand, [], { diamond_pickaxe: 1, cobblestone: 32 })
  const base = enterCandidate(fixture, state)
  // the path stage is the measured one (stuck); the vertical leg is not this
  // fixture's subject, so it carries no route of its own
  return { ...base, meta: { ...base.meta, vertical: 'none' } }
}

function distanceFrom(marker: string, name: string): number {
  const found = new RegExp(`${name}=([0-9.]+)`).exec(marker)
  return found === null ? Number.NaN : Number(found[1])
}

{
  // (a) the measured shape: pathTo stuck -> the direct walk enters and transfers
  const fixture = measuredFixture()
  const candidate = measuredCandidate(fixture)
  const model = installWalkModel(fixture, { transfer: true })
  const result = await runEntry(fixture, candidate, false, true, stubStuckPath(fixture))
  const marker = result.messages.find((line) => line.startsWith(`${PORTAL_WALK_IN} `)) ?? ''
  const enterCalls = fixture.pathCalls.filter((target) => key(target) === key(ENTER_CELL))
  check(
    '(j-a) measured shape: after the path stage sticks, the bounded direct walk enters the lit interior and the transfer is observed',
    result.status === 'done' &&
      result.verified === true &&
      result.failure === null &&
      marker.includes(`cell=${ENTER_CELL.x},${ENTER_CELL.y},${ENTER_CELL.z}`) &&
      marker.includes('transferred=true') &&
      distanceFrom(marker, 'to_d') <= 0.5 &&
      distanceFrom(marker, 'to_d') < distanceFrom(marker, 'from_d') &&
      result.messages.some((line) => line.startsWith('PORTAL_ENTERED')) &&
      enterCalls.length === 1 &&
      model.controls.includes('forward') &&
      model.controls.includes('jump') &&
      result.messages.some((line) => line.startsWith(SKILL_START)) &&
      result.messages.some(
        (line) => line.startsWith(REFLEX) && line.includes('action=walk_into_portal_interior'),
      ) &&
      result.messages.some((line) => line.startsWith(SKILL_END) && line.includes('execution=entered')),
    `status=${result.status} verified=${result.verified} failure=${result.failure ?? 'none'} enterCalls=${enterCalls.length} marker=[${marker}] travelled=${model.travelled().toFixed(2)} controls=[${model.controls.join(',')}]`,
  )
}

{
  // (b1) a wall stops the walk: bounded, transferred=false, existing route failure
  const fixture = measuredFixture()
  const candidate = measuredCandidate(fixture)
  const model = installWalkModel(fixture, { transfer: false, blocked: true })
  const startedAt = Date.now()
  const result = await runEntry(fixture, candidate, false, true, stubStuckPath(fixture))
  const elapsedMs = Date.now() - startedAt
  const marker = result.messages.find((line) => line.startsWith(`${PORTAL_WALK_IN} `)) ?? ''
  const blockedLine = result.messages.find((line) => line.includes('PORTAL_ENTRY_ROUTE_BLOCKED'))
  check(
    '(j-b1) a direct walk making NO approach progress ends on its own progress bound (not the hard budget) and keeps the route-stage failure',
    result.status === 'failed' &&
      result.failure === 'path_stuck' &&
      marker.includes('transferred=false') &&
      distanceFrom(marker, 'to_d') >= distanceFrom(marker, 'from_d') - 0.35 &&
      model.travelled() > 0.3 &&
      elapsedMs < 2000 &&
      blockedLine !== undefined &&
      !result.messages.some((line) => line.startsWith('PORTAL_ENTERED')),
    `status=${result.status} failure=${result.failure ?? 'none'} elapsed=${elapsedMs}ms pushed=${model.travelled().toFixed(2)} marker=[${marker}] blocked=[${blockedLine ?? 'none'}]`,
  )
}

{
  // (b2) the body IS in the cell but the server never transfers: honest failure
  const fixture = measuredFixture()
  const candidate = measuredCandidate(fixture)
  const model = installWalkModel(fixture, { transfer: false })
  const startedAt = Date.now()
  const result = await runEntry(fixture, candidate, false, true, stubStuckPath(fixture))
  const elapsedMs = Date.now() - startedAt
  const marker = result.messages.find((line) => line.startsWith(`${PORTAL_WALK_IN} `)) ?? ''
  check(
    '(j-b2) a body inside the interior with no dimension change is NOT a fake success (bounded verify_failed)',
    result.status === 'failed' &&
      result.failure === 'verify_failed' &&
      result.verified === false &&
      marker.includes('transferred=false') &&
      distanceFrom(marker, 'to_d') <= 0.5 &&
      elapsedMs < 8000 &&
      !result.messages.some((line) => line.startsWith('PORTAL_ENTERED')),
    `status=${result.status} failure=${result.failure ?? 'none'} verified=${result.verified} elapsed=${elapsedMs}ms travelled=${model.travelled().toFixed(2)} marker=[${marker}]`,
  )
}

{
  // (c) a body 20+ blocks away: the direct walk is not attempted at all
  const grid = measuredApproachGrid()
  const fixture = makeBot({ x: 45, y: 66, z: 30 }, grid, true)
  const state = worldState({ x: 45.5, y: 66, z: 30.5 }, [], { diamond_pickaxe: 1, cobblestone: 32 })
  const base = enterCandidate(fixture, state)
  const candidate: Candidate = { ...base, meta: { ...base.meta, vertical: 'none' } }
  const model = installWalkModel(fixture, { transfer: true })
  const result = await runEntry(fixture, candidate, false, true, stubStuckPath(fixture))
  const enterCalls = fixture.pathCalls.filter((target) => key(target) === key(ENTER_CELL))
  const away = Math.hypot(45.5 - (ENTER_CELL.x + 0.5), 30.5 - (ENTER_CELL.z + 0.5))
  check(
    '(j-c) a body 20+ blocks away never triggers the direct walk: one generic path call, no portal-walk marker, zero movement',
    away > 20 &&
      result.status === 'failed' &&
      result.failure === 'path_stuck' &&
      enterCalls.length === 1 &&
      model.controls.length === 0 &&
      !result.messages.some(
        (line) => line.startsWith(`${PORTAL_WALK_IN} `) || line.startsWith(PORTAL_WALK_IN_REFUSED),
      ),
    `away=${away.toFixed(1)} status=${result.status} failure=${result.failure ?? 'none'} enterCalls=${enterCalls.length} controls=[${model.controls.join(',')}]`,
  )
}

{
  // (d) the portal went out between offer and entry: the lit precondition still
  // refuses before ANY movement (the direct walk never runs)
  const fixture = measuredFixture()
  const candidate = measuredCandidate(fixture)
  // observed (not remembered) interior: the frame is there, the portal is not
  fixture.grid.set(`${ENTER_CELL.x},${ENTER_CELL.y},${ENTER_CELL.z}`, cell('air'))
  const model = installWalkModel(fixture, { transfer: true })
  const result = await runEntry(fixture, candidate, false, true, stubStuckPath(fixture))
  check(
    '(j-d) an interior observed as NOT a portal refuses before any movement (no path call, no control state, no walk)',
    result.status === 'failed' &&
      result.failure === 'place_error' &&
      result.detail === 'PRECONDITION_MISSING portal=lit' &&
      fixture.pathCalls.length === 0 &&
      model.controls.length === 0 &&
      !result.messages.some(
        (line) => line.startsWith(`${PORTAL_WALK_IN} `) || line.startsWith(PORTAL_WALK_IN_REFUSED),
      ),
    `status=${result.status} failure=${result.failure ?? 'none'} detail=[${result.detail}] pathCalls=${fixture.pathCalls.length} controls=[${model.controls.join(',')}]`,
  )
}

{
  // (e) lava on the approach: typed refusal, zero movement
  const fixture = measuredFixture()
  const candidate = measuredCandidate(fixture)
  // a hazard cell appears on the straight approach AFTER the offer
  fixture.grid.set('26,66,10', { name: 'lava', boundingBox: 'empty' })
  const model = installWalkModel(fixture, { transfer: true })
  const result = await runEntry(fixture, candidate, false, true, stubStuckPath(fixture))
  const refused = result.messages.find((line) => line.startsWith(PORTAL_WALK_IN_REFUSED)) ?? ''
  check(
    '(e) a hazard between the body and the interior cell refuses the direct walk typed, before any movement',
    result.status === 'failed' &&
      result.failure === 'path_stuck' &&
      refused.includes(`cell=${ENTER_CELL.x},${ENTER_CELL.y},${ENTER_CELL.z}`) &&
      refused.includes('reason=hazard_between') &&
      model.controls.length === 0 &&
      !result.messages.some((line) => line.startsWith(`${PORTAL_WALK_IN} `)),
    `status=${result.status} failure=${result.failure ?? 'none'} controls=[${model.controls.join(',')}] marker=[${refused}]`,
  )
}

{
  // the run log is the only place a live reader can see this capability: both
  // marker shapes must be mirrored host events, not prose the sink drops
  check(
    '(j-mirror) both direct-walk markers are mirrored host events (live-visible)',
    MIRRORED_MARKERS.has(PORTAL_WALK_IN) && MIRRORED_MARKERS.has(PORTAL_WALK_IN_REFUSED),
    `PORTAL_WALK_IN=${MIRRORED_MARKERS.has(PORTAL_WALK_IN)} PORTAL_WALK_IN_REFUSED=${MIRRORED_MARKERS.has(PORTAL_WALK_IN_REFUSED)}`,
  )
}

// ---------------------------------------------------------------------------
// (k) THE MEASURED OCCLUDED SHAPE (run-mucaq28q-1ftq1, main 4c5645b): the body
// stood WEST of the left frame column at 24.7,67,9.7 and the entry cell
// (26,67,9) was 1.8 blocks EAST behind the obsidian column at (25,67,9) - a
// 2-high face. The straight walk can never get in, `MOVE:p26_67_9` (the
// interior cell itself) fails too, and the offer collapsed to WAIT/ESCALATE:
// the operator's "1ブロック避ければ通れるのに避けない" (it would get through if it
// stepped one block aside).
//
// The measured fix shape: the portal's OPEN faces are z=10 / z=8 (the frame ring
// is 25 and 28 in x), so the grounded next step is an ordinary MOVE onto
// (25,67,10)/(26,67,10) - a cell whose neighbour toward the interior is not a
// frame block - and the walk in finishes from there on the next decision.
// ---------------------------------------------------------------------------
function occludedFixture(): FixtureBot {
  const grid = measuredApproachGrid()
  // the live body level: the ground at the gate's own y (66) south of the frame
  for (const x of [24, 25, 26, 27, 28]) for (const z of [10, 11, 12]) grid.set(`${x},66,${z}`, cell('stone'))
  grid.set('25,67,10', cell('air'))
  grid.set('26,67,10', cell('air'))
  grid.set('25,68,10', cell('air'))
  grid.set('26,68,10', cell('air'))
  grid.set('25,66,9', cell('obsidian'))
  grid.set('25,68,9', cell('obsidian'))
  grid.set('25,69,9', cell('obsidian'))
  grid.set('24,66,9', cell('stone'))
  grid.set('24,66,10', cell('stone'))
  // the pocket: ONE standable open face (26,67,10). (27,67,10) is walled off and
  // the z=8 side has no floor, so the step-aside is mechanically UNIQUE and code
  // may finish the selected entry's prerequisite (#436).
  grid.set('27,67,10', cell('obsidian'))
  grid.set('27,68,10', cell('obsidian'))
  // complete the world model: an unset cell reads as `null` (unknown = blocked)
  // to the headroom/standability probes, which would veto honest geometry
  for (const x of [23, 24, 25, 26, 27, 28])
    for (const z of [8, 9, 10, 11, 12])
      for (const y of [67, 68, 69, 70]) {
        const k = `${x},${y},${z}`
        if (!grid.has(k)) grid.set(k, cell('air'))
      }
  return makeBot({ x: 24.2, y: 67, z: 9.2 }, grid, true)
}

const OCCLUDED_STAND: Vec3Json = { x: 24.7, y: 67, z: 9.7 }

{
  // (k-1) the offer contains the intermediate open-face leg, not only the entry
  const fixture = occludedFixture()
  // the sensor's terrain truth: the body's cell, the interior cell (a portal
  // block over obsidian reads standable to the generic rule) and the two open
  // faces on the gate's south side
  const state = worldState(OCCLUDED_STAND, [], { diamond_pickaxe: 1, cobblestone: 32 }, [], [
    OCCLUDED_STAND,
    ENTER_CELL,
    { x: 25, y: ENTER_CELL.y, z: 10 },
    { x: 26, y: ENTER_CELL.y, z: 10 },
    { x: 27, y: ENTER_CELL.y, z: 10 },
  ])
  const options: CandidateOptions = { ...defaultCandidateOptions, portalEntry: entryPlan(fixture) }
  const offered = entryCandidates(state, options)
  const entry = offered.candidates.find((candidate) => candidate.kind === 'ENTER_PORTAL')
  const legs = offered.candidates.filter((candidate) => candidate.meta.approachLeg === 'portal_open_face')
  check(
    '(k-1) the occluded shape offers the entry AND EVERY open face as a policy-visible MOVE leg (never one hard-coded)',
    entry !== undefined &&
      entry.id === `ENTER:${ENTER_CELL.x},${ENTER_CELL.y},${ENTER_CELL.z}` &&
      legs.length >= 2 &&
      legs.every((leg) => leg.kind === 'MOVE' && leg.target?.y === ENTER_CELL.y && leg.target?.z === 10) &&
      legs.some((leg) => leg.target?.x === 26) &&
      legs.some((leg) => leg.target?.x === 27) &&
      legs.every(
        (leg) => leg.meta.approachTarget === `${ENTER_CELL.x},${ENTER_CELL.y},${ENTER_CELL.z}`,
      ) &&
      !legs.some((leg) => leg.target?.x === 25),
    `offered=[${offered.candidates.map((candidate) => `${candidate.id}:${String(candidate.meta.approachLeg ?? '-')}`).join(',')}]`,
  )
}

{
  // (k-2) the occluded entry action grounds the step-aside itself (bounded chunk),
  // and the next decision enters from the open face it reached
  const fixture = occludedFixture()
  const candidate = measuredCandidate(fixture, OCCLUDED_STAND)
  const model = installWalkModel(fixture, { transfer: true })
  const first = await runEntry(fixture, candidate, false, true, stubStuckPath(fixture))
  const legLine = first.messages.find((line) => line.startsWith(PORTAL_APPROACH_LEG)) ?? ''
  check(
    '(k-2) the UNIQUE open face is executed as a REFLEX prerequisite and reported as durable progress (never entry)',
    first.status === 'done' &&
      first.verified === false &&
      legLine.includes(`target=${ENTER_CELL.x},${ENTER_CELL.y},${ENTER_CELL.z}`) &&
      fixture.movedToFace &&
      first.messages.some(
        (line) => line.startsWith(REFLEX) && line.includes('action=step_onto_open_face'),
      ) &&
      first.messages.some(
        (line) =>
          line.startsWith(SKILL_STEP) &&
          line.includes('step=approach_leg') &&
          line.includes('authority=MANDATORY_PREREQUISITE'),
      ) &&
      first.messages.some(
        (line) => line.startsWith(SKILL_END) && line.includes('execution=progress'),
      ) &&
      !first.messages.some((line) => line.startsWith('PORTAL_ENTERED')),
    `status=${first.status} verified=${first.verified} face=${fixture.movedToFace} controls=[${model.controls.join(',')}] marker=[${legLine}]`,
  )
  // the next decision re-grounds the entry from the open face and walks in
  const state = worldState(
    { x: fixture.position.x, y: fixture.position.y, z: fixture.position.z },
    [],
    { diamond_pickaxe: 1, cobblestone: 32 },
  )
  const reoffered = entryCandidates(state, { ...defaultCandidateOptions, portalEntry: entryPlan(fixture) })
  const secondFixture = fixture
  const second = await runEntry(
    secondFixture,
    candidate,
    false,
    true,
    stubStuckPath(secondFixture),
  )
  const walkLine = second.messages.find((line) => line.startsWith(`${PORTAL_WALK_IN} `)) ?? ''
  check(
    '(k-2) from the open face the bounded walk enters and the transfer is observed',
    reoffered.candidates.some((candidate) => candidate.kind === 'ENTER_PORTAL') &&
      second.status === 'done' &&
      second.verified === true &&
      walkLine.includes('transferred=true') &&
      second.messages.some((line) => line.startsWith('PORTAL_ENTERED')),
    `reoffered=[${reoffered.candidates.map((candidate) => candidate.id).join(',')}] status=${second.status} verified=${second.verified} marker=[${walkLine}]`,
  )
}

{
  // (k-3) every new marker is a mirrored host event (live-visible)
  const markers = [
    PORTAL_APPROACH_LEG,
    PORTAL_APPROACH_REFUSED,
    // the composed entry climb: without these in the mirrored set the live sink
    // DROPS the line naming which climb ran and why it could not close the height,
    // and the operator's trial is indistinguishable from "no leg was ever grounded".
    PORTAL_ENTRY_CLIMB,
    PORTAL_ENTRY_CLIMB_REFUSED,
    // ...and the crossing half's own line: the entry route's summary of the span it
    // declared and whether the body advanced onto the floor it placed. The
    // per-step placements are the already-mirrored `BRIDGE_*` markers.
    PORTAL_ENTRY_CROSS,
    SKILL_START,
    SKILL_STEP,
    SKILL_INTERRUPT,
    SKILL_END,
    REFLEX,
  ]
  check(
    '(k-3) the step-aside, composed-climb and issue-#436 markers are mirrored host events (live-visible)',
    markers.every((marker) => MIRRORED_MARKERS.has(marker)),
    markers.map((marker) => `${marker}=${MIRRORED_MARKERS.has(marker)}`).join(' '),
  )
}

{
  // (k-4) SEVERAL open faces are ONE remedy class (walk around the frame): the
  // skill refines mechanically to the nearest reachable face, NAMES every face it
  // considered, and still offers all of them to Jev.
  const fixture = occludedFixture()
  fixture.grid.set('27,67,10', cell('air'))
  fixture.grid.set('27,68,10', cell('air'))
  const candidate = measuredCandidate(fixture, OCCLUDED_STAND)
  const model = installWalkModel(fixture, { transfer: true })
  const result = await runEntry(fixture, candidate, false, true, stubStuckPath(fixture))
  const step = result.messages.find((line) => line.startsWith(SKILL_STEP) && line.includes('step=approach_leg')) ?? ''
  const legLine = result.messages.find((line) => line.startsWith(PORTAL_APPROACH_LEG)) ?? ''
  const state = worldState(OCCLUDED_STAND, [], { diamond_pickaxe: 1, cobblestone: 32 }, [], [
    OCCLUDED_STAND,
    ENTER_CELL,
    { x: 26, y: ENTER_CELL.y, z: 10 },
    { x: 27, y: ENTER_CELL.y, z: 10 },
  ])
  const offered = entryCandidates(state, { ...defaultCandidateOptions, portalEntry: entryPlan(fixture) })
  const legs = offered.candidates.filter((entry) => entry.meta.approachLeg === 'portal_open_face')
  check(
    '(k-4) several faces in one remedy class: code refines to the nearest reachable face, names them all, and every face stays offered',
    result.status === 'done' &&
      step.includes('class=DETOUR') &&
      step.includes('refined_by=nearest_reachable') &&
      step.includes('faces=[') &&
      step.includes('26,67,10') &&
      step.includes('27,67,10') &&
      legLine.includes('cell=26,67,10') &&
      fixture.digs.length === 0 &&
      legs.length >= 2,
    `status=${result.status} digs=${fixture.digs.length} legs=${legs.length} step=[${step}] marker=[${legLine}]`,
  )
}

// ---------------------------------------------------------------------------
// (m) THE MEASURED LOWER-CORRIDOR SHAPE (run-mucbyro1-1hqhm, source c54fa6f) and
// the issue #436 §7 U1..U6 contract for deterministic prerequisites. World truth
// read from the save (tools/world-truth-plane.mjs, read-only):
//   body (24,67,9) on cobblestone (24,66,9) top y=67 | frame column 25,67..69,9
//   interior 26,67..69,9 + obsidian threshold 26,66,9 (top 67)
//   the open side z=10: the corridor floor is y=65, so the standable cell beside
//   the interior is (26,66,10) - ONE LEVEL BELOW the interior - while the
//   interior-level cell the old search named was air, so its own leg was refused
//   (`REFLEX cell={26,67,10} -> PORTAL_APPROACH_REFUSED ... faces=1`).
// ---------------------------------------------------------------------------
function lowerCorridorFixture(): FixtureBot {
  const grid = gateGrid()
  // the corridor south of the gate: floor y=65, standable at feet y=66
  grid.set('25,65,10', cell('cobblestone'))
  grid.set('26,65,10', cell('cobblestone'))
  grid.set('24,65,10', cell('cobblestone'))
  grid.set('25,66,10', cell('air'))
  grid.set('26,66,10', cell('air'))
  grid.set('24,66,9', cell('cobblestone'))
  grid.set('25,66,9', cell('cobblestone'))
  // complete the world model so headroom/standability probes see explicit air
  for (const x of [23, 24, 25, 26, 27, 28])
    for (const z of [8, 9, 10, 11, 12])
      for (const y of [67, 68, 69, 70]) {
        const k = `${x},${y},${z}`
        if (!grid.has(k)) grid.set(k, cell('air'))
      }
  return makeBot({ x: 24.2, y: 67, z: 9.2 }, grid, true)
}

const LOWER_STAND: Vec3Json = { x: 24.7, y: 67, z: 9.7 }

// ---------------------------------------------------------------------------
// (m-b) THE MEASURED STEP-OVER SHAPE: the unique standable open face of the gate
// is at the interior's own level (26,67,10) while the stance column in front of
// the body is a 1-block hole whose VERIFIED floor is (25,66,10) - so the
// mechanical continuation is: drop onto that floor, then climb the ledge onto
// the face. The path stage cannot own the cell (`noPath`, the measured
// PATH_CALLBACK outcome) and the straight push from the stance makes no approach
// progress (the measured `unreachable` from the naive bearing walk) - which is
// exactly the precondition #436 §7 U1..U6 requires before code may finish it.
// ---------------------------------------------------------------------------
function stepOverFixture(): FixtureBot {
  const grid = gateGrid()
  // the stance column (24,z=10): floor y=66, the body stands at feet y=67
  grid.set('24,66,10', cell('stone'))
  grid.set('24,67,10', cell('air'))
  grid.set('24,68,10', cell('air'))
  // the hole in front (25,z=10): open at 67/68, NO support at 66, floor at 65 -
  // the ONE verified hole floor the step-over may drop onto
  grid.set('25,65,10', cell('stone'))
  grid.set('25,66,10', cell('air'))
  grid.set('25,67,10', cell('air'))
  grid.set('25,68,10', cell('air'))
  // the open face (26,z=10): floor y=66, standable at feet y=67 (one block up
  // from the hole floor), beside the lit interior cell (26,67,9)
  grid.set('26,66,10', cell('stone'))
  grid.set('26,67,10', cell('air'))
  grid.set('26,68,10', cell('air'))
  // disqualify the stance's other three neighbours: the hole must be UNIQUE or
  // the skill has several ways in and must state the policy boundary instead
  grid.set('23,67,10', cell('stone'))
  grid.set('24,67,11', cell('stone'))
  grid.set('24,67,9', cell('stone'))
  return makeBot({ x: 24.2, y: 67, z: 10.2 }, grid, true)
}

const STEP_OVER_STAND: Vec3Json = { x: 24.2, y: 67, z: 10.2 }
const STEP_OVER_VIA: Vec3Json = { x: 25, y: 66, z: 10 }
const STEP_OVER_FACE: Vec3Json = { x: 26, y: 67, z: 10 }

{
  // (m-a) the measured shape: the leg names the ONE-LOWER face and the walk then
  // steps UP into the interior and transfers
  const fixture = lowerCorridorFixture()
  const candidate = measuredCandidate(fixture, LOWER_STAND)
  const model = installWalkModel(fixture, { transfer: true })
  const first = await runEntry(fixture, candidate, false, true, stubStuckPath(fixture))
  const legLine = first.messages.find((line) => line.startsWith(PORTAL_APPROACH_LEG)) ?? ''
  const blocked = first.messages.find((line) => line.startsWith('PORTAL_WALK_IN_BLOCKED')) ?? ''
  check(
    '(m-a) the measured lower-corridor pocket: the leg names the one-level-below face, and the walk-in completes',
    first.status === 'done' &&
      legLine.includes('cell=26,66,10') &&
      first.messages.some(
        (line) =>
          line.startsWith(SKILL_STEP) &&
          line.includes('step=approach_leg') &&
          line.includes('authority=MANDATORY_PREREQUISITE'),
      ) &&
      blocked.includes('obsidian@25,67,9') &&
      fixture.movedToFace &&
      fixture.digs.length === 0,
    `status=${first.status} face=${fixture.movedToFace} digs=${fixture.digs.length} marker=[${legLine}] blocked=[${blocked}]`,
  )
  // the walk-in from the lower face: one step UP into the non-solid portal cell
  const state = worldState(
    { x: fixture.position.x, y: fixture.position.y, z: fixture.position.z },
    [],
    { diamond_pickaxe: 1, cobblestone: 32 },
  )
  const reoffered = entryCandidates(state, { ...defaultCandidateOptions, portalEntry: entryPlan(fixture) })
  const second = await runEntry(fixture, candidate, false, true, stubStuckPath(fixture))
  const walkLine = second.messages.find((line) => line.startsWith(`${PORTAL_WALK_IN} `)) ?? ''
  const hop = second.messages.find((line) => line.startsWith(SKILL_STEP) && line.includes('step=hop')) ?? ''
  check(
    '(m-a) from the lower face the bounded walk steps UP into the interior and the transfer is observed',
    reoffered.candidates.some((candidate) => candidate.kind === 'ENTER_PORTAL') &&
      second.status === 'done' &&
      second.verified === true &&
      walkLine.includes('transferred=true') &&
      hop.includes('cell=26,67,9') &&
      second.messages.some((line) => line.startsWith('PORTAL_ENTERED')),
    `reoffered=[${reoffered.candidates.map((candidate) => candidate.id).join(',')}] status=${second.status} verified=${second.verified} marker=[${walkLine}] hop=[${hop}]`,
  )
}

{
  // (m-c) an open side two levels lower is a climb the skill must not invent
  const fixture = lowerCorridorFixture()
  // sink the corridor to y=64: now the standable cell (26,65,10) is TWO below
  fixture.grid.set('25,65,10', cell('air'))
  fixture.grid.set('26,65,10', cell('air'))
  fixture.grid.set('25,66,10', cell('air'))
  fixture.grid.set('26,66,10', cell('air'))
  fixture.grid.set('25,64,10', cell('cobblestone'))
  fixture.grid.set('26,64,10', cell('cobblestone'))
  const candidate = measuredCandidate(fixture, LOWER_STAND)
  const model = installWalkModel(fixture, { transfer: true })
  const result = await runEntry(fixture, candidate, false, true, stubStuckPath(fixture))
  const refused = result.messages.find((line) => line.startsWith(PORTAL_APPROACH_REFUSED)) ?? ''
  const boundary = result.messages.find((line) => line.startsWith(SKILL_POLICY_BOUNDARY)) ?? ''
  check(
    '(m-c) an open side two levels below yields no face: typed refusal, a policy boundary, and zero movement',
    result.status === 'failed' &&
      refused.includes('reason=no_open_face') &&
      boundary.includes('reason=no_in_envelope_remedy') &&
      !result.messages.some((line) => line.startsWith(PORTAL_APPROACH_LEG)) &&
      model.controls.length === 0,
    `status=${result.status} controls=[${model.controls.join(',')}] refused=[${refused}] boundary=[${boundary}]`,
  )
}

{
  // (m-d) mixed levels: every face (same level AND one below) is offered and named
  const fixture = occludedFixture()
  // a same-level face at (26,67,10) and a one-lower face at (27,66,10)
  fixture.grid.set('27,67,10', cell('air'))
  fixture.grid.set('27,66,10', cell('leaf_litter'))
  fixture.grid.set('27,65,10', cell('stone'))
  const state = worldState(OCCLUDED_STAND, [], { diamond_pickaxe: 1, cobblestone: 32 }, [], [
    OCCLUDED_STAND,
    ENTER_CELL,
    { x: 26, y: 67, z: 10 },
    { x: 27, y: 66, z: 10 },
  ])
  const offered = entryCandidates(state, { ...defaultCandidateOptions, portalEntry: entryPlan(fixture) })
  const legs = offered.candidates.filter((entry) => entry.meta.approachLeg === 'portal_open_face')
  check(
    '(m-d) a mixed-level open side offers BOTH the same-level and the one-below face (neither hard-coded)',
    legs.some((leg) => leg.target?.x === 26 && leg.target?.y === 67) &&
      legs.some((leg) => leg.target?.x === 27 && leg.target?.y === 66) &&
      legs.length >= 2,
    `legs=[${legs.map((leg) => `${leg.target?.x},${leg.target?.y},${leg.target?.z}`).join(' ')}]`,
  )
}

{
  // (m-e) U3: a genuinely available NON-locomotion remedy (a hand-diggable wall
  // that is NOT the portal's structure) is a different semantic class -> the skill
  // chooses none and surfaces every grounded alternative
  const fixture = occludedFixture()
  // the wall between the body and the gate is now dirt (hand-harvestable, not the
  // frame): both DETOUR and MINE are genuinely available
  fixture.grid.set('25,67,9', cell('dirt'))
  fixture.grid.set('25,68,9', cell('dirt'))
  fixture.grid.set('25,66,9', cell('dirt'))
  const candidate = measuredCandidate(fixture, OCCLUDED_STAND)
  const model = installWalkModel(fixture, { transfer: true })
  const result = await runEntry(fixture, candidate, false, true, stubStuckPath(fixture))
  const boundary = result.messages.find((line) => line.startsWith(SKILL_POLICY_BOUNDARY)) ?? ''
  check(
    '(m-e) U3/U4: with mine AND detour genuinely available the skill chooses none and surfaces both',
    result.status === 'failed' &&
      boundary.includes('reason=several_remedy_classes') &&
      boundary.includes('alternatives=[') &&
      boundary.includes('walk_face@') &&
      boundary.includes('dig@25,67,9(dirt,available:') &&
      !result.messages.some((line) => line.startsWith(PORTAL_APPROACH_LEG)) &&
      model.controls.length === 0 &&
      fixture.digs.length === 0,
    `status=${result.status} controls=[${model.controls.join(',')}] digs=${fixture.digs.length} boundary=[${boundary}]`,
  )
}

{
  // (m-f) U6: a face that is not there any more after execution is NOT assumed to
  // have worked - bounded, re-observed, no progress claimed
  const fixture = occludedFixture()
  const candidate = measuredCandidate(fixture, OCCLUDED_STAND)
  const model = installWalkModel(fixture, { transfer: true, vanishFace: true })
  const result = await runEntry(fixture, candidate, false, true, stubStuckPath(fixture))
  const boundary = result.messages.find((line) => line.startsWith(SKILL_POLICY_BOUNDARY)) ?? ''
  check(
    '(m-f) U6: a face that vanished under the body is re-observed, claims no progress, and fails honestly',
    result.status === 'failed' &&
      boundary.includes('reason=face_unverified') &&
      !result.messages.some((line) => line.startsWith(PORTAL_APPROACH_LEG)) &&
      !result.messages.some((line) => line.startsWith(SKILL_END) && line.includes('execution=progress')),
    `status=${result.status} boundary=[${boundary}]`,
  )
}

{
  // (m-g) U4: a wall that appears after the offer grants this skill NO dig/place
  // authority - it stops, and zero world mutation happens
  const fixture = lowerCorridorFixture()
  const candidate = measuredCandidate(fixture, LOWER_STAND)
  // the wall appears between offer and execution
  fixture.grid.set('25,67,9', cell('dirt'))
  fixture.grid.set('25,68,9', cell('dirt'))
  const model = installWalkModel(fixture, { transfer: true })
  const result = await runEntry(fixture, candidate, false, true, stubStuckPath(fixture))
  check(
    '(m-g) U4: a wall appearing after the offer never grants the entry dig/place authority',
    fixture.digs.length === 0 &&
      result.messages.every((line) => !line.includes('MINE')) &&
      result.status === 'failed',
    `status=${result.status} digs=${fixture.digs.length} controls=[${model.controls.join(',')}]`,
  )
}

{
  // (m-b) U1..U6 for the STEP-OVER continuation: one verified hole floor, the
  // measured stage failures, the prerequisite named with its exact geometry and
  // blocker, and the SAME commitment resumed by the leg that follows.
  const fixture = stepOverFixture()
  const candidate = measuredCandidate(fixture, STEP_OVER_STAND)
  const model = installWalkModel(fixture, {
    transfer: true,
    noPath: true,
    stepOver: { stance: { x: 24, y: 67, z: 10 }, face: STEP_OVER_FACE },
  })
  const result = await runEntry(fixture, candidate, false, true, stubStuckPath(fixture))
  const step = result.messages.find((line) => line.startsWith(SKILL_STEP) && line.includes('step=step_over')) ?? ''
  const reflex = result.messages.find((line) => line.startsWith(REFLEX) && line.includes('action=step_over')) ?? ''
  const leg = result.messages.find((line) => line.startsWith(PORTAL_APPROACH_LEG)) ?? ''
  const start = result.messages.find((line) => line.startsWith(SKILL_START)) ?? ''
  const startCommitment = /commitmentId=([^\s]+)/.exec(start)?.[1] ?? null
  const stepCommitment = /commitmentId=([^\s]+)/.exec(step)?.[1] ?? null
  const forwards = model.controls.filter((control) => control === 'forward').length
  check(
    '(m-b) the measured step-over: ONE verified hole floor is executed as a MANDATORY_PREREQUISITE and the leg completes with the step up',
    result.status === 'done' &&
      step.includes('authority=MANDATORY_PREREQUISITE') &&
      step.includes('via=25,66,10') &&
      step.includes('to=26,67,10') &&
      step.includes('envelope=movement-only(no_dig,no_place)') &&
      step.includes('worldDelta=none') &&
      step.includes('blocker=') &&
      reflex.includes('reason=unique_binding_prerequisite') &&
      leg.includes('cell=26,67,10') &&
      leg.includes(`target=${ENTER_CELL.x},${ENTER_CELL.y},${ENTER_CELL.z}`) &&
      startCommitment !== null &&
      stepCommitment === startCommitment &&
      fixture.movedToFace &&
      fixture.digs.length === 0,
    `status=${result.status} face=${fixture.movedToFace} digs=${fixture.digs.length} start=[${startCommitment}] step=[${step}] leg=[${leg}]`,
  )
  check(
    '(m-b) the step-over is BOUNDED (one named prerequisite, a finite number of pushes, no oscillation)',
    result.messages.filter((line) => line.includes('step=step_over')).length === 1 &&
      forwards > 0 &&
      forwards <= 24,
    `stepOverLines=${result.messages.filter((line) => line.includes('step=step_over')).length} forwards=${forwards} controls=[${model.controls.join(',')}]`,
  )
}

{
  // (m-b2) U6 on the step-over path: the prerequisite RUNS, the body arrives, and
  // the face is re-observed as gone - so the skill claims NO progress. A failed
  // prerequisite is never assumed to have worked.
  const fixture = stepOverFixture()
  const candidate = measuredCandidate(fixture, STEP_OVER_STAND)
  const model = installWalkModel(fixture, {
    transfer: true,
    noPath: true,
    vanishFace: true,
    stepOver: { stance: { x: 24, y: 67, z: 10 }, face: STEP_OVER_FACE },
  })
  const result = await runEntry(fixture, candidate, false, true, stubStuckPath(fixture))
  const boundary = result.messages.find((line) => line.startsWith(SKILL_POLICY_BOUNDARY)) ?? ''
  check(
    '(m-b2) U6: a step-over whose face vanished under the body is re-observed, claims no progress, and fails honestly',
    result.status === 'failed' &&
      result.messages.some((line) => line.startsWith(SKILL_STEP) && line.includes('step=step_over')) &&
      boundary.includes('reason=face_unverified') &&
      !result.messages.some((line) => line.startsWith(PORTAL_APPROACH_LEG)) &&
      !result.messages.some((line) => line.startsWith(SKILL_END) && line.includes('execution=progress')),
    `status=${result.status} controls=[${model.controls.join(',')}] boundary=[${boundary}]`,
  )
}

{
  // (m-h) BYTE IDENTITY for a same-level face: the level-tolerance change must not
  // alter one byte of the same-level path's evidence. The expected lines are the
  // exact strings the pre-change code produced for this shape (k-2's fixture).
  const fixture = occludedFixture()
  const candidate = measuredCandidate(fixture, OCCLUDED_STAND)
  const model = installWalkModel(fixture, { transfer: true })
  const result = await runEntry(fixture, candidate, false, true, stubStuckPath(fixture))
  const step = result.messages.find((line) => line.startsWith(SKILL_STEP) && line.includes('step=approach_leg')) ?? ''
  const leg = result.messages.find((line) => line.startsWith(PORTAL_APPROACH_LEG)) ?? ''
  const stepOver = result.messages.filter((line) => line.includes('step=step_over')).length
  check(
    '(m-h) a same-level face is byte-identical: the same SKILL_STEP and PORTAL_APPROACH_LEG strings, no step-over',
    step ===
      'SKILL_STEP skill=ENTER_PORTAL(portalSite) step=approach_leg authority=MANDATORY_PREREQUISITE ' +
        'evidence=blocker=obsidian@25,67,9+obsidian@25,68,9 class=DETOUR faces=[walk_face@26,67,10] ' +
        'refined_by=nearest_reachable chosen=26,67,10 worldDelta=none commitmentId=ENTER:26,67,9#1' &&
      leg === 'PORTAL_APPROACH_LEG cell=26,67,10 target=26,67,9 from_d=1.81 to_d=1.02' &&
      stepOver === 0 &&
      fixture.movedToFace &&
      result.status === 'done',
    `step=[${step}] leg=[${leg}] stepOver=${stepOver} controls=[${model.controls.join(',')}]`,
  )
}

{
  // (m-e2) U3 over THREE classes: with the detour (walk around the frame), a
  // hand-harvestable wall (mine) AND a grounded vertical route (pillar) all
  // present, the skill executes NONE of them and surfaces every class it
  // grounded - including the vertical route this commitment already spent.
  const fixture = occludedFixture()
  fixture.grid.set('25,67,9', cell('dirt'))
  fixture.grid.set('25,68,9', cell('dirt'))
  fixture.grid.set('25,66,9', cell('dirt'))
  const base = measuredCandidate(fixture, OCCLUDED_STAND)
  // a grounded vertical route (the same meta a MOVE candidate carries). It was
  // attempted before this fallback, so its class is named as spent, never hidden.
  const candidate: Candidate = { ...base, meta: { ...base.meta, vertical: 'staircase-up', upDigY: 68 } }
  const model = installWalkModel(fixture, { transfer: true })
  const result = await runEntry(fixture, candidate, false, true, stubStuckPath(fixture))
  const boundary = result.messages.find((line) => line.startsWith(SKILL_POLICY_BOUNDARY)) ?? ''
  check(
    '(m-e2) U3: detour + mine + pillar all grounded -> code picks none and names every class (the spent one included)',
    result.status === 'failed' &&
      boundary.includes('reason=several_remedy_classes') &&
      boundary.includes('walk_face@26,67,10') &&
      boundary.includes('dig@25,67,9(dirt,available:') &&
      boundary.includes('vertical:staircase-up(spent)') &&
      !result.messages.some((line) => line.startsWith(PORTAL_APPROACH_LEG)) &&
      model.controls.length === 0 &&
      fixture.digs.length === 0,
    `status=${result.status} controls=[${model.controls.join(',')}] digs=${fixture.digs.length} boundary=[${boundary}]`,
  )
}


// ===========================================================================
// (s) THE OPERATOR'S TRIAL, DECODED FROM THE SAVE: the CROSSING half.
//
// MEASURED (read-only decode of `r.0.0.mca`, chunk (1,0), DataVersion 4671,
// Status=full; the portal/obsidian round-trip is the decoder's own sanity anchor):
//
//   * the portal is a 2x3 interior at z=9: nether_portal at (26..27, 67..69, 9),
//     ringed by obsidian (25,67..69,9) (28,67..69,9) (26..27,66,9) (26..27,70,9);
//   * the body's own stand cell is (26,64,6): feet and head AIR, support
//     (26,63,6)=grass_block - the reported live position (26.3,64.0,6.3);
//   * SOUTH of it, at the portal's own level, everything is AIR: (26,67,7),
//     (26,67,8) and their floors (26,66,7), (26,66,8) - the void between the ledge
//     and the gate. The frame's bottom row (26,66,9) is OBSIDIAN, so the interior's
//     floor exists but the body cannot walk to it: the pinned `canDig=false`
//     pathfinder cannot express "place a block into the void and step onto it",
//     which is why every ENTER realization ended `PATH_CALLBACK phase=failed
//     outcome=stuck`.
//
// The composition under test (one bounded commitment, each leg typed + mirrored):
//   climb legs (`PORTAL_ENTRY_CLIMB*`)  ->  crossing leg (`PORTAL_ENTRY_CROSS`,
//   one `runBridgeLeg` chunk, per-step evidence on the existing `BRIDGE_*`
//   markers)  ->  the verified walk-in (`PORTAL_WALK_IN`).
//
// (s-1) the climb half on the measured geometry is UNCHANGED: a body at the
//       ledge (26,64,6) carries the own-column PILLAR to the interior's level and
//       NO crossing (the crossing belongs to the level it happens at).
// (s-2) the crossing half: a body AT the interior's level (the post-climb state)
//       carries a real verified span south - place (26,66,7), land (26,67,7),
//       far = the interior cell itself - and BOTH the reachability gate and the
//       guard accept that crossing-only entry, so the selected leg really runs.
// (s-3) THE WHOLE TRIAL through the live gate, one bounded chunk per decision
//       (each decision re-sensed at the body's current cell): the climb lifts the
//       body, the crossing really PLACES and the body really ADVANCES onto the
//       floor it made, and the verified walk-in enters - the exact "advance, not
//       just a placement" distinction the previous lane's fixture left unproven.
// (s-4) ONE crossing decision is a bounded chunk: durable body progress,
//       `verified=false`, never a claimed entry.
// (s-5) the one-below shape (the interior one block above the far side): the offer
//       is a SELF-LANDING scaffold, its execution floors (26,65,7) with the body
//       standing on it, and the rest of the route still enters.
// (s-6) a declared crossing that cannot execute is a TERMINAL typed refusal that
//       names the failed leg, and the body is never pushed into the gap.
// (s-7) the control shapes stay byte-identical: a level gate, a one-block step-up
//       and an ordinary walkable gate carry no crossing at all - including one
//       whose probes ARE sensed.
// ===========================================================================

/**
 * The measured geometry's structural cells, written as the save's own coordinates
 * (the fixtures above use the historical ORIGIN/LAYOUT gate; this one is the
 * operator's trial). Every cell named here was read from the region bytes; the
 * cells deliberately NOT named are left unknown (`blockAt` -> null), which the
 * sensor and every rule treat as fail-closed.
 */
function measuredPortalGrid(): Map<string, Cell> {
  const grid = new Map<string, Cell>()
  const air = (x: number, y: number, z: number): void => {
    grid.set(`${x},${y},${z}`, cell('air'))
  }
  // the body's ledge: support + the body rows, and the CLEAR AIR COLUMN above it
  // the pillar climb needs (the save has air all the way to the gate's level here:
  // that is why the climb is the leg that closes the height)
  grid.set('26,63,6', cell('grass_block'))
  for (const y of [64, 65, 66, 67, 68, 69]) air(26, y, 6)
  // the existing cobblestone step south of the body (the save's own block)
  grid.set('26,64,7', cell('cobblestone'))
  // the void the crossing has to floor, at the portal's level and below it:
  // (26,67,7)/(26,66,7) and (26,67,8)/(26,66,8) are the span's own cells
  for (const x of [26]) {
    for (const z of [7, 8]) {
      air(x, 65, z)
      air(x, 66, z)
      air(x, 67, z)
      air(x, 68, z)
    }
  }
  // the gate itself: 2x3 interior + the 10-cell obsidian ring
  for (const y of [67, 68, 69]) {
    grid.set(`25,${y},9`, cell('obsidian'))
    grid.set(`26,${y},9`, cell(NETHER_PORTAL))
    grid.set(`27,${y},9`, cell(NETHER_PORTAL))
    grid.set(`28,${y},9`, cell('obsidian'))
  }
  grid.set('26,66,9', cell('obsidian'))
  grid.set('27,66,9', cell('obsidian'))
  grid.set('26,70,9', cell('obsidian'))
  grid.set('27,70,9', cell('obsidian'))
  // the first cell of the OTHER three cardinal probes, exactly as the save has
  // them (air on air): so the crossing is chosen as the shortest REAL span, never
  // because the other directions were merely unsensed.
  for (const [x, z] of [
    [25, 6],
    [27, 6],
    [26, 5],
  ] as const) {
    air(x, 66, z)
    air(x, 67, z)
    air(x, 68, z)
  }
  // the wider surroundings the save also has (the body's ledge and the grass
  // shelf west of the corridor), so a probe that looks further sees real ground
  grid.set('26,63,5', cell('grass_block'))
  grid.set('26,63,4', cell('grass_block'))
  grid.set('27,63,4', cell('grass_block'))
  return grid
}

/** The gate's live-structure member cells (frame + interior): the protected set. */
const MEASURED_STRUCTURE: Vec3Json[] = [
  ...LAYOUT.frame.map((c) => ({ ...c })),
  ...LAYOUT.interior.map((c) => ({ ...c })),
]

/** The real sensor's four bounded probes for a body on the measured geometry. */
function measuredProbes(fixture: FixtureBot, feet: Vec3Json): BridgeProbe[] {
  return BRIDGE_DIRS.map((dir) => probeBridgeDirection(fixture.bot, feet, dir))
}

/**
 * The measured LOCOMOTION facts of the trial: the portal interior is not a walk
 * target for the stock actuator (`PATH_CALLBACK phase=failed outcome=stuck`), and
 * a landing cell is only walked onto when its support really exists in the world
 * (the crossing places it first).
 */
function measuredEntryPath(fixture: FixtureBot, executor: Executor, interiorWalkable: boolean): void {
  const base = (executor as unknown as { pathTo: (target: Vec3Json) => Promise<void> }).pathTo
  ;(executor as unknown as { pathTo: (target: Vec3Json) => Promise<void> }).pathTo = async (
    target: Vec3Json,
  ): Promise<void> => {
    fixture.pathCalls.push({ ...target })
    if (key(target) === key(ENTER_CELL) && !interiorWalkable) {
      throw new ExecutorError('path_stuck', 'pathfinder GoalBlock -> stuck')
    }
    if (key(target) !== key(ENTER_CELL)) {
      const support = fixture.grid.get(`${target.x},${target.y - 1},${target.z}`)
      if (support === undefined || support.boundingBox !== 'block') {
        throw new ExecutorError('path_stuck', `no support under (${key(target)})`)
      }
    }
    await base(target)
  }
}

/**
 * The ENTER candidate the LIVE decision loop would present for the measured
 * geometry: `generateGroundedCandidates` (the reachability gate included) with the
 * measured pathfinder fact - the interior is not a walk target for the stock
 * actuator, so a `no_path` probe is what the gate sees. `null` means the gate
 * WITHHELD the entry (which would mean the crossing route can never be chosen).
 */
function liveEntryCandidate(fixture: FixtureBot, state: WorldState, self: Vec3Json): Candidate | null {
  const options: CandidateOptions = {
    ...defaultCandidateOptions,
    portalEntry: entryPlan(fixture, self),
    reachability: { pathProbe: () => 'no_path' },
  }
  return generateGroundedCandidates(state, options).candidates.find((c) => c.kind === 'ENTER_PORTAL') ?? null
}

/**
 * The offering state re-SENSED at the body's CURRENT cell, exactly as the live
 * decision loop does every tick. The bridge probes are feet-level facts, so a
 * state captured at an older cell would offer a span from a cell the body has
 * already left.
 */
function measuredStateAt(
  fixture: FixtureBot,
  counts: Record<string, number> = { diamond_pickaxe: 1, cobblestone: 32 },
): WorldState {
  const feet = {
    x: Math.floor(fixture.position.x),
    y: Math.floor(fixture.position.y),
    z: Math.floor(fixture.position.z),
  }
  return worldState(
    { x: fixture.position.x, y: fixture.position.y, z: fixture.position.z },
    [],
    counts,
    [],
    [feet],
    measuredProbes(fixture, feet),
    MEASURED_STRUCTURE,
  )
}

/**
 * Run the ENTER commitment the way the live loop does: each decision RE-SENSES the
 * body's current cell and runs ONE bounded chunk (the climb chunk, a crossing
 * chunk, then the verified walk-in). Bounded by `maxActions`, so a route that
 * cannot finish reports what it really did instead of looping.
 */
async function runMeasuredEntryRoute(
  fixture: FixtureBot,
  maxActions = 6,
): Promise<{ status: string; failure: string | null; verified: boolean; actions: number; messages: string[] }> {
  let messages: string[] = []
  let status = 'failed'
  let failure: string | null = null
  let verified = false
  let actions = 0
  for (let index = 0; index < maxActions; index += 1) {
    const state = measuredStateAt(fixture)
    const feet = {
      x: Math.floor(fixture.position.x),
      y: Math.floor(fixture.position.y),
      z: Math.floor(fixture.position.z),
    }
    // The LIVE loop's own composition: the reachability gate presents the entry the
    // body's CURRENT cell grounds (a withheld entry is reported as such, never as a
    // silent no-route).
    const candidate = liveEntryCandidate(fixture, state, feet) ?? enterCandidate(fixture, state)
    const result = await runEntry(fixture, candidate, true, false, (executor) => {
      installWalkModel(fixture, { transfer: true })
      measuredEntryPath(fixture, executor, false)
    })
    actions += 1
    messages = [...messages, ...result.messages]
    status = result.status
    failure = result.failure
    verified = result.verified
    if (result.status === 'done' && result.verified) break
  }
  return { status, failure, verified, actions, messages }
}

{
  // (s-1) The CLIMB half on the measured geometry, BEFORE it runs: the body stands
  // on the ledge at feet y=64, three below the interior. The offer is exactly the
  // one today's code grounds (the own-column pillar to the interior's level) and
  // carries NO crossing: a crossing at the ledge's own level would spend blocks on
  // a span that still does not reach the gate.
  const grid = measuredPortalGrid()
  const fixture = makeBot({ x: 26, y: 64, z: 6 }, grid, true, { cobblestone: 32 })
  const state = worldState(
    { x: 26.5, y: 64, z: 6.5 },
    [],
    { diamond_pickaxe: 1, cobblestone: 32 },
    [],
    [{ x: 26, y: 64, z: 6 }],
    measuredProbes(fixture, { x: 26, y: 64, z: 6 }),
    MEASURED_STRUCTURE,
  )
  const candidate = enterCandidate(fixture, state)
  const sig = routeSignature({ kind: candidate.kind, id: candidate.id, meta: candidate.meta })
  check(
    '(s-1) the measured ledge grounds the CLIMB (own-column pillar to the interior level) and no crossing at the ledge level',
    candidate.meta.vertical === 'pillar' &&
      candidate.meta.pillarToY === ENTER_CELL.y &&
      candidate.meta.pillarSteps === 3 &&
      candidate.meta.pillarPlaceName === 'cobblestone' &&
      candidate.meta[BRIDGE_META] === undefined &&
      candidate.meta[BRIDGE_PLACE_META] === undefined &&
      sig === 'ENTER_PORTAL:pillar:unknown:64->67:dig=none:step=none:pillar=3:fallback=none',
    `vertical=${String(candidate.meta.vertical)} toY=${String(candidate.meta.pillarToY)} steps=${String(candidate.meta.pillarSteps)} bridge=${String(candidate.meta[BRIDGE_META])} routeSig=${sig}`,
  )
}

{
  // (s-2) The CROSSING half: the post-climb state (the pillar the climb places
  // occupies the body's own column below its feet), at the interior's own level.
  // The offer grounds a REAL verified span south - the first placement cell, the
  // first landing, and the far side, which IS the interior cell.
  const grid = measuredPortalGrid()
  for (const y of [64, 65, 66]) grid.set(`26,${y},6`, cell('cobblestone'))
  const fixture = makeBot({ x: 26, y: 67, z: 6 }, grid, true, { cobblestone: 32 })
  const state = worldState(
    { x: 26.5, y: 67, z: 6.5 },
    [],
    { diamond_pickaxe: 1, cobblestone: 32 },
    [],
    [{ x: 26, y: 67, z: 6 }],
    measuredProbes(fixture, { x: 26, y: 67, z: 6 }),
    MEASURED_STRUCTURE,
  )
  const candidate = enterCandidate(fixture, state)
  check(
    '(s-2) at the interior level the entry grounds the CROSSING: a verified span south, place (26,66,7) land (26,67,7) far = the interior',
    candidate.meta[BRIDGE_META] === true &&
      candidate.meta.bridgeDir === 'S' &&
      candidate.meta.bridgeBlock === 'cobblestone' &&
      candidate.meta.bridgeSpan === 2 &&
      candidate.meta[BRIDGE_PLACE_META] === '26,66,7' &&
      candidate.meta.bridgeLanding === '26,67,7' &&
      candidate.meta.bridgeTarget === '26,67,9' &&
      candidate.meta.mayPlaceBlocks === true &&
      candidate.meta.legContinuationSkill === PORTAL_ENTER_SKILL &&
      String(candidate.meta.bridgeLine).startsWith('BRIDGE_START cell=26,67,7 block=cobblestone span=2') &&
      String(candidate.meta.bridgeAuthorityLine).startsWith(
        `SKILL_STEP skill=${PORTAL_ENTER_SKILL} step=bridge authority=MECHANICAL_CONTINUATION`,
      ),
    `dir=${String(candidate.meta.bridgeDir)} span=${String(candidate.meta.bridgeSpan)} place=${String(candidate.meta[BRIDGE_PLACE_META])} landing=${String(candidate.meta.bridgeLanding)} target=${String(candidate.meta.bridgeTarget)} line="${String(candidate.meta.bridgeLine)}" authority="${String(candidate.meta.bridgeAuthorityLine)}"`,
  )

  // The REACHABILITY GATE must present this entry: the crossing contract is its own
  // path fact (a bridge leg is evaluated like a vertical plan, `candidates.ts#evaluateCandidate`),
  // so an entry whose only route is to lay its own floor is not withheld `no_path`.
  // Without this the live loop would never offer the crossing after the climb.
  const live = liveEntryCandidate(fixture, state, { x: 26, y: 67, z: 6 })
  check(
    '(s-2) the reachability gate PRESENTS the crossing-only entry (a bridge leg is its own path fact), never withholds it no_path',
    live !== null && live.meta[BRIDGE_META] === true && live.meta.bridgeSpan === 2,
    `presented=${live !== null} bridge=${String(live?.meta[BRIDGE_META])} span=${String(live?.meta.bridgeSpan)}`,
  )
  // ...and the GUARD accepts it: the crossing is the entry's own route, so the
  // horizontal path probe is skipped for exactly the reason a MOVE bridge skips it
  // (`policy.ts#carriesOwnRoute`), while every hazard/void/in-flight check still runs.
  const verdict =
    live === null
      ? null
      : guardCandidate(live, state, {
          phase: 'decision',
          candidateIds: new Set([live.id]),
          inFlight: null,
          reach: 4.5,
          maxCandidateAgeTicks: 200,
          canComputePath: () => true,
        })
  check(
    '(s-2) the guard accepts the crossing-only entry (its own route), so the selected leg really leases',
    verdict !== null && verdict.ok === true,
    `ok=${String(verdict?.ok)} reason=${verdict === null || verdict.ok ? 'none' : verdict.reason}`,
  )

  // (s-3) EXECUTION OF THE WHOLE MEASURED TRIAL, one bounded chunk per decision,
  // each decision re-sensed at the body's current cell (the live loop's own shape):
  // the CLIMB lifts the body to the interior's level, the CROSSING lays the floor
  // of the void and the body ADVANCES onto it, and the verified WALK-IN closes the
  // last cell. The assertion separates the two facts the previous lane's fixture
  // could not: the blocks really appear in the world AND the body really advances.
  {
    const runFixture = makeBot({ x: 26, y: 64, z: 6 }, measuredPortalGrid(), true, { cobblestone: 32 })
    const route = await runMeasuredEntryRoute(runFixture)
    const climb = route.messages.filter((line) => line.startsWith(PORTAL_ENTRY_CLIMB))
    const steps = route.messages.filter((line) => line.startsWith('BRIDGE_STEP'))
    const cross = route.messages.filter((line) => line.startsWith(PORTAL_ENTRY_CROSS))
    const entered = route.messages.find((line) => line.startsWith('PORTAL_ENTERED')) ?? ''
    const walkIn = route.messages.find((line) => line.startsWith('PORTAL_WALK_IN ')) ?? ''
    // The crossing's own STRICT REDUCTION - the bound every verified span takes.
    //
    // `d=` is a 3D distance to the interior, so its `from` carries the fraction of
    // a block the body is still descending when the crossing chunk starts. That is
    // not noise and not a fixture slack: the pillar's landing predicate is a
    // DECLARED +/-`PILLAR_LANDING_Y_TOLERANCE` window (`pillarApex.ts:639`), so a
    // climb that has already placed the block it stands on legitimately hands over
    // a body still up to that tolerance above it (the merged live run measured
    // `attemptFeetY=67.001`; this fixture measures 67.1768). The reduction is the
    // assertion; the exact `from` fraction is the arc's phase, so it is bounded by
    // the geometry and the tolerance rather than pinned to one sample.
    const crossLine = cross[0] ?? ''
    const crossSpan = /d=([0-9.]+)->([0-9.]+)/.exec(crossLine)
    const crossFrom = crossSpan === null ? Number.NaN : Number(crossSpan[1])
    const crossTo = crossSpan === null ? Number.NaN : Number(crossSpan[2])
    // the interior is 0.5 cells in x and 2.5 in z from the stance; the leftover
    // descent the climb may hand over is bounded by its landing tolerance.
    const fromFloor = Math.hypot(0.5, 0, 2.5)
    const fromCeiling = Math.hypot(0.5, PILLAR_LANDING_Y_TOLERANCE, 2.5)
    check(
      '(s-3) the measured trial crosses: the climb lifts the body, the crossing ADVANCES it onto the floor it places, the walk-in enters',
      climb.some((line) => line.includes('climb=pillar') && line.includes('outcome=climbed')) &&
        crossLine.includes('outcome=advanced') &&
        crossTo === 0.71 &&
        crossFrom >= fromFloor - 0.01 &&
        crossFrom <= fromCeiling + 0.02 &&
        // the span really CLOSED the gap in one bounded chunk, not merely moved
        crossTo <= crossFrom - 1.8 &&
        steps.length === 2 &&
        steps[0] === 'BRIDGE_STEP from=26,67,6 to=26,67,7 block=cobblestone' &&
        steps[1] === 'BRIDGE_STEP from=26,67,7 to=26,67,8 block=cobblestone' &&
        runFixture.grid.get('26,66,7')?.name === 'cobblestone' &&
        runFixture.grid.get('26,66,8')?.name === 'cobblestone' &&
        walkIn.includes('transferred=true') &&
        entered.includes('pos=26,67,9') &&
        entered.includes('dimension=minecraft:the_nether') &&
        route.status === 'done' &&
        route.verified === true &&
        route.failure === null,
      `actions=${route.actions} status=${route.status} failure=${route.failure ?? 'none'} verified=${route.verified} climb=${climb.length} climbLines=[${climb.slice(0, 4).join(' || ')}] steps=[${steps.join(' | ')}] floors=${String(runFixture.grid.get('26,66,7')?.name)}/${String(runFixture.grid.get('26,66,8')?.name)} cross=[${cross.join(' | ')}] walkIn=[${walkIn}] entered=[${entered}] body=${runFixture.position.x.toFixed(3)},${runFixture.position.y.toFixed(3)},${runFixture.position.z.toFixed(3)} placePaths=[${runFixture.placePaths.join(',')}] physics=engine(gravity=${0.08},airdrag=fround(0.98),physicsTick@50ms) placePath=${runFixture.placePaths[0] ?? 'none'}x${runFixture.placePaths.length} handshake=PILLAR_PLACE_SAME_TICK crossFrom=${crossFrom} crossTo=${crossTo} fromBand=[${fromFloor.toFixed(4)},${fromCeiling.toFixed(4)}]`,
    )

    // (s-4) The crossing is a BOUNDED chunk, never a claimed entry: the FIRST
    // decision that runs it returns durable body progress with `verified=false`, and
    // the entry is only claimed by the later dimension postcondition.
    const chunk = await (async (): Promise<{ status: string; verified: boolean; cross: string }> => {
      const fixture = makeBot({ x: 26, y: 67, z: 6 }, measuredPortalGrid(), true, { cobblestone: 32 })
      for (const y of [64, 65, 66]) fixture.grid.set(`26,${y},6`, cell('cobblestone'))
      const candidate = enterCandidate(fixture, measuredStateAt(fixture))
      const result = await runEntry(fixture, candidate, true, false, (executor) => {
        installWalkModel(fixture, { transfer: true })
        measuredEntryPath(fixture, executor, false)
      })
      return {
        status: result.status,
        verified: result.verified,
        cross: result.messages.find((line) => line.startsWith(PORTAL_ENTRY_CROSS)) ?? '',
      }
    })()
    check(
      '(s-4) one crossing decision is a bounded chunk: durable body progress, verified=false, no claimed entry',
      chunk.status === 'done' &&
        chunk.verified === false &&
        chunk.cross.includes('outcome=advanced') &&
        chunk.cross.includes('d=2.55->0.71'),
      `status=${chunk.status} verified=${chunk.verified} cross=[${chunk.cross}]`,
    )
  }
}

{
  // (s-5) THE INTERIOR ONE BLOCK ABOVE THE FAR SIDE: the body is at feet y=66 (one
  // below the interior), so no already-standable far bank exists inside the probe
  // and the crossing grounds as a SELF-LANDING SCAFFOLD - this step creates the
  // floor of the cell it occupies. Its execution + the walk-in's own audited hop
  // then reach the dimension postcondition in ONE commitment.
  const grid = measuredPortalGrid()
  for (const y of [64, 65]) grid.set(`26,${y},6`, cell('cobblestone'))
  const fixture = makeBot({ x: 26, y: 66, z: 6 }, grid, true, { cobblestone: 32 })
  const state = worldState(
    { x: 26.5, y: 66, z: 6.5 },
    [],
    { diamond_pickaxe: 1, cobblestone: 32 },
    [],
    [{ x: 26, y: 66, z: 6 }],
    measuredProbes(fixture, { x: 26, y: 66, z: 6 }),
    MEASURED_STRUCTURE,
  )
  const candidate = enterCandidate(fixture, state)
  const offered =
    candidate.meta[BRIDGE_META] === true &&
    candidate.meta.bridgeSelfLanding === true &&
    candidate.meta.bridgeSpan === 1 &&
    candidate.meta[BRIDGE_PLACE_META] === '26,65,7' &&
    candidate.meta.bridgeLanding === '26,66,7' &&
    String(candidate.meta.bridgePocketEvidence).includes('floor=26,65,7:cobblestone:placed')
  // The CLIMB half is the one the measured ledge offer already grounds (and (s-3)
  // proves it runs); this section isolates the crossing EXECUTION in the
  // one-block-above shape, with the climb half already realized - the same fixture
  // idiom the (m-e2) case uses. The crossing must then CREATE the floor of the cell
  // it occupies and the body must really stand on it.
  const crossingCandidate: Candidate = { ...candidate, meta: { ...candidate.meta, vertical: 'none' } }
  const crossingAction = await runEntry(fixture, crossingCandidate, true, false, (executor) => {
    installWalkModel(fixture, { transfer: true })
    measuredEntryPath(fixture, executor, false)
  })
  const cross = crossingAction.messages.find((line) => line.startsWith(PORTAL_ENTRY_CROSS)) ?? ''
  const step = crossingAction.messages.find((line) => line.startsWith('BRIDGE_STEP')) ?? ''
  const crossingBody = {
    x: Math.floor(fixture.position.x),
    y: Math.floor(fixture.position.y),
    z: Math.floor(fixture.position.z),
  }
  // The rest of the route, one bounded chunk per decision, reaches the transfer.
  const walkAction = await runMeasuredEntryRoute(fixture)
  const entered = walkAction.messages.find((line) => line.startsWith('PORTAL_ENTERED')) ?? ''
  const walkIn = walkAction.messages.find((line) => line.startsWith('PORTAL_WALK_IN ')) ?? ''
  check(
    '(s-5) one block below the interior the crossing is a SELF-LANDING scaffold: it floors the cell and the body stands on it',
    offered &&
      step === 'BRIDGE_STEP from=26,66,6 to=26,66,7 block=cobblestone' &&
      fixture.grid.get('26,65,7')?.name === 'cobblestone' &&
      key(crossingBody) === '26,66,7' &&
      cross.includes('outcome=advanced') &&
      cross.includes('placed=1') &&
      crossingAction.status === 'done' &&
      crossingAction.verified === false &&
      walkIn.includes('transferred=true') &&
      entered.includes('pos=26,67,9') &&
      walkAction.status === 'done' &&
      walkAction.verified === true,
    `self=${String(candidate.meta.bridgeSelfLanding)} place=${String(candidate.meta[BRIDGE_PLACE_META])} floor=${String(fixture.grid.get('26,65,7')?.name)} body=${key(crossingBody)} step=[${step}] cross=[${cross}] crossingVerified=${crossingAction.verified} actions=${walkAction.actions} walkIn=[${walkIn}] entered=[${entered}] status=${walkAction.status} verified=${walkAction.verified}`,
  )
}

{
  // (s-6) A DECLARED crossing that cannot execute live (the block left the
  // inventory between the decision and the lease) is a TERMINAL typed refusal that
  // NAMES the leg: `cross=` carries the offer's own span/place/landing and the
  // refusal. The body is never pushed into the gap the crossing was grounded to
  // fill - the walk-in cannot see a missing floor, only solid blockers.
  const grid = measuredPortalGrid()
  for (const y of [64, 65, 66]) grid.set(`26,${y},6`, cell('cobblestone'))
  const fixture = makeBot({ x: 26, y: 67, z: 6 }, grid, true, { cobblestone: 32 })
  const state = worldState(
    { x: 26.5, y: 67, z: 6.5 },
    [],
    { diamond_pickaxe: 1, cobblestone: 32 },
    [],
    [{ x: 26, y: 67, z: 6 }],
    measuredProbes(fixture, { x: 26, y: 67, z: 6 }),
    MEASURED_STRUCTURE,
  )
  const candidate = enterCandidate(fixture, state)
  // the crossing was planned WITH the block; execution time has none
  fixture.inventoryItems.length = 0
  const result = await runEntry(fixture, candidate, true, false, (executor) => {
    installWalkModel(fixture, { transfer: true })
    measuredEntryPath(fixture, executor, false)
  })
  const cross = result.messages.find((line) => line.startsWith(PORTAL_ENTRY_CROSS)) ?? ''
  const blocked = result.messages.find((line) => line.startsWith('PORTAL_ENTRY_ROUTE_BLOCKED')) ?? ''
  check(
    '(s-6) a declared crossing that cannot execute is terminal and typed: cross= names the span, the place cell, the landing and the refusal',
    cross.includes('outcome=refused') &&
      // a refusal claims NO movement: the leg's own distance is unchanged
      cross.includes('d=2.55->2.55') &&
      cross.includes('detail=no_block verified=false') &&
      blocked.includes('reason=route_blocked') &&
      blocked.includes('cross=dir=S,span=2,place=26,66,7,landing=26,67,7,outcome=refused,placed=0,d=2.55->2.55') &&
      blocked.includes('detail=no_block') &&
      result.status === 'failed' &&
      fixture.grid.get('26,66,7')?.name === 'air' &&
      !result.messages.some((line) => line.startsWith('PORTAL_WALK_IN ')),
    `status=${result.status} cross=[${cross}] blocked=[${blocked}] placed=${String(fixture.grid.get('26,66,7')?.name)} walkIns=${result.messages.filter((line) => line.startsWith('PORTAL_WALK_IN ')).length}`,
  )
}

{
  // (s-7) THE CONTROL SHAPES, with the crossing rule fully active AND the probes
  // really sensed: a level gate where the body stands on ordinary ground beside the
  // interior grounds NO crossing (the first cell in every direction is either a
  // stand or has a floor), so the offer keeps exactly the meta it had and no
  // crossing marker is ever emitted.
  const grid = gateGrid()
  grid.set('25,66,10', cell('stone'))
  grid.set('26,66,10', cell('stone'))
  grid.set('27,66,10', cell('stone'))
  grid.set('25,66,9', cell('stone'))
  const fixture = makeBot({ x: 25, y: 67, z: 10 }, grid, true, { cobblestone: 32 })
  const state = worldState(
    { x: 25.5, y: 67, z: 10.5 },
    [],
    { diamond_pickaxe: 1, cobblestone: 32 },
    [],
    [
      { x: 25, y: 67, z: 10 },
      { x: 26, y: 67, z: 10 },
    ],
    measuredProbes(fixture, { x: 25, y: 67, z: 10 }),
  )
  const candidate = enterCandidate(fixture, state)
  const result = await runEntry(fixture, candidate, true)
  check(
    '(s-7) a LEVEL gate with sensed probes grounds no crossing: vertical=none, no bridge key, no crossing marker, the walk-in transfers',
    candidate.meta.vertical === 'none' &&
      candidate.meta[BRIDGE_META] === undefined &&
      candidate.meta.fallbackVertical === undefined &&
      result.status === 'done' &&
      result.verified === true &&
      !result.messages.some((line) => line.startsWith(PORTAL_ENTRY_CROSS)) &&
      fixture.grid.get('26,66,10')?.name === 'stone',
    `vertical=${String(candidate.meta.vertical)} bridge=${String(candidate.meta[BRIDGE_META])} status=${result.status} verified=${result.verified} crossingLines=${result.messages.filter((line) => line.startsWith(PORTAL_ENTRY_CROSS)).length}`,
  )
}

process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
if (failures > 0) process.exit(1)
