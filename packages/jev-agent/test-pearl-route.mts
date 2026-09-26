// test-pearl-route.mts - the general "a mob drop is needed and the producer is a
// MOB" route, measured on the M3 pearl half (`collect 12 x ender_pearl`).
//
// WHY (live evidence, run-muc3qbug-18vg3 / source 35dfd29):
//   gate: nether_reached PASS, M3 incomplete only on `ender_eye_ready`
//   m3_facts: ender_pearl=0 blaze_rod=0 blaze_powder=0 ender_eye=0
//   RETRIEVE:known:ender_pearl:*  -> NONE (no remembered source of any kind)
//   RETRIEVE:known:blaze_rod:b35_60_-23 / b37_58_-21 (the fortress half works)
// and the earlier measured hunt shape (2026-09-21T17:07-17:08, `ATTACK:e1758`):
// the sensor offered a sensed enderman, Jev chose the hunt, and the lease ended
// after 1.0-2.0 s with ZERO swings because the enderman had already TELEPORTED
// out of the tracked entity set. The skill ended `failed/out_of_reach` with
// nothing and was restarted five times.
//
// What this fixture pins, in the four shapes the task names:
//   (a) a pearl goal WITH a sensed enderman  -> the hunt candidate is offered and
//       carries the producer facts (goalDrop / requiresKill / producerMob /
//       producerRoute), and it is the grounded route the reachability gate sees.
//   (b) the same hunt where the target teleports out of range -> a bounded
//       RE-ACQUIRE happens inside the same lease (retarget a sensed enderman, or
//       re-approach the last observed position), and when that fails the end is a
//       TYPED non-completion (`HUNT_TARGET_LOST`, `huntEnd=no_reacquire`) - never
//       a silent end and never a bare `out_of_reach` throw for a hunt.
//   (c) a pearl goal with NOTHING sensed -> a grounded search route (the generic
//       exploration arm) plus the typed `MOB_DROP_SOURCE_NONE` gap naming the
//       missing affordance, its producer mobs and the grounded next step; and a
//       standable-frontier dead end is the typed `EXPLORE_ROUTE_BLOCKED`.
//   (d) the SAME sighting in the Nether (warped forest / nether wastes / wherever)
//       -> the route stays generic: identical ids and no biome- or
//       coordinate-specific branch anywhere in the producer path.
//
// Authority split: code owns CAN/SAFE/TRUE (which mob drops the item, what is
// sensed, what a bounded re-acquisition may adopt, how a hunt ended); Jev owns
// WHICH producer/action; System2 owns WHAT happens next. Nothing here ranks.
//
// Run: bun test ./test-pearl-route.mts
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import {
  defaultCandidateOptions,
  formatExploreRouteBlocked,
  formatMobDropSourceGap,
  formatMobSpawnContext,
  generateGroundedCandidates,
  MOB_DROP_SOURCE_NONE,
  MOB_SPAWN_CONTEXT,
  mobDropSourceGap,
} from './src/candidates.ts'
import type { Candidate, MobDropSpawnContext, ReachabilityGateOptions } from './src/candidates.ts'
import { Executor, defaultExecutorOptions } from './src/executor.ts'
import { EventLogger } from './src/jev.ts'
import type { AgentLevel } from './src/jev/client.ts'
import { createRecipeIndex } from './src/crafting.ts'
import { MOB_SPAWN_CONTEXTS, mobSpawnContextMet, sampleMobSpawnContext, scannedBlockNames } from './src/state.ts'
import type {
  BlockState,
  EntityState,
  GoalState,
  InventoryState,
  MobSpawnContextObservation,
  SelfState,
  Vec3Json,
  WorldState,
} from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'

const require = createRequire(import.meta.url)
const RECIPES = createRecipeIndex(require('minecraft-data')('1.21.11') as unknown)

interface Case {
  name: string
  run: () => Promise<{ pass: boolean; detail: string }> | { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

// ---------------------------------------------------------------------------
// candidate-level world
// ---------------------------------------------------------------------------

const SELF: Vec3Json = { x: 0.5, y: 61, z: 0.5 }
const FRONTIER: Vec3Json[] = [
  SELF,
  { x: 3, y: 61, z: 0 },
  { x: 0, y: 61, z: 3 },
  { x: -3, y: 61, z: 0 },
  { x: 0, y: 61, z: -3 },
  { x: 3, y: 61, z: 3 },
]

function selfState(dimension: string): SelfState {
  return {
    username: 'AI_PEARL',
    position: SELF,
    eyePosition: { x: SELF.x, y: SELF.y + 1.62, z: SELF.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension,
    isDay: true,
    heldItem: null,
  }
}

function goalState(targetItem: string, requiredCount = 12): GoalState {
  return {
    id: `collect:${targetItem}`,
    description: `collect ${requiredCount} x ${targetItem}`,
    targetItem,
    requiredCount,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(targetItem: string, requiredCount = 12): QueuedGoal {
  return {
    id: `g1:collect:${targetItem}`,
    kind: 'collect',
    description: `collect ${requiredCount} x ${targetItem}`,
    targetItem,
    requiredCount,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function queue(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

function enderman(id: number, distance: number, position: Vec3Json): EntityState {
  return {
    id,
    name: 'enderman',
    kind: 'hostile',
    username: null,
    position,
    distance,
    hostile: true,
    lineOfSight: true,
  }
}

function sensedFabric(position: Vec3Json, name = 'nether_bricks'): BlockState {
  return {
    kind: 'ore',
    name,
    position,
    distance: 30,
    diggable: true,
    inReach: false,
    hasAdjacentStandable: true,
    adjacentStandable: { x: position.x, y: position.y - 1, z: position.z },
    yield: name,
    harvestTool: 'pickaxe',
    harvestTier: 4,
    visible: true,
  }
}

function build(input: {
  dimension: string
  entities?: EntityState[]
  standable?: Vec3Json[]
  blocks?: BlockState[]
  /** the sensor's spawn-context observation, as `buildWorldState` would emit it */
  spawnContexts?: MobSpawnContextObservation[]
}): WorldState {
  const current = queuedGoal('ender_pearl')
  const inventory: InventoryState = {
    slots: [],
    counts: { diamond_sword: 1, diamond_pickaxe: 1 },
    totalItems: 2,
  }
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: selfState(input.dimension),
    inventory,
    entities: input.entities ?? [],
    blocks: input.blocks ?? [],
    ...(input.spawnContexts === undefined ? {} : { spawnContexts: input.spawnContexts }),
    terrain: { standable: input.standable ?? FRONTIER },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goalState('ender_pearl'),
    goalQueue: queue(current),
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

function candidateOptions(probe: ReachabilityGateOptions['pathProbe'] = () => 'reachable'): typeof defaultCandidateOptions & {
  recipes: ReturnType<typeof createRecipeIndex>
  reachability: ReachabilityGateOptions
} {
  return {
    ...defaultCandidateOptions,
    recipes: RECIPES,
    reachability: { memory: null, pathProbe: probe },
  }
}

const ids = (candidates: readonly Candidate[]): string => `[${candidates.map((c) => c.id).join(' ')}]`

function explorationMoves(candidates: readonly Candidate[]): Candidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.kind === 'MOVE' &&
      candidate.meta.explore === true &&
      candidate.target !== null &&
      (candidate.target.x !== Math.floor(SELF.x) ||
        candidate.target.y !== Math.floor(SELF.y) ||
        candidate.target.z !== Math.floor(SELF.z)),
  )
}

// ---------------------------------------------------------------------------
// executor-level fixture: a hunt against a TELEPORTING enderman
// ---------------------------------------------------------------------------

class P {
  constructor(public x: number, public y: number, public z: number) {}
  clone(): P { return new P(this.x, this.y, this.z) }
  set(x: number, y: number, z: number): P { this.x = x; this.y = y; this.z = z; return this }
  offset(x: number, y: number, z: number): P { return new P(this.x + x, this.y + y, this.z + z) }
  distanceTo(other: { x: number; y: number; z: number }): number {
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
  }
}

/** Captures the executor's typed markers so the fixture can assert on them. */
class CapturingLogger extends EventLogger {
  readonly lines: string[] = []
  constructor() {
    super(null, false)
  }
  override log(
    source: string,
    level: AgentLevel,
    message: string,
    detail: Record<string, unknown> = {},
    tick: number | null = null,
  ): void {
    this.lines.push(message)
    super.log(source, level, message, detail, tick)
  }
  has(prefix: string): boolean {
    return this.lines.some((line) => line.startsWith(prefix))
  }
  matching(prefix: string): string[] {
    return this.lines.filter((line) => line.startsWith(prefix))
  }
}

/**
 * A teleporting-mob hunt.
 *
 *   'retarget'   the chosen enderman blinks away after the first swing and a
 *                SECOND sensed enderman is inside the envelope -> the hunt must
 *                adopt it and finish the kill.
 *   'lost'       the chosen enderman blinks away and there is no other enderman
 *                -> the bounded re-acquisition must re-approach the last known
 *                position, exhaust, and end TYPED.
 *   'out-of-range' the enderman stays tracked but 10 m away while a closer one
 *                is sensed -> the hunt must adopt the closer producer.
 *   'never-closes' the only enderman stays tracked at 30 m and never closes ->
 *                a typed `out_of_range` hunt end with zero swings.
 */
type HuntMode = 'retarget' | 'lost' | 'out-of-range' | 'never-closes'

interface HuntFixture {
  bot: Bot
  emitter: EventEmitter
  logger: CapturingLogger
  attacks: () => number
  /** issue #436 section 9: swings aimed at ONE entity id, so a retarget is provable */
  attacksOn: (entityId: number) => number
  pearls: () => number
  pearlsAdded: () => number
  goalsSet: () => unknown[]
}

function makeHuntFixture(mode: HuntMode): HuntFixture {
  const emitter = new EventEmitter()
  const feet = new P(0, 64, 0)
  const registryData = require('minecraft-data')('1.21.11')
  const pearlId = registryData.itemsByName.ender_pearl.id
  let pearls = 0
  let pearlsAdded = 0
  let attacks = 0
  const attacksByEntity = new Map<number, number>()
  const goals: unknown[] = []
  const primary: Record<string, unknown> = {
    id: 31,
    name: 'enderman',
    kind: 'hostile',
    height: 2.9,
    isValid: true,
    position:
      mode === 'never-closes' || mode === 'out-of-range' ? new P(30, 64, 0) : new P(1, 64, 0),
  }
  const closer: Record<string, unknown> = {
    id: 32,
    name: 'enderman',
    kind: 'hostile',
    height: 2.9,
    isValid: true,
    position: new P(2, 64, 0),
  }
  const entities: Record<number, unknown> = { 31: primary }
  const bot = emitter as EventEmitter & Record<string, any>
  Object.assign(bot, {
    registry: registryData,
    health: 20,
    oxygenLevel: 20,
    blockAt: () => null,
    physicsEnabled: true,
    entity: { id: 1, position: feet, yaw: 0, pitch: 0, onGround: true, width: 0.6, height: 1.8 },
    entities,
    inventory: {
      count: (id: number) => (id === pearlId ? pearls : 0),
      items: () =>
        pearls > 0 ? [{ name: 'ender_pearl', type: pearlId, count: pearls, slot: 0 }] : [],
    },
    pathfinder: {
      setMovements: () => undefined,
      setGoal: (goal: unknown) => {
        goals.push(goal)
      },
      stop: () => undefined,
      getPathTo: () => ({ status: 'success', path: [] }),
    },
    lookAt: async () => undefined,
    attack: (entity: { id: number }) => {
      attacks += 1
      attacksByEntity.set(entity.id, (attacksByEntity.get(entity.id) ?? 0) + 1)
      if (entity.id === 31 && (mode === 'retarget' || mode === 'lost')) {
        // The enderman TELEPORTS: the instance leaves the tracked entity set with
        // no death event. In 'retarget' a second enderman is already sensed.
        delete entities[31]
        if (mode === 'retarget') entities[32] = closer
        return
      }
      if (entity.id === 32) {
        pearls += 1
        pearlsAdded += 1
        emitter.emit('entityDead', entity)
        delete entities[32]
        return
      }
      // 'out-of-range' / 'never-closes': the swing is on the primary but the
      // fixture only counts it (the kill never happens).
    },
    stopDigging: () => undefined,
    setControlState: () => undefined,
  })
  return {
    bot: bot as unknown as Bot,
    emitter,
    logger: new CapturingLogger(),
    attacks: () => attacks,
    attacksOn: (entityId: number) => attacksByEntity.get(entityId) ?? 0,
    pearls: () => pearls,
    pearlsAdded: () => pearlsAdded,
    goalsSet: () => goals,
  }
}

function huntCandidate(targetEntityId: number, targetName = 'enderman'): Candidate {
  return {
    id: `ATTACK:e${targetEntityId}`,
    kind: 'ATTACK',
    label: `hunt ${targetName} for ender_pearl`,
    targetName,
    target: { x: 1, y: 64, z: 0 },
    targetEntityId,
    itemName: 'ender_pearl',
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: {
      tick: 1,
      entityId: targetEntityId,
      distance: 1,
      goalDrop: 'ender_pearl',
      requiresKill: true,
      producerMob: targetName,
      producerRoute: 'mob_drop',
    },
  }
}

function makeExecutor(fixture: HuntFixture): Executor {
  return new Executor(fixture.bot, fixture.logger, {
    ...defaultExecutorOptions,
    goalItem: 'ender_pearl',
    verifyTimeoutMs: 300,
    pickupPathTimeoutMs: 300,
    // Keep the fixture bounded: the production default is HUNT_REACQUIRE_MS.
    huntReacquireMs: 400,
    huntReacquireRadius: 24,
  })
}

// ---------------------------------------------------------------------------
// (a) a sensed producer is the grounded route and carries the producer facts
// ---------------------------------------------------------------------------

addCase('(a) a pearl goal with a sensed enderman offers the hunt candidate with the producer facts', () => {
  const state = build({
    dimension: 'minecraft:overworld',
    entities: [enderman(31, 6, { x: 6, y: 61, z: 0 })],
  })
  const grounded = generateGroundedCandidates(state, candidateOptions())
  const attack = grounded.candidates.find((c) => c.kind === 'ATTACK')
  return {
    pass:
      attack !== undefined &&
      attack.id === 'ATTACK:e31' &&
      attack.meta.goalDrop === 'ender_pearl' &&
      attack.meta.requiresKill === true &&
      attack.meta.producerMob === 'enderman' &&
      attack.meta.producerRoute === 'mob_drop' &&
      attack.targetEntityId === 31 &&
      // A route exists, so NO gap is reported (the marker can never disagree
      // with the offered set it describes).
      grounded.mobDropGap === null &&
      grounded.exploreRouteBlocked === null,
    detail: `attack=${attack?.id ?? 'none'} meta=${JSON.stringify(attack?.meta ?? {})} gap=${grounded.mobDropGap === null ? 'none' : 'present'}`,
  }
})

// (a2) the same route is offered at any sensed distance, and stays the SAME
// candidate: the producer facts are the mob, not a coordinate.
addCase('(a2) the hunt candidate is offered for a distant producer too, without a coordinate policy', () => {
  const near = generateGroundedCandidates(
    build({ dimension: 'minecraft:the_nether', entities: [enderman(31, 4, { x: 4, y: 61, z: 0 })] }),
    candidateOptions(),
  )
  const far = generateGroundedCandidates(
    build({ dimension: 'minecraft:the_nether', entities: [enderman(31, 31, { x: -31, y: 63, z: 12 })] }),
    candidateOptions(),
  )
  const nearAttack = near.candidates.find((c) => c.kind === 'ATTACK')
  const farAttack = far.candidates.find((c) => c.kind === 'ATTACK')
  return {
    pass:
      nearAttack?.id === 'ATTACK:e31' &&
      farAttack?.id === 'ATTACK:e31' &&
      nearAttack?.meta.producerMob === 'enderman' &&
      farAttack?.meta.producerMob === 'enderman' &&
      nearAttack?.meta.goalDrop === 'ender_pearl' &&
      farAttack?.meta.goalDrop === 'ender_pearl',
    detail: `near=${nearAttack?.id ?? 'none'} far=${farAttack?.id ?? 'none'} farMeta=${JSON.stringify(farAttack?.meta ?? {})}`,
  }
})

// ---------------------------------------------------------------------------
// (b) the hunt re-acquires a teleporting target, or ends typed
// ---------------------------------------------------------------------------

// (b1) issue #436 section 9: the committed ENTITY ID is the target. A teleport
// (the id leaves the tracked set) may be recovered only by re-acquiring THAT id;
// a second enderman standing at 2m is a different causal entity and is NOT
// adopted, because "zombie A disappears; attack skeleton B instead -> Jev pi".
addCase('(b1) a teleporting hunt target is re-acquired by IDENTITY, never replaced by a sensed same-mob enderman', async () => {
  const fixture = makeHuntFixture('retarget')
  const result = await makeExecutor(fixture).claim(huntCandidate(31)).completion
  return {
    pass:
      result.status === 'failed' &&
      result.verified === false &&
      result.entityDefeated === false &&
      result.itemsGained === 0 &&
      result.huntEnd === 'target_lost' &&
      result.combatOutcome === 'TARGET_LOST' &&
      result.huntReacquired === 0 &&
      // the sensed enderman e32 was never swung at
      fixture.attacksOn(32) === 0 &&
      fixture.pearlsAdded() === 0 &&
      fixture.logger.has('HUNT_RETARGET') === false &&
      fixture.logger.has('HUNT_END reason=target_lost') &&
      fixture.logger.has('COMBAT_OUTCOME outcome=TARGET_LOST') &&
      // the listeners are released and the pathfinder goal cleared on the way out
      fixture.emitter.listenerCount('entityDead') === 0 &&
      fixture.goalsSet().at(-1) === null,
    detail: `status=${result.status} huntEnd=${result.huntEnd} outcome=${result.combatOutcome} attacksOn32=${fixture.attacksOn(32)} log=${JSON.stringify(fixture.logger.matching('HUNT_'))}`,
  }
})

addCase('(b2) a hunt whose target teleports away with no replacement ends TYPED, never silently', async () => {
  const fixture = makeHuntFixture('lost')
  const result = await makeExecutor(fixture).claim(huntCandidate(31)).completion
  const lost = fixture.logger.matching('HUNT_TARGET_LOST')
  const nearGoals = fixture.goalsSet().filter((goal) => goal !== null && goal !== undefined)
  return {
    pass:
      result.status === 'failed' &&
      result.verified === false &&
      result.failure === 'verify_failed' &&
      result.phase === 'target-not-defeated' &&
      result.huntEnd === 'target_lost' &&
      result.combatOutcome === 'TARGET_LOST' &&
      result.entityDefeated === false &&
      result.itemsGained === 0 &&
      lost.length === 1 &&
      result.huntLastKnown !== undefined &&
      result.huntLastKnown.x === 1 &&
      result.huntLastKnown.y === 64 &&
      fixture.logger.has('HUNT_END reason=target_lost') &&
      fixture.logger.has('HUNT_RETARGET') === false &&
      fixture.logger.has('COMBAT_OUTCOME outcome=TARGET_LOST') &&
      // the bounded re-approach really happened: a goal toward the last observed
      // cell was issued, and the hunt released the pathfinder when it ended
      nearGoals.length >= 1 &&
      fixture.goalsSet().at(-1) === null &&
      fixture.emitter.listenerCount('entityDead') === 0,
    detail: `status=${result.status} failure=${result.failure} huntEnd=${result.huntEnd} lastKnown=${JSON.stringify(result.huntLastKnown ?? null)} goals=${nearGoals.length} clearedLast=${fixture.goalsSet().at(-1) === null} lost=${JSON.stringify(lost)}`,
  }
})

// (b3) issue #436 section 9: "Do not automatically attack the nearest entity F,
// even if F has the same mob type". A second enderman at 2m must NOT be adopted
// when the committed id leaves the tracked set - that would be a new WHICH.
addCase('(b3) a vanished producer is NOT replaced by a closer SAME-mob producer (§9 no retarget)', async () => {
  const fixture = makeHuntFixture('retarget')
  const result = await makeExecutor(fixture).claim(huntCandidate(31)).completion
  return {
    pass:
      result.status === 'failed' &&
      result.verified === false &&
      result.entityDefeated === false &&
      result.huntEnd === 'target_lost' &&
      result.combatOutcome === 'TARGET_LOST' &&
      result.huntReacquired === 0 &&
      fixture.attacksOn(32) === 0 &&
      fixture.pearlsAdded() === 0 &&
      fixture.logger.has('HUNT_RETARGET') === false &&
      fixture.logger.has('COMBAT_OUTCOME outcome=TARGET_LOST') &&
      fixture.logger.lines.some((line) => line.includes('kill=unproven reason=same_identity_reacquire_exhausted')),
    detail: `status=${result.status} huntEnd=${result.huntEnd} outcome=${result.combatOutcome} reacquired=${result.huntReacquired} attacksOn32=${fixture.attacksOn(32)} combat=${JSON.stringify(fixture.logger.matching('COMBAT_OUTCOME'))}`,
  }
})

addCase('(b4) a hunt whose target never enters melee ends with a typed out_of_range, not a bare throw', async () => {
  const fixture = makeHuntFixture('never-closes')
  const result = await makeExecutor(fixture).claim(huntCandidate(31)).completion
  return {
    pass:
      result.status === 'failed' &&
      result.verified === false &&
      result.huntEnd === 'out_of_range' &&
      result.attackHits === 0 &&
      result.huntReacquired === 0 &&
      result.failure === 'verify_failed' &&
      result.phase === 'target-not-defeated' &&
      fixture.attacks() === 0 &&
      fixture.logger.has('HUNT_END reason=out_of_range'),
    detail: `status=${result.status} failure=${result.failure} huntEnd=${result.huntEnd} hits=${result.attackHits} swings=${fixture.attacks()}`,
  }
})

// (b5) the re-acquisition never widens the hunt to a DIFFERENT mob: a sensed
// zombie is not an enderman and must not be adopted.
addCase('(b5) the bounded re-acquisition never adopts a different mob', async () => {
  const fixture = makeHuntFixture('lost')
  ;(fixture.bot.entities as Record<number, unknown>)[99] = {
    id: 99,
    name: 'zombie',
    kind: 'hostile',
    height: 1.95,
    isValid: true,
    position: new P(2, 64, 0),
  }
  const result = await makeExecutor(fixture).claim(huntCandidate(31)).completion
  return {
    pass:
      result.status === 'failed' &&
      result.huntEnd === 'target_lost' &&
      result.combatOutcome === 'TARGET_LOST' &&
      fixture.pearlsAdded() === 0 &&
      !fixture.logger.has('HUNT_RETARGET'),
    detail: `status=${result.status} huntEnd=${result.huntEnd} log=${JSON.stringify(fixture.logger.matching('HUNT_'))}`,
  }
})

// (b6) an ordinary (non-hunt) ATTACK target that vanishes before the first swing
// is the typed `target_gone` (§9/§14: the entity identity is gone), never
// `out_of_reach` - the body was not out of reach, the target stopped existing.
addCase('(b6) an ordinary ATTACK target that vanishes is the typed target_gone', async () => {
  const fixture = makeHuntFixture('lost')
  const plain: Candidate = { ...huntCandidate(31), meta: { tick: 1, entityId: 31, distance: 1 } }
  const promise = makeExecutor(fixture).claim(plain).completion
  // the target is gone at the first poll; the same-identity re-acquire runs (a
  // plain ATTACK has the same §9 identity contract) and ends typed.
  delete (fixture.bot.entities as Record<number, unknown>)[31]
  const result = await promise
  return {
    pass:
      result.status === 'failed' &&
      result.failure === 'target_gone' &&
      result.huntEnd === undefined &&
      result.huntReacquired === undefined &&
      // the honest combat outcome is on the evidence line even though the
      // historical throw shape carries the failure code on the result
      fixture.logger.has('COMBAT_OUTCOME outcome=TARGET_LOST') &&
      fixture.attacks() === 0,
    detail: `status=${result.status} failure=${result.failure} combat=${JSON.stringify(fixture.logger.matching('COMBAT_OUTCOME'))} swings=${fixture.attacks()}`,
  }
})

// ---------------------------------------------------------------------------
// (c) no producer sensed: a grounded search route plus the typed gap
// ---------------------------------------------------------------------------

addCase('(c1) a pearl goal with nothing sensed offers the generic search route and the typed producer gap', () => {
  const grounded = generateGroundedCandidates(
    build({ dimension: 'minecraft:overworld' }),
    candidateOptions(),
  )
  const moves = explorationMoves(grounded.candidates)
  const gap = grounded.mobDropGap
  const line = gap === null ? 'none' : formatMobDropSourceGap(gap)
  return {
    pass:
      moves.length >= 2 &&
      new Set(moves.map((c) => c.id)).size === moves.length &&
      gap !== null &&
      gap.item === 'ender_pearl' &&
      gap.reason === 'no_producer_sensed' &&
      gap.sensed === 0 &&
      gap.producers.join(',') === 'enderman' &&
      gap.offered.join(',') === 'explore' &&
      gap.next === 'explore' &&
      line ===
        `${MOB_DROP_SOURCE_NONE} item=ender_pearl reason=no_producer_sensed producers=["enderman"] sensed=0 offered=["explore"] next=explore` &&
      scannedBlockNames('ender_pearl') === undefined,
    detail: `moves=${moves.length} offered=${ids(grounded.candidates)} gap=${line}`,
  }
})

addCase('(c2) an unreachable exploration dead end is a typed EXPLORE_ROUTE_BLOCKED, not a silent WAIT', () => {
  const grounded = generateGroundedCandidates(
    build({ dimension: 'minecraft:overworld', standable: [SELF] }),
    candidateOptions(),
  )
  const blocked = grounded.exploreRouteBlocked
  const gap = grounded.mobDropGap
  return {
    pass:
      blocked !== null &&
      blocked.item === 'ender_pearl' &&
      blocked.reason === 'no_frontier' &&
      formatExploreRouteBlocked(blocked) ===
        'EXPLORE_ROUTE_BLOCKED goal=collect:ender_pearl item=ender_pearl reason=no_frontier' &&
      gap !== null &&
      gap.next === 'escalate' &&
      gap.offered.length === 0 &&
      grounded.candidates.every((c) => c.kind === 'WAIT' || c.kind === 'ESCALATE'),
    detail: `blocked=${blocked === null ? 'none' : formatExploreRouteBlocked(blocked)} gap=${gap === null ? 'none' : formatMobDropSourceGap(gap)} offered=${ids(grounded.candidates)}`,
  }
})

// (c3) a sensed producer is ALWAYS offered: reachability gates MINE/locomotion,
// never the producer ATTACK, so the real generator cannot report
// `producer_withheld`. This pins that the gap closes exactly when the route does.
addCase('(c3) a sensed producer is always offered, so an unreachable route cannot fake a producer gap', () => {
  const state = build({
    dimension: 'minecraft:overworld',
    entities: [enderman(31, 6, { x: 6, y: 61, z: 0 })],
  })
  const grounded = generateGroundedCandidates(state, candidateOptions(() => 'no_path'))
  const attack = grounded.candidates.find((c) => c.kind === 'ATTACK')
  return {
    pass:
      attack !== undefined &&
      attack.id === 'ATTACK:e31' &&
      grounded.withheld.every((entry) => entry.candidate.kind !== 'ATTACK') &&
      grounded.mobDropGap === null,
    detail: `attack=${attack?.id ?? 'none'} withheld=${JSON.stringify(grounded.withheld.map((w) => w.candidate.id))} gap=${grounded.mobDropGap === null ? 'none' : 'present'}`,
  }
})

// (c4) the reason is derived from the SENSED count, not from the offered set, so
// a producer that is sensed but has no offered route can never be reported as
// "no producer sensed". Pure-function check of that fail-safe branch.
addCase('(c4) a sensed producer with no offered route reports reason=producer_withheld', () => {
  const state = build({
    dimension: 'minecraft:overworld',
    entities: [enderman(31, 6, { x: 6, y: 61, z: 0 })],
  })
  const waitOnly: Candidate[] = [
    {
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
      meta: { tick: state.tick, waitMs: 300 },
    },
  ]
  const gap = mobDropSourceGap(state, waitOnly)
  return {
    pass:
      gap !== null &&
      gap.reason === 'producer_withheld' &&
      gap.sensed === 1 &&
      gap.offered.length === 0 &&
      gap.next === 'escalate',
    detail: `gap=${gap === null ? 'none' : formatMobDropSourceGap(gap)}`,
  }
})

// (c5) negative control: a focus whose item has NO declared mob producer reports
// no mob-drop gap even while an enderman is sensed, so the marker cannot over-fire.
addCase('(c5) a non-mob-drop focus reports no mob-drop gap', () => {
  const state = build({
    dimension: 'minecraft:overworld',
    entities: [enderman(31, 6, { x: 6, y: 61, z: 0 })],
  })
  state.goalQueue = queue(queuedGoal('raw_iron', 3))
  state.goal = goalState('raw_iron', 3)
  const grounded = generateGroundedCandidates(state, candidateOptions())
  return {
    pass: grounded.mobDropGap === null,
    detail: `gap=${grounded.mobDropGap === null ? 'none' : formatMobDropSourceGap(grounded.mobDropGap)}`,
  }
})

// ---------------------------------------------------------------------------
// (d) the route stays generic in the Nether
// ---------------------------------------------------------------------------

addCase('(d1) a sighted enderman in the Nether produces the identical generic route', () => {
  const overworld = generateGroundedCandidates(
    build({ dimension: 'minecraft:overworld', entities: [enderman(31, 6, { x: 6, y: 61, z: 0 })] }),
    candidateOptions(),
  )
  const nether = generateGroundedCandidates(
    build({ dimension: 'minecraft:the_nether', entities: [enderman(31, 6, { x: 6, y: 61, z: 0 })] }),
    candidateOptions(),
  )
  // a fortress body block is present too: the pearl route must not care
  const netherWithFabric = generateGroundedCandidates(
    build({
      dimension: 'minecraft:the_nether',
      entities: [enderman(31, 6, { x: 6, y: 61, z: 0 })],
      blocks: [sensedFabric({ x: 12, y: 62, z: 0 })],
    }),
    candidateOptions(),
  )
  const routeOf = (result: ReturnType<typeof generateGroundedCandidates>): string =>
    result.candidates
      .filter((c) => c.kind === 'ATTACK')
      .map((c) => `${c.id}|${String(c.meta.goalDrop)}|${String(c.meta.producerMob)}`)
      .join(',')
  const text = [
    ...nether.candidates.map((c) => `${c.id} ${c.label}`),
    ...netherWithFabric.candidates.map((c) => `${c.id} ${c.label}`),
  ].join(' ')
  const biomeTokens = ['warped_forest', 'nether_wastes', 'soul_sand_valley', 'crimson_forest', 'basalt_deltas']
  return {
    pass:
      routeOf(overworld) === routeOf(nether) &&
      routeOf(nether) === routeOf(netherWithFabric) &&
      routeOf(nether) === 'ATTACK:e31|ender_pearl|enderman' &&
      biomeTokens.every((token) => !text.includes(token)) &&
      nether.mobDropGap === null,
    detail: `overworld=${routeOf(overworld)} nether=${routeOf(nether)} netherWithFabric=${routeOf(netherWithFabric)} biomeTokens=false`,
  }
})

addCase('(d2) a pearl goal with nothing sensed in the Nether is the same generic search, not a biome hunt', () => {
  const grounded = generateGroundedCandidates(
    build({ dimension: 'minecraft:the_nether' }),
    candidateOptions(),
  )
  const moves = explorationMoves(grounded.candidates)
  const gap = grounded.mobDropGap
  const line = gap === null ? 'none' : formatMobDropSourceGap(gap)
  return {
    pass:
      moves.length >= 2 &&
      gap !== null &&
      gap.reason === 'no_producer_sensed' &&
      gap.producers.join(',') === 'enderman' &&
      gap.next === 'explore' &&
      line ===
        `${MOB_DROP_SOURCE_NONE} item=ender_pearl reason=no_producer_sensed producers=["enderman"] sensed=0 offered=["explore"] next=explore`,
    detail: `moves=${moves.length} gap=${line}`,
  }
})

// ---------------------------------------------------------------------------
// (e) SPAWN CONTEXT: where a producer can exist, and whether the live context
//     was actually read
//
// Before this existed every pearl tick read `MOB_DROP_SOURCE_NONE ... sensed=0`
// and no layer could tell apart three different world situations:
//   (e1) the body IS in a valid spawn context and the search is grounded on it;
//   (e2) the context could not be measured and the search is a search FOR the
//        context (the measured island: nothing said whether a pearl was findable
//        where the body stood);
//   (e3) the dimension can never host the producer, so a search here is NOT
//        grounded and the body must be told that instead of wandering.
// ---------------------------------------------------------------------------

function spawnObservation(
  request: {
    mob?: string
    dimension: string
    verdict: MobSpawnContextObservation['verdict']
    cell?: Vec3Json | null
    surfaceBlock?: string | null
    light?: number | null
    spawnLightMax?: number | null
    biome?: string | null
    probeReason?: MobSpawnContextObservation['probeReason']
  },
): MobSpawnContextObservation {
  return {
    mob: request.mob ?? 'enderman',
    dimension: request.dimension,
    verdict: request.verdict,
    cell: request.cell === undefined ? { x: 0, y: 60, z: 0 } : request.cell,
    surfaceBlock: request.surfaceBlock === undefined ? 'grass_block' : request.surfaceBlock,
    light: request.light === undefined ? 3 : request.light,
    spawnLightMax: request.spawnLightMax === undefined ? 7 : request.spawnLightMax,
    biome: request.biome === undefined ? 'soul_sand_valley' : request.biome,
    probeReason: request.probeReason ?? null,
  }
}

addCase('(e1) a valid spawn context ahead grounds the SEARCH objective and carries the producer facts', () => {
  const grounded = generateGroundedCandidates(
    build({
      dimension: 'minecraft:overworld',
      spawnContexts: [
        spawnObservation({ dimension: 'minecraft:overworld', verdict: 'met', light: 3, biome: 'plains' }),
      ],
    }),
    candidateOptions(),
  )
  const moves = explorationMoves(grounded.candidates)
  const gap = grounded.mobDropGap
  return {
    pass:
      moves.length >= 2 &&
      // every offered frontier MOVE IS the producer search: the same exploration
      // arm, declaring WHY it is being run (never a forked route)
      moves.every(
        (move) =>
          move.meta.producerSearch === true &&
          move.meta.producerItem === 'ender_pearl' &&
          move.meta.producerMobs === '["enderman"]' &&
          move.meta.producerSpawnContext === 'met' &&
          move.meta.producerSpawnSearchGrounded === true,
      ) &&
      new Set(moves.map((move) => move.id)).size === moves.length &&
      gap !== null &&
      gap.spawnContext !== null &&
      gap.spawnContext.reason === 'met' &&
      gap.spawnContext.searchGrounded === true &&
      gap.spawnContext.surfaceBlock === 'grass_block' &&
      gap.spawnContext.light === 3 &&
      gap.spawnContext.spawnLightMax === 7 &&
      gap.spawnContext.biome === 'plains' &&
      gap.spawnContext.cell !== null &&
      gap.spawnContext.cell.x === 0 &&
      gap.spawnContext.cell.y === 60 &&
      gap.next === 'explore',
    detail: `moves=${moves.length} meta=${JSON.stringify(moves[0]?.meta ?? {})} ctx=${gap?.spawnContext === undefined || gap.spawnContext === null ? 'none' : `${gap.spawnContext.reason}/${gap.spawnContext.searchGrounded}`}`,
  }
})

addCase('(e2) an UNMEASURABLE context is typed as unknown and still grounds a search for the context', () => {
  const grounded = generateGroundedCandidates(
    build({
      dimension: 'minecraft:overworld',
      spawnContexts: [
        spawnObservation({
          dimension: 'minecraft:overworld',
          verdict: 'context_unknown',
          cell: null,
          surfaceBlock: null,
          light: null,
          spawnLightMax: 7,
          biome: null,
          probeReason: 'no_sensed_surface',
        }),
      ],
    }),
    candidateOptions(),
  )
  const gap = grounded.mobDropGap
  const context: MobDropSpawnContext | null = gap?.spawnContext ?? null
  const line = gap === null ? 'none' : formatMobSpawnContext(gap.item, gap.producers, gap.spawnContext)
  return {
    pass:
      gap !== null &&
      context !== null &&
      context.reason === 'context_unknown' &&
      context.searchGrounded === true &&
      context.probeReason === 'no_sensed_surface' &&
      context.light === null &&
      context.cell === null &&
      gap.next === 'explore' &&
      explorationMoves(grounded.candidates).length >= 2 &&
      line ===
        `${MOB_SPAWN_CONTEXT} item=ender_pearl producers=["enderman"] mobs=["enderman"] ` +
          `dimensions=["minecraft:overworld","minecraft:the_end","minecraft:the_nether"] ` +
          `dimension=minecraft:overworld reason=context_unknown cell=unknown light=unknown ` +
          `spawnLightMax=7 biome=unknown probe=no_sensed_surface searchGrounded=true`,
    detail: `line=${line} next=${gap?.next ?? 'none'} moves=${explorationMoves(grounded.candidates).length}`,
  }
})

addCase('(e3) a dimension that cannot host the producer withholds the search and says so', () => {
  const grounded = generateGroundedCandidates(
    build({
      dimension: 'minecraft:the_end',
      spawnContexts: [
        spawnObservation({ dimension: 'minecraft:the_end', verdict: 'dimension_unmet', light: null, spawnLightMax: null }),
      ],
    }),
    candidateOptions(),
  )
  const gap = grounded.mobDropGap
  const context = gap?.spawnContext ?? null
  const line = gap === null ? 'none' : formatMobSpawnContext(gap.item, gap.producers, gap.spawnContext)
  return {
    pass:
      gap !== null &&
      context !== null &&
      context.reason === 'dimension_unmet' &&
      context.searchGrounded === false &&
      // no search MOVE may claim to be a producer search here
      grounded.candidates.every((c) => c.meta.producerSearch !== true) &&
      line.includes('reason=dimension_unmet') &&
      line.includes('searchGrounded=false'),
    detail: `line=${line} searchMoves=${grounded.candidates.filter((c) => c.meta.producerSearch === true).length}`,
  }
})

addCase('(e4) a measured light that is too high is `light_unmet`, and the search for a darker surface stays grounded', () => {
  const grounded = generateGroundedCandidates(
    build({
      dimension: 'minecraft:overworld',
      spawnContexts: [
        spawnObservation({ dimension: 'minecraft:overworld', verdict: 'light_unmet', light: 15, biome: 'plains' }),
      ],
    }),
    candidateOptions(),
  )
  const gap = grounded.mobDropGap
  const context = gap?.spawnContext ?? null
  const moves = explorationMoves(grounded.candidates)
  return {
    pass:
      context !== null &&
      context.reason === 'light_unmet' &&
      context.searchGrounded === true &&
      context.light === 15 &&
      context.spawnLightMax === 7 &&
      moves.length >= 2 &&
      moves.every((move) => move.meta.producerSpawnContext === 'light_unmet') &&
      gap?.next === 'explore',
    detail: `reason=${context?.reason ?? 'none'} light=${String(context?.light)} moves=${moves.length}`,
  }
})

addCase('(e5) the search context is producer-generic: the same rule serves a Nether blaze_rod focus', () => {
  const state = build({
    dimension: 'minecraft:the_nether',
    spawnContexts: [
      spawnObservation({
        mob: 'blaze',
        dimension: 'minecraft:the_nether',
        verdict: 'met',
        light: 0,
        spawnLightMax: 0,
        biome: 'nether_wastes',
      }),
    ],
  })
  state.goalQueue = queue(queuedGoal('blaze_rod', 7))
  state.goal = goalState('blaze_rod', 7)
  const grounded = generateGroundedCandidates(state, candidateOptions())
  const gap = grounded.mobDropGap
  const context = gap?.spawnContext ?? null
  const moves = explorationMoves(grounded.candidates)
  return {
    pass:
      context !== null &&
      context.reason === 'met' &&
      context.mobs.join(',') === 'blaze' &&
      context.dimensions.join(',') === 'minecraft:the_nether' &&
      // no light gate applies in this dimension: the rule's `lightGatedDimensions`
      // is empty, so the Nether can never look unspawnable for lack of a sample
      MOB_SPAWN_CONTEXTS['blaze']?.lightGatedDimensions.length === 0 &&
      context.searchGrounded === true &&
      moves.length >= 2 &&
      moves.every(
        (move) => move.meta.producerItem === 'blaze_rod' && move.meta.producerMobs === '["blaze"]',
      ),
    detail: `mobs=${context?.mobs.join(',') ?? 'none'} gated=${MOB_SPAWN_CONTEXTS['blaze']?.lightGatedDimensions.join(',') || 'none'} moves=${moves.length} ids=${ids(grounded.candidates)}`,
  }
})

addCase('(e6) the spawn-context rule itself is deterministic data, not a mob-specific branch', () => {
  const enderman = MOB_SPAWN_CONTEXTS['enderman']
  const blaze = MOB_SPAWN_CONTEXTS['blaze']
  return {
    pass:
      enderman !== undefined &&
      blaze !== undefined &&
      // the overworld half is light-gated at 7 ...
      mobSpawnContextMet(enderman, 'minecraft:overworld', 7) === true &&
      mobSpawnContextMet(enderman, 'minecraft:overworld', 8) === false &&
      // ... and the SAME mob in the Nether/End is not gated at all, so a valid
      // context there needs no light sample
      enderman.lightGatedDimensions.join(',') === 'minecraft:overworld' &&
      mobSpawnContextMet(enderman, 'minecraft:the_nether', null) === true &&
      mobSpawnContextMet(enderman, 'minecraft:the_nether', 15) === true &&
      mobSpawnContextMet(enderman, 'minecraft:the_end', null) === true &&
      // where the rule DOES gate, an unmeasured light is never "spawnable"
      mobSpawnContextMet(enderman, 'minecraft:overworld', null) === false &&
      // blazes are Nether-only and never light-gated
      blaze.lightGatedDimensions.length === 0 &&
      mobSpawnContextMet(blaze, 'minecraft:the_nether', 15) === true &&
      mobSpawnContextMet(blaze, 'minecraft:overworld', 0) === false,
    detail: `enderman=${enderman === undefined ? 'missing' : `${enderman.dimensions.join('|')} gated=${enderman.lightGatedDimensions.join('|')}`} blaze=${blaze === undefined ? 'missing' : `${blaze.dimensions.join('|')} gated=${blaze.lightGatedDimensions.join('|') || 'none'}`}`,
  }
})

addCase('(e7) the SENSOR reads the live context: block light and biome come from the world, never invented', () => {
  const makeBot = (blocks: Record<string, { name: string; light: number | null; biome: number | null } | null>) =>
    ({
      blockAt: (cell: { x: number; y: number; z: number }) => blocks[`${cell.x},${cell.y},${cell.z}`] ?? null,
      registry: { biomes: { 49: { name: 'soul_sand_valley' } } },
    }) as never
  const self = { x: 0.5, y: 61, z: 0.5 }
  const dark = sampleMobSpawnContext(
    makeBot({ '0,60,0': { name: 'soul_soil', light: 0, biome: 49 } }),
    'enderman',
    'minecraft:overworld',
    self,
  )
  const bright = sampleMobSpawnContext(
    makeBot({ '0,60,0': { name: 'soul_soil', light: 15, biome: 49 } }),
    'enderman',
    'minecraft:overworld',
    self,
  )
  const noLight = sampleMobSpawnContext(
    makeBot({ '0,60,0': { name: 'soul_soil', light: null, biome: 49 } }),
    'enderman',
    'minecraft:overworld',
    self,
  )
  const nether = sampleMobSpawnContext(
    makeBot({}),
    'enderman',
    'minecraft:the_nether',
    self,
  )
  const wrongDimension = sampleMobSpawnContext(makeBot({}), 'blaze', 'minecraft:overworld', self)
  return {
    pass:
      dark.verdict === 'met' &&
      dark.light === 0 &&
      dark.biome === 'soul_sand_valley' &&
      dark.surfaceBlock === 'soul_soil' &&
      dark.cell?.y === 60 &&
      bright.verdict === 'light_unmet' &&
      bright.light === 15 &&
      nether.verdict === 'met' &&
      // a Nether producer in the Nether is `met` WITHOUT a world read
      nether.cell === null &&
      nether.probeReason === null &&
      wrongDimension.verdict === 'dimension_unmet' &&
      // an unreadable light is a MISSING fact, never a silent "spawnable"
      noLight.verdict === 'context_unknown' &&
      noLight.light === null &&
      noLight.probeReason === 'light_unavailable',
    detail: `dark=${dark.verdict}/${String(dark.light)}/${dark.biome} bright=${bright.verdict} noLight=${noLight.verdict}/${String(noLight.probeReason)} nether=${nether.verdict} blazeOw=${wrongDimension.verdict}`,
  }
})

addCase('(e8) once a producer IS sensed the hunt route replaces the search, with no stale search facts', () => {
  const grounded = generateGroundedCandidates(
    build({
      dimension: 'minecraft:overworld',
      entities: [enderman(31, 6, { x: 6, y: 61, z: 0 })],
      spawnContexts: [
        spawnObservation({ dimension: 'minecraft:overworld', verdict: 'met', light: 3, biome: 'plains' }),
      ],
    }),
    candidateOptions(),
  )
  const attacks = grounded.candidates.filter((c) => c.kind === 'ATTACK')
  return {
    pass:
      attacks.length === 1 &&
      attacks[0]?.id === 'ATTACK:e31' &&
      attacks[0]?.meta.goalDrop === 'ender_pearl' &&
      attacks[0]?.meta.requiresKill === true &&
      attacks[0]?.meta.dropItem === 'ender_pearl' &&
      grounded.mobDropGap === null &&
      grounded.candidates.every((c) => c.meta.producerSearch !== true),
    detail: `attacks=${attacks.length} meta=${JSON.stringify(attacks[0]?.meta ?? {})} searchMoves=${grounded.candidates.filter((c) => c.meta.producerSearch === true).length}`,
  }
})

addCase('(e9) an ordinary (non mob-drop) goal is unchanged: no spawn context, no producer search', () => {
  const state = build({ dimension: 'minecraft:overworld' })
  state.goalQueue = queue(queuedGoal('raw_iron', 3))
  state.goal = goalState('raw_iron', 3)
  const grounded = generateGroundedCandidates(state, candidateOptions())
  return {
    pass:
      grounded.mobDropGap === null &&
      grounded.candidates.every(
        (c) => c.meta.producerSearch !== true && c.meta.producerItem === undefined,
      ),
    detail: `gap=${grounded.mobDropGap === null ? 'none' : 'present'} ids=${ids(grounded.candidates)}`,
  }
})

addCase('(e10) the search is honest about NOVELTY: an exhausted frontier is typed, never re-walked', () => {
  // The exploration arm already drops cells the body has occupied
  // (`signals.exploredCells`, the controller's bounded LRU). With a producer
  // search riding on those same MOVEs, a fully-explored neighbourhood must yield
  // NO search move and a typed escalation - not the same cells offered again as
  // "unexplored terrain", which is a search that makes no progress.
  const state = build({
    dimension: 'minecraft:overworld',
    spawnContexts: [
      spawnObservation({ dimension: 'minecraft:overworld', verdict: 'met', light: 3, biome: 'plains' }),
    ],
  })
  state.signals.exploredCells = new Set(FRONTIER.map((spot) => `p${spot.x}_${spot.y}_${spot.z}`))
  const grounded = generateGroundedCandidates(state, candidateOptions())
  const moves = explorationMoves(grounded.candidates)
  const gap = grounded.mobDropGap
  return {
    pass:
      moves.length === 0 &&
      grounded.candidates.every((c) => c.meta.producerSearch !== true) &&
      gap !== null &&
      gap.spawnContext !== null &&
      // the context fact survives even when the movement is exhausted: the gap
      // still says WHERE the producer could be, it just cannot offer a new cell
      gap.spawnContext.reason === 'met' &&
      gap.spawnContext.searchGrounded === true &&
      gap.next === 'escalate' &&
      gap.offered.length === 0,
    detail: `moves=${moves.length} next=${gap?.next ?? 'none'} offered=${JSON.stringify(gap?.offered ?? null)} ctx=${gap?.spawnContext?.reason ?? 'none'}`,
  }
})

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

let failures = 0
process.stdout.write('pearl route: a mob-drop need is searched, hunted, and re-acquired generically\n')
process.stdout.write(`${'-'.repeat(80)}\n`)
for (const testCase of cases) {
  const outcome = await testCase.run()
  if (!outcome.pass) failures += 1
  process.stdout.write(`${outcome.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${outcome.detail}\n`)
}
process.stdout.write(`${'-'.repeat(80)}\n`)
process.stdout.write(`${cases.length - failures}/${cases.length} pearl-route cases passed\n`)
if (failures > 0) process.exit(1)
