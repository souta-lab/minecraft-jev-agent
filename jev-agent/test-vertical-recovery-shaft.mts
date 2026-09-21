// test-vertical-recovery-shaft.mts - measured vertical-recovery dead end:
// a bot in a 1x1 dug shaft at y=63 whose goal is `recover vertical access to
// y>=80` (surface/log). The goal is unreachable with the pre-fix plan layer in
// two independent, provable ways:
//
//   1. `planUpward` emitted a pillar step whose `steps` (17) far exceeded the
//      held placeable count (1 dirt), i.e. a step emitted without the blocks it
//      requires. The executor consumes the single block and then refuses
//      `no_placeable` mid-climb, and the caller never learns why.
//   2. An upward gap with no grounded plan collapsed to `plan: null` with no
//      typed cause, so the caller could not tell "no vertical leg needed" from
//      "the ascent is impossible" and re-issued the same goal forever (the live
//      `OSCILLATION_DETECTED cycles=4 pair=26.5,63,19.5->26.5,63,20.3
//      goal=surface:log:1` stretch while `recover_vertical_access` y>=80 was
//      active from y=63).
//
// This fixture is pure: no bot, no network. Run: bun test-vertical-recovery-shaft.mts
import { defaultCandidateOptions, generateCandidates, generateGroundedCandidates } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { planVerticalApproach, planVerticalApproachDetailed } from './src/verticalPlan.ts'
// The refusal marker is read through the namespace so this fixture still RUNS
// (and fails semantically) against the pre-fix module, where the export does not
// exist yet; a static named import would abort the whole run with a SyntaxError
// and hide the before/after diff.
import * as verticalPlanModule from './src/verticalPlan.ts'
import { selectPlaceableBlock } from './src/pillarSearch.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type {
  AgentSignals,
  GoalState,
  InventoryState,
  KnownResource,
  SelfState,
  Vec3Json,
  WorldState,
} from './src/state.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

/** The measured shaft: feet (26,63,19), goal target y>=80. */
const SHAFT_FEET: Vec3Json = { x: 26, y: 63, z: 19 }
const SHAFT_TARGET: Vec3Json = { x: 26, y: 80, z: 19 }
const SHAFT_GAP = SHAFT_TARGET.y - SHAFT_FEET.y

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_VRSHAFT',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'overworld',
    isDay: false,
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

function surfaceGoal(targetY: number): GoalState {
  return {
    id: 'surface:log:1',
    description: `recover vertical access to y>=${targetY} and collect 1 x log`,
    targetItem: 'log',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedSurface(targetY: number): QueuedGoal {
  return {
    id: 'surface:log:1',
    kind: 'surface',
    description: `recover vertical access to y>=${targetY} and collect 1 x log`,
    targetItem: 'log',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
    targetY,
    dimension: 'overworld',
  }
}

function queueWith(current: QueuedGoal): GoalQueueState {
  return { ...emptyGoalQueueState(), depth: 1, current, empty: false, goals: [current] }
}

function shaftWorld(counts: Record<string, number>, known: KnownResource[] = []): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(SHAFT_FEET),
    inventory: inventory(counts),
    entities: [],
    blocks: [],
    // 1x1 shaft: only the bot's own two cells are standable, so no walkable
    // step exists and the ceiling above is solid (no sensor step cut).
    terrain: { standable: [SHAFT_FEET] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: surfaceGoal(SHAFT_TARGET.y),
    goalQueue: queueWith(queuedSurface(SHAFT_TARGET.y)),
    recentEvents: [],
    descent: [],
    stepCuts: [],
    signals: signals({ knownResources: known }),
  }
}

function retrieveOf(candidates: readonly Candidate[]): Candidate | null {
  return candidates.find((candidate) => candidate.kind === 'RETRIEVE') ?? null
}

// --- 1. the emitted pillar step never requires blocks the bot does not hold ----

addCase('a 17-block shaft gap with 1 held dirt emits a 1-step pillar, not a 17-step plan', () => {
  const plan = planVerticalApproach({
    selfFeetY: SHAFT_FEET.y,
    selfPosition: SHAFT_FEET,
    target: SHAFT_TARGET,
    tunnel: null,
    descent: [],
    stepCuts: [],
    placeable: { name: 'dirt', count: 1 },
    columnSafe: true,
    inventory: inventory({ diamond_pickaxe: 1, dirt: 1 }).counts,
  })
  const pass =
    plan?.kind === 'pillar' &&
    plan.steps === 1 &&
    plan.steps <= plan.placeCount &&
    plan.fromY === SHAFT_FEET.y &&
    plan.toY === SHAFT_FEET.y + 1
  return { pass, detail: JSON.stringify(plan) }
})

addCase('a 17-block shaft gap with 3 held cobblestone emits a 3-step pillar, not a 17-step plan', () => {
  const plan = planVerticalApproach({
    selfFeetY: SHAFT_FEET.y,
    selfPosition: SHAFT_FEET,
    target: SHAFT_TARGET,
    tunnel: null,
    descent: [],
    stepCuts: [],
    placeable: selectPlaceableBlock({ cobblestone: 3 }),
    columnSafe: true,
    inventory: inventory({ diamond_pickaxe: 1, cobblestone: 3 }).counts,
  })
  const pass = plan?.kind === 'pillar' && plan.steps === 3 && plan.steps <= plan.placeCount && plan.toY === SHAFT_FEET.y + 3
  return { pass, detail: JSON.stringify(plan) }
})

addCase('a full stack still climbs the whole gap (cap does not change the old behaviour)', () => {
  const plan = planVerticalApproach({
    selfFeetY: SHAFT_FEET.y,
    selfPosition: SHAFT_FEET,
    target: { x: SHAFT_TARGET.x, y: 68, z: SHAFT_TARGET.z },
    tunnel: null,
    descent: [],
    stepCuts: [],
    placeable: { name: 'cobblestone', count: 64 },
    columnSafe: true,
    inventory: inventory({ diamond_pickaxe: 1, cobblestone: 64 }).counts,
  })
  const pass = plan?.kind === 'pillar' && plan.steps === 5 && plan.toY === 68
  return { pass, detail: JSON.stringify(plan) }
})

// --- 2. an upward gap with no grounded plan is a TYPED refusal, not null -------

addCase('no placeable held names the refusal instead of collapsing to null', () => {
  const decision = planVerticalApproachDetailed({
    selfFeetY: SHAFT_FEET.y,
    selfPosition: SHAFT_FEET,
    target: SHAFT_TARGET,
    tunnel: null,
    descent: [],
    stepCuts: [],
    placeable: null,
    columnSafe: true,
    inventory: inventory({ diamond_pickaxe: 1 }).counts,
  })
  const refusal = ascentRefusalOf(decision)
  const pass =
    decision.plan === null &&
    refusal !== null &&
    refusal.reason === 'no_placeable' &&
    refusal.fromY === SHAFT_FEET.y &&
    refusal.toY === SHAFT_TARGET.y
  return { pass, detail: JSON.stringify({ plan: decision.plan, ascentRefusal: refusal }) }
})

addCase('an unsafe ascent column names its own typed refusal', () => {
  const decision = planVerticalApproachDetailed({
    selfFeetY: SHAFT_FEET.y,
    selfPosition: SHAFT_FEET,
    target: SHAFT_TARGET,
    tunnel: null,
    descent: [],
    stepCuts: [],
    placeable: { name: 'cobblestone', count: 64 },
    columnSafe: false,
    inventory: inventory({ diamond_pickaxe: 1, cobblestone: 64 }).counts,
  })
  const refusal = ascentRefusalOf(decision)
  const pass = decision.plan === null && refusal?.reason === 'unsafe_column'
  return { pass, detail: JSON.stringify({ plan: decision.plan, ascentRefusal: refusal }) }
})

addCase('a level or downward target is never an ascent refusal (no false positive)', () => {
  const level = planVerticalApproachDetailed({
    selfFeetY: SHAFT_FEET.y,
    selfPosition: SHAFT_FEET,
    target: { x: SHAFT_TARGET.x, y: SHAFT_FEET.y, z: SHAFT_TARGET.z },
    tunnel: null,
    descent: [],
    stepCuts: [],
    placeable: null,
  })
  const downward = planVerticalApproachDetailed({
    selfFeetY: SHAFT_FEET.y,
    selfPosition: SHAFT_FEET,
    target: { x: SHAFT_TARGET.x, y: SHAFT_FEET.y - 2, z: SHAFT_TARGET.z },
    tunnel: null,
    descent: [],
    stepCuts: [],
    placeable: null,
  })
  const pass = ascentRefusalOf(level) === null && ascentRefusalOf(downward) === null
  return { pass, detail: `level=${JSON.stringify(level)} downward=${JSON.stringify(downward)}` }
})

interface AscentRefusalLike {
  reason: string
  fromY: number
  toY: number
  cell: Vec3Json
}

/**
 * Read the typed ascent refusal whether or not the running module already has
 * it, so the pre-fix module reports a semantic FAIL instead of crashing.
 */
function ascentRefusalOf(decision: { plan: unknown }): AscentRefusalLike | null {
  return (decision as unknown as { ascentRefusal?: AscentRefusalLike | null }).ascentRefusal ?? null
}

const formatAscentRefusedMaybe = (
  verticalPlanModule as unknown as { formatAscentRefused?: (refusal: AscentRefusalLike) => string }
).formatAscentRefused

addCase('the refusal marker carries the reason and both Ys', () => {
  const refusal: AscentRefusalLike = {
    reason: 'no_placeable',
    fromY: SHAFT_FEET.y,
    toY: SHAFT_TARGET.y,
    cell: { x: SHAFT_FEET.x, y: SHAFT_FEET.y, z: SHAFT_FEET.z },
  }
  const line = formatAscentRefusedMaybe === undefined ? 'ASCENT_REFUSED_MARKER_MISSING' : formatAscentRefusedMaybe(refusal)
  const pass = line === `ASCENT_REFUSED reason=no_placeable from_y=63 to_y=80 cell=26,63,19`
  return { pass, detail: line }
})

// --- 3. the retrieval candidate the goal is served by ----------------------------

const KNOWN_LOG_ABOVE: KnownResource = {
  name: 'oak_log',
  kind: 'log',
  position: { x: SHAFT_FEET.x, y: 79, z: SHAFT_FEET.z },
  dimension: 'overworld',
}

addCase('the known-log retrieval candidate never promises more pillar steps than the bot holds', () => {
  const state = shaftWorld({ diamond_pickaxe: 1, dirt: 1 }, [KNOWN_LOG_ABOVE])
  const retrieve = retrieveOf(generateCandidates(state, defaultCandidateOptions))
  const steps = typeof retrieve?.meta.pillarSteps === 'number' ? retrieve.meta.pillarSteps : null
  const placeCount = typeof retrieve?.meta.pillarPlaceCount === 'number' ? retrieve.meta.pillarPlaceCount : null
  const pass =
    retrieve !== null &&
    retrieve.meta.vertical === 'pillar' &&
    steps === 1 &&
    placeCount === 1 &&
    steps !== null &&
    placeCount !== null &&
    steps <= placeCount &&
    retrieve.meta.verticalToY === SHAFT_FEET.y + 1
  return { pass, detail: retrieve === null ? 'no RETRIEVE' : JSON.stringify(retrieve.meta) }
})

addCase('with no placeable the known-log candidate is withheld as needs_ascend (no climbing candidate)', () => {
  const state = shaftWorld({ diamond_pickaxe: 1 }, [KNOWN_LOG_ABOVE])
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const retrieve = retrieveOf(grounded.candidates)
  const withheldRetrieve = grounded.withheld.find((entry) => entry.candidate.kind === 'RETRIEVE') ?? null
  const missing = withheldRetrieve?.result.missingCapabilities.map((capability) => capability.kind) ?? []
  const pass =
    retrieve === null &&
    withheldRetrieve !== null &&
    withheldRetrieve.result.reason === 'needs_ascend' &&
    missing.includes('placeable_block')
  return {
    pass,
    detail:
      retrieve !== null
        ? JSON.stringify(retrieve.meta)
        : JSON.stringify({ reason: withheldRetrieve?.result.reason, missing }),
  }
})

// --- 4. the surface candidate's structural cap (the goal's y>=80 is not its target) ----

addCase('the surface-search candidate only reaches one standable level above the bot', () => {
  // A 1x1 shaft has no standable cell above, so the only surface waypoint the
  // sensor can offer is the bot's own level; the goal's y>=80 cannot be the
  // candidate target. This pins the fact the controller layer must turn into a
  // re-plan rather than pacing.
  const shaftState = shaftWorld({ diamond_pickaxe: 1, dirt: 1 })
  const shaftRetrieve = retrieveOf(generateCandidates(shaftState, defaultCandidateOptions))
  const pass =
    shaftRetrieve === null || (shaftRetrieve.target !== null && shaftRetrieve.target.y <= SHAFT_FEET.y + 1)
  return {
    pass,
    detail:
      shaftRetrieve === null
        ? 'no RETRIEVE (shaft has no standable cell above)'
        : `candidate target y=${shaftRetrieve.target?.y} goal targetY=${SHAFT_TARGET.y}`,
  }
})

let failures = 0
process.stdout.write('vertical recovery: 1x1 shaft y=63 -> goal y>=80\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} vertical-recovery-shaft cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
