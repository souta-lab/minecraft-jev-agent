// test-candidate-recovery.mts - CANDIDATE_GENERATION defect (frozen run
// run-mu98ondr-192ql, RC_SHA 928601f).
//
// Boundary = `place:furnace` reachability recovery. The run had furnace=1,
// iron_ingot=3, iron_pickaxe=1 and `OPTION_COMPILE emitted place:furnace`; the
// next evidence was
//   REACHABILITY candidate=MOVE:p56_60_24 reachable=false reason=no_path missing=[open_path]
//   CANDIDATE_WITHHELD
//   CANDIDATE_STARVATION goal=place:furnace:1 presented=2 productive=0
// and NO generic open_path / dig / recovery candidate was offered, so the only
// mechanically-valid choices were WAIT / ESCALATE.
//
// The gate's capability-acquisition pass already turns a withheld target into
// grounded enabling candidates for `headroom`, `tool` and `descend_plan`. It had
// no arm for `open_path` / `standable_approach`, so a locomotion target refused
// for `no_path`/`no_standable_approach` contributed NOTHING. This suite proves
// the existing generic route-opening family (STEP / DESCEND / explore-MOVE) is
// now enumerated for that refusal, without item/coordinate/portal special-casing
// and without any deterministic selection: the candidates are facts the model
// still chooses between.
//
// Pure: no bot, no network, no model.
//
// Run: npx tsx test-candidate-recovery.mts  (wired as `npm run candidate-recovery-test`)
import { applyReachabilityGate, defaultCandidateOptions } from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { capabilityKey } from './src/reachability.ts'
import type { DescentOption, GoalState, InventoryState, StepCut, Vec3Json, WorldState } from './src/state.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

// --- world builders ------------------------------------------------------------

const BOT: Vec3Json = { x: 0.5, y: 60, z: 0.5 }
/** The unreachable MOVE destination, mirroring the live `MOVE:p56_60_24`. */
const OPEN_TARGET: Vec3Json = { x: 12, y: 60, z: 12 }
/** A standable frontier the bot can actually reach (an approach fact). */
const FRONTIER: Vec3Json = { x: 3, y: 60, z: 0 }

function self(position: Vec3Json): WorldState['self'] {
  return {
    username: 'AI_RECOVERY',
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

function goal(targetItem: string): GoalState {
  return {
    id: `goal:${targetItem}`,
    description: `place ${targetItem}`,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(targetItem: string, kind: QueuedGoal['kind']): QueuedGoal {
  return {
    id: `g-${targetItem}`,
    kind,
    description: `place 1 x ${targetItem}`,
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

function queueWith(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

function worldState(overrides: {
  blocks?: WorldState['blocks']
  inventory?: InventoryState
  goal: GoalState
  goalQueue: GoalQueueState
  standable?: Vec3Json[]
  stepCuts?: StepCut[]
  descent?: DescentOption[]
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(BOT),
    inventory: overrides.inventory ?? inventory({}),
    entities: [],
    blocks: overrides.blocks ?? [],
    terrain: { standable: overrides.standable ?? [BOT, FRONTIER] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: overrides.descent ?? [],
    stepCuts: overrides.stepCuts ?? [],
    headroomCuts: [],
    goal: overrides.goal,
    goalQueue: overrides.goalQueue,
    recentEvents: [],
    signals: {
      consecutiveFailures: 0,
      lastFailureCode: null,
      lastPathStatus: 'idle',
      stalledMs: 0,
      lastPolicyConfidence: null,
      maxConcurrentActions: 0,
      escalationRecommended: false,
      failedCandidates: {},
      knownResources: [],
    },
  }
}

function waitCandidate(tick: number): Candidate {
  return {
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
    meta: { tick, waitMs: 300 },
  }
}

/** A standable MOVE whose own destination has no path (the live starvation shape). */
function unreachableMove(tick: number): Candidate {
  return {
    id: `MOVE:p${OPEN_TARGET.x}_${OPEN_TARGET.y}_${OPEN_TARGET.z}`,
    kind: 'MOVE',
    label: 'walk to the unreachable station',
    targetName: null,
    target: OPEN_TARGET,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: { tick },
  }
}

/** `no_path` for the withheld target only; the frontier stays reachable. */
const pathProbe = (position: Vec3Json): 'no_path' | 'reachable' =>
  position.x === OPEN_TARGET.x && position.z === OPEN_TARGET.z ? 'no_path' : 'reachable'

function optionsWith(): CandidateOptions {
  return { ...defaultCandidateOptions, reachability: { memory: null, pathProbe } }
}

const isProductive = (candidate: Candidate): boolean =>
  candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE'

const selectionKeys = ['priority', 'rank', 'order', 'selected', 'chosen', 'forced', 'deterministic', 'override']

function safeStepCut(): StepCut {
  return {
    dir: 'E',
    dx: 1,
    dz: 0,
    cut: { x: 1, y: 61, z: 0 },
    step: { x: 1, y: 61, z: 0 },
    name: 'dirt',
    safe: true,
    reason: 'safe',
  }
}

function downDescent(): DescentOption {
  return {
    dir: 'N',
    mode: 'down',
    dx: 0,
    dz: -1,
    step: { x: 0, y: 59, z: -1 },
    wall: { x: 0, y: 60, z: -1 },
    head: { x: 0, y: 61, z: -1 },
    floor: { x: 0, y: 59, z: -1 },
    wallSolid: true,
    headSolid: false,
    floorSolid: true,
    safe: true,
    reason: 'safe',
    digName: 'dirt',
    digHarvestTool: null,
    digHarvestTier: null,
    diggable: true,
  }
}

function main(): void {
  process.stdout.write('candidate recovery: an unreachable locomotion target still yields route-opening facts\n')
  process.stdout.write('-'.repeat(78) + '\n')

  const placeGoalState = worldState({
    goal: goal('furnace'),
    goalQueue: queueWith(queuedGoal('furnace', 'place')),
    stepCuts: [safeStepCut()],
  })

  // (a) RED on 928601f: open_path contributed no enabling candidates, so the
  // only family on offer was WAIT. The generic STEP + explore-MOVE must appear.
  {
    const grounded = applyReachabilityGate(
      [waitCandidate(placeGoalState.tick), unreachableMove(placeGoalState.tick)],
      placeGoalState,
      optionsWith(),
    )
    const withheld = grounded.withheld.find((entry) => entry.candidate.id === unreachableMove(placeGoalState.tick).id)
    const productive = grounded.candidates.filter(isProductive)
    const acquisitions = productive.filter((candidate) => candidate.meta.capabilityAcquisition === true)
    const step = acquisitions.find((candidate) => candidate.kind === 'STEP')
    const recoveryMove = acquisitions.find((candidate) => candidate.kind === 'MOVE')

    check(
      '(a) the unreachable MOVE is withdrawn for no_path with [open_path]',
      withheld !== undefined &&
        withheld.result.reason === 'no_path' &&
        withheld.result.missingCapabilities.map(capabilityKey).join(',') === 'open_path',
      `withheld=${withheld?.result.reason ?? 'none'} missing=[${(withheld?.result.missingCapabilities ?? []).map(capabilityKey).join(',')}]`,
    )
    check(
      '(a) route-opening candidates are presented instead of a barren WAIT-only set',
      productive.length >= 2 && step !== undefined && recoveryMove !== undefined,
      `productive=[${productive.map((candidate) => candidate.id).join(',')}]`,
    )
    check(
      '(a) every recovery candidate is tagged as an open_path acquisition',
      acquisitions.length >= 2 &&
        acquisitions.every((candidate) => candidate.meta.missingCapability === 'open_path'),
      `acquisitions=[${acquisitions.map((candidate) => `${candidate.id}:${String(candidate.meta.missingCapability)}`).join(',')}]`,
    )
    check(
      '(a) the withheld target itself is still NOT presented (truth preserved)',
      grounded.candidates.every((candidate) => candidate.id !== unreachableMove(placeGoalState.tick).id),
      `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
    )
  }

  // (b) Authority: the gate enumerates facts, it does not pick. The recovery
  // candidates carry no selection/priority/ranking metadata, and more than one
  // mechanically-valid option survives for the model to choose between.
  {
    const grounded = applyReachabilityGate(
      [waitCandidate(placeGoalState.tick), unreachableMove(placeGoalState.tick)],
      placeGoalState,
      optionsWith(),
    )
    const acquisitions = grounded.candidates.filter(
      (candidate) => candidate.meta.capabilityAcquisition === true,
    )
    const kinds = new Set(acquisitions.map((candidate) => candidate.kind))
    const carriesSelection = acquisitions.some((candidate) =>
      selectionKeys.some((key) => candidate.meta[key] !== undefined),
    )
    check(
      '(b) no deterministic selection/priority/ranking is injected into the recovery facts',
      acquisitions.length > 0 && !carriesSelection,
      `selectionKeys=${selectionKeys.filter((key) => acquisitions.some((candidate) => candidate.meta[key] !== undefined)).join(',') || 'none'}`,
    )
    check(
      '(b) more than one candidate family remains, so the model still selects',
      kinds.size >= 2,
      `families=[${[...kinds].join(',')}]`,
    )
  }

  // (c) Generic: the same arm exposes the DESCEND family for a collect goal with
  // a proven safe down step. No item/coordinate special-casing.
  {
    const collect = worldState({
      goal: goal('cobblestone'),
      goalQueue: queueWith(queuedGoal('cobblestone', 'collect')),
      descent: [downDescent()],
    })
    const grounded = applyReachabilityGate(
      [waitCandidate(collect.tick), unreachableMove(collect.tick)],
      collect,
      optionsWith(),
    )
    const descend = grounded.candidates.find(
      (candidate) => candidate.kind === 'DESCEND' && candidate.meta.capabilityAcquisition === true,
    )
    check(
      '(c) a collect goal with a safe down step yields the DESCEND recovery candidate',
      descend !== undefined && descend.meta.missingCapability === 'open_path' && descend.meta.safe === true,
      `descend=${descend === undefined ? 'none' : `${descend.id} -> ${String(descend.target?.x)},${String(descend.target?.y)},${String(descend.target?.z)}`} candidates=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
    )
  }

  process.stdout.write('-'.repeat(78) + '\n')
  process.stdout.write(`candidate-recovery: ${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}\n`)
  if (failures > 0) process.exit(1)
}

main()
