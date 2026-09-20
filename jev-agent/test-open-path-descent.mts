// test-open-path-descent.mts - regression for the candidate-enumeration defect
// where an unreachable MOVE/PLACE target (`reason=no_path`, `missing=[open_path]`)
// collapsed the candidate set to only WAIT/ESCALATE.
//
// Two generic enumeration fixes are locked here:
//  1. `capabilityAcquisitionCandidates` now has an arm for `open_path` /
//     `standable_approach`, so a withheld locomotion target contributes the
//     EXISTING route-opening families (STEP / DESCEND / explore-MOVE) instead of
//     nothing.
//  2. `mineCandidates` preserves its existing `descent` (staircase/tunnel step)
//     candidates when the MOVE/access route is known blocked by `no_path`, even
//     when the focus is NOT a stone/ore yield.
//
// Both are candidate ENUMERATION only: no MOVE is replaced, no item/coordinate/
// portal is special-cased, and no priority/ranking/selection is injected.
//
// Pure: no bot, no network, no model.
//
// Run: npx tsx test-open-path-descent.mts  (wired as `npm run open-path-descent-test`)
import {
  applyReachabilityGate,
  defaultCandidateOptions,
  generateGroundedCandidates,
} from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { capabilityKey } from './src/reachability.ts'
import type {
  BlockState,
  DescentOption,
  GoalState,
  InventoryState,
  SelfState,
  StepCut,
  Vec3Json,
  WorldState,
} from './src/state.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const BOT: Vec3Json = { x: 0.5, y: 60, z: 0.5 }
/** The withheld locomotion destination (mirrors the live `MOVE:p56_60_24`). */
const OPEN_TARGET: Vec3Json = { x: 12, y: 60, z: 12 }
/** A standable frontier the bot can still reach. */
const FRONTIER: Vec3Json = { x: 4, y: 60, z: 0 }
/** A non-stone/ore focus block (a log), with a stand at (0,60,5). */
const LOG_POS: Vec3Json = { x: 0, y: 60, z: 6 }
const LOG_STAND: Vec3Json = { x: 0, y: 60, z: 5 }

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_OPEN_PATH',
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

function goal(targetItem: string, description: string): GoalState {
  return {
    id: `goal:${targetItem}`,
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

function queuedGoal(targetItem: string, kind: QueuedGoal['kind'], description: string): QueuedGoal {
  return {
    id: `g-${targetItem}`,
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

function queueWith(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

function worldState(overrides: {
  blocks?: BlockState[]
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
    inventory: inventory({}),
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

/** A standalone MOVE whose own destination has no path (the starvation shape). */
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

function logBlock(): BlockState {
  return {
    kind: 'log',
    name: 'oak_log',
    position: LOG_POS,
    distance: 5.5,
    diggable: true,
    inReach: false,
    hasAdjacentStandable: true,
    adjacentStandable: LOG_STAND,
    yield: 'oak_log',
    harvestTool: null,
    harvestTier: null,
    visible: true,
  }
}

/** A blocked log: no walk-up access, only a refused interaction stand. */
function inaccessibleLogBlock(): BlockState {
  return {
    ...logBlock(),
    hasAdjacentStandable: false,
    adjacentStandable: null,
  }
}

function safeStepCut(): StepCut {
  return {
    dir: 'E',
    dx: 1,
    dz: 0,
    cut: { x: 2, y: 60, z: 0 },
    step: { x: 2, y: 60, z: 0 },
    name: 'dirt',
    safe: true,
    reason: 'safe',
  }
}

/** A safe same-level tunnel step toward the non-stone focus. */
function levelStep(): DescentOption {
  return {
    dir: 'S',
    mode: 'level',
    dx: 0,
    dz: 1,
    step: { x: 0, y: 60, z: 1 },
    wall: { x: 0, y: 60, z: 1 },
    head: { x: 0, y: 61, z: 1 },
    floor: { x: 0, y: 59, z: 1 },
    wallSolid: true,
    headSolid: false,
    floorSolid: true,
    safe: true,
    reason: 'safe',
    digName: 'oak_log',
    digHarvestTool: null,
    digHarvestTier: null,
    diggable: true,
  }
}

/** `no_path` for the withheld destinations only; everything else is reachable. */
const pathProbe = (position: Vec3Json): 'no_path' | 'reachable' =>
  (position.x === OPEN_TARGET.x && position.z === OPEN_TARGET.z) ||
  (position.x === LOG_STAND.x && position.y === LOG_STAND.y && position.z === LOG_STAND.z)
    ? 'no_path'
    : 'reachable'

const isProductive = (candidate: Candidate): boolean =>
  candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE'

const selectionKeys = ['priority', 'rank', 'order', 'selected', 'chosen', 'forced', 'deterministic', 'override']

function main(): void {
  process.stdout.write('open-path descent: an unreachable MOVE/PLACE target still yields route-opening facts\n')
  process.stdout.write('-'.repeat(82) + '\n')

  // (a) The live place:furnace shape: an unreachable MOVE is withheld for
  // `no_path`/`open_path`; the existing STEP + explore-MOVE families must be
  // presented, not a barren WAIT-only set. The withheld target stays withheld.
  const placeState = worldState({
    goal: goal('furnace', 'place 1 x furnace'),
    goalQueue: queueWith(queuedGoal('furnace', 'place', 'place 1 x furnace')),
    stepCuts: [safeStepCut()],
  })
  {
    const options: CandidateOptions = { ...defaultCandidateOptions, reachability: { memory: null, pathProbe } }
    const grounded = applyReachabilityGate(
      [waitCandidate(placeState.tick), unreachableMove(placeState.tick)],
      placeState,
      options,
    )
    const withheld = grounded.withheld.find(
      (entry) => entry.candidate.id === unreachableMove(placeState.tick).id,
    )
    const productive = grounded.candidates.filter(isProductive)
    const step = productive.find((candidate) => candidate.kind === 'STEP')
    const move = productive.find((candidate) => candidate.kind === 'MOVE')
    check(
      '(a) the unreachable MOVE is withheld for no_path with [open_path]',
      withheld !== undefined &&
        withheld.result.reason === 'no_path' &&
        withheld.result.missingCapabilities.map(capabilityKey).join(',') === 'open_path',
      `withheld=${withheld?.result.reason ?? 'none'} missing=[${(withheld?.result.missingCapabilities ?? [])
        .map(capabilityKey)
        .join(',')}]`,
    )
    check(
      '(a) the presented set includes the STEP and explore-MOVE route-opening families',
      step !== undefined && move !== undefined,
      `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
    )
    check(
      '(a) the withheld target itself is NOT presented (truth preserved)',
      grounded.candidates.every((candidate) => candidate.id !== unreachableMove(placeState.tick).id),
      `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
    )
  }

  // (b) Authority: the gate enumerates facts, it does not choose. The recovery
  // candidates carry no selection/priority/ranking metadata and more than one
  // family survives for the model to choose between.
  {
    const options: CandidateOptions = { ...defaultCandidateOptions, reachability: { memory: null, pathProbe } }
    const grounded = applyReachabilityGate(
      [waitCandidate(placeState.tick), unreachableMove(placeState.tick)],
      placeState,
      options,
    )
    const acquisitions = grounded.candidates.filter(
      (candidate) => candidate.meta.capabilityAcquisition === true,
    )
    const families = new Set(acquisitions.map((candidate) => candidate.kind))
    const carriesSelection = acquisitions.some((candidate) =>
      selectionKeys.some((key) => candidate.meta[key] !== undefined),
    )
    check(
      '(b) no deterministic selection/priority/ranking is injected',
      acquisitions.length > 0 && !carriesSelection,
      `selectionKeys=${
        selectionKeys.filter((key) => acquisitions.some((candidate) => candidate.meta[key] !== undefined)).join(',') ||
        'none'
      }`,
    )
    check(
      '(b) more than one candidate family remains, so the model still selects',
      families.size >= 2,
      `families=[${[...families].join(',')}]`,
    )
  }

  // (c) Generic mineCandidates arm (path probe): a non-stone/ore focus whose MOVE
  // stand spot has no path still preserves the existing DESCEND step.
  {
    const state = worldState({
      goal: goal('oak_log', 'collect 1 x oak_log'),
      goalQueue: queueWith(queuedGoal('oak_log', 'collect', 'collect 1 x oak_log')),
      blocks: [logBlock()],
      descent: [levelStep()],
    })
    const options: CandidateOptions = { ...defaultCandidateOptions, reachability: { memory: null, pathProbe } }
    const grounded = generateGroundedCandidates(state, options)
    const descend = grounded.candidates.find((candidate) => candidate.kind === 'DESCEND')
    const withheldMove = grounded.withheld.find((entry) => entry.candidate.kind === 'MOVE')
    check(
      '(c) a non-stone/ore focus keeps its existing DESCEND step when its MOVE route is no_path',
      descend !== undefined,
      `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
    )
    check(
      '(c) the unreachable MOVE itself is still withheld for no_path/open_path',
      withheldMove !== undefined &&
        withheldMove.result.reason === 'no_path' &&
        withheldMove.result.missingCapabilities.map(capabilityKey).join(',') === 'open_path',
      `withheld=${withheldMove?.result.reason ?? 'none'} missing=[${(withheldMove?.result.missingCapabilities ?? [])
        .map(capabilityKey)
        .join(',')}]`,
    )
  }

  // (d) Generic mineCandidates arm (dig-access refusal): the typed
  // `no_path_to_stand` refusal is the same no_path/open_path fact at the gate.
  {
    const state = worldState({
      goal: goal('oak_log', 'collect 1 x oak_log'),
      goalQueue: queueWith(queuedGoal('oak_log', 'collect', 'collect 1 x oak_log')),
      blocks: [inaccessibleLogBlock()],
      descent: [levelStep()],
    })
    const options: CandidateOptions = {
      ...defaultCandidateOptions,
      reachability: {
        memory: null,
        pathProbe,
        digApproach: () => ({ approach: LOG_STAND, path: 'no_path' }),
      },
    }
    const grounded = generateGroundedCandidates(state, options)
    const descend = grounded.candidates.find((candidate) => candidate.kind === 'DESCEND')
    const withheldAccess = grounded.withheld.find(
      (entry) => entry.candidate.meta.digAccessRefusal === 'no_path_to_stand',
    )
    check(
      '(d) a non-stone/ore focus keeps its existing DESCEND step when dig access is no_path_to_stand',
      descend !== undefined,
      `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
    )
    check(
      '(d) the refused dig access is still withheld for no_path/open_path',
      withheldAccess !== undefined &&
        withheldAccess.result.reason === 'no_path' &&
        withheldAccess.result.missingCapabilities.map(capabilityKey).join(',') === 'open_path',
      `withheld=${withheldAccess?.result.reason ?? 'none'} missing=[${(
        withheldAccess?.result.missingCapabilities ?? []
      )
        .map(capabilityKey)
        .join(',')}]`,
    )
  }

  process.stdout.write('-'.repeat(82) + '\n')
  process.stdout.write(`open-path-descent: ${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}\n`)
  if (failures > 0) process.exit(1)
}

main()
