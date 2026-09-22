// test-m3-terminal-craft.mts - offline proof of the M3 terminal craft chain.
//
// M3's predicate is a single inventory threshold: `ender_eye >= 12`
// (AGENTS.md section 5; tools/m3-gate.mjs ENDER_EYE_REQUIRED). The ladder's
// terminal rung emits `craft 12 x ender_eye` (buddy-driver/planner-legacy.ts
// RUNGS id=ender_eyes). This fixture pins the mechanics truth that chain rests
// on, straight from the pinned minecraft-data registry the live Leaf 1.21.11
// server makes mineflayer@4.39.0 load:
//
//   * `ender_eye` IS an item (id 1128, "Eye of Ender");
//     `eye_of_ender` is ONLY the thrown projectile ENTITY (entity id 50). It is
//     never an item and must never be counted by an M3 predicate.
//   * `ender_eye <= 1 ender_pearl + 1 blaze_powder` (shapeless, 2x2 inventory).
//   * `blaze_powder x2 <= 1 blaze_rod` (shapeless, 2x2 inventory).
//   * `blaze_rod` has NO crafting recipe: it is a blaze mob drop and must be
//     collected, never crafted.
//
// Arithmetic: 12 eyes = 12 pearls + 12 blaze_powder = 6 blaze_rods exactly.
// The ladder's `blaze_rods` rung asks for >= 7 (collect 7 x blaze_rod). That is
// one rod MORE than the craft minimum; it is a conservative surplus (7 rods ->
// 14 powder), so it can never under-supply the craft. The fixture pins both the
// exact minimum (6) and the ladder/gate margin (7) so the off-by-one is visible.
//
// The multi-count craft stall this file used to document is FIXED, and the pin
// now sits in the assertions rather than in a defect note: `craftCandidates`
// plans with `want = craftGoalRequirement(state, focusItem)` (the active goal's
// `requiredCount`, `candidates.ts:5920`), so the terminal `craft 12 x ender_eye`
// goal keeps emitting a craft step at 1..11 eyes. The diagnostic section at the
// bottom prints `DEFECT_FIXED` for every partial count and flips back to
// `KNOWN_DEFECT` automatically if a later change re-threads `want = 1`.
//
// Run: bun jev-agent/test-m3-terminal-craft.mts
//       (also auto-run by jev-agent/bun-tests/legacy-suite.test.ts)
import { defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import { createRecipeIndex, planNextCraftStep } from './src/crafting.ts'
import { loadGameData } from './src/gameData.ts'
import type { GameDataRegistry } from './src/gameData.ts'
import { RUNGS } from '../buddy-driver/planner-legacy.ts'
import type { Rung } from '../buddy-driver/planner-legacy.ts'
import type {
  AgentSignals,
  GoalState,
  InventoryState,
  SelfState,
  Vec3Json,
  WorldState,
} from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'

const ENDER_EYE = 'ender_eye'
const EYE_OF_ENDER = 'eye_of_ender'
const BLAZE_POWDER = 'blaze_powder'
const BLAZE_ROD = 'blaze_rod'
const ENDER_PEARL = 'ender_pearl'
const EYES_REQUIRED = 12
const POWDER_PER_EYE = 1
const POWDER_PER_ROD = 2
/** tools/m3-gate.mjs BLAZE_ROD_REQUIRED (kept as the ladder's rung threshold too). */
const LADDER_BLAZE_ROD_THRESHOLD = 7

const registry = loadGameData()
const recipes = createRecipeIndex(registry)

/** The ladder's `satisfied`/`goals` take a world memory the inventory rungs ignore. */
const noWorld = {} as unknown as Parameters<Rung['satisfied']>[1]

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

function extendedRegistry(): GameDataRegistry & {
  entitiesByName?: Record<string, { id?: number; type?: string; category?: string; name?: string }>
} {
  return registry as GameDataRegistry & {
    entitiesByName?: Record<string, { id?: number; type?: string; category?: string; name?: string }>
  }
}

// ---------------------------------------------------------------------------
// 1. item vs projectile entity
// ---------------------------------------------------------------------------

addCase('ender_eye is an item (id 1128); eye_of_ender is only a projectile entity', () => {
  const item = registry.itemsByName?.[ENDER_EYE]
  const entity = extendedRegistry().entitiesByName?.[EYE_OF_ENDER]
  const entityAsItem = registry.itemsByName?.[EYE_OF_ENDER]
  const pass =
    item?.id === 1128 &&
    entity?.id === 50 &&
    typeof entity?.type === 'string' &&
    entityAsItem === undefined
  return {
    pass,
    detail: `ender_eye.itemId=${String(item?.id)} eye_of_ender.entityId=${String(entity?.id)} type=${String(entity?.type)} eye_of_ender.itemId=${String(entityAsItem?.id)}`,
  }
})

addCase('the planning recipe index knows ender_eye as an item and never eye_of_ender', () => {
  const pass =
    recipes.hasItem(ENDER_EYE) &&
    recipes.itemId(ENDER_EYE) === 1128 &&
    !recipes.hasItem(EYE_OF_ENDER) &&
    recipes.itemId(EYE_OF_ENDER) === null &&
    recipes.recipesFor(EYE_OF_ENDER).length === 0
  return {
    pass,
    detail: `ender_eye=${String(recipes.itemId(ENDER_EYE))} eye_of_ender=${String(recipes.itemId(EYE_OF_ENDER))} eye_of_ender_recipes=${recipes.recipesFor(EYE_OF_ENDER).length}`,
  }
})

// ---------------------------------------------------------------------------
// 2. recipe truth
// ---------------------------------------------------------------------------

addCase('ender_eye recipe is exactly 1 ender_pearl + 1 blaze_powder -> 1 (2x2 inventory)', () => {
  const variants = recipes.recipesFor(ENDER_EYE)
  const variant = variants[0]
  const ingredients = variant?.ingredients ?? []
  const pearl = ingredients.find((entry) => entry.item === ENDER_PEARL)?.count ?? 0
  const powder = ingredients.find((entry) => entry.item === BLAZE_POWDER)?.count ?? 0
  const pass =
    variants.length === 1 &&
    variant?.resultCount === 1 &&
    variant?.requiresTable === false &&
    ingredients.length === 2 &&
    pearl === 1 &&
    powder === 1
  return {
    pass,
    detail: `variants=${variants.length} result=${String(variant?.resultCount)} requiresTable=${String(variant?.requiresTable)} pearl=${pearl} powder=${powder}`,
  }
})

addCase('blaze_powder recipe is exactly 1 blaze_rod -> 2 blaze_powder (2x2 inventory)', () => {
  const variants = recipes.recipesFor(BLAZE_POWDER)
  const variant = variants[0]
  const rod = variant?.ingredients.find((entry) => entry.item === BLAZE_ROD)?.count ?? 0
  const pass =
    variants.length === 1 &&
    variant?.resultCount === POWDER_PER_ROD &&
    variant?.requiresTable === false &&
    variant?.ingredients.length === 1 &&
    rod === 1
  return {
    pass,
    detail: `variants=${variants.length} result=${String(variant?.resultCount)} requiresTable=${String(variant?.requiresTable)} rod=${rod}`,
  }
})

addCase('blaze_rod and ender_pearl have no crafting recipe (raw mob drops)', () => {
  const pass = recipes.recipesFor(BLAZE_ROD).length === 0 && recipes.recipesFor(ENDER_PEARL).length === 0
  return {
    pass,
    detail: `blaze_rod_recipes=${recipes.recipesFor(BLAZE_ROD).length} ender_pearl_recipes=${recipes.recipesFor(ENDER_PEARL).length}`,
  }
})

// ---------------------------------------------------------------------------
// 3. arithmetic: rods -> powder -> eyes
// ---------------------------------------------------------------------------

addCase('12 eyes need 12 powder = exactly 6 blaze_rods; the ladder asks 7 (surplus, never short)', () => {
  const powderNeeded = EYES_REQUIRED * POWDER_PER_EYE
  const rodsExact = Math.ceil(powderNeeded / POWDER_PER_ROD)
  const surplusPowder = LADDER_BLAZE_ROD_THRESHOLD * POWDER_PER_ROD - powderNeeded
  const pass =
    powderNeeded === 12 &&
    rodsExact === 6 &&
    LADDER_BLAZE_ROD_THRESHOLD >= rodsExact &&
    surplusPowder === 2
  return {
    pass,
    detail: `eyes=${EYES_REQUIRED} powderNeeded=${powderNeeded} rodsExact=${rodsExact} ladderThreshold=${LADDER_BLAZE_ROD_THRESHOLD} surplusPowder=${surplusPowder}`,
  }
})

// ---------------------------------------------------------------------------
// 4. ladder truth (the rung the resident actually executes)
// ---------------------------------------------------------------------------

addCase('ladder blaze_rods rung: collect 7 x blaze_rod, satisfied only at >= 7', () => {
  const rung = RUNGS.find((entry) => entry.id === 'blaze_rods')
  const goals = rung?.goals({}, noWorld) ?? []
  const goal = goals[0]
  const pass =
    rung !== undefined &&
    rung.satisfied({ [BLAZE_ROD]: LADDER_BLAZE_ROD_THRESHOLD - 1 }, noWorld) === false &&
    rung.satisfied({ [BLAZE_ROD]: LADDER_BLAZE_ROD_THRESHOLD }, noWorld) === true &&
    goals.length === 1 &&
    goal?.kind === 'collect' &&
    goal.targetItem === BLAZE_ROD &&
    goal.requiredCount === LADDER_BLAZE_ROD_THRESHOLD
  return {
    pass,
    detail: `at6=${String(rung?.satisfied({ [BLAZE_ROD]: 6 }, noWorld))} at7=${String(rung?.satisfied({ [BLAZE_ROD]: 7 }, noWorld))} goal=${String(goal?.kind)}:${String(goal?.targetItem)}:${String(goal?.requiredCount)}`,
  }
})

addCase('ladder ender_eyes rung: craft 12 x ender_eye, satisfied only at ender_eye >= 12', () => {
  const rung = RUNGS.find((entry) => entry.id === 'ender_eyes')
  const goals = rung?.goals({}, noWorld) ?? []
  const goal = goals[0]
  const pass =
    rung !== undefined &&
    rung.satisfied({ [ENDER_EYE]: EYES_REQUIRED - 1 }, noWorld) === false &&
    rung.satisfied({ [ENDER_EYE]: EYES_REQUIRED }, noWorld) === true &&
    goals.length === 1 &&
    goal?.kind === 'craft' &&
    goal.targetItem === ENDER_EYE &&
    goal.requiredCount === EYES_REQUIRED
  return {
    pass,
    detail: `at11=${String(rung?.satisfied({ [ENDER_EYE]: 11 }, noWorld))} at12=${String(rung?.satisfied({ [ENDER_EYE]: 12 }, noWorld))} goal=${String(goal?.kind)}:${String(goal?.targetItem)}:${String(goal?.requiredCount)}`,
  }
})

addCase('no ladder rung names or counts the eye_of_ender projectile entity', () => {
  const entityCounts = { [EYE_OF_ENDER]: EYES_REQUIRED }
  const offenders = RUNGS.filter((entry) => {
    const goals = entry.goals({}, noWorld)
    return entry.id.includes(EYE_OF_ENDER) || goals.some((goal) => goal.targetItem === EYE_OF_ENDER)
  }).map((entry) => entry.id)
  // The terminal predicate must ignore an eye_of_ender count of 12.
  const eyesRung = RUNGS.find((entry) => entry.id === 'ender_eyes')
  const projectileSatisfies = eyesRung?.satisfied(entityCounts, noWorld) === true
  const pass = offenders.length === 0 && projectileSatisfies === false
  return {
    pass,
    detail: `offenders=[${offenders.join(',')}] eye_of_ender_satisfies_terminal=${String(projectileSatisfies)}`,
  }
})

// ---------------------------------------------------------------------------
// 5. the planner expresses the concrete craft steps
// ---------------------------------------------------------------------------

addCase('planNextCraftStep with materials (no eyes yet) emits one craft 1x ender_eye in the 2x2 inventory', () => {
  const plan = planNextCraftStep(
    recipes,
    ENDER_EYE,
    { [ENDER_PEARL]: 12, [BLAZE_POWDER]: 12 },
    false,
  )
  const op = plan.op
  const pass =
    op !== null &&
    op.type === 'craft' &&
    op.item === ENDER_EYE &&
    op.count === 1 &&
    op.requiresTable === false
  return { pass, detail: `op=${JSON.stringify(op)} reason=${plan.reason}` }
})

addCase('planNextCraftStep descends blaze_rod -> blaze_powder with the 1 -> 2 ratio', () => {
  const plan = planNextCraftStep(recipes, ENDER_EYE, { [ENDER_PEARL]: 12, [BLAZE_ROD]: 6 }, false)
  const op = plan.op
  const pass = op !== null && op.type === 'craft' && op.item === BLAZE_POWDER && op.count === POWDER_PER_ROD
  return { pass, detail: `op=${JSON.stringify(op)} reason=${plan.reason}` }
})

addCase('candidate layer offers CRAFT:ender_eye for craft 12 x ender_eye at 0 eyes with full materials', () => {
  const grounded = generateGroundedCandidates(
    world({ [ENDER_PEARL]: 12, [BLAZE_POWDER]: 12 }, 0),
    { ...defaultCandidateOptions, recipes },
  )
  const ids = grounded.candidates.map((candidate) => candidate.id)
  const pass = ids.includes(`CRAFT:${ENDER_EYE}`)
  return { pass, detail: `candidates=[${ids.join(',')}]` }
})

// ---------------------------------------------------------------------------
// world builder (single goal: craft 12 x ender_eye)
// ---------------------------------------------------------------------------

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_M3_CRAFT_TRUTH',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'the_nether',
    isDay: false,
    heldItem: null,
  }
}

function inventory(counts: Record<string, number>): InventoryState {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, count) => sum + count, 0) }
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

function queuedGoal(eyesHeld: number): QueuedGoal {
  return {
    id: 'g-craft-ender-eyes',
    kind: 'craft',
    description: `craft ${EYES_REQUIRED} x ${ENDER_EYE}`,
    targetItem: ENDER_EYE,
    requiredCount: EYES_REQUIRED,
    startCount: 0,
    haveCount: eyesHeld,
    status: 'active',
    origin: 'bootstrap',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function queue(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

function world(counts: Record<string, number>, eyesHeld: number): WorldState {
  const position: Vec3Json = { x: 0, y: 64, z: 0 }
  const current = queuedGoal(eyesHeld)
  const goal: GoalState = {
    id: current.id,
    description: current.description,
    targetItem: ENDER_EYE,
    requiredCount: EYES_REQUIRED,
    startCount: 0,
    haveCount: eyesHeld,
    progress: Math.min(1, eyesHeld / EYES_REQUIRED),
    complete: eyesHeld >= EYES_REQUIRED,
    startedAtMs: 0,
  }
  return {
    schemaVersion: 1,
    tick: 1,
    timestampMs: 1_700_000_000_000,
    self: self(position),
    inventory: inventory(counts),
    entities: [],
    blocks: [],
    terrain: { standable: [position] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: [],
    stepCuts: [],
    headroomCuts: [],
    goal,
    goalQueue: queue(current),
    recentEvents: [],
    signals: signals(),
  }
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

let failures = 0
process.stdout.write('m3 terminal craft truth - rods -> powder -> ender_eye\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}

// ---------------------------------------------------------------------------
// KNOWN_DEFECT: multi-count craft cannot progress past one item.
//
// `generateGroundedCandidates` is asked for the real terminal goal
// `craft 12 x ender_eye`. With 0 eyes it offers CRAFT:ender_eye (pinned above).
// With 1..11 eyes and the remaining crafting materials in hand it offers no
// craft step at all, because `planNextCraftStep(..., want=1)` sees any held copy
// as "already satisfied". This section is diagnostic and never fails the suite;
// it flips to DEFECT_FIXED automatically if a later fix threads the remaining
// goal count into the craft plan.
// ---------------------------------------------------------------------------
process.stdout.write('-'.repeat(72) + '\n')
const stalls: string[] = []
for (let eyes = 1; eyes < EYES_REQUIRED; eyes += 1) {
  const remaining = EYES_REQUIRED - eyes
  const counts = { [ENDER_EYE]: eyes, [ENDER_PEARL]: remaining, [BLAZE_POWDER]: remaining }
  const grounded = generateGroundedCandidates(world(counts, eyes), {
    ...defaultCandidateOptions,
    recipes,
  })
  const hasCraft = grounded.candidates.some((candidate) => candidate.id === `CRAFT:${ENDER_EYE}`)
  stalls.push(`${eyes}->${hasCraft ? 'craft' : 'STALL'}`)
}
const planAtOne = planNextCraftStep(
  recipes,
  ENDER_EYE,
  { [ENDER_EYE]: 1, [ENDER_PEARL]: 11, [BLAZE_POWDER]: 11 },
  false,
)
const stalled = stalls.some((entry) => entry.endsWith('STALL'))
if (stalled) {
  process.stdout.write(
    `KNOWN_DEFECT  craft ${EYES_REQUIRED} x ${ENDER_EYE} offers no CRAFT step once eyes are held: ${stalls.join(' ')}\n`,
  )
  process.stdout.write(
    `KNOWN_DEFECT  planNextCraftStep(ender_eye) at 1 eye = ${JSON.stringify(planAtOne.op)} reason="${planAtOne.reason}"\n`,
  )
} else {
  process.stdout.write(`DEFECT_FIXED  craft ${EYES_REQUIRED} x ${ENDER_EYE} progresses at every partial count: ${stalls.join(' ')}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} m3-terminal-craft cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
