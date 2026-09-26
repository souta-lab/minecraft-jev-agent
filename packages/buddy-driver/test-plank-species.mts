// test-plank-species.mts - #plank-species regression: a GENERIC plank need must
// never commit the plan to a plank species the body cannot supply.
//
// MEASURED LIVE (run-mubobiq6-12onv, source c27fbb7, control-socket ledger):
//
//   done g8:collect:log 3/1 | ACTIVE g9:craft:acacia_planks 0/4 |
//   pending g10:craft:crafting_table 0/1 | pending g11:place:crafting_table 0/1
//   inventory {oak_log:42, birch_log:24, ...} - no acacia log, ever
//   done=7 flat while the body mined/moved (body motion, no semantic progress)
//
// OWNING LAYER: `selectCraftIngredients` (jev-agent/src/optionSpec-legacy.ts)
// ranked the 12 interchangeable `crafting_table` recipe variants by recipe
// signature, i.e. alphabetically first species = `acacia_planks`, and reported
// `inventoryAtLeast{acacia_planks,4}` as the craft's initiation precondition.
// `dependencyGoalForItem` then collapsed the row's own `acacia_log` requirement to
// the `log` CLASS, so the inserted `collect:log` row was satisfied by oak/birch -
// a species that can never make acacia planks. The consumer row could not be
// produced and pinned `craft:crafting_table` and its `place` row behind it.
//
// FIXTURES
//   (a) the live shape -> the plan uses a held species (or the `planks` class) and
//       never emits a species-pinned plank row; the ladder advances;
//   (b) a genuinely species-specific goal still asks for its own species;
//   (c) a held species with the count unmet keeps collect-then-craft unchanged;
//   (d) nothing held -> the existing wood-collection route, unchanged.
//
// Run: bun ./test-plank-species.mts
import { createRequire } from 'node:module'
import {
  compilePlannedGoal,
  describePredicate,
  expandOptionDependencies,
  isOptionStartable,
  makeOptionSnapshot,
  orderGoalsByReadiness,
  selectCraftIngredients,
} from '../jev-agent/src/optionSpec.ts'
import type { OptionWorldSnapshot } from '../jev-agent/src/optionSpec.ts'
import { recipesFor } from '../jev-agent/src/gameData.ts'
import { createRecipeIndex, planNextCraftStep } from '../jev-agent/src/crafting.ts'
import { logsForPlanks, planksPerLog, sourceUnitsForClass } from '../jev-agent/src/resourceClass.ts'
import { craftIngredientPrereq, defaultCandidateOptions, formatCraftIngredientPrereq } from '../jev-agent/src/candidates.ts'
import type { AgentSignals, BlockState, GoalState, InventoryState, SelfState, StepCut, Vec3Json, WorldState } from '../jev-agent/src/state.ts'
import type { GoalQueueSnapshot, GoalQueueState, PlannedGoal, QueuedGoal } from '../jev-agent/src/goalQueue.ts'
import { GoalQueue } from '../jev-agent/src/goalQueue.ts'
import { buildLadder } from './planner.ts'
import { emptyWorldMemory } from './resident-types.ts'
import type { ResidentWorldMemory } from './resident-types.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

/** The measured live inventory (run-mubobiq6-12onv): 42 oak + 24 birch, no acacia. */
const LIVE_INVENTORY: Record<string, number> = {
  dirt: 10,
  birch_log: 24,
  oak_sapling: 6,
  charcoal: 1,
  stick: 11,
  iron_ingot: 3,
  raw_copper: 11,
  oak_log: 42,
  birch_sapling: 2,
  leaf_litter: 31,
  raw_iron: 2,
  red_mushroom: 1,
}

const require_ = createRequire(import.meta.url)
const recipes = createRecipeIndex(require_('minecraft-data')('1.21.11') as unknown)

const world = (over: Partial<ResidentWorldMemory> = {}): ResidentWorldMemory => ({ ...emptyWorldMemory(), ...over })

const snap = (inventory: Readonly<Record<string, number>>): OptionWorldSnapshot =>
  makeOptionSnapshot({ inventory, dimension: 'minecraft:overworld', position: null, health: 20, toolRank: 0, knownStations: [], knownOres: [] })

const craft = (targetItem: string, requiredCount = 1): PlannedGoal => ({
  kind: 'craft',
  description: `craft ${requiredCount} x ${targetItem}`,
  targetItem,
  requiredCount,
})

const specIds = (specs: readonly { id: string }[]): string[] => specs.map((spec) => spec.id)

const preconditionText = (goal: PlannedGoal, snapshot: OptionWorldSnapshot): string => {
  const spec = compilePlannedGoal(goal, snapshot)
  return spec.preconditions.map(describePredicate).join(' & ') || 'none'
}

// ---------------------------------------------------------------------------
// candidate-layer world (the marker the runtime mirrors each tick)
// ---------------------------------------------------------------------------

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_PLANK_SPECIES',
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
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, count) => sum + count, 0) }
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

const LOG_BLOCKING: BlockState = {
  kind: 'stone',
  name: 'stone',
  position: { x: 39, y: 12, z: 31 },
  distance: 1,
  diggable: true,
  inReach: false,
  hasAdjacentStandable: true,
  adjacentStandable: { x: 39, y: 11, z: 32 },
  yield: 'cobblestone',
  harvestTool: 'pickaxe',
  harvestTier: 0,
  visible: true,
}

const BLOCKED_STEP: StepCut = {
  dir: 'N',
  dx: 0,
  dz: -1,
  cut: { x: 39, y: 12, z: 31 },
  step: { x: 39, y: 12, z: 31 },
  name: 'stone',
  safe: true,
  reason: 'safe',
}

/** Minimal sensed world whose only craft goal is `current` (no station in range). */
function candidateWorld(current: QueuedGoal, counts: Record<string, number>): WorldState {
  const position = { x: 39, y: 11, z: 32 }
  const goal: GoalState = {
    id: current.id,
    description: current.description,
    targetItem: current.targetItem ?? 'crafting_table',
    requiredCount: current.requiredCount,
    startCount: current.startCount,
    haveCount: current.haveCount,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
  const queue: GoalQueueState = { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
  return {
    schemaVersion: 1,
    tick: 41,
    timestampMs: 1_700_000_000_000,
    self: self(position),
    inventory: inventory(counts),
    entities: [],
    blocks: [LOG_BLOCKING],
    terrain: { standable: [position, { x: 41, y: 11, z: 32 }] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: [],
    stepCuts: [BLOCKED_STEP],
    headroomCuts: [],
    goal,
    goalQueue: queue,
    recentEvents: [],
    signals: signals(),
  }
}

const craftRow = (targetItem: string, requiredCount: number): QueuedGoal => ({
  id: `t:craft:${targetItem}`,
  kind: 'craft',
  description: `craft ${requiredCount} x ${targetItem}`,
  targetItem,
  requiredCount,
  startCount: 0,
  haveCount: 0,
  status: 'active',
  origin: 'llm',
  createdAt: 0,
  updatedAt: 0,
  detail: null,
})

/** The typed candidate-layer marker the tick mirrors for the current craft goal. */
function markerFor(targetItem: string, requiredCount: number, counts: Record<string, number>): string {
  const line = craftIngredientPrereq(candidateWorld(craftRow(targetItem, requiredCount), counts), {
    ...defaultCandidateOptions,
    recipes,
  })
  return line === null ? 'none' : formatCraftIngredientPrereq(line)
}

// ---------------------------------------------------------------------------
// (a1) the live shape: 42 oak + 24 birch logs, no acacia
// ---------------------------------------------------------------------------
addCase('(a1) live shape: the crafting_table plan uses a HELD species and emits no acacia row', () => {
  const table = craft('crafting_table')
  const snapshot = snap(LIVE_INVENTORY)
  const spec = compilePlannedGoal(table, snapshot)
  const expansion = expandOptionDependencies(spec, snapshot)
  const ordered = orderGoalsByReadiness([table], snapshot)
  const marker = markerFor('crafting_table', 1, LIVE_INVENTORY)
  // The candidate layer picks the FIRST producible variant, so the grounded
  // species is data order (birch before oak) - either held species is correct.
  const heldSpecies = Object.keys(LIVE_INVENTORY)
    .filter((name) => name.endsWith('_log'))
    .map((name) => name.slice(0, -'_log'.length))
  const acceptableMarkers = heldSpecies.map(
    (species) => `CRAFT_INGREDIENT_PREREQ item=crafting_table missing=${species}_planks producer=craft ${species}_planks`,
  )
  const detail =
    `preconditions=${preconditionText(table, snapshot)} chain=[${specIds(expansion.specs).join(' -> ')}] ` +
    `inserted=${ordered.inserted.length} ready=${ordered.ready.length} marker="${marker}"`
  const pass =
    spec.preconditions.length === 0 &&
    isOptionStartable(spec, snapshot) &&
    specIds(expansion.specs).join(',') === 'craft:crafting_table' &&
    !specIds(expansion.specs).some((id) => id.includes('acacia')) &&
    ordered.inserted.length === 0 &&
    ordered.ready.length === 1 &&
    acceptableMarkers.includes(marker)
  return { pass, detail }
})

// ---------------------------------------------------------------------------
// (a2) the birth condition: nothing held at plan time
// ---------------------------------------------------------------------------
addCase('(a2) nothing held: the generic need becomes `class planks` and one collect log, never acacia', () => {
  const table = craft('crafting_table')
  const snapshot = snap({})
  const spec = compilePlannedGoal(table, snapshot)
  const expansion = expandOptionDependencies(spec, snapshot)
  const ordered = orderGoalsByReadiness([table], snapshot)
  const head = ordered.goals[0]
  const selection = selectCraftIngredients(recipesFor('crafting_table'), {})
  const marker = markerFor('crafting_table', 1, {})
  const detail =
    `preconditions=${preconditionText(table, snapshot)} chain=[${specIds(expansion.specs).join(' -> ')}] ` +
    `head=${head?.kind}:${head?.targetItem}x${head?.requiredCount} ` +
    `rawVariant=${selection?.variant.signature ?? 'none'} rawMissing=${selection?.missing.map((need) => need.cls ?? need.item).join(',') ?? 'none'} ` +
    `planksPerLog=${String(planksPerLog())} logsFor4=${String(logsForPlanks(4))} marker="${marker}"`
  const pass =
    spec.preconditions.length === 1 &&
    describePredicate(spec.preconditions[0]!) === 'class planks >= 4' &&
    specIds(expansion.specs).join(',') === 'collect:log,craft:crafting_table' &&
    !specIds(expansion.specs).some((id) => id.includes('planks')) &&
    head?.kind === 'collect' &&
    head.targetItem === 'log' &&
    head.requiredCount === 1 &&
    // The deterministic variant anchor is still the alphabetical one - only the
    // REQUIREMENT is now the class, which is why the anchor never reaches a row.
    selection?.variant.signature === 'crafting_tablex1<=acacia_planksx4' &&
    selection?.missing.length === 1 &&
    selection.missing[0]?.cls === 'planks' &&
    selection.missing[0]?.item === 'planks' &&
    planksPerLog() === 4 &&
    logsForPlanks(4) === 1 &&
    sourceUnitsForClass('planks', 8) === 2 &&
    marker === 'CRAFT_INGREDIENT_PREREQ item=crafting_table missing=planks producer=collect log'
  return { pass, detail }
})

// ---------------------------------------------------------------------------
// (a3) the measured live ledger: the stale row must not survive the next plan
// ---------------------------------------------------------------------------
function liveLedgerSnapshot(): GoalQueueSnapshot {
  const acaciaSpec = compilePlannedGoal(craft('acacia_planks', 4))
  const rows: QueuedGoal[] = [
    {
      id: 'g8:collect:log',
      kind: 'collect',
      description: 'collect 1 x log',
      targetItem: 'log',
      requiredCount: 1,
      startCount: 0,
      haveCount: 3,
      status: 'done',
      origin: 'llm',
      createdAt: 0,
      updatedAt: 0,
      detail: null,
    },
    {
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
      optionInstanceId: 'craft:acacia_planks#c4',
      optionTemplateId: 'craft:acacia_planks',
      optionSpec: acaciaSpec,
      // The measured row was a mechanically expanded prerequisite of the
      // System2 goal `craft crafting_table`, not a species goal of its own.
      semanticOptionInstanceId: 'craft:crafting_table',
      semanticOptionTemplateId: 'craft:crafting_table',
      semanticOptionIntent: 'craft crafting_table',
    },
    {
      id: 'g10:craft:crafting_table',
      kind: 'craft',
      description: 'craft crafting_table',
      targetItem: 'crafting_table',
      requiredCount: 1,
      startCount: 0,
      haveCount: 0,
      status: 'pending',
      origin: 'llm',
      createdAt: 0,
      updatedAt: 0,
      detail: null,
      semanticOptionInstanceId: 'craft:crafting_table',
      semanticOptionTemplateId: 'craft:crafting_table',
      semanticOptionIntent: 'craft crafting_table',
    },
    {
      id: 'g11:place:crafting_table',
      kind: 'place',
      description: 'place crafting_table',
      targetItem: 'crafting_table',
      requiredCount: 1,
      startCount: 0,
      haveCount: 0,
      status: 'pending',
      origin: 'llm',
      createdAt: 0,
      updatedAt: 0,
      detail: null,
    },
  ]
  return { counter: 11, goals: rows, revision: 1 }
}

addCase('(a3) measured live ledger: the next plan drops the ungroundable acacia row and heads the table craft', () => {
  const queue = new GoalQueue()
  queue.restore(liveLedgerSnapshot())
  const stalledHead = queue.state.current
  const ladder = buildLadder(LIVE_INVENTORY, world())
  queue.applyPlan(ladder.goals, 'llm', 'replace')
  const current = queue.state.current
  const unfinishedAcacia = queue.state.goals.filter(
    (goal) => goal.targetItem === 'acacia_planks' && (goal.status === 'pending' || goal.status === 'active'),
  )
  const headGoal = current === null ? null : { kind: current.kind, targetItem: current.targetItem ?? null }
  const headStartable =
    current === null
      ? false
      : isOptionStartable(
          compilePlannedGoal(
            { kind: current.kind, description: current.description, targetItem: current.targetItem, requiredCount: current.requiredCount },
            snap(LIVE_INVENTORY),
          ),
          snap(LIVE_INVENTORY),
        )
  const detail =
    `stalledHead=${stalledHead?.id ?? 'none'} ladder=[${ladder.goals.map((goal) => `${goal.kind}:${goal.targetItem}`).join(',')}] ` +
    `after=[${queue.state.goals.map((goal) => `${goal.id}:${goal.status}`).join(' | ')}] ` +
    `head=${headGoal?.kind ?? 'none'}:${headGoal?.targetItem ?? 'none'} startable=${String(headStartable)}`
  const pass =
    stalledHead?.id === 'g9:craft:acacia_planks' &&
    unfinishedAcacia.length === 0 &&
    headGoal?.targetItem === 'crafting_table' &&
    headStartable === true
  return { pass, detail }
})

// ---------------------------------------------------------------------------
// (b) a genuinely species-specific goal still asks for ITS species
// ---------------------------------------------------------------------------
addCase('(b) a species-specific goal keeps its species: no silent substitution', () => {
  const acacia = craft('acacia_planks', 4)
  const empty = snap({})
  const held = snap({ acacia_log: 2 })
  const acaciaExpansion = expandOptionDependencies(compilePlannedGoal(acacia, empty), empty)
  const boat = craft('oak_boat')
  const birchPlanks = snap({ birch_planks: 5 })
  const boatSpec = compilePlannedGoal(boat, birchPlanks)
  const detail =
    `acaciaPreconditions=${preconditionText(acacia, empty)} acaciaChain=[${specIds(acaciaExpansion.specs).join(' -> ')}] ` +
    `acaciaHeldStartable=${String(isOptionStartable(compilePlannedGoal(acacia, held), held))} ` +
    `oakBoatPreconditions=${preconditionText(boat, birchPlanks)} oakBoatStartableWithBirch=${String(isOptionStartable(boatSpec, birchPlanks))}`
  const pass =
    describePredicate(compilePlannedGoal(acacia, empty).preconditions[0]!) === 'acacia_log >= 1' &&
    specIds(acaciaExpansion.specs).join(',') === 'collect:log,craft:acacia_planks' &&
    isOptionStartable(compilePlannedGoal(acacia, held), held) &&
    // `oak_boat` has exactly ONE recipe variant, so its concrete plank survives:
    // five birch planks must NOT satisfy an oak requirement.
    describePredicate(boatSpec.preconditions[0]!) === 'oak_planks >= 5' &&
    isOptionStartable(boatSpec, birchPlanks) === false
  return { pass, detail }
})

// ---------------------------------------------------------------------------
// (c) a held species with the count unmet: collect-then-craft unchanged
// ---------------------------------------------------------------------------
addCase('(c) held species under count keeps collect-then-craft unchanged', () => {
  const table = craft('crafting_table')
  const twoBirch = snap({ birch_planks: 2 })
  const expansion = expandOptionDependencies(compilePlannedGoal(table, twoBirch), twoBirch)
  const marker = markerFor('crafting_table', 1, { birch_planks: 2 })
  const pickaxe = craft('wooden_pickaxe')
  const livePlanks = snap({ birch_planks: 2, stick: 2 })
  const pickaxeOrder = orderGoalsByReadiness([pickaxe], livePlanks)
  const detail =
    `tablePreconditions=${preconditionText(table, twoBirch)} chain=[${specIds(expansion.specs).join(' -> ')}] ` +
    `pickaxeHead=${pickaxeOrder.goals[0]?.kind}:${pickaxeOrder.goals[0]?.targetItem} marker="${marker}"`
  const pass =
    describePredicate(compilePlannedGoal(table, twoBirch).preconditions[0]!) === 'birch_planks >= 4' &&
    specIds(expansion.specs).join(',') === 'collect:log,craft:birch_planks,craft:crafting_table' &&
    pickaxeOrder.goals[0]?.kind === 'collect' &&
    pickaxeOrder.goals[0]?.targetItem === 'log' &&
    marker === 'CRAFT_INGREDIENT_PREREQ item=crafting_table missing=birch_planks producer=collect log'
  return { pass, detail }
})

// ---------------------------------------------------------------------------
// (d) nothing held: the existing wood-collection route, unchanged
// ---------------------------------------------------------------------------
addCase('(d) nothing held: the wood-collection route is unchanged (one class log, no fake craft)', () => {
  const table = craft('crafting_table')
  const snapshot = snap({})
  const ordered = orderGoalsByReadiness([table], snapshot)
  const insertion = ordered.inserted[0]
  const step = planNextCraftStep(recipes, 'crafting_table', {}, false, 1)
  const detail =
    `head=${ordered.goals[0]?.kind}:${ordered.goals[0]?.targetItem}x${ordered.goals[0]?.requiredCount} ` +
    `inserted=${insertion?.prerequisite.kind}:${insertion?.prerequisite.targetItem} ` +
    `candidateStep=${step.op === null ? `none(${step.reason})` : step.reason} ` +
    `blocked=${ordered.blocked.length} unresolved=${ordered.unresolved.length}`
  const pass =
    ordered.goals.length === 2 &&
    ordered.goals[0]?.kind === 'collect' &&
    ordered.goals[0]?.targetItem === 'log' &&
    ordered.goals[0]?.requiredCount === 1 &&
    insertion?.prerequisite.targetItem === 'log' &&
    insertion.consumer.targetItem === 'crafting_table' &&
    step.op === null &&
    step.reason === 'no satisfiable recipe for crafting_table' &&
    ordered.blocked.length === 1 &&
    ordered.unresolved.length === 0
  return { pass, detail }
})

// ---------------------------------------------------------------------------

let failures = 0
process.stdout.write('plank species grounding (#plank-species)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} plank-species cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
