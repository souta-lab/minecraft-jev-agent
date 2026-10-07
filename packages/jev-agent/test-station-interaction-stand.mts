// test-station-interaction-stand.mts - EXECUTOR station-interaction stand defect.
//
// Live RC9 (run-mu8usj39-10iyr, source d573097): PLACE:crafting_table:p-50_79_-7
// was verified=true, then `craftAtTable` called `bot.openBlock(table)` and it
// failed with a 20 s timeout across 3+ retries. The sensed table was at
// (-50,79,-7) and the bot was BELOW/OFFSET from it: no valid stand adjacent to
// the table was ever established, and `openBlock` was called with no direction
// (face), so the server rejected the interaction. Jev chose the one valid CRAFT
// candidate correctly - this is executor mechanics only.
//
// `interactionStandCandidates` / `deriveInteractionFace` make the stand and the
// `block_place` direction explicit, and `approachPlacedBlock` now requires a
// real stand (or fails loud with the typed path_stuck code) before any window
// is opened. The suite drives the real Executor over a structural fake bot:
//   (a) below/offset with NO valid stand must NOT call openBlock at all and must
//       fail with a typed error (red before the fix: openBlock called blindly);
//   (b) an already-correctly-positioned bot still opens the table (with the
//       derived face, red before: no face) and crafts successfully;
//   (c) the face geometry for every stand orientation;
//   (d) the stand filter (passable + supported + face in reach);
//   (e) the wiring that forwards the face into craftAtTable/openBlock.
//
// Run: bun --test test-station-interaction-stand.mts
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { Bot } from 'mineflayer'
import { Executor, EventLogger, defaultExecutorOptions } from './src/index.ts'
import * as executorModule from './src/executor.ts'
import type { Candidate, Vec3Json } from './src/index.ts'
import type { InternalEffectActuationOutcome, InternalEffectReservation } from './src/executor.ts'
import { fixtureClaim, fixtureClaimContext } from './test-claim-context.mts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const TABLE: Vec3Json = { x: 1, y: 64, z: 0 }

/** Minimal structural vec3 the executor touches on the fake bot. */
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
  diggable: boolean
  position: P
}

interface StationBotFixture {
  bot: Bot
  openCalls: Array<Vec3Json | null>
  mutationTrace: string[]
  table: FakeBlock
}

/**
 * A structural bot containing only what the CRAFT path reads: the block grid,
 * the entity feet, the registry, a stub pathfinder and an `openBlock` that
 * records the direction it was given. `blocks` maps "x,y,z" → block name.
 */
function makeStationBot(feet: Vec3Json, blocks: Map<string, string>, withFloor: boolean, mutationTrace: string[] = []): StationBotFixture {
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`
  const position = new P(feet.x, feet.y, feet.z)
  const openCalls: Array<Vec3Json | null> = []
  let opened = false
  const blockAt = (v: { x: number; y: number; z: number }): FakeBlock | null => {
    const name = blocks.get(key(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)))
    // Loaded area, station in open air: an unlisted cell is open space, not an
    // unloaded chunk (see #382 - null is not passable).
    const resolved = name ?? 'air'
    return { name: resolved, boundingBox: resolved === 'air' ? 'empty' : 'block', diggable: resolved !== 'air', position: new P(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)) }
  }
  const table = blockAt(TABLE as { x: number; y: number; z: number }) as FakeBlock
  const itemsByName = registry.itemsByName as Record<string, { id: number }>
  const resultId = itemsByName.stone_pickaxe?.id ?? 0

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
    physicsEnabled: withFloor,
    entities: {},
    inventory: {
      count: (id: number) => (opened && id === resultId ? 1 : 0),
      items: (): Array<{ name: string; type: number; count: number }> => [],
    },
    blockAt,
    on: () => undefined,
    removeListener: () => undefined,
    setControlState: () => undefined,
    lookAt: async () => undefined,
    equip: async () => undefined,
    canDigBlock: () => true,
    dig: async () => undefined,
    stopDigging: () => undefined,
    craft: async () => undefined,
    recipesFor: () => [
      { requiresTable: true, result: { id: resultId, count: 1 }, inShape: [[{ id: 1, count: 1, metadata: null }]], outShape: null },
    ],
    openBlock: async (_block: unknown, direction?: { x: number; y: number; z: number }): Promise<unknown> => {
      mutationTrace.push('bot.openBlock')
      openCalls.push(direction === undefined ? null : { x: direction.x, y: direction.y, z: direction.z })
      opened = true
      const win = {
        type: 'minecraft:crafting',
        id: 1,
        inventoryStart: 10,
        inventoryEnd: 46,
        craftingResultSlot: 0,
        selectedItem: null,
        slots: new Array<unknown>(46).fill(null),
        findInventoryItem: () => ({ slot: 10, type: 1, metadata: null, count: 1 }),
        findItemRange: () => null,
        firstEmptySlotRange: () => 11,
        updateSlot: (slot: number, item: unknown) => {
          win.slots[slot] = item
        },
      }
      return win
    },
    clickWindow: async () => { mutationTrace.push('bot.clickWindow') },
    putSelectedItemRange: async () => { mutationTrace.push('bot.putSelectedItemRange') },
    closeWindow: async () => { mutationTrace.push('bot.closeWindow') },
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

  return { bot: bot as unknown as Bot, openCalls, mutationTrace, table }
}

function craftCandidate(): Candidate {
  return {
    id: 'CRAFT:stone_pickaxe',
    kind: 'CRAFT',
    label: 'craft 1 x stone_pickaxe',
    targetName: null,
    target: { x: TABLE.x, y: TABLE.y, z: TABLE.z },
    targetEntityId: null,
    itemName: 'stone_pickaxe',
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: { requiresTable: true },
  }
}

async function runCraft(feet: Vec3Json, blocks: Map<string, string>, withFloor: boolean) {
  const fixture = makeStationBot(feet, blocks, withFloor)
  const executor = new Executor(fixture.bot, new EventLogger(null, false), {
    ...defaultExecutorOptions,
    actuation: 'packet',
    packetStepMs: 1,
    maxStepsPerWaypoint: 5,
  })
  const result = await fixtureClaim(executor, craftCandidate()).completion
  return { fixture, result }
}

/** A floor at y=63 and a table at (1,64,0); adjacent cells are open air. */
function openTableTerrain(): Map<string, string> {
  const blocks = new Map<string, string>()
  for (let x = -2; x <= 3; x += 1) for (let z = -2; z <= 3; z += 1) blocks.set(`${x},63,${z}`, 'stone')
  blocks.set(`${TABLE.x},${TABLE.y},${TABLE.z}`, 'crafting_table')
  return blocks
}

/** The table is walled in: every adjacent feet/head cell is solid. */
function walledTableTerrain(): Map<string, string> {
  const blocks = openTableTerrain()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    for (let y = TABLE.y - 2; y <= TABLE.y + 2; y += 1) blocks.set(`${TABLE.x + dx},${y},${TABLE.z + dz}`, 'stone')
  }
  return blocks
}

// A CRAFT at a table is a compound actuator: station open, recipe window
// clicks, and station close. The executor must reserve its declared Kernel
// CRAFT effect before the first of those mutations and settle only after the
// whole table operation returns.
addCase('(b4) table crafting mutations are inside one Kernel CRAFT dispatch', async () => {
  const trace: string[] = []
  const fixture = makeStationBot({ x: 0.5, y: 64, z: 0.5 }, openTableTerrain(), true, trace)
  const executor = new Executor(fixture.bot, new EventLogger(null, false), {
    ...defaultExecutorOptions,
    actuation: 'packet',
    packetStepMs: 1,
    maxStepsPerWaypoint: 5,
  })
  const candidate = craftCandidate()
  const reservations: InternalEffectReservation[] = []
  const settlements: Array<InternalEffectReservation & { outcome: InternalEffectActuationOutcome }> = []
  const claimed = executor.claim(candidate, {
    ...fixtureClaimContext(candidate),
    internalEffectCallbacks: {
      before: (reservation) => {
        reservations.push(reservation)
        trace.push(`kernel-dispatch:${reservation.kernelEffectKind}`)
        return true
      },
      after: (settlement) => {
        settlements.push(settlement)
        trace.push(`kernel-settled:${settlement.outcome.status}`)
      },
    },
  })
  const result = await claimed.completion
  const dispatchAt = trace.indexOf('kernel-dispatch:CRAFT')
  const openAt = trace.indexOf('bot.openBlock')
  const settledAt = trace.indexOf('kernel-settled:actuator-returned')
  const mutations = trace.flatMap((event, index) => event.startsWith('bot.') ? [index] : [])
  const pass = result.status === 'done' && result.itemsGained === 1 &&
    reservations.length === 1 && settlements.length === 1 &&
    reservations[0]?.effect.type === 'station' && reservations[0]?.effect.station === 'crafting_table' &&
    reservations[0]?.kernelEffectKind === 'CRAFT' &&
    dispatchAt >= 0 && openAt > dispatchAt && settledAt > openAt &&
    mutations.length >= 3 && mutations.every((index) => index > dispatchAt && index < settledAt)
  return { pass, detail: `status=${result.status} dispatch=${reservations[0]?.kernelEffectKind ?? 'none'} trace=${trace.join('>')}` }
})

addCase('(b5) a refused Kernel CRAFT dispatch prevents opening the table', async () => {
  const trace: string[] = []
  const fixture = makeStationBot({ x: 0.5, y: 64, z: 0.5 }, openTableTerrain(), true, trace)
  const executor = new Executor(fixture.bot, new EventLogger(null, false), {
    ...defaultExecutorOptions,
    actuation: 'packet',
    packetStepMs: 1,
    maxStepsPerWaypoint: 5,
  })
  const candidate = craftCandidate()
  const claimed = executor.claim(candidate, {
    ...fixtureClaimContext(candidate),
    internalEffectCallbacks: { before: () => false, after: () => { trace.push('unexpected-settle') } },
  })
  const result = await claimed.completion
  const pass = result.status === 'failed' && result.failure === 'effect_reservation_refused' &&
    fixture.openCalls.length === 0 && fixture.mutationTrace.length === 0 && !trace.includes('unexpected-settle')
  return { pass, detail: `failure=${result.failure} openCalls=${fixture.openCalls.length} mutations=${fixture.mutationTrace.length}` }
})

// (a) below/offset, no valid stand -> typed fail, never a blind openBlock.
addCase('(a) a table with the bot below/offset and no valid stand fails path_stuck and never opens the table', async () => {
  const { fixture, result } = await runCraft({ x: 0.5, y: 62, z: 0.5 }, walledTableTerrain(), false)
  const pass = result.status === 'failed' && result.failure === 'path_stuck' && fixture.openCalls.length === 0
  return {
    pass,
    detail: `status=${result.status} failure=${result.failure} openCalls=${fixture.openCalls.length} detail=${result.detail}`,
  }
})

// (b) already on a valid stand -> the derived face is passed and the craft lands.
addCase('(b) an already-correctly-positioned bot opens the table with the derived face and crafts successfully', async () => {
  const { fixture, result } = await runCraft({ x: 0.5, y: 64, z: 0.5 }, openTableTerrain(), true)
  const face = fixture.openCalls[0]
  const pass =
    result.status === 'done' &&
    result.itemsGained === 1 &&
    fixture.openCalls.length === 1 &&
    face !== null &&
    face !== undefined &&
    face.x === -1 &&
    face.y === 0 &&
    face.z === 0
  return {
    pass,
    detail: `status=${result.status} gained=${result.itemsGained} openCalls=${JSON.stringify(fixture.openCalls)} detail=${result.detail}`,
  }
})

// The recovery shape in p25: the closest station stand has a blocked route
// through the body's own scaffold. Another stand around that scaffold is
// reachable without digging. A CRAFT must use that route rather than acquire
// undeclared clearance effects in its direct-bearing fallback.
addCase('(b2) a blocked nearest station stand uses a reachable alternative and an exact goal, then crafts', async () => {
  const terrain = openTableTerrain()
  for (let x = -7; x <= -3; x += 1) {
    for (let z = -3; z <= 3; z += 1) terrain.set(`${x},63,${z}`, 'stone')
  }
  const fixture = makeStationBot({ x: -5.5, y: 64, z: 0.5 }, terrain, true)
  const bot = fixture.bot as unknown as {
    entity: { position: P }
    on: EventEmitter['on']
    removeListener: EventEmitter['removeListener']
    dig: () => Promise<void>
    pathfinder: {
      movements: unknown
      getPathTo: (movements: unknown, goal: { x: number; y: number; z: number }, budget: number) => unknown
      setGoal: (goal: { x: number; y: number; z: number; constructor: { name: string } } | null) => void
    }
  }
  const events = new EventEmitter()
  bot.on = events.on.bind(events)
  bot.removeListener = events.removeListener.bind(events)
  let digs = 0
  let selectedGoal: { x: number; y: number; z: number; exact: boolean } | null = null
  const probes: Vec3Json[] = []
  bot.dig = async () => { digs += 1 }
  bot.pathfinder.getPathTo = (_movements, goal) => {
    probes.push({ x: goal.x, y: goal.y, z: goal.z })
    return { status: goal.z === 0 ? 'noPath' : 'success', path: [] }
  }
  bot.pathfinder.setGoal = (goal) => {
    if (goal === null) return
    selectedGoal = { x: goal.x, y: goal.y, z: goal.z, exact: goal.constructor.name === 'GoalBlock' }
    queueMicrotask(() => {
      if (goal.z === 0) {
        events.emit('path_update', { status: 'noPath', path: [] })
        return
      }
      bot.entity.position.set(goal.x + 0.5, goal.y, goal.z + 0.5)
      events.emit('goal_reached')
    })
  }
  const executor = new Executor(fixture.bot, new EventLogger(null, false), {
    ...defaultExecutorOptions,
    actuation: 'pathfinder',
  })
  const result = await fixtureClaim(executor, craftCandidate()).completion
  const selected = selectedGoal as { x: number; y: number; z: number; exact: boolean } | null
  const pass =
    result.status === 'done' && result.itemsGained === 1 &&
    probes.length >= 2 && probes.length <= 8 && probes[0]?.z === 0 &&
    selected !== null && selected.z !== 0 && selected.exact &&
    fixture.openCalls.length === 1 && digs === 0
  return { pass, detail: `status=${result.status} probes=${JSON.stringify(probes)} selected=${JSON.stringify(selected)} digs=${digs} opens=${fixture.openCalls.length}` }
})

addCase('(b3) an unrouteable table approach needing a scaffold cut returns typed clearance without digging', async () => {
  const terrain = openTableTerrain()
  for (let x = -7; x <= -3; x += 1) terrain.set(`${x},63,0`, 'stone')
  terrain.set('-5,64,0', 'birch_planks')
  terrain.set('-5,65,0', 'birch_planks')
  const fixture = makeStationBot({ x: -5.5, y: 64, z: 0.5 }, terrain, true)
  let digs = 0
  fixture.bot.dig = async () => { digs += 1 }
  const executor = new Executor(fixture.bot, new EventLogger(null, false), {
    ...defaultExecutorOptions,
    actuation: 'packet',
  })
  const result = await fixtureClaim(executor, craftCandidate()).completion
  const pass = result.status === 'failed' && result.failure === 'path_stuck' &&
    result.detail.includes('separate clearance action') && digs === 0 && fixture.openCalls.length === 0
  return { pass, detail: `failure=${result.failure} detail=${result.detail} digs=${digs} opens=${fixture.openCalls.length}` }
})

// (c) the geometric face for every stand orientation.
addCase('(c) deriveInteractionFace returns the outward face normal for each stand orientation', () => {
  const face = executorModule.deriveInteractionFace
  if (typeof face !== 'function') return { pass: false, detail: 'deriveInteractionFace is not exported' }
  const table: Vec3Json = { x: 5, y: 70, z: 5 }
  const observed = {
    east: face({ x: 6, y: 70, z: 5 }, table),
    west: face({ x: 4, y: 70, z: 5 }, table),
    south: face({ x: 5, y: 70, z: 6 }, table),
    north: face({ x: 5, y: 70, z: 4 }, table),
    top: face({ x: 5, y: 71, z: 5 }, table),
    below: face({ x: 6, y: 69, z: 5 }, table),
  }
  const pass =
    observed.east.x === 1 &&
    observed.west.x === -1 &&
    observed.south.z === 1 &&
    observed.north.z === -1 &&
    observed.top.y === 1 &&
    observed.below.x === 1 &&
    observed.below.y === 0
  return { pass, detail: JSON.stringify(observed) }
})

// (d) the stand filter: passable + supported + face in reach. The search is the
// reach envelope, not a fixed 12-cell adjacency: diagonal and farther cells are
// valid stands when they are passable, supported and in face reach (live v2-n1:
// trunks withheld as standable_approach while open floor stood inside reach).
addCase('(d) interactionStandCandidates requires passable, supported cells and an in-reach face', () => {
  const candidates = executorModule.interactionStandCandidates
  if (typeof candidates !== 'function') return { pass: false, detail: 'interactionStandCandidates is not exported' }
  const table: Vec3Json = { x: 1, y: 64, z: 0 }
  const feet: Vec3Json = { x: 0.5, y: 64, z: 0.5 }
  const probe = {
    passable: (x: number, y: number, z: number) => !(x === 1 && y === 64 && z === 1),
    solidSupport: (x: number, y: number, z: number) => y === 63,
  }
  const near = candidates(table, feet, probe, 4.5)
  const farReach = candidates(table, feet, probe, 0.1)
  const pass =
    near.some((stand) => stand.x === 0 && stand.y === 64 && stand.z === 0) &&
    near.some((stand) => stand.x === 0 && stand.y === 64 && stand.z === 1) &&
    near.some((stand) => stand.x === 3 && stand.y === 64 && stand.z === 0) &&
    !near.some((stand) => stand.x === 1 && stand.y === 64 && stand.z === 1) &&
    farReach.length === 0
  return { pass, detail: `near=[${near.map((s) => `${s.x},${s.y},${s.z}`).join(' ')}] farReach=${farReach.length}` }
})

// (f) Regression (live v2-n1, seed 20260927): a trunk rooted on a rise whose
// ring-1 cells are all covered by a canopy skirt has NO stand under the old
// 12-cell adjacency - every sensed log withheld as `standable_approach` while
// open floor two levels below sat inside face reach. The reach-envelope search
// must return that floor stand.
addCase('(f) a floor stand inside face reach is found when every ring-1 cell is blocked', () => {
  const candidates = executorModule.interactionStandCandidates
  if (typeof candidates !== 'function') return { pass: false, detail: 'interactionStandCandidates is not exported' }
  const trunk: Vec3Json = { x: 10, y: 64, z: 0 }
  const feet: Vec3Json = { x: 10.5, y: 62, z: 3.5 }
  const ring1 = new Set<string>()
  for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    for (const dy of [0, 1, -1] as const) ring1.add(`${10 + ox},${64 + dy},${0 + oz}`)
  }
  const probe = {
    passable: (x: number, y: number, z: number) => !(x === trunk.x && z === trunk.z && y >= trunk.y - 1) && !ring1.has(`${x},${y},${z}`),
    solidSupport: (x: number, y: number, z: number) => y === 61 || (ring1.has(`${x},${y + 1},${z}`) && y >= 62),
  }
  const near = candidates(trunk, feet, probe, 4.5)
  const pass = near.some((stand) => stand.x === 10 && stand.y === 62 && stand.z === 2)
  return { pass, detail: `near=[${near.map((s) => `${s.x},${s.y},${s.z}`).join(' ')}]` }
})

// (e) the wiring: the stand is established and its face reaches openBlock.
addCase('(e) the executor derives the face from the stand and craftWindow forwards it to openBlock', () => {
  const executorSource = readFileSync(fileURLToPath(new URL('./src/executor.ts', import.meta.url)), 'utf8')
  const windowSource = readFileSync(fileURLToPath(new URL('./src/craftWindow.ts', import.meta.url)), 'utf8')
  const delegates = executorSource.includes('craftAtTable(this.bot, table, recipe as unknown as CraftRecipeLike, faceVec)')
  const derives = executorSource.includes('const face = deriveInteractionFace(stand, station)')
  const gates = executorSource.includes('await this.approachPlacedBlock(station, \'crafting_table\', epoch, signal)')
  const forwards = windowSource.includes('bot.openBlock(table, face)')
  const pass = delegates && derives && gates && forwards
  return { pass, detail: `delegates=${delegates} derives=${derives} gates=${gates} forwards=${forwards}` }
})

let failures = 0
process.stdout.write('EXECUTOR station-interaction stand + geometric face\n')
process.stdout.write('-'.repeat(76) + '\n')
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(76) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} station-interaction cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
