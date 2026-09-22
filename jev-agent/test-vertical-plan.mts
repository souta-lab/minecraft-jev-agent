// test-vertical-plan.mts - issue #45 unit proof for the retrieval vertical leg
// and the stall escalation. No bot, no network.
//
// Run: bun test-vertical-plan.mts
import { defaultCandidateOptions, generateCandidates } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { guardCandidate } from './src/policy.ts'
import type { GuardContext } from './src/policy.ts'
import {
  ASCENT_PROGRESS_EPSILON,
  classifyHeadroomBlocker,
  evaluateAscentColumn,
  evaluatePillarStep,
  evaluateRetrievalProgress,
  evaluateTunnelEntry,
  formatAscentProgress,
  formatLocalClear,
  formatPillarRefused,
  formatPillarRelocate,
  formatTunnelEntryRefused,
  headroomAcrossFootprint,
  LOCAL_CLEAR_RADIUS,
  PILLAR_UP_STEP_CAP,
  pillarColumnUnsafeFromBlocks,
  planReuseLeg,
  planVerticalApproach,
  planVerticalApproachDetailed,
  resolvePillarStep,
  selectPillarFallbackColumn,
} from './src/verticalPlan.ts'
import type { PillarColumnProbe, RetrievalProgressState, TunnelEntryBlockerProbe } from './src/verticalPlan.ts'
import { formatPillarUpStep } from './src/pillarJump.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type {
  AgentSignals,
  DescentOption,
  GoalState,
  InventoryState,
  KnownResource,
  SelfState,
  StepCut,
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

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_M2V45',
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

function goal(overrides: Partial<GoalState>): GoalState {
  return {
    id: 'collect:raw_iron',
    description: 'collect 3 x raw_iron',
    targetItem: 'raw_iron',
    requiredCount: 3,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
    ...overrides,
  }
}

function queuedGoal(overrides: Partial<QueuedGoal>): QueuedGoal {
  return {
    id: 'g1',
    kind: 'collect',
    description: 'collect 3 x raw_iron',
    targetItem: 'raw_iron',
    requiredCount: 3,
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

function queueWith(current: QueuedGoal): GoalQueueState {
  return { ...emptyGoalQueueState(), depth: 1, current, empty: false, goals: [current] }
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

function worldState(overrides: {
  position: Vec3Json
  goalQueue: GoalQueueState
  goal?: GoalState
  signals?: AgentSignals
  descent?: DescentOption[]
  stepCuts?: StepCut[]
  inventory?: InventoryState
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position),
    inventory: overrides.inventory ?? inventory({ stone_pickaxe: 1 }),
    entities: [],
    blocks: [],
    terrain: { standable: [overrides.position] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: overrides.goal ?? goal({}),
    goalQueue: overrides.goalQueue,
    recentEvents: [],
    descent: overrides.descent,
    stepCuts: overrides.stepCuts,
    signals: overrides.signals ?? signals(),
  }
}

function downStep(dir: DescentOption['dir'], dx: number, dz: number, feet: Vec3Json): DescentOption {
  const step = { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz }
  return {
    dir,
    mode: 'down',
    dx,
    dz,
    step,
    wall: { x: feet.x + dx, y: feet.y, z: feet.z + dz },
    head: { x: feet.x + dx, y: feet.y + 1, z: feet.z + dz },
    floor: { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz },
    wallSolid: false,
    headSolid: false,
    floorSolid: true,
    safe: true,
    reason: 'safe',
    digName: 'stone',
    digHarvestTool: 'pickaxe',
    digHarvestTier: 1,
    diggable: true,
  }
}

function retrieveOf(candidates: readonly Candidate[]): Candidate | null {
  return candidates.find((candidate) => candidate.kind === 'RETRIEVE') ?? null
}

/** The mirror of `downStep`: the upper block of a 2-block face opens a step up. */
function upCut(dir: StepCut['dir'], dx: number, dz: number, feet: Vec3Json, name = 'cobblestone'): StepCut {
  const cut = { x: feet.x + dx, y: feet.y + 1, z: feet.z + dz }
  return { dir, dx, dz, cut, step: cut, name, safe: true, reason: 'safe' }
}

const COBBLESTONE_HELD = { name: 'cobblestone', count: 119 }

function guardContext(candidateIds: string[]): GuardContext {
  return {
    phase: 'decision',
    candidateIds: new Set(candidateIds),
    inFlight: null,
    reach: 5,
    maxCandidateAgeTicks: 10,
  }
}

// --- vertical-plan generation ---------------------------------------------------

addCase('a target 8 blocks below yields an aligned downward staircase plan', () => {
  const feet = { x: 28, y: 57, z: 35 }
  const target = { x: 40, y: 49, z: 0 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target,
    tunnel: null,
    descent: [downStep('E', 1, 0, feet), downStep('N', 0, -1, feet)],
  })
  const pass =
    plan?.kind === 'staircase' &&
    plan.dir === 'E' &&
    plan.fromY === 57 &&
    plan.toY === 49 &&
    plan.step.y === 56 &&
    plan.dig.y === 56
  return { pass, detail: JSON.stringify(plan) }
})

addCase('a tunnel between the bot and a lower target is reused before digging', () => {
  const feet = { x: 28, y: 57, z: 35 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 25, y: 49, z: 36 },
    tunnel: { x: 27, y: 53, z: 35 },
    descent: [downStep('W', -1, 0, feet)],
  })
  const pass = plan?.kind === 'reuse' && plan.tunnel.x === 27 && plan.tunnel.y === 53
  return { pass, detail: JSON.stringify(plan) }
})

addCase('a tunnel pointing away from the target is ignored in favour of a staircase', () => {
  const feet = { x: 28, y: 57, z: 35 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 25, y: 49, z: 36 },
    tunnel: { x: 28, y: 61, z: 35 },
    descent: [downStep('W', -1, 0, feet)],
  })
  const pass = plan?.kind === 'staircase' && plan.toY === 49
  return { pass, detail: JSON.stringify(plan) }
})

addCase('an upward target with no safe upward primitive yields no staircase', () => {
  const feet = { x: 0, y: 57, z: 0 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 4, y: 66, z: 0 },
    tunnel: null,
    descent: [downStep('E', 1, 0, feet)],
  })
  return { pass: plan === null, detail: JSON.stringify(plan) }
})

addCase('a level target produces no vertical plan', () => {
  const feet = { x: 0, y: 57, z: 0 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 4, y: 58, z: 0 },
    tunnel: null,
    descent: [downStep('E', 1, 0, feet)],
  })
  return { pass: plan === null, detail: JSON.stringify(plan) }
})

// --- upward-plan generation (M2 blocker: the bot is under everything) -----------

addCase('a target one block above with a held cobblestone yields a pillar plan', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 39, y: 32, z: 33 },
    tunnel: null,
    descent: [],
    placeable: COBBLESTONE_HELD,
  })
  const pass =
    plan?.kind === 'pillar' && plan.steps === 1 && plan.fromY === 31 && plan.toY === 32 && plan.placeName === 'cobblestone'
  return { pass, detail: JSON.stringify(plan) }
})

addCase('a target five blocks above with a held cobblestone yields a bounded pillar plan', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 43, y: 36, z: 33 },
    tunnel: null,
    descent: [],
    placeable: COBBLESTONE_HELD,
  })
  const pass = plan?.kind === 'pillar' && plan.steps === 5 && plan.toY === 36 && plan.placeCount === 119
  return { pass, detail: JSON.stringify(plan) }
})

addCase('a target beyond the pillar cap is a bounded decision, never an unbounded climb', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 43, y: 66, z: 33 },
    tunnel: null,
    descent: [],
    placeable: COBBLESTONE_HELD,
  })
  const pass =
    plan?.kind === 'pillar' &&
    plan.steps === PILLAR_UP_STEP_CAP &&
    plan.steps < 35 &&
    plan.toY === feet.y + PILLAR_UP_STEP_CAP
  return { pass, detail: JSON.stringify(plan) }
})

addCase('pillar-up refuses when no placeable block is held', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 43, y: 36, z: 33 },
    tunnel: null,
    descent: [],
    placeable: null,
  })
  return { pass: plan === null, detail: JSON.stringify(plan) }
})

addCase('a safe step-cut turns an upward target into a staircase-up plan', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const cut = upCut('E', 1, 0, feet)
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 43, y: 36, z: 33 },
    tunnel: null,
    descent: [],
    stepCuts: [cut],
  })
  const pass =
    plan?.kind === 'staircase-up' &&
    plan.dir === 'E' &&
    plan.dig.x === cut.cut.x &&
    plan.dig.y === 32 &&
    plan.step.x === cut.step.x &&
    plan.digName === 'cobblestone'
  return { pass, detail: JSON.stringify(plan) }
})

addCase('a tunnel between the bot and an upper target is reused before climbing', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 39, y: 40, z: 33 },
    tunnel: { x: 39, y: 36, z: 33 },
    descent: [],
    placeable: COBBLESTONE_HELD,
  })
  const pass = plan?.kind === 'reuse' && plan.tunnel.y === 36
  return { pass, detail: JSON.stringify(plan) }
})

addCase('a safe step-cut is preferred over pillar-up when both are grounded', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 43, y: 36, z: 33 },
    tunnel: null,
    descent: [],
    stepCuts: [upCut('E', 1, 0, feet)],
    placeable: COBBLESTONE_HELD,
  })
  return { pass: plan?.kind === 'staircase-up', detail: JSON.stringify(plan) }
})

addCase('an unsafe step-cut does not ground an upward staircase', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const cut = { ...upCut('E', 1, 0, feet), safe: false, reason: 'lava/water in the step column' }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 43, y: 36, z: 33 },
    tunnel: null,
    descent: [],
    stepCuts: [cut],
  })
  return { pass: plan === null, detail: JSON.stringify(plan) }
})

// --- executable upward plans (FIRST_FAILED_BOUNDARY d54d9a8) ---------------------
//
// `StepCut.safe` proves the geometry (breakable, landing support, headroom, no
// hazard) but not that the held tools can finish the dig. The measured live
// refusal `safe_column:no_tool@39,12,31:pickaxe@0` came from a staircase-up plan
// the executor could never dig (stone, no pickaxe) shadowing the pillar-up
// mechanic that the held cobblestone 170 made available. A plan is now only
// chosen when `canDigBlock` proves the dig executable, so the pillar fallback
// gets its chance and the soft classes never require a pickaxe.

addCase('a stone step-cut without a pickaxe falls through to the pillar fallback', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 43, y: 36, z: 33 },
    tunnel: null,
    descent: [],
    stepCuts: [upCut('E', 1, 0, feet, 'stone')],
    placeable: COBBLESTONE_HELD,
    inventory: inventory({ cobblestone: 119 }).counts,
  })
  const pass =
    plan?.kind === 'pillar' &&
    plan.placeName === 'cobblestone' &&
    plan.fromY === 31 &&
    plan.toY === 36
  return { pass, detail: JSON.stringify(plan) }
})

addCase('a stone step-cut without a pickaxe AND without a placeable yields no upward plan', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 43, y: 36, z: 33 },
    tunnel: null,
    descent: [],
    stepCuts: [upCut('E', 1, 0, feet, 'stone')],
    placeable: null,
    inventory: inventory({ birch_planks: 2 }).counts,
  })
  return { pass: plan === null, detail: JSON.stringify(plan) }
})

addCase('a dirt step-cut is diggable by hand without a pickaxe (soft class)', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 43, y: 36, z: 33 },
    tunnel: null,
    descent: [],
    stepCuts: [upCut('E', 1, 0, feet, 'dirt')],
    placeable: COBBLESTONE_HELD,
    inventory: inventory({}).counts,
  })
  const pass = plan?.kind === 'staircase-up' && plan.digName === 'dirt' && plan.dig.y === 32
  return { pass, detail: JSON.stringify(plan) }
})

addCase('with the pickaxe held the same stone step-cut still wins over the pillar (no reordering)', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 43, y: 36, z: 33 },
    tunnel: null,
    descent: [],
    stepCuts: [upCut('E', 1, 0, feet, 'stone')],
    placeable: COBBLESTONE_HELD,
    inventory: inventory({ cobblestone: 119, stone_pickaxe: 1 }).counts,
  })
  const pass = plan?.kind === 'staircase-up' && plan.dir === 'E' && plan.dig.y === 32
  return { pass, detail: JSON.stringify(plan) }
})

addCase('a tool-agnostic caller (no inventory) keeps the geometry-only staircase-up choice', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 43, y: 36, z: 33 },
    tunnel: null,
    descent: [],
    stepCuts: [upCut('E', 1, 0, feet, 'cobblestone')],
  })
  return { pass: plan?.kind === 'staircase-up', detail: JSON.stringify(plan) }
})

// --- M2 ascent persistence ------------------------------------------------------

addCase('a 56-block ascent sustains bounded pillar chunks until the target Y', () => {
  const target = { x: 39, y: 66, z: 33 }
  let y = 10
  const chunks: number[] = []
  const outcomes: string[] = []
  let track: RetrievalProgressState = { best: target.y - y, ticks: 0, bestGap: target.y - y }
  for (let guard = 0; y < target.y && guard < 20; guard += 1) {
    const plan = planVerticalApproach({
      selfFeetY: y,
      selfPosition: { x: target.x, y, z: target.z },
      target,
      tunnel: null,
      descent: [],
      placeable: COBBLESTONE_HELD,
    })
    if (plan === null || plan.kind !== 'pillar') break
    chunks.push(plan.steps)
    y += plan.steps
    const decision = evaluateRetrievalProgress({
      previous: track,
      distance: Math.abs(target.y - y),
      verticalGap: target.y - y,
      epsilon: 0.5,
      stallTicks: 4,
    })
    track = { best: decision.best, ticks: decision.ticks, bestGap: decision.bestGap }
    outcomes.push(decision.outcome)
  }
  const pass =
    y >= target.y &&
    PILLAR_UP_STEP_CAP > 8 &&
    chunks.length >= 2 &&
    chunks.length <= 6 &&
    chunks[0] === PILLAR_UP_STEP_CAP &&
    chunks.every((steps) => steps >= 1 && steps <= PILLAR_UP_STEP_CAP) &&
    !outcomes.includes('stalled')
  return { pass, detail: `chunks=[${chunks.join(',')}] y=${y} outcomes=[${outcomes.join(',')}]` }
})

addCase('altitude gain counts as progress when the 3D distance barely moves', () => {
  const target = { x: 239, y: 66, z: 33 }
  const self = { x: 39, y: 10, z: 33 }
  const distanceAt = (y: number): number => Math.hypot(target.x - self.x, y - target.y, target.z - self.z)
  const beforeDistance = distanceAt(10)
  const afterDistance = distanceAt(11)
  const distanceOnly = evaluateRetrievalProgress({
    previous: { best: beforeDistance, ticks: 0, bestGap: 56 },
    distance: afterDistance,
    epsilon: 0.5,
    stallTicks: 1,
  })
  const withAltitude = evaluateRetrievalProgress({
    previous: { best: beforeDistance, ticks: 0, bestGap: 56 },
    distance: afterDistance,
    verticalGap: 55,
    verticalEpsilon: ASCENT_PROGRESS_EPSILON,
    epsilon: 0.5,
    stallTicks: 1,
  })
  const pass =
    Math.abs(afterDistance - beforeDistance) < 0.5 &&
    distanceOnly.outcome === 'stalled' &&
    withAltitude.outcome === 'progress' &&
    withAltitude.bestGap === 55
  return {
    pass,
    detail: `distanceDelta=${(afterDistance - beforeDistance).toFixed(3)} distanceOnly=${distanceOnly.outcome} withAltitude=${withAltitude.outcome} bestGap=${withAltitude.bestGap}`,
  }
})

addCase('a climbing retrieval never stalls across the stall window', () => {
  let track: RetrievalProgressState = { best: 56, ticks: 0, bestGap: 56 }
  const outcomes: string[] = []
  for (let step = 1; step <= 40; step += 1) {
    const decision = evaluateRetrievalProgress({
      previous: track,
      distance: 56 - step,
      verticalGap: 56 - step,
      epsilon: 0.5,
      stallTicks: 40,
    })
    track = { best: decision.best, ticks: decision.ticks, bestGap: decision.bestGap }
    outcomes.push(decision.outcome)
  }
  const pass =
    !outcomes.includes('stalled') &&
    outcomes.every((outcome) => outcome === 'progress') &&
    track.bestGap === 16 &&
    track.ticks === 0
  return { pass, detail: `stalled=${outcomes.filter((o) => o === 'stalled').length} bestGap=${track.bestGap} ticks=${track.ticks}` }
})

addCase('a retrieval that only loses altitude still stalls', () => {
  let track: RetrievalProgressState = { best: 10, ticks: 0, bestGap: 10 }
  const outcomes: string[] = []
  for (let tick = 0; tick < 5; tick += 1) {
    const decision = evaluateRetrievalProgress({
      previous: track,
      distance: 10.2,
      verticalGap: 10.2 + tick,
      epsilon: 0.5,
      stallTicks: 4,
    })
    track = { best: decision.best, ticks: decision.ticks, bestGap: decision.bestGap }
    outcomes.push(decision.outcome)
  }
  const pass = outcomes.includes('stalled') && track.bestGap === 10
  return { pass, detail: `outcomes=[${outcomes.join(',')}] bestGap=${track.bestGap}` }
})

addCase('a pillar step refuses without a placeable, on a hazard column, without footing, or without headroom', () => {
  const base = { placeableCount: 1, columnSafe: true, remaining: 4, footingSolid: true, headroomClear: true }
  const noPlaceable = evaluatePillarStep({ ...base, placeableCount: 0 })
  const unsafe = evaluatePillarStep({ ...base, columnSafe: false })
  const noFooting = evaluatePillarStep({ ...base, footingSolid: false })
  const noHeadroom = evaluatePillarStep({ ...base, headroomClear: false })
  const reached = evaluatePillarStep({ ...base, remaining: 0 })
  const ok = evaluatePillarStep(base)
  const pass =
    !noPlaceable.ok &&
    noPlaceable.reason === 'no_placeable' &&
    !unsafe.ok &&
    unsafe.reason === 'unsafe_column' &&
    !noFooting.ok &&
    noFooting.reason === 'no_footing' &&
    !noHeadroom.ok &&
    noHeadroom.reason === 'no_headroom' &&
    !reached.ok &&
    reached.reason === 'reached' &&
    ok.ok
  return {
    pass,
    detail: `noPlaceable=${noPlaceable.ok ? 'ok' : noPlaceable.reason} unsafe=${unsafe.ok ? 'ok' : unsafe.reason} noFooting=${noFooting.ok ? 'ok' : noFooting.reason} noHeadroom=${noHeadroom.ok ? 'ok' : noHeadroom.reason} reached=${reached.ok ? 'ok' : reached.reason} ok=${ok.ok}`,
  }
})

addCase('jump headroom includes adjacent cells touched by the player footprint', () => {
  const blocked = new Set(['38,24,33'])
  const isPassable = (x: number, y: number, z: number): boolean => !blocked.has(`${x},${y},${z}`)
  const nearBoundary = headroomAcrossFootprint({
    center: { x: 39.28, z: 33.48 },
    feetY: 23.5,
    halfWidth: 0.3,
    isPassable,
  })
  const centered = headroomAcrossFootprint({
    center: { x: 39.5, z: 33.5 },
    feetY: 23.5,
    halfWidth: 0.3,
    isPassable,
  })
  const pass =
    !nearBoundary.clear &&
    nearBoundary.blocker !== null &&
    nearBoundary.blocker.x === 38 &&
    nearBoundary.blocker.y === 24 &&
    nearBoundary.blocker.z === 33 &&
    centered.clear &&
    centered.blocker === null
  return {
    pass,
    detail: `nearBoundary=${nearBoundary.clear ? 'clear' : `blocked@${nearBoundary.blocker?.x},${nearBoundary.blocker?.y},${nearBoundary.blocker?.z}`} centered=${centered.clear ? 'clear' : 'blocked'}`,
  }
})

addCase('jump headroom fails closed when any footprint cell is unknown/unloaded', () => {
  const unknown = new Set(['10,56,25'])
  const result = headroomAcrossFootprint({
    center: { x: 10.6, z: 25.4 },
    feetY: 54,
    halfWidth: 0.3,
    isPassable: (x, y, z) => !unknown.has(`${x},${y},${z}`),
  })
  const pass =
    !result.clear &&
    result.blocker?.x === 10 &&
    result.blocker?.y === 56 &&
    result.blocker?.z === 25
  return {
    pass,
    detail: `unknown=${result.clear ? 'incorrectly-clear' : `blocked@${result.blocker?.x},${result.blocker?.y},${result.blocker?.z}`}`,
  }
})

addCase('a hazard in the bot column refuses the pillar plan even with a placeable held', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const inColumn = pillarColumnUnsafeFromBlocks(feet, [
    { kind: 'hazard', position: { x: 39, y: 32, z: 33 } },
  ])
  const underneath = pillarColumnUnsafeFromBlocks(feet, [
    { kind: 'hazard', position: { x: 39, y: 30, z: 33 } },
  ])
  const beside = pillarColumnUnsafeFromBlocks(feet, [
    { kind: 'hazard', position: { x: 39, y: 32, z: 34 } },
  ])
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 43, y: 36, z: 33 },
    tunnel: null,
    descent: [],
    placeable: COBBLESTONE_HELD,
    columnSafe: false,
  })
  const pass = inColumn && underneath && !beside && plan === null
  return {
    pass,
    detail: `inColumn=${inColumn} underneath=${underneath} beside=${beside} plan=${plan === null ? 'null' : plan.kind}`,
  }
})

addCase('the pillar footing scan grounds a full block and a partial mount, and refuses an airborne gap', () => {
  const full = resolvePillarStep({ feetY: 10, isSolid: (y) => y === 9 })
  const partial = resolvePillarStep({ feetY: 9.5, isSolid: (y) => y === 9 })
  // A solid block two cells down with air between is not a footing: the old
  // scan accepted it and would place into the gap.
  const gap = resolvePillarStep({ feetY: 10.5, isSolid: (y) => y === 8 })
  const none = resolvePillarStep({ feetY: 10, isSolid: () => false })
  const pass =
    full?.footingY === 9 &&
    full.placeY === 10 &&
    full.landingY === 11 &&
    partial?.footingY === 9 &&
    partial.placeY === 10 &&
    partial.landingY === 11 &&
    gap === null &&
    none === null
  return {
    pass,
    detail: `full=${JSON.stringify(full)} partial=${JSON.stringify(partial)} gap=${gap === null ? 'null' : 'pose'} none=${none === null ? 'null' : 'pose'}`,
  }
})

addCase('a 1-block and a 2-block climb stay single-step pillar actions', () => {
  const results: Array<{ dy: number; steps: number; reached: number }> = []
  for (const dy of [1, 2]) {
    const feet = { x: 39, y: 31, z: 33 }
    const target = { x: 39, y: 31 + dy, z: 33 }
    const plan = planVerticalApproach({
      selfFeetY: feet.y,
      selfPosition: feet,
      target,
      tunnel: null,
      descent: [],
      placeable: COBBLESTONE_HELD,
    })
    if (plan !== null && plan.kind === 'pillar') {
      results.push({ dy, steps: plan.steps, reached: feet.y + plan.steps })
    }
  }
  const pass =
    results.length === 2 &&
    results.every((entry) => entry.steps === entry.dy && entry.reached === 31 + entry.dy)
  return { pass, detail: JSON.stringify(results) }
})

addCase('the ASCENT_PROGRESS marker carries the chunk and the target Y', () => {
  const line = formatAscentProgress(10, 34, 66)
  const pass = line === 'ASCENT_PROGRESS from_y=10 to_y=34 target_y=66'
  return { pass, detail: line }
})

// --- PILLAR_UP pocket escape (headroom clear / grounded relocation) -------------

addCase('a diggable ceiling block is cleared and the pillar step then proceeds (1-block pocket)', () => {
  // Live cell: feet (40,8,31), cobblestone ceiling at (40,9,31).
  const decision = classifyHeadroomBlocker({
    cell: { x: 40, y: 9, z: 31 },
    name: 'cobblestone',
    diggable: true,
    fluidOrHazard: false,
    floodRisk: false,
    toolOk: true,
  })
  const noObstacle = classifyHeadroomBlocker(null)
  const step = evaluatePillarStep({
    placeableCount: 62,
    columnSafe: true,
    remaining: 24,
    footingSolid: true,
    headroomClear: true,
  })
  const pass =
    decision.kind === 'dig' &&
    decision.obstacle.name === 'cobblestone' &&
    decision.obstacle.cell.y === 9 &&
    noObstacle.kind === 'refuse' &&
    noObstacle.reason === 'no_obstacle' &&
    step.ok
  return {
    pass,
    detail: `decision=${decision.kind} obstacle=${decision.kind === 'dig' ? `${decision.obstacle.name}@${decision.obstacle.cell.y}` : '-'} noObstacle=${noObstacle.kind}/${noObstacle.kind === 'refuse' ? noObstacle.reason : 'dig'} step=${step.ok ? 'ok' : step.reason}`,
  }
})

addCase('an undiggable ceiling refuses with the typed marker and offers the adjacent open column', () => {
  const ceiling = { x: 40, y: 9, z: 31 }
  const feet = { x: 40, y: 8, z: 31 }
  // Live inventory: cobblestone x62 and no pickaxe -> selectDigTool refuses the
  // stone-family ceiling, which used to be a silent `false` from clearPillarHeadroom.
  const decision = classifyHeadroomBlocker({
    cell: ceiling,
    name: 'cobblestone',
    diggable: true,
    fluidOrHazard: false,
    floodRisk: false,
    toolOk: false,
  })
  const marker =
    decision.kind === 'refuse'
      ? formatPillarRefused({ reason: 'no_headroom', cell: feet, obstacle: decision.obstacle, cause: decision.reason })
      : 'not-refused'
  // Live step geometry: E/W/N walls, S (40,8,32) open with air at +1 and +2.
  const probes: PillarColumnProbe[] = [
    { cell: { x: 41, y: 8, z: 31 }, supported: true, feetClear: true, headClear: true, aboveHeadClear: true, unsafe: true },
    { cell: { x: 39, y: 8, z: 31 }, supported: true, feetClear: false, headClear: false, aboveHeadClear: false, unsafe: false },
    { cell: { x: 40, y: 8, z: 30 }, supported: true, feetClear: false, headClear: false, aboveHeadClear: false, unsafe: false },
    { cell: { x: 40, y: 8, z: 32 }, supported: true, feetClear: true, headClear: true, aboveHeadClear: true, unsafe: false },
  ]
  const fallback = selectPillarFallbackColumn(probes, feet)
  const pass =
    decision.kind === 'refuse' &&
    decision.reason === 'needs_tool' &&
    marker === 'PILLAR_REFUSED reason=no_headroom cell=40,8,31 obstacle=cobblestone@40,9,31 cause=needs_tool' &&
    fallback !== null &&
    fallback.x === 40 &&
    fallback.y === 8 &&
    fallback.z === 32
  return {
    pass,
    detail: `decision=${decision.kind}${decision.kind === 'refuse' ? `/${decision.reason}` : ''} marker=${marker} fallback=${fallback === null ? 'none' : `${fallback.x},${fallback.y},${fallback.z}`}`,
  }
})

addCase('fluid, flood-risk and unbreakable ceilings refuse with their own causes (never dug)', () => {
  const fluid = classifyHeadroomBlocker({
    cell: { x: 40, y: 9, z: 31 },
    name: 'water',
    diggable: false,
    fluidOrHazard: true,
    floodRisk: true,
    toolOk: false,
  })
  const flood = classifyHeadroomBlocker({
    cell: { x: 40, y: 10, z: 31 },
    name: 'dirt',
    diggable: true,
    fluidOrHazard: false,
    floodRisk: true,
    toolOk: true,
  })
  const unbreakable = classifyHeadroomBlocker({
    cell: { x: 40, y: 9, z: 31 },
    name: 'bedrock',
    diggable: false,
    fluidOrHazard: false,
    floodRisk: false,
    toolOk: false,
  })
  const pass =
    fluid.kind === 'refuse' &&
    fluid.reason === 'fluid_or_hazard' &&
    flood.kind === 'refuse' &&
    flood.reason === 'flood_risk' &&
    unbreakable.kind === 'refuse' &&
    unbreakable.reason === 'not_diggable'
  return {
    pass,
    detail: `fluid=${fluid.kind}/${fluid.kind === 'refuse' ? fluid.reason : ''} flood=${flood.kind}/${flood.kind === 'refuse' ? flood.reason : ''} unbreakable=${unbreakable.kind}/${unbreakable.kind === 'refuse' ? unbreakable.reason : ''}`,
  }
})

addCase('the fallback picks the nearest open same-level column and keeps probe order as tie-break', () => {
  const open = (cell: Vec3Json): PillarColumnProbe => ({
    cell,
    supported: true,
    feetClear: true,
    headClear: true,
    aboveHeadClear: true,
    unsafe: false,
  })
  const feet = { x: 40, y: 8, z: 31 }
  const diagonal = { x: 41, y: 8, z: 32 }
  const first = selectPillarFallbackColumn([open({ x: 41, y: 8, z: 31 }), open(diagonal)], feet)
  const tie = selectPillarFallbackColumn([open({ x: 40, y: 8, z: 32 }), open({ x: 41, y: 8, z: 31 })], feet)
  const level = selectPillarFallbackColumn([open({ x: 40, y: 9, z: 32 }), open({ x: 40, y: 8, z: 30 })], feet)
  const pass =
    first?.x === 41 &&
    first?.z === 31 &&
    tie?.x === 40 &&
    tie?.z === 32 &&
    level?.y === 8 &&
    selectPillarFallbackColumn([], feet) === null
  return {
    pass,
    detail: `nearest=${first?.x},${first?.y},${first?.z} tie=${tie?.x},${tie?.y},${tie?.z} sameLevel=${level?.x},${level?.y},${level?.z} empty=null`,
  }
})

addCase('a non-pocket pillar proceeds and a walled pocket offers no relocation', () => {
  const step = evaluatePillarStep({
    placeableCount: 1,
    columnSafe: true,
    remaining: 4,
    footingSolid: true,
    headroomClear: true,
  })
  const walled: PillarColumnProbe[] = [
    { cell: { x: 41, y: 8, z: 31 }, supported: true, feetClear: false, headClear: false, aboveHeadClear: false, unsafe: false },
    { cell: { x: 39, y: 8, z: 31 }, supported: true, feetClear: false, headClear: false, aboveHeadClear: false, unsafe: false },
    { cell: { x: 40, y: 8, z: 30 }, supported: true, feetClear: false, headClear: false, aboveHeadClear: false, unsafe: false },
    { cell: { x: 40, y: 8, z: 32 }, supported: true, feetClear: false, headClear: false, aboveHeadClear: false, unsafe: false },
  ]
  const fallback = selectPillarFallbackColumn(walled, { x: 40, y: 8, z: 31 })
  const pass = step.ok && fallback === null
  return { pass, detail: `step=${step.ok ? 'ok' : step.reason} fallback=${fallback === null ? 'none' : 'offered'}` }
})

addCase('the live pocket marker sequence pins refusal, relocation and the executed step', () => {
  const obstacle = { cell: { x: 40, y: 9, z: 31 }, name: 'cobblestone' }
  const refused = formatPillarRefused({
    reason: 'no_headroom',
    cell: { x: 40, y: 8, z: 31 },
    obstacle,
    cause: 'needs_tool',
  })
  const relocate = formatPillarRelocate({ x: 40, y: 8, z: 31 }, { x: 40, y: 8, z: 32 }, obstacle)
  const step = formatPillarUpStep(1, 8, 9, 'cobblestone')
  const pass =
    refused === 'PILLAR_REFUSED reason=no_headroom cell=40,8,31 obstacle=cobblestone@40,9,31 cause=needs_tool' &&
    relocate === 'PILLAR_RELOCATE from=40,8,31 to=40,8,32 obstacle=cobblestone@40,9,31' &&
    step === 'PILLAR_UP_STEP step=1 from_y=8 to_y=9 placed=cobblestone'
  return { pass, detail: `${refused} | ${relocate} | ${step}` }
})

// --- candidate wiring -----------------------------------------------------------

addCase('a below-level remembered ore emits a staircase retrieval candidate', () => {
  const feet = { x: 28, y: 57, z: 35 }
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', dimension: 'minecraft:overworld', position: { x: 40, y: 49, z: 0 } }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({})),
    signals: signals({ knownResources: [known] }),
    descent: [downStep('E', 1, 0, feet)],
  })
  const retrieve = retrieveOf(generateCandidates(state, defaultCandidateOptions))
  const pass =
    retrieve !== null &&
    retrieve.meta.vertical === 'staircase' &&
    retrieve.meta.stairToY === 49 &&
    typeof retrieve.meta.stairDigX === 'number' &&
    retrieve.meta.stairDigY === 56
  return { pass, detail: retrieve === null ? 'no RETRIEVE' : JSON.stringify(retrieve.meta) }
})

addCase('a remembered tunnel turns the retrieval candidate into a reuse plan', () => {
  const feet = { x: 28, y: 57, z: 35 }
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', dimension: 'minecraft:overworld', position: { x: 25, y: 49, z: 36 } }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({})),
    signals: signals({ knownResources: [known], lastTunnel: { x: 27, y: 53, z: 35 } }),
    descent: [downStep('W', -1, 0, feet)],
  })
  const retrieve = retrieveOf(generateCandidates(state, defaultCandidateOptions))
  const pass =
    retrieve !== null &&
    retrieve.meta.vertical === 'reuse' &&
    retrieve.meta.tunnelX === 27 &&
    retrieve.meta.tunnelY === 53
  return { pass, detail: retrieve === null ? 'no RETRIEVE' : JSON.stringify(retrieve.meta) }
})

addCase('an above-level remembered ore with cobblestone held emits a pillar retrieval candidate', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', dimension: 'minecraft:overworld', position: { x: 53, y: 36, z: 33 } }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({})),
    signals: signals({ knownResources: [known] }),
    inventory: inventory({ cobblestone: 119, stone_pickaxe: 1 }),
  })
  const retrieve = retrieveOf(generateCandidates(state, defaultCandidateOptions))
  const pass =
    retrieve !== null &&
    retrieve.meta.vertical === 'pillar' &&
    retrieve.meta.pillarPlaceName === 'cobblestone' &&
    retrieve.meta.pillarSteps === 5 &&
    retrieve.meta.verticalToY === 36
  return { pass, detail: retrieve === null ? 'no RETRIEVE' : JSON.stringify(retrieve.meta) }
})

addCase('an above-level remembered ore with a safe step-cut emits a staircase-up candidate', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', dimension: 'minecraft:overworld', position: { x: 43, y: 40, z: 33 } }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({})),
    signals: signals({ knownResources: [known] }),
    inventory: inventory({ cobblestone: 119, stone_pickaxe: 1 }),
    stepCuts: [upCut('E', 1, 0, feet)],
  })
  const retrieve = retrieveOf(generateCandidates(state, defaultCandidateOptions))
  const pass =
    retrieve !== null &&
    retrieve.meta.vertical === 'staircase-up' &&
    retrieve.meta.upDir === 'E' &&
    retrieve.meta.upDigY === 32 &&
    retrieve.meta.upStepX === feet.x + 1
  return { pass, detail: retrieve === null ? 'no RETRIEVE' : JSON.stringify(retrieve.meta) }
})

addCase('an above-level remembered ore without a placeable keeps an explicit vertical=none', () => {
  const feet = { x: 39, y: 31, z: 33 }
  // dy=3 stays inside the walkable band, so the affordance gate presents it and
  // the vertical plan stays explicitly 'none' (a dy>4 climb without a plan is
  // withheld as needs_ascend by the gate; see test-reachability.mts).
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', dimension: 'minecraft:overworld', position: { x: 53, y: 34, z: 33 } }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({})),
    signals: signals({ knownResources: [known] }),
    inventory: inventory({ stone_pickaxe: 1 }),
  })
  const retrieve = retrieveOf(generateCandidates(state, defaultCandidateOptions))
  const pass =
    retrieve !== null &&
    retrieve.meta.vertical === 'none' &&
    retrieve.meta.verticalToY === 34
  return { pass, detail: retrieve === null ? 'no RETRIEVE' : JSON.stringify(retrieve.meta) }
})

// --- guard grounding ------------------------------------------------------------

addCase('the guard accepts a staircase retrieval grounded in the descent options', () => {
  const feet = { x: 28, y: 57, z: 35 }
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', dimension: 'minecraft:overworld', position: { x: 40, y: 49, z: 0 } }
  const step = downStep('E', 1, 0, feet)
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({})),
    signals: signals({ knownResources: [known] }),
    descent: [step],
  })
  const candidate: Candidate = {
    id: 'RETRIEVE:known:raw_iron:b40_49_0',
    kind: 'RETRIEVE',
    label: 'retrieve',
    targetName: 'iron_ore',
    target: known.position,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: {
      tick: 7,
      retrieval: 'known',
      resource: 'raw_iron',
      vertical: 'staircase',
      stairDigX: step.floor.x,
      stairDigY: step.floor.y,
      stairDigZ: step.floor.z,
    },
  }
  const result = guardCandidate(candidate, state, guardContext([candidate.id]))
  return { pass: result.ok, detail: result.ok ? 'accepted' : result.code }
})

addCase('the guard rejects a staircase retrieval with no matching descent step', () => {
  const feet = { x: 28, y: 57, z: 35 }
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', dimension: 'minecraft:overworld', position: { x: 40, y: 49, z: 0 } }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({})),
    signals: signals({ knownResources: [known] }),
    descent: [downStep('E', 1, 0, feet)],
  })
  const candidate: Candidate = {
    id: 'RETRIEVE:known:raw_iron:b40_49_0',
    kind: 'RETRIEVE',
    label: 'retrieve',
    targetName: 'iron_ore',
    target: known.position,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: {
      tick: 7,
      retrieval: 'known',
      resource: 'raw_iron',
      vertical: 'staircase',
      stairDigX: 999,
      stairDigY: 20,
      stairDigZ: 999,
    },
  }
  const result = guardCandidate(candidate, state, guardContext([candidate.id]))
  return { pass: !result.ok && result.code === 'NO_SUPPORT', detail: result.ok ? 'accepted' : result.code }
})

// --- stall escalation -----------------------------------------------------------

addCase('a decreasing retrieval distance counts as progress', () => {
  const decision = evaluateRetrievalProgress({
    previous: { best: 9, ticks: 3 },
    distance: 8.4,
    epsilon: 0.5,
    stallTicks: 6,
  })
  const pass = decision.outcome === 'progress' && decision.best === 8.4 && decision.ticks === 0
  return { pass, detail: JSON.stringify(decision) }
})

addCase('a flat retrieval distance increments the stall counter', () => {
  const decision = evaluateRetrievalProgress({
    previous: { best: 9, ticks: 2 },
    distance: 8.9,
    epsilon: 0.5,
    stallTicks: 6,
  })
  const pass = decision.outcome === 'tracking' && decision.best === 9 && decision.ticks === 3
  return { pass, detail: JSON.stringify(decision) }
})

addCase('a retrieval that stops closing distance for N ticks escalates', () => {
  let track = { best: 9, ticks: 0 }
  const outcomes: string[] = []
  for (let i = 0; i < 7; i += 1) {
    const decision = evaluateRetrievalProgress({
      previous: track,
      distance: 9,
      epsilon: 0.5,
      stallTicks: 6,
    })
    track = { best: decision.best, ticks: decision.ticks }
    outcomes.push(decision.outcome)
  }
  const pass = outcomes.join(',') === 'tracking,tracking,tracking,tracking,tracking,stalled,tracking'
  return { pass, detail: outcomes.join(',') }
})

// --- tunnel entry validation (M2 FURNACE_READY) ---------------------------------

const blockedBy = (cell: Vec3Json, name: string, ok = true): TunnelEntryBlockerProbe => ({
  cell,
  name,
  diggable: ok,
  fluidOrHazard: false,
  floodRisk: false,
  toolOk: ok,
})

addCase('a reused tunnel whose entry is blocked yields the clearance step, never a blind waypoint', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const tunnel = { x: 40, y: 30, z: 33 }
  const decision = planVerticalApproachDetailed({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 40, y: 25, z: 33 },
    tunnel,
    descent: [],
    tunnelEntry: {
      cell: tunnel,
      bodyClear: false,
      headClear: true,
      supportSolid: true,
      blocker: blockedBy(tunnel, 'cobblestone'),
    },
  })
  const pass =
    decision.plan?.kind === 'reuse' &&
    decision.plan.clear?.cell.y === 30 &&
    decision.plan.clear?.name === 'cobblestone' &&
    decision.tunnelRefusal === null
  return { pass, detail: JSON.stringify(decision) }
})

addCase('a blocked entry cell with an enterable alternate reuses the next entry cell', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const tunnel = { x: 40, y: 30, z: 33 }
  const alternate = { x: 40, y: 29, z: 33 }
  const decision = planVerticalApproachDetailed({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 40, y: 25, z: 33 },
    tunnel,
    descent: [],
    tunnelEntry: {
      cell: tunnel,
      bodyClear: false,
      headClear: true,
      supportSolid: true,
      blocker: blockedBy(tunnel, 'bedrock', false),
    },
    tunnelAlternates: [{ cell: alternate, bodyClear: true, headClear: true, supportSolid: true }],
  })
  const pass =
    decision.plan?.kind === 'reuse' &&
    decision.plan.tunnel.x === alternate.x &&
    decision.plan.tunnel.y === alternate.y &&
    decision.plan.clear === undefined &&
    decision.tunnelRefusal === null
  return { pass, detail: JSON.stringify(decision) }
})

addCase('a blocked waypoint 1.5 m away produces a local clearance attempt, not path_stuck', () => {
  const leg = planReuseLeg({
    entry: { kind: 'enterable' },
    pathFailed: true,
    distanceToTunnel: 1.5,
    approachBlockages: [
      { cell: { x: 32, y: 36, z: 36 }, passable: false, name: 'cobblestone', diggable: true, fluidOrHazard: false, floodRisk: false, toolOk: true },
      { cell: { x: 32, y: 35, z: 35 }, passable: true },
    ],
  })
  const far = planReuseLeg({
    entry: { kind: 'enterable' },
    pathFailed: true,
    distanceToTunnel: LOCAL_CLEAR_RADIUS + 5,
    approachBlockages: [
      { cell: { x: 32, y: 36, z: 36 }, passable: false, name: 'cobblestone', diggable: true, fluidOrHazard: false, floodRisk: false, toolOk: true },
    ],
  })
  const multiple = planReuseLeg({
    entry: { kind: 'enterable' },
    pathFailed: true,
    distanceToTunnel: 1.5,
    approachBlockages: [
      { cell: { x: 32, y: 36, z: 36 }, passable: false, name: 'cobblestone', diggable: true, fluidOrHazard: false, floodRisk: false, toolOk: true },
      { cell: { x: 31, y: 36, z: 35 }, passable: false, name: 'stone', diggable: true, fluidOrHazard: false, floodRisk: false, toolOk: true },
    ],
  })
  const pass =
    leg.action === 'clear-approach' &&
    leg.cell.x === 32 &&
    leg.cell.z === 36 &&
    far.action === 'fail' &&
    far.code === 'path_stuck' &&
    multiple.action === 'fail'
  return { pass, detail: `near=${leg.action} far=${far.action} multiple=${multiple.action}` }
})

addCase('a tunnel with no usable entry refuses with the typed marker and selects a different plan', () => {
  const feet = { x: 28, y: 57, z: 35 }
  const tunnel = { x: 27, y: 53, z: 35 }
  const decision = planVerticalApproachDetailed({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 25, y: 49, z: 36 },
    tunnel,
    descent: [downStep('W', -1, 0, feet)],
    tunnelEntry: { cell: tunnel, bodyClear: true, headClear: true, supportSolid: false, blocker: null },
  })
  const marker = formatTunnelEntryRefused({
    reason: 'no_support',
    cell: tunnel,
  })
  const pass =
    decision.plan?.kind === 'staircase' &&
    decision.tunnelRefusal?.reason === 'no_support' &&
    decision.tunnelRefusal.cell.y === 53 &&
    marker === 'TUNNEL_ENTRY_REFUSED reason=no_support cell=27,53,35'
  return { pass, detail: `${JSON.stringify(decision)} marker=${marker}` }
})

addCase('a normally enterable tunnel is unaffected (no regression)', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const tunnel = { x: 40, y: 30, z: 33 }
  const decision = planVerticalApproachDetailed({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 40, y: 25, z: 33 },
    tunnel,
    descent: [],
    tunnelEntry: { cell: tunnel, bodyClear: true, headClear: true, supportSolid: true, blocker: null },
  })
  const unverified = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 40, y: 25, z: 33 },
    tunnel,
    descent: [],
  })
  const pass =
    decision.plan?.kind === 'reuse' &&
    decision.plan.tunnel.x === 40 &&
    decision.plan.clear === undefined &&
    decision.tunnelRefusal === null &&
    unverified?.kind === 'reuse'
  return { pass, detail: JSON.stringify(decision) }
})

addCase('an undiggable entry with no alternate refuses as no_clearance and the exact marker fires', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const tunnel = { x: 40, y: 30, z: 33 }
  const decision = planVerticalApproachDetailed({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 40, y: 25, z: 33 },
    tunnel,
    descent: [],
    tunnelEntry: {
      cell: tunnel,
      bodyClear: true,
      headClear: false,
      supportSolid: true,
      blocker: blockedBy({ x: 40, y: 31, z: 33 }, 'bedrock', false),
    },
  })
  const enter = evaluateTunnelEntry({ cell: tunnel, bodyClear: true, headClear: true, supportSolid: true })
  const marker = formatTunnelEntryRefused({ reason: 'no_clearance', cell: { x: 40, y: 31, z: 33 } })
  const pass =
    decision.tunnelRefusal?.reason === 'no_clearance' &&
    decision.tunnelRefusal.cell.y === 31 &&
    decision.plan === null &&
    enter.kind === 'enterable' &&
    marker === 'TUNNEL_ENTRY_REFUSED reason=no_clearance cell=40,31,33'
  return { pass, detail: `refusal=${JSON.stringify(decision.tunnelRefusal)} enter=${enter.kind} marker=${marker}` }
})

addCase('the LOCAL_CLEAR marker carries the cell, block, tool and tier', () => {
  const line = formatLocalClear({ x: 32, y: 35, z: 35 }, 'cobblestone', 'pickaxe', 1)
  const hand = formatLocalClear({ x: 1, y: 2, z: 3 }, 'dirt', null, null)
  const pass =
    line === 'LOCAL_CLEAR cell=32,35,35 block=cobblestone tool=pickaxe tier=1' &&
    hand === 'LOCAL_CLEAR cell=1,2,3 block=dirt tool=hand tier=0'
  return { pass, detail: `${line} | ${hand}` }
})

addCase('a reuse retrieval candidate carries the no-tunnel fallback vertical plan', () => {
  const feet = { x: 28, y: 57, z: 35 }
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', dimension: 'minecraft:overworld', position: { x: 25, y: 49, z: 36 } }
  const state = worldState({
    position: feet,
    goalQueue: queueWith(queuedGoal({})),
    signals: signals({ knownResources: [known], lastTunnel: { x: 27, y: 53, z: 35 } }),
    descent: [downStep('W', -1, 0, feet)],
  })
  const retrieve = retrieveOf(generateCandidates(state, defaultCandidateOptions))
  const pass =
    retrieve !== null &&
    retrieve.meta.vertical === 'reuse' &&
    retrieve.meta.fallbackVertical === 'staircase' &&
    retrieve.meta.fallbackStairDigY === 56 &&
    retrieve.meta.tunnelClearX === undefined
  return { pass, detail: retrieve === null ? 'no RETRIEVE' : JSON.stringify(retrieve.meta) }
})

addCase('the safe_column fact: a clearable column with the held tool is satisfied', () => {
  const feet = { x: 31, y: 34, z: 37 }
  const cut: StepCut = {
    dir: 'E',
    dx: 1,
    dz: 0,
    cut: { x: 32, y: 35, z: 37 },
    step: { x: 32, y: 35, z: 37 },
    name: 'cobblestone',
    safe: true,
    reason: 'safe',
  }
  const decision = evaluateAscentColumn({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 32, y: 63, z: 37 },
    stepCuts: [cut],
    standable: [feet],
    inventory: inventory({ stone_pickaxe: 1 }).counts,
  })
  return {
    pass:
      decision.kind === 'clearable' &&
      decision.cell.x === 32 &&
      decision.cell.y === 35 &&
      decision.blocker.name === 'cobblestone' &&
      decision.blocker.toolOk &&
      decision.blocker.requiredTool === 'pickaxe',
    detail: JSON.stringify(decision),
  }
})

addCase('the safe_column fact: clearable geometry without the tool refuses as no_tool', () => {
  const feet = { x: 31, y: 34, z: 37 }
  const cut: StepCut = {
    dir: 'E',
    dx: 1,
    dz: 0,
    cut: { x: 32, y: 35, z: 37 },
    step: { x: 32, y: 35, z: 37 },
    name: 'cobblestone',
    safe: true,
    reason: 'safe',
  }
  const decision = evaluateAscentColumn({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 32, y: 63, z: 37 },
    stepCuts: [cut],
    standable: [feet],
    inventory: inventory({}).counts,
  })
  return {
    pass:
      decision.kind === 'refuse' &&
      decision.reason === 'no_tool' &&
      decision.cell.x === 32 &&
      decision.blocker?.requiredTool === 'pickaxe' &&
      decision.blocker?.requiredTier === 0,
    detail: JSON.stringify(decision),
  }
})

addCase('the safe_column fact: an unsafe cut names no_clearance at the cut cell', () => {
  const feet = { x: 31, y: 34, z: 37 }
  const cut: StepCut = {
    dir: 'N',
    dx: 0,
    dz: -1,
    cut: { x: 31, y: 35, z: 36 },
    step: { x: 31, y: 35, z: 36 },
    name: 'cobblestone',
    safe: false,
    reason: 'no solid landing under the cut',
  }
  const decision = evaluateAscentColumn({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 31, y: 63, z: 30 },
    stepCuts: [cut],
    standable: [feet],
    inventory: inventory({ stone_pickaxe: 1 }).counts,
  })
  return {
    pass: decision.kind === 'refuse' && decision.reason === 'no_clearance' && decision.cell.z === 36,
    detail: JSON.stringify(decision),
  }
})

addCase('the safe_column fact: a standable cell one level up is a clear column', () => {
  const feet = { x: 31, y: 34, z: 37 }
  const decision = evaluateAscentColumn({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 40, y: 63, z: 37 },
    stepCuts: [],
    standable: [feet, { x: 32, y: 35, z: 37 }],
    inventory: inventory({}).counts,
  })
  return {
    pass: decision.kind === 'clear' && decision.cell.x === 32 && decision.cell.y === 35,
    detail: JSON.stringify(decision),
  }
})

addCase('the safe_column fact: no geometry names the target-aligned cardinal cell', () => {
  const feet = { x: 31, y: 34, z: 37 }
  const decision = evaluateAscentColumn({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 31, y: 63, z: 30 },
    stepCuts: [],
    standable: [feet],
    inventory: inventory({}).counts,
  })
  return {
    pass:
      decision.kind === 'refuse' &&
      decision.reason === 'no_clearance' &&
      decision.cell.x === 31 &&
      decision.cell.y === 35 &&
      decision.cell.z === 36 &&
      decision.blocker === null,
    detail: JSON.stringify(decision),
  }
})

addCase('the safe_column fact: a hazard next to a clear cell disqualifies the column', () => {
  const feet = { x: 31, y: 34, z: 37 }
  const decision = evaluateAscentColumn({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 32, y: 63, z: 37 },
    stepCuts: [],
    standable: [feet, { x: 32, y: 35, z: 37 }],
    hazards: [{ x: 32, y: 36, z: 37 }],
    inventory: inventory({}).counts,
  })
  return {
    pass: decision.kind === 'refuse' && decision.reason === 'no_clearance' && decision.cell.x === 32,
    detail: JSON.stringify(decision),
  }
})

addCase('the safe_column fact: a shovel/axe cut still clears by hand (no false no_tool)', () => {
  const feet = { x: 31, y: 34, z: 37 }
  const cut: StepCut = {
    dir: 'E',
    dx: 1,
    dz: 0,
    cut: { x: 32, y: 35, z: 37 },
    step: { x: 32, y: 35, z: 37 },
    name: 'dirt',
    safe: true,
    reason: 'safe',
  }
  const decision = evaluateAscentColumn({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 32, y: 63, z: 37 },
    stepCuts: [cut],
    standable: [feet],
    inventory: inventory({}).counts,
  })
  return {
    pass: decision.kind === 'clearable' && decision.blocker.toolOk,
    detail: JSON.stringify(decision),
  }
})

let failures = 0
process.stdout.write('issue #45 - retrieval vertical plan and stall escalation\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} vertical-plan cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
