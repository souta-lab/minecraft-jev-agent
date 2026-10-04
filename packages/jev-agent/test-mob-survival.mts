// test-mob-survival.mts - general hostile-mob survival capability.
//
// Measured live (m3-live, `run-mubobiq6-12onv`, source 220b9db, permanent night,
// `difficulty=normal`, `spawn-monsters=true`): eight deaths in seven minutes,
// every one `cause=damage`, with no weapon and no armour. Two defects made that
// shape possible and both are pinned here:
//
//   1. the response was PER-TICK. `restrictCandidatesDuringImmediateThreat` only
//      armed while a hostile was inside 3.2 m in the current snapshot, so the
//      body retreated once and went straight back to digging when the mob's
//      snapshot moved outside it. Executed trace: RETREAT, RETREAT, RETRIEVE,
//      RETRIEVE, RETRIEVE, RETREAT, RETRIEVE, CRAFT, DEATH. Health eroded
//      20 -> 18 -> 16 -> 2 -> death.
//   2. the offered "retreat" could not retreat. `pickRetreats` only saw the
//      5x5x3 `terrain.standable` window, so the destinations were 1.4-2.4 m away
//      while the zombie was inside 0.8 m; `RETREAT:p4_69_-9` (0.71 m away) ran as
//      `moved=0m` and the body died on that spot.
//
// The fixtures below pin the general behaviours, not an M3-specific policy:
//
//   (a) hostile inside the danger radius + a stalled goal -> survival actions are
//       offered and the typed `THREAT_NEARBY` marker names the mob;
//   (b) no hostile nearby -> the offer and the state are unchanged;
//   (c) an engaged-but-survivable threat with a weapon held -> ATTACK stays among
//       the options with code-owned weapon facts, and code ranks nothing;
//   (d) a genuinely unavoidable death -> no fabricated success.
//
//   bun test ./test-mob-survival.mts
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import {
  applyGroundedThreatRestriction,
  applyThreatRestriction,
  CONTACT_THREAT_KINDS,
  COMBAT_CANDIDATE_RANGE,
  defaultCandidateOptions,
  generateCandidates,
  generateGroundedCandidates,
  isSurvivalAnswerCandidate,
  restrictCandidatesAtCriticalHealth,
  THREAT_SURVIVAL_KINDS,
} from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { guardCandidate } from './src/policy.ts'
import { buildSurvivalDigCells, buildWorldState, defaultSensorOptions } from './src/state.ts'
import type { AgentSignals, EntityState, GoalState, InventoryState, SelfState, Vec3Json, WorldState } from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import {
  assessAttackRace,
  bodySurvivalFacts,
  formatThreatClear,
  formatThreatNearby,
  formatThreatNoEscape,
  formatThreatOccluded,
  MELEE_THREAT_REACH,
  MIN_KEEP_DISTANCE_GAIN,
  THREAT_CLEAR_MS,
  THREAT_DANGER_RADIUS,
  ThreatTracker,
  weaponFacts,
} from './src/threat.ts'
import { evaluateActionCommitment } from './src/candidateCommitment.ts'

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
const SELF: Vec3Json = { x: 0.5, y: 10, z: 0.5 }
/** a diamond cell 9 m away, so a stalled collect goal still has one work route */
const REMEMBERED: Vec3Json = { x: 9, y: 10, z: 0.5 }

function selfState(position: Vec3Json, overrides: Partial<SelfState> = {}): SelfState {
  return {
    username: 'AI_M3MOB',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'minecraft:overworld',
    isDay: false,
    heldItem: null,
    ...overrides,
  }
}

function goalState(): GoalState {
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

function queuedGoal(): QueuedGoal {
  return {
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

function hostile(
  id: number,
  name: string,
  position: Vec3Json,
  overrides: Partial<EntityState> = {},
  from: Vec3Json = SELF,
): EntityState {
  const distance = Math.sqrt(
    (position.x - from.x) ** 2 + (position.y - from.y) ** 2 + (position.z - from.z) ** 2,
  )
  return {
    id,
    name,
    kind: 'hostile',
    username: null,
    position,
    distance: Math.round(distance * 100) / 100,
    hostile: true,
    lineOfSight: true,
    heldItem: null,
    health: 20,
    attackedSelf: false,
    ...overrides,
  }
}

/**
 * A body standing in the open with one remembered diamond 9 m away, a stalled
 * goal, and whatever hostiles the case injects. `escapeCells` stands in for the
 * sensor's wider threat scan.
 */
function bodyState(entities: EntityState[], overrides: Partial<WorldState> = {}): WorldState {
  const inventory: InventoryState = { slots: [], counts: {}, totalItems: 0 }
  return {
    schemaVersion: 1,
    tick: 12,
    timestampMs: NOW,
    self: selfState(SELF),
    inventory,
    entities,
    blocks: [],
    terrain: {
      standable: [SELF, { x: 1, y: 10, z: 0.5 }],
      escapeCells: [{ x: -5, y: 10, z: 0.5 }],
    },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goalState(),
    goalQueue: queue(),
    recentEvents: [],
    signals: signals({ stalledMs: 61_350, knownResources: [{ name: 'diamond_ore', kind: 'ore', position: REMEMBERED }] }),
    ...overrides,
  }
}

const ids = (candidates: readonly Candidate[]): string[] => candidates.map((candidate) => candidate.id)

// ---------------------------------------------------------------------------
// (a) hostile inside the danger radius + a stalled goal
// ---------------------------------------------------------------------------

addCase('(a1) the danger state survives the clear snapshot that used to end the response', () => {
  const tracker = new ThreatTracker()
  const contact = tracker.note({ atMs: NOW, entities: [hostile(9, 'zombie', { x: 3, y: 10, z: 0.5 })] })
  const steppedBack = tracker.note({ atMs: NOW + 1000, entities: [hostile(9, 'zombie', { x: 6, y: 10, z: 0.5 })] })
  // One quiet frame: the mob is outside melee reach but still inside the danger
  // radius. The response MUST continue (the measured failure resumed work here).
  const quietFrame = tracker.note({ atMs: NOW + 2000, entities: [] })
  const stillActive = quietFrame.active && quietFrame.clearForMs === 0
  // Not yet a sustained clear.
  const halfClear = tracker.note({ atMs: NOW + 5000, entities: [] })
  // Bounded exit after the whole envelope stayed clear.
  const cleared = tracker.note({ atMs: NOW + 2000 + THREAT_CLEAR_MS, entities: [] })
  const pass =
    contact.active === true &&
    contact.inContact === true &&
    contact.entryReason === 'contact' &&
    steppedBack.active === true &&
    steppedBack.inDanger === true &&
    steppedBack.entryReason === 'danger' &&
    stillActive &&
    halfClear.active === true &&
    cleared.active === false &&
    cleared.exitReason === 'sustained_clear' &&
    cleared.enteredAtMs === null
  return {
    pass,
    detail:
      `contact=${contact.entryReason} stepBack=${steppedBack.entryReason} quietActive=${quietFrame.active} ` +
      `halfClearActive=${halfClear.active} cleared=${cleared.active}/${cleared.exitReason} clearMs=${THREAT_CLEAR_MS}`,
  }
})

addCase('(a2) a hostile inside the danger radius with a stalled goal leaves only survival actions offered', () => {
  const state = bodyState([hostile(11, 'zombie', { x: 4, y: 10, z: 0.5 })])
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const generated = generateCandidates(state, defaultCandidateOptions)
  const offer = applyThreatRestriction(state, generated)
  const kinds = new Set(offer.candidates.map((candidate) => candidate.kind))
  const attacks = offer.candidates.filter((candidate) => candidate.kind === 'ATTACK')
  const markedAttack = generated.find((candidate) => candidate.kind === 'ATTACK')
  const work = generated.filter((candidate) => !THREAT_SURVIVAL_KINDS.has(candidate.kind))
  const pass =
    offer.threat?.active === true &&
    offer.restricted === true &&
    work.length > 0 &&
    offer.candidates.length > 0 &&
    [...kinds].every((kind) => THREAT_SURVIVAL_KINDS.has(kind)) &&
    // The bare-fist zombie fight is a proven-lost race (15s kill vs ~6s death
    // at 20hp + regen bank): generated for observability, withheld from offer.
    attacks.length === 0 &&
    markedAttack?.meta.attackRaceLost === true &&
    offer.gap === null
  return {
    pass,
    detail: `generated=[${ids(generated).join(',')}] offered=[${ids(offer.candidates).join(',')}] removedWork=${work.length}`,
  }
})

addCase('(a3) the typed THREAT_NEARBY marker names the mob, distance, weapon and regeneration', () => {
  const state = bodyState([
    hostile(12, 'zombie', { x: 1.5, y: 10, z: 0.5 }),
    hostile(13, 'skeleton', { x: 6, y: 10, z: 0.5 }),
  ])
  state.self = { ...state.self, health: 16, food: 2 }
  const evidence = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const line = formatThreatNearby('smelt:charcoal:1', evidence, weaponFacts(null), bodySurvivalFacts(state.self))
  // The measured live window: food 0-2, no EAT ever executed, so the body cannot
  // regenerate and every hit is permanent until it dies.
  const pass =
    line.startsWith('THREAT_NEARBY ') &&
    line.includes('threat=zombie') &&
    line.includes('distance=1m') &&
    line.includes('contact=true') &&
    line.includes('hostiles=2') &&
    line.includes('weapon=fists') &&
    line.includes('weaponDamage=1') &&
    line.includes('food=2') &&
    line.includes('regenerating=false')
  return { pass, detail: line }
})

addCase('(a4) the exit is recorded with the bounded clear interval', () => {
  const tracker = new ThreatTracker()
  tracker.note({ atMs: NOW, entities: [hostile(23, 'creeper', { x: 3, y: 10, z: 0.5 })] })
  // The interval starts on the first clear observation, not on the last threat.
  tracker.note({ atMs: NOW + 1, entities: [] })
  const cleared = tracker.note({ atMs: NOW + 1 + THREAT_CLEAR_MS, entities: [] })
  const line = formatThreatClear('collect:diamond', cleared)
  const pass = cleared.active === false && line.includes('THREAT_CLEAR') && line.includes(`clearMs=${THREAT_CLEAR_MS}`)
  return { pass, detail: line }
})

// ---------------------------------------------------------------------------
// (b) no hostile nearby -> unchanged
// ---------------------------------------------------------------------------

addCase('(b1) no hostile nearby leaves the offer byte-identical and the state inactive', () => {
  const state = bodyState([])
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: [] })
  const generated = generateCandidates(state, defaultCandidateOptions)
  const offer = applyThreatRestriction(state, generated)
  const same =
    offer.candidates.length === generated.length &&
    offer.candidates.every((candidate, index) => candidate.id === generated[index]?.id)
  const pass =
    offer.threat?.active === false &&
    offer.restricted === false &&
    offer.gap === null &&
    same &&
    generated.some((candidate) => candidate.kind !== 'ATTACK' && candidate.kind !== 'RETREAT')
  return { pass, detail: `offered=${offer.candidates.length}/${generated.length} same=${same}` }
})

addCase('(b2) a remote unengaged hostile stays a world observation, not a fight', () => {
  const state = bodyState([hostile(14, 'skeleton', { x: 30, y: 10, z: 0.5 })])
  const evidence = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const pass = evidence.active === false && evidence.entryReason === null && evidence.threatName === null
  return { pass, detail: `active=${evidence.active} distance=${state.entities[0]?.distance} dangerRadius=${THREAT_DANGER_RADIUS}` }
})

// ---------------------------------------------------------------------------
// (c) engaged-but-survivable threat with a weapon held
// ---------------------------------------------------------------------------

addCase('(c1) a weapon-holding body keeps ATTACK among the options with code-owned weapon facts', () => {
  const state = bodyState([hostile(15, 'zombie', { x: 3, y: 10, z: 0.5 }, { attackedSelf: true })])
  state.self = { ...state.self, health: 14, food: 2, heldItem: { name: 'stone_sword', count: 1, slot: 0 } }
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const generated = generateCandidates(state, defaultCandidateOptions)
  const offer = applyThreatRestriction(state, generated)
  const attack = offer.candidates.find((candidate) => candidate.kind === 'ATTACK')
  const retreat = offer.candidates.find((candidate) => candidate.kind === 'RETREAT')
  const pass =
    attack !== undefined &&
    attack.meta.weapon === 'stone_sword' &&
    attack.meta.weaponKind === 'sword' &&
    attack.meta.weaponDamage === 5 &&
    attack.meta.bodyRegenerates === false &&
    attack.label.includes('with stone_sword') &&
    // No new ranking: the grounded keep-distance route is offered alongside it.
    retreat !== undefined &&
    offer.candidates.every((candidate) => CONTACT_THREAT_KINDS.has(candidate.kind) || candidate.kind === 'EAT' || candidate.kind === 'EQUIP')
  return {
    pass,
    detail: `attack=${attack?.label ?? 'none'} retreat=${retreat?.id ?? 'none'} offered=[${ids(offer.candidates).join(',')}]`,
  }
})

addCase('(c1b) a non-contact hostile with no melee route is withheld instead of becoming the only executable ATTACK', () => {
  // Exact live shape, 2026-09-22 04:44:47Z: body underground at y=11,
  // skeleton at y=17 / 7.83m, los=false, engaged=false. The pre-fix generator
  // advertised ATTACK:e53961 as its single executable candidate and the executor
  // returned out_of_reach every 2.2s.
  const body: Vec3Json = { x: 10.31, y: 11, z: 25.31 }
  const state = bodyState(
    [hostile(53961, 'skeleton', { x: 10.55, y: 17, z: 20.29 }, { lineOfSight: false, heldItem: 'bow' }, body)],
    {
      self: selfState(body, { health: 20, food: 15, heldItem: { name: 'cobblestone', count: 64, slot: 0 } }),
      terrain: { standable: [body], escapeCells: [] },
    },
  )
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const grounded = generateGroundedCandidates(state, {
    ...defaultCandidateOptions,
    reachability: { attackPathProbe: () => 'no_path' },
  })
  const refused = grounded.withheld.find((entry) => entry.candidate.id === 'ATTACK:e53961')
  const offer = applyThreatRestriction(state, grounded.candidates)
  const pass =
    state.signals.threat.active === true &&
    refused?.result.reachable === false &&
    refused.result.reason === 'no_path' &&
    refused.result.missingCapabilities.some((capability) => capability.kind === 'open_path') &&
    !grounded.candidates.some((candidate) => candidate.id === 'ATTACK:e53961') &&
    !offer.candidates.some((candidate) => candidate.kind === 'ATTACK') &&
    offer.candidates.length === 1 &&
    offer.candidates[0]?.kind === 'ESCALATE' &&
    offer.gap?.reason === 'no_grounded_threat_response'
  return {
    pass,
    detail: `refused=${refused?.result.reason ?? 'none'} offered=[${ids(offer.candidates).join(',')}] gap=${offer.gap?.reason ?? 'none'}`,
  }
})

addCase('(c1c) a non-contact hostile with a proven melee route keeps ATTACK on offer', () => {
  const state = bodyState([hostile(53962, 'skeleton', { x: 6, y: 10, z: 0.5 }, { heldItem: 'bow' })])
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const grounded = generateGroundedCandidates(state, {
    ...defaultCandidateOptions,
    reachability: { attackPathProbe: () => 'reachable' },
  })
  const attack = grounded.candidates.find((candidate) => candidate.id === 'ATTACK:e53962')
  const fact = grounded.reachability.find((entry) => entry.candidate.id === 'ATTACK:e53962')
  const pass = attack !== undefined && fact?.result.reachable === true && fact.result.reason === 'reachable'
  return { pass, detail: `attack=${attack?.id ?? 'none'} reachable=${fact?.result.reachable}/${fact?.result.reason}` }
})

addCase('(c1d) contact-range ATTACK is never erased by a failing path probe', () => {
  const state = bodyState([hostile(53963, 'zombie', { x: 2.5, y: 10, z: 0.5 }, { attackedSelf: true })])
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const grounded = generateGroundedCandidates(state, {
    ...defaultCandidateOptions,
    reachability: { attackPathProbe: () => 'no_path' },
  })
  const attack = grounded.candidates.find((candidate) => candidate.id === 'ATTACK:e53963')
  const fact = grounded.reachability.find((entry) => entry.candidate.id === 'ATTACK:e53963')
  const pass = attack !== undefined && fact?.result.reachable === true && !grounded.withheld.some((entry) => entry.candidate.id === attack.id)
  return { pass, detail: `attack=${attack?.id ?? 'none'} reachable=${fact?.result.reachable}/${fact?.result.reason}` }
})

addCase('(c1e) live occluded skeleton: no LOS + no melee path does not erase grounded goal work', () => {
  const body: Vec3Json = { x: 10.31, y: 11, z: 25.31 }
  const state = bodyState(
    [hostile(53961, 'skeleton', { x: 10.55, y: 17, z: 20.29 }, { lineOfSight: false, heldItem: 'bow' }, body)],
    { self: selfState(body, { health: 20, food: 15 }) },
  )
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const work: Candidate = {
    id: 'MINE:b10_13_25',
    kind: 'MINE',
    label: 'clear headroom for portal ascent',
    targetName: 'stone',
    target: { x: 10, y: 13, z: 25 },
    targetEntityId: null,
    itemName: null,
    requiresTool: true,
    toolName: 'pickaxe',
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: state.tick, headroom: true },
  }
  const grounded = generateGroundedCandidates(state, { ...defaultCandidateOptions, reachability: { attackPathProbe: () => 'no_path' } })
  const offer = applyGroundedThreatRestriction(state, [work], grounded.withheld)
  const line = offer.occluded === null || offer.threat === null
    ? ''
    : formatThreatOccluded('enter_portal:goal', offer.threat, offer.occluded.entityIds)
  const pass =
    offer.threat?.active === true &&
    offer.occluded?.reason === 'no_los_no_path' &&
    offer.restricted === false &&
    offer.gap === null &&
    offer.candidates.length === 1 &&
    offer.candidates[0]?.id === work.id &&
    line.startsWith('THREAT_OCCLUDED ') &&
    line.includes('ids=[53961]') &&
    line.includes('los=false')
  return { pass, detail: `offered=[${ids(offer.candidates).join(',')}] occluded=${offer.occluded?.reason ?? 'none'} | ${line}` }
})

addCase('(c1f) LOS=true keeps the survival restriction even when the melee path is blocked', () => {
  const state = bodyState([hostile(53964, 'skeleton', { x: 6, y: 10, z: 0.5 }, { lineOfSight: true, heldItem: 'bow' })])
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const work: Candidate = {
    id: 'MINE:b0_11_0', kind: 'MINE', label: 'work', targetName: 'stone', target: { x: 0, y: 11, z: 0 },
    targetEntityId: null, itemName: null, requiresTool: false, toolName: null, inReach: true, hasStandableAdjacent: true, meta: { tick: state.tick },
  }
  const offer = applyThreatRestriction(state, [work], { unreachableThreatEntityIds: new Set([53964]) })
  const pass = offer.occluded === null && offer.candidates.length === 1 && offer.candidates[0]?.kind === 'ESCALATE' && !offer.candidates.some((candidate) => candidate.kind === 'MINE')
  return { pass, detail: `occluded=${offer.occluded?.reason ?? 'none'} offered=[${ids(offer.candidates).join(',')}]` }
})

addCase('(c1g) recent damage keeps the survival restriction through temporary cover', () => {
  const state = bodyState([hostile(53965, 'skeleton', { x: 6, y: 10, z: 0.5 }, { lineOfSight: false, heldItem: 'bow' })])
  state.signals.lastDamage = { atMs: NOW - 500, health: 18, sourceId: 53965, sourceName: 'skeleton' }
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities, lastDamage: state.signals.lastDamage })
  const work: Candidate = {
    id: 'MINE:b0_11_0', kind: 'MINE', label: 'work', targetName: 'stone', target: { x: 0, y: 11, z: 0 },
    targetEntityId: null, itemName: null, requiresTool: false, toolName: null, inReach: true, hasStandableAdjacent: true, meta: { tick: state.tick },
  }
  const offer = applyThreatRestriction(state, [work], { unreachableThreatEntityIds: new Set([53965]) })
  const pass = offer.occluded === null && offer.candidates.length === 1 && offer.candidates[0]?.kind === 'ESCALATE' && !offer.candidates.some((candidate) => candidate.kind === 'MINE')
  return { pass, detail: `recentDamage=${NOW - (state.signals.lastDamage?.atMs ?? 0)}ms offered=[${ids(offer.candidates).join(',')}]` }
})

addCase('(c1h) one additional danger-radius hostile without a no-path proof prevents the bypass', () => {
  const state = bodyState([
    hostile(53966, 'skeleton', { x: 6, y: 10, z: 0.5 }, { lineOfSight: false }),
    hostile(53967, 'zombie', { x: 7, y: 10, z: 0.5 }, { lineOfSight: false }),
  ])
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const work: Candidate = {
    id: 'MINE:b0_11_0', kind: 'MINE', label: 'work', targetName: 'stone', target: { x: 0, y: 11, z: 0 },
    targetEntityId: null, itemName: null, requiresTool: false, toolName: null, inReach: true, hasStandableAdjacent: true, meta: { tick: state.tick },
  }
  const offer = applyThreatRestriction(state, [work], { unreachableThreatEntityIds: new Set([53966]) })
  const pass = offer.occluded === null && offer.candidates.length === 1 && offer.candidates[0]?.kind === 'ESCALATE' && !offer.candidates.some((candidate) => candidate.kind === 'MINE')
  return { pass, detail: `proofs=[53966] hostiles=[53966,53967] offered=[${ids(offer.candidates).join(',')}]` }
})

addCase('(c1i) a melee-only watcher whose approach is proven no_path does not suppress work', () => {
  // Live p18.1: creeper at 5.46m with lineOfSight=true and a proven-unreachable
  // melee approach held the danger envelope armed ~17min (ESCALATE-only churn)
  // while mechanically unable to ever reach the body's ledge.
  const state = bodyState([hostile(53970, 'creeper', { x: 5.5, y: 10, z: 0.5 }, { lineOfSight: true })])
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const work: Candidate = {
    id: 'MINE:b0_11_0', kind: 'MINE', label: 'work', targetName: 'stone', target: { x: 0, y: 11, z: 0 },
    targetEntityId: null, itemName: null, requiresTool: false, toolName: null, inReach: true, hasStandableAdjacent: true, meta: { tick: state.tick },
  }
  const offer = applyThreatRestriction(state, [work], { unreachableThreatEntityIds: new Set([53970]) })
  const pass =
    offer.occluded?.reason === 'unreachable_melee' &&
    offer.restricted === false &&
    offer.gap === null &&
    offer.candidates.length === 1 &&
    offer.candidates[0]?.id === work.id
  return { pass, detail: `occluded=${offer.occluded?.reason ?? 'none'} offered=[${ids(offer.candidates).join(',')}]` }
})

addCase('(c1j) LOS=true still suppresses for a melee watcher with NO unreachable proof', () => {
  // Sight alone is not the release: without the no_path/no_attack_stand proof a
  // visible hostile may simply not have been evaluated yet, so the envelope stays.
  const state = bodyState([hostile(53971, 'creeper', { x: 5.5, y: 10, z: 0.5 }, { lineOfSight: true })])
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const work: Candidate = {
    id: 'MINE:b0_11_0', kind: 'MINE', label: 'work', targetName: 'stone', target: { x: 0, y: 11, z: 0 },
    targetEntityId: null, itemName: null, requiresTool: false, toolName: null, inReach: true, hasStandableAdjacent: true, meta: { tick: state.tick },
  }
  const offer = applyThreatRestriction(state, [work], { unreachableThreatEntityIds: new Set() })
  const pass = offer.occluded === null && offer.candidates.length === 1 && offer.candidates[0]?.kind === 'ESCALATE'
  return { pass, detail: `occluded=${offer.occluded?.reason ?? 'none'} offered=[${ids(offer.candidates).join(',')}]` }
})

addCase('(c1k) one reachable watcher keeps the suppression even beside a proven-unreachable one', () => {
  const state = bodyState([
    hostile(53972, 'creeper', { x: 5.5, y: 10, z: 0.5 }, { lineOfSight: true }),
    hostile(53973, 'zombie', { x: 6.5, y: 10, z: 0.5 }, { lineOfSight: true }),
  ])
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const work: Candidate = {
    id: 'MINE:b0_11_0', kind: 'MINE', label: 'work', targetName: 'stone', target: { x: 0, y: 11, z: 0 },
    targetEntityId: null, itemName: null, requiresTool: false, toolName: null, inReach: true, hasStandableAdjacent: true, meta: { tick: state.tick },
  }
  const offer = applyThreatRestriction(state, [work], { unreachableThreatEntityIds: new Set([53972]) })
  const pass = offer.occluded === null && offer.candidates.length === 1 && offer.candidates[0]?.kind === 'ESCALATE' && !offer.candidates.some((candidate) => candidate.kind === 'MINE')
  return { pass, detail: `proofs=[53972] hostiles=[53972,53973] offered=[${ids(offer.candidates).join(',')}]` }
})

addCase('(c1l) a crowd beyond the ATTACK budget: unemitted hostiles get the same stance/path verdict and the bypass still releases work', () => {
  // Live portal-p23 `run-mutsv43u-1a0g` gen-muu2pt9c (17:07-17:40Z): seven
  // hostiles inside the 8 m danger radius, all mechanically unreachable
  // (every emitted ATTACK withheld `no_attack_stand`), but `maxAttackCandidates`
  // caps the emitted set at 4 - the three overflow watchers never produced a
  // candidate, so `unreachableThreatEntityIds` could never cover `nearby`, the
  // occluded-envelope bypass never held, and the offer sat ESCALATE-only for
  // ~35 min of starvation/replan churn at hp20 with zero contact.
  const entities = [
    hostile(54601, 'spider', { x: 4, y: 10, z: 0.5 }, { lineOfSight: false }),
    hostile(54602, 'creeper', { x: 6, y: 8, z: 0.5 }, { lineOfSight: false }),
    hostile(54603, 'creeper', { x: -6, y: 10, z: 0.5 }, { lineOfSight: false }),
    hostile(54604, 'zombie', { x: 0.5, y: 10, z: 7 }, { lineOfSight: false }),
    // These two sit past the emitted budget: no ATTACK candidate is ever built
    // for them, so only the probe-eval arm can prove their approach.
    hostile(54605, 'creeper', { x: 0.5, y: 6, z: -5 }, { lineOfSight: false }),
    hostile(54606, 'creeper', { x: 0.5, y: 14, z: -6 }, { lineOfSight: false }),
  ]
  const state = bodyState(entities)
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const work: Candidate = {
    id: 'MINE:b0_12_0', kind: 'MINE', label: 'dig pocket ceiling', targetName: 'stone', target: { x: 0, y: 12, z: 0 },
    targetEntityId: null, itemName: null, requiresTool: false, toolName: null, inReach: true, hasStandableAdjacent: true, meta: { tick: state.tick },
  }
  const reachability = {
    // Every watcher is unreachable: the unemitted pair proves it two ways -
    // 54605 has no stance at all; 54606's stance exists but the walk is no_path.
    attackStandProbe: ({ entityId }: { entityId: number; position: Vec3Json }) =>
      entityId === 54606
        ? { stand: { x: 1, y: 10, z: -5 }, standDistance: 2.4, onBody: false, nearest: null, refusal: null }
        : { stand: null, standDistance: null, onBody: false, nearest: null, refusal: 'no_standable_cell' as const },
    pathProbe: () => 'no_path' as const,
  }
  const grounded = generateGroundedCandidates(state, { ...defaultCandidateOptions, reachability })
  const emittedAttacks = grounded.withheld.filter((entry) => entry.candidate.kind === 'ATTACK')
  const offer = applyGroundedThreatRestriction(state, [work], grounded.withheld, reachability)
  const pass =
    emittedAttacks.length === 4 &&
    emittedAttacks.every((entry) => entry.result.reason === 'no_attack_stand') &&
    offer.threat?.active === true &&
    offer.occluded?.reason === 'no_los_no_path' &&
    offer.occluded.entityIds.length === 6 &&
    offer.restricted === false &&
    offer.candidates.length === 1 &&
    offer.candidates[0]?.id === work.id
  return {
    pass,
    detail: `emitted=${emittedAttacks.length} occluded=${offer.occluded?.reason ?? 'none'}[${(offer.occluded?.entityIds ?? []).join(',')}] offered=[${ids(offer.candidates).join(',')}]`,
  }
})

addCase('(c1m) an unemitted watcher whose probe says REACHABLE keeps the suppression', () => {
  // The probe-eval arm is not a release by itself: an overflow hostile with a
  // stance the body could walk to is still dangerous, so the envelope holds.
  const entities = [
    hostile(54701, 'spider', { x: 4, y: 10, z: 0.5 }, { lineOfSight: false }),
    hostile(54702, 'creeper', { x: 6, y: 8, z: 0.5 }, { lineOfSight: false }),
    hostile(54703, 'creeper', { x: -6, y: 10, z: 0.5 }, { lineOfSight: false }),
    hostile(54704, 'zombie', { x: 0.5, y: 10, z: 7 }, { lineOfSight: false }),
    hostile(54705, 'creeper', { x: 0.5, y: 10, z: -6 }, { lineOfSight: false }),
  ]
  const state = bodyState(entities)
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const work: Candidate = {
    id: 'MINE:b0_12_0', kind: 'MINE', label: 'dig pocket ceiling', targetName: 'stone', target: { x: 0, y: 12, z: 0 },
    targetEntityId: null, itemName: null, requiresTool: false, toolName: null, inReach: true, hasStandableAdjacent: true, meta: { tick: state.tick },
  }
  const reachability = {
    attackStandProbe: ({ entityId }: { entityId: number; position: Vec3Json }) =>
      entityId === 54705
        ? { stand: { x: 1, y: 10, z: -5 }, standDistance: 2.4, onBody: false, nearest: null, refusal: null }
        : { stand: null, standDistance: null, onBody: false, nearest: null, refusal: 'no_standable_cell' as const },
    pathProbe: () => 'no_path' as const,
  }
  // The emitted four keep `no_attack_stand`; the unemitted creeper's stance is
  // real and - with the default reachable path probe below - walkable.
  const walkable = { ...reachability, pathProbe: () => 'reachable' as const }
  const grounded = generateGroundedCandidates(state, { ...defaultCandidateOptions, reachability })
  const offer = applyGroundedThreatRestriction(state, [work], grounded.withheld, walkable)
  const pass = offer.occluded === null && offer.candidates.length === 1 && offer.candidates[0]?.kind === 'ESCALATE'
  return { pass, detail: `occluded=${offer.occluded?.reason ?? 'none'} offered=[${ids(offer.candidates).join(',')}]` }
})

addCase('(c2) fists are a weapon fact too, and a fed body reports the regeneration truth', () => {
  const starving = bodyState([hostile(16, 'zombie', { x: 6, y: 10, z: 0.5 })])
  starving.self = { ...starving.self, food: 0 }
  const fed = bodyState([hostile(16, 'zombie', { x: 6, y: 10, z: 0.5 })])
  fed.self = { ...fed.self, food: 20 }
  const bare = generateCandidates(starving, defaultCandidateOptions).find((candidate) => candidate.kind === 'ATTACK')
  const fedAttack = generateCandidates(fed, defaultCandidateOptions).find((candidate) => candidate.kind === 'ATTACK')
  const pass =
    bare?.meta.weapon === 'fists' &&
    bare?.meta.weaponDamage === 1 &&
    bare?.meta.bodyRegenerates === false &&
    fedAttack?.meta.bodyRegenerates === true &&
    weaponFacts(null).kind === 'fists' &&
    bodySurvivalFacts({ health: 16, food: 2 }).regenerating === false
  return {
    pass,
    detail: `fists=${JSON.stringify(bare?.meta ?? null)} fedRegen=${fedAttack?.meta.bodyRegenerates}`,
  }
})

addCase('(c3) a keep-distance destination that only shuffles inside melee reach is NOT a retreat', () => {
  // The measured death: zombie at 3.08m, "retreat to safety" 0.71m away.
  const state = bodyState([hostile(17, 'zombie', { x: 3, y: 10, z: 0.5 }, { attackedSelf: true })])
  state.terrain = { standable: [SELF, { x: 1, y: 10, z: 0.5 }], escapeCells: [] }
  const generated = generateCandidates(state, defaultCandidateOptions)
  const retreats = generated.filter((candidate) => candidate.kind === 'RETREAT')
  const pass = retreats.length === 0 && !generated.some((candidate) => candidate.label.includes('retreat to safety'))
  return { pass, detail: `retreats=[${ids(retreats).join(',')}] minGain=${MIN_KEEP_DISTANCE_GAIN} reach=${MELEE_THREAT_REACH}` }
})

addCase('(c4) a real escape cell from the wider scan is offered and the guard accepts it', () => {
  const state = bodyState([hostile(18, 'zombie', { x: 3, y: 10, z: 0.5 }, { attackedSelf: true })])
  const generated = generateCandidates(state, defaultCandidateOptions)
  const retreat = generated.find((candidate) => candidate.kind === 'RETREAT')
  const escapeSpot: Vec3Json = { x: -5, y: 10, z: 0.5 }
  const guarded =
    retreat === undefined
      ? null
      : guardCandidate(retreat, state, {
          phase: 'decision',
          candidateIds: new Set([retreat.id]),
          inFlight: null,
          reach: 4.5,
          maxCandidateAgeTicks: 6,
          canComputePath: null,
        })
  // The same destination is denied when the escape scan did not ground it.
  const outside = { ...state, terrain: { standable: [SELF], escapeCells: [] } }
  const denied =
    retreat === undefined
      ? null
      : guardCandidate(retreat, outside, {
          phase: 'decision',
          candidateIds: new Set([retreat.id]),
          inFlight: null,
          reach: 4.5,
          maxCandidateAgeTicks: 6,
          canComputePath: null,
        })
  const pass =
    retreat !== undefined &&
    retreat.target?.x === escapeSpot.x &&
    retreat.meta.escapeScan === true &&
    (retreat.meta.separationGain as number) >= MIN_KEEP_DISTANCE_GAIN &&
    retreat.label.includes('keep distance from zombie') &&
    guarded?.ok === true &&
    denied?.ok === false &&
    denied.code === 'NO_SUPPORT'
  return {
    pass,
    detail: `retreat=${retreat?.id ?? 'none'} label=${retreat?.label ?? 'none'} guarded=${guarded?.ok} outsideGuard=${denied?.ok}/${denied?.ok === false ? denied.code : ''}`,
  }
})

addCase('(c5) the in-flight hold releases to Jev newer choice when a hostile is in contact', () => {
  const base = {
    previous: { actionId: 'RETREAT:p1', epoch: 3, planKey: 'plan', holds: 0 },
    inFlight: { id: 'RETREAT:p1', epoch: 3, startedAtMs: NOW },
    chosenId: 'ATTACK:e33467',
    planKey: 'plan',
    nowMs: NOW + 1000,
    inFlightInvalid: false,
    inFlightOffered: true,
  }
  const held = evaluateActionCommitment(base)
  const released = evaluateActionCommitment({ ...base, contactThreatResponse: true })
  const pass =
    held.committed === true &&
    held.chosenId === 'RETREAT:p1' &&
    released.committed === false &&
    released.chosenId === 'ATTACK:e33467' &&
    (released.releaseLine ?? '').includes('reason=contact_threat')
  return { pass, detail: `held=${held.chosenId} released=${released.chosenId} line=${released.releaseLine ?? 'none'}` }
})

addCase('(c5b) a same-kind RETREAT retarget holds the in-flight escape in contact', () => {
  // portal-p23 gen-mutoyo8o (2026-10-04T10:44:0x): three successive RETREAT
  // picks each released the last via contact_threat, every walk leg restarted
  // (final leg `closed=0.01m`), and the drowned killed the body at 3.17hp
  // while escape-scan-endorsed retreat cells stayed offered. The contact
  // release exists for kind switches; a same-kind retarget only discards the
  // held escape's closed distance.
  const base = {
    previous: { actionId: 'RETREAT:p34_62_-2', epoch: 3, planKey: 'plan', holds: 0 },
    inFlight: { id: 'RETREAT:p34_62_-2', epoch: 3, startedAtMs: NOW },
    planKey: 'plan',
    nowMs: NOW + 1000,
    inFlightInvalid: false,
    inFlightOffered: true,
    contactThreatResponse: true,
  }
  const held = evaluateActionCommitment({ ...base, chosenId: 'RETREAT:p34_62_-20' })
  const kindSwitch = evaluateActionCommitment({ ...base, chosenId: 'ATTACK:e10460' })
  // A held cell that leaves the offer still releases to the newer retreat.
  const dropped = evaluateActionCommitment({
    ...base,
    chosenId: 'RETREAT:p34_62_-20',
    inFlightOffered: false,
  })
  const pass =
    held.committed === true &&
    held.chosenId === 'RETREAT:p34_62_-2' &&
    kindSwitch.committed === false &&
    kindSwitch.chosenId === 'ATTACK:e10460' &&
    (kindSwitch.releaseLine ?? '').includes('reason=contact_threat') &&
    dropped.chosenId === 'RETREAT:p34_62_-20' &&
    (dropped.releaseLine ?? '').includes('reason=no_longer_offered')
  return {
    pass,
    detail: `held=${held.chosenId} kindSwitch=${kindSwitch.chosenId} dropped=${dropped.chosenId} heldLine=${held.line ?? 'none'}`,
  }
})

addCase('(c6) the critical-flight keep consults exactly the survival-answer set', () => {
  // portal-p22 spawn-camp: every post-respawn 'start'-epoch answer was voided
  // by the first damage_taken pending in flight, so the body never executed a
  // single survival action across 15 camped generations. The keep must admit
  // exactly the kinds the threat restriction preserves - no wider (a stale
  // work/WAIT answer taken before injury must still void), no narrower (a
  // danger-zone exit is a survival route, not work).
  const at = (id: string, kind: Candidate['kind'], meta: Candidate['meta'] = { tick: 1 }): Candidate => ({
    id,
    kind,
    label: id,
    targetName: null,
    target: null,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta,
  })
  const kept = ['ATTACK', 'RETREAT', 'ESCALATE', 'EAT', 'EQUIP'] as const
  const dropped = ['MINE', 'CRAFT', 'PLACE', 'WAIT', 'RETRIEVE', 'MOVE', 'DESCEND', 'SMELT', 'PICKUP', 'STEP'] as const
  const keptSet = kept.every((kind) => isSurvivalAnswerCandidate(at(`X:${kind}`, kind)))
  const droppedSet = dropped.every((kind) => !isSurvivalAnswerCandidate(at(`X:${kind}`, kind)))
  const escapeRoutes =
    isSurvivalAnswerCandidate(at('MOVE:dangerzone:p-5_10_0', 'MOVE')) &&
    isSurvivalAnswerCandidate(at('ASCEND:escape:p0_10_0', 'MOVE', { tick: 1, escapeAscent: true })) &&
    isSurvivalAnswerCandidate(at('SWIM:exit:p0_10_0', 'MOVE', { tick: 1, swimRoute: true }))
  const workMove = !isSurvivalAnswerCandidate(at('MOVE:p-5_10_0', 'MOVE'))
  const pass = keptSet && droppedSet && escapeRoutes && workMove
  return { pass, detail: `kept=${keptSet} dropped=${droppedSet} escapes=${escapeRoutes} workMove=${workMove}` }
})

// ---------------------------------------------------------------------------
// (d) a genuinely unavoidable death fabricates no success
// ---------------------------------------------------------------------------

addCase('(d1) with no grounded attack or escape the offer is a bounded ESCALATE, never work', () => {
  // Contract pin: when the code can ground no attack and no keep-distance
  // route, the work set is NOT handed back (the pre-existing fallback), the
  // offer is a single bounded ESCALATE and the gap is named.
  const state = bodyState([hostile(19, 'creeper', { x: 1, y: 10, z: 0.5 }, { attackedSelf: true })])
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const work: Candidate = {
    id: 'RETRIEVE:known:ore:b9_10_0',
    kind: 'RETRIEVE',
    label: 'return to the remembered diamond',
    targetName: 'diamond_ore',
    target: REMEMBERED,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: { tick: state.tick },
  }
  const noResponse = applyThreatRestriction(state, [work])
  const line =
    noResponse.gap === null
      ? ''
      : formatThreatNoEscape('collect:diamond', state.signals.threat!, weaponFacts(null), noResponse.gap.reason)
  const pass =
    noResponse.candidates.length === 1 &&
    noResponse.candidates[0]?.kind === 'ESCALATE' &&
    noResponse.gap?.reason === 'no_grounded_threat_response' &&
    line.startsWith('THREAT_NO_ESCAPE ') &&
    line.includes('threat=creeper') &&
    !noResponse.candidates.some((candidate) => candidate.id === work.id)
  return { pass, detail: `offered=[${ids(noResponse.candidates).join(',')}] gap=${noResponse.gap?.reason ?? 'none'} | ${line}` }
})

addCase('(d2) a lethal fight in the controller chain never offers WAIT or work, and no fake escape', () => {
  // The real chain: threat restriction, then the critical-health envelope. The
  // measured death had health 2.17, a zombie in contact, and a WAIT/work offer.
  const state = bodyState([hostile(21, 'zombie', { x: 2, y: 10, z: 0.5 }, { attackedSelf: true })])
  state.self = { ...state.self, health: 2, food: 0 }
  state.terrain = { standable: [SELF], escapeCells: [] }
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const generated = generateCandidates(state, defaultCandidateOptions)
  const restricted = restrictCandidatesAtCriticalHealth(state, applyThreatRestriction(state, generated).candidates)
  const retreats = restricted.filter((candidate) => candidate.kind === 'RETREAT')
  const pass =
    generated.some((candidate) => candidate.id === 'WAIT') &&
    restricted.length > 0 &&
    restricted.every(
      (candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'MINE' && candidate.kind !== 'RETRIEVE',
    ) &&
    // No fabricated escape: every RETREAT that survives really gains separation.
    retreats.every((candidate) => (candidate.meta.separationGain as number) >= MIN_KEEP_DISTANCE_GAIN) &&
    restricted.every((candidate) => candidate.kind !== 'ATTACK' || candidate.targetEntityId === 21)
  return {
    pass,
    detail: `generated=[${ids(generated).join(',')}] chain=[${ids(restricted).join(',')}] retreats=${retreats.length}`,
  }
})

// ---------------------------------------------------------------------------
// sensor + envelope facts
// ---------------------------------------------------------------------------

addCase('(e1) the sensor grounds escape cells only while a hostile is inside the danger radius', () => {
  const Vec3 = require('vec3')
  const position = new Vec3(0.5, 10, 0.5)
  const withZombie = (entities: Record<number, unknown>): Bot =>
    ({
      username: 'AI_M3MOB',
      entity: { id: 1, position, yaw: 0, pitch: 0, onGround: true },
      heldItem: null,
      health: 20,
      food: 2,
      game: { gameMode: 'survival', dimension: 'minecraft:overworld', minY: 0, height: 256 },
      time: { isDay: false },
      registry: null,
      entities,
      inventory: { items: () => [] },
      // air above y=9, solid support at y=9: the only standable plane is y=10
      blockAt: (p: { y: number }) => (p.y < 10 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }),
      canSeeBlock: () => false,
      findBlocks: () => [],
    }) as never
  const zombie = { id: 42, name: 'zombie', kind: 'hostile', position: new Vec3(1.5, 10, 0.5), isValid: true, heldItem: null }
  const farZombie = { ...zombie, position: new Vec3(20.5, 10, 0.5) }
  const input = (signalsOverride: AgentSignals) => ({
    tick: 4,
    goal: goalState(),
    goalQueue: queue(),
    recentEvents: [],
    signals: signalsOverride,
  })
  const threatened = buildWorldState(withZombie({ 42: zombie }), input(signals()), defaultSensorOptions)
  const peaceful = buildWorldState(withZombie({ 42: farZombie }), input(signals()), defaultSensorOptions)
  const cells = threatened.terrain.escapeCells ?? []
  const gains = cells.map((cell) =>
    Math.sqrt((cell.x - 1.5) ** 2 + (cell.y - 10) ** 2 + (cell.z - 0.5) ** 2),
  )
  const pass =
    cells.length > 0 &&
    cells.every((cell) => cell.y === 10) &&
    gains.every((separation) => separation >= MELEE_THREAT_REACH) &&
    (peaceful.terrain.escapeCells ?? []).length === 0
  return {
    pass,
    detail: `threatenedCells=${cells.length} minSeparation=${gains.length === 0 ? 'none' : Math.min(...gains).toFixed(2)} peacefulCells=${(peaceful.terrain.escapeCells ?? []).length}`,
  }
})

addCase('(f1) the measured 22:19 death window now offers a real escape, not the 1.4m shuffle', () => {
  // Exact live geometry from `run-mubobiq6-12onv` 2026-09-21T22:19:39Z:
  //   body   (28.7, 65, 11.4)   zombie (28.14, 65, 11.91) 0.78m
  //   spider (27.7, 66.68, 12.3) 2.16m
  //   offered RETREAT:p30_65_10 (1.888m), RETREAT:p29_66_10 (1.71m),
  //   RETREAT:p28_66_10 (1.81m), RETREAT:p28_64_12 (1.372m)
  // and the body selected one of those, executed `moved=0m`, and died on it
  // (22:19:44 DEATH pos=28.7,65.0,11.4 healthBefore=2.17).
  const body: Vec3Json = { x: 28.7, y: 65, z: 11.4 }
  const state = bodyState(
    [
      hostile(33467, 'zombie', { x: 28.14, y: 65, z: 11.91 }, { attackedSelf: true }, body),
      hostile(33478, 'spider', { x: 27.7, y: 66.68, z: 12.3 }, {}, body),
    ],
    { self: selfState(body, { health: 19, food: 2 }) },
  )
  // The measured local window.
  state.terrain = {
    standable: [
      body,
      { x: 30, y: 65, z: 10 },
      { x: 29, y: 66, z: 10 },
      { x: 28, y: 66, z: 10 },
      { x: 28, y: 64, z: 12 },
    ],
    // The wider threat scan the sensor now runs: real cells away from the mob.
    escapeCells: [
      { x: 34, y: 65, z: 11 },
      { x: 33, y: 66, z: 12 },
      { x: 33, y: 65, z: 13 },
    ],
  }
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const generated = generateCandidates(state, defaultCandidateOptions)
  const offered = applyThreatRestriction(state, generated)
  const retreats = offered.candidates.filter((candidate) => candidate.kind === 'RETREAT')
  const oldShuffle = retreats.filter((candidate) => (candidate.meta.separationGain as number) < MIN_KEEP_DISTANCE_GAIN)
  const attack = offered.candidates.find((candidate) => candidate.kind === 'ATTACK')
  const pass =
    state.signals.threat.active === true &&
    state.signals.threat.inContact === true &&
    offered.candidates.length > 0 &&
    offered.candidates.every((candidate) => THREAT_SURVIVAL_KINDS.has(candidate.kind)) &&
    oldShuffle.length === 0 &&
    retreats.length > 0 &&
    retreats.every((candidate) => (candidate.meta.separationGain as number) >= MIN_KEEP_DISTANCE_GAIN) &&
    retreats.some((candidate) => candidate.meta.escapeScan === true) &&
    // The starving body (food=2, no regen) dies to the zombie long before the
    // fist kill lands - the measured death. The race gate withholds it.
    attack === undefined
  return {
    pass,
    detail: `offered=[${ids(offered.candidates).join(',')}] retreatGains=[${retreats
      .map((candidate) => candidate.meta.separationGain)
      .join(',')}] attack=${attack?.id ?? 'none'}`,
  }
})

addCase('(e2) the danger radius is the bounded combat envelope, and the contract values hold', () => {
  const pass =
    COMBAT_CANDIDATE_RANGE === THREAT_DANGER_RADIUS &&
    THREAT_DANGER_RADIUS > MELEE_THREAT_REACH &&
    MIN_KEEP_DISTANCE_GAIN > 1 &&
    THREAT_CLEAR_MS >= 1000 &&
    weaponFacts('diamond_sword').damage === 7 &&
    weaponFacts('iron_pickaxe').kind === 'tool' &&
    weaponFacts('oak_log').kind === 'block'
  return {
    pass,
    detail: `danger=${THREAT_DANGER_RADIUS} contact=${MELEE_THREAT_REACH} minGain=${MIN_KEEP_DISTANCE_GAIN} clearMs=${THREAT_CLEAR_MS}`,
  }
})

// ---------------------------------------------------------------------------
// (g) §4.1 world-shaping survival answers (portal-p23 gen-mutp1aul):
//     `escapes=0` closes locomotion only - the offer names the grounded
//     shaping affordances (vertical-escape pillar, approach-lane wall)
//     alongside combat, and the threat restriction keeps them.
// ---------------------------------------------------------------------------

addCase('(g1) a contact melee threat with placeable dirt offers pillar and wall, not ATTACK-only', () => {
  // Measured live (portal-p23 gen-mutp1aul, 2026-10-04T10:44:4x): a naked
  // respawn at a water-adjacent pocket saw `SURVIVAL_ESCAPE_NONE escapes=0`
  // and the offer collapsed to bare-fist ATTACKs while dirt sat in hand -
  // the locomotion gap erased every world-modification affordance.
  const state = bodyState([hostile(10460, 'drowned', { x: 2.5, y: 10, z: 0.5 }, { attackedSelf: true })], {
    inventory: { slots: [], counts: { dirt: 4 }, totalItems: 4 },
  })
  state.terrain = { standable: [SELF], escapeCells: [] }
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const generated = generateCandidates(state, defaultCandidateOptions)
  const offered = applyThreatRestriction(state, generated)
  const pillar = offered.candidates.find((candidate) => candidate.meta.escapePillar === true)
  const wall = offered.candidates.find((candidate) => candidate.meta.threatWall === true)
  const pass =
    state.signals.threat.active === true &&
    state.signals.threat.inContact === true &&
    offered.restricted === true &&
    pillar !== undefined &&
    pillar.id.startsWith('MOVE:escapeup:') &&
    pillar.kind === 'MOVE' &&
    pillar.meta.vertical === 'pillar' &&
    pillar.meta.pillarSteps === 2 &&
    pillar.meta.pillarPlaceName === 'dirt' &&
    wall !== undefined &&
    wall.kind === 'PLACE' &&
    wall.itemName === 'dirt' &&
    wall.placementCells?.length === 2 &&
    wall.placementCells[0]?.y === 10 &&
    wall.placementCells[1]?.y === 11
  return {
    pass,
    detail: `offered=[${ids(offered.candidates).join(',')}] wallCells=${(wall?.placementCells ?? []).length}`,
  }
})

addCase('(g2) a ranged threat suppresses the pillar but keeps the wall', () => {
  const state = bodyState([hostile(99, 'skeleton', { x: 3, y: 10, z: 0.5 })], {
    inventory: { slots: [], counts: { dirt: 4 }, totalItems: 4 },
  })
  state.terrain = { standable: [SELF], escapeCells: [] }
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const generated = generateCandidates(state, defaultCandidateOptions)
  const offered = applyThreatRestriction(state, generated)
  const pillar = offered.candidates.find((candidate) => candidate.meta.escapePillar === true)
  const wall = offered.candidates.find((candidate) => candidate.meta.threatWall === true)
  return {
    pass: pillar === undefined && wall !== undefined,
    detail: `offered=[${ids(offered.candidates).join(',')}]`,
  }
})

addCase('(g3) no placeable material emits neither shaping answer', () => {
  const state = bodyState([hostile(98, 'zombie', { x: 2.5, y: 10, z: 0.5 })])
  state.terrain = { standable: [SELF], escapeCells: [] }
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const generated = generateCandidates(state, defaultCandidateOptions)
  const shaping = generated.filter((candidate) => candidate.meta.escapePillar === true || candidate.meta.threatWall === true)
  return {
    pass: shaping.length === 0,
    detail: `generated=[${ids(generated).join(',')}]`,
  }
})

addCase('(g4) one held block offers a one-cell wall and no two-step pillar', () => {
  const state = bodyState([hostile(97, 'zombie', { x: 2.5, y: 10, z: 0.5 })], {
    inventory: { slots: [], counts: { dirt: 1 }, totalItems: 1 },
  })
  state.terrain = { standable: [SELF], escapeCells: [] }
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const generated = generateCandidates(state, defaultCandidateOptions)
  const wall = generated.find((candidate) => candidate.meta.threatWall === true)
  const pillar = generated.find((candidate) => candidate.meta.escapePillar === true)
  return {
    pass: pillar === undefined && wall !== undefined && wall.placementCells?.length === 1,
    detail: `wall=${wall?.id ?? 'none'} cells=${(wall?.placementCells ?? []).length}`,
  }
})

addCase('(g5) a lane cell the scan names solid is never a fill target', () => {
  const state = bodyState([hostile(96, 'zombie', { x: 2.5, y: 10, z: 0.5 })], {
    inventory: { slots: [], counts: { dirt: 4 }, totalItems: 4 },
  })
  state.terrain = { standable: [SELF], escapeCells: [] }
  // The lane column toward the zombie is (1,10,0); its feet cell is stone.
  state.blocks = [
    {
      kind: 'stone',
      name: 'stone',
      position: { x: 1, y: 10, z: 0 },
      distance: 1.4,
      diggable: true,
      inReach: true,
      hasAdjacentStandable: true,
      adjacentStandable: null,
    },
  ]
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const generated = generateCandidates(state, defaultCandidateOptions)
  const wall = generated.find((candidate) => candidate.meta.threatWall === true)
  const cells = wall?.placementCells ?? []
  return {
    pass:
      wall !== undefined &&
      cells.length === 1 &&
      cells[0]?.y === 11 &&
      cells.every((cell) => !(cell.x === 1 && cell.y === 10 && cell.z === 0)),
    detail: `cells=[${cells.map((cell) => `${cell.x},${cell.y},${cell.z}`).join(';')}]`,
  }
})

addCase('(g6) a starved body under contact offers MINE:survival material sources and no race-lost ATTACK (run-mutlktrv-3xw deaths #12-14 camp cluster)', () => {
  // The measured shape: `itemsLost=0` respawn, contact zombie, no placeable -
  // the offer collapsed to a bare-fist ATTACK that cannot out-race the body.
  const state = bodyState([hostile(90, 'zombie', { x: 2.5, y: 10, z: 0.5 }, { attackedSelf: true })])
  state.terrain = { standable: [SELF], escapeCells: [] }
  state.survivalDigCells = [
    { position: { x: 1, y: 9, z: 0 }, name: 'grass_block', yieldItem: 'dirt' },
    { position: { x: 1, y: 9, z: -1 }, name: 'dirt', yieldItem: 'dirt' },
  ]
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  const generated = generateCandidates(state, defaultCandidateOptions)
  const offered = applyThreatRestriction(state, generated)
  const dig = offered.candidates.find((candidate) => candidate.meta.survivalDig === true)
  const attack = generated.find((candidate) => candidate.kind === 'ATTACK')
  const pass =
    dig !== undefined &&
    dig.id.startsWith('MINE:survival:') &&
    dig.kind === 'MINE' &&
    dig.meta.yieldItem === 'dirt' &&
    isSurvivalAnswerCandidate(dig) === true &&
    attack !== undefined &&
    attack.meta.attackRaceLost === true &&
    !offered.candidates.some((candidate) => candidate.kind === 'ATTACK')
  return {
    pass,
    detail: `dig=${dig?.id ?? 'none'} attack=${attack?.id ?? 'none'} race=${String(attack?.meta.attackRace)} offered=[${ids(offered.candidates).join(',')}]`,
  }
})

addCase('(g7) the attack race verdict: fists lose even while regenerating, a sword wins, unknown names fail open', () => {
  const fistVsZombie = assessAttackRace({ threatName: 'zombie', threatHealth: null, swingDamage: 1, bodyHealth: 20, bodyRegenerating: false })
  const swordVsZombie = assessAttackRace({ threatName: 'zombie', threatHealth: null, swingDamage: 4, bodyHealth: 20, bodyRegenerating: false })
  const fistVsWoundedZombie = assessAttackRace({ threatName: 'zombie', threatHealth: 6, swingDamage: 1, bodyHealth: 20, bodyRegenerating: false })
  const unknownMob = assessAttackRace({ threatName: 'wither_skeleton', threatHealth: null, swingDamage: 1, bodyHealth: 5, bodyRegenerating: false })
  // The measured case: a fresh respawn reads regenerating (food=20) and the
  // fist race is still hopeless - regeneration banks hearts, not immunity.
  const regenFistVsZombie = assessAttackRace({ threatName: 'zombie', threatHealth: null, swingDamage: 1, bodyHealth: 20, bodyRegenerating: true })
  // The bonus flips a marginal fight: hp 4 dies before a 2-hp zombie falls,
  // hp 4 + banked regen outlasts the kill.
  const regenMarginal = assessAttackRace({ threatName: 'zombie', threatHealth: 2, swingDamage: 1, bodyHealth: 4, bodyRegenerating: true })
  const sameMarginalStarved = assessAttackRace({ threatName: 'zombie', threatHealth: 2, swingDamage: 1, bodyHealth: 4, bodyRegenerating: false })
  // The measured miss: a creeper blast is ~30 hearts inside reach. Unarmored
  // at full health the race is always lost; diamond armor (20 pts -> 80%
  // mitigation) makes the same sword fight survivable enough to offer.
  const creeperUnarmored = assessAttackRace({ threatName: 'creeper', threatHealth: null, swingDamage: 7, bodyHealth: 20, bodyRegenerating: true })
  const creeperArmored = assessAttackRace({ threatName: 'creeper', threatHealth: null, swingDamage: 7, bodyHealth: 20, bodyRegenerating: true, bodyArmorPoints: 20 })
  const pass =
    fistVsZombie.lost === true &&
    fistVsZombie.reason === 'race_lost' &&
    swordVsZombie.lost === false &&
    swordVsZombie.reason === 'race_winnable' &&
    fistVsWoundedZombie.lost === false &&
    unknownMob.lost === false &&
    unknownMob.known === false &&
    regenFistVsZombie.lost === true &&
    regenMarginal.lost === false &&
    sameMarginalStarved.lost === true &&
    creeperUnarmored.lost === true &&
    creeperArmored.lost === false
  return {
    pass,
    detail: `fist=${fistVsZombie.killMs}/${fistVsZombie.deathMs} regenFist=${regenFistVsZombie.lost} creeper=${creeperUnarmored.lost}/${creeperArmored.lost} unknown=${unknownMob.known}`,
  }
})

// --- (h) survivalDigCells sensor: the zero-material material source ----------

type DigBlockSpec = { name: string; boundingBox: string }
const digSolid = (name: string): DigBlockSpec => ({ name, boundingBox: 'block' })
const digEmpty = (): DigBlockSpec => ({ name: 'air', boundingBox: 'empty' })
const digKey = (x: number, y: number, z: number): string => `${x},${y},${z}`

/** A stub world for the sensor: "x,y,z" -> block, missing cells unloaded. */
function digBot(blocks: Record<string, DigBlockSpec>, selfPos: Vec3Json): Bot {
  const entity = {
    position: {
      ...selfPos,
      set(x: number, y: number, z: number) {
        this.x = x
        this.y = y
        this.z = z
        return this
      },
      clone() {
        return { x: this.x, y: this.y, z: this.z, set: this.set }
      },
    },
  }
  return {
    entity,
    blockAt: (p: { x: number; y: number; z: number }) =>
      blocks[digKey(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))] ?? null,
    registry: {
      blocksByName: {
        dirt: { drops: [3] },
        grass_block: { drops: [3] },
        sand: { drops: [4] },
        stone: { drops: [5] },
        gravel: { drops: [6] },
        mud: { drops: [7] },
      },
      items: {
        3: { name: 'dirt' },
        4: { name: 'sand' },
        5: { name: 'cobblestone' },
        6: { name: 'gravel' },
        7: { name: 'mud' },
      },
    },
  } as unknown as Bot
}

addCase('(h1) starved + threatened: adjacent soft solids emit dig cells, the standing cell is excluded', () => {
  const self = selfState(SELF)
  const zombie = hostile(80, 'zombie', { x: 2.5, y: 10, z: 0.5 })
  const g: Record<string, DigBlockSpec> = {
    // Standing cell + floor: floor never offered, own column excluded anyway.
    [digKey(0, 9, 0)]: digSolid('dirt'),
    // Lane toward the zombie (+x): grass drops dirt.
    [digKey(1, 9, 0)]: digSolid('grass_block'),
    [digKey(2, 9, 0)]: digSolid('grass_block'),
    // Off-lane dirt and a sand cell at feet level.
    [digKey(0, 9, -1)]: digSolid('dirt'),
    [digKey(-1, 10, 0)]: digSolid('sand'),
    // Stone is not in the soft set - too slow to fist-mine inside a melee
    // window; filtered by name before the harvest lookup ever runs.
    [digKey(0, 9, 1)]: digSolid('stone'),
    [digKey(-1, 9, 0)]: digEmpty(),
  }
  const cells = buildSurvivalDigCells(
    digBot(g, SELF),
    self,
    [zombie],
    null,
    {},
    { ...defaultSensorOptions, reach: 4.5 },
    NOW,
  )
  const standing = cells.find((cell) => cell.position.x === 0 && cell.position.z === 0)
  const names = cells.map((cell) => `${cell.position.x},${cell.position.y},${cell.position.z}:${cell.name}->${cell.yieldItem}`)
  const pass =
    cells.length > 0 &&
    cells.length <= 4 &&
    standing === undefined &&
    cells.every((cell) => cell.yieldItem.length > 0) &&
    cells.some((cell) => cell.name === 'grass_block' && cell.yieldItem === 'dirt') &&
    // Lane-first ordering: the +x grass cells sort before the off-lane cells.
    cells[0] !== undefined &&
    cells[0].position.x === 1 &&
    cells[0].position.z === 0
  return { pass, detail: `cells=[${names.join(' | ')}]` }
})

addCase('(h2) the sensor stays silent while a placeable is already held or no threat is active', () => {
  const self = selfState(SELF)
  const zombie = hostile(79, 'zombie', { x: 2.5, y: 10, z: 0.5 })
  const g: Record<string, DigBlockSpec> = { [digKey(1, 9, 0)]: digSolid('dirt') }
  const withPlaceable = buildSurvivalDigCells(
    digBot(g, SELF),
    self,
    [zombie],
    null,
    { dirt: 4 },
    { ...defaultSensorOptions, reach: 4.5 },
    NOW,
  )
  const noThreat = buildSurvivalDigCells(
    digBot(g, SELF),
    self,
    [],
    null,
    {},
    { ...defaultSensorOptions, reach: 4.5 },
    NOW,
  )
  const pass = withPlaceable.length === 0 && noThreat.length === 0
  return { pass, detail: `withPlaceable=${withPlaceable.length} noThreat=${noThreat.length}` }
})

addCase('(h3) blocks whose drop cannot feed the wall/pillar answers are never offered', () => {
  const self = selfState(SELF)
  const zombie = hostile(78, 'zombie', { x: 2.5, y: 10, z: 0.5 })
  // obsidian is not in the soft set (name filter). gravel/mud ARE in the set
  // and resolve real drops (`gravel`/`mud`), but neither yield is
  // PILLAR_PLACE_PRIORITY-selectable, so digging them can never satisfy the
  // placeable starvation the arm exists to break - the same contract the
  // producer scan applies. Only the dirt cell (yield `dirt`) survives.
  // Live evidence: `MINE:survival:b-17_24_16` offered gravel thousands of
  // epochs and every lease answered TARGET_GONE because the cell was never in
  // `state.blocks`.
  const g: Record<string, DigBlockSpec> = {
    [digKey(1, 9, 0)]: digSolid('obsidian'),
    [digKey(1, 9, 1)]: digSolid('gravel'),
    [digKey(2, 9, 1)]: digSolid('mud'),
    [digKey(-1, 9, 0)]: digSolid('dirt'),
  }
  const cells = buildSurvivalDigCells(
    digBot(g, SELF),
    self,
    [zombie],
    null,
    {},
    { ...defaultSensorOptions, reach: 4.5 },
    NOW,
  )
  const pass = cells.length === 1 && cells[0] !== undefined && cells[0].name === 'dirt'
  return { pass, detail: `cells=[${cells.map((cell) => cell.name).join(',')}]` }
})

addCase('(h4) a survival dig cell that has exhausted its own retry budget is not re-offered', () => {
  // Same-arm complement of the yield contract: the candidate layer honours
  // the ordinary spatial failure memory. The measured loop leased one dead
  // cell for thousands of epochs precisely because the arm ignored it.
  const state = bodyState([hostile(77, 'zombie', { x: 2.5, y: 10, z: 0.5 }, { attackedSelf: true })])
  state.terrain = { standable: [SELF], escapeCells: [] }
  state.survivalDigCells = [
    { position: { x: 1, y: 9, z: 0 }, name: 'dirt', yieldItem: 'dirt' },
    { position: { x: -2, y: 9, z: 0 }, name: 'dirt', yieldItem: 'dirt' },
  ]
  state.signals.threat = new ThreatTracker().note({ atMs: NOW, entities: state.entities })
  state.signals.failedCandidates = { 'MINE:survival:b1_9_0': 40 }
  const generated = generateCandidates(state, defaultCandidateOptions)
  const digs = generated.filter((candidate) => candidate.meta.survivalDig === true)
  const pass =
    digs.length === 1 &&
    digs[0] !== undefined &&
    digs[0].id === 'MINE:survival:b-2_9_0'
  return { pass, detail: `digs=[${digs.map((candidate) => candidate.id).join(',')}]` }
})

let failures = 0
process.stdout.write('mob survival - grounded threat response, bounded danger state, honest retreats\n')
process.stdout.write('-'.repeat(78) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(78) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} mob-survival cases passed\n`)

if (failures > 0) process.exit(1)
