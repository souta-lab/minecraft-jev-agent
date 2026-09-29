/**
 * Sealed-pocket escape affordance — regression for the measured portal-p10
 * wedge: a body at y56 in a self-dug stone pocket, inventory `{"gravel":1}`,
 * goals `goto`/`explore`/`descend`, offered nothing but WAIT/ESCALATE for
 * ~25 minutes (`NO_PRODUCTIVE_CANDIDATE` x27, `STALLED` x2). The only physical
 * route left is a clearance staircase dig — which `ascentRouteTo` already
 * plans (`staircase-up` needs no tool; a pickaxe only speeds it) — but the
 * ascent arm only ran under `kind === 'surface'` goals, so a sealed body
 * under any other goal kind never saw it.
 *
 * Fixture contract (the measured shape):
 *   - body below the surface band (y < 63), dimension overworld;
 *   - no locomotion route at all (standable = own cell only, no descent,
 *     no explored/known cells, no entities to chase);
 *   - the sensor DOES see a safe step cut (stone at head level, east) —
 *     `stepCuts` is the same primitive the down-staircase uses;
 *   - a non-`surface` goal is active (a `goto` row, as measured).
 *
 * Expectations:
 *   1. an `ASCEND:escape:*` MOVE is offered once the scheduler's own stall
 *      boundary is crossed (stalledMs >= 25 s — the staircase-up CAN envelope);
 *   2. a transient candidate-starved tick (stalledMs < boundary) gets no offer;
 *   3. the same stalled sealed body above the surface band gets no offer;
 *   4. a stalled body with any locomotion route gets no offer;
 *   5. a stalled sealed body with no safe step cut falls through silently.
 */

import { defaultCandidateOptions, generateGroundedCandidates } from '../jev-agent/src/candidates.ts'
import type { CandidateOptions } from '../jev-agent/src/candidates.ts'
import type { AgentSignals, InventoryState, SelfState, StepCut, Vec3Json, WorldState } from '../jev-agent/src/state.ts'
import type { GoalQueueState, QueuedGoal } from '../jev-agent/src/goalQueue.ts'

const OVERWORLD = 'minecraft:overworld'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}
const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

/** The measured p10 pocket cell. */
const FEET: Vec3Json = { x: 3240, y: 56, z: 2825 }
/** The head-level stone wall one step east — dig it, stand on it. */
const EAST_CUT: StepCut = {
  dir: 'E',
  dx: 1,
  dz: 0,
  cut: { x: FEET.x + 1, y: FEET.y + 1, z: FEET.z },
  step: { x: FEET.x + 1, y: FEET.y + 1, z: FEET.z },
  name: 'stone',
  safe: true,
  reason: 'safe',
}

function inventory(counts: Record<string, number>): InventoryState {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0) }
}

function self(position: Vec3Json, dimension: string = OVERWORLD): SelfState {
  return {
    username: 'AI_DOM',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension,
    isDay: true,
    heldItem: null,
  }
}

function signals(stalledMs: number = 0): AgentSignals {
  return {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastPathStatus: 'idle',
    stalledMs,
    lastPolicyConfidence: null,
    maxConcurrentActions: 0,
    escalationRecommended: false,
    failedCandidates: {},
    knownResources: [],
  }
}

function gotoGoal(): QueuedGoal {
  return {
    id: 'g31:goto:oak_log',
    kind: 'goto',
    description: 'reach the nearest known oak_log',
    targetItem: 'oak_log',
    requiredCount: 1,
    targetY: null,
    dimension: OVERWORLD,
    status: 'active',
    startCount: 0,
    haveCount: 0,
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function queueWith(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

function sealedWorld(overrides: Partial<WorldState> = {}): WorldState {
  return {
    schemaVersion: 1,
    tick: 11,
    timestampMs: 1_790_000_000_000,
    self: self(FEET),
    inventory: inventory({ gravel: 1 }),
    entities: [],
    blocks: [],
    terrain: { standable: [FEET] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: [],
    stepCuts: [EAST_CUT],
    headroomCuts: [],
    goal: {
      id: 'g31:goto:oak_log',
      description: 'reach the nearest known oak_log',
      targetItem: 'oak_log',
      requiredCount: 1,
      startCount: 0,
      haveCount: 0,
      progress: 0,
      complete: false,
      startedAtMs: 0,
    },
    goalQueue: queueWith(gotoGoal()),
    recentEvents: [],
    // The measured wedge stalled for ~25 min; use a comfortably-boundary-
    // crossing value so the case keys on geometry, not the threshold edge.
    signals: signals(120_000),
    ...overrides,
  }
}

function escapeOffers(world: WorldState): string[] {
  const options: CandidateOptions = { ...defaultCandidateOptions, reach: 4.5 }
  const grounded = generateGroundedCandidates(world, options)
  return grounded.candidates.filter((candidate) => candidate.id.startsWith('ASCEND:escape:')).map((candidate) => candidate.id)
}

addCase('(p10) a stalled sealed body under a goto goal is offered a staircase-up escape', () => {
  const offers = escapeOffers(sealedWorld())
  // The id is keyed on the escape CONTEXT (own cell), so a re-planned step
  // cell cannot churn the chosen id out of the offer (portal-p13 vanish).
  const pass = offers.length === 1 && offers[0] === `ASCEND:escape:p${FEET.x}_${FEET.y}_${FEET.z}`
  return { pass, detail: `offers=[${offers.join(',')}]` }
})

addCase('(p13) a re-planned step cut keeps the SAME escape id (vanish regression)', () => {
  // The vertical planner may pick a different cut each tick; the offered id
  // must stay constant or the freshness guard drops the chosen escape.
  const north: StepCut = {
    dir: 'N',
    dx: 0,
    dz: -1,
    cut: { x: FEET.x, y: FEET.y + 1, z: FEET.z - 1 },
    step: { x: FEET.x, y: FEET.y + 1, z: FEET.z - 1 },
    name: 'stone',
    safe: true,
    reason: 'safe',
  }
  const east = escapeOffers(sealedWorld())
  const northOffers = escapeOffers(sealedWorld({ stepCuts: [north] }))
  const pass = east.length === 1 && northOffers.length === 1 && east[0] === northOffers[0]
  return { pass, detail: `east=[${east.join(',')}] north=[${northOffers.join(',')}]` }
})

addCase('(p10) a transient empty tick below the stall boundary gets no escape offer', () => {
  const offers = escapeOffers(sealedWorld({ signals: signals(0) }))
  return { pass: offers.length === 0, detail: `offers=[${offers.join(',')}]` }
})

addCase('(p10) a stalled sealed body AT/above the surface band gets no escape offer', () => {
  const surface = { x: FEET.x, y: 64, z: FEET.z }
  const offers = escapeOffers(
    sealedWorld({
      self: self(surface),
      terrain: { standable: [surface] },
      stepCuts: [{ ...EAST_CUT, cut: { x: surface.x + 1, y: surface.y + 1, z: surface.z }, step: { x: surface.x + 1, y: surface.y + 1, z: surface.z } }],
    }),
  )
  return { pass: offers.length === 0, detail: `offers=[${offers.join(',')}]` }
})

addCase('(p10) a stalled body with a walking route never sees the escape offer displace it', () => {
  const next = { x: FEET.x + 2, y: FEET.y, z: FEET.z }
  const offers = escapeOffers(sealedWorld({ terrain: { standable: [FEET, next] } }))
  return { pass: offers.length === 0, detail: `offers=[${offers.join(',')}]` }
})

addCase('(p10) a stalled sealed body with no safe step cut falls through silently (typed refusal elsewhere)', () => {
  const offers = escapeOffers(sealedWorld({ stepCuts: [{ ...EAST_CUT, safe: false, reason: 'lava/water in the step column' }] }))
  return { pass: offers.length === 0, detail: `offers=[${offers.join(',')}]` }
})

let failed = 0
for (const testCase of cases) {
  const { pass, detail } = testCase.run()
  if (!pass) failed += 1
  console.log(`${pass ? 'PASS' : 'FAIL'} ${testCase.name} :: ${detail}`)
}
if (failed > 0) process.exit(1)
console.log(`${cases.length}/${cases.length} sealed-pocket cases passed`)
