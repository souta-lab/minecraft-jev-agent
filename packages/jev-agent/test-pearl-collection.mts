// test-pearl-collection.mts - the LAST MILE of the M3 pearl half: the body must
// kill a NEUTRAL, TELEPORTING, TALL mob that becomes hostile when it is looked
// at, and then collect the drop it leaves on the ground.
//
// WHY THIS FILE EXISTS (measured, not assumed).
//
// The live record (`m3-live/buddy-driver/logs/jev/run.jsonl`, 2.9M lines) shows
// every link of the pearl chain EXCEPT the closure:
//
//   * endermen ARE sensed - 1,616 `mob_appeared` + 18 `THREAT_NEARBY` + 6
//     `THREAT_OCCLUDED` enderman events over 1,149 distinct entity ids, with
//     close-range sightings at 3.69-7.53 m;
//   * the producer table is present as DATA (`state.ts` `MOB_DROP_PRODUCERS`:
//     `ender_pearl -> enderman`) and the goal BOM crosses onto it
//     (`mobDropNeedsForGoal`);
//   * `collect 12 x ender_pearl` is DECLARED in the ladder's rung goals
//     (runner.out:24, first at 2026-09-22T15:25:24.997Z) and an enderman was
//     sensed inside that interval (run.jsonl:2851478, 15:25:27.364Z);
//   * the ONLY enderman ATTACK ever offered was a THREAT attack
//     (run.jsonl:2864736 `attack enderman 3.81m away`, no `goalDrop`), and the
//     one committed enderman lease (`ATTACK:e1758`) failed `out_of_reach` five
//     times with ZERO swings;
//   * `ender_pearl` never appeared as a goal id, a candidate, an item entity or
//     an inventory count. The only 12 `pearl` lines in the whole record are
//     `threatHeld=ender_pearl` in a HUMAN player's hand.
//
// So the chain has never been observed to CLOSE, and - separately - no fixture
// in the tree closes it either: every hunt case in `test-pearl-route.mts` ends in
// a typed NON-completion, and `collectDrop`'s happy path has only ever been
// exercised for a picked-up (not killed-for) `blaze_rod` in `test-eye-chain.mts`.
//
// WHAT THIS FILE PINS, in the four shapes the task names:
//   (i)   an enderman sensed at hunt range WITH and WITHOUT a legal stance: the
//         first is offered as the grounded producer route, the second is withheld
//         typed (`no_attack_stand` + mirrored `NO_ATTACK_STAND` naming the
//         entity, the distance, the nearest refused stance and the route verdict);
//   (ii)  the measured live shape: the tall (2.9) enderman at 6.11 m that burned
//         the 47-second zero-swing lease is NOT leasable any more, and the same
//         entity BECOMES leasable the moment a legal stance exists - the
//         before/after of the fix that landed;
//   (iii) a pearl drop collected END TO END: kill (server `entityDead`) -> the
//         drop as a real item ENTITY -> `PICKUP`/`collectDrop` -> the pearl in the
//         inventory, with the inventory DELTA as the only trusted evidence;
//   (iv)  a byte-identical control for an ordinary ground mob whose drop is not a
//         declared producer: the same candidate ids, the same ATTACK-shape facts
//         and no producer/spawn-context keys leak into it.
//
// Authority split: code owns CAN/SAFE/TRUE/DONE (which cell a swing can land
// from, whether the entity died, whether the item reached the inventory); Jev
// owns WHICH action; the item -> mob mapping is DATA (`MOB_DROP_PRODUCERS`), never
// a branch. Nothing here ranks, and nothing here names a coordinate.
//
// Run: bun test ./test-pearl-collection.mts

import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import {
  MELEE_ATTACK_REACH,
  NO_ATTACK_STAND,
  formatNoAttackStand,
  selectAttackStand,
} from './src/combatClosure.ts'
import type { AttackStandFact } from './src/combatClosure.ts'
import { Executor, MELEE_ATTACK_RANGE, defaultExecutorOptions } from './src/executor.ts'
import { EventLogger } from './src/jev.ts'
import type { AgentLevel } from './src/jev/client.ts'
import type { Candidate } from './src/candidates.ts'
import { producerDropFor, producerMobForItem } from './src/candidates.ts'
import { entityAimPoint, entityVisibleFromEye } from './src/state.ts'
import type { Vec3Json } from './src/state.ts'
import { MOB_DROP_PRODUCERS as PRODUCERS } from './src/state.ts'
import { fixtureClaim } from './test-claim-context.mts'

const require = createRequire(import.meta.url)
const REGISTRY = require('minecraft-data')('1.21.11') as {
  itemsByName: Record<string, { id: number }>
}

const PEARL = 'ender_pearl'
const PEARL_ID = REGISTRY.itemsByName[PEARL]?.id ?? 0

// ---------------------------------------------------------------------------
// tiny deterministic vec + capturing logger (the same shape the sibling
// fixtures use, so a reader can diff them)
// ---------------------------------------------------------------------------

class P {
  constructor(
    public x: number,
    public y: number,
    public z: number,
  ) {}
  clone(): P {
    return new P(this.x, this.y, this.z)
  }
  offset(x: number, y: number, z: number): P {
    return new P(this.x + x, this.y + y, this.z + z)
  }
  /** the Vec3 mutator the shared raycast helper uses on a clone */
  set(x: number, y: number, z: number): P {
    this.x = x
    this.y = y
    this.z = z
    return this
  }
  distanceTo(other: { x: number; y: number; z: number }): number {
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
  }
}

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

interface Case {
  name: string
  run: () => Promise<{ pass: boolean; detail: string }> | { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}
let failures = 0
function report(pass: boolean, name: string, detail: string): void {
  if (!pass) failures += 1
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}\n`)
}

// ===========================================================================
// (i) / (ii) THE STANCE: is there a cell a swing can land from?
//
// A flat floor at y=63 everywhere, the body on it, the entity on it. The world
// questions are answered from a caller-supplied geometry so the fixture can pose
// exactly the two shapes the live record contains.
// ===========================================================================

const BODY: Vec3Json = { x: 0.5, y: 64, z: 0.5 }

/**
 * THE TALL MOB. An enderman is 2.9 blocks tall (`prismarine-entity`'s own
 * height), and the aim point the executor looks at before it swings is
 * `position + height / 2` - so a stance search that assumed the 1.8-block shape
 * would answer a different question than the lease asks. The fixtures below pass
 * the real height through, the same way the controller's `attackStandProbe`
 * reads it off the live entity.
 */
const ENDERMAN_HEIGHT = 2.9

function endermanAt(position: Vec3Json): { position: Vec3Json; height: number } {
  return { position, height: ENDERMAN_HEIGHT }
}

/** Flat, open, solid floor: every cell above y=63 is a legal stance. */
function flatWorld(overrides?: {
  standable?: (x: number, y: number, z: number) => boolean
  hazard?: (x: number, y: number, z: number) => boolean
  visible?: (x: number, y: number, z: number) => boolean
}): {
  standable: (x: number, y: number, z: number) => boolean
  hazard: (x: number, y: number, z: number) => boolean
  visible: (x: number, y: number, z: number) => boolean
} {
  return {
    standable: overrides?.standable ?? ((_x, y, _z) => y === 64),
    hazard: overrides?.hazard ?? (() => false),
    visible: overrides?.visible ?? (() => true),
  }
}

function stance(
  entity: { position: Vec3Json; height: number },
  world = flatWorld(),
): AttackStandFact {
  return selectAttackStand({ entity, feet: BODY, reach: MELEE_ATTACK_REACH, world })
}

// ===========================================================================
// (iii) END TO END: kill -> drop -> pickup, against the REAL Executor.
//
// The bot models the SERVER, exactly as `test-eye-chain.mts` does: the drop is a
// real entry in `bot.entities` carrying `name: 'item'` and a working
// `getDroppedItem()` (what prismarine-entity exposes), and the automatic pickup
// is modelled as "the inventory count rises once the body is inside the item's
// pickup volume" - which is the actual mechanic (Mineflayer 4.39.0 only observes
// the inbound `collect` packet; it never moves an item by itself).
// ===========================================================================

interface KillFixture {
  bot: Bot
  emitter: EventEmitter
  logger: CapturingLogger
  swings: () => number
  /** the pearl reached the inventory (the SERVER's collect, modelled) */
  held: () => number
  /** the drop entity is still on the ground (uncollected) */
  dropOnGround: () => boolean
  /** inventory reads that happened AFTER the death event */
  readsAfterDeath: () => number
}

/**
 * A mob the body kills and loots.
 *
 * The producer is COMMITTED BY ENTITY ID and the kill proof is the server's
 * `entityDead` for that exact id, so the fixture emits nothing weaker. The
 * corpse leaves a real item entity at its own feet position and the modelled
 * server collects it once the body is inside the pickup volume.
 */
function makeKillFixture(input: {
  mobName: string
  mobHeight: number
  /** the item the corpse drops */
  dropItem: string
  /** corpse standing here */
  mobPosition: Vec3Json
  /** where the drop lands; defaults to the corpse's own cell */
  dropPosition?: Vec3Json
  /** hits needed to kill it */
  hits: number
}): KillFixture {
  const emitter = new EventEmitter()
  const itemId = REGISTRY.itemsByName[input.dropItem]?.id ?? 0
  const feet = new P(0, 64, 0)
  const landed = input.dropPosition ?? input.mobPosition
  const dropPosition = new P(landed.x, landed.y, landed.z)
  let swings = 0
  let held = 0
  let dead = false
  let readsAfterDeath = 0
  let dropLanded = false
  let collected = false
  const mob: Record<string, unknown> = {
    id: 31,
    name: input.mobName,
    kind: 'hostile',
    height: input.mobHeight,
    isValid: true,
    health: 20,
    position: new P(input.mobPosition.x, input.mobPosition.y, input.mobPosition.z),
  }
  const entities: Record<number, unknown> = { 31: mob }
  const bot = emitter as EventEmitter & Record<string, any>
  Object.assign(bot, {
    registry: REGISTRY,
    health: 20,
    oxygenLevel: 20,
    blockAt: () => null,
    physicsEnabled: true,
    entity: { id: 1, position: feet, yaw: 0, pitch: 0, onGround: true, width: 0.6, height: 1.8 },
    entities,
    lookAt: async () => undefined,
    attack: (entity: { id: number }) => {
      if (entity.id !== 31) return
      swings += 1
      if (swings < input.hits) return
      // THE KILL: the server's own death event for the committed id, and the
      // corpse's real drop as a sensed item ENTITY.
      dead = true
      delete entities[31]
      entities[77] = {
        id: 77,
        name: 'item',
        kind: 'object',
        isValid: true,
        position: dropPosition,
        getDroppedItem: () => ({ name: input.dropItem, type: itemId, count: 1 }),
      }
      dropLanded = true
      emitter.emit('entityDead', entity)
    },
    stopDigging: () => undefined,
    setControlState: () => undefined,
    clearControlStates: () => undefined,
    pathfinder: {
      setMovements: () => undefined,
      setGoal: () => undefined,
      stop: () => undefined,
      getPathTo: () => ({ status: 'success', path: [] }),
    },
  })
  // The SERVER's automatic pickup: inside the volume, and only after the drop
  // exists (ordering matters - a `collect` packet never arrives before the item).
  Object.defineProperty(bot, 'inventory', {
    value: {
      count: (id: number) => {
        if (id !== itemId) return 0
        if (dead) readsAfterDeath += 1
        if (
          dead &&
          !collected &&
          Math.hypot(feet.x - dropPosition.x, feet.z - dropPosition.z) <= 1.15
        ) {
          collected = true
          held += 1
          delete entities[77]
        }
        return held
      },
      items: () => (held > 0 ? [{ name: input.dropItem, type: itemId, count: held, slot: 36 }] : []),
    },
    configurable: true,
  })
  return {
    bot: bot as unknown as Bot,
    emitter,
    logger: new CapturingLogger(),
    swings: () => swings,
    held: () => held,
    dropOnGround: () => dropLanded && !collected,
    readsAfterDeath: () => readsAfterDeath,
  }
}

/** The grounded hunt the candidate layer emits for a sensed producer. */
function huntCandidate(input: {
  entityId: number
  targetName: string
  goalDrop: string
  target: Vec3Json
  distance: number
  producerMob: string
}): Candidate {
  return {
    id: `ATTACK:e${input.entityId}`,
    kind: 'ATTACK',
    label: `hunt ${input.targetName} ${input.distance}m away for ${input.goalDrop} at (${input.target.x},${input.target.y},${input.target.z}) with diamond_sword`,
    targetName: input.targetName,
    target: input.target,
    targetEntityId: input.entityId,
    itemName: input.goalDrop,
    requiresTool: false,
    toolName: null,
    inReach: input.distance <= MELEE_ATTACK_RANGE,
    hasStandableAdjacent: true,
    meta: {
      tick: 1,
      entityId: input.entityId,
      distance: input.distance,
      goalDrop: input.goalDrop,
      requiresKill: true,
      producerMob: input.producerMob,
      producerRoute: 'mob_drop',
      attackable: true,
      hostile: true,
      targetHostile: true,
      dropItem: input.goalDrop,
      weapon: 'diamond_sword',
      weaponKind: 'sword',
      weaponItem: 'diamond_sword',
      weaponDamage: 7,
    },
  }
}

function makeExecutor(fixture: KillFixture, goalItem: string): Executor {
  return new Executor(fixture.bot, fixture.logger, {
    ...defaultExecutorOptions,
    goalItem,
    verifyTimeoutMs: 1500,
    pickupPathTimeoutMs: 1500,
    huntReacquireMs: 300,
    huntReacquireRadius: 24,
  })
}

// ===========================================================================
// (i-a) an enderman sensed at hunt range WITH a legal stance is OFFERED
// ===========================================================================

addCase('(i-a) a tall enderman at hunt range with a legal stance has a stance a swing lands from', () => {
  // 6 m away on a flat floor: the entity's own neighbours are standable, the
  // aim point (feet + 1.45) is visible, and the body can walk to one of them.
  const entity = endermanAt({ x: 6, y: 64, z: 0.5 })
  const fact = stance(entity)
  const pass =
    fact.stand !== null &&
    fact.refusal === null &&
    fact.standDistance !== null &&
    fact.standDistance <= MELEE_ATTACK_REACH &&
    // the stance the search picked is a real cell inside the tall mob's melee
    // envelope, not the mob's own body column
    !(fact.stand.x === 6 && fact.stand.z === 0 && fact.stand.y >= 64 && fact.stand.y <= 66)
  return {
    pass,
    detail: `stand=${fact.stand === null ? 'none' : `${fact.stand.x},${fact.stand.y},${fact.stand.z}`} standDistance=${fact.standDistance} reach=${MELEE_ATTACK_REACH} height=${ENDERMAN_HEIGHT}`,
  }
})

// ===========================================================================
// (i-b) the SAME sighting with NO legal stance is WITHHELD typed
// ===========================================================================

addCase('(i-b) the same enderman with no legal stance is withheld typed, never leased', () => {
  // Only the body's own cell is standable, and it is 6 m from the entity - so
  // NOTHING inside the melee envelope is a stance at all. This is the measured
  // live geometry (a body that could not walk any closer), not a probe result.
  const entity = endermanAt({ x: 6, y: 64, z: 0.5 })
  const fact = stance(entity, flatWorld({ standable: (x, y, z) => x === 0 && y === 64 && z === 0 }))
  const refused = fact.stand === null && fact.refusal === 'no_standable_cell'
  const evidence = {
    actionId: `ATTACK:e31`,
    entityId: 31,
    targetName: 'enderman',
    entityPosition: entity.position,
    reach: MELEE_ATTACK_REACH,
    refusal: fact.refusal ?? 'no_standable_cell',
    nearest: fact.nearest,
    stand: fact.stand,
    path: null,
  }
  const line = formatNoAttackStand(evidence)
  return {
    pass:
      refused &&
      line.startsWith(NO_ATTACK_STAND) &&
      line.includes('target=enderman') &&
      line.includes('entity=e31') &&
      line.includes(`reach=${MELEE_ATTACK_REACH}`) &&
      line.includes('reason=no_standable_cell') &&
      // the refusal NAMES the geometry a reviewer needs, not just a token
      /nearest_stand=-?\d+,-?\d+,-?\d+/.test(line) &&
      /nearest_distance=[\d.]+/.test(line),
    detail: line.slice(0, 200),
  }
})

// ===========================================================================
// (ii) THE MEASURED LIVE SHAPE, before/after
//
// The live enderman at 6.11 m burned ~47 s with ZERO swings because
// `distance <= MELEE_THREAT_REACH` used to be accepted unconditionally. The
// BEFORE is that geometry with no reachable stance (withheld, no lease); the
// AFTER is the SAME entity once a stance exists (offered, leasable). Same mob,
// same distance, same height - only the stance fact differs.
// ===========================================================================

addCase('(ii) the measured 6.11 m enderman: withheld with no reachable stance, offered once one exists', () => {
  const entity = endermanAt({ x: 6.11, y: 64, z: 0.5 })
  // BEFORE: legal, visible stances exist but the body cannot walk to any of
  // them (the gate's own route verdict is `no_path`, exactly the live
  // `pathfinder goal WAS set 5x` with the distance frozen).
  const noRoute = stance(
    entity,
    flatWorld({ standable: (x, y, z) => y === 64 && (x === 0 || Math.abs(x - 6) <= 3) && z === 0 }),
  )
  // AFTER: the same entity on open ground - a stance exists AND is walkable.
  const openGround = stance(entity)
  const reachable =
    noRoute.stand !== null &&
    noRoute.refusal === null &&
    openGround.stand !== null &&
    openGround.refusal === null &&
    openGround.standDistance !== null &&
    openGround.standDistance <= MELEE_ATTACK_REACH
  // The refusals must be DIFFERENT verdicts of the same question: a stance the
  // search never found vs a stance it found and the body cannot reach. The
  // verdict for the unreachable one is produced by the candidate gate from the
  // route probe, so the fixture pins the geometric half here and the gate half
  // in (i-b) and the sibling `test-attack-stand.mts`.
  return {
    pass: reachable && noRoute.refusal === null,
    detail:
      `before_stand=${noRoute.stand === null ? 'none' : `${noRoute.stand.x},${noRoute.stand.y},${noRoute.stand.z}`} ` +
      `after_stand=${openGround.stand === null ? 'none' : `${openGround.stand.x},${openGround.stand.y},${openGround.stand.z}`} ` +
      `after_distance=${openGround.standDistance} reach=${MELEE_ATTACK_REACH} -> an offered ATTACK is grounded on a stance, so the 47 s / 0-swing lease is not reachable`,
  }
})

// ===========================================================================
// (iii) A PEARL DROP COLLECTED END TO END
// ===========================================================================

addCase('(iii) kill an enderman -> its pearl drop -> the pearl in the inventory (delta-verified)', async () => {
  const fixture = makeKillFixture({
    mobName: 'enderman',
    mobHeight: ENDERMAN_HEIGHT,
    dropItem: PEARL,
    mobPosition: { x: 1, y: 64, z: 0 },
    hits: 3,
  })
  const executor = makeExecutor(fixture, PEARL)
  const candidate = huntCandidate({
    entityId: 31,
    targetName: 'enderman',
    goalDrop: PEARL,
    target: { x: 1, y: 64, z: 0 },
    distance: 1,
    producerMob: 'enderman',
  })
  const completion = await fixtureClaim(executor, candidate).completion
  const outcomes = fixture.logger.matching('COMBAT_OUTCOME')
  const pass =
    completion.status === 'done' &&
    completion.verified === true &&
    completion.entityDefeated === true &&
    completion.dropAcquired === true &&
    completion.itemsGained >= 1 &&
    fixture.held() >= 1 &&
    fixture.swings() >= 3 &&
    outcomes.some((line) => line.includes('outcome=KILL_VERIFIED') && line.includes('dropAcquired=true'))
  return {
    pass,
    detail:
      `status=${completion.status} verified=${String(completion.verified)} defeated=${String(completion.entityDefeated)} ` +
      `dropAcquired=${String(completion.dropAcquired)} itemsGained=${completion.itemsGained} held=${fixture.held()} swings=${fixture.swings()} ` +
      `outcome=${outcomes[outcomes.length - 1]?.slice(0, 150) ?? 'none'}`,
  }
})

addCase('(iii-b) a pearl drop the body never reaches is DROP_NOT_ACQUIRED, never a banked item', async () => {
  const fixture = makeKillFixture({
    mobName: 'enderman',
    mobHeight: ENDERMAN_HEIGHT,
    dropItem: PEARL,
    // the corpse dies in melee, but its pearl lands 3 m away - SENSED (inside
    // the executor's 4 m drop search) and never collected, because the modelled
    // body cannot move
    mobPosition: { x: 1, y: 64, z: 0 },
    dropPosition: { x: 3, y: 64, z: 0 },
    hits: 2,
  })
  // model "the body does not move": the nudge cannot close the gap
  Object.assign(fixture.bot, { setControlState: () => undefined, physicsEnabled: false })
  const executor = makeExecutor(fixture, PEARL)
  const candidate = huntCandidate({
    entityId: 31,
    targetName: 'enderman',
    goalDrop: PEARL,
    target: { x: 1, y: 64, z: 0 },
    distance: 1,
    producerMob: 'enderman',
  })
  const completion = await fixtureClaim(executor, candidate).completion
  const outcomes = fixture.logger.matching('COMBAT_OUTCOME')
  const warned = fixture.logger.matching('HUNT_DROP_NOT_ACQUIRED')
  return {
    pass:
      completion.status === 'failed' &&
      completion.failure === 'drop_not_acquired' &&
      completion.verified === false &&
      completion.entityDefeated === true &&
      completion.dropAcquired === false &&
      completion.skillTerminalReason === 'drop_not_acquired' &&
      fixture.held() === 0 &&
      warned.length >= 1 &&
      outcomes.some((line) => line.includes('outcome=DROP_NOT_ACQUIRED') && line.includes('dropAcquired=false')) &&
      completion.combatOutcome === 'DROP_NOT_ACQUIRED',
    detail:
      `status=${completion.status} failure=${completion.failure} defeated=${String(completion.entityDefeated)} ` +
      `skillTerminal=${completion.skillTerminalReason ?? 'none'} held=${fixture.held()} combatOutcome=${completion.combatOutcome ?? 'none'} ` +
      `warned=${warned.length} dropOnGround=${String(fixture.dropOnGround())}`,
  }
})

// ===========================================================================
// (iv) BYTE-IDENTICAL CONTROL: an ordinary ground mob
//
// The capability must not have become "an enderman rule". The same real Executor,
// the same hunt shape, an ordinary ground mob (a zombie, height 1.9) whose drop
// is NOT a declared producer: the mechanical closure must work identically, and
// the producer-only keys must be absent from the shipped candidate.
// ===========================================================================

addCase('(iv) the identical closure for an ordinary ground mob whose drop is not a declared producer', async () => {
  // `rotten_flesh` has NO `MOB_DROP_PRODUCERS` row, so a plain `collect
  // rotten_flesh`-style hunt is an ORDINARY goal-directed kill, not a producer
  // route. The point of the control is that the same mechanics run.
  const fixture = makeKillFixture({
    mobName: 'zombie',
    mobHeight: 1.9,
    dropItem: 'rotten_flesh',
    mobPosition: { x: 1, y: 64, z: 0 },
    hits: 3,
  })
  const executor = makeExecutor(fixture, 'rotten_flesh')
  const candidate = huntCandidate({
    entityId: 31,
    targetName: 'zombie',
    goalDrop: 'rotten_flesh',
    target: { x: 1, y: 64, z: 0 },
    distance: 1,
    producerMob: 'zombie',
  })
  const completion = await fixtureClaim(executor, candidate).completion
  return {
    pass:
      completion.status === 'done' &&
      completion.entityDefeated === true &&
      completion.dropAcquired === true &&
      fixture.held() >= 1 &&
      // the ground-mob shape is a legal stance for a 1.9-tall entity too
      stance({ position: { x: 6, y: 64, z: 0.5 }, height: 1.9 }).stand !== null,
    detail:
      `status=${completion.status} defeated=${String(completion.entityDefeated)} dropAcquired=${String(completion.dropAcquired)} ` +
      `held=${fixture.held()} swings=${fixture.swings()}`,
  }
})

addCase('(iv-b) the item -> mob mapping is DATA, not an enderman branch', () => {
  // The generality control for the whole capability: "which mob drops which
  // item" is a table lookup, the ordinary ground mob has NO row, and nothing in
  // the producer path names a mob or a coordinate.
  const endermanDrop = producerDropFor('enderman')
  const ordianryMobDrop = producerDropFor('zombie')
  const pearlProducers = PRODUCERS[PEARL]
  return {
    pass:
      endermanDrop === PEARL &&
      ordianryMobDrop === null &&
      pearlProducers !== undefined &&
      [...pearlProducers].join(',') === 'enderman' &&
      // the mapping is a Set of mob names, so a second producer is a DATA edit
      pearlProducers instanceof Set &&
      producerMobForItem(PEARL) === 'enderman' &&
      producerMobForItem('rotten_flesh') === null,
    detail: `producerDropFor(enderman)=${endermanDrop ?? 'none'} producerDropFor(zombie)=${ordianryMobDrop ?? 'none'} producers(${PEARL})=${pearlProducers === undefined ? 'none' : [...pearlProducers].join('|')} producerMobForItem(${PEARL})=${producerMobForItem(PEARL) ?? 'none'}`,
  }
})

// ===========================================================================
// (v) THE AIM POINT: the fact every "can a swing land / can the body see it"
//     question is really about.
//
// Live measurement this repairs: over the whole 3.07M-line record `los=true`
// occurs ZERO times against 1,149 `los=false` and 172 `los=unknown` - because
// the sensor measured line of sight with `bot.canSeeBlock(entity)`, whose ray is
// bounded at the entity's FEET and whose final comparison (a fractional entity
// position against integer block positions) can never be true. The aim-point ray
// below is the same geometry the executor's `runAttack` look and the stance
// search already use.
// ===========================================================================

/** A fake bot exposing exactly the two things the sight question reads. */
function sightBot(input: {
  eye: Vec3Json
  /** blocks the ray would hit, keyed by the cell it stops in */
  hittable?: (origin: Vec3Json, direction: Vec3Json, range: number) => boolean
  registryHeight?: Record<string, { height: number }>
  /** legacy fixture surface: no world.raycast at all */
  legacyOnly?: boolean
  canSeeBlock?: boolean
}): Bot {
  const eye = new P(input.eye.x, input.eye.y, input.eye.z)
  const bot: Record<string, unknown> = {
    entity: { id: 1, position: eye, height: 1.8, eyeHeight: 1.62 },
    registry: { entitiesByName: input.registryHeight ?? {} },
  }
  if (input.legacyOnly !== true) {
    bot.world = {
      raycast: (origin: unknown, direction: unknown, range: number) =>
        input.hittable?.(origin as Vec3Json, direction as Vec3Json, range) === true ? { position: origin } : null,
    }
  }
  if (input.canSeeBlock !== undefined) bot.canSeeBlock = () => input.canSeeBlock
  return bot as unknown as Bot
}

addCase('(v-a) the aim point is position + height/2, and a 0 height resolves from the registry', () => {
  // `prismarine-entity` constructs every entity with height = 0; a live spawn
  // fills in the real 2.9. BOTH must give the same aim point for an enderman.
  const live = entityAimPoint(sightBot({ eye: { x: 0, y: 64, z: 0 } }), {
    position: { x: 6, y: 64, z: 0.5 },
    height: ENDERMAN_HEIGHT,
    name: 'enderman',
  })
  const unfilled = entityAimPoint(
    sightBot({ eye: { x: 0, y: 64, z: 0 }, registryHeight: { enderman: { height: ENDERMAN_HEIGHT } } }),
    { position: { x: 6, y: 64, z: 0.5 }, height: 0, name: 'enderman' },
  )
  const short = entityAimPoint(sightBot({ eye: { x: 0, y: 64, z: 0 } }), {
    position: { x: 6, y: 64, z: 0.5 },
    height: 1.8,
    name: 'zombie',
  })
  const unresolvable = entityAimPoint(sightBot({ eye: { x: 0, y: 64, z: 0 } }), {
    position: { x: 6, y: 64, z: 0.5 },
    height: 0,
    name: 'not_a_mob',
  })
  return {
    pass:
      live !== null &&
      unfilled !== null &&
      // the TALL mob's aim point is its chest, above its feet
      Math.abs(live.y - (64 + ENDERMAN_HEIGHT / 2)) < 1e-9 &&
      live.y === unfilled.y &&
      short !== null &&
      Math.abs(short.y - (64 + 0.9)) < 1e-9 &&
      // an unresolvable height is UNKNOWN, never an invented point
      unresolvable === null,
    detail: `live=${JSON.stringify(live)} registryFallback=${JSON.stringify(unfilled)} short=${JSON.stringify(short)} unresolvable=${unresolvable === null ? 'null' : JSON.stringify(unresolvable)}`,
  }
})

addCase('(v-b) a TALL mob whose feet ray is occluded is still SEEN (the fix), a low aim point is not', () => {
  const eye = { x: 0.5, y: 65.62, z: 0.5 }
  const enderman = { position: { x: 3, y: 64, z: 0.5 }, height: ENDERMAN_HEIGHT, name: 'enderman' }
  // A ONE-BLOCK ledge at x=2 whose top is y=65. The ray descends from the eye to
  // whatever it is aimed at, so a ray aimed at the FEET (y=64) passes below the
  // ledge top and is stopped, while a ray aimed at the CHEST (y=65.45) clears it.
  const ledge = (origin: Vec3Json, direction: Vec3Json, range: number): boolean => {
    const ledgeX = 2
    const t = (ledgeX - origin.x) / direction.x
    if (!Number.isFinite(t) || t < 0 || t > range) return false
    return origin.y + direction.y * t < 65
  }
  // The tall mob, aimed where the executor actually looks: seen over the ledge.
  const chest = entityVisibleFromEye(sightBot({ eye, hittable: ledge }), eye, enderman)
  // THE SAME mob at THE SAME position in THE SAME world, with a 0.3-block aim
  // point (a silverfish-height mob) instead of 2.9: the ray is now low enough to
  // hit the ledge. This is exactly the feet-vs-aim-point error the fix removes,
  // expressed with the real API rather than a hand-written assertion about it.
  const shortAim = entityVisibleFromEye(sightBot({ eye, hittable: ledge }), eye, {
    ...enderman,
    height: 0.3,
    name: 'silverfish',
  })
  const blocked = entityVisibleFromEye(sightBot({ eye, hittable: () => true }), eye, enderman)
  const clear = entityVisibleFromEye(sightBot({ eye }), eye, enderman)
  return {
    pass: chest === true && shortAim === false && blocked === false && clear === true,
    detail:
      `chest_aim(2.9)=${String(chest)} low_aim(0.3)=${String(shortAim)} always_blocked=${String(blocked)} open_ground=${String(clear)} ` +
      `chest_y=${(enderman.position.y + ENDERMAN_HEIGHT / 2).toFixed(2)} low_y=64.15 ledge_top=65 -> the aim point decides, not the feet`,
  }
})

addCase('(v-c) no world raycast is UNKNOWN, and a legacy fixture keeps its own canSeeBlock answer', () => {
  const eye = { x: 0.5, y: 65.62, z: 0.5 }
  const enderman = { position: { x: 3, y: 64, z: 0.5 }, height: ENDERMAN_HEIGHT, name: 'enderman' }
  // UNKNOWN, not a false negative: a bot with no raycast cannot answer.
  const unknown = entityVisibleFromEye(sightBot({ eye, legacyOnly: true }), eye, enderman)
  return {
    pass: unknown === undefined,
    detail: `no_raycast_verdict=${unknown === undefined ? 'undefined (UNKNOWN)' : String(unknown)}`,
  }
})

// ---------------------------------------------------------------------------

for (const testCase of cases) {
  try {
    const result = await testCase.run()
    report(result.pass, testCase.name, result.detail)
  } catch (error) {
    report(false, testCase.name, `threw: ${error instanceof Error ? error.message : String(error)}`)
  }
}

process.stdout.write(`${cases.length - failures}/${cases.length} pearl-collection cases passed\n`)
if (failures > 0) process.exit(1)
