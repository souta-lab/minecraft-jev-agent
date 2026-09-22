// test-food-route.mts - grounded food-route regression for a starving body.
//
// Live incident (measured, run-muc0l5fp-158ak / run-mubobiq6-12onv lineage):
//
//   food = 0 for the WHOLE run, health 20 -> 18 -> 16 -> 15 -> 1 pinned at the
//   server's starvation floor. The only food affordance the code could offer was
//   an ATTACK on a salmon at 22m ("could not reach salmon during ATTACK lease",
//   failure code=out_of_reach x10); no land animal was ever sensed. The body held
//   a red_mushroom and stood in an oak/birch forest, but:
//
//     * the food focus declared NO scanned block names, so no edible block was
//       ever in the world state (`buildFoodSourceBlocks` did not exist);
//     * the recipe planner was never asked for an EDIBLE result, so a held
//       ingredient could not become mushroom_stew;
//     * nothing said "there is no food route at all" - the state was visible
//       only as FOOD_LOW/EAT_REFUSED lines that were not even mirrored;
//     * the option layer saw only `health: 1, food: 0` numbers with no typed
//       starvation fact.
//
// These cases pin the four fixtures:
//
//   (a) starving + a sensed animal      -> grounded hunt route (foodRoute=animal)
//   (b) starving + a reachable edible   -> forage MINE, acquire MINE, or cook CRAFT
//   (c) fed body                        -> unchanged (no food routes, no gap)
//   (d) starving + no food source       -> bounded typed FOOD_SOURCE_NONE naming
//                                          the missing affordance (never silent)
//
// The (b) cases deliberately run under an UNRELATED active goal
// (`craft:acacia_planks`), because that is the measured live shape: the body was
// not on a collect:food goal at all while it starved.
//
// Run: bun test-food-route.mts
import { createRequire } from 'node:module'
import { createRecipeIndex } from './src/crafting.ts'
import {
  defaultCandidateOptions,
  foodSourceGap,
  generateGroundedCandidates,
  pickFood,
} from './src/candidates.ts'
import { formatFoodSourceGap, isEdibleFoodItem } from './src/foodSources.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { buildWorldState, defaultSensorOptions, makeGoal } from './src/state.ts'
import type { AgentSignals, Vec3Json, WorldState } from './src/state.ts'
import { mirroredEventToken } from './src/controller-legacy.ts'
import { starvationFact } from '../buddy-driver/planner.ts'

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
const HEALTH = 20

/** A block double: everything not listed is air (except the y=63 floor). */
interface BlockSpec {
  name: string
  diggable?: boolean
}

interface BotSpec {
  counts: Record<string, number>
  food: number
  health?: number
  entities?: Record<string, unknown>[]
  blocks?: Array<{ at: Vec3Json; name: string; diggable?: boolean }>
}

/**
 * Sensor double over a tiny world: a solid floor at y=63, plus the listed
 * blocks. `findBlocks` honours the scanner's name filter, so a block only
 * appears in the world state when the scanner asked for it by name.
 */
function fakeBot(spec: BotSpec): Bot {
  const position = new Vec3(ORIGIN.x, ORIGIN.y, ORIGIN.z)
  const items = Object.entries(spec.counts).map(([name, count], slot) => ({ name, count, slot }))
  const mobs = new Map<string, unknown>()
  for (const entity of spec.entities ?? []) {
    const record = entity as { id: number }
    mobs.set(String(record.id), entity)
  }
  const blockMap = new Map<string, BlockSpec>()
  for (const entry of spec.blocks ?? []) {
    blockMap.set(`${entry.at.x},${entry.at.y},${entry.at.z}`, { name: entry.name, diggable: entry.diggable ?? true })
  }
  const blockAt = (position: { x: number; y: number; z: number }): Record<string, unknown> | null => {
    const key = `${position.x},${position.y},${position.z}`
    const listed = blockMap.get(key)
    if (listed !== undefined) {
      const solid = listed.name !== 'air' && listed.name !== 'water'
      return {
        name: listed.name,
        boundingBox: solid ? 'block' : 'empty',
        diggable: listed.diggable ?? solid,
        position: new Vec3(position.x, position.y, position.z),
      }
    }
    if (position.y <= 63) return { name: 'stone', boundingBox: 'block', diggable: true, position: new Vec3(position.x, position.y, position.z) }
    return { name: 'air', boundingBox: 'empty', diggable: false, position: new Vec3(position.x, position.y, position.z) }
  }
  const findBlocks = (options: {
    matching: (block: { name: string }) => boolean
    maxDistance?: number
    count?: number
  }): unknown[] => {
    const out: unknown[] = []
    const max = options.maxDistance ?? 64
    const count = options.count ?? 64
    for (const [key, listed] of blockMap) {
      if (out.length >= count) break
      if (!options.matching({ name: listed.name })) continue
      const [x, y, z] = key.split(',').map(Number) as [number, number, number]
      if (Math.hypot(x - ORIGIN.x, y - ORIGIN.y, z - ORIGIN.z) > max) continue
      out.push(new Vec3(x, y, z))
    }
    return out
  }
  return {
    username: 'AI_FOOD',
    entity: { id: 1, position, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: spec.health ?? HEALTH,
    food: spec.food,
    game: { gameMode: 'survival', dimension: 'minecraft:overworld', minY: -64, height: 384 },
    time: { isDay: true },
    registry,
    entities: Object.fromEntries(mobs),
    inventory: { items: () => items },
    blockAt,
    canSeeBlock: () => true,
    findBlocks,
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

/** The live shape: an UNRELATED active goal (craft acacia_planks) while starving. */
function craftGoal(): QueuedGoal {
  return {
    id: 'g9:craft:acacia_planks',
    kind: 'craft',
    description: 'craft 4 x acacia_planks',
    targetItem: 'acacia_planks',
    requiredCount: 4,
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

function perceive(spec: BotSpec, focusItem = 'acacia_log'): WorldState {
  return buildWorldState(
    fakeBot(spec),
    {
      tick: 1,
      goal: makeGoal(focusItem ?? 'acacia_log', 1),
      goalQueue: queueWith(craftGoal()),
      focusItem,
      recentEvents: [],
      signals: signals(),
    },
    defaultSensorOptions,
  )
}

function options() {
  return { ...defaultCandidateOptions, recipes: createRecipeIndex(registry) }
}

function grounded(state: WorldState) {
  return generateGroundedCandidates(state, options())
}

function foodRoutes(candidates: readonly { meta: Record<string, unknown> }[]): string[] {
  return candidates
    .filter((candidate) => typeof candidate.meta.foodRoute === 'string')
    .map((candidate) => `${String(candidate.meta.foodRoute)}:${String(candidate.meta.foodTarget)}`)
    .sort()
}

const FLOOR: Array<{ at: Vec3Json; name: string; diggable?: boolean }> = []

// --- (a) starving + a sensed animal: the hunt route is still grounded ---------

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

addCase('(a1) starving + sensed cow at 12m: a grounded hunt route is offered', () => {
  const state = perceive({ counts: {}, food: 0, health: 1, entities: [animal('cow', 12)], blocks: FLOOR })
  const result = grounded(state)
  const hunt = result.candidates.find((candidate) => candidate.meta.foodRoute === 'animal')
  return {
    pass: hunt !== undefined && hunt.kind === 'ATTACK' && hunt.meta.foodTarget === 'cow',
    detail: `routes=[${foodRoutes(result.candidates).join(',')}] hunt=${hunt?.id ?? 'none'}`,
  }
})

addCase('(a2) starving + sensed cow: no EAT is invented (nothing edible is held)', () => {
  const state = perceive({ counts: { raw_iron: 2 }, food: 0, health: 1, entities: [animal('cow', 12)], blocks: FLOOR })
  const result = grounded(state)
  const eat = result.candidates.find((candidate) => candidate.kind === 'EAT')
  return {
    pass: pickFood(state) === null && eat === undefined,
    detail: `heldFood=${String(pickFood(state))} eat=${eat?.id ?? 'none'} (FOOD_LOW + EAT_REFUSED reason=no_food)`,
  }
})

// --- (b1) starving + a reachable edible block: forage route -------------------

addCase('(b1) starving under an unrelated craft goal + sensed sweet_berry_bush: forage route', () => {
  const state = perceive({
    counts: {},
    food: 0,
    health: 1,
    blocks: [{ at: { x: 2, y: 64, z: 0 }, name: 'sweet_berry_bush' }],
  })
  const result = grounded(state)
  const forage = result.candidates.find((candidate) => candidate.meta.foodRoute === 'forage')
  return {
    pass:
      forage !== undefined &&
      forage.kind === 'MINE' &&
      forage.meta.foodTarget === 'sweet_berries' &&
      forage.targetName === 'sweet_berry_bush',
    detail: `focus=acacia_log routes=[${foodRoutes(result.candidates).join(',')}] forage=${forage?.id ?? 'none'}`,
  }
})

addCase('(b2) a sensed apple-bearing oak canopy is a forage route (curated vanilla drop)', () => {
  const state = perceive({
    counts: {},
    food: 0,
    health: 1,
    blocks: [{ at: { x: 2, y: 65, z: 0 }, name: 'oak_leaves' }],
  })
  const result = grounded(state)
  const forage = result.candidates.find(
    (candidate) => candidate.meta.foodRoute === 'forage' && candidate.meta.foodTarget === 'apple',
  )
  return {
    pass: forage !== undefined && forage.targetName === 'oak_leaves',
    detail: `routes=[${foodRoutes(result.candidates).join(',')}] oak=${forage?.id ?? 'none'}`,
  }
})

// --- (b3) starving + held ingredients: cook route -----------------------------

addCase('(b3) starving + held mushroom_stew ingredients + sensed table: cook route', () => {
  const state = perceive({
    counts: { red_mushroom: 1, brown_mushroom: 1, oak_planks: 3 },
    food: 0,
    health: 1,
    blocks: [{ at: { x: 3, y: 64, z: 0 }, name: 'crafting_table', diggable: true }],
  })
  const result = grounded(state)
  const cook = result.candidates.find((candidate) => candidate.meta.foodRoute === 'cook')
  const route = `${String(cook?.meta.foodRoute)}:${String(cook?.meta.foodTarget)}`
  return {
    pass:
      cook !== undefined &&
      cook.kind === 'CRAFT' &&
      cook.meta.foodTarget === 'mushroom_stew' &&
      // the first executable step of the chain is the bowl the stew needs
      route === 'cook:mushroom_stew',
    detail: `routes=[${foodRoutes(result.candidates).join(',')}] cook=${cook?.id ?? 'none'} (first step of the edible recipe)`,
  }
})

addCase('(b4) starving + held red_mushroom only: no cook route is invented', () => {
  const state = perceive({
    counts: { red_mushroom: 1, oak_planks: 3 },
    food: 0,
    health: 1,
    blocks: [{ at: { x: 3, y: 64, z: 0 }, name: 'crafting_table', diggable: true }],
  })
  const result = grounded(state)
  const cook = result.candidates.find((candidate) => candidate.meta.foodRoute === 'cook')
  return {
    pass: cook === undefined,
    detail: `routes=[${foodRoutes(result.candidates).join(',')}] cook=${cook?.id ?? 'none'} (missing brown_mushroom)`,
  }
})

// --- (b5) starving + a sensed ingredient block: acquire route -----------------

addCase('(b5) starving + sensed brown_mushroom completes a held stew recipe: acquire route', () => {
  const state = perceive({
    counts: { red_mushroom: 1, oak_planks: 3 },
    food: 0,
    health: 1,
    blocks: [
      { at: { x: 2, y: 64, z: 0 }, name: 'brown_mushroom' },
      { at: { x: 3, y: 64, z: 2 }, name: 'crafting_table', diggable: true },
    ],
  })
  const result = grounded(state)
  const acquire = result.candidates.find((candidate) => candidate.meta.foodRoute === 'acquire')
  return {
    pass: acquire !== undefined && acquire.kind === 'MINE' && acquire.meta.foodTarget === 'brown_mushroom',
    detail: `routes=[${foodRoutes(result.candidates).join(',')}] acquire=${acquire?.id ?? 'none'}`,
  }
})

addCase('(b6) a sensed ingredient block with no held recipe is NOT a food route', () => {
  const state = perceive({
    counts: {},
    food: 0,
    health: 1,
    blocks: [{ at: { x: 2, y: 64, z: 0 }, name: 'brown_mushroom' }],
  })
  const result = grounded(state)
  const acquire = result.candidates.find((candidate) => candidate.meta.foodRoute === 'acquire')
  return {
    pass: acquire === undefined && result.foodGap?.sensedIngredientBlock === false,
    detail: `routes=[${foodRoutes(result.candidates).join(',')}] acquire=${acquire?.id ?? 'none'} (no held ingredient)`,
  }
})

addCase('(b7) the forage route survives a focus-crowded pool (the live forest shape)', () => {
  // The live body stood in an oak/birch forest under a `craft acacia_planks`
  // goal: its mechanical pool alone can consume every one of the 12 MINE slots.
  // The survival affordance must be an ADDITIONAL grounded set, not a competitor
  // for those slots.
  const logs: Array<{ at: Vec3Json; name: string }> = []
  for (const x of [-2, -1, 0, 1, 2]) {
    for (const z of [-2, 2]) logs.push({ at: { x, y: 64, z }, name: 'oak_log' })
  }
  for (const [x, z] of [
    [2, 1],
    [-2, 1],
    [2, -1],
    [-2, -1],
  ] as Array<[number, number]>) {
    logs.push({ at: { x, y: 64, z }, name: 'oak_log' })
  }
  const state = perceive({
    counts: {},
    food: 0,
    health: 1,
    blocks: [...logs, { at: { x: 2, y: 64, z: 0 }, name: 'oak_leaves' }],
  })
  const result = grounded(state)
  const focusCandidates = result.candidates.filter(
    (candidate) =>
      candidate.meta.foodRoute === undefined && (candidate.kind === 'MINE' || candidate.kind === 'MOVE'),
  )
  const forage = result.candidates.find((candidate) => candidate.meta.foodRoute === 'forage')
  return {
    pass: focusCandidates.length >= 12 && forage !== undefined,
    detail: `focusCandidates=${focusCandidates.length} forage=${forage?.id ?? 'none'} routes=[${foodRoutes(result.candidates).join(',')}]`,
  }
})

// --- (c) fed body: unchanged --------------------------------------------------

addCase('(c1) fed body (food=20) with an edible block and a cow: no food routes at all', () => {
  const state = perceive({
    counts: {},
    food: 20,
    blocks: [
      { at: { x: 2, y: 64, z: 0 }, name: 'sweet_berry_bush' },
      { at: { x: 3, y: 64, z: 2 }, name: 'crafting_table', diggable: true },
    ],
    entities: [animal('cow', 12)],
  })
  const result = grounded(state)
  const routes = foodRoutes(result.candidates)
  return {
    pass: routes.length === 0 && result.foodGap === null,
    detail: `food=20 routes=[${routes.join(',')}] gap=${result.foodGap === null ? 'none' : 'set'}`,
  }
})

addCase('(c2) fed body holding food: no EAT (EAT_REFUSED reason=full), no cook route', () => {
  const state = perceive({ counts: { cooked_beef: 3 }, food: 20, blocks: FLOOR })
  const result = grounded(state)
  const eat = result.candidates.find((candidate) => candidate.kind === 'EAT')
  const cook = result.candidates.find((candidate) => candidate.meta.foodRoute === 'cook')
  return {
    pass: eat === undefined && cook === undefined && result.foodGap === null,
    detail: `food=20 held=${String(pickFood(state))} eat=${eat?.id ?? 'none'} cook=${cook?.id ?? 'none'}`,
  }
})

addCase('(c3) hungry-but-fed-enough body holding an edible item still gets EAT (unchanged)', () => {
  const state = perceive({ counts: { cooked_beef: 3 }, food: 12, blocks: FLOOR })
  const result = grounded(state)
  const eat = result.candidates.find((candidate) => candidate.kind === 'EAT')
  return {
    pass: eat !== undefined && eat.id === 'EAT:cooked_beef' && result.foodGap === null,
    detail: `food=12 eat=${eat?.id ?? 'none'} gap=${result.foodGap === null ? 'none' : 'set'}`,
  }
})

// --- (d) no food source anywhere: bounded typed escalation ---------------------

addCase('(d1) starving with no food source anywhere: typed FOOD_SOURCE_NONE naming every missing affordance', () => {
  const state = perceive({ counts: { raw_iron: 2, oak_log: 4 }, food: 0, health: 1, blocks: FLOOR })
  const result = grounded(state)
  const gap = result.foodGap
  if (gap === null) return { pass: false, detail: 'foodGap=null (silent starvation)' }
  const line = formatFoodSourceGap(gap)
  const namesAll =
    line.includes('FOOD_SOURCE_NONE') &&
    line.includes('no_edible_held') &&
    line.includes('no_food_animal_sensed') &&
    line.includes('no_edible_block_sensed') &&
    line.includes('starving=true') &&
    (gap.next === 'explore' || gap.next === 'escalate')
  return {
    pass: gap.reason === 'no_source_sensed' && gap.starving && namesAll,
    detail: line,
  }
})

addCase('(d2) the gap is computed from the OFFERED set: a sensed animal clears it', () => {
  const state = perceive({ counts: {}, food: 0, health: 1, entities: [animal('cow', 12)], blocks: FLOOR })
  const result = grounded(state)
  return {
    pass: result.foodGap === null,
    detail: `gap=${result.foodGap === null ? 'none' : formatFoodSourceGap(result.foodGap)}`,
  }
})

addCase('(d3) an animal sensed but OUTSIDE the hunt range does not clear the gap', () => {
  const state = perceive({ counts: {}, food: 0, health: 1, entities: [animal('cow', 40)], blocks: FLOOR })
  const result = grounded(state)
  const gap = result.foodGap
  return {
    pass: gap !== null && gap.sensedAnimal === false,
    detail: gap === null ? 'gap=none' : formatFoodSourceGap(gap),
  }
})

addCase('(d4) a hungry body with a route reports no gap; a fed body never reports one', () => {
  const hungryWithRoute = grounded(
    perceive({ counts: {}, food: 14, blocks: [{ at: { x: 2, y: 64, z: 0 }, name: 'sweet_berry_bush' }] }),
  )
  const fed = grounded(perceive({ counts: {}, food: 20, blocks: FLOOR }))
  return {
    pass: hungryWithRoute.foodGap === null && fed.foodGap === null,
    detail: `hungryWithRoute=${hungryWithRoute.foodGap === null ? 'none' : 'set'} fed=${fed.foodGap === null ? 'none' : 'set'}`,
  }
})

addCase('(d5) foodSourceGap is pure: the same state yields the same gap line', () => {
  const state = perceive({ counts: {}, food: 0, health: 1, blocks: FLOOR })
  const first = foodSourceGap(state, options(), generateGroundedCandidates(state, options()).candidates)
  const second = foodSourceGap(state, options(), generateGroundedCandidates(state, options()).candidates)
  return {
    pass:
      first !== null &&
      second !== null &&
      formatFoodSourceGap(first) === formatFoodSourceGap(second),
    detail: first === null ? 'gap=null' : formatFoodSourceGap(first),
  }
})

// --- (e) the food truth table --------------------------------------------------

addCase('(e1) the eat truth is one table: mushroom_stew / glow_berries are edible, raw red_mushroom is not', () => {
  return {
    pass:
      isEdibleFoodItem('mushroom_stew') &&
      isEdibleFoodItem('glow_berries') &&
      isEdibleFoodItem('sweet_berries') &&
      isEdibleFoodItem('apple') &&
      !isEdibleFoodItem('red_mushroom') &&
      !isEdibleFoodItem('brown_mushroom') &&
      !isEdibleFoodItem('oak_leaves'),
    detail: 'stew/berries/apple edible; mushrooms and leaves are ingredients/sources, not food',
  }
})

addCase('(e2) a forage cell is only offered while it can still end the hunger', () => {
  const starving = grounded(
    perceive({ counts: {}, food: 0, health: 1, blocks: [{ at: { x: 2, y: 64, z: 0 }, name: 'sweet_berry_bush' }] }),
  )
  const satisfied = grounded(
    perceive({
      counts: { sweet_berries: 2 },
      food: 0,
      health: 1,
      blocks: [{ at: { x: 2, y: 64, z: 0 }, name: 'sweet_berry_bush' }],
    }),
  )
  const starvingForage = starving.candidates.some((candidate) => candidate.meta.foodRoute === 'forage')
  const satisfiedForage = satisfied.candidates.some((candidate) => candidate.meta.foodRoute === 'forage')
  const satisfiedEat = satisfied.candidates.some((candidate) => candidate.kind === 'EAT')
  return {
    pass: starvingForage && satisfiedEat && !satisfiedForage,
    detail: `starvingForage=${starvingForage} heldEat=${satisfiedEat} heldForage=${satisfiedForage} (EAT wins by being the held item, not by rank)`,
  }
})

// --- (f) the starvation vocabulary is mirrored run evidence --------------------

addCase('(f1) the hunger/starvation markers ride the mirrored event path', () => {
  const tokens = [
    'BODY_STARVING health=1/6 food=0 at=1,2,3',
    'FOOD_LOW food=0 threshold=18',
    'EAT_REFUSED reason=no_food',
    'FOOD_ROUTE kind=forage target=sweet_berries',
    'FOOD_SOURCE_NONE item=food reason=no_source_sensed',
    'CRITICAL_DAMAGE goal=x health=1/6 damage=1/3 food=0 source=environment',
    'CRITICAL_DAMAGE_EXHAUSTED goal=x health=1/6 damage=3/3 food=0 source=environment',
  ]
  const mapped = tokens.map((line) => mirroredEventToken(line))
  const expected = [
    'BODY_STARVING',
    'FOOD_LOW',
    'EAT_REFUSED',
    'FOOD_ROUTE',
    'FOOD_SOURCE_NONE',
    'CRITICAL_DAMAGE',
    'CRITICAL_DAMAGE_EXHAUSTED',
  ]
  return {
    pass: mapped.every((token, index) => token === expected[index]),
    detail: `tokens=[${mapped.map((token) => String(token)).join(',')}]`,
  }
})

// --- (g) the option layer sees the starvation state ----------------------------

addCase('(g1) the plan layer gets a typed starvation fact while the body is at the floor', () => {
  const fact = starvationFact({ food: 0, health: 1 } as never)
  const healthy = starvationFact({ food: 20, health: 20 } as never)
  const hungryNotStarving = starvationFact({ food: 6, health: 14 } as never)
  const unknown = starvationFact({ food: undefined, health: undefined } as never)
  return {
    pass:
      fact !== null &&
      fact.includes('BODY_STARVING') &&
      fact.includes('health=1/') &&
      fact.includes('food=0') &&
      healthy === null &&
      hungryNotStarving === null &&
      unknown === null,
    detail: `starving=${String(fact)} fed=${String(healthy)} hungry=${String(hungryNotStarving)} unknown=${String(unknown)}`,
  }
})

addCase('(g2) the plan-layer fact is position-free, so it cannot churn the model-call identity', () => {
  const first = starvationFact({ food: 0, health: 1 } as never)
  const second = starvationFact({ food: 0, health: 1 } as never)
  return {
    pass: first !== null && first === second && !first.includes('at='),
    detail: `fact=${String(first)}`,
  }
})

// ---------------------------------------------------------------------------

let failures = 0
process.stdout.write('food route: grounded food acquisition for a starving body\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} food-route cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
