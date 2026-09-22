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
  selectKeepDistanceSpots,
  THREAT_CLEAR_MS,
  THREAT_DANGER_RADIUS,
  THREAT_RESPONSE_RANGE,
  ThreatTracker,
} from './src/threat.ts'

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
