// test-stone-focus-filter.mts - regression fixture for the purposeless-stone lag
// the owner reported: with an active `collect 1 x flint (from gravel)` goal the
// candidate generator kept offering clearance MINEs for nearby/ceiling stone and
// blind DESCEND tunnel steps, they completed (`verified=true status=done
// resource=stone progressDelta=0` / `DESCEND` digging), and were re-offered
// forever, so Jev's only concrete action advanced the goal by zero (live: a
// sprawling tunnel network with no flint).
//
// Root cause (code path): `generateRawCandidates` default branch ->
// `mineCandidates(state, options, focusItem)` correctly filters the focused pool
// by `resourceMatches(block.yield, focusItem)`, which is empty for `flint` and
// `gravel` (no sensed source and not satisfied by stone). But when the focused
// pool is empty it appends `headroomCandidates(...)` clearance MINEs and
// `descendCandidates(...)` steps that bypass the focus check; the `hasGoalRoute`
// filter only removes the clearance when ANOTHER goal route exists, so with no
// focused route the ceiling stone MINE / level tunnel step is the only concrete
// action and leaks to Jev.
//
// This fixture pins the smallest honest fix: a MINE is withheld when its drop
// cannot advance the active focus, and a DESCEND step is withheld when a SPECIFIC
// focus item's source is not underground and has no sensed/tunnel target. Both
// are withholding rules, not rankings: the remaining candidates keep their order.
//
//   bun test ./test-stone-focus-filter.mts
import { createRequire } from 'node:module'
import { createRecipeIndex } from './src/crafting.ts'
import { blockId, defaultCandidateOptions, generateCandidates } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import type {
  BlockState,
  GoalState,
  InventoryState,
  SelfState,
  Vec3Json,
  WorldState,
} from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'

const require = createRequire(import.meta.url)
// The live controller always passes `createRecipeIndex(bot.registry)`
// (controller-legacy.ts candidateOptions -> generateGroundedCandidates), so the
// fixture uses the same mechanics truth table.
const RECIPES = createRecipeIndex(require('minecraft-data')('1.21.11') as unknown)

const SELF: Vec3Json = { x: 0.5, y: 61, z: 0.5 }

function selfState(position: Vec3Json): SelfState {
  return {
    username: 'AI_M3FOCUS',
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

function queuedGoal(kind: QueuedGoal['kind'], targetItem: string | null, description: string): QueuedGoal {
  return {
    id: `g1:${kind}:${targetItem ?? 'none'}`,
    kind,
    description,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function queue(goal: QueuedGoal): GoalQueueState {
  return { depth: 1, current: goal, empty: false, hasImpossible: false, done: 0, goals: [goal] }
}

function goalState(targetItem: string, description: string): GoalState {
  return {
    id: `collect:${targetItem}`,
    description,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function signals(): WorldState['signals'] {
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

/** A sensed stone block (drop `cobblestone`) the sensor would put in `state.blocks`. */
function stoneBlock(position: Vec3Json, name = 'stone', yieldItem = 'cobblestone'): BlockState {
  return {
    kind: 'stone',
    name,
    position,
    distance: 1.5,
    diggable: true,
    inReach: true,
    hasAdjacentStandable: true,
    adjacentStandable: { x: position.x, y: position.y - 1, z: position.z },
    yield: yieldItem,
    harvestTool: 'pickaxe',
    // wooden pickaxe (rank 0) is enough for stone; the fixture holds one.
    harvestTier: 0,
    visible: true,
  }
}

/** A sensed log block in reach (drop `oak_log`). */
function logBlock(position: Vec3Json): BlockState {
  return {
    kind: 'log',
    name: 'oak_log',
    position,
    distance: 1.5,
    diggable: true,
    inReach: true,
    hasAdjacentStandable: true,
    adjacentStandable: { x: position.x, y: position.y - 1, z: position.z },
    yield: 'oak_log',
    harvestTool: null,
    harvestTier: null,
    visible: true,
  }
}

/** The ceiling clearance cuts `buildHeadroomCuts` emits for a 1-high pocket. */
function clearanceCuts(): NonNullable<WorldState['headroomCuts']> {
  return [
    { pos: { x: 0, y: 63, z: 0 }, name: 'stone', safe: true, reason: 'safe' },
    { pos: { x: 1, y: 63, z: 0 }, name: 'stone', safe: true, reason: 'safe' },
  ]
}

/** One safe level tunnel step, the shape the sensor's `state.descent` carries. */
function descentStep(): NonNullable<WorldState['descent']>[number] {
  return {
    dir: 'W',
    mode: 'level',
    dx: -1,
    dz: 0,
    step: { x: 0, y: 61, z: 0 },
    wall: { x: 0, y: 61, z: 0 },
    head: { x: 0, y: 62, z: 0 },
    floor: { x: 0, y: 60, z: 0 },
    wallSolid: true,
    headSolid: false,
    floorSolid: true,
    safe: true,
    reason: 'safe',
    digName: 'stone',
    diggable: true,
    digHarvestTool: 'pickaxe',
    digHarvestTier: 0,
  }
}

function build(
  kind: QueuedGoal['kind'],
  focus: string,
  description: string,
  blocks: BlockState[],
  cuts: NonNullable<WorldState['headroomCuts']> | null = null,
  withDescent = false,
): WorldState {
  const inventory: InventoryState = { slots: [], counts: { wooden_pickaxe: 1 }, totalItems: 1 }
  const state: WorldState = {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: selfState(SELF),
    inventory,
    entities: [],
    blocks,
    terrain: { standable: [SELF] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goalState(focus, description),
    goalQueue: queue(queuedGoal(kind, focus, description)),
    recentEvents: [],
    signals: signals(),
  }
  if (cuts !== null) state.headroomCuts = cuts
  if (withDescent) state.descent = [descentStep()]
  return state
}

const OPTIONS = { ...defaultCandidateOptions, recipes: RECIPES }

function minesOf(state: WorldState): Candidate[] {
  return generateCandidates(state, OPTIONS).filter((candidate) => candidate.kind === 'MINE')
}

function descendsOf(state: WorldState): Candidate[] {
  return generateCandidates(state, OPTIONS).filter((candidate) => candidate.kind === 'DESCEND')
}

const describeIds = (candidates: readonly Candidate[]): string => `[${candidates.map((candidate) => candidate.id).join(' ')}]`

const describeMines = (mines: readonly Candidate[]): string =>
  `[${mines
    .map((candidate) => `${candidate.id}(${String(candidate.meta?.yieldItem ?? candidate.targetName)})`)
    .join(' ')}]`

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

// (a) flint goal, sensed stone nearby + clearance stone above, no sensed gravel.
addCase('(a) collect flint with no sensed gravel offers no stone MINE', () => {
  const state = build('collect', 'flint', 'collect 1 x flint (from gravel)', [
    stoneBlock({ x: 1, y: 61, z: 0 }),
    stoneBlock({ x: 5, y: 61, z: 5 }),
  ], clearanceCuts())
  const mines = minesOf(state)
  return {
    pass: mines.length === 0,
    detail: `focusItems=${String(state.goalQueue.current?.targetItem)} mines=${describeMines(mines)}`,
  }
})

// (a)+3: the withholding is durable for the same focus (repeated ticks) and
// resets when the focus changes to a goal stone genuinely serves.
addCase('(3) withholding is durable across ticks and resets when the focus changes', () => {
  const flintStates = [0, 1, 2].map((tick) => {
    const state = build('collect', 'flint', 'collect 1 x flint (from gravel)', [stoneBlock({ x: 1, y: 61, z: 0 })], clearanceCuts())
    state.tick = tick
    return state
  })
  const durable = flintStates.every((state) => minesOf(state).length === 0)
  const cobble = build('collect', 'cobblestone', 'collect 1 x cobblestone', [stoneBlock({ x: 1, y: 61, z: 0 })], clearanceCuts())
  const resetOffers = minesOf(cobble).length > 0
  return {
    pass: durable && resetOffers,
    detail: `flintTicksNoMine=${durable} cobblestoneMines=${describeMines(minesOf(cobble))}`,
  }
})

// (b) a goal whose drop IS the focus (cobblestone) keeps the regular stone MINE.
addCase('(b) collect cobblestone still offers the sensed stone MINE', () => {
  const state = build('collect', 'cobblestone', 'collect 1 x cobblestone', [stoneBlock({ x: 1, y: 61, z: 0 })])
  const mines = minesOf(state)
  return {
    pass: mines.some((candidate) => candidate.targetName === 'stone'),
    detail: `mines=${describeMines(mines)}`,
  }
})

// (b) a craft goal whose chain genuinely needs cobblestone (furnace) keeps the
// clearance stone MINE: stone IS a material in the focus's dependency chain.
addCase('(b) craft furnace keeps the clearance stone MINE (chain needs cobblestone)', () => {
  const state = build('craft', 'furnace', 'craft 1 x furnace', [], clearanceCuts())
  const mines = minesOf(state)
  return {
    pass: mines.length > 0 && mines.every((candidate) => candidate.meta?.clearance === true),
    detail: `mines=${describeMines(mines)}`,
  }
})

// (b) raw_iron needs no plain stone while the pickaxe is held, so its clearance
// MINE is withheld like flint.
addCase('(b) collect raw_iron withholds the clearance stone MINE', () => {
  const state = build('collect', 'raw_iron', 'collect 1 x raw_iron', [], clearanceCuts())
  const mines = minesOf(state)
  return {
    pass: mines.length === 0,
    detail: `mines=${describeMines(mines)}`,
  }
})

// (c) collect log is a resource-class goal: behaviour is unchanged. With no
// sensed log, the clearance MINE is still offered exactly as before the fix.
addCase('(c) collect log keeps the clearance MINE unchanged (class focus)', () => {
  const state = build('collect', 'log', 'collect 3 x log', [], clearanceCuts())
  const mines = minesOf(state)
  return {
    pass: mines.length > 0 && mines.every((candidate) => candidate.meta?.clearance === true),
    detail: `mines=${describeMines(mines)}`,
  }
})

// (c) and a sensed log is still mined: the log route is untouched.
addCase('(c) collect log still offers the sensed log MINE', () => {
  const state = build('collect', 'log', 'collect 3 x log', [
    logBlock({ x: 1, y: 61, z: 0 }),
    stoneBlock({ x: 3, y: 61, z: 3 }),
  ])
  const mines = minesOf(state)
  return {
    pass: mines.some((candidate) => candidate.targetName === 'oak_log') && !mines.some((candidate) => candidate.targetName === 'stone'),
    detail: `mines=${describeMines(mines)} blockId=${blockId('b', { x: 1, y: 61, z: 0 })}`,
  }
})

// (2) flint/gravel: a level/down tunnel step cannot reach the source, so the
// repeating zero-progress DESCEND the live run carved tunnels with is withheld.
addCase('(2) collect flint withholds the purposeless DESCEND step', () => {
  const state = build('collect', 'flint', 'collect 1 x flint (from gravel)', [stoneBlock({ x: 5, y: 61, z: 5 })], null, true)
  const descends = descendsOf(state)
  return {
    pass: descends.length === 0,
    detail: `focus=flint descends=${describeIds(descends)}`,
  }
})

addCase('(2) collect gravel withholds the purposeless DESCEND step', () => {
  const state = build('collect', 'gravel', 'collect 1 x gravel', [], null, true)
  const descends = descendsOf(state)
  return {
    pass: descends.length === 0,
    detail: `focus=gravel descends=${describeIds(descends)}`,
  }
})

// (2) an underground-resource focus keeps DESCEND: the source layer is below.
addCase('(2) underground resource goals still offer DESCEND', () => {
  const observed = ['raw_iron', 'diamond', 'obsidian'].map((focus) => {
    const descends = descendsOf(build('collect', focus, `collect 1 x ${focus}`, [], null, true))
    return { focus, kept: descends.length > 0 }
  })
  return {
    pass: observed.every((entry) => entry.kept),
    detail: observed.map((entry) => `${entry.focus}=${entry.kept}`).join(' '),
  }
})

// (2) an explicit descend_to:Y goal is vertical recovery: DESCEND is the goal.
addCase('(2) a descend_to predicate goal still offers DESCEND', () => {
  const state = build('descend', 'flint', 'descend to Y=-3', [], null, true)
  state.goalQueue.current = { ...state.goalQueue.current!, kind: 'descend', targetY: -3, targetItem: null }
  const descends = descendsOf(state)
  return {
    pass: descends.length > 0,
    detail: `descends=${describeIds(descends)}`,
  }
})

// (2)(c) a resource-class log goal keeps DESCEND (historical behaviour).
addCase('(2) collect log keeps the DESCEND step unchanged (class focus)', () => {
  const state = build('collect', 'log', 'collect 3 x log', [], null, true)
  const descends = descendsOf(state)
  return {
    pass: descends.length > 0,
    detail: `descends=${describeIds(descends)}`,
  }
})

// (1)/(2) never collapse to a forced single action: a flint goal with no sensed
// gravel but several grounded frontier cells must present >= 3 distinct non-WAIT
// actions (not WAIT + one), so Jev pi carries information.
addCase('(1) no goal route still presents >=3 distinct grounded alternatives', () => {
  const state = build('collect', 'flint', 'collect 1 x flint (from gravel)', [], null, true)
  state.terrain = {
    standable: [
      SELF,
      { x: 3, y: 61, z: 0 },
      { x: 0, y: 61, z: 3 },
      { x: -3, y: 61, z: 0 },
      { x: 0, y: 61, z: -3 },
      { x: 3, y: 61, z: 3 },
    ],
  }
  const actionable = generateCandidates(state, OPTIONS).filter((candidate) => candidate.kind !== 'WAIT')
  const ids = new Set(actionable.map((candidate) => candidate.id))
  return {
    pass: actionable.length >= 3 && ids.size === actionable.length,
    detail: `presented=${actionable.length} distinct=${ids.size} ids=${describeIds(actionable)}`,
  }
})

let failures = 0
process.stdout.write('stone focus feasibility filter - purposeless MINE/DESCEND withholding\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} stone-focus cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
