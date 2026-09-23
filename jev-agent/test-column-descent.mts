// test-column-descent.mts - the stranded-on-a-column movement gap.
//
// Measured live (run-mubj6ucc-si3e, source cc658cb, m3-live): a starving 1 HP
// body pillared itself up to y=81 at (23.7,81,8.5); the sensor knew no standable
// cell but the pillar top, so `pickExplore` found no frontier and the only
// offered candidate was WAIT:
//
//   HEARTBEAT pos=23.7,81.0,8.5 health=1     (food=0, goal collect:food 0/3)
//   CANDIDATE_STARVATION presented=1 productive=0 goal=collect:food:3
//     blockedBy=no_productive_action missing=["explore_route_blocked:no_frontier"]
//
// The body must be able to leave its own support column through the ordinary,
// bounded, damage-free movement machinery (or say with a typed reason why not).
// No bot, no network.
//
// Run: bun test-column-descent.mts
import { defaultCandidateOptions, formatColumnDescentRefused, generateGroundedCandidates, strandedOnColumn } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { AgentSignals, DescentOption, GoalState, InventoryState, SelfState, Vec3Json, WorldState } from './src/state.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const FEET: Vec3Json = { x: 23.5, y: 81, z: 8.5 }
const FEET_CELL: Vec3Json = { x: 23, y: 81, z: 8 }

function self(position: Vec3Json, overrides: Partial<SelfState> = {}): SelfState {
  return {
    username: 'AI_Buddy',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 1,
    food: 0,
    gameMode: 'survival',
    dimension: 'overworld',
    isDay: true,
    heldItem: null,
    ...overrides,
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
    id: 'g37:collect:food',
    description: 'collect 3 x food (hunt passive animals)',
    targetItem: 'food',
    requiredCount: 3,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queued(): QueuedGoal {
  return {
    id: 'g37:collect:food',
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

function queue(): GoalQueueState {
  const current = queued()
  return { ...emptyGoalQueueState(), depth: 1, current, empty: false, goals: [current] }
}

/**
 * One `DescentOption` as `buildDescent` would compute it for the feet cell of
 * `body`: mode `down` lands one block lower, `level` stays at the same Y. The
 * real sensor marks a step `safe` only when it is diggable, hazard-free and the
 * landing cell has solid support, so the fixture mirrors that by construction.
 */
function step(
  body: Vec3Json,
  dir: DescentOption['dir'],
  dx: number,
  dz: number,
  spec: { mode: 'down' | 'level'; safe: boolean; digName?: string | null; tool?: 'pickaxe' | null; tier?: number | null; floorSolid?: boolean },
): DescentOption {
  const feet = { x: Math.floor(body.x), y: Math.floor(body.y), z: Math.floor(body.z) }
  const stepY = spec.mode === 'down' ? feet.y - 1 : feet.y
  return {
    dir,
    mode: spec.mode,
    dx,
    dz,
    step: { x: feet.x + dx, y: stepY, z: feet.z + dz },
    wall: { x: feet.x + dx, y: feet.y, z: feet.z + dz },
    head: { x: feet.x + dx, y: feet.y + 1, z: feet.z + dz },
    floor: { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz },
    wallSolid: false,
    headSolid: false,
    floorSolid: spec.floorSolid ?? (spec.safe && spec.mode === 'down'),
    safe: spec.safe,
    reason: spec.safe ? 'safe' : 'no solid support',
    digName: spec.safe ? (spec.digName ?? 'dirt') : null,
    digHarvestTool: spec.safe ? (spec.tool ?? null) : null,
    digHarvestTier: spec.safe ? (spec.tier ?? null) : null,
    diggable: spec.safe,
  }
}

/** The four cardinal + own-column down steps, all `safe`, as `buildDescent` would emit them on solid ground. */
function openGroundDescent(body: Vec3Json): DescentOption[] {
  return [
    step(body, 'E', 1, 0, { mode: 'down', safe: true }),
    step(body, 'W', -1, 0, { mode: 'down', safe: true }),
    step(body, 'N', 0, -1, { mode: 'down', safe: true }),
    step(body, 'S', 0, 1, { mode: 'down', safe: true }),
    step(body, 'D', 0, 0, { mode: 'down', safe: true }),
  ]
}

/** The live pillar: only the body's own column is safe; every cardinal lands over the drop. */
function pillarDescent(body: Vec3Json): DescentOption[] {
  return [
    step(body, 'E', 1, 0, { mode: 'down', safe: false }),
    step(body, 'W', -1, 0, { mode: 'down', safe: false }),
    step(body, 'N', 0, -1, { mode: 'down', safe: false }),
    step(body, 'S', 0, 1, { mode: 'down', safe: false }),
    // own column: the pillar block under the feet is diggable with solid support below
    step(body, 'D', 0, 0, { mode: 'down', safe: true, digName: 'dirt' }),
  ]
}

function worldState(overrides: {
  position: Vec3Json
  standable: Vec3Json[]
  descent: DescentOption[]
  inventory?: InventoryState
  signals?: AgentSignals
  goalQueue?: GoalQueueState
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 1,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position),
    inventory: overrides.inventory ?? inventory({ dirt: 100, diamond_pickaxe: 1 }),
    entities: [],
    blocks: [],
    terrain: { standable: overrides.standable },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goal(),
    goalQueue: overrides.goalQueue ?? queue(),
    recentEvents: [],
    descent: overrides.descent,
    stepCuts: [],
    headroomCuts: [],
    signals: overrides.signals ?? signals(),
  }
}

function columnDescentCandidates(candidates: readonly Candidate[]): Candidate[] {
  return candidates.filter((candidate) => candidate.meta.columnDescent === true)
}

// --- the live reproduction -------------------------------------------------------

addCase('(a) the live pillar top offers a controlled own-column descent instead of WAIT-only', () => {
  const state = worldState({ position: FEET, standable: [FEET_CELL], descent: pillarDescent(FEET) })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const descent = grounded.candidates.find((candidate) => candidate.kind === 'DESCEND')
  const pass =
    strandedOnColumn(state) &&
    grounded.candidates.length === 2 &&
    descent !== undefined &&
    descent.meta.columnDescent === true &&
    descent.meta.dir === 'D' &&
    descent.meta.mode === 'down' &&
    descent.meta.safe === true &&
    descent.meta.grounded === true &&
    descent.meta.stepY === FEET_CELL.y - 1 &&
    grounded.columnDescentRefusal === null
  return {
    pass,
    detail: `stranded=${strandedOnColumn(state)} set=[${grounded.candidates.map((c) => c.id).join(',')}] descent=${descent?.id ?? 'none'} stepY=${String(descent?.meta.stepY)} refusal=${JSON.stringify(grounded.columnDescentRefusal)}`,
  }
})

addCase('(a2) open ground beside the pillar offers the safe step-down onto it (body leaves the column)', () => {
  const state = worldState({ position: FEET, standable: [FEET_CELL], descent: openGroundDescent(FEET) })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const descent = grounded.candidates.find((candidate) => candidate.kind === 'DESCEND')
  const pass =
    descent !== undefined &&
    descent.meta.columnDescent === true &&
    descent.meta.mode === 'down' &&
    descent.meta.safe === true &&
    descent.meta.stepY === FEET_CELL.y - 1 &&
    // the offered descent digs a real floor cell and steps onto supported ground
    descent.target !== null &&
    grounded.candidates.every(
      (candidate) => candidate.kind !== 'MOVE' || candidate.meta.columnDescent !== true,
    )
  return {
    pass,
    detail: `set=[${grounded.candidates.map((c) => c.id).join(',')}] descent=${descent?.id ?? 'none'} dir=${String(descent?.meta.dir)} stepY=${String(descent?.meta.stepY)}`,
  }
})

addCase('(a3) an existing locomotion candidate is never displaced by the last-resort column descent', () => {
  // Same stranded pillar, but the active `goto` goal already offers a MOVE to its
  // target cell: the body has a route, so the column descent is not enumerated.
  const target = { x: 30, y: 81, z: 8 }
  const gotoGoal: QueuedGoal = {
    id: 'g9:goto',
    kind: 'goto',
    description: 'go to the code-grounded target',
    targetItem: null,
    requiredCount: 0,
    targetPosition: target,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
  const state = worldState({
    position: FEET,
    standable: [FEET_CELL],
    descent: pillarDescent(FEET),
    goalQueue: { ...emptyGoalQueueState(), depth: 1, current: gotoGoal, empty: false, goals: [gotoGoal] },
  })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const pass =
    strandedOnColumn(state) &&
    grounded.candidates.some((candidate) => candidate.kind === 'MOVE') &&
    columnDescentCandidates(grounded.candidates).length === 0 &&
    grounded.columnDescentRefusal === null
  return {
    pass,
    detail: `set=[${grounded.candidates.map((c) => c.id).join(',')}] column=${columnDescentCandidates(grounded.candidates).length} refusal=${JSON.stringify(grounded.columnDescentRefusal)}`,
  }
})

// --- flat ground is unchanged ----------------------------------------------------

addCase('(b) normal flat ground offers no column descent even when a down step is safe', () => {
  // A walkable frontier exists (neighbouring standable cells), so the body is not
  // stranded. Digging a hole beside the body is mechanically "safe" but must stay
  // a gratuitous step-down: it is not offered.
  const neighbour = { x: FEET_CELL.x + 2, y: FEET_CELL.y, z: FEET_CELL.z }
  const state = worldState({
    position: FEET,
    standable: [FEET_CELL, { x: FEET_CELL.x + 1, y: FEET_CELL.y, z: FEET_CELL.z }, neighbour],
    descent: openGroundDescent(FEET),
  })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const pass =
    !strandedOnColumn(state) &&
    columnDescentCandidates(grounded.candidates).length === 0 &&
    grounded.columnDescentRefusal === null
  return {
    pass,
    detail: `stranded=${strandedOnColumn(state)} set=[${grounded.candidates.map((c) => c.id).join(',')}] column=${columnDescentCandidates(grounded.candidates).length} refusal=${JSON.stringify(grounded.columnDescentRefusal)}`,
  }
})

// --- no safe descent is a typed refusal, never a damaging jump --------------------

addCase('(c) a pillar surrounded by a hurtful drop with no safe step refuses with a typed reason', () => {
  const unsafe = [
    step(FEET, 'E', 1, 0, { mode: 'down', safe: false }),
    step(FEET, 'W', -1, 0, { mode: 'down', safe: false }),
    step(FEET, 'N', 0, -1, { mode: 'down', safe: false }),
    step(FEET, 'S', 0, 1, { mode: 'down', safe: false }),
    step(FEET, 'D', 0, 0, { mode: 'down', safe: false }),
  ]
  const state = worldState({ position: FEET, standable: [FEET_CELL], descent: unsafe })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const refusal = grounded.columnDescentRefusal
  const pass =
    grounded.candidates.every((candidate) => candidate.kind === 'WAIT') &&
    refusal !== null &&
    refusal.reason === 'no_safe_step' &&
    refusal.cell.x === FEET_CELL.x &&
    refusal.cell.y === FEET_CELL.y &&
    refusal.cell.z === FEET_CELL.z &&
    formatColumnDescentRefused(refusal) === `COLUMN_DESCENT_REFUSED reason=no_safe_step cell=23,81,8`
  return {
    pass,
    detail: `set=[${grounded.candidates.map((c) => c.id).join(',')}] refusal=${refusal === null ? 'none' : formatColumnDescentRefused(refusal)}`,
  }
})

addCase('(c2) a safe step needing a tool the body lacks refuses with reason=no_tool', () => {
  const state = worldState({
    position: FEET,
    standable: [FEET_CELL],
    inventory: inventory({ dirt: 100 }),
    descent: [step(FEET, 'D', 0, 0, { mode: 'down', safe: true, digName: 'stone', tool: 'pickaxe', tier: 1 })],
  })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const refusal = grounded.columnDescentRefusal
  const pass =
    grounded.candidates.every((candidate) => candidate.kind === 'WAIT') &&
    refusal !== null &&
    refusal.reason === 'no_tool' &&
    refusal.tool === 'pickaxe' &&
    refusal.tier === 1
  return {
    pass,
    detail: `set=[${grounded.candidates.map((c) => c.id).join(',')}] refusal=${refusal === null ? 'none' : formatColumnDescentRefused(refusal)}`,
  }
})

addCase('(c3) an exhausted safe step refuses with reason=exhausted (bounded retry)', () => {
  const own = step(FEET, 'D', 0, 0, { mode: 'down', safe: true, digName: 'dirt' })
  const state = worldState({
    position: FEET,
    standable: [FEET_CELL],
    descent: [own],
    signals: signals({ failedCandidates: { 'DESCEND:down:D:b23_80_8': 9 } }),
  })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const refusal = grounded.columnDescentRefusal
  const pass =
    grounded.candidates.every((candidate) => candidate.kind === 'WAIT') &&
    refusal !== null &&
    refusal.reason === 'exhausted'
  return {
    pass,
    detail: `set=[${grounded.candidates.map((c) => c.id).join(',')}] refusal=${refusal === null ? 'none' : formatColumnDescentRefused(refusal)}`,
  }
})

addCase('(c4) recurrence retires the only column step and hands the no-frontier fact to policy', () => {
  const only = step(FEET, 'E', 1, 0, { mode: 'down', safe: true })
  const state = worldState({
    position: FEET,
    standable: [FEET_CELL],
    descent: [only],
    signals: signals({ digDir: 'E', digMode: 'down', digOscillate: true }),
  })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const escalate = grounded.candidates.find((candidate) => candidate.kind === 'ESCALATE')
  return {
    pass:
      grounded.columnDescentRefusal?.reason === 'recurrent' &&
      grounded.candidates.every((candidate) => candidate.kind !== 'DESCEND') &&
      escalate?.meta.skillOutcome === 'RECURRENT_STATE' &&
      String(escalate.meta.legPolicyBoundary).includes('reason=recurrent_descent_no_alternative'),
    detail: `set=[${grounded.candidates.map((candidate) => candidate.id).join(',')}] refusal=${formatColumnDescentRefused(grounded.columnDescentRefusal ?? { reason: 'no_safe_step', cell: FEET_CELL })}`,
  }
})

addCase('the typed marker line is stable for every refusal reason', () => {
  const cell = { x: 23, y: 81, z: 8 }
  const noStep = formatColumnDescentRefused({ reason: 'no_safe_step', cell })
  const noTool = formatColumnDescentRefused({ reason: 'no_tool', cell, tool: 'pickaxe', tier: 2 })
  const exhausted = formatColumnDescentRefused({ reason: 'exhausted', cell })
  const recurrent = formatColumnDescentRefused({ reason: 'recurrent', cell })
  const pass =
    noStep === 'COLUMN_DESCENT_REFUSED reason=no_safe_step cell=23,81,8' &&
    noTool === 'COLUMN_DESCENT_REFUSED reason=no_tool cell=23,81,8 tool=pickaxe tier=2' &&
    exhausted === 'COLUMN_DESCENT_REFUSED reason=exhausted cell=23,81,8' &&
    recurrent === 'COLUMN_DESCENT_REFUSED reason=recurrent cell=23,81,8'
  return { pass, detail: `${noStep} | ${noTool} | ${exhausted} | ${recurrent}` }
})

let failures = 0
process.stdout.write('stranded-on-a-column descent - bounded safe step down\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} column-descent cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
