// test-candidate-unreachable-affordance.mts
//
// RED-first regression for the CANDIDATE_GENERATION boundary on main 928601f
// (run-mu98ondr-192ql). Placing the M2 furnace, the generator withheld the
// placement approach with:
//   REACHABILITY candidate=MOVE:p56_60_24 reachable=false reason=no_path missing=[open_path]
//   CANDIDATE_WITHHELD reason=no_path candidate=MOVE:p56_60_24
//   CANDIDATE_STARVATION goal=place:furnace:1 presented=2 productive=0
// The capability-acquisition pass had arms for `headroom`/`tool`/`descend_plan`
// but none for `open_path`, so the policy only ever saw WAIT/ESCALATE. This suite
// proves an `open_path` refusal now enumerates the existing generic route-opening
// affordance (STEP face cut), and that code does not select it: WAIT stays on the
// table and no candidate is marked chosen.
//
// Run: npx tsx test-candidate-unreachable-affordance.mts
import { applyReachabilityGate, defaultCandidateOptions } from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import { capabilityKey } from './src/reachability.ts'
import type {
  AgentSignals,
  BlockState,
  GoalState,
  InventoryState,
  SelfState,
  StepCut,
  Vec3Json,
  WorldState,
} from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_AFFORD',
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

function queuedGoal(overrides: Partial<QueuedGoal> = {}): QueuedGoal {
  return {
    id: 'g1',
    kind: 'place',
    description: 'place 1 x furnace',
    targetItem: 'furnace',
    requiredCount: 1,
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
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

function goal(): GoalState {
  return {
    id: 'place:furnace',
    description: 'place 1 x furnace',
    targetItem: 'furnace',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function worldState(overrides: {
  position: Vec3Json
  stepCuts: StepCut[]
  blocks: BlockState[]
  standable: Vec3Json[]
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 41,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position),
    inventory: inventory({ furnace: 1 }),
    entities: [],
    blocks: overrides.blocks,
    terrain: { standable: overrides.standable },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: [],
    stepCuts: overrides.stepCuts,
    headroomCuts: [],
    goal: goal(),
    goalQueue: queueWith(queuedGoal()),
    recentEvents: [],
    signals: signals(),
  }
}

const FACE_CUT: StepCut = {
  dir: 'E',
  dx: 1,
  dz: 0,
  cut: { x: 55, y: 61, z: 26 },
  step: { x: 55, y: 61, z: 26 },
  name: 'dirt',
  safe: true,
  reason: 'safe',
}

const CUT_BLOCK: BlockState = {
  kind: 'stone',
  name: 'dirt',
  position: FACE_CUT.cut,
  distance: 1,
  diggable: true,
  inReach: true,
  hasAdjacentStandable: true,
  adjacentStandable: FACE_CUT.step,
  yield: 'dirt',
  harvestTool: null,
  harvestTier: null,
}

const APPROACH_MOVE: Candidate = {
  id: 'MOVE:p56_60_24',
  kind: 'MOVE',
  label: 'walk to the furnace placement stand (56,60,24)',
  targetName: null,
  target: { x: 56, y: 60, z: 24 },
  targetEntityId: null,
  itemName: null,
  requiresTool: false,
  toolName: null,
  inReach: false,
  hasStandableAdjacent: true,
  meta: { tick: 41, x: 56, y: 60, z: 24 },
}

const WAIT_CANDIDATE: Candidate = {
  id: 'WAIT',
  kind: 'WAIT',
  label: 'do nothing for one tick',
  targetName: null,
  target: null,
  targetEntityId: null,
  itemName: null,
  requiresTool: false,
  toolName: null,
  inReach: true,
  hasStandableAdjacent: true,
  meta: { tick: 41, waitMs: 300 },
}

const state = worldState({
  position: { x: 54.5, y: 61, z: 26.4 },
  standable: [{ x: 54, y: 61, z: 26 }],
  stepCuts: [FACE_CUT],
  blocks: [CUT_BLOCK],
})

const options: CandidateOptions = {
  ...defaultCandidateOptions,
  reachability: { memory: null, pathProbe: () => 'no_path' },
}
const grounded = applyReachabilityGate([APPROACH_MOVE, WAIT_CANDIDATE], state, options)

const withheld = grounded.withheld.find((entry) => entry.candidate.id === APPROACH_MOVE.id)
const productive = grounded.candidates.filter(
  (candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE',
)
const recovery = productive.find((candidate) => candidate.kind === 'STEP')
const hasWait = grounded.candidates.some((candidate) => candidate.kind === 'WAIT')

check(
  '(1) the placement approach MOVE is withheld as no_path with missing=[open_path]',
  withheld !== undefined &&
    withheld.result.reason === 'no_path' &&
    withheld.result.missingCapabilities.map(capabilityKey).join(',') === 'open_path',
  withheld === undefined
    ? `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`
    : `reason=${withheld.result.reason} missing=[${withheld.result.missingCapabilities.map(capabilityKey).join(',')}]`,
)

check(
  '(2) an open_path refusal offers the generic route-opening STEP cut (not only WAIT/ESCALATE)',
  recovery !== undefined &&
    recovery.meta.capabilityAcquisition === true &&
    recovery.meta.missingCapability === 'open_path',
  `productive=[${productive.map((candidate) => candidate.id).join(',')}] recovery=${recovery?.id ?? 'none'}`,
)

check(
  '(3) code does not select it: the recovery is offered alongside WAIT with no chosen marker',
  recovery !== undefined &&
    hasWait &&
    grounded.candidates.every(
      (candidate) => candidate.meta.selected !== true && candidate.meta.autoInserted !== true,
    ),
  `candidates=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
)

process.stdout.write(
  failures === 0
    ? '\nAll unreachable-affordance checks passed.\n'
    : `\n${failures} check(s) failed.\n`,
)
process.exit(failures === 0 ? 0 : 1)
