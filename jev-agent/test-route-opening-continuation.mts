// test-route-opening-continuation.mts - EXECUTOR/path-fallback + generic
// route-continuation regression for the exact-RC boundary after PR #269.
//
// Live RC (RC_SHA 321ef78, run-mu99dkap-19w1f, generation 2ba2d14ca359):
// PR #269 offered the generic route-opening affordances and Jev selected
//   DESCEND:level:E:b55_61_26
// for option `place:furnace`. The DESCEND dug its wall, then the stock
// pathfinder returned `noPath` for the step. The control-walk fallback made
// ZERO body progress (start=(54.5,61,26.43) end=(54.5,61,26.43)) yet the
// executor reported `verified=true status=done`, because `isAtRequiredLevel`
// accepted the same-floor neighbouring stance (hypot 0.64 <= 1.2). The next
// state then had no route-opening candidate left (the level step's wall and
// head were both already clear, so `descendCandidates` required a diggable
// primary and emitted nothing) and collapsed to
//   CANDIDATE_STARVATION presented=2 productive=0 goal=place:furnace:1
//
// This suite locks two generic mechanics, with no item/coordinate/portal
// special-casing and with Jev still the action chooser:
//
//   (A) EXECUTOR: a same-floor step is complete only when the body OCCUPIES the
//       target cell. An adjacent no-progress fallback is not `done`, so a failed
//       route-opening action fails truthfully (truth = CAN/TRUE/SAFE/DONE).
//   (B) ROUTE-CONTINUATION: a safe level step whose dig cells are already clear
//       is still enumerated as an ordinary forward MOVE by the route-opening
//       acquisition pass, so one failed/opened route attempt cannot starve the
//       next state.
//
// Pure: no bot, no network, no model.
//
// Run: bun test-route-opening-continuation.mts
//      (wired as `bun run route-opening-continuation-test`)
import { applyReachabilityGate, defaultCandidateOptions } from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import { isAtRequiredLevel } from './src/executor.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { capabilityKey } from './src/reachability.ts'
import type { DescentOption, GoalState, InventoryState, Vec3Json, WorldState } from './src/state.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

// --- world builders ------------------------------------------------------------

/** The live body stance: adjacent to the step cell, never inside it. */
const BOT: Vec3Json = { x: 54.5, y: 61, z: 26.4 }
/** The live withheld locomotion target (`MOVE:p56_60_24`). */
const OPEN_TARGET: Vec3Json = { x: 56, y: 60, z: 24 }
/** The opened level step cell (`DESCEND:level:E` step, wall and head both clear). */
const STEP: Vec3Json = { x: 55, y: 61, z: 26 }
/** A second, different opened level step: genericity, not a coordinate special case. */
const STEP_N: Vec3Json = { x: 54, y: 61, z: 25 }

const isProductive = (candidate: Candidate): boolean =>
  candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE'

const selectionKeys = ['priority', 'rank', 'order', 'selected', 'chosen', 'forced', 'deterministic', 'override']

function self(position: Vec3Json): WorldState['self'] {
  return {
    username: 'AI_ROUTE',
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

function worldState(overrides: { descent?: DescentOption[]; standable?: Vec3Json[] }): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(BOT),
    inventory: inventory({}),
    entities: [],
    blocks: [],
    terrain: { standable: overrides.standable ?? [BOT, OPEN_TARGET] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: overrides.descent ?? [],
    stepCuts: [],
    headroomCuts: [],
    goal: goal('furnace'),
    goalQueue: queueWith(queuedGoal('furnace', 'place')),
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

/** The live withheld locomotion target: a standable frontier with no path. */
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

const probe = (position: Vec3Json): 'no_path' | 'reachable' =>
  position.x === OPEN_TARGET.x && position.z === OPEN_TARGET.z ? 'no_path' : 'reachable'

function optionsWith(): CandidateOptions {
  return { ...defaultCandidateOptions, reachability: { memory: null, pathProbe: probe } }
}

/**
 * The state the executor left after the route-opening DESCEND: the E level step
 * has wall AND head already clear (nothing left to dig) but is a valid forward
 * body change, and the withheld MOVE is still `no_path`.
 */
function openLevelStep(dir: DescentOption['dir'], dx: number, dz: number, step: Vec3Json): DescentOption {
  return {
    dir,
    mode: 'level',
    dx,
    dz,
    step,
    wall: { x: step.x, y: step.y, z: step.z },
    head: { x: step.x, y: step.y + 1, z: step.z },
    floor: { x: step.x, y: step.y - 1, z: step.z },
    wallSolid: false,
    headSolid: false,
    floorSolid: true,
    safe: true,
    reason: 'safe',
    digName: 'air',
    digHarvestTool: null,
    digHarvestTier: null,
    diggable: false,
  }
}

function main(): void {
  process.stdout.write(
    'route-opening continuation: a failed/opened DESCEND still yields a forward fact\n',
  )
  process.stdout.write('-'.repeat(78) + '\n')

  // (A) Executor truth: the exact live no-progress fallback stance is NOT a
  // completed same-floor step. This is what turned `noPath` into `verified=true`
  // with zero body progress on the RC.
  {
    const adjacent = isAtRequiredLevel(BOT, STEP)
    const centred = isAtRequiredLevel({ x: 55.5, y: 61, z: 26.5 }, STEP)
    const crossFloor = isAtRequiredLevel({ x: 55.5, y: 61.6, z: 26.5 }, STEP)
    check(
      '(A) a same-floor adjacent no-progress stance is NOT an arrived step',
      adjacent === false,
      `adjacent=${adjacent} (live body 54.5,61,26.4 vs target ${STEP.x},${STEP.y},${STEP.z})`,
    )
    check(
      '(A) occupying the target cell IS arrived and cross-floor keeps the tolerance',
      centred === true && crossFloor === true,
      `centred=${centred} crossFloor=${crossFloor}`,
    )
  }

  const state = worldState({ descent: [openLevelStep('E', 1, 0, STEP)] })

  // (B) RED on 321ef78: the opened level step has no diggable primary, so the
  // route-opening acquisition emitted nothing and the state collapsed to
  // WAIT + ESCALATE (presented=2 productive=0).
  {
    const grounded = applyReachabilityGate([waitCandidate(state.tick), unreachableMove(state.tick)], state, optionsWith())
    const withheld = grounded.withheld.find((entry) => entry.candidate.id === unreachableMove(state.tick).id)
    const productive = grounded.candidates.filter(isProductive)
    const continuation = productive.find(
      (candidate) => candidate.kind === 'MOVE' && candidate.target?.x === STEP.x && candidate.target?.z === STEP.z,
    )
    check(
      '(B) the withheld locomotion target still reports no_path/[open_path]',
      withheld !== undefined &&
        withheld.result.reason === 'no_path' &&
        withheld.result.missingCapabilities.map(capabilityKey).join(',') === 'open_path',
      `withheld=${withheld?.result.reason ?? 'none'} missing=[${(withheld?.result.missingCapabilities ?? []).map(capabilityKey).join(',')}]`,
    )
    check(
      '(B) the next state does NOT collapse to presented=2 productive=0',
      productive.length >= 1,
      `presented=${grounded.candidates.length} productive=${productive.length} ids=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
    )
    check(
      '(B) the opened level step is offered as a forward MOVE fact',
      continuation !== undefined && continuation.meta.capabilityAcquisition === true,
      `continuation=${continuation?.id ?? 'none'} target=${continuation?.target?.x ?? '?'},${continuation?.target?.y ?? '?'},${continuation?.target?.z ?? '?'}`,
    )
    check(
      '(B) the withheld target itself is still NOT presented (truth preserved)',
      grounded.candidates.every((candidate) => candidate.id !== unreachableMove(state.tick).id),
      `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
    )
  }

  // (C) Genericity + authority: a different, unrelated level step yields the same
  // fact family, and no deterministic selection/priority/ranking is injected.
  {
    const other = worldState({ descent: [openLevelStep('N', 0, -1, STEP_N)] })
    const grounded = applyReachabilityGate([waitCandidate(other.tick), unreachableMove(other.tick)], other, optionsWith())
    const continuation = grounded.candidates.find(
      (candidate) => candidate.kind === 'MOVE' && candidate.target?.x === STEP_N.x && candidate.target?.z === STEP_N.z,
    )
    const acquisitions = grounded.candidates.filter((candidate) => candidate.meta.capabilityAcquisition === true)
    const carriesSelection = acquisitions.some((candidate) =>
      selectionKeys.some((key) => candidate.meta[key] !== undefined),
    )
    check(
      '(C) a different column yields the same forward fact (no coordinate special-casing)',
      continuation !== undefined,
      `ids=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
    )
    check(
      '(C) the route-continuation facts carry no selection/priority/ranking metadata',
      acquisitions.length > 0 && !carriesSelection,
      `selectionKeys=${selectionKeys.filter((key) => acquisitions.some((candidate) => candidate.meta[key] !== undefined)).join(',') || 'none'}`,
    )
  }

  process.stdout.write('-'.repeat(78) + '\n')
  process.stdout.write(`route-opening-continuation: ${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}\n`)
  if (failures > 0) process.exit(1)
}

main()
