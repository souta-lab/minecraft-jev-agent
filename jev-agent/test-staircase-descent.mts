// test-staircase-descent.mts - the descent PLAN shape: one coherent heading, a
// 1x2 dig profile per step, existing routes reused, and typed refusals untouched.
//
// Measured live (run-muc3qbug-18vg3, main ab19403) the descent WORKED but was
// incomprehensible: every step re-picked its heading
//
//   DESCEND:down:W:b7_35_20 | DESCEND:down:N:b8_35_19 | DESCEND:down:W:b7_34_20
//   DESCEND:down:N:b8_34_19 | DESCEND:down:E:b9_33_20 | DESCEND:down:E:b10_32_20
//   heading histogram of the last 60 descend steps: W 23 | E 17 | N 12 | S 8
//
// and each of those steps dug only its floor cell, so the landing cell had no
// clearance: `PATH_CALLBACK phase=failed outcome=noPath` then `stuck`, on every
// cardinal step, followed by the next heading. The result was one hollow bowl per
// Y level instead of a staircase, with no backfill.
//
// The invariants this suite pins:
//   (a) a descent holds ONE heading across consecutive steps, and each step opens
//       the same 1x2 profile (front cell first, landing cell last);
//   (b) a blocked heading changes only WITH a typed reason, and a fully blocked
//       column still retargets a fresh column (the lane-638dc9da behaviour);
//   (c) a descent route the world already has - an opening beside the body or the
//       shaft the body already dug - is offered, not carved over;
//   (d) hazard / unbreakable refusals keep their typed reason and never become a
//       silent heading switch.
//
// No bot, no network.
//
// Run: bun test ./test-staircase-descent.mts
import { defaultCandidateOptions, generateCandidates, strandedOnColumn } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { DigMemory } from './src/worldMemory.ts'
import type { DigDir } from './src/worldMemory.ts'
import { buildWorldState, defaultSensorOptions, descentDigPlan, descentPrimaryCell, makeGoal } from './src/state.ts'
import type {
  AgentSignals,
  DescentDir,
  DescentOption,
  GoalState,
  InventoryState,
  SelfState,
  Vec3Json,
  WorldState,
} from './src/state.ts'
import { createRequire } from 'node:module'
import { Vec3 } from 'vec3'

const require = createRequire(import.meta.url)

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const FEET: Vec3Json = { x: 8.5, y: 63, z: 20.5 }
const FEET_CELL: Vec3Json = { x: 8, y: 63, z: 20 }

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_M3STAIR',
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

function signals(overrides: Partial<AgentSignals> = {}): AgentSignals {
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
    ...overrides,
  }
}

function goal(): GoalState {
  return {
    id: 'g1:descend',
    description: 'descend_to:Y=40',
    targetItem: '',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queued(overrides: Partial<QueuedGoal> = {}): QueuedGoal {
  return {
    id: 'g1:descend',
    kind: 'descend',
    description: 'descend_to:Y=40',
    targetItem: null,
    requiredCount: 0,
    targetY: 40,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
    ...overrides,
  }
}

function queue(current: QueuedGoal = queued()): GoalQueueState {
  return { ...emptyGoalQueueState(), depth: 1, current, empty: false, goals: [current] }
}

const CARDINALS: Array<{ dir: DescentDir; dx: number; dz: number }> = [
  { dir: 'E', dx: 1, dz: 0 },
  { dir: 'W', dx: -1, dz: 0 },
  { dir: 'N', dx: 0, dz: -1 },
  { dir: 'S', dx: 0, dz: 1 },
]

/**
 * One `DescentOption` exactly as `buildDescent` computes it for a solid stone
 * column: the floor cell and the front (wall) cell are both solid and diggable,
 * so the step's 1x2 profile is `[wall, floor]`.
 */
function stoneStep(
  body: Vec3Json,
  dir: DescentDir,
  dx: number,
  dz: number,
  overrides: Partial<DescentOption> = {},
): DescentOption {
  const feet = { x: Math.floor(body.x), y: Math.floor(body.y), z: Math.floor(body.z) }
  const wall = { x: feet.x + dx, y: feet.y, z: feet.z + dz }
  const head = { x: feet.x + dx, y: feet.y + 1, z: feet.z + dz }
  const floor = { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz }
  const own = dx === 0 && dz === 0
  const odd: Vec3Json = { x: -9999, y: -9999, z: -9999 }
  return {
    dir,
    mode: 'down',
    dx,
    dz,
    step: { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz },
    wall: own ? odd : wall,
    head: own ? odd : head,
    floor,
    wallSolid: !own,
    headSolid: !own,
    floorSolid: true,
    supportSolid: true,
    hazardNearby: false,
    digs: own
      ? [{ cell: floor, name: 'stone', harvestTool: 'pickaxe', harvestTier: 0, diggable: true }]
      : [
          { cell: wall, name: 'stone', harvestTool: 'pickaxe', harvestTier: 0, diggable: true },
          { cell: floor, name: 'stone', harvestTool: 'pickaxe', harvestTier: 0, diggable: true },
        ],
    safe: true,
    reason: 'safe',
    digName: 'stone',
    digHarvestTool: 'pickaxe',
    digHarvestTier: 0,
    diggable: true,
    ...overrides,
  }
}

/** The five safe down steps of a solid stone column, in `buildDescent` order. */
function stoneColumn(body: Vec3Json): DescentOption[] {
  return [
    ...CARDINALS.map(({ dir, dx, dz }) => stoneStep(body, dir, dx, dz)),
    stoneStep(body, 'D', 0, 0),
  ]
}

function worldState(overrides: {
  position: Vec3Json
  descent: DescentOption[]
  standable?: Vec3Json[]
  signals?: AgentSignals
  queue?: GoalQueueState
  inventory?: InventoryState
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 1,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position),
    inventory: overrides.inventory ?? inventory({ stone_pickaxe: 1, dirt: 12 }),
    entities: [],
    blocks: [],
    terrain: { standable: overrides.standable ?? [FEET_CELL] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goal(),
    goalQueue: overrides.queue ?? queue(),
    recentEvents: [],
    descent: overrides.descent,
    stepCuts: [],
    headroomCuts: [],
    signals: overrides.signals ?? signals(),
  }
}

function descendOf(candidates: readonly Candidate[]): Candidate | undefined {
  return candidates.find((candidate) => candidate.kind === 'DESCEND')
}

// --- (a) one heading, one profile, step after step --------------------------------

addCase('(a) a 10-step descent down a stone column holds ONE heading', () => {
  const memory = new DigMemory()
  let position: Vec3Json = { ...FEET }
  const headings: string[] = []
  const lines: string[] = []
  for (let step = 0; step < 10; step += 1) {
    const state = worldState({
      position,
      descent: stoneColumn(position),
      signals: signals({ digDir: memory.dir, digDirCount: memory.dirCount }),
    })
    const descend = descendOf(generateCandidates(state, defaultCandidateOptions))
    if (descend === undefined || descend.target === null) break
    headings.push(String(descend.meta.dir))
    lines.push(String(descend.meta.headingLine ?? 'no-heading-line'))
    memory.record({
      x: descend.target.x,
      y: descend.target.y,
      z: descend.target.z,
      dir: descend.meta.dir as DigDir,
      mode: 'down',
      target: null,
      atMs: step,
    })
    // the body lands in the dug cell, exactly as the executor's step does
    position = { x: descend.target.x + 0.5, y: descend.target.y, z: descend.target.z + 0.5 }
  }
  const unique = [...new Set(headings)]
  const held = lines.every((line) => line.includes('held=true'))
  const descending = headings.length === 10 && new Set(headings.map((_, index) => index < 10)).size === 1
  return {
    pass: headings.length === 10 && unique.length === 1 && held && descending,
    detail: `headings=[${headings.join(' ')}] unique=${unique.length} held=${held} lines=${lines[0] ?? 'none'}`,
  }
})

addCase('(a2) every held step opens the same 1x2 profile, passage cell first', () => {
  const state = worldState({ position: FEET, descent: stoneColumn(FEET) })
  const descend = descendOf(generateCandidates(state, defaultCandidateOptions))
  if (descend === undefined) return { pass: false, detail: 'no DESCEND candidate' }
  const cells = String(descend.meta.digCells ?? '').split(';')
  const wall = `${descend.meta.wallX},${descend.meta.wallY},${descend.meta.wallZ}`
  const floor = `${descend.meta.floorX},${descend.meta.floorY},${descend.meta.floorZ}`
  const primary = `${descend.target?.x},${descend.target?.y},${descend.target?.z}`
  return {
    pass:
      descend.meta.digCount === 2 &&
      cells.length === 2 &&
      cells[0] === wall &&
      cells[1] === floor &&
      primary === floor &&
      descend.meta.profileTool === 'pickaxe',
    detail: `cells=[${cells.join(' | ')}] primary=${primary} wall=${wall} floor=${floor} digCount=${String(descend.meta.digCount)} tool=${String(descend.meta.profileTool)}`,
  }
})

addCase('(a3) a goal-grounded descent (not stranded) holds its heading too', () => {
  const memory = new DigMemory()
  let position: Vec3Json = { x: 11.5, y: 63, z: 24.5 }
  const headings: string[] = []
  for (let step = 0; step < 6; step += 1) {
    const state = worldState({
      position,
      descent: stoneColumn(position),
      // a walkable frontier exists, so this is the goal-grounded descent family,
      // not the stranded-column one
      standable: [position, { x: position.x + 3, y: position.y, z: position.z }],
      signals: signals({ digDir: memory.dir, digDirCount: memory.dirCount }),
    })
    const descend = descendOf(generateCandidates(state, defaultCandidateOptions))
    if (descend === undefined || descend.target === null) break
    headings.push(String(descend.meta.dir))
    memory.record({
      x: descend.target.x,
      y: descend.target.y,
      z: descend.target.z,
      dir: descend.meta.dir as DigDir,
      mode: 'down',
      target: null,
      atMs: step,
    })
    position = { x: descend.target.x + 0.5, y: descend.target.y, z: descend.target.z + 0.5 }
  }
  return {
    pass: headings.length === 6 && new Set(headings).size === 1,
    detail: `headings=[${headings.join(' ')}] unique=${new Set(headings).size}`,
  }
})

// --- (b) a heading change is a typed event ---------------------------------------

addCase('(b) a blocked heading changes only WITH the typed obstruction', () => {
  const blocked = stoneStep(FEET, 'E', 1, 0, {
    safe: false,
    reason: 'bedrock wall is not breakable',
    refusal: 'unbreakable',
    digName: 'bedrock',
  })
  const state = worldState({
    position: FEET,
    descent: [blocked, ...CARDINALS.slice(1).map(({ dir, dx, dz }) => stoneStep(FEET, dir, dx, dz)), stoneStep(FEET, 'D', 0, 0)],
    signals: signals({ digDir: 'E', digDirCount: 2 }),
  })
  const descend = descendOf(generateCandidates(state, defaultCandidateOptions))
  if (descend === undefined) return { pass: false, detail: 'no DESCEND candidate' }
  const line = String(descend.meta.headingLine ?? '')
  return {
    pass:
      descend.meta.dir === 'W' &&
      descend.meta.planHeadingHeld === false &&
      descend.meta.headingChangeFrom === 'E' &&
      descend.meta.headingChangeReason === 'unbreakable' &&
      descend.meta.headingChangeCell === `${blocked.floor.x},${blocked.floor.y},${blocked.floor.z}` &&
      descend.meta.headingChangeBlock === 'bedrock' &&
      line === `DESCEND_HEADING dir=W held=false from=E reason=unbreakable cell=${blocked.floor.x},${blocked.floor.y},${blocked.floor.z} block=bedrock`,
    detail: `dir=${String(descend.meta.dir)} line=${line}`,
  }
})

addCase('(b2) a safe held heading is never re-picked', () => {
  const state = worldState({
    position: FEET,
    descent: stoneColumn(FEET),
    signals: signals({ digDir: 'N', digDirCount: 3 }),
  })
  const descend = descendOf(generateCandidates(state, defaultCandidateOptions))
  if (descend === undefined) return { pass: false, detail: 'no DESCEND candidate' }
  return {
    pass:
      descend.meta.dir === 'N' &&
      descend.meta.planHeading === 'N' &&
      descend.meta.planHeadingHeld === true &&
      descend.meta.headingChangeReason === undefined &&
      String(descend.meta.headingLine) === 'DESCEND_HEADING dir=N held=true',
    detail: `dir=${String(descend.meta.dir)} line=${String(descend.meta.headingLine)}`,
  }
})

addCase('(b3) a fully blocked column still retargets a fresh standable column', () => {
  const blocked = (dir: DescentDir, dx: number, dz: number): DescentOption =>
    stoneStep(FEET, dir, dx, dz, {
      safe: false,
      reason: 'lava/water in the step column',
      refusal: 'hazard',
    })
  const state = worldState({
    position: FEET,
    descent: [...CARDINALS.map(({ dir, dx, dz }) => blocked(dir, dx, dz)), blocked('D', 0, 0)],
    standable: [FEET_CELL, { x: 4, y: 62, z: 20 }, { x: 13, y: 64, z: 21 }],
    signals: signals({ digDir: 'S', digDirCount: 4 }),
  })
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const retarget = candidates.find((candidate) => candidate.meta.descendRetarget === true)
  return {
    pass:
      descendOf(candidates) === undefined &&
      retarget !== undefined &&
      retarget.kind === 'MOVE' &&
      retarget.target?.x === 4 &&
      retarget.target?.y === 62 &&
      retarget.meta.verticalRecovery === 'descent_retarget',
    detail: `set=[${candidates.map((candidate) => candidate.id).join(',')}] retarget=${retarget?.id ?? 'none'}`,
  }
})

// --- (c) routes the world already has are offered, not carved over ----------------

addCase('(c) an existing opening beside the body is offered as a step-down route', () => {
  const open = stoneStep(FEET, 'E', 1, 0, {
    safe: false,
    reason: 'floor already open (uncontrolled fall)',
    refusal: 'open_floor',
    floorSolid: false,
    wallSolid: false,
    diggable: false,
    digName: null,
    digHarvestTool: null,
    digHarvestTier: null,
    digs: [],
  })
  const state = worldState({
    position: FEET,
    descent: [open, ...CARDINALS.slice(1).map(({ dir, dx, dz }) => stoneStep(FEET, dir, dx, dz)), stoneStep(FEET, 'D', 0, 0)],
  })
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const shaft = candidates.find((candidate) => candidate.meta.verticalRecovery === 'open_shaft_step')
  return {
    pass:
      shaft !== undefined &&
      shaft.kind === 'MOVE' &&
      shaft.target?.x === open.step.x &&
      shaft.target?.y === open.step.y &&
      shaft.target?.z === open.step.z &&
      // the new dig step is still on offer: reuse is enumeration order, not a ranking
      descendOf(candidates) !== undefined,
    detail: `set=[${candidates.map((candidate) => candidate.id).join(',')}] shaft=${shaft?.id ?? 'none'}`,
  }
})

addCase('(c2) an opening with lava next to it is never offered as a route', () => {
  const open = stoneStep(FEET, 'E', 1, 0, {
    safe: false,
    reason: 'floor already open (uncontrolled fall)',
    refusal: 'open_floor',
    floorSolid: false,
    wallSolid: false,
    hazardNearby: true,
    diggable: false,
    digName: null,
    digHarvestTool: null,
    digHarvestTier: null,
    digs: [],
  })
  const state = worldState({ position: FEET, descent: [open] })
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const shaft = candidates.find((candidate) => candidate.meta.verticalRecovery === 'open_shaft_step')
  return {
    pass: shaft === undefined,
    detail: `set=[${candidates.map((candidate) => candidate.id).join(',')}] shaft=${shaft?.id ?? 'none'}`,
  }
})

addCase('(c3) the shaft the body already dug is offered as a remembered route', () => {
  const state = worldState({
    position: FEET,
    descent: [...CARDINALS.map(({ dir, dx, dz }) => stoneStep(FEET, dir, dx, dz)), stoneStep(FEET, 'D', 0, 0)],
    signals: signals({ lastTunnel: { x: 8, y: 60, z: 20 } }),
  })
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const shaft = candidates.find((candidate) => candidate.meta.verticalRecovery === 'remembered_shaft')
  return {
    pass:
      shaft !== undefined &&
      shaft.kind === 'MOVE' &&
      shaft.target?.y === 60 &&
      shaft.meta.vertical === 'reuse' &&
      shaft.meta.tunnelY === 60,
    detail: `set=[${candidates.map((candidate) => candidate.id).join(',')}] shaft=${shaft?.id ?? 'none'} vertical=${String(shaft?.meta.vertical)}`,
  }
})

// --- (d) typed refusals are unchanged ---------------------------------------------

addCase('(d) a hazard-refused heading reports hazard, and no step is offered', () => {
  const hazard = (dir: DescentDir, dx: number, dz: number): DescentOption =>
    stoneStep(FEET, dir, dx, dz, {
      safe: false,
      reason: 'lava/water in the step column',
      refusal: 'hazard',
      digName: 'lava',
    })
  const state = worldState({
    position: FEET,
    descent: [stoneStep(FEET, 'E', 1, 0), hazard('W', -1, 0), hazard('N', 0, -1), hazard('S', 0, 1)],
    signals: signals({ digDir: 'W', digDirCount: 5 }),
  })
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const descend = descendOf(candidates)
  return {
    pass:
      descend !== undefined &&
      descend.meta.dir === 'E' &&
      descend.meta.headingChangeReason === 'hazard' &&
      descend.meta.headingChangeBlock === 'lava' &&
      candidates.every((candidate) => candidate.kind !== 'DESCEND' || candidate.meta.safe === true),
    detail: `dir=${String(descend?.meta.dir)} reason=${String(descend?.meta.headingChangeReason)} set=[${candidates.map((candidate) => candidate.id).join(',')}]`,
  }
})

addCase('(d2) an unbreakable held heading is reported as unbreakable, not as a fallback', () => {
  const state = worldState({
    position: FEET,
    descent: [
      stoneStep(FEET, 'E', 1, 0, {
        safe: false,
        reason: 'obsidian floor is not breakable',
        refusal: 'unbreakable',
        digName: 'obsidian',
      }),
      stoneStep(FEET, 'N', 0, -1),
    ],
    signals: signals({ digDir: 'E', digDirCount: 1 }),
  })
  const descend = descendOf(generateCandidates(state, defaultCandidateOptions))
  return {
    pass:
      descend !== undefined &&
      descend.meta.dir === 'N' &&
      descend.meta.headingChangeReason === 'unbreakable' &&
      descend.meta.headingChangeBlock === 'obsidian' &&
      descend.meta.headingChangeFrom === 'E',
    detail: `dir=${String(descend?.meta.dir)} reason=${String(descend?.meta.headingChangeReason)} block=${String(descend?.meta.headingChangeBlock)}`,
  }
})

addCase('(d3) a stranded body with no safe step keeps its typed refusal and no DESCEND', () => {
  const unsafe = CARDINALS.map(({ dir, dx, dz }) =>
    stoneStep(FEET, dir, dx, dz, { safe: false, reason: 'no solid support', refusal: 'no_support' }),
  )
  const state = worldState({ position: FEET, descent: unsafe, inventory: inventory({ dirt: 5 }) })
  const grounded = generateCandidates(state, defaultCandidateOptions)
  return {
    pass:
      strandedOnColumn(state) &&
      grounded.every((candidate) => candidate.kind === 'WAIT') &&
      descendOf(grounded) === undefined,
    detail: `stranded=${strandedOnColumn(state)} set=[${grounded.map((candidate) => candidate.id).join(',')}]`,
  }
})

// --- (s) the SENSOR's own geometry, from block truth ------------------------------
//
// Everything above builds `DescentOption`s by hand; these cases run the real
// `buildDescent` (via `buildWorldState`) against a block-truth double, so the
// 1x2 profile is pinned where it is actually computed.

type SensorBot = Parameters<typeof buildWorldState>[0]

/** A block-truth double: every cell of `solid` is stone unless overridden. */
function solidStoneBot(
  feet: Vec3Json,
  overrides: Record<string, { name: string; diggable?: boolean; boundingBox?: 'block' | 'empty' }>,
): SensorBot {
  const position = new Vec3(feet.x + 0.5, feet.y, feet.z + 0.5)
  const cell = (p: { x: number; y: number; z: number }): string =>
    `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
  const stone = new Set<string>()
  for (let x = feet.x - 3; x <= feet.x + 3; x += 1) {
    for (let y = feet.y - 4; y <= feet.y + 3; y += 1) {
      for (let z = feet.z - 3; z <= feet.z + 3; z += 1) stone.add(`${x},${y},${z}`)
    }
  }
  // the body itself stands in an air pocket, as it does in the live shaft
  stone.delete(`${feet.x},${feet.y},${feet.z}`)
  stone.delete(`${feet.x},${feet.y + 1},${feet.z}`)
  stone.delete(`${feet.x},${feet.y + 2},${feet.z}`)
  return {
    username: 'AI_STAIR_SENSOR',
    entity: { id: 3, position, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 20,
    food: 20,
    game: { gameMode: 'survival', dimension: 'overworld', minY: -64, height: 384 },
    time: { isDay: true },
    registry: require('minecraft-data')('1.21.11'),
    entities: {},
    inventory: { items: () => [{ name: 'stone_pickaxe', count: 1, slot: 0 }] },
    blockAt: (p: { x: number; y: number; z: number }) => {
      const key = cell(p)
      const override = overrides[key]
      if (override !== undefined) {
        return {
          name: override.name,
          boundingBox: override.boundingBox ?? 'block',
          diggable: override.diggable ?? (override.boundingBox === 'empty' ? false : true),
        }
      }
      if (stone.has(key)) return { name: 'stone', boundingBox: 'block', diggable: true }
      return { name: 'air', boundingBox: 'empty', diggable: false }
    },
    canSeeBlock: () => true,
    findBlocks: () => [],
  } as never
}

function sensed(
  feet: Vec3Json,
  overrides: Record<string, { name: string; diggable?: boolean; boundingBox?: 'block' | 'empty' }> = {},
): WorldState {
  return buildWorldState(
    solidStoneBot(feet, overrides),
    {
      tick: 1,
      goal: makeGoal('raw_iron', 1),
      goalQueue: queue(queued({ targetItem: 'raw_iron', targetY: 40 })),
      focusItem: 'raw_iron',
      recentEvents: [],
      signals: signals(),
      rememberedStations: [],
    },
    defaultSensorOptions,
  )
}

function descentOption(state: WorldState, dir: DescentDir, mode: 'down' | 'level'): DescentOption | undefined {
  return (state.descent ?? []).find((step) => step.dir === dir && step.mode === mode)
}

addCase('(s1) a solid stone column senses a 1x2 profile: front cell then landing cell', () => {
  const feet: Vec3Json = { x: 8, y: 63, z: 20 }
  const state = sensed(feet)
  const e = descentOption(state, 'E', 'down')
  const own = descentOption(state, 'D', 'down')
  if (e === undefined || own === undefined) return { pass: false, detail: 'sensor produced no down step' }
  const cells = descentDigPlan(e).map((item) => `${item.cell.x},${item.cell.y},${item.cell.z}`)
  const ownCells = descentDigPlan(own).map((item) => `${item.cell.x},${item.cell.y},${item.cell.z}`)
  const primary = descentPrimaryCell(e)
  return {
    pass:
      e.safe === true &&
      cells.length === 2 &&
      cells[0] === `${e.wall.x},${e.wall.y},${e.wall.z}` &&
      cells[1] === `${e.floor.x},${e.floor.y},${e.floor.z}` &&
      primary.x === e.floor.x &&
      primary.y === e.floor.y &&
      e.supportSolid === true &&
      e.hazardNearby === false &&
      descentDigPlan(e).every((item) => item.diggable && item.harvestTool === 'pickaxe') &&
      // the own-column dig never includes a cell the body occupies
      ownCells.length === 1 &&
      ownCells[0] === `${own.floor.x},${own.floor.y},${own.floor.z}`,
    detail: `E=[${cells.join(' | ')}] primary=${primary.x},${primary.y},${primary.z} support=${String(e.supportSolid)} own=[${ownCells.join(' | ')}]`,
  }
})

addCase('(s2) a level step senses the 2-high corridor, front cell last', () => {
  const feet: Vec3Json = { x: 8, y: 63, z: 20 }
  const state = sensed(feet)
  const e = descentOption(state, 'E', 'level')
  if (e === undefined) return { pass: false, detail: 'sensor produced no level step' }
  const cells = descentDigPlan(e).map((item) => `${item.cell.x},${item.cell.y},${item.cell.z}`)
  const primary = descentPrimaryCell(e)
  return {
    pass:
      e.safe === true &&
      cells.length === 2 &&
      cells[0] === `${e.head.x},${e.head.y},${e.head.z}` &&
      cells[1] === `${e.wall.x},${e.wall.y},${e.wall.z}` &&
      primary.x === e.wall.x &&
      primary.y === e.wall.y,
    detail: `E-level=[${cells.join(' | ')}] primary=${primary.x},${primary.y},${primary.z}`,
  }
})

addCase('(s3) an already-open floor with support underneath senses as a step-down opening', () => {
  const feet: Vec3Json = { x: 8, y: 63, z: 20 }
  // open the cell the body would land in (E, y=62); the cell below it stays solid
  const state = sensed(feet, { '9,62,20': { name: 'air', boundingBox: 'empty', diggable: false } })
  const e = descentOption(state, 'E', 'down')
  if (e === undefined) return { pass: false, detail: 'sensor produced no E down step' }
  return {
    pass:
      e.refusal === 'open_floor' &&
      e.supportSolid === true &&
      e.hazardNearby === false &&
      e.floorSolid === false &&
      descentDigPlan(e).map((item) => `${item.cell.x},${item.cell.y},${item.cell.z}`).join(';') ===
        `${e.wall.x},${e.wall.y},${e.wall.z}`,
    detail: `refusal=${String(e.refusal)} support=${String(e.supportSolid)} hazard=${String(e.hazardNearby)} digs=[${descentDigPlan(e).map((item) => `${item.cell.x},${item.cell.y},${item.cell.z}`).join(' | ')}]`,
  }
})

addCase('(s4) lava beside a solid step senses hazardNearby, not just the typed refusal', () => {
  const feet: Vec3Json = { x: 8, y: 63, z: 20 }
  const state = sensed(feet, { '9,62,21': { name: 'lava', boundingBox: 'empty', diggable: false } })
  const e = descentOption(state, 'E', 'down')
  if (e === undefined) return { pass: false, detail: 'sensor produced no E down step' }
  return {
    pass: e.safe === false && e.refusal === 'hazard' && e.hazardNearby === true,
    detail: `safe=${String(e.safe)} refusal=${String(e.refusal)} hazard=${String(e.hazardNearby)}`,
  }
})

addCase('(s5) an unbreakable landing cell refuses the whole step (unbreakable)', () => {
  const feet: Vec3Json = { x: 8, y: 63, z: 20 }
  const state = sensed(feet, { '9,62,20': { name: 'bedrock', diggable: false } })
  const e = descentOption(state, 'E', 'down')
  const candidates = generateCandidates(state, defaultCandidateOptions)
  if (e === undefined) return { pass: false, detail: 'sensor produced no E down step' }
  const carved = candidates.find(
    (candidate) =>
      candidate.kind === 'DESCEND' &&
      candidate.meta.mode === 'down' &&
      candidate.target?.x === 9 &&
      candidate.target?.y === 62 &&
      candidate.target?.z === 20,
  )
  return {
    pass: e.safe === false && e.refusal === 'unbreakable' && carved === undefined,
    detail: `safe=${String(e.safe)} refusal=${String(e.refusal)} carvedE=${carved?.id ?? 'none'}`,
  }
})

addCase('(s6) a sensed open shaft mouth is offered as a step-down route end to end', () => {
  const feet: Vec3Json = { x: 8, y: 63, z: 20 }
  const state = sensed(feet, {
    '9,63,20': { name: 'air', boundingBox: 'empty', diggable: false },
    '9,62,20': { name: 'air', boundingBox: 'empty', diggable: false },
  })
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const shaft = candidates.find((candidate) => candidate.meta.verticalRecovery === 'open_shaft_step')
  return {
    pass:
      shaft !== undefined &&
      shaft.kind === 'MOVE' &&
      shaft.target?.x === 9 &&
      shaft.target?.y === 62 &&
      shaft.target?.z === 20,
    detail: `set=[${candidates.map((candidate) => candidate.id).join(',')}] shaft=${shaft?.id ?? 'none'}`,
  }
})

let failures = 0
process.stdout.write('staircase descent: one heading, one 1x2 profile, typed changes\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} staircase-descent cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
