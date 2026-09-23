// test-canopy-ground.mts - a leaf canopy is not a destination, a placement site
// or a landing.
//
// Live incident (operator screenshot, run-mubobiq6-12onv, source 220b9db,
// m3-live): a hungry body (`food = 0` held for hours) was photographed standing
// on a cobblestone block at treetop height, digging leaves and clambering around
// at y=74-78, while it held 38 logs and its `rung=crafting_table` objective
// starved with `missing=["column_descent:no_safe_step"]`. World truth from the
// region file of the chunk it occupied: `oak_leaves=313` around y=68-84 and a
// 4-block cobblestone pillar (76,72..75,12) built up through the canopy.
//
// Root cause (STATIC, two layers):
//
//   * `state.ts` `isSolidSupport` accepted ANY `boundingBox === 'block'` cell as
//     support. A leaf block has `boundingBox === 'block'`, so every treetop cell
//     was "standable" - which made it terrain (a MOVE/explore/retreat
//     destination), a `placementSpots` site, and the landing of a safe
//     `staircase-up` cut. Live shape: `STEP:N:b75_78_8 phase=digging` dug leaves
//     to climb the canopy, and world truth holds the cobblestone pillar.
//   * `candidates.ts` `foodHabitatAscent` fired whenever the body was hungry with
//     no sensed animal, and its target Y came from `highestKnownSurfaceY`, which
//     read REMEMBERED stations anywhere in the world. A remembered
//     `crafting_table` at (-50,79,-7) raised the own-column habitat target to
//     y=79, so the hungry body pillared straight up toward an altitude that had
//     nothing to do with where it stood.
//
// The fix keeps `isStandable` as pure locomotion truth (standing on leaves is
// legal in vanilla and walking across a canopy must stay possible) and adds the
// missing LOAD-BEARING distinction (`isUsableGroundSupport` / `isUsableStand`),
// used by the destination, placement-site and step-landing layers; the habitat
// arm additionally only fires below the animal band and only trusts a SENSED
// local surface.
//
// Cases:
//   (a) body under/atop a leaf canopy with no food source above  -> no habitat
//       ascent into the canopy, no placement on leaves, no canopy destination
//   (b) a genuine destination above (ground step-up / pillar on real ground)
//       -> unchanged ascent
//   (c) placement on solid ground -> unchanged
//   (d) the starved objective either gets a route or ONE typed escalation
//
// Run: bun test-canopy-ground.mts
import { createRequire } from 'node:module'
import { defaultCandidateOptions, formatFoodHabitatRefused, generateGroundedCandidates } from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import { ANIMAL_HABITAT_SEA_LEVEL, FOOD_HABITAT_REFUSED } from './src/candidates.ts'
import { candidateStarvationLine } from './src/controller.ts'
import { createRecipeIndex } from './src/crafting.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import {
  buildWorldState,
  defaultSensorOptions,
  isCanopyBlockName,
  isUsableGroundSupport,
  makeGoal,
} from './src/state.ts'
import type { AgentSignals, KnownResource, Vec3Json, WorldState } from './src/state.ts'
import { evaluateCandidateStarvationBoundary } from './src/system2Escalation.ts'
import { evaluatePillarStep } from './src/verticalPlan.ts'

const require = createRequire(import.meta.url)
const Vec3 = require('vec3')
const registry = require('minecraft-data')('1.21.11')
const recipeIndex = createRecipeIndex(registry)

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

type Bot = Parameters<typeof buildWorldState>[0]

/** Minecraft truth for the few blocks these fixtures need. */
const BLOCKS: Record<string, { boundingBox: string; diggable: boolean }> = {
  air: { boundingBox: 'empty', diggable: false },
  water: { boundingBox: 'empty', diggable: false },
  oak_leaves: { boundingBox: 'block', diggable: true },
  birch_leaves: { boundingBox: 'block', diggable: true },
  dirt: { boundingBox: 'block', diggable: true },
  grass_block: { boundingBox: 'block', diggable: true },
  stone: { boundingBox: 'block', diggable: true },
  cobblestone: { boundingBox: 'block', diggable: true },
  crafting_table: { boundingBox: 'block', diggable: true },
  oak_log: { boundingBox: 'block', diggable: true },
}

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`
const nameAt = (grid: Map<string, string>, x: number, y: number, z: number): string =>
  grid.get(key(x, y, z)) ?? 'air'
const supportIsCanopy = (grid: Map<string, string>, cell: Vec3Json): boolean =>
  isCanopyBlockName(nameAt(grid, cell.x, cell.y - 1, cell.z))

/**
 * A block-grid bot double: `grid` holds every non-air cell, everything else
 * reads as air. `findBlocks` answers the sensor's name scans from the same grid,
 * so sensed stations/logs are real perception facts here. The real
 * minecraft-data registry is attached so block names, harvest families and
 * entity kinds resolve exactly as they do live.
 */
function gridBot(
  grid: Map<string, string>,
  self: { position: Vec3Json; food?: number; counts?: Record<string, number> },
): Bot {
  const position = new Vec3(self.position.x, self.position.y, self.position.z)
  const items = Object.entries(self.counts ?? {}).map(([name, count], slot) => ({ name, count, slot }))
  const blockAt = (point: { x: number; y: number; z: number }) => {
    const x = Math.floor(point.x)
    const y = Math.floor(point.y)
    const z = Math.floor(point.z)
    const name = nameAt(grid, x, y, z)
    const shape = BLOCKS[name] ?? BLOCKS.air
    return { name, ...shape, position: new Vec3(x, y, z) }
  }
  return {
    username: 'AI_CANOPY',
    entity: { id: 1, position, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 20,
    food: self.food ?? 20,
    game: { gameMode: 'survival', dimension: 'minecraft:overworld', minY: -64, height: 384 },
    time: { isDay: true },
    registry,
    entities: {},
    inventory: { items: () => items },
    blockAt,
    canSeeBlock: () => true,
    findBlocks: (query: { matching: (block: { name: string }) => boolean; maxDistance: number; count: number }) => {
      const out: unknown[] = []
      for (const [cell, name] of grid) {
        const [x, y, z] = cell.split(',').map(Number)
        const block = { name, ...(BLOCKS[name as string] ?? BLOCKS.air) }
        if (!query.matching(block)) continue
        if (position.distanceTo(new Vec3(x as number, y as number, z as number)) > query.maxDistance) continue
        out.push(new Vec3(x as number, y as number, z as number))
        if (out.length >= query.count) break
      }
      return out
    },
  } as never
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

function goalQueue(current: QueuedGoal | null): GoalQueueState {
  if (current === null) return emptyGoalQueueState()
  return { ...emptyGoalQueueState(), depth: 1, current, empty: false, goals: [current] }
}

function goalOf(kind: QueuedGoal['kind'], targetItem: string, extra: Partial<QueuedGoal> = {}): QueuedGoal {
  return {
    id: `g:${kind}:${targetItem}`,
    kind,
    description: `${kind} ${targetItem}`,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
    ...extra,
  }
}

interface Scene {
  position: Vec3Json
  food?: number
  counts?: Record<string, number>
  goal?: { item: string; queue?: QueuedGoal | null; focus?: string | null }
  rememberedStations?: KnownResource[]
}

function perceive(grid: Map<string, string>, scene: Scene): WorldState {
  const goal = scene.goal ?? { item: 'log' }
  return buildWorldState(
    gridBot(grid, { position: scene.position, food: scene.food ?? 0, counts: scene.counts ?? {} }),
    {
      tick: 1,
      goal: makeGoal(goal.item, 1),
      goalQueue: goalQueue(goal.queue ?? null),
      focusItem: goal.focus ?? null,
      recentEvents: [],
      signals: signals(),
      rememberedStations: scene.rememberedStations,
    },
    defaultSensorOptions,
  )
}

const options: CandidateOptions = { ...defaultCandidateOptions, recipes: recipeIndex }

function offer(state: WorldState): { candidates: Candidate[]; grounded: ReturnType<typeof generateGroundedCandidates> } {
  const grounded = generateGroundedCandidates(state, options)
  return { candidates: grounded.candidates, grounded }
}

/** A station a durable world memory holds far away at canopy height (live: (-50,79,-7)). */
function rememberedRemoteTable(): KnownResource[] {
  return [
    {
      name: 'crafting_table',
      kind: 'station',
      position: { x: -50, y: 79, z: -7 },
      verifiedAt: 0,
    } as KnownResource,
  ]
}

// --- scenes -----------------------------------------------------------------

/** The live shape: hillside to y=71, the body's own 4-block cobblestone pillar, leaf canopy y=74-78. */
function insideCanopy(): Map<string, string> {
  const grid = new Map<string, string>()
  for (let dx = -3; dx <= 3; dx += 1) {
    for (let dz = -3; dz <= 3; dz += 1) {
      for (let y = 66; y <= 71; y += 1) grid.set(key(76 + dx, y, 12 + dz), 'dirt')
      grid.set(key(76 + dx, 72, 12 + dz), 'grass_block')
    }
  }
  for (let y = 72; y <= 75; y += 1) grid.set(key(76, y, 12), 'cobblestone')
  grid.set(key(76, 74, 11), 'oak_log')
  grid.set(key(76, 75, 11), 'oak_leaves')
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dz = -2; dz <= 2; dz += 1) {
      if (dx === 0 && dz === 0) continue // the body's own pillar column
      for (const y of [74, 75, 76, 77, 78]) grid.set(key(76 + dx, y, 12 + dz), 'oak_leaves')
    }
  }
  // One real dirt patch beside the body's column: the differential control that
  // proves a ground-supported cell in the SAME window is still offered.
  grid.set(key(77, 78, 12), 'dirt')
  return grid
}

/** The operator's screenshot: the body standing ON the canopy at y=79. */
function atopCanopy(): Map<string, string> {
  const grid = new Map<string, string>()
  for (let dx = -3; dx <= 3; dx += 1) {
    for (let dz = -3; dz <= 3; dz += 1) {
      for (const y of [74, 75, 76, 77, 78]) grid.set(key(76 + dx, y, 12 + dz), 'oak_leaves')
    }
  }
  // A real ground patch next to the body: the differential control.
  grid.set(key(77, 78, 12), 'dirt')
  return grid
}

/** Open flat ground with the surface top at y=72 (body feet stand at 73). */
function openGround(): Map<string, string> {
  const grid = new Map<string, string>()
  for (let dx = -3; dx <= 3; dx += 1) {
    for (let dz = -3; dz <= 3; dz += 1) {
      for (let y = 66; y <= 71; y += 1) grid.set(key(76 + dx, y, 12 + dz), 'dirt')
      grid.set(key(76 + dx, 72, 12 + dz), 'grass_block')
    }
  }
  return grid
}

/** The same ground with a genuine 2-block dirt face one north (a real step-up). */
function groundStepUp(): Map<string, string> {
  const grid = openGround()
  grid.set(key(76, 73, 11), 'dirt')
  grid.set(key(76, 74, 11), 'dirt')
  return grid
}

/** An underground shaft: stone floor at y=54, body feet at y=55 (below the band 63). */
function shaft(): Map<string, string> {
  const grid = new Map<string, string>()
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dz = -2; dz <= 2; dz += 1) {
      for (let y = 50; y <= 54; y += 1) grid.set(key(76 + dx, y, 12 + dz), 'stone')
    }
  }
  return grid
}

const GROUND_FEET: Vec3Json = { x: 76.5, y: 73.0, z: 12.5 }
const CANOPY_FEET: Vec3Json = { x: 76.5, y: 76.0, z: 12.6 }
const ATOP_FEET: Vec3Json = { x: 76.5, y: 79.0, z: 12.5 }
const SHAFT_FEET: Vec3Json = { x: 76.5, y: 55.0, z: 12.5 }

// ---------------------------------------------------------------------------
// (a) the live shape: a canopy is not a destination, a site or a landing
// ---------------------------------------------------------------------------

check(
  '(a0) the load-bearing rule: leaves are solid but not usable ground',
  isCanopyBlockName('oak_leaves') &&
    isCanopyBlockName('birch_leaves') &&
    isCanopyBlockName('azalea_leaves') &&
    isCanopyBlockName('leaves') &&
    !isCanopyBlockName('oak_log') &&
    !isCanopyBlockName('dirt') &&
    isUsableGroundSupport({ name: 'dirt', boundingBox: 'block' }) &&
    isUsableGroundSupport({ name: 'grass_block', boundingBox: 'block' }) &&
    isUsableGroundSupport({ name: 'cobblestone', boundingBox: 'block' }) &&
    !isUsableGroundSupport({ name: 'oak_leaves', boundingBox: 'block' }) &&
    !isUsableGroundSupport({ name: 'air', boundingBox: 'empty' }) &&
    !isUsableGroundSupport({ name: 'water', boundingBox: 'empty' }) &&
    !isUsableGroundSupport(null),
  'leaves(oak/birch/azalea/legacy)=canopy dirt/grass/cobble=ground air/water/null=no',
)

const atop = perceive(atopCanopy(), { position: ATOP_FEET, food: 0 })
const atopGrid = atopCanopy()
const controlStand: Vec3Json = { x: 77, y: 79, z: 12 }
const leafStand: Vec3Json = { x: 75, y: 79, z: 12 }

check(
  '(a1) terrain (MOVE/explore/retreat destinations) excludes leaf-supported cells and keeps ground ones',
  atop.terrain.standable.length > 0 &&
    atop.terrain.standable.every((cell) => !supportIsCanopy(atopGrid, cell)) &&
    atop.terrain.standable.some((cell) => cell.x === controlStand.x && cell.y === controlStand.y && cell.z === controlStand.z) &&
    !atop.terrain.standable.some((cell) => cell.x === leafStand.x && cell.y === leafStand.y && cell.z === leafStand.z),
  `terrain=${atop.terrain.standable.map((cell) => `${cell.x},${cell.y},${cell.z}`).join(' ')} (ground patch 77,79,12 kept, leaf top 75,79,12 dropped)`,
)

const leafLandingGrid = new Map<string, string>([
  [key(0, 71, 0), 'dirt'],
  [key(1, 71, 0), 'oak_leaves'],
])
const leafLanding = perceive(leafLandingGrid, { position: { x: 0.5, y: 72, z: 0.5 }, food: 20 })
const eastLevelLanding = leafLanding.descent?.find((step) => step.dir === 'E' && step.mode === 'level')
const leafLandingCell = { x: 1, y: 72, z: 0 }
const leafLandingCandidate = offer(leafLanding).candidates.find(
  (candidate) =>
    candidate.kind === 'MOVE' &&
    candidate.meta.verticalRecovery === 'safe_level_step' &&
    candidate.target?.x === leafLandingCell.x &&
    candidate.target?.y === leafLandingCell.y &&
    candidate.target?.z === leafLandingCell.z,
)

check(
  '(a1b) descent sensor marks a collidable leaf landing unusable and candidate generation withholds it',
  eastLevelLanding?.safe === true &&
    eastLevelLanding.landingUsable === false &&
    !leafLanding.terrain.standable.some(
      (cell) => cell.x === leafLandingCell.x && cell.y === leafLandingCell.y && cell.z === leafLandingCell.z,
    ) &&
    leafLandingCandidate === undefined,
  `safe=${eastLevelLanding?.safe} landingUsable=${eastLevelLanding?.landingUsable} terrainHasLanding=${leafLanding.terrain.standable.some(
    (cell) => cell.x === leafLandingCell.x && cell.y === leafLandingCell.y && cell.z === leafLandingCell.z,
  )} candidate=${leafLandingCandidate?.id ?? 'none'}`,
)

check(
  '(a2) placement sites exclude leaf-supported cells and keep ground ones',
  atop.placementSpots.length > 0 &&
    atop.placementSpots.every((cell) => !supportIsCanopy(atopGrid, cell)) &&
    atop.placementSpots.some((cell) => cell.x === controlStand.x && cell.y === controlStand.y && cell.z === controlStand.z) &&
    !atop.placementSpots.some((cell) => cell.x === leafStand.x && cell.y === leafStand.y && cell.z === leafStand.z),
  `placementSpots=${atop.placementSpots.map((cell) => `${cell.x},${cell.y},${cell.z}`).join(' ')}`,
)

const inside = perceive(insideCanopy(), { position: CANOPY_FEET, food: 0, counts: { cobblestone: 3, dirt: 34 } })
const insideGrid = insideCanopy()
const insideCuts = inside.stepCuts ?? []

check(
  '(a3) standing on its own pillar inside the canopy: no safe step-up lands on leaves',
  insideCuts.filter((cut) => cut.safe).every((cut) => !supportIsCanopy(insideGrid, cut.step)) &&
    insideCuts.some((cut) => cut.safe) === false &&
    insideCuts.some((cut) => isCanopyBlockName(cut.name) && cut.reason === 'no usable ground under the cut'),
  `safeCuts=${insideCuts.filter((cut) => cut.safe).length} leafCuts=${insideCuts
    .filter((cut) => isCanopyBlockName(cut.name))
    .map((cut) => `${cut.dir}@${cut.cut.y}:"${cut.reason}"`)
    .join(' ')} (the same geometry with dirt is a safe cut: case b1)`,
)

const insideTick = offer(inside)

check(
  '(a4) hungry body in the canopy: no ASCEND:habitat into the canopy',
  insideTick.candidates.every((candidate) => candidate.meta.foodHabitat !== true) &&
    insideTick.grounded.foodHabitatRefusal === null,
  `food=0 bodyY=${CANOPY_FEET.y} band=${ANIMAL_HABITAT_SEA_LEVEL} habitatCandidates=${insideTick.candidates
    .filter((candidate) => candidate.meta.foodHabitat === true)
    .map((candidate) => candidate.id)
    .join(' ')}`,
)

check(
  '(a5) no MOVE/RETREAT/STEP destination targets a leaf-supported cell',
  insideTick.candidates
    .filter((candidate) => candidate.kind === 'MOVE' || candidate.kind === 'RETREAT' || candidate.kind === 'STEP')
    .every((candidate) => candidate.target === null || !supportIsCanopy(insideGrid, candidate.target)),
  `moveLike=${insideTick.candidates
    .filter((candidate) => candidate.kind === 'MOVE' || candidate.kind === 'RETREAT' || candidate.kind === 'STEP')
    .map((candidate) => candidate.id)
    .join(' ')}`,
)

check(
  '(a6) a remembered remote station cannot raise the own-column habitat target',
  Math.floor(CANOPY_FEET.y) >= ANIMAL_HABITAT_SEA_LEVEL &&
    offer(
      perceive(insideCanopy(), {
        position: CANOPY_FEET,
        food: 0,
        counts: { cobblestone: 3, dirt: 34 },
        rememberedStations: rememberedRemoteTable(),
      }),
    ).candidates.every((candidate) => candidate.meta.foodHabitat !== true),
  'remembered crafting_table@(-50,79,-7): no habitat climb from y=76',
)

// Below the band the arm is still allowed, but its target must be the LOCAL
// band / sensed surface - never an altitude remembered from elsewhere.
const belowBand = offer(
  perceive(shaft(), {
    position: SHAFT_FEET,
    food: 0,
    counts: { cobblestone: 12 },
    rememberedStations: rememberedRemoteTable(),
  }),
)
const habitatBelow = belowBand.candidates.find((candidate) => candidate.meta.foodHabitat === true)

check(
  '(a7) below the band the arm still fires, aimed at the band (never a remembered Y=79)',
  habitatBelow !== undefined && habitatBelow.meta.ascentTargetY === ANIMAL_HABITAT_SEA_LEVEL,
  `candidate=${habitatBelow?.id ?? 'none'} ascentTargetY=${String(habitatBelow?.meta.ascentTargetY ?? 'none')} band=${ANIMAL_HABITAT_SEA_LEVEL} vertical=${String(habitatBelow?.meta.vertical ?? 'none')}`,
)

const sensedShaft = shaft()
sensedShaft.set(key(78, 66, 12), 'crafting_table')
const sensedTick = offer(
  perceive(sensedShaft, {
    position: SHAFT_FEET,
    food: 0,
    counts: { cobblestone: 12 },
    rememberedStations: rememberedRemoteTable(),
  }),
)
const sensedHabitat = sensedTick.candidates.find((candidate) => candidate.meta.foodHabitat === true)

check(
  '(a8) a SENSED local surface is honoured over the remembered remote one',
  sensedHabitat !== undefined && sensedHabitat.meta.ascentTargetY === 66,
  `candidate=${sensedHabitat?.id ?? 'none'} ascentTargetY=${String(sensedHabitat?.meta.ascentTargetY ?? 'none')} (sensed crafting_table@78,66,12, remembered@(-50,79,-7))`,
)

// Below the band under a canopy with NOTHING to place: the route cannot be
// built, so the arm must say so with its typed refusal instead of climbing.
const canopyShaft = shaft()
for (const y of [55, 56, 57]) canopyShaft.set(key(76, y, 12), 'oak_leaves')
for (const [dx, dz] of [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const) {
  for (const y of [55, 56, 57]) canopyShaft.set(key(76 + dx, y, 12 + dz), 'oak_leaves')
}
const noPlaceable = offer(perceive(canopyShaft, { position: SHAFT_FEET, food: 0, counts: {} }))

check(
  '(a9) below the band under a canopy with nothing to place: typed FOOD_HABITAT_REFUSED, no climb',
  noPlaceable.candidates.every((candidate) => candidate.meta.foodHabitat !== true) &&
    noPlaceable.grounded.foodHabitatRefusal !== null &&
    formatFoodHabitatRefused(noPlaceable.grounded.foodHabitatRefusal).startsWith(`${FOOD_HABITAT_REFUSED} goal=`) &&
    noPlaceable.grounded.foodHabitatRefusal.reason === 'no_placeable',
  noPlaceable.grounded.foodHabitatRefusal === null
    ? 'refusal=null'
    : formatFoodHabitatRefused(noPlaceable.grounded.foodHabitatRefusal),
)

// ---------------------------------------------------------------------------
// (b) a genuine destination above is unchanged
// ---------------------------------------------------------------------------

const ground = perceive(openGround(), { position: GROUND_FEET, food: 20 })
const stepUpGrid = groundStepUp()
const stepUpState = perceive(stepUpGrid, { position: GROUND_FEET, food: 20 })
const flatCuts = ground.stepCuts ?? []
const stepUpCuts = stepUpState.stepCuts ?? []

check(
  '(b1) a real ground step-up is still a safe staircase-up cut',
  flatCuts.length === 0 && stepUpCuts.some((cut) => cut.safe && cut.name === 'dirt' && cut.dir === 'N'),
  `flat=${flatCuts.length} cuts; stepUp=${stepUpCuts
    .map((cut) => `${cut.dir}@${cut.cut.y}:${cut.name}:${cut.reason}`)
    .join(' ')}`,
)

const surfaceTick = offer(
  perceive(openGround(), {
    position: GROUND_FEET,
    food: 20,
    counts: { cobblestone: 16 },
    goal: { item: 'log', queue: goalOf('surface', 'log', { targetY: 80 }), focus: 'log' },
  }),
)
const surfaceAscent = surfaceTick.candidates.find((candidate) => candidate.meta.surfaceAscent === true)

check(
  '(b2) a real destination above keeps its ascent (surface goal -> ASCEND:surface pillar)',
  surfaceAscent !== undefined && surfaceAscent.meta.vertical === 'pillar' && surfaceAscent.meta.ascentTargetY === 80,
  `ascent=${surfaceAscent?.id ?? 'none'} vertical=${String(surfaceAscent?.meta.vertical ?? 'none')} targetY=${String(surfaceAscent?.meta.ascentTargetY ?? 'none')}`,
)

const stepUpTick = offer(
  perceive(stepUpGrid, {
    position: GROUND_FEET,
    food: 20,
    counts: {},
    goal: { item: 'log', queue: goalOf('surface', 'log', { targetY: 75 }), focus: 'log' },
  }),
)
const stepUpAscent = stepUpTick.candidates.find((candidate) => candidate.meta.surfaceAscent === true)

check(
  '(b3) a ground step-up above is still offered as staircase-up',
  stepUpAscent !== undefined && stepUpAscent.meta.vertical === 'staircase-up',
  `ascent=${stepUpAscent?.id ?? 'none'} vertical=${String(stepUpAscent?.meta.vertical ?? 'none')} upDigY=${String(stepUpAscent?.meta.upDigY ?? 'none')}`,
)

check(
  '(b4) the pure pillar gate still allows a real-ground footing',
  evaluatePillarStep({
    placeableCount: 4,
    columnSafe: true,
    remaining: 4,
    footingSolid: true,
    footingUsable: true,
    headroomClear: true,
  }).ok === true,
  'footing=dirt/cobblestone -> ok',
)

const canopyFooting = evaluatePillarStep({
  placeableCount: 4,
  columnSafe: true,
  remaining: 4,
  footingSolid: true,
  footingUsable: false,
  headroomClear: true,
})

check(
  '(b5) the pure pillar gate refuses a leaf footing with a typed reason',
  canopyFooting.ok === false && canopyFooting.reason === 'canopy_footing',
  `reason=${canopyFooting.ok ? 'ok' : canopyFooting.reason}`,
)

// ---------------------------------------------------------------------------
// (c) placement on solid ground is unchanged
// ---------------------------------------------------------------------------

const placeTick = offer(
  perceive(openGround(), {
    position: GROUND_FEET,
    food: 20,
    counts: { crafting_table: 1, oak_planks: 8 },
    goal: { item: 'crafting_table', queue: goalOf('place', 'crafting_table'), focus: 'crafting_table' },
  }),
)
const place = placeTick.candidates.find((candidate) => candidate.kind === 'PLACE')

check(
  '(c1) a held station is still placed on real ground',
  placeTick.grounded.candidates.some((candidate) => candidate.kind === 'PLACE') &&
    place !== undefined &&
    place.target !== null &&
    !isCanopyBlockName(nameAt(openGround(), place.target.x, place.target.y - 1, place.target.z)),
  `place=${place?.id ?? 'none'} placementSpots=${placeTick.grounded.candidates.filter((candidate) => candidate.kind === 'PLACE').length}`,
)

const canopyPlaceTick = offer(
  perceive(atopCanopy(), {
    position: ATOP_FEET,
    food: 20,
    counts: { crafting_table: 1, oak_planks: 8 },
    goal: { item: 'crafting_table', queue: goalOf('place', 'crafting_table'), focus: 'crafting_table' },
  }),
)
const canopyPlace = canopyPlaceTick.candidates.find((candidate) => candidate.kind === 'PLACE')

check(
  '(c2) on the canopy a station is only offered at the real ground patch, never on leaves',
  canopyPlace !== undefined &&
    canopyPlace.target !== null &&
    canopyPlace.target.x === controlStand.x &&
    canopyPlace.target.y === controlStand.y &&
    canopyPlace.target.z === controlStand.z,
  `place=${canopyPlace?.id ?? 'none'} (expected the 77,79,12 dirt patch, leaf tops withheld)`,
)

// ---------------------------------------------------------------------------
// (d) a starved objective gets a route or ONE typed escalation
// ---------------------------------------------------------------------------

const craftTick = offer(
  perceive(insideCanopy(), {
    position: CANOPY_FEET,
    food: 0,
    counts: { oak_planks: 5, stick: 4, cobblestone: 3 },
    goal: {
      item: 'crafting_table',
      queue: goalOf('craft', 'acacia_planks', { requiredCount: 4, haveCount: 0 }),
      focus: 'acacia_planks',
    },
  }),
)
const productive = craftTick.candidates.filter(
  (candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE',
)
const craftStarvation = candidateStarvationLine(
  craftTick.candidates,
  'objective:crafting_table:1',
  false,
  'no_productive_action',
  ['column_descent:no_safe_step'],
)

check(
  '(d1) the canopy never contributes a habitat climb to a starved ladder objective',
  craftTick.candidates.every((candidate) => candidate.meta.foodHabitat !== true),
  `productive=${productive.length} habitat=${craftTick.candidates.filter((candidate) => candidate.meta.foodHabitat === true).length} candidates=${craftTick.candidates.map((candidate) => candidate.id).join(' ')}`,
)

check(
  '(d2) a starved tick either has a real route or names a typed blocker (never silent)',
  productive.length > 0 || (craftStarvation !== null && craftStarvation.includes('missing=')),
  productive.length > 0
    ? `route=${productive.map((candidate) => candidate.id).join(' ')}`
    : (craftStarvation ?? 'starvation=null'),
)

const boundary = evaluateCandidateStarvationBoundary({
  activeOption: true,
  blockedBy: 'no_productive_action',
  missing: ['column_descent:no_safe_step'],
  semanticExhausted: false,
  semanticInvalid: false,
  semanticAbandoned: false,
  localRecoveryExhausted: true,
})

check(
  '(d3) the exhausted local recovery crosses the System2 boundary once, typed',
  boundary.wake === true && boundary.reason === 'semantic_boundary',
  `wake=${boundary.wake} reason=${boundary.reason}`,
)

// ---------------------------------------------------------------------------

process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${failures === 0 ? 'ALL' : 'FAILED'} canopy-ground cases: ${failures} failure(s)\n`)
if (failures > 0) process.exit(1)
