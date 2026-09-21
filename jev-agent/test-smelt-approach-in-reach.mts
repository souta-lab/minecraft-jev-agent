// test-smelt-approach-in-reach.mts - EXECUTOR SMELT already-in-reach defect.
//
// LIVE BLOCKER (source d8d53c2, measured. The resident was farming the M2
// `flint_and_steel` chain and wedged on an iron smelt):
//   bot feet (8.7, 65.0, -9.3), rung=nether_portal, queue=`smelt 1 x iron_ingot`
//   target station (10, 65, -9) - server console proved it is a REAL unlit
//   `minecraft:furnace` (not stale station memory)
//   (9, 65, -9) AIR, (9, 66, -9) AIR, (10, 66, -9) AIR
//   floors (8,64,-9), (9,64,-9), (10,64,-9) all solid
//   `SMELT:iron_ingot key=overworld:10,65,-9 attempts=81 reason=stuck kind=SMELT`
//   `PATH_CALLBACK phase=failed actionId=SMELT:iron_ingot`
//   `LOCAL_PROGRESS_STALL stalledMs=73354 goal=smelt:iron_ingot:1`
//
// Root cause (executor mechanics only; no semantic/policy question): the bot's
// feet cell is (8,65,-10) - DIAGONAL to the furnace - so the exact-cell
// interaction-stand test in `approachPlacedBlock` (`standAt` over
// `interactionStandCandidates`, which only enumerates the four ORTHOGONAL
// neighbours) returns null and the executor insists on pathing to the free
// orthogonal stand (9,65,-9). That node is 0.42 m away, so the stock
// `GoalNear(dest, 1)` is already satisfied and can only report `reached`
// WITHOUT moving; the control-nudge fallback pivots on the same exact-cell
// predicate, so the approach can never complete. After the bounded nudge
// budget it throws `path_stuck`, the identical candidate is re-offered, and the
// live loop repeats byte-identically.
//
// Meanwhile the furnace face is already inside vanilla interaction reach from
// the live body: eye (8.7,66.62,-9.3) -> furnace AABB is ~1.47 m (reach 4.5).
//
// The fix treats the live body cell as a valid interaction stand when it sits at
// one of the block's three stand levels, is passable/supported, and the live
// eye->AABB face distance is in reach - so a diagonal-but-interactable furnace
// needs no path at all. `path_stuck` is still the typed outcome when the body is
// genuinely out of reach or below the stand levels.
//
// This suite drives the real Executor over a structural fake bot:
//   (1) the live geometry (diagonal, face in reach, a valid orthogonal stand
//       0.42 m away, pathfinder/controls that cannot move the body) opens the
//       furnace and smelts - RED before the fix (`path_stuck`, furnace never
//       opened);
//   (2) a normal already-on-the-stand approach still opens and smelts;
//   (3) a body genuinely BELOW the stand levels (dy=-2) stays the typed
//       fail-fast `path_stuck` and never opens a window;
//   (4) the pure stand geometry: the live stand cell is a real
//       `interactionStandCandidates` cell and the live eye is in reach.
//
// Run: bun --test test-smelt-approach-in-reach.mts
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import { Executor, EventLogger, defaultExecutorOptions } from './src/index.ts'
import { deriveInteractionFace, interactionStandCandidates } from './src/executor.ts'
import { faceDistanceFromEye } from './src/reachability.ts'
import type { Candidate, Vec3Json } from './src/index.ts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')

/** The live target station (a real furnace verified on the server). */
const FURNACE: Vec3Json = { x: 10, y: 65, z: -9 }
/** The live body position (feet). */
const LIVE_FEET: Vec3Json = { x: 8.7, y: 65, z: -9.3 }
/** A body already standing on a valid orthogonal interaction stand. */
const STAND_FEET: Vec3Json = { x: 9.5, y: 65, z: -8.5 }

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
  position: P
}

interface ItemEntry {
  name: string
  type: number
  count: number
  slot: number
}

interface SmeltBotFixture {
  bot: Bot
  openCalls: Array<Vec3Json | null>
  position: P
  ironIngots: () => number
}

/**
 * A structural bot with only what the SMELT path reads: the block grid, the
 * entity feet, the registry, a pathfinder that never moves the body and an
 * `openFurnace` that records the block it was asked to open and returns a
 * furnace window which smelts one `raw_iron` into one `iron_ingot`.
 */
function makeSmeltBot(feet: Vec3Json, blocks: Map<string, string>): SmeltBotFixture {
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`
  const position = new P(feet.x, feet.y, feet.z)
  const openCalls: Array<Vec3Json | null> = []
  const items = registry.itemsByName as Record<string, { id: number }>
  const rawIronId = items.raw_iron?.id ?? 0
  const coalId = items.coal?.id ?? 0
  const ironId = items.iron_ingot?.id ?? 0
  const inventory: ItemEntry[] = [
    { name: 'raw_iron', type: rawIronId, count: 3, slot: 0 },
    { name: 'coal', type: coalId, count: 2, slot: 1 },
  ]
  const blockAt = (v: { x: number; y: number; z: number }): FakeBlock | null => {
    const name = blocks.get(key(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)))
    if (name === undefined) return null
    return {
      name,
      boundingBox: name === 'air' ? 'empty' : 'block',
      position: new P(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)),
    }
  }

  const bot = {
    registry,
    entity: {
      position,
      velocity: new P(0, 0, 0),
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
    physicsEnabled: false,
    entities: {},
    inventory: {
      count: (id: number) => inventory.filter((entry) => entry.type === id).reduce((sum, entry) => sum + entry.count, 0),
      items: (): ItemEntry[] => inventory.filter((entry) => entry.count > 0),
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
    openFurnace: async (block: FakeBlock): Promise<unknown> => {
      openCalls.push({ x: block.position.x, y: block.position.y, z: block.position.z })
      const slots: Array<{ name: string; type: number; count: number } | null> = [null, null, null]
      const take = (name: string, type: number, count: number): void => {
        const existing = inventory.find((entry) => entry.name === name)
        if (existing === undefined) inventory.push({ name, type, count, slot: inventory.length })
        else existing.count += count
      }
      return {
        slots,
        inputItem: (): { name: string; type: number; count: number } | null => slots[0] ?? null,
        fuelItem: (): { name: string; type: number; count: number } | null => slots[1] ?? null,
        outputItem: (): { name: string; type: number; count: number } | null => slots[2] ?? null,
        putInput: async (type: number, _metadata: number | null, count: number): Promise<void> => {
          const entry = inventory.find((candidate) => candidate.type === type)
          if (entry !== undefined) entry.count -= count
          // The live furnace consumes one input per fuel and produces one output.
          slots[0] = null
          slots[2] = { name: 'iron_ingot', type: ironId, count }
        },
        putFuel: async (type: number, _metadata: number | null, count: number): Promise<void> => {
          const entry = inventory.find((candidate) => candidate.type === type)
          if (entry !== undefined) entry.count -= count
          slots[1] = { name: 'coal', type, count: 1 }
        },
        takeOutput: async (): Promise<void> => {
          const output = slots[2] ?? null
          if (output !== null) take(output.name, output.type, output.count)
          slots[2] = null
        },
        takeInput: async (): Promise<void> => {
          slots[0] = null
        },
        close: (): void => undefined,
      }
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

  return {
    bot: bot as unknown as Bot,
    openCalls,
    position,
    ironIngots: () => inventory.find((entry) => entry.name === 'iron_ingot')?.count ?? 0,
  }
}

function smeltCandidate(): Candidate {
  return {
    id: 'SMELT:iron_ingot',
    kind: 'SMELT',
    label: `smelt 1x iron_ingot from raw_iron in the furnace at (${FURNACE.x},${FURNACE.y},${FURNACE.z}) using coal`,
    targetName: 'iron_ingot',
    target: { x: FURNACE.x, y: FURNACE.y, z: FURNACE.z },
    targetEntityId: null,
    itemName: 'iron_ingot',
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: {
      inputItem: 'raw_iron',
      inputCount: 1,
      fuelItem: 'coal',
      fuelCount: 1,
      furnaceSource: 'sensed',
    },
  }
}

/**
 * The live terrain: solid floor at y=64 (covers the live feet cell (8,65,-10)
 * and the orthogonal stand (9,65,-9)) and the real furnace at (10,65,-9).
 * Everything else is open air.
 */
function liveTerrain(): Map<string, string> {
  const blocks = new Map<string, string>()
  for (let x = 5; x <= 14; x += 1) for (let z = -14; z <= -4; z += 1) blocks.set(`${x},64,${z}`, 'stone')
  blocks.set(`${FURNACE.x},${FURNACE.y},${FURNACE.z}`, 'furnace')
  return blocks
}

async function runSmelt(feet: Vec3Json): Promise<{ fixture: SmeltBotFixture; result: Awaited<ReturnType<Executor['claim']>['completion']> }> {
  const fixture = makeSmeltBot(feet, liveTerrain())
  const executor = new Executor(fixture.bot, new EventLogger(null, false), {
    ...defaultExecutorOptions,
    actuation: 'packet',
    packetStepMs: 1,
    maxStepsPerWaypoint: 5,
  })
  const result = await executor.claim(smeltCandidate()).completion
  return { fixture, result }
}

let failures = 0
async function check(label: string, ok: boolean, detail: string): Promise<void> {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

async function main(): Promise<void> {
  process.stdout.write('SMELT approach: an already-in-reach furnace needs no path\n')
  process.stdout.write('-'.repeat(78) + '\n')

  // (1) The exact live geometry. Before the fix the exact-cell stand test
  // rejects the diagonal feet cell, the pathfinder's GoalNear is already
  // satisfied, and the approach wedges to `path_stuck` without opening the
  // furnace. After the fix the live face distance decides, no path is issued,
  // and the smelt completes.
  {
    const { fixture, result } = await runSmelt(LIVE_FEET)
    await check(
      '(1) diagonal feet with the furnace face in reach opens the furnace and smelts (live d8d53c2 geometry)',
      result.status === 'done' &&
        result.verified === true &&
        result.failure === null &&
        fixture.openCalls.length === 1 &&
        fixture.openCalls[0]?.x === FURNACE.x &&
        fixture.openCalls[0]?.y === FURNACE.y &&
        fixture.openCalls[0]?.z === FURNACE.z &&
        fixture.ironIngots() === 1,
      `status=${result.status} verified=${result.verified} failure=${result.failure} openCalls=${JSON.stringify(fixture.openCalls)} iron=${fixture.ironIngots()} detail=${result.detail}`,
    )
  }

  // (2) Normal approach: the body already stands on the valid orthogonal stand
  // (9,65,-9) -> unchanged behaviour, still opens and smelts.
  {
    const { fixture, result } = await runSmelt(STAND_FEET)
    await check(
      '(2) a body already on the orthogonal interaction stand still opens the furnace and smelts',
      result.status === 'done' && result.verified === true && fixture.openCalls.length === 1 && fixture.ironIngots() === 1,
      `status=${result.status} verified=${result.verified} openCalls=${JSON.stringify(fixture.openCalls)} iron=${fixture.ironIngots()} detail=${result.detail}`,
    )
  }

  // (3) Genuinely below the stand levels (dy=-2): the live position is NOT a
  // valid stand level, so the typed fail-fast is preserved and no window opens.
  // This is the RC9 class the strict stand geometry was added for.
  {
    const { fixture, result } = await runSmelt({ x: 9.5, y: 63, z: -8.5 })
    await check(
      '(3) a body two levels below still fails fast with path_stuck and never opens the furnace',
      result.status === 'failed' && result.failure === 'path_stuck' && fixture.openCalls.length === 0,
      `status=${result.status} failure=${result.failure} openCalls=${fixture.openCalls.length} detail=${result.detail}`,
    )
  }

  // (4) Pure geometry: (9,65,-9) is a real interaction stand for the furnace
  // and the live eye->furnace-AABB distance is inside reach, which is exactly
  // why no path is required.
  {
    const stands = interactionStandCandidates(
      FURNACE,
      { x: LIVE_FEET.x, y: LIVE_FEET.y, z: LIVE_FEET.z },
      {
        passable: (x, y, z) => !(x === FURNACE.x && y === FURNACE.y && z === FURNACE.z),
        solidSupport: (x, y, z) => y === 63 || y === 64,
      },
      4.5,
    )
    const face = faceDistanceFromEye({ x: LIVE_FEET.x, y: LIVE_FEET.y + 1.62, z: LIVE_FEET.z }, FURNACE)
    const derived = deriveInteractionFace({ x: Math.floor(LIVE_FEET.x), y: 65, z: Math.floor(LIVE_FEET.z) }, FURNACE)
    await check(
      '(4) the live stand cell is a valid interaction stand and the live eye->furnace face is in reach',
      stands.some((stand) => stand.x === 9 && stand.y === 65 && stand.z === -9) &&
        face <= 4.5 &&
        derived.x === -1 &&
        derived.y === 0 &&
        derived.z === 0,
      `stands=[${stands.map((s) => `${s.x},${s.y},${s.z}`).join(' ')}] face=${face.toFixed(2)} derivedFace=${JSON.stringify(derived)}`,
    )
  }

  process.stdout.write('-'.repeat(78) + '\n')
  process.stdout.write(`smelt-approach-in-reach: ${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}\n`)
  if (failures > 0) process.exit(1)
}

await main()
