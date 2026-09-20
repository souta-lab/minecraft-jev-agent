// test-surface-spot-grounding.mts - CANDIDATE_GENERATION / terrain-truth
// affordance gap in `surfaceSpot()`.
//
// Live shape (run-mu9crrhw-1b5xw, RC a137735): after a water death the body sits
// around y=69 with an empty inventory and a `collect log` goal. Its terrain has
// NO standable cell above `self.y + 2`, so `surfaceSpot()` returned null and the
// generator emitted only local route-opening MOVE cells + WAIT - no
// `RETRIEVE:surface:*` exploration affordance at all. Mercury repeatedly chose
// `explore_surface`, but the CANDIDATE_GENERATION layer never offered a grounded
// surface target for it.
//
// The fix is generic terrain truth: when the `spot.y > self.y + 2` ascent scan
// yields nothing, `surfaceSpot()` still returns a grounded, body-changing
// standable cell (never the body's own feet cell, never blacklisted/exhausted),
// with the SAME `RETRIEVE:surface:<item>:<id>` id scheme and failure bookkeeping.
// No item/coordinate special case. Code enumerates mechanically-valid
// affordances; Jev/Mercury still SELECT.
//
// Pure: no bot, no network, no model.
//
// Run: npx tsx test-surface-spot-grounding.mts  (wired as `npm run surface-spot-grounding-test`)
import { blockId, defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { AgentSignals, GoalState, InventoryState, SelfState, Vec3Json, WorldState } from './src/state.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

// --- world builders ------------------------------------------------------------

/** The body's feet cell; also the only cell it already occupies. */
const SELF: Vec3Json = { x: 0, y: 69, z: 0 }
/** Same-level standable neighbours: reachable, but not strictly higher than y+2. */
const NEAR: Vec3Json = { x: 3, y: 69, z: 0 }
const FAR: Vec3Json = { x: 9, y: 69, z: 0 }
/** A standable cell below the body (still not strictly higher). */
const LOWER: Vec3Json = { x: 0, y: 66, z: 0 }
/** A strictly-higher ascent cell: `y > self.y + 2`, the primary scan's province. */
const ASCENT: Vec3Json = { x: 0, y: 72, z: 0 }

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_SURFACE_GROUND',
    position: { x: position.x + 0.5, y: position.y, z: position.z + 0.5 },
    eyePosition: { x: position.x + 0.5, y: position.y + 1.62, z: position.z + 0.5 },
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

function inventory(counts: Record<string, number> = {}): InventoryState {
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

function queuedGoal(): QueuedGoal {
  return {
    id: 'g-collect-log',
    kind: 'collect',
    description: 'collect 1 x log',
    targetItem: 'log',
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

function goal(): GoalState {
  return {
    id: 'collect:log',
    description: 'collect 1 x log',
    targetItem: 'log',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function worldState(standable: Vec3Json[]): WorldState {
  const current = queuedGoal()
  return {
    schemaVersion: 1,
    tick: 41,
    timestampMs: 1_700_000_000_000,
    self: self(SELF),
    inventory: inventory(),
    entities: [],
    blocks: [],
    terrain: { standable },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: [],
    stepCuts: [],
    headroomCuts: [],
    goal: goal(),
    goalQueue: queueWith(current),
    recentEvents: [],
    signals: signals(),
  }
}

function options(): CandidateOptions {
  return {
    ...defaultCandidateOptions,
    reachability: { memory: null, pathProbe: () => 'reachable' },
  }
}

const isSurfaceRetrieve = (candidate: Candidate): boolean =>
  candidate.kind === 'RETRIEVE' && candidate.id.startsWith('RETRIEVE:surface:log:')

const selectionKeys = ['priority', 'rank', 'order', 'selected', 'chosen', 'forced', 'deterministic', 'override']

function sameCell(a: Vec3Json, b: Vec3Json): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z
}

function main(): void {
  process.stdout.write('surface-spot grounding: a log goal still gets a surface exploration affordance\n')
  process.stdout.write('-'.repeat(78) + '\n')

  // (1) RED on a137735: no standable cell above self.y + 2, but reachable
  // standable cells at/below it. A grounded RETRIEVE:surface:* target must be
  // emitted instead of null (previously the only body change was a bare MOVE).
  {
    const standable = [SELF, NEAR, FAR, LOWER]
    const elevated = standable.filter((spot) => spot.y > SELF.y + 2)
    const state = worldState(standable)
    const grounded = generateGroundedCandidates(state, options())
    const surface = grounded.candidates.find(isSurfaceRetrieve)
    const surfaceTarget = surface?.target ?? null
    const targetIsStandable =
      surfaceTarget !== null && standable.some((spot) => sameCell(spot, surfaceTarget))
    const targetIsSelf = surfaceTarget !== null && sameCell(surfaceTarget, SELF)

    check(
      '(1) the fixture has no standable cell above self.y + 2',
      elevated.length === 0,
      `self.y=${SELF.y} elevated=[${elevated.map((spot) => `${spot.x},${spot.y},${spot.z}`).join(' ')}]`,
    )
    check(
      '(1) a grounded RETRIEVE:surface:* exploration target is emitted',
      surface !== undefined,
      `surface=${surface?.id ?? 'NONE'} candidates=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
    )
    check(
      '(1) the surface target is a real standable cell, and not the body itself',
      targetIsStandable && !targetIsSelf,
      `target=${JSON.stringify(surfaceTarget)}`,
    )
    check(
      '(1) the id reuses the RETRIEVE:surface scheme',
      surface !== undefined &&
        surfaceTarget !== null &&
        surface.id === `RETRIEVE:surface:log:${blockId('p', surfaceTarget)}`,
      `id=${surface?.id ?? 'NONE'}`,
    )
  }

  // (2) Authority: the generator enumerates mechanical facts and never injects a
  // selection/priority/ranking. More than one mechanically-valid option survives,
  // so Jev/Mercury still chooses.
  {
    const grounded = generateGroundedCandidates(worldState([SELF, NEAR, FAR, LOWER]), options())
    const surface = grounded.candidates.find(isSurfaceRetrieve)
    const carriesSelection = grounded.candidates.some((candidate) =>
      selectionKeys.some((key) => candidate.meta[key] !== undefined),
    )
    check(
      '(2) no deterministic selection/priority/ranking is injected',
      surface !== undefined && !carriesSelection,
      `keys=${selectionKeys.filter((key) => grounded.candidates.some((candidate) => candidate.meta[key] !== undefined)).join(',') || 'none'}`,
    )
    check(
      '(2) more than one mechanically-valid option remains for the model',
      grounded.candidates.length >= 2,
      `candidates=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
    )
  }

  // (3) Preserved primary behaviour: when a standable cell strictly above
  // self.y + 2 exists, the ascent scan still owns the target (the highest cell).
  {
    const grounded = generateGroundedCandidates(worldState([SELF, NEAR, FAR, LOWER, ASCENT]), options())
    const surface = grounded.candidates.find(isSurfaceRetrieve)
    check(
      '(3) a strictly-higher standable cell is still the surface target',
      surface !== undefined && surface.target !== null && sameCell(surface.target, ASCENT),
      `target=${JSON.stringify(surface?.target ?? null)} expected=${JSON.stringify(ASCENT)}`,
    )
  }

  process.stdout.write('-'.repeat(78) + '\n')
  process.stdout.write(`surface-spot grounding: ${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}\n`)
  if (failures > 0) process.exit(1)
}

main()
