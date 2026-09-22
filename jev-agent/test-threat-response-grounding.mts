// test-threat-response-grounding.mts - P1 durability: an ENGAGED attacker must
// have a grounded response, and no keep-distance realization may cross a
// dimension.
//
// Measured live (main 1453724, `run-mucgir1z-1p7oh`):
//
//   THREAT_NEARBY threat=skeleton threatId=30465 distance=8.93 contact=false
//     danger=false entryReason=engaged activeMs=20572 weapon=stone
//   THREAT_NO_ESCAPE threat=skeleton distance=8.93 inContact=false
//     reason=no_grounded_threat_response
//   actions: ENTER:26,67,9 (the OVERWORLD gate) <-> MOVE:p5_59_-3 (inside the
//     Nether portal area)
//   DIMENSION_OBSERVED: the_nether -> overworld -> the_nether -> overworld ->
//     the_nether, 30-90 s apart (186 transition records)
//
// Two independent defects made that shape possible:
//
//   1. NO GROUNDED RESPONSE AT 8.93 m. The ATTACK offer was bounded by
//      `COMBAT_CANDIDATE_RANGE` (8 m, the melee reaction envelope) while the
//      danger STATE answers an engaged attacker out to `THREAT_RESPONSE_RANGE`
//      (24 m). A skeleton inside its own firing band but outside melee therefore
//      produced no attack candidate at all; the only grounded keep-distance
//      cells in the portal room were cells of the portal itself.
//   2. A RETREAT REALIZATION COULD CROSS A DIMENSION. Every "away" cell gained
//      separation by standing in the lit portal, so "move away from the threat"
//      was realized as a dimension change - which does not keep distance at all,
//      it abandons the objective, and in this geometry it walks straight back
//      into the same skeleton. A dimension change is a semantic disengage
//      (Jev/System2, the explicit `ENTER_PORTAL` candidate), never a mechanical
//      keep-distance leg.
//
// What is pinned here, in fixture order:
//   (i)   engaged attacker at ~9 m, reachable -> a grounded response EXISTS
//         (approach + attack on that SAME entity, and/or a reposition), and no
//         dimension-crossing retreat is offered;
//   (ii)  the only "away" cells are through a portal -> the crossing retreat is
//         never offered and never realized, while the explicit entry stays;
//   (iii) a hostile IN CONTACT -> unchanged (the survival envelope owns it);
//   (iv)  a genuinely unanswerable threat -> the typed no-response path still
//         exists and does not oscillate;
//   (v)   ordinary walking with no threat -> unchanged offer, no new facts.
//
//   bun jev-agent/test-threat-response-grounding.mts
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import {
  applyGroundedThreatRestriction,
  applyReachabilityGate,
  applyThreatRestriction,
  defaultCandidateOptions,
  generateCandidates,
  generateGroundedCandidates,
  THREAT_SURVIVAL_KINDS,
} from './src/candidates.ts'
import type { Candidate, CandidateOptions, ReachabilityGateOptions } from './src/candidates.ts'
import { buildWorldState, defaultSensorOptions } from './src/state.ts'
import type { AgentSignals, EntityState, GoalState, InventoryState, LastDamageEvidence, SelfState, Vec3Json, WorldState } from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import {
  MELEE_THREAT_REACH,
  MIN_KEEP_DISTANCE_GAIN,
  MOB_IDENTITY_CHURN,
  IDENTITY_CHURN_RADIUS,
  IDENTITY_CHURN_WINDOW_MS,
  formatMobIdentityChurn,
  formatSurvivalReground,
  identityChurnCandidate,
  regroundVanishedSurvivalChoice,
  survivalControlFallback,
  selectKeepDistanceSpots,
  THREAT_CLEAR_MS,
  THREAT_DANGER_RADIUS,
  THREAT_RESPONSE_RANGE,
  ThreatTracker,
} from './src/threat.ts'
import { MIRRORED_MARKERS } from './src/controller.ts'

const require = createRequire(import.meta.url)

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const NOW = 1_700_000_000_000
const NETHER = 'minecraft:the_nether'
/** the body's own gate: the 2x3 interior cells are transfer cells */
const PORTAL_FEET: Vec3Json = { x: 4, y: 59, z: -3 }
const PORTAL_HEAD: Vec3Json = { x: 4, y: 60, z: -3 }
const OVERWORLD_GATE: Vec3Json = { x: 26, y: 67, z: 9 }
const BODY: Vec3Json = { x: 5, y: 59, z: 0 }
/** the measured attacker: exactly 8.93 m from the body, in its own firing band */
const SKELETON: Vec3Json = { x: 5, y: 59, z: 8.93 }

function selfState(position: Vec3Json, overrides: Partial<SelfState> = {}): SelfState {
  return {
    username: 'AI_M3THREAT',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: NETHER,
    isDay: false,
    heldItem: null,
    ...overrides,
  }
}

function goalState(): GoalState {
  return {
    id: 'collect:blaze_rod',
    description: 'collect 7 x blaze_rod',
    targetItem: 'blaze_rod',
    requiredCount: 7,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(): QueuedGoal {
  return {
    id: 'g1:collect:blaze_rod',
    kind: 'collect',
    description: 'collect 7 x blaze_rod',
    targetItem: 'blaze_rod',
    requiredCount: 7,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function queue(): GoalQueueState {
  const goal = queuedGoal()
  return { depth: 1, current: goal, empty: false, hasImpossible: false, done: 0, goals: [goal] }
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
    lastDamage: null,
    ...overrides,
  }
}

function entity(
  id: number,
  name: string,
  position: Vec3Json,
  hostile: boolean,
  overrides: Partial<EntityState> = {},
  from: Vec3Json = BODY,
): EntityState {
  const distance = Math.sqrt((position.x - from.x) ** 2 + (position.y - from.y) ** 2 + (position.z - from.z) ** 2)
  return {
    id,
    name,
    kind: hostile ? 'hostile' : 'passive',
    username: null,
    position,
    distance: Math.round(distance * 100) / 100,
    hostile,
    lineOfSight: true,
    heldItem: null,
    health: 20,
    attackedSelf: false,
    ...overrides,
  }
}

/**
 * The measured situation: the body is in the Nether portal room with an engaged
 * skeleton 8.93 m away. `lastDamage` is the arrow that engaged it - the recorded
 * source is the projectile, so `attackedSelf` stays false and the threat is
 * response-worthy through the code-owned "line of sight after damage" path, the
 * exact shape of the measured `entryReason=engaged engaged=false` line.
 */
function measuredBody(overrides: Partial<WorldState> = {}, skeletonOverrides: Partial<EntityState> = {}): WorldState {
  const inventory: InventoryState = { slots: [], counts: {}, totalItems: 0 }
  const skeleton = entity(30465, 'skeleton', SKELETON, true, skeletonOverrides)
  const arrow: LastDamageEvidence = { atMs: NOW - 1000, health: 12, sourceId: 9001, sourceName: 'arrow' }
  const state: WorldState = {
    schemaVersion: 1,
    tick: 41,
    timestampMs: NOW,
    self: selfState(BODY, { health: 18, food: 5, heldItem: { name: 'stone_sword', count: 1, slot: 0 } }),
    inventory,
    entities: [skeleton],
    blocks: [],
    terrain: {
      // the local window: the body's cell and one corridor cell toward the gate
      standable: [BODY, { x: 5, y: 59, z: -1 }],
      // the wider threat scan: the ONLY cells that gain separation are the gate
      escapeCells: [PORTAL_FEET, PORTAL_HEAD],
      // real block truth: standing in either of those transfers the body
      portalWalkInCells: [PORTAL_FEET, PORTAL_HEAD],
    },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goalState(),
    goalQueue: queue(),
    recentEvents: [],
    signals: signals({ stalledMs: 61_350, lastDamage: arrow }),
    ...overrides,
  }
  return state
}

/** The tracker observation for a state, so the danger STATE matches the sensor. */
function noteThreat(state: WorldState, atMs = NOW): WorldState {
  return {
    ...state,
    signals: {
      ...state.signals,
      threat: new ThreatTracker().note({ atMs, entities: state.entities, lastDamage: state.signals.lastDamage ?? null }),
    },
  }
}

const ids = (candidates: readonly Candidate[]): string[] => candidates.map((candidate) => candidate.id)
const withProbe = (options: CandidateOptions, reachability: ReachabilityGateOptions): CandidateOptions => ({
  ...options,
  reachability: { ...(options.reachability ?? {}), ...reachability },
})
const targetsTransferCell = (candidate: Candidate, cells: readonly Vec3Json[]): boolean =>
  candidate.target !== null && cells.some((cell) => cell.x === candidate.target?.x && cell.y === candidate.target?.y && cell.z === candidate.target?.z)

const PORTAL_CELLS: Vec3Json[] = [PORTAL_FEET, PORTAL_HEAD]

// ---------------------------------------------------------------------------
// (i) engaged attacker at ~9 m, reachable -> a grounded response EXISTS
// ---------------------------------------------------------------------------

addCase('(i1) the measured 8.93m engaged skeleton is answerable: ATTACK on that SAME entity, no gap', () => {
  const state = noteThreat(measuredBody())
  const evidence = state.signals.threat!
  const generated = generateCandidates(state, defaultCandidateOptions)
  const offer = applyThreatRestriction(state, generated)
  const attack = offer.candidates.find((candidate) => candidate.kind === 'ATTACK')
  const pass =
    // the measured tracker line, reproduced
    evidence.active === true &&
    evidence.entryReason === 'engaged' &&
    evidence.inContact === false &&
    evidence.inDanger === false &&
    evidence.threatDistance === 8.93 &&
    evidence.threatId === 30465 &&
    // the grounded response the measured run did not have
    attack !== undefined &&
    attack.targetEntityId === 30465 &&
    attack.id === 'ATTACK:e30465' &&
    attack.meta.reachability === 'approach' &&
    attack.meta.weapon === 'stone_sword' &&
    // THREAT_NO_ESCAPE is a diagnostic: it must not fire while code grounds one
    offer.gap === null &&
    offer.candidates.every((candidate) => THREAT_SURVIVAL_KINDS.has(candidate.kind))
  return {
    pass,
    detail:
      `active=${evidence.active} reason=${evidence.entryReason} contact=${evidence.inContact} danger=${evidence.inDanger} ` +
      `distance=${evidence.threatDistance} offered=[${ids(offer.candidates).join(',')}] gap=${offer.gap?.reason ?? 'none'}`,
  }
})

addCase('(i2) the engaged approach is grounded by the reachability gate, and withheld when it has no route', () => {
  const state = noteThreat(measuredBody())
  const reachable = generateGroundedCandidates(
    state,
    withProbe(defaultCandidateOptions, { attackPathProbe: () => 'reachable' }),
  )
  const routeless = generateGroundedCandidates(
    state,
    withProbe(defaultCandidateOptions, { attackPathProbe: () => 'no_path' }),
  )
  const reachableAttack = reachable.candidates.find((candidate) => candidate.id === 'ATTACK:e30465')
  const withheldAttack = routeless.withheld.find((entry) => entry.candidate.id === 'ATTACK:e30465')
  const pass =
    reachableAttack !== undefined &&
    withheldAttack !== undefined &&
    withheldAttack.result.reason === 'no_path' &&
    routeless.candidates.every((candidate) => candidate.id !== 'ATTACK:e30465')
  return {
    pass,
    detail: `reachable=[${ids(reachable.candidates).join(',')}] routeless=[${ids(routeless.candidates).join(',')}] withheld=${withheldAttack?.result.reason ?? 'none'}`,
  }
})

addCase('(i3) an away cell that is NOT the portal is offered next to the ATTACK (code ranks neither)', () => {
  const away: Vec3Json = { x: 5, y: 59, z: -6 }
  const state = noteThreat(
    measuredBody({
      terrain: {
        standable: [BODY, { x: 5, y: 59, z: -1 }, away],
        escapeCells: [away],
        portalWalkInCells: [PORTAL_FEET, PORTAL_HEAD],
      },
    }),
  )
  const generated = generateCandidates(state, defaultCandidateOptions)
  const offered = applyThreatRestriction(state, generated)
  const attack = offered.candidates.find((candidate) => candidate.kind === 'ATTACK')
  const retreat = offered.candidates.find((candidate) => candidate.kind === 'RETREAT')
  const pass =
    attack !== undefined &&
    retreat !== undefined &&
    retreat.id === `RETREAT:p${away.x}_${away.y}_${away.z}` &&
    (retreat.meta.separationGain as number) >= MIN_KEEP_DISTANCE_GAIN &&
    offered.gap === null &&
    offered.candidates.every((candidate) => THREAT_SURVIVAL_KINDS.has(candidate.kind))
  return {
    pass,
    detail: `offered=[${ids(offered.candidates).join(',')}] retreatGain=${retreat?.meta.separationGain ?? 'none'} gap=${offered.gap?.reason ?? 'none'}`,
  }
})

addCase('(i4) a cell out of the attacker sight line is a grounded keep-distance destination', () => {
  // Distance cannot answer a ranged attacker in a tight room. The code-owned
  // fact that can is cover: the cell is real block truth, not a preference.
  const cover: Vec3Json = { x: 6, y: 59, z: -0.5 }
  const spots = selectKeepDistanceSpots({
    self: BODY,
    threat: SKELETON,
    standable: [cover],
    occludedCells: [cover],
    standoff: 12,
  })
  const withoutCover = selectKeepDistanceSpots({
    self: BODY,
    threat: SKELETON,
    standable: [cover],
    standoff: 12,
  })
  const pass =
    spots.length === 1 &&
    spots[0]?.occluded === true &&
    spots[0].gain > 0 &&
    spots[0].gain < MIN_KEEP_DISTANCE_GAIN &&
    withoutCover.length === 0
  return {
    pass,
    detail: `coverSpots=[${spots.map((spot) => `${spot.spot.x},${spot.spot.y},${spot.spot.z}:gain=${Math.round(spot.gain * 100) / 100}`).join('|')}] withoutCover=${withoutCover.length}`,
  }
})

// ---------------------------------------------------------------------------
// (ii) the only "away" cells are through a portal -> never realized
// ---------------------------------------------------------------------------

addCase('(ii1) the portal is never offered as a retreat, and a hand-built MOVE to it is withheld `crosses_dimension`', () => {
  const state = noteThreat(measuredBody())
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const portalMove: Candidate = {
    id: `MOVE:p${PORTAL_FEET.x}_${PORTAL_FEET.y}_${PORTAL_FEET.z}`,
    kind: 'MOVE',
    label: 'step into the lit portal',
    targetName: null,
    target: PORTAL_FEET,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: state.tick },
  }
  const gated = applyReachabilityGate([portalMove], state, defaultCandidateOptions)
  const withheld = gated.withheld.find((entry) => entry.candidate.id === portalMove.id)
  const offered = applyThreatRestriction(state, generateCandidates(state, defaultCandidateOptions))
  const pass =
    // the generator cannot even ground one (the solver refuses transfer cells)
    grounded.candidates.every((candidate) => !targetsTransferCell(candidate, PORTAL_CELLS)) &&
    offered.candidates.every((candidate) => !targetsTransferCell(candidate, PORTAL_CELLS)) &&
    offered.candidates.length > 0 &&
    // and any other source of such a leg is refused by the gate, typed (the
    // single ESCALATE is the gate's existing typed-refusal surface, not the leg)
    !gated.candidates.some((candidate) => candidate.id === portalMove.id) &&
    withheld !== undefined &&
    withheld.result.reason === 'crosses_dimension'
  return {
    pass,
    detail: `grounded=[${ids(grounded.candidates).join(',')}] offered=[${ids(offered.candidates).join(',')}] gate=[${ids(gated.candidates).join(',')}] withheld=${withheld?.result.reason ?? 'none'}`,
  }
})

addCase('(ii2) a destination whose ROUTE crosses the portal is withheld with the same typed reason', () => {
  const state = noteThreat(measuredBody())
  const beyond: Candidate = {
    id: 'MOVE:p5_59_-2',
    kind: 'MOVE',
    label: 'walk past the gate',
    targetName: null,
    target: { x: 5, y: 59, z: -2 },
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: state.tick },
  }
  const crosses = applyReachabilityGate(
    [beyond],
    state,
    withProbe(defaultCandidateOptions, { pathProbe: () => 'reachable', dimensionTransferProbe: () => 'crosses' }),
  )
  const clear = applyReachabilityGate(
    [beyond],
    state,
    withProbe(defaultCandidateOptions, { pathProbe: () => 'reachable', dimensionTransferProbe: () => 'clear' }),
  )
  const unknown = applyReachabilityGate(
    [beyond],
    state,
    withProbe(defaultCandidateOptions, { pathProbe: () => 'reachable', dimensionTransferProbe: () => 'unknown' }),
  )
  const pass =
    !crosses.candidates.some((candidate) => candidate.id === beyond.id) &&
    crosses.withheld[0]?.result.reason === 'crosses_dimension' &&
    clear.candidates.length === 1 &&
    unknown.candidates.length === 1
  return {
    pass,
    detail: `crosses=[${ids(crosses.candidates).join(',')}]/${crosses.withheld[0]?.result.reason ?? 'none'} clear=[${ids(clear.candidates).join(',')}] unknown=[${ids(unknown.candidates).join(',')}]`,
  }
})

addCase('(ii3) the EXPLICIT dimension-transfer candidate still exists: the invariant removes the mechanical leg, not the choice', () => {
  const state = noteThreat(measuredBody())
  const entry: Candidate = {
    id: `ENTER:${PORTAL_FEET.x},${PORTAL_FEET.y},${PORTAL_FEET.z}`,
    kind: 'ENTER_PORTAL',
    label: 'walk into the lit nether portal',
    targetName: 'nether_portal',
    target: PORTAL_FEET,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: state.tick, dimension: 'minecraft:overworld' },
  }
  const gated = applyReachabilityGate(
    [entry],
    state,
    withProbe(defaultCandidateOptions, { pathProbe: () => 'reachable', dimensionTransferProbe: () => 'crosses' }),
  )
  const pass = gated.candidates.length === 1 && gated.withheld.length === 0
  return { pass, detail: `presented=[${ids(gated.candidates).join(',')}] withheld=${gated.withheld.length}` }
})

addCase('(ii4) the sensor carries the transfer cells as block truth and still reports them standable', () => {
  const Vec3 = require('vec3')
  const position = new Vec3(5.5, 59, -0.5)
  const isPortal = (p: { x: number; y: number; z: number }): boolean =>
    p.x === 4 && p.z === -3 && (p.y === 59 || p.y === 60)
  const bot = {
    username: 'AI_M3THREAT',
    entity: { id: 1, position, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 18,
    food: 5,
    game: { gameMode: 'survival', dimension: NETHER, minY: 0, height: 256 },
    time: { isDay: false },
    registry: null,
    entities: { 42: { id: 42, name: 'skeleton', kind: 'hostile', position: new Vec3(5.5, 59, 8.43), isValid: true, heldItem: null } },
    inventory: { items: () => [] },
    // air above y=58, solid support at y=58: the only standable plane is y=59
    blockAt: (p: { x: number; y: number; z: number }) =>
      isPortal(p)
        ? { name: 'nether_portal', boundingBox: 'empty' }
        : p.y < 59
          ? { name: 'netherrack', boundingBox: 'block' }
          : { name: 'air', boundingBox: 'empty' },
    canSeeBlock: () => false,
    findBlocks: () => [],
    // no world raycast: cover must then never be claimed (unknown is not cover)
  } as never
  const state = buildWorldState(
    bot,
    { tick: 4, goal: goalState(), goalQueue: queue(), recentEvents: [], signals: signals() },
    // a raised terrain cap so the capped `standable` slice cannot hide the cell
    // this case is about (the default 8 nearest cells do not reach the portal)
    { ...defaultSensorOptions, maxTerrain: 32 },
  )
  const transfer = state.terrain.portalWalkInCells ?? []
  const standable = state.terrain.standable ?? []
  // a cell is recorded when EITHER its feet or its head block is portal material:
  // the bottom interior cell is reachable with the head, the upper ones with the
  // feet, and all of them transfer the body. Whatever the block truth says.
  const pass =
    transfer.length >= 2 &&
    transfer.some((cell) => cell.x === PORTAL_FEET.x && cell.y === PORTAL_FEET.y && cell.z === PORTAL_FEET.z) &&
    transfer.some((cell) => cell.x === PORTAL_HEAD.x && cell.y === PORTAL_HEAD.y && cell.z === PORTAL_HEAD.z) &&
    // the block truth did not change: a portal interior cell is still a legally
    // standable cell (the SOLVER and the GATE refuse it, not the sensor)
    standable.some((cell) => cell.x === PORTAL_FEET.x && cell.y === PORTAL_FEET.y && cell.z === PORTAL_FEET.z) &&
    state.terrain.threatCoverCells === undefined
  return {
    pass,
    detail: `transfer=[${transfer.map((cell) => `${cell.x},${cell.y},${cell.z}`).join('|')}] standable=${standable.length} cover=${state.terrain.threatCoverCells?.length ?? 'none'}`,
  }
})

// ---------------------------------------------------------------------------
// (iii) hostile IN CONTACT -> unchanged (the survival envelope owns it)
// ---------------------------------------------------------------------------

addCase('(iii1) a contact hostile keeps the existing envelope: survival kinds only, ATTACK offered, no gap', () => {
  const contact: Vec3Json = { x: 6, y: 59, z: 0 }
  const away: Vec3Json = { x: 2, y: 59, z: -2 }
  const state = noteThreat(
    measuredBody({
      entities: [entity(7, 'zombie', contact, true, { attackedSelf: true })],
      terrain: { standable: [BODY, away], escapeCells: [away], portalWalkInCells: PORTAL_CELLS },
    }),
  )
  const evidence = state.signals.threat!
  const generated = generateCandidates(state, defaultCandidateOptions)
  const offer = applyThreatRestriction(state, generated)
  const attack = offer.candidates.find((candidate) => candidate.kind === 'ATTACK')
  const retreats = offer.candidates.filter((candidate) => candidate.kind === 'RETREAT')
  const pass =
    evidence.active === true &&
    evidence.inContact === true &&
    evidence.entryReason === 'contact' &&
    offer.restricted === true &&
    offer.inContact === true &&
    attack?.targetEntityId === 7 &&
    retreats.length > 0 &&
    retreats.every((candidate) => !targetsTransferCell(candidate, PORTAL_CELLS)) &&
    offer.candidates.every((candidate) => THREAT_SURVIVAL_KINDS.has(candidate.kind)) &&
    offer.gap === null
  return {
    pass,
    detail: `contact=${evidence.inContact} reason=${evidence.entryReason} offered=[${ids(offer.candidates).join(',')}] gap=${offer.gap?.reason ?? 'none'}`,
  }
})

// ---------------------------------------------------------------------------
// (iv) a genuinely unanswerable threat: typed gap, no oscillation
// ---------------------------------------------------------------------------

addCase('(iv1) an engaged threat with no route and no away cell keeps the typed no-response path, stably', () => {
  const options = withProbe(defaultCandidateOptions, { attackPathProbe: () => 'no_path' })
  const base = measuredBody()
  const evidence: { gap: string | null; active: boolean; offered: string[] }[] = []
  for (let i = 0; i < 5; i += 1) {
    const state = noteThreat(base, NOW + i * 1000)
    const grounded = generateGroundedCandidates(state, options)
    const offer = applyGroundedThreatRestriction(state, grounded.candidates, grounded.withheld)
    evidence.push({
      gap: offer.gap?.reason ?? null,
      active: offer.threat?.active ?? false,
      offered: ids(offer.candidates),
    })
  }
  const first = evidence[0]
  const stable = evidence.every(
    (entry) =>
      entry.gap === 'no_grounded_threat_response' &&
      entry.active === true &&
      entry.offered.length === 1 &&
      entry.offered[0] === 'ESCALATE',
  )
  const pass = first !== undefined && stable
  return {
    pass,
    detail: `ticks=${evidence.map((entry) => `${entry.offered.join('+')}:${entry.gap ?? 'none'}`).join(' ')}`,
  }
})

addCase('(iv2) the unanswerable state does not exit until the whole envelope is clear, and never crosses a dimension', () => {
  const tracker = new ThreatTracker()
  const state = measuredBody()
  const first = tracker.note({ atMs: NOW, entities: state.entities, lastDamage: state.signals.lastDamage ?? null })
  // The threat leaves the sensor for less than the clear interval: the response
  // state must NOT flap back to work (the measured per-tick failure).
  const quiet = tracker.note({ atMs: NOW + 1000, entities: [] })
  const stillActive = quiet.active === true && quiet.clearForMs === 0
  const cleared = tracker.note({ atMs: NOW + 1000 + THREAT_CLEAR_MS, entities: [] })
  const pass =
    first.active === true &&
    first.entryReason === 'engaged' &&
    stillActive &&
    cleared.active === false &&
    cleared.exitReason === 'sustained_clear'
  return {
    pass,
    detail: `first=${first.entryReason} quietActive=${quiet.active} cleared=${cleared.active}/${cleared.exitReason} clearMs=${THREAT_CLEAR_MS}`,
  }
})

// ---------------------------------------------------------------------------
// (v) ordinary walking with no threat -> unchanged
// ---------------------------------------------------------------------------

/**
 * Ordinary walking in the OVERWORLD: one remembered diamond ore 9 m away and a
 * matching collect goal, so the offer is the real work set
 * (`RETRIEVE:known:diamond:b9_10_0` + `WAIT`) rather than a degenerate one.
 */
const REMEMBERED_DIAMOND: Vec3Json = { x: 9, y: 10, z: 0 }

function plainGoal(): GoalState {
  return {
    id: 'collect:diamond',
    description: 'collect 1 x diamond',
    targetItem: 'diamond',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function plainQueue(): GoalQueueState {
  const goal: QueuedGoal = {
    id: 'g1:collect:diamond',
    kind: 'collect',
    description: 'collect 1 x diamond',
    targetItem: 'diamond',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
  return { depth: 1, current: goal, empty: false, hasImpossible: false, done: 0, goals: [goal] }
}

function plainState(overrides: Partial<WorldState> = {}): WorldState {
  const inventory: InventoryState = { slots: [], counts: {}, totalItems: 0 }
  return {
    schemaVersion: 1,
    tick: 12,
    timestampMs: NOW,
    self: selfState({ x: 0, y: 10, z: 0 }, { dimension: 'minecraft:overworld' }),
    inventory,
    entities: [],
    blocks: [],
    terrain: { standable: [{ x: 0, y: 10, z: 0 }, { x: 1, y: 10, z: 0 }, { x: -5, y: 10, z: 0 }] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: plainGoal(),
    goalQueue: plainQueue(),
    recentEvents: [],
    signals: signals({ stalledMs: 61_350, knownResources: [{ name: 'diamond_ore', kind: 'ore', position: REMEMBERED_DIAMOND }] }),
    ...overrides,
  }
}

addCase('(v1) with no threat the offer is byte-identical to the pre-change work set', () => {
  const state = plainState()
  const generated = generateCandidates(state, defaultCandidateOptions)
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const offer = applyThreatRestriction(state, generated)
  const golden = 'RETRIEVE:known:diamond:b9_10_0,WAIT'
  const pass =
    ids(generated).join(',') === golden &&
    ids(grounded.candidates).join(',') === golden &&
    ids(offer.candidates).join(',') === golden &&
    offer.restricted === false &&
    offer.gap === null &&
    offer.threat === null &&
    offer.candidates.every((candidate) => candidate.kind !== 'RETREAT' && candidate.kind !== 'ATTACK') &&
    state.terrain.portalWalkInCells === undefined &&
    state.terrain.threatCoverCells === undefined
  return {
    pass,
    detail: `golden=[${golden}] generated=[${ids(generated).join(',')}] offered=[${ids(offer.candidates).join(',')}] restricted=${offer.restricted}`,
  }
})

addCase('(v2) a hostile that has NOT engaged the body adds no ATTACK beyond the melee envelope', () => {
  const far = entity(88, 'zombie', { x: 0, y: 10, z: 12 }, true, {}, { x: 0, y: 10, z: 0 })
  const state = plainState({ entities: [far] })
  const generated = generateCandidates(state, defaultCandidateOptions)
  const attacks = generated.filter((candidate) => candidate.kind === 'ATTACK')
  // now the same mob with a recorded engagement: the offer widens (that is the fix)
  const engaged = generateCandidates(
    { ...state, signals: signals({ lastDamage: { atMs: NOW - 1000, health: 14, sourceId: 77, sourceName: 'zombie' } }) },
    defaultCandidateOptions,
  )
  const engagedAttacks = engaged.filter((candidate) => candidate.kind === 'ATTACK')
  const pass =
    attacks.length === 0 &&
    engagedAttacks.length === 1 &&
    engagedAttacks[0]?.id === 'ATTACK:e88' &&
    THREAT_RESPONSE_RANGE === 24 &&
    THREAT_DANGER_RADIUS === 8 &&
    MELEE_THREAT_REACH === 3.2
  return {
    pass,
    detail: `unengaged=[${ids(attacks).join(',')}] engaged=[${ids(engagedAttacks).join(',')}] responseRange=${THREAT_RESPONSE_RANGE}`,
  }
})

addCase('(v3) the new terrain facts stay absent while nothing grounds them', () => {
  const state = noteThreat(plainState())
  const pass =
    state.terrain.portalWalkInCells === undefined &&
    state.terrain.threatCoverCells === undefined &&
    state.signals.threat?.active === false
  return {
    pass,
    detail: `portalWalkInCells=${state.terrain.portalWalkInCells === undefined ? 'absent' : 'present'} cover=${state.terrain.threatCoverCells === undefined ? 'absent' : 'present'}`,
  }
})

// ===========================================================================
// MOB IDENTITY CHURN: a hostile whose entity id churns by design stays
// attackable, and nothing else is ever adopted.
//
// Measured live (m3-live, the Nether magma-cube fights): `THREAT_NEARBY
// threat=magma_cube threatId=49561 distance=2.32 contact=true` ->
// `JEV_HEADS action=ATTACK:e49561` -> `SURVIVAL_NO_GROUNDED_ACTION
// chosenId=ATTACK:e49561 kind=ATTACK reason=no_grounded_equivalent
// outcome=TARGET_LOST`. A magma cube/slime is REPLACED when its size state
// changes (the parent is removed, the smaller cubes are new entities with new
// ids), so "the chosen entity id vanished" is the NORMAL case for this mob while
// the CAUSAL threat is still standing on the body. What survives the churn:
// the mob name, the entity kind, the position - never the id.
// ===========================================================================

/** A grounded ATTACK candidate over a sensed hostile, as candidates.ts builds it. */
function hostileAttack(
  entityId: number,
  name: string,
  position: Vec3Json,
  meta: Record<string, unknown> = {},
): {
  id: string
  kind: string
  targetEntityId: number
  targetName: string
  target: Vec3Json
  meta: Record<string, unknown>
} {
  return {
    id: `ATTACK:e${entityId}`,
    kind: 'ATTACK',
    targetEntityId: entityId,
    targetName: name,
    target: position,
    meta: { entityId, targetHostile: true, targetKind: 'Hostile mobs', attackable: true, hostile: true, ...meta },
  }
}

/** The position the vanished candidate recorded for the measured magma cube. */
const CUBE_AT: Vec3Json = { x: 5, y: 59, z: 2.32 }
const CUBE_CHURN_NOW = NOW + 760

addCase('(i) the measured shape: a hostile in contact whose entity id churns while kind+position match is STILL fought', () => {
  const chosen = hostileAttack(49561, 'magma_cube', CUBE_AT)
  const fresh = [
    hostileAttack(50001, 'zombie', { x: 5, y: 59, z: 2.4 }),
    hostileAttack(49572, 'magma_cube', { x: 5, y: 59, z: 2.72 }),
  ]
  const context = {
    previousEntityTracked: false,
    knownEntityIds: new Set([49561, 50001]),
    chosenAtMs: NOW,
    nowMs: CUBE_CHURN_NOW,
  }
  const result = regroundVanishedSurvivalChoice(chosen, fresh, context)
  const churn = result.identityChurn
  const fallback = survivalControlFallback({
    reground: result,
    threatInContact: true,
    freshCandidates: fresh,
  })
  const evidence = {
    threatId: 49572,
    threatName: 'magma_cube',
    threatDistance: 2.2,
    inContact: true,
  } as never
  const line = churn === null ? '' : formatMobIdentityChurn(chosen.id, churn, evidence, { health: 8, food: 17 } as never)
  const pass =
    result.candidateId === 'ATTACK:e49572' &&
    result.reason === 'same_kind_near_last_position_attack' &&
    result.outcome === 'REGROUNDED_IDENTITY_CHURN' &&
    churn !== null &&
    churn.fromEntityId === 49561 &&
    churn.toEntityId === 49572 &&
    churn.name === 'magma_cube' &&
    churn.kind === 'Hostile mobs' &&
    Math.abs(churn.distance - 0.4) < 0.001 &&
    churn.elapsedMs === 760 &&
    churn.rule === 'same_kind_near_last_position' &&
    churn.goneEvidence === 'not_in_client_tracked_set' &&
    churn.newEntity === 'absent_from_decision_snapshot' &&
    // the survival path keeps FIGHTING that threat instead of escalating
    fallback.candidateId === null &&
    fallback.reason === 'regrounded' &&
    line.includes('MOB_IDENTITY_CHURN from=ATTACK:e49561 to=ATTACK:e49572 mob=magma_cube') &&
    line.includes('kind=Hostile mobs') &&
    line.includes('moved=0.4m') &&
    line.includes('elapsedMs=760') &&
    line.includes('rule=same_kind_near_last_position') &&
    line.includes('gone=not_in_client_tracked_set') &&
    line.includes('new=absent_from_decision_snapshot') &&
    // and the proof rides the mirrored live path
    MIRRORED_MARKERS.has(MOB_IDENTITY_CHURN) &&
    IDENTITY_CHURN_WINDOW_MS === 3000 &&
    IDENTITY_CHURN_RADIUS === 3
  return {
    pass,
    detail: `to=${result.candidateId} reason=${result.reason} outcome=${result.outcome} churn=${churn === null ? 'none' : `${churn.fromEntityId}->${churn.toEntityId} ${churn.name} ${churn.distance}m ${churn.elapsedMs}ms`} fallback=${fallback.reason} mirrored=${MIRRORED_MARKERS.has(MOB_IDENTITY_CHURN)}`,
  }
})

addCase('(ii) a DIFFERENT mob kind at that position is never adopted (typed TARGET_LOST)', () => {
  const chosen = hostileAttack(49561, 'magma_cube', CUBE_AT)
  const context = {
    previousEntityTracked: false,
    knownEntityIds: new Set([49561]),
    chosenAtMs: NOW,
    nowMs: CUBE_CHURN_NOW,
  }
  // (a) a different NAME, (b) a different name AND kind, (c) same category only.
  const otherName = regroundVanishedSurvivalChoice(
    chosen,
    [hostileAttack(49572, 'zombie', CUBE_AT)],
    context,
  )
  const otherKind = regroundVanishedSurvivalChoice(
    chosen,
    [hostileAttack(49572, 'blaze', CUBE_AT, { targetKind: 'Hostile mobs' })],
    context,
  )
  const otherCategory = regroundVanishedSurvivalChoice(
    chosen,
    [hostileAttack(49572, 'skeleton', { x: 5, y: 59, z: 2.4 }, { targetKind: 'Hostile mobs' })],
    context,
  )
  const pass =
    otherName.candidateId === null &&
    otherName.outcome === 'TARGET_LOST' &&
    otherName.identityChurn === null &&
    otherKind.candidateId === null &&
    otherKind.outcome === 'TARGET_LOST' &&
    otherCategory.candidateId === null &&
    otherCategory.outcome === 'TARGET_LOST'
  return {
    pass,
    detail: `zombie=${otherName.candidateId}/${otherName.outcome} blaze=${otherKind.candidateId}/${otherKind.outcome} skeleton=${otherCategory.candidateId}/${otherCategory.outcome}`,
  }
})

addCase('(iii) the old entity still alive (or UNKNOWN) is never adopted', () => {
  const chosen = hostileAttack(49561, 'magma_cube', CUBE_AT)
  const fresh = [hostileAttack(49572, 'magma_cube', { x: 5, y: 59, z: 2.72 })]
  const base = { knownEntityIds: new Set([49561]), chosenAtMs: NOW, nowMs: CUBE_CHURN_NOW }
  // the committed id is still in the client's tracked set: it is alive somewhere,
  // so the replacement is a DIFFERENT mob and must not be adopted.
  const alive = regroundVanishedSurvivalChoice(chosen, fresh, { ...base, previousEntityTracked: true })
  // UNKNOWN tracked state (no live probe) must refuse too: fail closed.
  const unknown = regroundVanishedSurvivalChoice(chosen, fresh, { ...base, previousEntityTracked: null })
  const missing = regroundVanishedSurvivalChoice(chosen, fresh, base)
  // the SAME inputs with the old entity PROVEN gone adopt, so the test measures
  // the tracked-set fact and nothing else.
  const gone = regroundVanishedSurvivalChoice(chosen, fresh, { ...base, previousEntityTracked: false })
  const pass =
    alive.candidateId === null &&
    alive.outcome === 'TARGET_LOST' &&
    unknown.candidateId === null &&
    unknown.outcome === 'TARGET_LOST' &&
    missing.candidateId === null &&
    missing.outcome === 'TARGET_LOST' &&
    gone.candidateId === 'ATTACK:e49572' &&
    gone.outcome === 'REGROUNDED_IDENTITY_CHURN'
  return {
    pass,
    detail: `alive=${alive.candidateId}/${alive.outcome} unknown=${unknown.candidateId}/${unknown.outcome} absent=${missing.candidateId}/${missing.outcome} gone=${gone.candidateId}/${gone.outcome}`,
  }
})

addCase('(iv) an unrelated same-kind mob (wrong place, or already there at decision time) is never adopted', () => {
  const chosen = hostileAttack(49561, 'magma_cube', CUBE_AT)
  const context = {
    previousEntityTracked: false,
    knownEntityIds: new Set([49561]),
    chosenAtMs: NOW,
    nowMs: CUBE_CHURN_NOW,
  }
  // same kind, 6 m away: a different mob.
  const farAway = regroundVanishedSurvivalChoice(
    chosen,
    [hostileAttack(49572, 'magma_cube', { x: 5, y: 59, z: 8.4 })],
    context,
  )
  // same kind, just OUTSIDE the declared radius (3 m): still refused.
  const justOutside = regroundVanishedSurvivalChoice(
    chosen,
    [hostileAttack(49572, 'magma_cube', { x: 5, y: 59, z: 5.4 })],
    context,
  )
  // same kind, inside the radius, but it was ALREADY sensed at decision time: a
  // pre-existing bystander, not a churn replacement (the measured HUNT_RETARGET
  // shape must stay impossible).
  const bystander = regroundVanishedSurvivalChoice(
    chosen,
    [hostileAttack(49572, 'magma_cube', { x: 5, y: 59, z: 2.72 })],
    { ...context, knownEntityIds: new Set([49561, 49572]) },
  )
  // same kind, inside the radius, NEW - but no position was recorded on the
  // vanished candidate: UNKNOWN refuses rather than guesses.
  const noPosition = regroundVanishedSurvivalChoice(
    { id: 'ATTACK:e49561', kind: 'ATTACK', targetEntityId: 49561, targetName: 'magma_cube', meta: { entityId: 49561, targetHostile: true } },
    [hostileAttack(49572, 'magma_cube', { x: 5, y: 59, z: 2.72 })],
    context,
  )
  // outside the bounded window: refused.
  const tooLate = regroundVanishedSurvivalChoice(
    chosen,
    [hostileAttack(49572, 'magma_cube', { x: 5, y: 59, z: 2.72 })],
    { ...context, nowMs: NOW + IDENTITY_CHURN_WINDOW_MS + 1 },
  )
  const pass =
    farAway.candidateId === null &&
    farAway.outcome === 'TARGET_LOST' &&
    justOutside.candidateId === null &&
    justOutside.outcome === 'TARGET_LOST' &&
    bystander.candidateId === null &&
    bystander.outcome === 'TARGET_LOST' &&
    noPosition.candidateId === null &&
    noPosition.outcome === 'TARGET_LOST' &&
    tooLate.candidateId === null &&
    tooLate.outcome === 'TARGET_LOST' &&
    identityChurnCandidate(chosen, [hostileAttack(49572, 'magma_cube', { x: 5, y: 59, z: 2.72 })], context) !== null
  return {
    pass,
    detail: `far=${farAway.candidateId}/${farAway.outcome} edge=${justOutside.candidateId}/${justOutside.outcome} bystander=${bystander.candidateId}/${bystander.outcome} noPos=${noPosition.candidateId}/${noPosition.outcome} late=${tooLate.candidateId}/${tooLate.outcome}`,
  }
})

addCase('(v) ordinary one-id combat is byte-identical (same id, same markers, producer hunts untouched)', () => {
  const chosen = hostileAttack(49561, 'magma_cube', CUBE_AT)
  const sameId = hostileAttack(49561, 'magma_cube', { x: 5, y: 59, z: 2.4 })
  // a churn context that WOULD adopt a replacement if the same id were missing:
  // the exact-id path must win first and emit no churn evidence.
  const context = {
    previousEntityTracked: false,
    knownEntityIds: new Set([49561]),
    chosenAtMs: NOW,
    nowMs: CUBE_CHURN_NOW,
  }
  const result = regroundVanishedSurvivalChoice(chosen, [sameId, hostileAttack(49572, 'magma_cube', { x: 5, y: 59, z: 2.72 })], context)
  const line = formatSurvivalReground(
    chosen.id,
    result,
    1,
    { threatId: 49561, threatName: 'magma_cube', threatDistance: 2.4, inContact: true } as never,
    { health: 8, food: 17 } as never,
  )
  const golden =
    'SURVIVAL_REGROUND from=ATTACK:e49561 to=ATTACK:e49561 kind=ATTACK reason=same_target_attack outcome=REGROUNDED offer=1 ' +
    'threat=magma_cube threatId=49561 distance=2.4m contact=true health=8 food=17'
  // the RETREAT re-ground is untouched as well.
  const retreat = regroundVanishedSurvivalChoice(
    { id: 'RETREAT:p16_59_3', kind: 'RETREAT', targetEntityId: null, meta: { threatEntityId: 49202 } },
    [{ id: 'RETREAT:p17_59_2', kind: 'RETREAT', targetEntityId: null, meta: { threatEntityId: 49202 } }],
    context,
  )
  // a producer HUNT keeps its instance identity: a perfect same-kind churn match
  // on a `goalDrop` attack is still TARGET_LOST (the measured HUNT_RETARGET must
  // stay impossible).
  const hunt = regroundVanishedSurvivalChoice(
    hostileAttack(49561, 'blaze', CUBE_AT, { goalDrop: 'blaze_rod', producerRoute: 'mob_drop' }),
    [hostileAttack(49572, 'blaze', { x: 5, y: 59, z: 2.72 }, { goalDrop: 'blaze_rod', producerRoute: 'mob_drop' })],
    context,
  )
  const foodHunt = regroundVanishedSurvivalChoice(
    hostileAttack(49561, 'cow', CUBE_AT, { foodAnimal: true, foodRoute: 'animal', foodTarget: 'cow' }),
    [hostileAttack(49572, 'cow', { x: 5, y: 59, z: 2.72 }, { foodAnimal: true, foodRoute: 'animal', foodTarget: 'cow' })],
    context,
  )
  const pass =
    result.candidateId === 'ATTACK:e49561' &&
    result.reason === 'same_target_attack' &&
    result.outcome === 'REGROUNDED' &&
    result.identityChurn === null &&
    line === golden &&
    retreat.candidateId === 'RETREAT:p17_59_2' &&
    retreat.reason === 'same_threat_keep_distance' &&
    retreat.outcome === 'REGROUNDED' &&
    retreat.identityChurn === null &&
    hunt.candidateId === null &&
    hunt.outcome === 'TARGET_LOST' &&
    foodHunt.candidateId === null &&
    foodHunt.outcome === 'TARGET_LOST'
  return {
    pass,
    detail: `sameId=${result.candidateId}/${result.reason} byteIdentical=${line === golden} retreat=${retreat.reason} hunt=${hunt.outcome} foodHunt=${foodHunt.outcome}`,
  }
})

addCase('(vi) with no grounded response the survival path stays TYPED (never a silent no-action, never a fabricated target)', () => {
  const chosen = hostileAttack(49561, 'magma_cube', CUBE_AT)
  const context = {
    previousEntityTracked: false,
    knownEntityIds: new Set([49561]),
    chosenAtMs: NOW,
    nowMs: CUBE_CHURN_NOW,
  }
  // the fresh restricted offer carries NO attack at all: nothing is invented, the
  // outcome stays typed and the control action is the grounded answer.
  const noAttack = regroundVanishedSurvivalChoice(chosen, [{ id: 'WAIT', kind: 'WAIT' }], context)
  const escalate = survivalControlFallback({
    reground: noAttack,
    threatInContact: true,
    freshCandidates: [{ id: 'WAIT', kind: 'WAIT' }, { id: 'ESCALATE', kind: 'ESCALATE' }],
  })
  // ... and a vanished RETREAT with no grounded escape keeps its own typed gap.
  const noRetreat = regroundVanishedSurvivalChoice(
    { id: 'RETREAT:p-1_44_-1', kind: 'RETREAT', meta: { threatEntityId: 49561 } },
    [],
    context,
  )
  const noControl = survivalControlFallback({ reground: noRetreat, threatInContact: true, freshCandidates: [] })
  // a churn candidate that is present but NOT grounded for the body (not in the
  // fresh restricted offer) can never be reached: the rule only reads the offer.
  const notOffered = regroundVanishedSurvivalChoice(chosen, [], context)
  const pass =
    noAttack.candidateId === null &&
    noAttack.outcome === 'TARGET_LOST' &&
    noAttack.kind === 'ATTACK' &&
    escalate.candidateId === 'ESCALATE' &&
    escalate.reason === 'control_action_escalate' &&
    noRetreat.candidateId === null &&
    noRetreat.outcome === 'CAPABILITY_LOST' &&
    noControl.candidateId === null &&
    noControl.reason === 'no_control_action_offered' &&
    notOffered.candidateId === null &&
    notOffered.outcome === 'TARGET_LOST'
  return {
    pass,
    detail: `noAttack=${noAttack.candidateId}/${noAttack.outcome} control=${escalate.candidateId}/${escalate.reason} noRetreat=${noRetreat.outcome} noControl=${noControl.reason} empty=${notOffered.outcome}`,
  }
})

addCase('(vii) the controller feeds the rule the TRACKED-set truth and mirrors the churn facts', () => {
  // The rule is only as good as the facts the live controller hands it, and the
  // evidence only exists if it rides the mirrored path (`buddy.log` lines are
  // `marker` + the `detail` fields - the message body is NOT mirrored).
  const text = readFileSync(new URL('./src/controller-legacy.ts', import.meta.url), 'utf8')
  const call = text.indexOf('regroundVanishedSurvivalChoice(vanishedChoice, freshCandidates, identityContext)')
  const helper = text.indexOf('private mobIdentityContext(')
  const tracked = text.indexOf('const live = this.bot.entities[entityId]', helper)
  const trackedValidity = text.indexOf('live.isValid !== false', tracked)
  const known = text.indexOf('knownEntityIds: new Set(decisionState.entities.map((entity) => entity.id))', helper)
  const snapshotTimes =
    text.indexOf('chosenAtMs: decisionState.timestampMs', helper) > helper &&
    text.indexOf('nowMs: freshState.timestampMs', helper) > helper
  const churnMarker = text.indexOf('MOB_IDENTITY_CHURN,')
  const mirrored = MIRRORED_MARKERS.has(MOB_IDENTITY_CHURN)
  // the identity proof is in the DETAIL object (what the host mirrors), naming
  // both ids, the shared kind, the movement, the elapsed window and the rule.
  const detailFields = ['fromEntityId: churn.fromEntityId', 'toEntityId: churn.toEntityId', 'mob: churn.name', 'moved:', 'elapsedMs: Math.round(churn.elapsedMs)', 'rule: churn.rule', 'gone: churn.goneEvidence', 'new: churn.newEntity', 'outcome: reground.outcome']
  const detailAt = text.indexOf('formatMobIdentityChurn(')
  const inDetail = detailFields.every((field) => text.indexOf(field, detailAt) > detailAt)
  return {
    pass:
      call > 0 &&
      helper > 0 &&
      tracked > helper &&
      trackedValidity > tracked &&
      known > helper &&
      snapshotTimes &&
      churnMarker > 0 &&
      mirrored &&
      detailAt > 0 &&
      inDetail &&
      // the tracked set is the CLIENT's, never the bounded sensor snapshot: the
      // rule must not read "gone" from `decisionState.entities`/`freshState`.
      !/previousEntityTracked: [^\n]*freshState\.entities/.test(text),
    detail: `call=${call} helper=${helper} trackedAt=${tracked} validity=${trackedValidity} knownAt=${known} snapshotTimes=${snapshotTimes} mirrored=${mirrored} detailFields=${inDetail}`,
  }
})

let failures = 0
process.stdout.write('threat response grounding - engaged attacker answerable, no dimension-crossing realization\n')
process.stdout.write('-'.repeat(96) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(96) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} threat-response-grounding cases passed\n`)

if (failures > 0) process.exit(1)
