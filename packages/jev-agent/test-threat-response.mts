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
import { authorityState } from './src/jev/authority.ts'
import { EventLogger } from './src/jev.ts'
import { guardCandidate } from './src/policy.ts'
import { pickHigherPriority } from './src/controller.ts'
import { DecisionScheduler, PREEMPTIVE_TRIGGERS, RETREAT_DEFER_HIT_BUDGET, shouldDeferDamageDuringRetreatLease, shouldDeferTriggerDuringRetreatLease, shouldInterruptAttackLease, selectPostActionTrigger, TRIGGER_PRIORITY } from './src/scheduler.ts'
import type { TriggerEvent } from './src/scheduler.ts'
import { buildWorldState, defaultSensorOptions } from './src/state.ts'
import type { AgentSignals, BlockState, EntityState, GoalState, InventoryState, LastDamageEvidence, SelfState, Vec3Json, WorldState } from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { JevRequest } from './src/jev/client.ts'

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

addCase('server living-entity flags expose self shield use and a skeleton active hand to ATTACK context', () => {
  const bot = fakeThreatBot() as unknown as Record<string, any>
  const registry = require('minecraft-data')('1.21.11')
  bot.registry = registry
  const metadata = (entityName: string, flags: number): unknown[] => {
    const keys = registry.entitiesByName[entityName]?.metadataKeys as string[] | undefined
    const index = keys?.indexOf('living_entity_flags') ?? -1
    const values: unknown[] = []
    if (index >= 0) values[index] = flags
    return values
  }
  bot.entity.metadata = metadata('player', 0x03) // using item + active offhand
  const slots: Array<Record<string, unknown> | null> = new Array(46).fill(null)
  slots[45] = { name: 'shield', count: 1, slot: 45, maxDurability: 336, durabilityUsed: 20 }
  bot.inventory.slots = slots
  bot.entities[42].metadata = metadata('skeleton', 0x01) // using item in mainhand (bow)
  const input = {
    tick: 6,
    goal: goalState(),
    goalQueue: queue(),
    recentEvents: [],
    signals: signals({ lastDamage: ATTACKED_DAMAGE }),
  }
  const active = buildWorldState(bot as unknown as Bot, input, defaultSensorOptions)
  const activeSkeleton = active.entities.find((entity) => entity.id === 42)
  const activeAttack = generateCandidates(active, defaultCandidateOptions).find(
    (candidate) => candidate.kind === 'ATTACK' && candidate.targetEntityId === 42,
  )
  bot.entity.metadata = metadata('player', 0)
  bot.entities[42].metadata = metadata('skeleton', 0)
  const inactive = buildWorldState(bot as unknown as Bot, { ...input, tick: 7 }, defaultSensorOptions)
  const inactiveSkeleton = inactive.entities.find((entity) => entity.id === 42)
  const inactiveAttack = generateCandidates(inactive, defaultCandidateOptions).find(
    (candidate) => candidate.kind === 'ATTACK' && candidate.targetEntityId === 42,
  )
  const pass =
    active.self.activeItemUse?.active === true &&
    active.self.activeItemUse.hand === 'offhand' &&
    active.self.activeItemUse.item === 'shield' &&
    activeSkeleton?.activeItemUse?.active === true &&
    activeSkeleton.activeItemUse.hand === 'mainhand' &&
    activeSkeleton.activeItemUse.item === 'bow' &&
    activeAttack?.meta.targetUsingItem === true &&
    activeAttack.meta.targetUseHand === 'mainhand' &&
    activeAttack.meta.targetUseItem === 'bow' &&
    inactive.self.activeItemUse?.active === false &&
    inactiveSkeleton?.activeItemUse?.active === false &&
    inactiveAttack?.meta.targetUsingItem === false
  return {
    pass,
    detail:
      `self=${JSON.stringify(active.self.activeItemUse)} skeleton=${JSON.stringify(activeSkeleton?.activeItemUse ?? null)} ` +
      `attackUse=${String(activeAttack?.meta.targetUsingItem)}/${String(activeAttack?.meta.targetUseHand)}/${String(activeAttack?.meta.targetUseItem)} ` +
      `inactive=${String(inactive.self.activeItemUse?.active)}/${String(inactiveSkeleton?.activeItemUse?.active)}`,
  }
})

addCase('worn armor and offhand shield are distinguished from carried inventory in raw Jev state', () => {
  const bot = fakeThreatBot()
  const slots: Array<Record<string, unknown> | null> = new Array(46).fill(null)
  slots[5] = { name: 'iron_helmet', count: 1, slot: 5, maxDurability: 165, durabilityUsed: 12 }
  slots[6] = { name: 'iron_chestplate', count: 1, slot: 6, maxDurability: 240, durabilityUsed: 197 }
  const boots: Record<string, unknown> = { name: 'golden_boots', count: 1, slot: 8, maxDurability: 91 }
  Object.defineProperty(boots, 'durabilityUsed', {
    get() {
      throw new Error('durability component unavailable')
    },
  })
  slots[8] = boots
  slots[45] = { name: 'shield', count: 1, slot: 45, maxDurability: 336, durabilityUsed: 80 }
  const inventory = (bot as unknown as {
    inventory: {
      items: () => Array<{ name: string; count: number; slot: number }>
      slots: Array<Record<string, unknown> | null>
    }
  }).inventory
  inventory.slots = slots
  // One more shield is merely carried in slot 9. It appears in `items()` and
  // counts both before/after the offhand slot changes.
  inventory.items = () => [{ name: 'shield', count: 1, slot: 9 }]
  const state = buildWorldState(
    bot,
    {
      tick: 4,
      goal: goalState(),
      goalQueue: queue(),
      recentEvents: [],
      signals: signals({ lastDamage: ATTACKED_DAMAGE }),
    },
    defaultSensorOptions,
  )
  const payload = authorityState(authorityRequest(state, generateCandidates(state, defaultCandidateOptions)))
  const carriedOnlySlots = [...slots]
  carriedOnlySlots[45] = null
  inventory.slots = carriedOnlySlots
  const carriedOnly = buildWorldState(
    bot,
    {
      tick: 5,
      goal: goalState(),
      goalQueue: queue(),
      recentEvents: [],
      signals: signals({ lastDamage: ATTACKED_DAMAGE }),
    },
    defaultSensorOptions,
  )
  type RawArmorPiece = { name: string; slot: number; durabilityUsed: number | null; maxDurability: number | null }
  const rawSelf = payload.self && typeof payload.self === 'object'
    ? (payload.self as {
        armor?: Record<string, RawArmorPiece | null>
        offhand?: { observed: boolean; item: RawArmorPiece | null }
      })
    : undefined
  const armor = rawSelf?.armor
  const offhand = rawSelf?.offhand
  const pass =
    state.self.armor?.head?.name === 'iron_helmet' &&
    state.self.armor.head.slot === 5 &&
    state.self.armor.head.durabilityUsed === 12 &&
    state.self.armor.head.maxDurability === 165 &&
    state.self.armor.torso?.name === 'iron_chestplate' &&
    state.self.armor.torso.durabilityUsed === 197 &&
    state.self.armor.legs === null &&
    state.self.armor.feet?.name === 'golden_boots' &&
    state.self.armor.feet.durabilityUsed === null &&
    state.self.offhand?.name === 'shield' &&
    state.self.offhand.slot === 45 &&
    state.self.offhand.durabilityUsed === 80 &&
    armor?.torso?.slot === 6 &&
    armor.torso.name === 'iron_chestplate' &&
    armor.torso.durabilityUsed === 197 &&
    armor.torso.maxDurability === 240 &&
    offhand?.observed === true &&
    offhand.item?.name === 'shield' &&
    offhand.item.slot === 45 &&
    offhand.item.durabilityUsed === 80 &&
    state.inventory.counts.iron_chestplate === undefined &&
    state.inventory.counts.shield === 1 &&
    carriedOnly.inventory.counts.shield === 1 &&
    carriedOnly.self.heldItem?.name === state.self.heldItem?.name &&
    carriedOnly.self.offhand === null
  return {
    pass,
    detail: `sensorArmor=${JSON.stringify(state.self.armor)} sensorOffhand=${JSON.stringify(state.self.offhand)} modelOffhand=${JSON.stringify(offhand)} carriedOnlyOffhand=${JSON.stringify(carriedOnly.self.offhand)} inventoryShield=${state.inventory.counts.shield}`,
  }
})

addCase('the sensor scans escape cells for a recently engaged ranged hostile beyond the danger radius', () => {
  const Vec3 = require('vec3')
  const position = new Vec3(0.5, 10, 0.5)
  const bot = {
    username: 'AI_RANGED_ESCAPE',
    entity: { id: 1, position, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 16,
    food: 20,
    game: { gameMode: 'survival', dimension: 'minecraft:overworld', minY: 0, height: 256 },
    time: { isDay: true },
    registry: null,
    entities: {
      42: {
        id: 42,
        name: 'pillager',
        kind: 'hostile',
        // Match the live pillager-only decision where the sole candidate was
        // ATTACK at 9.59m: outside the 8m imminent envelope, but a proven recent
        // attacker with enough local world to ground a >12m destination.
        position: new Vec3(0.5, 10, 10.09),
        isValid: true,
        heldItem: { name: 'crossbow', count: 1 },
      },
    },
    inventory: { items: () => [] },
    // A flat, loaded floor in every direction. The sensor has real block truth
    // for the entire bounded escape scan, but no raycast proof of cover.
    blockAt: (cell: { y: number }) =>
      cell.y < 10 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' },
    canSeeBlock: () => true,
    findBlocks: () => [],
  } as never
  const state = buildWorldState(
    bot,
    {
      tick: 9,
      goal: goalState(),
      goalQueue: queue(),
      recentEvents: [],
      signals: signals({
        lastDamage: {
          atMs: Date.now() - 500,
          health: 16,
          sourceId: 42,
          sourceName: 'pillager',
        },
      }),
    },
    { ...defaultSensorOptions, maxTerrain: 32 },
  )
  const passiveState = buildWorldState(
    bot,
    {
      tick: 10,
      goal: goalState(),
      goalQueue: queue(),
      recentEvents: [],
      signals: signals({ lastDamage: null }),
    },
    { ...defaultSensorOptions, maxTerrain: 32 },
  )
  const generated = generateCandidates(state, defaultCandidateOptions)
  const retreats = generated.filter((candidate) => candidate.kind === 'RETREAT')
  const outsideStandoff = retreats.filter((candidate) => candidate.meta.outsideReach === true)
  const escapeCells = new Set((state.terrain.escapeCells ?? []).map((cell) => `${cell.x},${cell.y},${cell.z}`))
  const pass =
    Math.abs((state.entities.find((entity) => entity.id === 42)?.distance ?? 0) - 9.59) < 0.01 &&
    state.terrain.escapeCells !== undefined &&
    state.terrain.escapeCells.length > 0 &&
    (passiveState.terrain.escapeCells?.length ?? 0) === 0 &&
    generated.some((candidate) => candidate.kind === 'ATTACK' && candidate.targetEntityId === 42) &&
    outsideStandoff.length > 0 &&
    outsideStandoff.every(
      (candidate) =>
        candidate.meta.threatEntityId === 42 &&
        candidate.meta.threatStandoff === 12 &&
        candidate.target !== null &&
        escapeCells.has(`${candidate.target.x},${candidate.target.y},${candidate.target.z}`),
    )
  return {
    pass,
    detail: `distance=${state.entities.find((entity) => entity.id === 42)?.distance ?? 'none'} escapeCells=${state.terrain.escapeCells?.length ?? 0} passiveEscapeCells=${passiveState.terrain.escapeCells?.length ?? 0} retreats=[${retreats.map((candidate) => `${candidate.id}:${candidate.meta.outsideReach}`).join(',')}]`,
  }
})

addCase('the escape scan does not retreat from a nearer hostile into another engaged hostile', () => {
  const Vec3 = require('vec3')
  const position = new Vec3(0.5, 10, 0.5)
  const bot = {
    username: 'AI_MULTI_THREAT_ESCAPE',
    entity: { id: 1, position, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 18,
    food: 20,
    game: { gameMode: 'survival', dimension: 'minecraft:overworld', minY: 0, height: 256 },
    time: { isDay: true },
    registry: null,
    entities: {
      // The nearer zombie is the primary escape direction. Walking away from
      // it toward negative X would enter the already-engaged skeleton's reach.
      42: {
        id: 42,
        name: 'skeleton',
        kind: 'hostile',
        position: new Vec3(-8.5, 10, 0.5),
        isValid: true,
        heldItem: { name: 'bow', count: 1 },
      },
      43: {
        id: 43,
        name: 'zombie',
        kind: 'hostile',
        position: new Vec3(3.5, 10, 0.5),
        isValid: true,
      },
    },
    inventory: { items: () => [] },
    blockAt: (cell: { y: number }) =>
      cell.y < 10 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' },
    canSeeBlock: () => true,
    findBlocks: () => [],
  } as never
  const now = Date.now()
  const state = buildWorldState(
    bot,
    {
      tick: 11,
      goal: goalState(),
      goalQueue: queue(),
      recentEvents: [],
      signals: signals({
        lastDamage: { atMs: now - 500, health: 18, sourceId: 42, sourceName: 'skeleton' },
      }),
    },
    defaultSensorOptions,
  )
  const skeleton = state.entities.find((entity) => entity.id === 42)
  const current = skeleton === undefined ? 0 : Math.hypot(
    state.self.position.x - skeleton.position.x,
    state.self.position.y - skeleton.position.y,
    state.self.position.z - skeleton.position.z,
  )
  const getsCloser = (state.terrain.escapeCells ?? []).filter((cell) =>
    Math.hypot(cell.x - skeleton!.position.x, cell.y - skeleton!.position.y, cell.z - skeleton!.position.z) + 1e-9 < current,
  )
  const pass =
    skeleton !== undefined &&
    state.entities.some((entity) => entity.id === 43 && entity.distance < skeleton.distance) &&
    current < 12 &&
    (state.terrain.escapeCells?.length ?? 0) > 0 &&
    getsCloser.length === 0
  return {
    pass,
    detail: `primary=zombie secondary=skeleton current=${current.toFixed(2)}m escapeCells=${state.terrain.escapeCells?.length ?? 0} towardSecondary=${getsCloser.length}`,
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

addCase('a completed stale goal leaves grounded hostile ATTACK and RETREAT to Jev, while WAIT remains ALREADY_DONE', () => {
  const unfinished = goalState()
  const activeState = baseState([attackingSkeleton()], ATTACKED_DAMAGE, selfState(SELF, { health: 1.33 }))
  const completed: GoalState = {
    ...unfinished,
    id: activeState.goalQueue.current?.id ?? unfinished.id,
    haveCount: 1,
    progress: 1,
    complete: true,
  }
  const state: WorldState = {
    ...activeState,
    goal: completed,
  }
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const retreat = candidates.find((candidate) => candidate.kind === 'RETREAT')
  const attack = candidates.find((candidate) => candidate.kind === 'ATTACK' && candidate.targetEntityId === 42)
  const wait = candidates.find((candidate) => candidate.kind === 'WAIT')
  const jevCandidates = authorityState(authorityRequest(state, candidates)).candidates as Array<{ id: string; kind: string }>
  const context = {
    phase: 'decision' as const,
    candidateIds: new Set(candidates.map((candidate) => candidate.id)),
    inFlight: null,
    reach: 4.5,
    maxCandidateAgeTicks: 10,
    canComputePath: () => true,
  }
  const retreatResult = retreat === undefined ? null : guardCandidate(retreat, state, context)
  const attackResult = attack === undefined ? null : guardCandidate(attack, state, context)
  const waitResult = wait === undefined ? null : guardCandidate(wait, state, context)
  const retreatBlockedByPath =
    retreat === undefined
      ? null
      : guardCandidate(retreat, state, { ...context, canComputePath: () => false })
  const jevStillChooses =
    attack !== undefined &&
    retreat !== undefined &&
    jevCandidates.some((candidate) => candidate.id === attack.id && candidate.kind === 'ATTACK') &&
    jevCandidates.some((candidate) => candidate.id === retreat.id && candidate.kind === 'RETREAT')
  const deadAttackResult =
    attack === undefined
      ? null
      : guardCandidate(attack, { ...state, self: { ...state.self, health: 0 } }, context)
  const breathlessAttackResult =
    attack === undefined
      ? null
      : guardCandidate(
          attack,
          { ...state, self: { ...state.self, air: 3, feetInWater: true, eyesInWater: true } },
          context,
        )
  const starvingAttackResult =
    attack === undefined
      ? null
      : guardCandidate(attack, { ...state, self: { ...state.self, health: 1.33, food: 0 } }, context)
  const pass =
    state.goal.complete &&
    state.goalQueue.current?.status === 'active' &&
    attackResult?.ok === true &&
    retreatResult?.ok === true &&
    jevStillChooses &&
    waitResult?.ok === false &&
    waitResult.code === 'ALREADY_DONE' &&
    retreatBlockedByPath?.ok === false &&
    retreatBlockedByPath.code === 'NO_PATH' &&
    deadAttackResult?.ok === false &&
    deadAttackResult.code === 'ALREADY_DONE' &&
    deadAttackResult.reason.includes('bot is dead') &&
    breathlessAttackResult?.ok === false &&
    breathlessAttackResult.code === 'SUBMERGED' &&
    starvingAttackResult?.ok === false &&
    starvingAttackResult.code === 'STARVING'
  return {
    pass,
    detail: `staleQueue=${state.goalQueue.current?.status ?? 'none'} JevChoices=${jevCandidates.filter((candidate) => candidate.kind === 'ATTACK' || candidate.kind === 'RETREAT').map((candidate) => candidate.id).join(',')} attack=${attackResult?.ok ? 'accepted' : attackResult?.code ?? 'missing'} retreat=${retreatResult?.ok ? 'accepted' : retreatResult?.code ?? 'missing'} wait=${waitResult?.ok ? 'accepted' : waitResult?.code ?? 'missing'} badPath=${retreatBlockedByPath?.ok ? 'accepted' : retreatBlockedByPath?.code ?? 'missing'} deadAttack=${deadAttackResult?.ok ? 'accepted' : deadAttackResult?.code ?? 'missing'} breathlessAttack=${breathlessAttackResult?.ok ? 'accepted' : breathlessAttackResult?.code ?? 'missing'} starvingAttack=${starvingAttackResult?.ok ? 'accepted' : starvingAttackResult?.code ?? 'missing'}`,
  }
})

addCase('a completed Goal from a retired Option cannot reject the empty-queue horizon as ALREADY_DONE', () => {
  const goal: GoalState = {
    ...goalState(),
    id: 'g1:collect:log',
    description: 'collect log',
    targetItem: 'log',
    haveCount: 1,
    progress: 1,
    complete: true,
  }
  const log: BlockState = {
    kind: 'log',
    name: 'birch_log',
    position: { x: 1.5, y: 10, z: 0.5 },
    distance: 1,
    diggable: true,
    inReach: true,
    hasAdjacentStandable: true,
    adjacentStandable: SELF,
    yield: 'birch_log',
    visible: true,
  }
  const state: WorldState = {
    ...baseState([], null, selfState(SELF)),
    goal,
    inventory: { slots: [], counts: { birch_log: 1 }, totalItems: 1 },
    blocks: [log],
    goalQueue: { depth: 0, current: null, empty: true, hasImpossible: false, done: 1, goals: [] },
    currentOption: null,
  }
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const mine = candidates.find((candidate) => candidate.kind === 'MINE' && candidate.target?.x === log.position.x)
  const wait = candidates.find((candidate) => candidate.kind === 'WAIT')
  const context = {
    phase: 'decision' as const,
    candidateIds: new Set(candidates.map((candidate) => candidate.id)),
    inFlight: null,
    reach: 4.5,
    maxCandidateAgeTicks: 10,
    canComputePath: () => true,
  }
  const mineResult = mine === undefined ? null : guardCandidate(mine, state, context)
  const waitResult = wait === undefined ? null : guardCandidate(wait, state, context)
  const pass =
    state.goal.complete &&
    state.goalQueue.current === null &&
    state.currentOption === null &&
    mineResult?.ok === true &&
    waitResult?.ok === true
  return {
    pass,
    detail: `completedGoal=${state.goal.id} activeOption=${state.goalQueue.current?.id ?? 'none'} mine=${mineResult?.ok ? 'accepted' : mineResult?.code ?? 'missing'} wait=${waitResult?.ok ? 'accepted' : waitResult?.code ?? 'missing'}`,
  }
})

addCase('a completed goal still rejects an optional nonhostile ATTACK as ALREADY_DONE', () => {
  const unfinished = goalState()
  const activeState = baseState([], null, selfState(SELF, { food: 10 }))
  const completed: GoalState = {
    ...unfinished,
    id: activeState.goalQueue.current?.id ?? unfinished.id,
    haveCount: 1,
    progress: 1,
    complete: true,
  }
  const cow: EntityState = {
    id: 55,
    name: 'cow',
    kind: 'passive',
    username: null,
    position: { x: 3.5, y: 10, z: 0.5 },
    distance: 3,
    hostile: false,
    lineOfSight: true,
    heldItem: null,
    attackedSelf: false,
  }
  const state: WorldState = {
    ...activeState,
    entities: [cow],
    goal: completed,
  }
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const attack = candidates.find((candidate) => candidate.kind === 'ATTACK' && candidate.targetEntityId === cow.id)
  const result = attack === undefined
    ? null
    : guardCandidate(attack, state, {
        phase: 'decision',
        candidateIds: new Set(candidates.map((candidate) => candidate.id)),
        inFlight: null,
        reach: 4.5,
        maxCandidateAgeTicks: 10,
        canComputePath: () => true,
      })
  return {
    pass: attack !== undefined && result?.ok === false && result.code === 'ALREADY_DONE',
    detail: `optionalFoodAttack=${attack?.id ?? 'missing'} result=${result?.ok ? 'accepted' : result?.code ?? 'missing'}`,
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

addCase('real damage is deferred while a bounded RETREAT lease closes distance, then replayed after completion', () => {
  const pass =
    PREEMPTIVE_TRIGGERS.has('damage_taken') &&
    PREEMPTIVE_TRIGGERS.has('hp_changed') &&
    shouldDeferDamageDuringRetreatLease('damage_taken', 'RETREAT') &&
    shouldDeferDamageDuringRetreatLease('hp_changed', 'RETREAT') &&
    !shouldDeferDamageDuringRetreatLease('mob_appeared', 'RETREAT') &&
    !shouldDeferDamageDuringRetreatLease('low_air', 'RETREAT') &&
    !shouldDeferDamageDuringRetreatLease('damage_taken', 'MOVE')
  return {
    pass,
    detail: 'damage/hp events coalesce through the bounded retreat; new mobs, low air, and non-retreat actions retain existing preemption',
  }
})

addCase('a RETREAT lease absorbs at most a bounded hit count before the next hit preempts (portal-p21: spider free-hit 12hp across 6 deferred hits, zero separation)', () => {
  // The deferral exists to let a retreat gain separation; each hit that lands
  // during the lease is live proof the premise is false. Budget the absorbed
  // hits per lease so a non-separating retreat yields while hp is still
  // survivable - measured chain: 6 deferrals, hp 17.8 -> 3.84, death.
  const pass =
    shouldDeferDamageDuringRetreatLease('damage_taken', 'RETREAT', 20, 6, 0) &&
    shouldDeferDamageDuringRetreatLease('damage_taken', 'RETREAT', 20, 6, RETREAT_DEFER_HIT_BUDGET - 1) &&
    !shouldDeferDamageDuringRetreatLease('damage_taken', 'RETREAT', 20, 6, RETREAT_DEFER_HIT_BUDGET) &&
    !shouldDeferTriggerDuringRetreatLease('damage_taken', 'RETREAT', 20, 6, RETREAT_DEFER_HIT_BUDGET) &&
    // hp_changed shares the same budget (same deferrable class)
    !shouldDeferDamageDuringRetreatLease('hp_changed', 'RETREAT', 20, 6, RETREAT_DEFER_HIT_BUDGET) &&
    // survival_reground is controller repair, not world damage - unaffected
    shouldDeferTriggerDuringRetreatLease('survival_reground', 'RETREAT', 20, 6, RETREAT_DEFER_HIT_BUDGET)
  return {
    pass,
    detail: `per-lease absorbed-hit budget=${RETREAT_DEFER_HIT_BUDGET}; beyond it the next hit preempts while hp is still survivable`,
  }
})

addCase('a damage event at critical health preempts the RETREAT lease instead of deferring under it (portal-p16: 9/28 deaths mid-retreat)', () => {
  // Above the critical band the old semantics stand: hits coalesce while the
  // bounded leg gains separation. At/below it the same hit is fresh safety
  // evidence - the lease must yield so Jev can re-ground against fresh state.
  const pass =
    shouldDeferDamageDuringRetreatLease('damage_taken', 'RETREAT', 20, 6) &&
    shouldDeferDamageDuringRetreatLease('hp_changed', 'RETREAT', 7, 6) &&
    !shouldDeferDamageDuringRetreatLease('damage_taken', 'RETREAT', 6, 6) &&
    !shouldDeferDamageDuringRetreatLease('hp_changed', 'RETREAT', 2, 6) &&
    !shouldDeferTriggerDuringRetreatLease('damage_taken', 'RETREAT', 4, 6) &&
    // controller-only repair requests still defer even at critical health -
    // they are not fresh world evidence
    shouldDeferTriggerDuringRetreatLease('survival_reground', 'RETREAT', 4, 6) &&
    // non-RETREAT leases unchanged
    !shouldDeferDamageDuringRetreatLease('damage_taken', 'ATTACK', 4, 6)
  return {
    pass,
    detail: 'critical-band hits break the deferral; healthy-band hits and controller repair requests keep it',
  }
})

addCase('queued reground cannot cancel a successful RETREAT, while real damage replays preemptively into a fresh threat state', () => {
  const completed: TriggerEvent = {
    trigger: 'action_completed',
    detail: { actionId: 'retreat:42', status: 'done', failure: null },
    ts: NOW + 1,
  }
  const queuedReground: TriggerEvent = {
    trigger: 'survival_reground',
    detail: { source: 'survival_reground_failed', chosenId: 'move:stale' },
    ts: NOW,
  }
  // The request arrived while the decision tick was occupied, was queued, then
  // reached requestDecision with RETREAT still leased. The controller must defer
  // it; after successful escape, action_completed is newer truth and wins.
  const pendingReground = pickHigherPriority(null, queuedReground)
  const regroundDeferred = shouldDeferTriggerDuringRetreatLease(pendingReground.trigger, 'RETREAT')
  const deferredReground = regroundDeferred ? pickHigherPriority(null, pendingReground) : null
  const regroundDelivered = selectPostActionTrigger(deferredReground, completed)
  const lowAirStillInterrupts =
    PREEMPTIVE_TRIGGERS.has('low_air') &&
    !shouldDeferTriggerDuringRetreatLease('low_air', 'RETREAT')

  // A real hit during that same bounded retreat is also held until completion,
  // but its higher priority survives and remains eligible to preempt the next
  // decision. With the engaged skeleton still present, that fresh state offers
  // a grounded RETREAT again.
  const queuedDamage: TriggerEvent = {
    trigger: 'damage_taken',
    detail: { attackerId: 42, attackerName: 'skeleton' },
    ts: NOW,
  }
  const pendingDamage = pickHigherPriority(null, queuedDamage)
  const damageDeferred = shouldDeferTriggerDuringRetreatLease(pendingDamage.trigger, 'RETREAT')
  const deferredDamage = damageDeferred ? pickHigherPriority(null, pendingDamage) : null
  const damageDelivered = selectPostActionTrigger(deferredDamage, completed)
  const freshThreat = baseState([attackingSkeleton()], ATTACKED_DAMAGE, selfState(SELF, { health: 10 }))
  const freshRetreat = generateCandidates(freshThreat, defaultCandidateOptions).some((candidate) => candidate.kind === 'RETREAT')

  const pass =
    regroundDeferred &&
    !PREEMPTIVE_TRIGGERS.has(queuedReground.trigger) &&
    regroundDelivered.trigger === 'action_completed' &&
    lowAirStillInterrupts &&
    damageDeferred &&
    damageDelivered.trigger === 'damage_taken' &&
    PREEMPTIVE_TRIGGERS.has(damageDelivered.trigger) &&
    freshRetreat
  return {
    pass,
    detail: `reground=${regroundDelivered.trigger} damage=${damageDelivered.trigger} freshThreatRetreat=${freshRetreat}`,
  }
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
