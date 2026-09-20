// test-log-target-route-affordances.mts - CANDIDATE_GENERATION defect.
//
// Frozen run run-mu9crrhw-1b5xw (RC_SHA a137735), subgoal `collect 3 x log`
// after a water death. Every generation logged
//   generated N executable candidate(s); skipped 13 blocked log(s)
//   (canDig=false, no walk-up access)
// and the presented set was ONLY local `MOVE:p4_69_4` shuffles + WAIT, because
// the trees were withheld as
//   REACHABILITY target=4,71,17 reachable=false reason=no_standable_approach missing=[standable_approach]
//   CANDIDATE_WITHHELD ... candidate=ACCESS:b4_71_17
// The route-opening acquisition pass was reached (the retirement carries
// `standable_approach`, and `open_path`/`standable_approach` already map to
// `routeOpeningCandidates`), but it discarded the ONE fact that matters: the
// withheld collect/mine target. `routeOpeningCandidates` re-derived its focus
// from `nearestResource(goalTargetItem)`, which is the log directly ABOVE the
// bot - a target no frontier can get "strictly closer" to - so the approach
// MOVE collapsed onto the nearest local frontier and the DEScend family was
// never oriented at the withheld block.
//
// This suite locks the generic repair: when a collect/mine target is withheld
// for `canDig=false` / no walk-up access, the route-opening enumeration is
// focused on THAT withheld block, so the existing STEP / DESCEND / approach
// families are enumerated toward it. No item/coordinate/portal special-casing,
// no new candidate kind, no ranking - the facts are still Jev's to choose.
//
// Pure: no bot, no network, no model.
//
// Run: npx tsx test-log-target-route-affordances.mts
//      (wired as `npm run log-target-route-test`)
import { defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { capabilityKey } from './src/reachability.ts'
import type { DigApproachFact } from './src/reachability.ts'
import type {
  AgentSignals,
  BlockState,
  DescentOption,
  GoalState,
  InventoryState,
  Vec3Json,
  WorldState,
} from './src/state.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const isProductive = (candidate: Candidate): boolean =>
  candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE'
const selectionKeys = ['priority', 'rank', 'order', 'selected', 'chosen', 'forced', 'deterministic', 'override']

// --- world builders ------------------------------------------------------------

function self(position: Vec3Json): WorldState['self'] {
  return {
    username: 'AI_LOGROUTE',
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

function goal(targetItem: string): GoalState {
  return {
    id: `collect:${targetItem}`,
    description: `collect 3 x ${targetItem}`,
    targetItem,
    requiredCount: 3,
    startCount: 1,
    haveCount: 2,
    progress: 2 / 3,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(targetItem: string): QueuedGoal {
  return {
    id: `g-${targetItem}`,
    kind: 'collect',
    description: `collect 3 x ${targetItem}`,
    targetItem,
    requiredCount: 3,
    startCount: 1,
    haveCount: 2,
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

/** A sensed log the body cannot walk up to: out of reach, no adjacent standable cell. */
function blockedLog(position: Vec3Json, distance: number): BlockState {
  return {
    kind: 'log',
    name: 'oak_log',
    position,
    distance,
    diggable: true,
    inReach: false,
    hasAdjacentStandable: false,
    adjacentStandable: null,
    yield: 'oak_log',
    harvestTool: null,
    harvestTier: null,
  }
}

/** A sensed log that has a walk-up spot sensor-side, but the spot has no path. */
function walkedLog(position: Vec3Json, stand: Vec3Json, distance: number): BlockState {
  return {
    kind: 'log',
    name: 'oak_log',
    position,
    distance,
    diggable: true,
    inReach: false,
    hasAdjacentStandable: true,
    adjacentStandable: stand,
    yield: 'oak_log',
    harvestTool: null,
    harvestTier: null,
  }
}

function worldState(overrides: {
  position: Vec3Json
  blocks: BlockState[]
  standable: Vec3Json[]
  descent?: DescentOption[]
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position),
    inventory: inventory({ oak_log: 2, dirt: 64 }),
    entities: [],
    blocks: overrides.blocks,
    terrain: { standable: overrides.standable },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: overrides.descent ?? [],
    stepCuts: [],
    headroomCuts: [],
    goal: goal('log'),
    goalQueue: queueWith(queuedGoal('log')),
    recentEvents: [],
    signals: signals(),
  }
}

/** No stand exists for any sensed block: the live `no_interaction_stand` refusal. */
const noStand: (block: Vec3Json) => DigApproachFact = () => ({ approach: null, path: null })

function optionsWith(
  digApproach: (block: Vec3Json) => DigApproachFact,
  pathProbe: (position: Vec3Json) => 'reachable' | 'no_path' = () => 'reachable',
): CandidateOptions {
  return { ...defaultCandidateOptions, reachability: { memory: null, digApproach, pathProbe } }
}

/** A safe down staircase step whose primary cell is diggable (so a DESCEND is legal). */
function downDescent(step: Vec3Json): DescentOption {
  return {
    dir: 'S',
    mode: 'down',
    dx: 0,
    dz: 1,
    step,
    wall: { x: step.x, y: step.y + 1, z: step.z },
    head: { x: step.x, y: step.y + 2, z: step.z },
    floor: { x: step.x, y: step.y, z: step.z },
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

const acquisitionsOf = (candidates: readonly Candidate[]): Candidate[] =>
  candidates.filter((candidate) => candidate.meta.capabilityAcquisition === true)

/** A presented MOVE that strictly reduces the horizontal distance to the withheld block. */
function approachToward(candidates: readonly Candidate[], target: Vec3Json, from: Vec3Json): Candidate | undefined {
  const current = Math.hypot(target.x - from.x, target.z - from.z)
  return candidates.find(
    (candidate) =>
      candidate.kind === 'MOVE' &&
      candidate.target !== null &&
      Math.hypot(target.x - candidate.target.x, target.z - candidate.target.z) < current,
  )
}

function main(): void {
  process.stdout.write('log-target route affordances: a withheld collect target gets route-opening facts\n')
  process.stdout.write('-'.repeat(78) + '\n')

  // (a) APPROACH. Two blocked logs are withheld (`standable_approach`): one
  // directly ABOVE the body (nearest, but no frontier can get closer to it) and
  // one FAR in +z. The route-opening pass must enumerate an approach toward the
  // withheld FAR block, not only the local frontier nearest the body.
  {
    const BOT: Vec3Json = { x: 0.5, y: 69, z: 0.5 }
    const ABOVE: Vec3Json = { x: 0, y: 72, z: 0 }
    const FAR: Vec3Json = { x: 0, y: 69, z: 12 }
    const state = worldState({
      position: BOT,
      blocks: [blockedLog(ABOVE, 3.08), blockedLog(FAR, 11.51)],
      standable: [BOT, { x: 2, y: 69, z: 0 }, { x: 0, y: 69, z: 2 }],
    })
    const grounded = generateGroundedCandidates(state, optionsWith(noStand))
    const productive = grounded.candidates.filter(isProductive)
    const approach = approachToward(grounded.candidates, FAR, BOT)

    check(
      '(a) both blocked logs are withheld for no_standable_approach/[standable_approach]',
      grounded.withheld.length === 2 &&
        grounded.withheld.every(
          (entry) =>
            entry.result.missingCapabilities.map(capabilityKey).includes('standable_approach') &&
            entry.result.reason === 'no_standable_approach',
        ),
      `withheld=[${grounded.withheld.map((e) => `${e.candidate.id}:${e.result.reason}`).join(',')}]`,
    )
    check(
      '(a) the withheld collect target itself is never presented (truth preserved)',
      grounded.candidates.every((candidate) => !candidate.id.startsWith('ACCESS:')),
      `presented=[${grounded.candidates.map((c) => c.id).join(',')}]`,
    )
    check(
      '(a) route-opening enumerates an approach MOVE toward the withheld FAR log',
      approach !== undefined && approach.meta.capabilityAcquisition === true,
      `approach=${approach?.id ?? 'none'} target=${approach?.target?.x ?? '?'},${approach?.target?.y ?? '?'},${approach?.target?.z ?? '?'} productive=[${productive.map((c) => c.id).join(',')}]`,
    )
    check(
      '(a) the presented set is not only the local MOVE + WAIT',
      productive.length >= 2,
      `productive=[${productive.map((c) => c.id).join(',')}] presented=[${grounded.candidates.map((c) => c.id).join(',')}]`,
    )
  }

  // (b) DESCEND. A blocked log BELOW the body that the sensor gave a walk-up
  // spot, whose `canDig=false` path is `no_path`, is withheld for `open_path`.
  // A safe down step exists. The route-opening pass must enumerate the DESCEND
  // toward the withheld block; re-deriving the focus from the nearest log
  // (directly above) suppressed it because `targetBelow` was false.
  {
    const BOT: Vec3Json = { x: 0.5, y: 69, z: 0.5 }
    const ABOVE: Vec3Json = { x: 0, y: 70, z: 0 }
    const BELOW: Vec3Json = { x: 0, y: 68, z: 2 }
    const BELOW_STAND: Vec3Json = { x: 0, y: 69, z: 2 }
    const state = worldState({
      position: BOT,
      blocks: [blockedLog(ABOVE, 1.22), walkedLog(BELOW, BELOW_STAND, 1.87)],
      standable: [BOT, { x: 2, y: 69, z: 0 }],
      descent: [downDescent({ x: 0, y: 68, z: 2 })],
    })
    const pathProbe = (position: Vec3Json): 'reachable' | 'no_path' =>
      position.x === BELOW_STAND.x && position.z === BELOW_STAND.z ? 'no_path' : 'reachable'
    const grounded = generateGroundedCandidates(state, optionsWith(noStand, pathProbe))
    const descend = acquisitionsOf(grounded.candidates).find((candidate) => candidate.kind === 'DESCEND')

    check(
      '(b) the below body target is withheld for no_path/[open_path]',
      grounded.withheld.some(
        (entry) =>
          entry.result.reason === 'no_path' &&
          entry.result.missingCapabilities.map(capabilityKey).join(',') === 'open_path',
      ),
      `withheld=[${grounded.withheld.map((e) => `${e.candidate.id}:${e.result.reason}`).join(',')}]`,
    )
    check(
      '(b) route-opening enumerates the DESCEND toward the withheld below-body log',
      descend !== undefined && descend.meta.missingCapability === 'open_path',
      `descend=${descend?.id ?? 'none'} target=${descend?.target?.x ?? '?'},${descend?.target?.y ?? '?'},${descend?.target?.z ?? '?'} presented=[${grounded.candidates.map((c) => c.id).join(',')}]`,
    )
  }

  // (c) AUTHORITY + GENERICITY. The route-opening facts carry no
  // selection/priority/ranking metadata, and the same family appears for a
  // shifted, unrelated geometry (no coordinate/item special-casing).
  {
    const BOT: Vec3Json = { x: -40.5, y: 12, z: 7.5 }
    const NEAR: Vec3Json = { x: -40, y: 15, z: 7 }
    const FAR: Vec3Json = { x: -40, y: 12, z: -5 }
    const state = worldState({
      position: BOT,
      blocks: [blockedLog(NEAR, 3.04), blockedLog(FAR, 11.51)],
      standable: [BOT, { x: -38, y: 12, z: 7 }, { x: -40, y: 12, z: 9 }],
    })
    const grounded = generateGroundedCandidates(state, optionsWith(noStand))
    const acquisitions = acquisitionsOf(grounded.candidates)
    const approach = approachToward(grounded.candidates, FAR, BOT)
    const carriesSelection = acquisitions.some((candidate) =>
      selectionKeys.some((key) => candidate.meta[key] !== undefined),
    )
    check(
      '(c) the same approach family appears for unrelated coordinates (generic)',
      approach !== undefined && approach.meta.capabilityAcquisition === true,
      `approach=${approach?.id ?? 'none'} presented=[${grounded.candidates.map((c) => c.id).join(',')}]`,
    )
    check(
      '(c) the route-opening facts carry no selection/priority/ranking metadata',
      acquisitions.length > 0 && !carriesSelection,
      `selectionKeys=${selectionKeys.filter((key) => acquisitions.some((candidate) => candidate.meta[key] !== undefined)).join(',') || 'none'}`,
    )
  }

  process.stdout.write('-'.repeat(78) + '\n')
  process.stdout.write(`log-target-route-affordances: ${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}\n`)
  if (failures > 0) process.exit(1)
}

main()
