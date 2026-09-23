// test-threat-response.mts - P1 durability: the resident must be able to answer
// a ranged attacker.
//
// Operator report: "In the Nether it paces back and forth and does not react
// even when a skeleton attacks it."
//
// Measured gap (live, 2026-09-21T15:15:09Z): a skeleton at 11.33m shooting the
// bot produced `combat=[]` in the Jev candidate set, because ATTACK stops at 8m
// and RETREAT was only generated for hostiles inside 3.2m. This fixture pins the
// three layers that must hold:
//
//   1. threat EVIDENCE reaches the authority state Jev reads;
//   2. at least one GROUNDED response candidate exists for a credible threat;
//   3. taking damage is a PREEMPTIVE decision trigger.
//
// and that a peaceful state yields neither evidence nor a combat candidate.
//
// The fail-before behaviour is the absence of (1) and (2); (3) is an existing
// invariant kept under test.
//
//   bun test ./test-threat-response.mts
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import {
  defaultCandidateOptions,
  generateCandidates,
  isResponseWorthyThreat,
  IMMEDIATE_HOSTILE_RANGE,
  COMBAT_CANDIDATE_RANGE,
  THREAT_RESPONSE_RANGE,
} from './src/candidates.ts'
import { authorityState } from './src/jev-authority.ts'
import { EventLogger } from './src/jev.ts'
import { DecisionScheduler, PREEMPTIVE_TRIGGERS, shouldInterruptAttackLease, TRIGGER_PRIORITY } from './src/scheduler.ts'
import type { TriggerEvent } from './src/scheduler.ts'
import { buildWorldState, defaultSensorOptions } from './src/state.ts'
import type { AgentSignals, EntityState, GoalState, InventoryState, LastDamageEvidence, SelfState, Vec3Json, WorldState } from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { JevRequest } from './src/jev-legacy.ts'

const require = createRequire(import.meta.url)

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const SELF: Vec3Json = { x: 0.5, y: 10, z: 0.5 }
const FLEE_SPOT: Vec3Json = { x: -6, y: 10, z: 0.5 }
const FLEE_SPOT_2: Vec3Json = { x: -3, y: 10, z: 3.5 }
const SKELETON_POSITION: Vec3Json = { x: 10.5, y: 10, z: 0.5 }
const SKELETON_DISTANCE = 10

/** Fixed "now" so the threat-memory window is deterministic in the fixture. */
const NOW = 1_700_000_000_000

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
    dimension: 'minecraft:the_nether',
    isDay: true,
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

function baseState(entities: EntityState[], lastDamage: LastDamageEvidence | null, self: SelfState): WorldState {
  const inventory: InventoryState = { slots: [], counts: {}, totalItems: 0 }
  return {
    schemaVersion: 1,
    tick: 11,
    timestampMs: NOW,
    self,
    inventory,
    entities,
    blocks: [],
    terrain: { standable: [SELF, FLEE_SPOT, FLEE_SPOT_2] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goalState(),
    goalQueue: queue(),
    recentEvents: [],
    signals: signals({ lastDamage }),
  }
}

/** A skeleton that shot the bot from 10m: the live failure shape. */
function attackingSkeleton(): EntityState {
  return {
    id: 42,
    name: 'skeleton',
    kind: 'hostile',
    username: null,
    position: SKELETON_POSITION,
    distance: SKELETON_DISTANCE,
    hostile: true,
    lineOfSight: true,
    heldItem: 'bow',
    attackedSelf: true,
  }
}

const ATTACKED_DAMAGE: LastDamageEvidence = {
  atMs: NOW - 500,
  health: 12,
  sourceId: 42,
  sourceName: 'skeleton',
}

function combatIds(state: WorldState): string[] {
  return generateCandidates(state, defaultCandidateOptions)
    .filter((candidate) => candidate.kind === 'ATTACK' || candidate.kind === 'RETREAT' || candidate.kind === 'EAT')
    .map((candidate) => candidate.id)
}

function authorityRequest(state: WorldState, candidates: ReturnType<typeof generateCandidates>): JevRequest {
  return { stage: 'fixture', state, candidates }
}

/**
 * Live-sensor double: a skeleton with line of sight, a bow, and an occluded
 * zombie. `canSeeBlock` is the ray the sensor uses for entity line of sight.
 */
function fakeThreatBot(): Bot {
  const Vec3 = require('vec3')
  const position = new Vec3(0.5, 10, 0.5)
  return {
    username: 'AI_THREAT',
    entity: { id: 1, position, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 12,
    food: 20,
    game: { gameMode: 'survival', dimension: 'minecraft:the_nether', minY: 0, height: 256 },
    time: { isDay: false },
    registry: null,
    entities: {
      42: {
        id: 42,
        name: 'skeleton',
        kind: 'hostile',
        position: new Vec3(10.5, 10, 0.5),
        isValid: true,
        heldItem: { name: 'bow', count: 1 },
      },
      43: {
        id: 43,
        name: 'zombie',
        kind: 'hostile',
        position: new Vec3(3.5, 10, 0.5),
        isValid: true,
        heldItem: null,
      },
    },
    inventory: { items: () => [] },
    blockAt: () => null,
    canSeeBlock: (target: { id?: number }) => target?.id !== 43,
    findBlocks: () => [],
  } as never
}

// ---------------------------------------------------------------------------
// (i) threat evidence reaches the authority state
// ---------------------------------------------------------------------------

addCase('the sensor projects sight, weapon and attacker attribution onto a sensed hostile', () => {
  const state = buildWorldState(
    fakeThreatBot(),
    {
      tick: 3,
      goal: goalState(),
      goalQueue: queue(),
      recentEvents: [],
      signals: signals({ lastDamage: ATTACKED_DAMAGE }),
    },
    defaultSensorOptions,
  )
  const skeleton = state.entities.find((entity) => entity.id === 42)
  const zombie = state.entities.find((entity) => entity.id === 43)
  const pass =
    skeleton?.hostile === true &&
    skeleton?.lineOfSight === true &&
    skeleton?.heldItem === 'bow' &&
    skeleton?.attackedSelf === true &&
    zombie?.lineOfSight === false &&
    zombie?.attackedSelf === false
  return {
    pass,
    detail: `skeleton=${JSON.stringify(skeleton ?? null)} zombie=${JSON.stringify(zombie ?? null)}`,
  }
})

addCase('a skeleton that shot the bot is visible to Jev with distance, sight, weapon and attacker attribution', () => {
  const state = baseState([attackingSkeleton()], ATTACKED_DAMAGE, selfState(SELF, { health: 12 }))
  const payload = authorityState(authorityRequest(state, generateCandidates(state, defaultCandidateOptions)))
  const entities = payload.nearestEntities as EntityState[]
  const skeleton = entities.find((entity) => entity.id === 42)
  const self = payload.self as { health: number; lastDamage: LastDamageEvidence | null }
  const pass =
    skeleton !== undefined &&
    skeleton.hostile === true &&
    skeleton.distance === SKELETON_DISTANCE &&
    skeleton.lineOfSight === true &&
    skeleton.heldItem === 'bow' &&
    skeleton.attackedSelf === true &&
    self.lastDamage?.sourceId === 42 &&
    self.lastDamage?.sourceName === 'skeleton'
  return {
    pass,
    detail: `skeleton=${JSON.stringify(skeleton ?? null)} lastDamage=${JSON.stringify(self.lastDamage)}`,
  }
})

// ---------------------------------------------------------------------------
// (ii) at least one grounded response candidate exists for the threat
// ---------------------------------------------------------------------------

addCase('a skeleton shooting from 10m (beyond melee, inside bow range) gets a grounded RETREAT and a grounded ATTACK on that entity', () => {
  const state = baseState([attackingSkeleton()], ATTACKED_DAMAGE, selfState(SELF, { health: 12 }))
  const generated = generateCandidates(state, defaultCandidateOptions)
  const retreats = generated.filter((candidate) => candidate.kind === 'RETREAT')
  const attacks = generated.filter((candidate) => candidate.kind === 'ATTACK')
  const namedThreat = retreats.every((candidate) => candidate.meta.threatEntityId === 42)
  const pass =
    retreats.length >= 1 &&
    retreats.length <= 3 &&
    namedThreat &&
    retreats[0]?.meta.threatAttackedSelf === true &&
    retreats[0]?.meta.threatHeldItem === 'bow' &&
    // 10m is outside the 8m melee-attack band but INSIDE the 24m response
    // envelope, and this skeleton has ENGAGED the body (attackedSelf). An engaged
    // attacker is answerable from anywhere inside that envelope, so BOTH grounded
    // responses are offered: the keep-distance route and the approach leg that
    // feeds the existing ATTACK skill on that same entity. Code ranks neither -
    // WHICH one is taken stays Jev's choice.
    attacks.length === 1 &&
    attacks[0]?.targetEntityId === 42 &&
    SKELETON_DISTANCE > COMBAT_CANDIDATE_RANGE &&
    THREAT_RESPONSE_RANGE >= SKELETON_DISTANCE
  return {
    pass,
    detail: `retreats=[${retreats.map((candidate) => candidate.id).join(',')}] attacks=[${attacks
      .map((candidate) => candidate.id)
      .join(',')}]`,
  }
})

addCase('an unattributed hit still grounds a retreat from a hostile that has line of sight', () => {
  const skeleton: EntityState = { ...attackingSkeleton(), attackedSelf: false }
  const damage: LastDamageEvidence = { atMs: NOW - 500, health: 12, sourceId: null, sourceName: null }
  const state = baseState([skeleton], damage, selfState(SELF, { health: 12 }))
  const entity = state.entities[0]!
  const retreats = generateCandidates(state, defaultCandidateOptions).filter((candidate) => candidate.kind === 'RETREAT')
  const pass = isResponseWorthyThreat(state, entity, NOW) === true && retreats.length >= 1
  return {
    pass,
    detail: `worthy=${isResponseWorthyThreat(state, entity, NOW)} retreats=[${retreats
      .map((candidate) => candidate.id)
      .join(',')}]`,
  }
})

addCase('a hostile that never engaged and is outside melee stays a passive observation', () => {
  const skeleton: EntityState = { ...attackingSkeleton(), attackedSelf: false }
  const state = baseState([skeleton], null, selfState(SELF, { health: 20 }))
  const entity = state.entities[0]!
  const retreats = generateCandidates(state, defaultCandidateOptions).filter((candidate) => candidate.kind === 'RETREAT')
  const pass =
    isResponseWorthyThreat(state, entity, NOW) === false &&
    retreats.length === 0 &&
    SKELETON_DISTANCE > IMMEDIATE_HOSTILE_RANGE
  return {
    pass,
    detail: `worthy=${isResponseWorthyThreat(state, entity, NOW)} retreats=[${retreats
      .map((candidate) => candidate.id)
      .join(',')}]`,
  }
})

// ---------------------------------------------------------------------------
// (iii) taking damage is a preemptive decision trigger that names the attacker
// ---------------------------------------------------------------------------

addCase('damage_taken is a preemptive trigger and interrupts an ATTACK lease at critical health', () => {
  const pass =
    PREEMPTIVE_TRIGGERS.has('damage_taken') &&
    PREEMPTIVE_TRIGGERS.has('hp_changed') &&
    !PREEMPTIVE_TRIGGERS.has('survival_reground') &&
    TRIGGER_PRIORITY.damage_taken > TRIGGER_PRIORITY.survival_reground &&
    shouldInterruptAttackLease('damage_taken', 5, 6) === true &&
    shouldInterruptAttackLease('damage_taken', 15, 6) === false &&
    shouldInterruptAttackLease('survival_reground', 1, 6) === false
  return { pass, detail: 'real damage/hp events preempt; survival_reground is lower-priority, non-preemptive control flow' }
})

addCase('the scheduler forwards the Mineflayer attacker with the damage trigger', () => {
  const bot = new EventEmitter() as unknown as Bot & EventEmitter
  ;(bot as unknown as { entity: unknown }).entity = { id: 1, position: { x: 0, y: 0, z: 0 } }
  ;(bot as unknown as { health: number }).health = 12
  ;(bot as unknown as { food: number }).food = 20
  ;(bot as unknown as { inventory: EventEmitter }).inventory = new EventEmitter()
  const scheduler = new DecisionScheduler(bot, new EventLogger(null, false), { enabledTriggers: ['damage_taken'] })
  const delivered: TriggerEvent[] = []
  scheduler.onDecision((event) => delivered.push(event))
  try {
    scheduler.start()
    const attacker = { id: 42, name: 'skeleton', kind: 'hostile' }
    bot.emit('entityHurt', { id: 1 }, attacker)
  } finally {
    scheduler.stop()
  }
  const damage = delivered.find((event) => event.trigger === 'damage_taken')
  const pass = damage !== undefined && damage.detail.attackerId === 42 && damage.detail.attackerName === 'skeleton'
  return { pass, detail: `delivered=${JSON.stringify(delivered.map((event) => ({ trigger: event.trigger, detail: event.detail })))}` }
})

// ---------------------------------------------------------------------------
// (iv) an UNSENSED attacker: the packet's own damage origin survives
//
// Measured live (main `cd7b38b`, server log `/summon minecraft:ender_dragon`):
// `CRITICAL_DAMAGE health=5 source=ender_dragon` then `DEATH_CAUSE
// killer=ender_dragon killerEvidence=mineflayer killerId=39414 threat=null`. The
// attacker was never in the sensor, so the only thing that can ground a
// direction away from it is the position the server states for the hit -
// `damage_event.sourcePosition`, a field mineflayer's `entityHurt` does not
// carry. This pins that the scheduler reads it, and that a hit WITHOUT one
// reports no position instead of inventing one.
// ---------------------------------------------------------------------------

/** A bot double with a live `_client` packet emitter, i.e. one that can hurt. */
function damageBot(): Bot & EventEmitter {
  const bot = new EventEmitter() as unknown as Bot & EventEmitter
  ;(bot as unknown as { entity: unknown }).entity = { id: 1, position: { x: 5.5, y: 59, z: -0.5 } }
  ;(bot as unknown as { health: number }).health = 1.67
  ;(bot as unknown as { food: number }).food = 20
  ;(bot as unknown as { inventory: EventEmitter }).inventory = new EventEmitter()
  ;(bot as unknown as { _client: EventEmitter })._client = new EventEmitter()
  return bot
}

function damageTrigger(bot: Bot & EventEmitter): TriggerEvent | undefined {
  const scheduler = new DecisionScheduler(bot, new EventLogger(null, false), { enabledTriggers: ['damage_taken'] })
  const delivered: TriggerEvent[] = []
  scheduler.onDecision((event) => delivered.push(event))
  try {
    scheduler.start()
    // The server's packet arrives first, then mineflayer emits `entityHurt`
    // (entities.js: `damage_event` -> `bot.emit('entityHurt', entity, source)`).
    // `source` is undefined here on purpose: this is the measured case where the
    // client never received the attacking entity at all.
    ;(bot as unknown as { _client: EventEmitter })._client.emit('damage_event', {
      entityId: 1,
      sourceTypeId: 0,
      sourceCauseId: 39415,
      sourceDirectId: 0,
      sourcePosition: { x: 5, y: 59, z: 12 },
    })
    bot.emit('entityHurt', { id: 1 }, undefined)
  } finally {
    scheduler.stop()
  }
  return delivered.find((event) => event.trigger === 'damage_taken')
}

addCase('the scheduler carries the packet damage origin, and an origin-less hit stays unknown', () => {
  const withOrigin = damageTrigger(damageBot())
  const bot = damageBot()
  const scheduler = new DecisionScheduler(bot, new EventLogger(null, false), { enabledTriggers: ['damage_taken'] })
  const delivered: TriggerEvent[] = []
  scheduler.onDecision((event) => delivered.push(event))
  try {
    scheduler.start()
    // No `damage_event` packet at all: a server that sent none, or an older
    // protocol. The origin must be ABSENT, not defaulted to a coordinate.
    bot.emit('entityHurt', { id: 1 }, undefined)
  } finally {
    scheduler.stop()
  }
  const withoutOrigin = delivered.find((event) => event.trigger === 'damage_taken')
  const pass =
    withOrigin !== undefined &&
    (withOrigin.detail.attackerPosition as { x: number; y: number; z: number } | undefined)?.z === 12 &&
    withoutOrigin !== undefined &&
    withoutOrigin.detail.attackerPosition === undefined &&
    // the packet listener is removed with the scheduler (issue #13: no leaks)
    (bot as unknown as { _client: EventEmitter })._client.listenerCount('damage_event') === 0
  return {
    pass,
    detail: `withOrigin=${JSON.stringify(withOrigin?.detail ?? null)} withoutOrigin=${JSON.stringify(withoutOrigin?.detail ?? null)}`,
  }
})

// ---------------------------------------------------------------------------
// peaceful control: neither evidence nor a combat candidate
// ---------------------------------------------------------------------------

addCase('a peaceful Nether (no hostile, no damage) has neither threat evidence nor a combat candidate', () => {
  const cow: EntityState = {
    id: 7,
    name: 'cow',
    kind: 'passive',
    username: null,
    position: SKELETON_POSITION,
    distance: SKELETON_DISTANCE,
    hostile: false,
    lineOfSight: true,
    heldItem: null,
    attackedSelf: false,
  }
  const state = baseState([], null, selfState(SELF, { health: 20 }))
  const withCow = baseState([cow], null, selfState(SELF, { health: 20 }))
  const payload = authorityState(authorityRequest(state, generateCandidates(state, defaultCandidateOptions)))
  const self = payload.self as { lastDamage: LastDamageEvidence | null }
  const combat = combatIds(withCow)
  const pass = self.lastDamage === null && combat.length === 0 && state.entities.length === 0
  return { pass, detail: `lastDamage=${JSON.stringify(self.lastDamage)} combatCandidates=[${combat.join(',')}]` }
})

let failures = 0
process.stdout.write('P1 durability - threat evidence, grounded response, damage preemption\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} threat-response cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
