// step-pipeline-test.mts - deterministic proof of the B2 STEP pipeline wiring:
// a safe step cut is emitted as a candidate when a MOVE is blocked, the guard
// accepts it, and a stale/absent cut is rejected.
//
// Run: bun data/step-pipeline-test.mts
import {
  emptyGoalQueueState,
  generateCandidates,
  guardCandidate,
  makeGoal,
} from '../src/index.ts'
import type { AgentSignals, Candidate, WorldState } from '../src/index.ts'

const signals: AgentSignals = {
  consecutiveFailures: 0,
  lastFailureCode: null,
  lastPathStatus: 'idle',
  stalledMs: 0,
  lastPolicyConfidence: null,
  maxConcurrentActions: 1,
  escalationRecommended: false,
  failedCandidates: {},
}

const state: WorldState = {
  schemaVersion: 1,
  tick: 1,
  timestampMs: Date.now(),
  self: {
    username: 't',
    position: { x: 0, y: 64, z: 0 },
    eyePosition: { x: 0, y: 65.62, z: 0 },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'overworld',
    isDay: true,
    heldItem: null,
  },
  inventory: { slots: [], counts: {}, totalItems: 0 },
  entities: [],
  blocks: [
    {
      kind: 'log',
      name: 'oak_log',
      position: { x: 10, y: 64, z: 0 },
      distance: 10,
      diggable: true,
      inReach: false,
      hasAdjacentStandable: true,
      adjacentStandable: { x: 9, y: 64, z: 0 },
      yield: 'oak_log',
      harvestTool: null,
      harvestTier: null,
      visible: true,
    },
  ],
  terrain: { standable: [] },
  craftingTables: [],
  placementSpots: [],
  descent: [],
  stepCuts: [
    { dir: 'E', dx: 1, dz: 0, cut: { x: 1, y: 65, z: 0 }, step: { x: 1, y: 65, z: 0 }, name: 'dirt', safe: true, reason: 'safe' },
  ],
  goal: makeGoal('oak_log', 3),
  goalQueue: emptyGoalQueueState(),
  recentEvents: [],
  signals,
}

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const candidates = generateCandidates(state, {
  reach: 4.5,
  maxMineCandidates: 12,
  maxAttackCandidates: 4,
  eatBelowFood: 18,
  recipes: null,
})
const step = candidates.find((candidate) => candidate.kind === 'STEP')
check(
  'a blocked MOVE alongside a safe step cut emits a STEP candidate',
  candidates.some((candidate) => candidate.kind === 'MOVE') && step !== undefined,
  `ids=[${candidates.map((candidate) => candidate.id).join(', ')}]`,
)

const ids = new Set(candidates.map((candidate) => candidate.id))
const context = {
  phase: 'decision' as const,
  candidateIds: ids,
  inFlight: null,
  reach: 4.5,
  maxCandidateAgeTicks: 20,
  canComputePath: null,
}
if (step !== undefined) {
  const accepted = guardCandidate(step, state, context)
  check(
    'the guard accepts a fresh safe stair-cut',
    accepted.ok,
    accepted.ok ? `accepted ${step.id}` : `${accepted.code}: ${accepted.reason}`,
  )
}

const stale: Candidate = {
  id: 'STEP:E:b99_65_0',
  kind: 'STEP',
  label: 'stale cut',
  targetName: 'dirt',
  target: { x: 99, y: 65, z: 0 },
  targetEntityId: null,
  itemName: null,
  requiresTool: false,
  toolName: null,
  inReach: true,
  hasStandableAdjacent: true,
  meta: { tick: 1, x: 99, y: 65, z: 0, diggable: true },
}
const rejected = guardCandidate(stale, state, { ...context, candidateIds: new Set([...ids, stale.id]) })
check(
  'the guard rejects a stair-cut whose face block is gone',
  !rejected.ok && rejected.code === 'TARGET_GONE',
  rejected.ok ? 'unexpectedly accepted' : `${rejected.code}: ${rejected.reason}`,
)

const firstCut = state.stepCuts === undefined ? undefined : state.stepCuts[0]
const unsafeState: WorldState = {
  ...state,
  stepCuts:
    firstCut === undefined
      ? []
      : [{ ...firstCut, safe: false, reason: 'lava/water in the step column' }],
}
if (step !== undefined) {
  const unsafe = guardCandidate(step, unsafeState, context)
  check(
    'the guard rejects an unsafe stair-cut (hazard in the column)',
    !unsafe.ok && unsafe.code === 'NO_SUPPORT',
    unsafe.ok ? 'unexpectedly accepted' : `${unsafe.code}: ${unsafe.reason}`,
  )
}

const descendState: WorldState = {
  ...state,
  stepCuts: [],
  descent: [
    {
      dir: 'E',
      mode: 'down',
      dx: 1,
      dz: 0,
      step: { x: 1, y: 63, z: 0 },
      wall: { x: 1, y: 64, z: 0 },
      head: { x: 1, y: 65, z: 0 },
      floor: { x: 1, y: 63, z: 0 },
      wallSolid: true,
      headSolid: true,
      floorSolid: true,
      safe: true,
      reason: 'safe',
    },
  ],
}
const descend: Candidate = {
  id: 'DESCEND:down:E:b1_63_0',
  kind: 'DESCEND',
  label: 'dig a staircase step down',
  targetName: 'cobblestone',
  target: { x: 1, y: 63, z: 0 },
  targetEntityId: null,
  itemName: null,
  requiresTool: false,
  toolName: null,
  inReach: true,
  hasStandableAdjacent: true,
  meta: { tick: 1, mode: 'down', dir: 'E' },
}
const descendOk = guardCandidate(descend, descendState, {
  ...context,
  candidateIds: new Set([descend.id]),
})
check(
  'the guard accepts a DESCEND whose terrain dig cell is in the sensor descent list',
  descendOk.ok,
  descendOk.ok ? `accepted ${descend.id}` : `${descendOk.code}: ${descendOk.reason}`,
)
const descendGone = guardCandidate(descend, { ...descendState, descent: [] }, {
  ...context,
  candidateIds: new Set([descend.id]),
})
check(
  'the guard rejects a DESCEND whose step disappeared (terrain moved)',
  !descendGone.ok && descendGone.code === 'TARGET_GONE',
  descendGone.ok ? 'unexpectedly accepted' : `${descendGone.code}: ${descendGone.reason}`,
)

process.stdout.write(`\n${6 - failures}/6 step-pipeline cases passed\n`)
process.exit(failures === 0 ? 0 : 1)
