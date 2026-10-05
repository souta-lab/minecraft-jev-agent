// test-hunger-food.mts - hunger survival regression.
//
// Live incident (operator report): the resident "was about to die of hunger".
//
//   /data get entity AI_Buddy foodLevel  -> 0            (starving, losing health)
//   after 16 steak were handed over:
//   /data get entity AI_Buddy foodLevel  -> 20           (EAT works when food is held)
//
// So the eat mechanic was fine, but the body had no route to food and no rung
// that cared about hunger. Root causes pinned here:
//
//   * EAT was gated on `food < eatBelowFood` (default 18), so hunger exactly AT
//     the sane threshold was already refused, and nothing surfaced why;
//   * the passive-food-animal hunt used the 8m melee COMBAT_CANDIDATE_RANGE even
//     though the ATTACK executor already paths to the entity, so a hungry body
//     9m from a cow had no grounded food route at all;
//   * the ladder had no optional `food` affordance.
//
// This fixture FAILS before the fix (case a: food=18 gets no EAT; case c: a cow
// at 12m is no route) and PASSES after it. It also pins that existing M2/M3
// mandatory rungs/predicates and their indices are unchanged.
//
// Run: bun test-hunger-food.mts
import { createRequire } from 'node:module'
import {
  defaultCandidateOptions,
  foodHabitatAscent,
  generateCandidates,
  generateGroundedCandidates,
} from './src/candidates.ts'
import { GoalQueue, emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { isProtectedGoal } from './src/protectedGoals.ts'
import { buildWorldState, defaultSensorOptions, makeGoal } from './src/state.ts'
import type { AgentSignals, Vec3Json, WorldState } from './src/state.ts'
import { buildPlanOptions, computeFrontier, RUNGS, rungIndexById } from '../buddy-driver/planner.ts'
import { emptyWorldMemory } from '../buddy-driver/resident-types.ts'
import type { ResidentWorldMemory } from '../buddy-driver/resident-types.ts'

const require = createRequire(import.meta.url)
const Vec3 = require('vec3')
const registry = require('minecraft-data')('1.21.11')

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

type Bot = Parameters<typeof buildWorldState>[0]

const ORIGIN: Vec3Json = { x: 0, y: 64, z: 0 }
const THRESHOLD = defaultCandidateOptions.eatBelowFood

/** A passive animal at a horizontal distance from ORIGIN; the sensor sees 24m. */
function animal(name: string, distance: number, id = 42): Record<string, unknown> {
  return {
    id,
    name,
    kind: 'PassiveMob',
    username: undefined,
    position: new Vec3(ORIGIN.x + distance, ORIGIN.y, ORIGIN.z),
    isValid: true,
  }
}

/**
 * Sensor double: `counts` is the live inventory, `food` the live hunger bar,
 * `entities` the sensed mobs. The real minecraft-data registry is attached so
 * hostile classification uses genuine entity kinds.
 */
function fakeBot(
  counts: Record<string, number>,
  food: number,
  entities: Record<string, unknown>[],
  dimension = 'minecraft:overworld',
): Bot {
  const position = new Vec3(ORIGIN.x, ORIGIN.y, ORIGIN.z)
  const items = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  const mobs = new Map<string, unknown>()
  for (const entity of entities) {
    const record = entity as { id: number }
    mobs.set(String(record.id), entity)
  }
  return {
    username: 'AI_HUNGER',
    entity: { id: 1, position, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 20,
    food,
    game: { gameMode: 'survival', dimension, minY: -64, height: 384 },
    time: { isDay: true },
    registry,
    entities: Object.fromEntries(mobs),
    inventory: { items: () => items },
    blockAt: () => ({ name: 'air', boundingBox: 'empty', diggable: false }),
    canSeeBlock: () => true,
    findBlocks: () => [],
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

function foodGoal(): QueuedGoal {
  return {
    id: 'g1:collect:food',
    kind: 'collect',
    description: 'collect 3 x food (hunt passive animals)',
    targetItem: 'food',
    requiredCount: 3,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function queueWith(current: QueuedGoal): GoalQueueState {
  return { ...emptyGoalQueueState(), depth: 1, current, empty: false, goals: [current] }
}

function perceive(
  counts: Record<string, number>,
  food: number,
  entities: Record<string, unknown>[] = [],
  dimension = 'minecraft:overworld',
): WorldState {
  return buildWorldState(
    fakeBot(counts, food, entities, dimension),
    {
      tick: 1,
      goal: makeGoal('food', 3),
      goalQueue: queueWith(foodGoal()),
      focusItem: 'beef',
      recentEvents: [],
      signals: signals(),
    },
    defaultSensorOptions,
  )
}

/** Candidate ids the generator offers AND withholds (marker facts are pure too). */
function offered(state: WorldState): { ids: string[]; candidates: ReturnType<typeof generateCandidates> } {
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const candidates = grounded.candidates
  return { ids: candidates.map((candidate) => candidate.id), candidates }
}

// --- (a) proactive eating: at or below the threshold, not only near death ------

addCase('(a) food held and hunger AT the threshold (18) offers EAT', () => {
  const state = perceive({ cooked_beef: 3 }, THRESHOLD)
  const { candidates } = offered(state)
  const eat = candidates.find((candidate) => candidate.kind === 'EAT')
  return {
    pass: state.self.food === THRESHOLD && eat !== undefined && eat.id === 'EAT:cooked_beef',
    detail: `food=${state.self.food} threshold=${THRESHOLD} eat=${eat?.id ?? 'none'}`,
  }
})

addCase('(a2) food held and hunger below the threshold offers EAT', () => {
  const state = perceive({ cooked_beef: 3 }, THRESHOLD - 8)
  const { candidates } = offered(state)
  const eat = candidates.find((candidate) => candidate.kind === 'EAT')
  return {
    pass: eat !== undefined && eat.id === 'EAT:cooked_beef',
    detail: `food=${state.self.food} eat=${eat?.id ?? 'none'}`,
  }
})

// --- (b) full hunger: no EAT, no hunt route ------------------------------------

addCase('(b) food held at full hunger (20) offers no EAT and no hunt route', () => {
  const state = perceive({ cooked_beef: 3 }, 20, [animal('cow', 12)])
  const { candidates } = offered(state)
  const eat = candidates.find((candidate) => candidate.kind === 'EAT')
  const route = candidates.find((candidate) => candidate.meta.foodRoute === 'animal')
  return {
    pass: state.self.food === 20 && eat === undefined && route === undefined,
    detail: `food=20 eat=${eat?.id ?? 'none'} route=${route?.id ?? 'none'} (EAT_REFUSED reason=full)`,
  }
})

// --- (c) food acquisition: a sensed animal beyond melee range is a route -------

addCase('(c) no food held and hunger low: a sensed passive animal at 12m is a grounded food route', () => {
  const state = perceive({}, 0, [animal('cow', 12)])
  const route = state.entities.find((entity) => entity.name === 'cow')
  const { candidates } = offered(state)
  const hunt = candidates.find((candidate) => candidate.meta.foodRoute === 'animal')
  return {
    pass:
      route !== undefined &&
      route.hostile === false &&
      hunt !== undefined &&
      hunt.kind === 'ATTACK' &&
      hunt.targetEntityId === route.id &&
      hunt.meta.foodTarget === 'cow',
    detail: `sensedCow=${route !== undefined} route=${hunt?.id ?? 'none'} target=${String(hunt?.meta.foodTarget)} (FOOD_ROUTE kind=animal target=cow)`,
  }
})

addCase('(c2) no food held and hunger low: no EAT is offered (reason=no_food)', () => {
  const state = perceive({}, 0, [animal('cow', 12)])
  const { candidates } = offered(state)
  const eat = candidates.find((candidate) => candidate.kind === 'EAT')
  return {
    pass: state.self.food <= THRESHOLD && eat === undefined,
    detail: `food=0 threshold=${THRESHOLD} eat=${eat?.id ?? 'none'} (FOOD_LOW + EAT_REFUSED reason=no_food)`,
  }
})

addCase('(c3) an animal outside the sensor radius is not invented as a route', () => {
  const state = perceive({}, 0, [animal('cow', 40)])
  const { candidates } = offered(state)
  const hunt = candidates.find((candidate) => candidate.meta.foodRoute === 'animal')
  return {
    pass: state.entities.length === 0 && hunt === undefined,
    detail: `sensed=${state.entities.length} route=${hunt?.id ?? 'none'} (CAN boundary = sensor radius)`,
  }
})

addCase('(c4) a hostile-only world still offers no fake food route', () => {
  const zombie = { id: 7, name: 'zombie', kind: 'HostileMob', username: undefined, position: new Vec3(12, 64, 0), isValid: true }
  const state = perceive({}, 0, [zombie])
  const { candidates } = offered(state)
  const hunt = candidates.find((candidate) => candidate.meta.foodRoute === 'animal')
  return {
    pass: hunt === undefined,
    detail: `route=${hunt?.id ?? 'none'} hostileSensed=${state.entities.filter((e) => e.hostile).length}`,
  }
})

// --- (d) ladder: food is an OPTIONAL, self-contained rung; M2/M3 unchanged ------

const M2_M3_RUNG_INDICES: ReadonlyArray<readonly [string, number]> = [
  ['wood', 0],
  ['crafting_table', 1],
  ['wooden_pickaxe', 2],
  ['cobblestone', 3],
  ['furnace', 4],
  ['stone_pickaxe', 5],
  ['charcoal', 6],
  ['raw_iron', 7],
  ['iron_ingot', 8],
  ['iron_pickaxe', 9],
  ['iron_gear', 10],
  ['diamond', 11],
  ['diamond_pickaxe', 12],
  ['nether_portal', 13],
  ['enter_nether', 14],
  ['blaze_rods', 15],
  ['ender_pearls', 16],
  ['ender_eyes', 17],
]

const M2_M3_MANDATORY = M2_M3_RUNG_INDICES.map(([id]) => id).filter((id) => id !== 'iron_gear')

addCase('(d) the existing M2/M3 rungs keep their ids and historical indices', () => {
  const indicesUnchanged = M2_M3_RUNG_INDICES.every(([id, index]) => rungIndexById(id) === index)
  const mandatory = M2_M3_MANDATORY.every((id) => {
    const rung = RUNGS.find((entry) => entry.id === id)
    return rung !== undefined && rung.optional !== true && rung.future !== true
  })
  const gearOptional = RUNGS.find((rung) => rung.id === 'iron_gear')?.optional === true
  // The live M2 frontier for the incident inventory is unchanged by a survival rung.
  const frontier = computeFrontier({ diamond: 3, diamond_pickaxe: 1, flint_and_steel: 1, obsidian: 3 }, emptyWorldMemory())
  return {
    pass: indicesUnchanged && mandatory && gearOptional && frontier.rungId === 'nether_portal',
    detail: `indicesUnchanged=${indicesUnchanged} ironIngotIndex=${rungIndexById('iron_ingot')} mandatory=${mandatory} gearOptional=${gearOptional} frontier=${frontier.rungId}`,
  }
})

addCase('(d2) the food rung is OPTIONAL, SELF-CONTAINED, and only offered while hungry', () => {
  const food = RUNGS.find((rung) => rung.id === 'food')
  const world = emptyWorldMemory()
  const hungry = buildPlanOptions({}, world, { foodLevel: 0, eatBelowFood: THRESHOLD }).find((entry) => entry.id === 'food')
  const fed = buildPlanOptions({}, world, { foodLevel: 20, eatBelowFood: THRESHOLD }).find((entry) => entry.id === 'food')
  const unknownHunger = buildPlanOptions({}, world).find((entry) => entry.id === 'food')
  const items = (hungry?.goals ?? []).map((goal) => goal.targetItem)
  const noMilestones = !items.some((item) => item === 'diamond' || item === 'obsidian' || item === 'raw_iron' || item === 'log')
  return {
    pass:
      food?.optional === true &&
      food.selfContained === true &&
      hungry !== undefined &&
      noMilestones &&
      items.includes('food') &&
      fed === undefined &&
      unknownHunger === undefined,
    detail: `optional=${food?.optional === true} selfContained=${food?.selfContained === true} hungry=[${items.join(',')}] fed=${fed?.id ?? 'none'} noHungerFact=${unknownHunger?.id ?? 'none'}`,
  }
})
 
addCase('(d2b) optional food goals are replaceable by a semantic recovery plan', () => {
  const option = buildPlanOptions({}, emptyWorldMemory(), { foodLevel: 0, eatBelowFood: THRESHOLD }).find((entry) => entry.id === 'food')
  const foodGoals = (option?.goals ?? []).filter((goal) => goal.targetItem === 'food')
  return {
    pass: option !== undefined && foodGoals.length > 0 && foodGoals.every((goal) => goal.core !== true),
    detail: `foodGoals=${foodGoals.length} core=[${foodGoals.map((goal) => String(goal.core === true)).join(',')}]`,
  }
})
 
addCase('(d2c) persisted core food rows remain replaceable but prerequisites stay protected', () => {
  const food = { kind: 'collect', targetItem: 'food', core: true, protected: false }
  const prerequisite = { kind: 'collect', targetItem: 'obsidian', core: true, protected: false }
  return {
    pass: !isProtectedGoal(food) && isProtectedGoal(prerequisite),
    detail: `foodProtected=${isProtectedGoal(food)} prerequisiteProtected=${isProtectedGoal(prerequisite)}`,
  }
})
 
addCase('(d2d) a patch replaces a persisted active food row with a new semantic goal', () => {
  const queue = new GoalQueue()
  queue.restore({
    counter: 1,
    revision: 1,
    goals: [
      {
        ...foodGoal(),
        core: true,
        protected: false,
      },
    ],
  })
  queue.applyPlan(
    [{ kind: 'collect', description: 'collect 10 x obsidian', targetItem: 'obsidian', requiredCount: 10 }],
    'llm',
    'patch',
  )
  return {
    pass: queue.current?.targetItem === 'obsidian',
    detail: `current=${queue.current?.targetItem ?? 'none'} depth=${queue.state.depth}`,
  }
})

addCase('(d3) holding any edible item satisfies the food rung and stops offering it', () => {
  const food = RUNGS.find((rung) => rung.id === 'food')
  const world = emptyWorldMemory()
  const hungryOpts = { foodLevel: 0, eatBelowFood: THRESHOLD }
  const byBeef = food?.satisfied({ beef: 3 }, world) === true
  const byPorkchop = food?.satisfied({ porkchop: 3 }, world) === true
  const byCooked = food?.satisfied({ cooked_beef: 3 }, world) === true
  const offeredWhenEmpty = buildPlanOptions({}, world, hungryOpts).some((entry) => entry.id === 'food')
  const offeredWhenFull = buildPlanOptions({ beef: 3 }, world, hungryOpts).some((entry) => entry.id === 'food')
  return {
    pass: byBeef && byPorkchop && byCooked && offeredWhenEmpty && !offeredWhenFull,
    detail: `beef=${byBeef} porkchop=${byPorkchop} cooked=${byCooked} offeredEmpty=${offeredWhenEmpty} offeredFull=${offeredWhenFull}`,
  }
})

addCase('(d4) the M2 nether_portal predicate still requires the lit portal block', () => {
  const portal = RUNGS.find((rung) => rung.id === 'nether_portal')
  const empty = portal?.satisfied({}, emptyWorldMemory()) === true
  const held = portal?.satisfied({ nether_portal: 1 }, emptyWorldMemory()) === true
  const flintOnly = portal?.satisfied({ flint_and_steel: 1 }, emptyWorldMemory()) === true
  return {
    pass: portal !== undefined && !empty && held && !flintOnly,
    detail: `empty=${empty} held=${held} flintOnly=${flintOnly}`,
  }
})

// --- (e) underground food goal: habitat route or typed refusal -----------------
// Live blocker (2026-09-21): HEARTBEAT pos=23.3,53.0,8.9 health=1 rung=enter_nether,
// ledger active g37:collect:food 0/3, chosen=food, actions WAIT / DESCEND / MOVE at
// y=52-53 with progressDelta=0. Passive animals do not spawn underground, so a food
// goal with no sensed animal must either carry a route to animal habitat (the lit
// surface) or say the dead end - never pace.

function worldWithUpperRegion(y: number): ResidentWorldMemory {
  const world = emptyWorldMemory()
  world.knownResources = [{ name: 'oak_log', kind: 'log', x: 0, y, z: 0 }]
  return world
}

addCase('(e1) underground + hungry: the food option carries a grounded surface-habitat prerequisite', () => {
  const option = buildPlanOptions({}, worldWithUpperRegion(70), {
    foodLevel: 0,
    eatBelowFood: THRESHOLD,
    botY: 53,
  }).find((entry) => entry.id === 'food')
  const first = option?.goals[0]
  const second = option?.goals[1]
  return {
    pass:
      option !== undefined &&
      first?.kind === 'surface' &&
      typeof first.targetY === 'number' &&
      first.targetY > 53 &&
      second?.targetItem === 'food',
    detail: `first=${first?.kind}@y=${first?.targetY ?? 'none'} second=${second?.targetItem ?? 'none'} goals=[${(option?.goals ?? []).map((g) => `${g.kind}:${g.targetItem ?? '-'}`).join(',')}]`,
  }
})

addCase('(e2) not below known habitat: the food option stays a short collect goal (no forced ascent)', () => {
  const option = buildPlanOptions({}, worldWithUpperRegion(64), {
    foodLevel: 0,
    eatBelowFood: THRESHOLD,
    botY: 64,
  }).find((entry) => entry.id === 'food')
  const kinds = (option?.goals ?? []).map((goal) => goal.kind)
  return {
    pass:
      option !== undefined &&
      !kinds.includes('surface') &&
      (option?.goals ?? []).some((goal) => goal.targetItem === 'food'),
    detail: `kinds=[${kinds.join(',')}]`,
  }
})

addCase('(e3) no animal sensed on a collect food goal: the tick reports a typed explore refusal (never silent)', () => {
  const state = perceive({}, 0, [])
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  return {
    pass: grounded.exploreRouteBlocked !== null && grounded.exploreRouteBlocked.item === 'food',
    detail:
      grounded.exploreRouteBlocked === null
        ? 'blocked=null'
        : `blocked=item:${grounded.exploreRouteBlocked.item} reason:${grounded.exploreRouteBlocked.reason}`,
  }
})

addCase('(e4) a sensed animal is a grounded food route: no explore refusal', () => {
  const state = perceive({}, 0, [animal('cow', 12)])
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const hunt = grounded.candidates.some((candidate) => candidate.meta.foodRoute === 'animal')
  return {
    pass: hunt && grounded.exploreRouteBlocked === null,
    detail: `hunt=${hunt} blocked=${grounded.exploreRouteBlocked?.reason ?? 'none'}`,
  }
})

addCase('(e5) the habitat surface goal resolves to an ASCEND route or a typed SURFACE_ASCENT_REFUSAL', () => {
  const option = buildPlanOptions({}, worldWithUpperRegion(70), {
    foodLevel: 0,
    eatBelowFood: THRESHOLD,
    botY: 53,
  }).find((entry) => entry.id === 'food')
  const surfaceGoal = option?.goals[0]
  if (surfaceGoal === undefined || surfaceGoal.kind !== 'surface' || typeof surfaceGoal.targetY !== 'number') {
    return { pass: false, detail: 'food option carries no surface habitat goal' }
  }
  const goal: QueuedGoal = {
    id: 'g-food-habitat',
    kind: 'surface',
    description: surfaceGoal.description,
    targetItem: surfaceGoal.targetItem ?? null,
    requiredCount: surfaceGoal.requiredCount ?? 1,
    targetY: surfaceGoal.targetY,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
  const state = buildWorldState(
    fakeBot({}, 0, []),
    {
      tick: 1,
      goal: makeGoal('log', 1),
      goalQueue: queueWith(goal),
      focusItem: 'log',
      recentEvents: [],
      signals: signals(),
    },
    defaultSensorOptions,
  )
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const ascent = grounded.candidates.some((candidate) => candidate.meta.surfaceAscent === true)
  const refused = grounded.surfaceAscentRefusal !== null
  return {
    pass: ascent || refused,
    detail: `targetY=${surfaceGoal.targetY} ascent=${ascent} refusal=${refused ? String(grounded.surfaceAscentRefusal?.reason) : 'none'}`,
  }
})

// --- (f) sealed pocket ABOVE the habitat band: the arm must still lead out ----
// Live portal-p24 (gen-muvj9mnn-fe3lb5): a starving body at y62 climbed its own
// hand-cut staircase under `BODY_STARVING` floor offers, one `step_overhead` ->
// VERIFIED MINE -> `ASCEND:habitat` leg at a time. The arm's `y>=63` band gate
// was measured on an OAK CANOPY body (open sky, walkable leaves - "higher is
// the treetop") and over-closes on the sealed body: crossing y63 kills the only
// producer still naming the next overhead cell. The facts that separate the two
// bodies are already sensed: `strandedOnColumn` (no standable cell beyond the
// body's own) plus a `currentFootprint` headroom cut or a face's `blockedBy`
// (an overhead obstruction exists). An island/canopy top has neither.

function pocketState(y: number): WorldState {
  const base = perceive({ cobblestone: 64, iron_pickaxe: 1 }, 0)
  const feet = { x: 10, y: Math.floor(y), z: -41 }
  return {
    ...base,
    self: {
      ...base.self,
      position: { x: feet.x + 0.5, y, z: feet.z + 0.5 },
      eyePosition: { x: feet.x + 0.5, y: y + 1.62, z: feet.z + 0.5 },
    },
    terrain: { ...base.terrain, standable: [{ x: feet.x, y: feet.y, z: feet.z }] },
    craftingTables: [],
    furnaces: [],
    // The pocket's own ceiling (feet+2) blocks the body's jump headroom, and a
    // face step's `blockedBy` names the next staircase overhead cell - the same
    // sensed facts the live conveyor reads each tick.
    headroomCuts: [
      {
        pos: { x: feet.x, y: feet.y + 2, z: feet.z },
        name: 'stone',
        safe: true,
        reason: 'safe',
        currentFootprint: true,
      },
    ],
    stepCuts: [
      {
        dir: 'N' as const,
        dx: 0,
        dz: -1,
        cut: { x: feet.x, y: feet.y + 1, z: feet.z - 1 },
        step: { x: feet.x, y: feet.y + 1, z: feet.z - 1 },
        name: 'stone',
        safe: false,
        reason: 'step overhead is closed',
        blockedBy: { pos: { x: feet.x, y: feet.y + 2, z: feet.z - 1 }, name: 'stone' },
      },
    ],
  }
}

addCase('(f1) sealed + stranded ABOVE the band: the habitat arm still emits the next staircase leg', () => {
  const state = pocketState(64.3)
  const ascent = foodHabitatAscent(state, defaultCandidateOptions)
  const ids = ascent.candidates.map((candidate) => candidate.id)
  const clearance = ascent.candidates.find(
    (candidate) => candidate.id === 'MINE:b10_66_-42' || candidate.meta.stepOverhead === true,
  )
  return {
    pass: ascent.candidates.length > 0 && (clearance !== undefined || ascent.candidates.some((c) => c.kind === 'MOVE')),
    detail: `y=${state.self.position.y} candidates=[${ids.join(',')}] refusal=${ascent.refusal?.reason ?? 'none'}`,
  }
})

addCase('(f2) stranded above the band with OPEN sky (island/canopy top): the arm stays silent', () => {
  const state = { ...pocketState(64.3), headroomCuts: [], stepCuts: [] }
  const ascent = foodHabitatAscent(state, defaultCandidateOptions)
  return {
    pass: ascent.candidates.length === 0,
    detail: `candidates=[${ascent.candidates.map((c) => c.id).join(',')}]`,
  }
})

addCase('(f3) enclosed overhead but NOT stranded (a 2-high cave above the band): the arm stays silent', () => {
  const base = pocketState(64.3)
  const feet = { x: 10, y: 64, z: -41 }
  const standable = [
    { x: feet.x, y: feet.y, z: feet.z },
    { x: feet.x + 1, y: feet.y, z: feet.z },
    { x: feet.x + 2, y: feet.y, z: feet.z },
    { x: feet.x, y: feet.y, z: feet.z + 1 },
    { x: feet.x, y: feet.y, z: feet.z + 2 },
    { x: feet.x + 1, y: feet.y, z: feet.z + 1 },
    { x: feet.x + 2, y: feet.y, z: feet.z + 1 },
    { x: feet.x + 1, y: feet.y, z: feet.z + 2 },
    { x: feet.x + 2, y: feet.y, z: feet.z + 2 },
    { x: feet.x - 1, y: feet.y, z: feet.z },
    { x: feet.x, y: feet.y, z: feet.z - 1 },
    { x: feet.x - 1, y: feet.y, z: feet.z - 1 },
  ]
  const state = { ...base, terrain: { ...base.terrain, standable } }
  const ascent = foodHabitatAscent(state, defaultCandidateOptions)
  return {
    pass: ascent.candidates.length === 0,
    detail: `candidates=[${ascent.candidates.map((c) => c.id).join(',')}]`,
  }
})

addCase('(f4) sealed + stranded BELOW the band: unchanged - the arm leads as before', () => {
  const state = pocketState(60.3)
  const ascent = foodHabitatAscent(state, defaultCandidateOptions)
  return {
    pass: ascent.candidates.length > 0,
    detail: `candidates=[${ascent.candidates.map((c) => c.id).join(',')}] refusal=${ascent.refusal?.reason ?? 'none'}`,
  }
})

// The `ASCEND:escape` last-resort arm carried the same altitude over-closure:
// its `y < band` clause kept a NON-hungry sealed body above the band WAIT/
// ESCALATE-only after the 25s stall measured, with no producer of the up-route.
function pocketStateFed(y: number): WorldState {
  const base = pocketState(y)
  return {
    ...base,
    self: { ...base.self, food: 20, health: 20 },
    signals: signals({ stalledMs: 30000 }),
  }
}

addCase('(f5) NOT hungry + sealed + stranded ABOVE the band + stalled: ASCEND:escape still offers the climb out', () => {
  const state = pocketStateFed(64.3)
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const escape = grounded.candidates.filter(
    (candidate) => candidate.id.startsWith('ASCEND:escape:') || candidate.meta.stepOverhead === true,
  )
  return {
    pass: escape.length > 0,
    detail: `candidates=[${grounded.candidates.map((c) => c.id).join(',')}]`,
  }
})

addCase('(f6) NOT hungry + stranded above band with OPEN sky + stalled: the escape arm stays silent (island digs DOWN)', () => {
  const state = { ...pocketStateFed(64.3), headroomCuts: [], stepCuts: [] }
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const escape = grounded.candidates.filter(
    (candidate) => candidate.id.startsWith('ASCEND:escape:') || candidate.meta.stepOverhead === true,
  )
  return {
    pass: escape.length === 0,
    detail: `candidates=[${grounded.candidates.map((c) => c.id).join(',')}]`,
  }
})

// ---------------------------------------------------------------------------

let failures = 0
process.stdout.write('hunger survival: proactive eating + grounded food route regression\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')

// ---------------------------------------------------------------------------
// The habitat ascent's premise is OVERWORLD spawn truth (grass + sky). A hungry
// body in another dimension must NOT climb toward a band that cannot hold its
// prey: measured live on 3570c79, a hungry body IN THE NETHER climbed to y102
// chasing this band while no passive animal can exist there.
// ---------------------------------------------------------------------------

addCase('(dimension) a hungry body in the Nether gets NO animal-habitat ascent', () => {
  const state = perceive({}, 0, [], 'minecraft:the_nether')
  const ascent = foodHabitatAscent(state, defaultCandidateOptions)
  return {
    pass: ascent.candidates.length === 0,
    detail: `dimension=${state.self.dimension} candidates=[${ascent.candidates.map((c) => c.id).join(',')}]`,
  }
})

process.stdout.write(`${cases.length - failures}/${cases.length} hunger-food cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
