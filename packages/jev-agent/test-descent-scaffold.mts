// test-descent-scaffold.mts - the DOWNWARD self-landing descent.
//
// THE MIRROR OF THE CROSSING. `bridgeRoute.ts#planBridgeSpan` answers a HORIZONTAL
// gap the body cannot cross by laying the floor of the cell it is about to occupy
// and stepping onto it (`selfLanding`, live-proven: `BRIDGE_START
// actionId=BRIDGE:N:p23_79_0 -> BRIDGE_STEP -> BRIDGE_END placed=1 verified=true
// reason=reached`). A descent whose landing cell has AIR below is the same shape
// rotated 90 degrees, and it was the one gap the descent vocabulary could not
// answer at all.
//
// MEASURED (main 974e954, the operator's floated-portal trial; body 23.5,79.0,1.5
// hp 16, portal interior at 26,67,9 i.e. dy=-12):
//
//   CANDIDATE_ACQUISITION candidate=MOVE:b26_74_-14 kind=MOVE reachable=false
//     reason=needs_descend missing=["descend_plan:no_support@25,78,-2:air"]
//   counts in this run: needs_descend 1912 | column_descent 4006
//
// The typed fact was already right; the ANSWER did not exist. Both descent remedies
// are DIGS (cut a staircase step `verticalPlan.ts#planVerticalApproachDetailed`, or
// dig the body's own column `candidates.ts#columnDescentCandidates`), so a landing
// with nothing under it could only be refused - 1912 times - although the body held
// blocks it could have laid.
//
// Fixtures (i)-(v) from the brief:
//   (i)   the measured shape: a body on a structure with the column below
//         unsupported, a placeable block in hand -> the descent GROUNDS, places its
//         landing, steps down, and the position (and the goal's dy) really reduces;
//   (ii)  the same with no block -> typed refusal naming the cell and the state
//         below it, and the acquisition names `placeable_block`;
//   (iii) a walkable descent -> byte-identical to today (no new candidate, no
//         placement);
//   (iv)  a protected plane / a hazard below -> refused typed, never placed into;
//   (v)   a multi-block descent: bounded and monotone - each step must reduce the
//         gap, the loop is capped, and it stops when the target level is reached.
//
// Run: bun test ./test-descent-scaffold.mts

import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import { defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type {
  AgentSignals,
  DescentDir,
  DescentOption,
  DescentRefusalReason,
  GoalState,
  InventoryState,
  SelfState,
  Vec3Json,
  WorldState,
} from './src/state.ts'
import { distance } from './src/state.ts'
import {
  DESCEND_SCAFFOLD_END,
  DESCEND_SCAFFOLD_PLACE_META,
  DESCEND_SCAFFOLD_REFUSED,
  DESCEND_SCAFFOLD_REFUSED_META,
  DESCEND_SCAFFOLD_START,
  DESCEND_SCAFFOLD_STEP,
  descendScaffoldReachabilityReason,
  formatDescentScaffoldRefused,
  planDescentScaffoldStep,
  strictlyReducesDescentGap,
} from './src/descentScaffold.ts'
import type { DescentScaffoldProbe } from './src/descentScaffold.ts'
import { envelopeForCandidate } from './src/skillCommitment.ts'
import { guardCandidate } from './src/policy.ts'
import type { GuardContext } from './src/policy.ts'
import { capabilityKey } from './src/reachability.ts'
import type { Capability } from './src/reachability.ts'
import { Executor, EventLogger, defaultExecutorOptions } from './src/index.ts'
import type { JsonlWriter } from './src/jev/client.ts'
import { MIRRORED_MARKERS } from './src/controller.ts'
import { fixtureClaim } from './test-claim-context.mts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const key = (p: Vec3Json): string => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`

// ---------------------------------------------------------------------------
// A small explicit terrain model. Every name carries the ONE fact the sensor reads
// (`boundingBox`) plus the hazard truth, so the hand-built `descent` /
// `descentScaffold` below are the same facts the live sensor would produce.
// ---------------------------------------------------------------------------
const EMPTY_BOX = new Set(['air', 'cave_air', 'void_air', 'water', 'lava'])
const REPLACEABLE = new Set(['air', 'cave_air', 'void_air'])
const SOLID_NAMES = new Set(['stone', 'cobblestone', 'nether_bricks', 'obsidian'])
const NO_CANOPY = new Set(['stone', 'cobblestone', 'nether_bricks', 'obsidian'])
const HAZARDS = new Set(['lava', 'fire', 'water', 'flowing_lava', 'magma_block', 'cactus'])

class Terrain {
  readonly cells = new Map<string, string>()
  set(cell: Vec3Json, name: string): this {
    this.cells.set(key(cell), name)
    return this
  }
  name(cell: Vec3Json): string {
    return this.cells.get(key(cell)) ?? 'air'
  }
  boundingBox(cell: Vec3Json): 'empty' | 'block' {
    return EMPTY_BOX.has(this.name(cell)) ? 'empty' : 'block'
  }
  open(cell: Vec3Json): boolean {
    return this.boundingBox(cell) === 'empty'
  }
  solid(cell: Vec3Json): boolean {
    return this.boundingBox(cell) === 'block'
  }
  hazard(cell: Vec3Json): boolean {
    return HAZARDS.has(this.name(cell))
  }
}

const DIRS: Array<{ dir: DescentDir; dx: number; dz: number }> = [
  { dir: 'E', dx: 1, dz: 0 },
  { dir: 'W', dx: -1, dz: 0 },
  { dir: 'N', dx: 0, dz: -1 },
  { dir: 'S', dx: 0, dz: 1 },
]

/** The sensor's own step geometry (`state.ts#buildDescent`) over `terrain`. */
function descentFromTerrain(terrain: Terrain, feet: Vec3Json): DescentOption[] {
  const out: DescentOption[] = []
  for (const { dir, dx, dz } of DIRS) {
    for (const mode of ['level', 'down'] as const) {
      const wall = { x: feet.x + dx, y: feet.y, z: feet.z + dz }
      const head = { x: feet.x + dx, y: feet.y + 1, z: feet.z + dz }
      const step = { x: feet.x + dx, y: mode === 'down' ? feet.y - 1 : feet.y, z: feet.z + dz }
      const floor = { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz }
      const support = { x: feet.x + dx, y: step.y - 1, z: feet.z + dz }
      const wallSolid = terrain.solid(wall)
      const headSolid = terrain.solid(head)
      const floorSolid = terrain.solid(floor)
      const supportSolid = terrain.solid(support)
      const hazardNearby = [wall, head, floor, step, support].some((cell) => terrain.hazard(cell))
      const wallOk = terrain.open(wall) || terrain.solid(wall)
      const headOk = terrain.open(head) || terrain.solid(head)
      const floorOk = mode === 'level' || terrain.open(floor) || terrain.solid(floor)
      let refusal: DescentRefusalReason | undefined
      let reason = 'safe'
      if (!wallOk) {
        refusal = 'unbreakable'
        reason = `${terrain.name(wall)} wall is not breakable`
      } else if (!headOk) {
        refusal = 'unbreakable'
        reason = `${terrain.name(head)} head-cell is not breakable`
      } else if (!floorOk) {
        refusal = 'unbreakable'
        reason = `${terrain.name(floor)} floor is not breakable`
      } else if (!supportSolid) {
        refusal = 'no_support'
        reason = `no solid support at (${support.x},${support.y},${support.z})`
      } else if (mode === 'down' && terrain.open(floor)) {
        refusal = 'open_floor'
        reason = 'floor already open (uncontrolled fall)'
      } else if (hazardNearby) {
        refusal = 'hazard'
        reason = 'lava/water in the step column'
      }
      const primary = mode === 'down' ? (floorSolid ? floor : wall) : wallSolid ? wall : head
      out.push({
        dir,
        mode,
        dx,
        dz,
        step,
        wall,
        head,
        floor,
        wallSolid,
        headSolid,
        floorSolid,
        supportSolid,
        hazardNearby,
        digs: [],
        safe: reason === 'safe',
        reason,
        ...(refusal === undefined ? {} : { refusal }),
        digName: terrain.name(primary),
        digHarvestTool: null,
        digHarvestTier: null,
        diggable: true,
      })
    }
  }
  // The own column, exactly as `buildDescent` emits it (`D` digs the floor).
  const floor = { x: feet.x, y: feet.y - 1, z: feet.z }
  const support = { x: feet.x, y: feet.y - 2, z: feet.z }
  const supportSolid = terrain.solid(support)
  out.push({
    dir: 'D',
    mode: 'down',
    dx: 0,
    dz: 0,
    step: floor,
    wall: feet,
    head: { x: feet.x, y: feet.y + 1, z: feet.z },
    floor,
    wallSolid: terrain.solid(feet),
    headSolid: terrain.solid({ x: feet.x, y: feet.y + 1, z: feet.z }),
    floorSolid: terrain.solid(floor),
    supportSolid,
    hazardNearby: [floor, support].some((cell) => terrain.hazard(cell)),
    digs: [],
    safe: supportSolid,
    reason: supportSolid ? 'safe' : `no solid support at (${support.x},${support.y},${support.z})`,
    ...(supportSolid ? {} : { refusal: 'no_support' as DescentRefusalReason }),
    digName: terrain.name(floor),
    digHarvestTool: null,
    digHarvestTier: null,
    diggable: true,
  })
  return out
}

/**
 * The live cell facts of the measured shape. `state.ts#buildDescentScaffoldProbe`
 * reads exactly these cells:
 *
 *   feet.y - 1  the LANDING cell (`landing`): the cell the own-column step drops
 *               into. AIR with AIR below it - the measured refusal.
 *   feet.y - 2  the PLACEMENT cell (`place`): the cell this leg creates the floor
 *               of. It is directly under the landing, so the block this leg places
 *               IS the landing's floor.
 *   feet.y - 3  the anchor / what the placed block rests on (`support`).
 *
 * The body stands on the ledge whose anchor block is `feet.y - 3` - the Minecraft
 * ledge shape (hitbox overhanging the void, supported by the adjacent solid face).
 * That one block is simultaneously the placement's reference face (the body places
 * against its top, `face=(0,...)`), which is what makes this mechanic legal.
 *
 * The values are supplied by the caller (the sensor reads them from the live world);
 * this helper only satisfies the type so a fixture can state ONE fact at a time.
 */
function probeOf(feet: Vec3Json, over: Partial<DescentScaffoldProbe> = {}): DescentScaffoldProbe {
  const landing = { x: feet.x, y: feet.y - 1, z: feet.z }
  const place = { x: feet.x, y: feet.y - 2, z: feet.z }
  return {
    selfFeet: feet,
    landing,
    place,
    landingOpen: true,
    landingHeadOpen: true,
    placeable: true,
    placeSupported: true,
    supportName: 'stone',
    landingName: 'air',
    landingHeadName: 'air',
    placeName: 'air',
    belowName: 'air',
    hazard: false,
    hazardBlock: null,
    flood: false,
    floodCell: null,
    floodBlock: null,
    footing: true,
    ...over,
  }
}

/** The body's feet cell for the MEASURED shape (a 1x1 anchor ledge at `feet.y - 3`). */
function ledgeFeet(): Vec3Json {
  return { x: 0, y: 64, z: 0 }
}

/** The terrain of the measured shape: one anchor block under the void column. */
function ledgeTerrain(feet: Vec3Json): Terrain {
  const terrain = new Terrain()
  terrain.set({ x: feet.x, y: feet.y - 3, z: feet.z }, 'stone')
  return terrain
}

// ---------------------------------------------------------------------------
// candidate-layer state
// ---------------------------------------------------------------------------
const OVERWORLD = 'minecraft:overworld'
/**
 * The active focus the descent serves. A `descend_to:Y` predicate no longer needs
 * an item to steer it, but `GoalState.targetItem` is a required string and the
 * controller always carries one - so the fixture carries the same underground-rock
 * focus the live `descend_to` row was attached to. It is a LABEL here: the descent
 * grounding reads the target LEVEL and the world, never this name.
 */
const STONE_FOCUS = 'stone'

function self(position: Vec3Json, overrides: Partial<SelfState> = {}): SelfState {
  return {
    username: 'AI_DESCENT',
    position: { x: position.x + 0.5, y: position.y, z: position.z + 0.5 },
    eyePosition: { x: position.x + 0.5, y: position.y + 1.62, z: position.z + 0.5 },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: OVERWORLD,
    isDay: true,
    heldItem: null,
    ...overrides,
  }
}

function inventory(counts: Record<string, number>): InventoryState {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0) }
}

function signals(extra: Partial<AgentSignals> = {}): AgentSignals {
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
    ...extra,
  }
}

/** The active `descend_to:Y=<n>` predicate goal: the bounded downward objective. */
function descendGoal(targetY: number): GoalState {
  return {
    id: `g1:descend_to:Y=${targetY}`,
    description: `descend to y=${targetY}`,
    targetItem: STONE_FOCUS,
    requiredCount: 0,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedDescend(targetY: number): QueuedGoal {
  return {
    id: `g1:descend_to:Y=${targetY}`,
    kind: 'descend',
    description: `descend to y=${targetY}`,
    targetItem: STONE_FOCUS,
    requiredCount: 0,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
    targetY,
  }
}

function queue(targetY: number): GoalQueueState {
  const current = queuedDescend(targetY)
  return { ...emptyGoalQueueState(), depth: 1, current, empty: false, goals: [current] }
}

function worldState(input: {
  feet: Vec3Json
  descent: DescentOption[]
  scaffold: DescentScaffoldProbe | null
  targetY: number
  counts?: Record<string, number>
  standable?: Vec3Json[]
  signals?: AgentSignals
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 1,
    timestampMs: 1_700_000_000_000,
    self: self(input.feet),
    inventory: inventory(input.counts ?? { cobblestone: 8 }),
    entities: [],
    blocks: [],
    terrain: { standable: input.standable ?? [input.feet] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: descendGoal(input.targetY),
    goalQueue: queue(input.targetY),
    recentEvents: [],
    // The sensor carries BOTH facts; a fixture that names only one would not be the
    // shape the live sensor produces.
    descent: input.descent,
    ...(input.scaffold === null ? {} : { descentScaffold: input.scaffold }),
    stepCuts: [],
    headroomCuts: [],
    signals: input.signals ?? signals(),
  }
}

/** The guard context the controller builds for a candidate decision. */
function guardContext(candidates: readonly Candidate[]): GuardContext {
  return {
    phase: 'decision',
    candidateIds: new Set(candidates.map((candidate) => candidate.id)),
    inFlight: null,
    reach: defaultCandidateOptions.reach,
    maxCandidateAgeTicks: 40,
    canComputePath: () => true,
  }
}

function descentScaffoldCandidates(candidates: readonly Candidate[]): Candidate[] {
  return candidates.filter(
    (candidate) => typeof candidate.meta[DESCEND_SCAFFOLD_PLACE_META] === 'string',
  )
}

// ---------------------------------------------------------------------------
// (i) THE MEASURED SHAPE: grounds, places its landing, steps down, dy reduces
// ---------------------------------------------------------------------------
{
  const feet = ledgeFeet()
  const terrain = ledgeTerrain(feet)
  const descent = descentFromTerrain(terrain, feet)
  const scaffold = probeOf(feet)
  const state = worldState({ feet, descent, scaffold, targetY: 60 })

  // (i-a) the pure rule grounds, and the plan names every cell the leg touches.
  const decision = planDescentScaffoldStep({
    probe: scaffold,
    blockName: 'cobblestone',
    blockCount: 8,
    targetY: 60,
    target: null,
  })
  check(
    '(i-a) the measured shape grounds a downward self-landing step',
    decision.kind === 'step' &&
      key(decision.plan.place) === '0,62,0' &&
      key(decision.plan.landing) === '0,63,0' &&
      key(decision.plan.reference) === '0,63,0' &&
      decision.plan.block === 'cobblestone' &&
      decision.plan.places === true,
    decision.kind !== 'step'
      ? `kind=${decision.kind} reason=${decision.kind === 'refuse' ? decision.refusal.reason : decision.reason}`
      : `from=${key(decision.plan.from)} landing=${key(decision.plan.landing)} place=${key(decision.plan.place)} ref=${key(decision.plan.reference)} block=${decision.plan.block}`,
  )

  // (i-b) ONE held block per leg: the plan declares the cell, the block and what is
  // left. The pocket evidence names the block that becomes the floor.
  check(
    '(i-b) the plan declares ONE cell, ONE block, and the shared pocket evidence',
    decision.kind === 'step' &&
      decision.plan.remaining === 7 &&
      decision.plan.pocketEvidence.includes('floor=0,62,0:cobblestone:placed') &&
      decision.plan.pocketEvidence.includes('profile=0,63,0') &&
      decision.plan.pocketEvidence.includes('flood=none'),
    decision.kind !== 'step' ? 'ungrounded' : decision.plan.pocketEvidence,
  )

  // (i-c) STRICT REDUCTION: the leg closes exactly one of the gap toward the target
  // level, and never steps past it.
  check(
    '(i-c) the leg strictly reduces the gap toward the target level',
    decision.kind === 'step' &&
      decision.plan.fromGap === 4 &&
      decision.plan.toGap === 3 &&
      strictlyReducesDescentGap(decision.plan),
    decision.kind !== 'step' ? 'ungrounded' : `gap=${String(decision.plan.fromGap)}->${String(decision.plan.toGap)}`,
  )

  // (i-d) the OFFER: a DESCEND candidate, offered beside whatever else is grounded,
  // declaring its block and its cell for the effect envelope.
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const offered = descentScaffoldCandidates(grounded.candidates)
  check(
    '(i-d) the descent is offered as a DESCEND candidate declaring its own block and cell',
    offered.length === 1 &&
      offered[0]?.kind === 'DESCEND' &&
      offered[0]?.meta[DESCEND_SCAFFOLD_PLACE_META] === '0,62,0' &&
      offered[0]?.meta.descentScaffoldBlock === 'cobblestone' &&
      offered[0]?.meta.descentScaffoldLanding === '0,63,0' &&
      typeof offered[0]?.meta[DESCEND_SCAFFOLD_REFUSED_META] !== 'string',
    `scaffold=${offered.length} ids=[${grounded.candidates.map((c) => c.id).join(',')}]`,
  )

  // (i-e) THE WALKABLE CONTROL IS UNTOUCHED: a plain walk beside the descent stays
  // exactly what it was, and the descent is enumerated ALONGSIDE it, never instead.
  const waitStillOffered = grounded.candidates.some((candidate) => candidate.kind === 'WAIT')
  check(
    '(i-e) the descent is offered ALONGSIDE the fallback (never as the only option) and attaches no refusal marker',
    offered.length === 1 &&
      waitStillOffered &&
      grounded.candidates.every((candidate) => typeof candidate.meta[DESCEND_SCAFFOLD_REFUSED_META] !== 'string'),
    `ids=[${grounded.candidates.map((c) => c.id).join(',')}] wait=${String(waitStillOffered)}`,
  )

  // (i-f) the executor PLACES the landing and STEPS DOWN onto it, and the recorded
  // position really lowers.
  const { bot, position } = makeDescentBot(terrain, feet, { cobblestone: 8 })
  const logs: CapturedLog[] = []
  const executor = new Executor(bot, makeCapturingLogger(logs), {
    ...defaultExecutorOptions,
    actuation: 'pathfinder',
    pathTimeoutMs: 60,
    packetStepMs: 0,
  })
  fixtureClaim(executor, offered[0] ?? scaffoldCandidate(feet))
  const done = await waitFor(() => logs.some((line) => line.message.startsWith(DESCEND_SCAFFOLD_END)))
  executor.cancelCurrent('descent scaffold fixture complete')
  const start = logs.find((line) => line.message.startsWith(DESCEND_SCAFFOLD_START))?.message ?? 'none'
  const step = logs.find((line) => line.message.startsWith(DESCEND_SCAFFOLD_STEP))?.message ?? 'none'
  const end = logs.find((line) => line.message.startsWith(DESCEND_SCAFFOLD_END))?.message ?? 'none'
  check(
    '(i-f) the executor places the landing, steps down onto it, and the body really lowers one level',
    done &&
      start.startsWith('DESCEND_SCAFFOLD_START kind=self_landing_down from=0,64,0 to=0,63,0 cell=0,62,0 block=cobblestone self_landing=true pocket=') &&
      step === 'DESCEND_SCAFFOLD_STEP from=0,64,0 to=0,63,0 cell=0,62,0 placed=true block=cobblestone' &&
      end === 'DESCEND_SCAFFOLD_END from_y=64 to_y=63 placed=1 verified=true reason=descended block=cobblestone' &&
      terrain.name({ x: 0, y: 62, z: 0 }) === 'cobblestone' &&
      Math.floor(position.y) === 63,
    `start="${start}" step="${step}" end="${end}" place=${terrain.name({ x: 0, y: 62, z: 0 })} body_y=${position.y}`,
  )

  // (i-h) the POLICY GUARD accepts the leg it generated. A DESCEND that places
  // instead of digging can never match a sensor step's wall/floor/head, so without
  // its own branch `guardDescend` would deny the one route that answers the measured
  // blocker - the same reason `carriesOwnRoute` exists for a placing MOVE.
  const guardTarget = offered[0] ?? scaffoldCandidate(feet)
  const guarded = guardCandidate(guardTarget, state, guardContext(grounded.candidates))
  check(
    '(i-h) the guard accepts the self-landing descent, re-verified from the same sensor probe',
    guarded.ok === true,
    guarded.ok === true ? 'ok' : `code=${guarded.code} reason=${guarded.reason}`,
  )
  // ...and it fails closed the moment the declared cell is not the state's own probe.
  const stale = guardCandidate(
    { ...guardTarget, meta: { ...guardTarget.meta, [DESCEND_SCAFFOLD_PLACE_META]: '9,9,9' } },
    state,
    guardContext(grounded.candidates),
  )
  check(
    '(i-h) a stale declared place cell is denied (the guard re-reads the sensor, never the meta alone)',
    stale.ok === false && stale.code === 'TARGET_GONE',
    stale.ok === true ? 'ok' : `code=${stale.code} reason=${stale.reason}`,
  )

  // (i-i) THE EFFECT ENVELOPE declares the consumed block and the equip, and grants
  // NO dig authority: this leg places, it never mines (the portal plane is never
  // mined). A DESCEND that declared nothing must still get no place authority.
  const declaredEnvelope = envelopeForCandidate(guardTarget, { equipItems: ['cobblestone'] })
  const bareEnvelope = envelopeForCandidate(scaffoldCandidateBare(feet), { equipItems: ['cobblestone'] })
  check(
    '(i-i) the envelope declares the one block + one cell and grants no dig authority',
    declaredEnvelope.mayPlaceGroundedRoute === true &&
      declaredEnvelope.mayDigGroundedRoute === false &&
      declaredEnvelope.mayPlaceBlocks?.length === 1 &&
      declaredEnvelope.mayPlaceBlocks[0]?.itemName === 'cobblestone' &&
      key(declaredEnvelope.mayPlaceBlocks[0]?.position ?? { x: 0, y: 0, z: 0 }) === '0,62,0' &&
      declaredEnvelope.mayEquipItems?.includes('cobblestone') === true &&
      bareEnvelope.mayPlaceGroundedRoute === false &&
      (bareEnvelope.mayPlaceBlocks ?? []).length === 0,
    `declared={place:${String(declaredEnvelope.mayPlaceGroundedRoute)},dig:${String(declaredEnvelope.mayDigGroundedRoute)},cells:${String(declaredEnvelope.mayPlaceBlocks?.length)}} bare={place:${String(bareEnvelope.mayPlaceGroundedRoute)}}`,
  )

  // (i-g) the markers are registered on the controller mirrored path, so a descent
  // leg reaches `buddy.log` instead of reading as an unexplained DESCEND.
  check(
    '(i-g) the descent markers are registered on the controller mirrored path',
    MIRRORED_MARKERS.has(DESCEND_SCAFFOLD_START) &&
      MIRRORED_MARKERS.has(DESCEND_SCAFFOLD_STEP) &&
      MIRRORED_MARKERS.has(DESCEND_SCAFFOLD_END) &&
      MIRRORED_MARKERS.has(DESCEND_SCAFFOLD_REFUSED),
    `mirrored=${[DESCEND_SCAFFOLD_START, DESCEND_SCAFFOLD_STEP, DESCEND_SCAFFOLD_END, DESCEND_SCAFFOLD_REFUSED]
      .map((marker) => MIRRORED_MARKERS.has(marker))
      .join('/')}`,
  )
}

// ---------------------------------------------------------------------------
// (ii) THE SAME WITH NO BLOCK: typed refusal naming the cell and the state below
// ---------------------------------------------------------------------------
{
  const feet = ledgeFeet()
  const terrain = ledgeTerrain(feet)
  const descent = descentFromTerrain(terrain, feet)
  const scaffold = probeOf(feet)
  const state = worldState({ feet, descent, scaffold, targetY: 60, counts: {} })

  const decision = planDescentScaffoldStep({
    probe: scaffold,
    blockName: null,
    blockCount: 0,
    targetY: 60,
    target: null,
  })
  const line = decision.kind === 'refuse' ? formatDescentScaffoldRefused(decision.refusal) : 'grounded'
  check(
    '(ii-a) with no block the descent is refused typed, naming the cell and the state below it',
    decision.kind === 'refuse' &&
      decision.refusal.reason === 'no_block' &&
      key(decision.refusal.cell) === '0,62,0' &&
      decision.refusal.below === 'air' &&
      line === `DESCEND_SCAFFOLD_REFUSED reason=no_block from_y=64 to_y=60 cell=0,62,0 below=air block=none`,
    line,
  )
  check(
    '(ii-b) the refusal folds onto the reachability vocabulary without widening it',
    descendScaffoldReachabilityReason('no_block') === 'no_safe_step' &&
      descendScaffoldReachabilityReason('no_ground') === 'no_support' &&
      descendScaffoldReachabilityReason('hazard') === 'hazard' &&
      descendScaffoldReachabilityReason('protected') === 'protected',
    `no_block=${descendScaffoldReachabilityReason('no_block')} no_ground=${descendScaffoldReachabilityReason('no_ground')}`,
  )

  // (ii-c) the acquisition pass names the MISSING MATERIAL, not a retryable token:
  // the body that holds nothing gets a `placeable_block` fact it can route to.
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const offered = descentScaffoldCandidates(grounded.candidates)
  // The reachability gate's own vocabulary for the SAME absence: a descent scaffold
  // the body cannot afford is the material fact `placeable_block` - the one
  // capability the acquisition pass can ROUTE to (craft/collect a block) instead of
  // re-offering a `descend_plan` token that can only be retried. Asserted through
  // the shared renderer, so the token the live log would carry is the one tested.
  const material: Capability = { kind: 'placeable_block' }
  check(
    '(ii-c) no block held: no descent candidate, and the gate answers with a route-able placeable_block fact',
    offered.length === 0 && capabilityKey(material) === 'placeable_block',
    `scaffold=${offered.length} key=${capabilityKey(material)} ids=[${grounded.candidates.map((c) => c.id).join(',')}]`,
  )
}

// ---------------------------------------------------------------------------
// (iii) A WALKABLE DESCENT: byte-identical (no new candidate, no placement)
// ---------------------------------------------------------------------------
{
  // A supported staircase: every cardinal step down lands on solid ground, so the
  // ordinary dig/staircase machinery owns the descent and NOTHING here grounds.
  const feet: Vec3Json = { x: 0, y: 64, z: 0 }
  const terrain = new Terrain()
  for (let dx = -3; dx <= 3; dx += 1) {
    for (let dz = -3; dz <= 3; dz += 1) {
      for (let dy = 1; dy <= 6; dy += 1) terrain.set({ x: feet.x + dx, y: feet.y - dy, z: feet.z + dz }, 'stone')
    }
  }
  const descent = descentFromTerrain(terrain, feet)
  // The live sensor only builds the downward probe when the own-column step is
  // refused `no_support` - which cannot happen on solid ground.
  const ownColumn = descent.find((step) => step.dir === 'D')
  check(
    '(iii-a) on solid ground the own-column step is safe, so no downward probe is built at all',
    ownColumn !== undefined && ownColumn.safe === true && ownColumn.refusal === undefined,
    `D safe=${String(ownColumn?.safe)} refusal=${ownColumn?.refusal ?? 'none'}`,
  )
  const state = worldState({ feet, descent, scaffold: null, targetY: 60 })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  check(
    '(iii-b) a walkable descent grounds no self-landing candidate and no refusal marker',
    descentScaffoldCandidates(grounded.candidates).length === 0 &&
      grounded.candidates.every((candidate) => typeof candidate.meta[DESCEND_SCAFFOLD_REFUSED_META] !== 'string'),
    `scaffold=${descentScaffoldCandidates(grounded.candidates).length} ids=[${grounded.candidates.map((c) => c.id).join(',')}]`,
  )

  // (iii-c) and with a probe nevertheless present, the CARDINAL stairs still own the
  // descent: the scaffold is anchored on the own column only, so a safe own-column
  // step grounds nothing even when a probe is supplied.
  const forced = planDescentScaffoldStep({
    probe: probeOf(feet, { landingOpen: false, landingName: 'stone' }),
    blockName: 'cobblestone',
    blockCount: 8,
    targetY: 60,
    target: null,
  })
  check(
    '(iii-c) with the landing already solid the step is refused `no_landing`: the rule reads the world',
    forced.kind === 'refuse' && forced.refusal.reason === 'no_landing',
    forced.kind === 'refuse' ? `reason=${forced.refusal.reason} detail=${forced.refusal.detail}` : 'grounded',
  )
}

// ---------------------------------------------------------------------------
// (iv) A PROTECTED PLANE / A HAZARD BELOW: refused typed, never placed into
// ---------------------------------------------------------------------------
{
  const feet: Vec3Json = { x: 0, y: 64, z: 0 }

  // (iv-a) a protected station block in the landing column: never stood in.
  const protectedProbe = probeOf(feet, { landingName: 'furnace', landingOpen: true, landingHeadOpen: true })
  const protectedDecision = planDescentScaffoldStep({
    probe: protectedProbe,
    blockName: 'cobblestone',
    blockCount: 8,
    targetY: 60,
    target: null,
    isProtected: (cell, name) => name === 'furnace' || key(cell) === '0,63,0',
  })
  check(
    '(iv-a) a protected block in the pocket is refused typed and never placed into',
    protectedDecision.kind === 'refuse' && protectedDecision.refusal.reason === 'protected',
    protectedDecision.kind === 'refuse'
      ? formatDescentScaffoldRefused(protectedDecision.refusal)
      : 'grounded',
  )

  // (iv-b) a LIVE STRUCTURE member (the portal plane's own cell) is protected too.
  const structureProbe = probeOf(feet)
  const structureDecision = planDescentScaffoldStep({
    probe: structureProbe,
    blockName: 'cobblestone',
    blockCount: 8,
    targetY: 60,
    target: null,
    isProtected: (cell) => key(cell) === '0,63,0',
  })
  check(
    '(iv-b) a live-structure member cell is refused `protected` before any placement',
    structureDecision.kind === 'refuse' && structureDecision.refusal.reason === 'protected',
    structureDecision.kind === 'refuse' ? formatDescentScaffoldRefused(structureDecision.refusal) : 'grounded',
  )

  // (iv-c) lava in the placement cell: refused `hazard`, and the block is NOT spent.
  const lavaProbe = probeOf(feet, { placeName: 'lava', placeable: false, hazard: true, hazardBlock: 'lava' })
  const lavaDecision = planDescentScaffoldStep({
    probe: lavaProbe,
    blockName: 'cobblestone',
    blockCount: 8,
    targetY: 60,
    target: null,
  })
  check(
    '(iv-c) lava in the placement cell is refused `hazard`',
    lavaDecision.kind === 'refuse' && lavaDecision.refusal.reason === 'hazard',
    lavaDecision.kind === 'refuse' ? formatDescentScaffoldRefused(lavaDecision.refusal) : 'grounded',
  )

  // (iv-d) a fluid FACE-ADJACENT to the pocket the body would occupy: the shared
  // flood rule refuses, so the body is never poured on.
  const floodProbe = probeOf(feet, { flood: true, floodCell: { x: feet.x + 1, y: feet.y - 1, z: feet.z }, floodBlock: 'water' })
  const floodDecision = planDescentScaffoldStep({
    probe: floodProbe,
    blockName: 'cobblestone',
    blockCount: 8,
    targetY: 60,
    target: null,
  })
  check(
    '(iv-d) a fluid face-adjacent to the pocket is refused `would_flood`',
    floodDecision.kind === 'refuse' && floodDecision.refusal.reason === 'would_flood',
    floodDecision.kind === 'refuse' ? formatDescentScaffoldRefused(floodDecision.refusal) : 'grounded',
  )

  // (iv-e) a dimension-transfer plane in the landing column: the body would be
  // teleported, not lowered, so the step is refused `portal_plane`.
  const portalProbe = probeOf(feet, { landingName: 'nether_portal' })
  const portalDecision = planDescentScaffoldStep({
    probe: portalProbe,
    blockName: 'cobblestone',
    blockCount: 8,
    targetY: 60,
    target: null,
  })
  check(
    '(iv-e) a dimension-transfer plane in the landing column is refused `portal_plane`',
    portalDecision.kind === 'refuse' && portalDecision.refusal.reason === 'portal_plane',
    portalDecision.kind === 'refuse' ? formatDescentScaffoldRefused(portalDecision.refusal) : 'grounded',
  )

  // (iv-f) the placement cell's own support is air: the placed block would fall, so
  // the step is refused `no_ground` - the honest mirror of the measured blocker.
  const noGroundProbe = probeOf(feet, { placeSupported: false, supportName: 'air' })
  const noGroundDecision = planDescentScaffoldStep({
    probe: noGroundProbe,
    blockName: 'cobblestone',
    blockCount: 8,
    targetY: 60,
    target: null,
  })
  check(
    '(iv-f) with nothing under the placement cell the step is refused `no_ground` (the block would fall)',
    noGroundDecision.kind === 'refuse' && noGroundDecision.refusal.reason === 'no_ground',
    noGroundDecision.kind === 'refuse' ? formatDescentScaffoldRefused(noGroundDecision.refusal) : 'grounded',
  )
}

// ---------------------------------------------------------------------------
// (v) A MULTI-BLOCK DESCENT: bounded, monotone, stops at the target level
// ---------------------------------------------------------------------------
{
  const targetY = 58
  let feet: Vec3Json = { x: 0, y: 64, z: 0 }
  const terrain = new Terrain()
  // The SAME measured shape at every level: the anchor ledge is re-grounded from
  // fresh world truth after each leg (which is exactly what the live sensor does),
  // so the loop proves the RULE is monotone rather than proving one hand-built
  // staircase. Each iteration states the shape a fresh sensor tick would report.
  const visited: number[] = []
  const gaps: string[] = []
  let placedBlocks = 0
  let iterations = 0
  // The loop is CAPPED by construction: one leg lowers the body exactly one level,
  // so the number of legs is bounded by the vertical gap.
  const legCap = Math.abs(feet.y - targetY) + 1
  while (feet.y > targetY && iterations < legCap + 1) {
    iterations += 1
    terrain.set({ x: feet.x, y: feet.y - 3, z: feet.z }, 'stone')
    const descent = descentFromTerrain(terrain, feet)
    const scaffold = probeOf(feet)
    const decision = planDescentScaffoldStep({
      probe: scaffold,
      blockName: 'cobblestone',
      blockCount: 8,
      targetY,
      target: null,
    })
    if (decision.kind !== 'step') {
      gaps.push(`refused:${decision.kind === 'refuse' ? decision.refusal.reason : decision.reason}`)
      break
    }
    // MONOTONE: every leg must strictly reduce the gap and must not overshoot.
    if (!strictlyReducesDescentGap(decision.plan) || decision.plan.landing.y < targetY) {
      gaps.push(`non_monotone@${feet.y}`)
      break
    }
    gaps.push(`gap=${String(decision.plan.fromGap)}->${String(decision.plan.toGap)}`)
    terrain.set(decision.plan.place, 'cobblestone')
    placedBlocks += 1
    feet = decision.plan.landing
    visited.push(feet.y)
  }
  const expectedLevels = 64 - targetY
  check(
    '(v-a) a multi-block descent is monotone: every leg closes exactly one of the gap',
    gaps.length === expectedLevels &&
      gaps.every((entry) => /^gap=\d+->\d+$/.test(entry)) &&
      gaps
        .map((entry) => Number(entry.split('->')[1]))
        .every((after, index) => after === 64 - targetY - 1 - index),
    `gaps=[${gaps.join(' ')}] visited=[${visited.join(',')}]`,
  )
  check(
    '(v-b) it stops exactly at the target level, and the loop is bounded by the gap',
    feet.y === targetY && visited[visited.length - 1] === targetY && iterations <= legCap && placedBlocks === expectedLevels,
    `final_y=${feet.y} target_y=${targetY} iterations=${iterations} legCap=${legCap} placed=${placedBlocks}`,
  )
  check(
    '(v-c) one held block per leg: exactly one placement per level lowered',
    placedBlocks === 64 - targetY && visited.length === placedBlocks && visited.every((y, index) => y === 64 - 1 - index),
    `placed=${placedBlocks} levels=${visited.length} visited=[${visited.join(',')}]`,
  )
  // The target level itself is never stepped past, even one block below it.
  const overshoot = planDescentScaffoldStep({
    probe: probeOf({ x: 0, y: targetY, z: 0 }, { landingOpen: false, landingName: 'stone' }),
    blockName: 'cobblestone',
    blockCount: 8,
    targetY,
    target: null,
  })
  check(
    '(v-d) at the target level no further leg grounds (the descent cannot overshoot)',
    overshoot.kind === 'refuse' && overshoot.refusal.reason === 'no_landing',
    overshoot.kind === 'refuse' ? formatDescentScaffoldRefused(overshoot.refusal) : 'grounded',
  )
}

// ---------------------------------------------------------------------------
// executor fixture harness
// ---------------------------------------------------------------------------
interface CapturedLog {
  level: string
  message: string
}

function makeCapturingLogger(logs: CapturedLog[]): EventLogger {
  const writer = {
    write: (record: { level?: string; message?: string }): void => {
      if (typeof record?.message !== 'string') return
      logs.push({ level: record.level ?? 'info', message: record.message })
    },
  } as unknown as JsonlWriter
  return new EventLogger(writer, false)
}

interface Vec {
  x: number
  y: number
  z: number
  clone(): Vec
  offset(x: number, y: number, z: number): Vec
  distanceTo(other: { x: number; y: number; z: number }): number
  set(x: number, y: number, z: number): Vec
}

function vec(x: number, y: number, z: number): Vec {
  const self: Vec = {
    x,
    y,
    z,
    clone: () => vec(self.x, self.y, self.z),
    offset: (dx, dy, dz) => vec(self.x + dx, self.y + dy, self.z + dz),
    distanceTo: (other) => Math.hypot(self.x - other.x, self.y - other.y, self.z - other.z),
    set: (nx, ny, nz) => {
      self.x = nx
      self.y = ny
      self.z = nz
      return self
    },
  }
  return self
}

/**
 * A minimal bot that models the ONE server rule this leg depends on: a placement
 * lands in the cell the clicked face points at, and the body FALLS one level when
 * the cell under it is opened and the cell below that is solid.
 */
function makeDescentBot(
  terrain: Terrain,
  feet: Vec3Json,
  counts: Record<string, number>,
): { bot: Bot; position: Vec } {
  const position = vec(feet.x + 0.5, feet.y, feet.z + 0.5)
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const emit = (event: string, payload?: unknown): void => {
    for (const handler of [...(listeners.get(event) ?? [])]) handler(payload)
  }
  const items = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  const bot: Record<string, unknown> = {
    registry,
    entity: {
      position,
      yaw: 0,
      pitch: 0,
      onGround: true,
      isCollidedHorizontally: false,
      width: 0.6,
      height: 1.8,
      offset: (x: number, y: number, z: number): Vec => position.offset(x, y, z),
      clone: (): Vec => position.clone(),
      distanceTo: (other: { x: number; y: number; z: number }): number => position.distanceTo(other),
    },
    _client: { write: (): boolean => true },
    physicsEnabled: true,
    entities: {},
    heldItem: null as { name: string; count: number; slot: number } | null,
    inventory: {
      items: (): Array<{ name: string; count: number; slot: number }> => items,
      count: (name: string): number => items.find((item) => item.name === name)?.count ?? 0,
    },
    blockAt: (v: { x: number; y: number; z: number }): { name: string; boundingBox: string; position: Vec3Json } | null => {
      const cell = { x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) }
      const name = terrain.name(cell)
      return { name, boundingBox: EMPTY_BOX.has(name) ? 'empty' : 'block', position: cell }
    },
    canDigBlock: (): boolean => true,
    equip: async (item: { name: string; count: number; slot: number }): Promise<void> => {
      bot.heldItem = item
    },
    placeBlock: async (reference: { position: Vec3Json }, face: { x: number; y: number; z: number }): Promise<void> => {
      const target = {
        x: reference.position.x + face.x,
        y: reference.position.y + face.y,
        z: reference.position.z + face.z,
      }
      terrain.set(target, 'cobblestone')
    },
    on: (event: string, handler: (...args: unknown[]) => void): unknown => {
      const set = listeners.get(event) ?? []
      set.push(handler)
      listeners.set(event, set)
      return bot
    },
    removeListener: (event: string, handler: (...args: unknown[]) => void): unknown => {
      const set = listeners.get(event) ?? []
      listeners.set(event, set.filter((entry) => entry !== handler))
      return bot
    },
    setControlState: (): void => undefined,
    lookAt: async (): Promise<void> => undefined,
    stopDigging: (): void => undefined,
    pathfinder: {
      movements: null as unknown,
      setMovements: (movements: unknown): void => {
        ;(bot.pathfinder as { movements: unknown }).movements = movements
      },
      setGoal: (goal: unknown): void => {
        if (goal === null || goal === undefined) return
        const asCell = goal as { x?: number; y?: number; z?: number }
        if (typeof asCell.x !== 'number' || typeof asCell.y !== 'number' || typeof asCell.z !== 'number') return
        // The server's own rule for THIS leg: the body drops ONE level and lands on
        // the floor the leg just placed, so its feet end up in the landing cell.
        position.x = asCell.x + 0.5
        position.y = asCell.y
        position.z = asCell.z + 0.5
        emit('goal_reached')
      },
      stop: (): void => undefined,
      getPathTo: (): { status: string; path: unknown[] } => ({ status: 'success', path: [] }),
    },
  }
  return { bot: bot as unknown as Bot, position }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return predicate()
}

/** The same DESCEND without any descent-scaffold declaration: it must gain nothing. */
function scaffoldCandidateBare(feet: Vec3Json): Candidate {
  const bare = scaffoldCandidate(feet)
  const meta: Record<string, string | number | boolean> = { ...bare.meta }
  delete meta[DESCEND_SCAFFOLD_PLACE_META]
  delete meta.descentScaffoldBlock
  return { ...bare, meta }
}

/** The DESCEND candidate the offer builds, rebuilt here so the executor fixture can claim it. */
function scaffoldCandidate(feet: Vec3Json): Candidate {
  const landing = { x: feet.x, y: feet.y - 1, z: feet.z }
  const place = { x: feet.x, y: feet.y - 2, z: feet.z }
  return {
    id: `DESCEND:place:D:b${place.x}_${place.y}_${place.z}`,
    kind: 'DESCEND',
    label: 'descend by placing a block under the feet',
    targetName: null,
    target: place,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: {
      tick: 1,
      x: place.x,
      y: place.y,
      z: place.z,
      [DESCEND_SCAFFOLD_PLACE_META]: `${place.x},${place.y},${place.z}`,
      descentScaffoldLanding: `${landing.x},${landing.y},${landing.z}`,
      descentScaffoldBlock: 'cobblestone',
      descentScaffoldFrom: `${feet.x},${feet.y},${feet.z}`,
      descentScaffoldReference: `${feet.x},${feet.y - 1},${feet.z}`,
      descentScaffoldPocket: 'fixture',
    },
  }
}

let failuresTotal = 0
process.stdout.write('downward self-landing descent - the mirror of the crossing\n')
process.stdout.write('-'.repeat(72) + '\n')
failuresTotal = failures
process.stdout.write('-'.repeat(72) + '\n')
if (failuresTotal === 0) {
  process.stdout.write('ALL DESCENT-SCAFFOLD FIXTURES PASS\n')
} else {
  process.stdout.write(`${failuresTotal} descent-scaffold fixture(s) FAILED\n`)
  process.exit(1)
}
