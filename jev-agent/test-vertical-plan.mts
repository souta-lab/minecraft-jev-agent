// test-vertical-plan.mts - issue #45 unit proof for the retrieval vertical leg
// and the stall escalation. No bot, no network.
//
// Run: npx tsx test-vertical-plan.mts
import { defaultCandidateOptions, generateCandidates } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { guardCandidate } from './src/policy.ts'
import type { GuardContext } from './src/policy.ts'
import {
  ASCENT_PROGRESS_EPSILON,
  evaluatePillarStep,
  evaluateRetrievalProgress,
  formatAscentProgress,
  PILLAR_UP_STEP_CAP,
  pillarColumnUnsafeFromBlocks,
  planVerticalApproach,
  resolvePillarStep,
} from './src/verticalPlan.ts'
import type { RetrievalProgressState } from './src/verticalPlan.ts'
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
function upCut(dir: StepCut['dir'], dx: number, dz: number, feet: Vec3Json): StepCut {
  const cut = { x: feet.x + dx, y: feet.y + 1, z: feet.z + dz }
  return { dir, dx, dz, cut, step: cut, name: 'cobblestone', safe: true, reason: 'safe' }
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

// --- candidate wiring -----------------------------------------------------------

addCase('a below-level remembered ore emits a staircase retrieval candidate', () => {
  const feet = { x: 28, y: 57, z: 35 }
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 40, y: 49, z: 0 } }
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
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 25, y: 49, z: 36 } }
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
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 53, y: 36, z: 33 } }
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
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 43, y: 40, z: 33 } }
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
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 53, y: 36, z: 33 } }
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
    retrieve.meta.verticalToY === 36
  return { pass, detail: retrieve === null ? 'no RETRIEVE' : JSON.stringify(retrieve.meta) }
})

// --- guard grounding ------------------------------------------------------------

addCase('the guard accepts a staircase retrieval grounded in the descent options', () => {
  const feet = { x: 28, y: 57, z: 35 }
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 40, y: 49, z: 0 } }
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
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 40, y: 49, z: 0 } }
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
