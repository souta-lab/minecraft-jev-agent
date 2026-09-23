// test-combat-closure.mts - issue #436 section 9 (combat) + section 11 (weapon
// selection), and the two live asks from the mission lane.
//
// §19 fixtures pinned here:
//   1  KILL(E) -> multiple swings under ONE commitment, no extra pi call
//   2  a second nearby entity F appears -> never retarget to F
//   3  E disappears without verified death -> TARGET_LOST/DESPAWNED, not success
//   4  HUNT_DROP(E,item) verifies target AND drop
//   10 exactly one carried weapon -> equip + verify, no second decision
//   11 the selected item is absent -> ITEM_UNAVAILABLE, no substitute
//   12 exact armour into the correct slot, no invented upgrade objective
//   24 generation/lease transfer mid-Skill -> no further mutating step
//   26 invariant: a Skill cannot silently change target identity
//   27 invariant: a Skill cannot mutate outside its declared envelope
//
// Live asks:
//   A  threat.ts: a vanished survival choice regrounds the SAME identity or ends
//      with a typed outcome - never a silent "no action" while a threat is on the
//      body (run-mucecx3h-1ljqz: `reason=no_grounded_equivalent` 9x, threat at
//      2.38m in contact)
//   B  candidates.ts: a producer ~37 blocks away is not offered as a kill it
//      cannot finish (grounded approach budget / positive route proof), while a
//      hostile IN CONTACT always produces an ATTACK
//
//   bun test ./test-combat-closure.mts
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import { Executor, defaultExecutorOptions } from './src/executor.ts'
import { EventLogger } from './src/jev.ts'
import { truthfulActionOutcome } from './src/actionPostcondition.ts'
import type { AgentLevel } from './src/jev-legacy.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import { defaultCandidateOptions, generateGroundedCandidates, isAttackableEntity, producerDropFor } from './src/candidates.ts'
import type { WorldState } from './src/state.ts'
import {
  MELEE_THREAT_REACH,
  regroundVanishedSurvivalChoice,
  survivalControlFallback,
  formatSurvivalNoGroundedAction,
  formatSurvivalReground,
} from './src/threat.ts'
import { combatFailureCode, classifyCombatOutcome, formatCombatOutcome, HUNT_APPROACH_BUDGET } from './src/combatClosure.ts'
import { weaponClass, carriedWeaponClasses, weaponHoldAlternatives, holdsCarriedWeapon } from './src/gearPlan.ts'
import { targetIdentityOf, targetIdentityViolation, effectViolation, envelopeForCandidate } from './src/skillCommitment.ts'

const require = createRequire(import.meta.url)
const REGISTRY = require('minecraft-data')('1.21.11')
class P {
  constructor(public x: number, public y: number, public z: number) {}
  clone(): P {
    return new P(this.x, this.y, this.z)
  }
  offset(x: number, y: number, z: number): P {
    return new P(this.x + x, this.y + y, this.z + z)
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
  containing(fragment: string): string[] {
    return this.lines.filter((line) => line.includes(fragment))
  }
}

interface FightFixture {
  bot: Bot
  logger: CapturingLogger
  attacks: () => number
  attacksOn: (entityId: number) => number
  held: () => string | null
  equips: () => number
  armorSlots: ({ name?: string } | null)[]
  addEntity: (entity: Record<string, unknown>) => void
  dropEntity: (entityId: number) => void
}

/**
 * A live melee fixture. `mob` is the COMMITTED entity; other entities can be
 * added mid-lease to prove no retarget happens.
 */
function makeFight(options: {
  carried?: Record<string, number>
  heldItem?: string | null
  hitsToKill?: number
  /** when set, the committed mob yields this item into the inventory on death */
  dropItem?: string
} = {}): FightFixture {
  const emitter = new EventEmitter()
  const carried = options.carried ?? {}
  const dropItemId = options.dropItem === undefined ? -1 : REGISTRY.itemsByName[options.dropItem]?.id ?? -1
  let dropped = 0
  const armorSlots: ({ name?: string } | null)[] = new Array(46).fill(null)
  let swings = 0
  let equips = 0
  let heldItem: string | null = options.heldItem ?? null
  const items = Object.entries(carried).map(([name, count], index) => ({
    name,
    type: REGISTRY.itemsByName[name]?.id ?? 1,
    count,
    slot: 36 + index,
  }))
  const attacksByEntity = new Map<number, number>()
  let hitsTaken = 0
  const hitsToKill = options.hitsToKill ?? 2
  const mob = { id: 31, name: 'blaze', kind: 'hostile', height: 1.8, isValid: true, position: new P(1, 64, 0) }
  const bot = emitter as EventEmitter & Record<string, any>
  Object.assign(bot, {
    registry: REGISTRY,
    health: 20,
    physicsEnabled: true,
    entity: { id: 1, position: new P(0, 64, 0), yaw: 0, pitch: 0, onGround: true, width: 0.6, height: 1.8 },
    entities: { 31: mob },
    game: { dimension: 'minecraft:the_nether' },
    inventory: {
      slots: armorSlots,
      items: () => {
        const all = [...items]
        if (heldItem !== null && !all.some((item) => item.name === heldItem)) {
          all.push({ name: heldItem, type: 1, count: 1, slot: 36 })
        }
        return all
      },
      // the fixture's drop lands in the inventory when the committed mob dies
      count: (id: number) => items.filter((item) => item.type === id).reduce((sum, item) => sum + item.count, 0) + (id === dropItemId ? dropped : 0),
    },
    pathfinder: {
      setMovements: () => undefined,
      setGoal: () => undefined,
      stop: () => undefined,
      getPathTo: () => ({ status: 'success', path: [] }),
    },
    lookAt: async () => undefined,
    equip: async (item: { name: string }, destination: string) => {
      equips += 1
      await new Promise((resolve) => setTimeout(resolve, 2))
      if (destination === 'hand') heldItem = item.name
      const index = { head: 5, torso: 6, legs: 7, feet: 8 }[destination as 'head' | 'torso' | 'legs' | 'feet']
      if (index !== undefined) armorSlots[index] = { name: item.name }
    },
    attack: (entity: { id: number }) => {
      swings += 1
      attacksByEntity.set(entity.id, (attacksByEntity.get(entity.id) ?? 0) + 1)
      if (entity.id !== mob.id) return
      hitsTaken += 1
      setTimeout(() => {
        emitter.emit('entityHurt', mob, bot.entity)
        if (hitsTaken >= hitsToKill) {
          if (dropItemId !== -1) dropped += 1
          delete (bot.entities as Record<number, unknown>)[mob.id]
          emitter.emit('entityDead', mob)
        }
      }, 3)
    },
    stopDigging: () => undefined,
    setControlState: () => undefined,
  })
  Object.defineProperty(bot, 'heldItem', {
    get: () => (heldItem === null ? null : { name: heldItem, type: 1, count: 1, slot: 36 }),
    configurable: true,
  })
  return {
    bot: bot as unknown as Bot,
    logger: new CapturingLogger(),
    attacks: () => swings,
    attacksOn: (entityId: number) => attacksByEntity.get(entityId) ?? 0,
    held: () => heldItem,
    equips: () => equips,
    armorSlots,
    addEntity: (entity) => {
      ;(bot.entities as Record<number, unknown>)[entity.id as number] = entity
    },
    dropEntity: (entityId) => {
      delete (bot.entities as Record<number, unknown>)[entityId]
    },
  }
}

function makeExecutor(fixture: FightFixture, extra: Record<string, unknown> = {}): Executor {
  return new Executor(fixture.bot, fixture.logger, {
    ...defaultExecutorOptions,
    goalItem: 'blaze_rod',
    verifyTimeoutMs: 300,
    pickupPathTimeoutMs: 300,
    huntReacquireMs: 250,
    ...extra,
  })
}

function killCandidate(entityId: number): Candidate {
  return {
    id: `ATTACK:e${entityId}`,
    kind: 'ATTACK',
    label: 'attack blaze',
    targetName: 'blaze',
    target: { x: 1, y: 64, z: 0 },
    targetEntityId: entityId,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 1, entityId, distance: 1, decisionEpoch: 3, worldEpoch: 1, worldKey: 'nether' },
  }
}

function huntCandidate(entityId: number, drop = 'blaze_rod'): Candidate {
  return {
    ...killCandidate(entityId),
    id: `ATTACK:e${entityId}`,
    itemName: drop,
    meta: { tick: 1, entityId, distance: 1, goalDrop: drop, requiresKill: true, decisionEpoch: 3, worldEpoch: 1 },
  }
}

function armorCandidate(itemName: string, slot: string): Candidate {
  return {
    id: `EQUIP:${slot}:${itemName}`,
    kind: 'EQUIP',
    label: `equip ${itemName}`,
    targetName: itemName,
    target: null,
    targetEntityId: null,
    itemName,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 1, slot, itemName, replaced: 'none', decisionEpoch: 3, worldEpoch: 1 },
  }
}

let total = 0
let failures = 0
const report = (pass: boolean, name: string, detail: string): void => {
  total += 1
  if (!pass) failures += 1
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}\n`)
  process.stdout.write(`      ${detail}\n`)
}

process.stdout.write('issue #436 section 9 - combat closure: exact identity, honest outcomes\n')
process.stdout.write('issue #436 section 11 - weapon selection is policy-visible when distinct\n')
process.stdout.write(`${'-'.repeat(84)}\n`)

// ===========================================================================
// 1. KILL(E): multiple swings under ONE commitment, no extra decision
// ===========================================================================

{
  const fixture = makeFight({ carried: { iron_sword: 1 }, hitsToKill: 3 })
  const result = await makeExecutor(fixture).claim(killCandidate(31)).completion
  const steps = fixture.logger.matching('SKILL_STEP')
  const commit = result.commitmentId ?? 'none'
  const pass =
    result.status === 'done' &&
    result.verified === true &&
    result.entityDefeated === true &&
    result.combatOutcome === 'KILL_VERIFIED' &&
    fixture.attacks() >= 2 &&
    fixture.attacksOn(31) === fixture.attacks() &&
    // ONE commitment spans every swing: every mechanical step carries it
    commit.startsWith('c') &&
    steps.length >= 2 &&
    steps.every((line) => line.includes(`commitmentId=${commit}`)) &&
    steps.filter((line) => line.includes('step=attack')).length >= 2 &&
    fixture.logger.matching('SKILL_COMMIT').length === 0
  report(
    pass,
    '1. KILL(E): multiple swings under ONE commitment, no second selection',
    `status=${result.status} outcome=${result.combatOutcome} swings=${fixture.attacks()} steps=${steps.length} commit=${commit}`,
  )
}

// ===========================================================================
// 2. a second nearby entity F appears -> NEVER retarget
// ===========================================================================

{
  const fixture = makeFight({ carried: { iron_sword: 1 }, hitsToKill: 1 })
  // F: a second blaze, CLOSER than the committed one, appearing mid-lease.
  fixture.addEntity({ id: 77, name: 'blaze', kind: 'hostile', height: 1.8, isValid: true, position: new P(0.5, 64, 0) })
  const result = await makeExecutor(fixture).claim(killCandidate(31)).completion
  const pass =
    result.status === 'done' &&
    result.entityDefeated === true &&
    result.combatOutcome === 'KILL_VERIFIED' &&
    fixture.attacksOn(77) === 0 &&
    fixture.attacksOn(31) >= 1 &&
    !fixture.logger.has('HUNT_RETARGET')
  report(
    pass,
    '2. a second nearby entity F (same mob type, closer) is NEVER attacked',
    `outcome=${result.combatOutcome} attacksOn31=${fixture.attacksOn(31)} attacksOn77=${fixture.attacksOn(77)}`,
  )
}

// ===========================================================================
// 3. E disappears without verified death -> TARGET_LOST, never a kill
// ===========================================================================

{
  const fixture = makeFight({ carried: { iron_sword: 1 } })
  fixture.dropEntity(31)
  const result = await makeExecutor(fixture).claim(killCandidate(31)).completion
  const combat = fixture.logger.matching('COMBAT_OUTCOME')
  const pass =
    result.status === 'failed' &&
    result.failure === 'target_gone' &&
    result.entityDefeated !== true &&
    fixture.logger.has('COMBAT_OUTCOME outcome=TARGET_LOST') &&
    combat.some((line) => line.includes('outcome=TARGET_LOST') && line.includes('kill=unproven')) &&
    !combat.some((line) => line.includes('outcome=KILL_VERIFIED'))
  report(
    pass,
    '3. a vanished entity is TARGET_LOST with kill=unproven, never a false success',
    `status=${result.status} failure=${result.failure} combat=${JSON.stringify(combat)}`,
  )
}

{
  // A despawn while the id is still "tracked but invalid" is distinguished from a
  // lost re-acquire by the classification function (unit level, pure).
  const lost = classifyCombatOutcome({ entityDefeated: false, tracked: false, reacquireExhausted: true, invalidated: false, interrupted: false, hits: 2 })
  const despawned = classifyCombatOutcome({ entityDefeated: false, tracked: false, reacquireExhausted: false, invalidated: false, interrupted: false, hits: 0 })
  const invalid = classifyCombatOutcome({ entityDefeated: false, tracked: true, reacquireExhausted: false, invalidated: true, interrupted: false, hits: 1 })
  const timeout = classifyCombatOutcome({ entityDefeated: false, tracked: true, reacquireExhausted: false, invalidated: false, interrupted: false, hits: 3 })
  const killed = classifyCombatOutcome({ entityDefeated: true, tracked: false, reacquireExhausted: true, invalidated: false, interrupted: false, hits: 3 })
  const interrupted = classifyCombatOutcome({ entityDefeated: false, tracked: true, reacquireExhausted: false, invalidated: false, interrupted: true, hits: 1 })
  const line = formatCombatOutcome({
    outcome: 'TARGET_DESPAWNED',
    actionId: 'ATTACK:e16002',
    entityId: 16002,
    targetName: 'blaze',
    swings: 0,
    hits: 0,
    reacquires: 0,
    lastKnown: { x: 60.5, y: 59, z: -23.5 },
    ms: 2500,
  })
  const pass =
    lost === 'TARGET_LOST' &&
    despawned === 'TARGET_DESPAWNED' &&
    invalid === 'TARGET_INVALIDATED' &&
    timeout === 'COMBAT_TIMEOUT' &&
    killed === 'KILL_VERIFIED' &&
    interrupted === 'COMBAT_INTERRUPTED' &&
    combatFailureCode('KILL_VERIFIED') === null &&
    combatFailureCode('TARGET_DESPAWNED') === 'target_despawned' &&
    line.startsWith('COMBAT_OUTCOME outcome=TARGET_DESPAWNED actionId=ATTACK:e16002 entity=e16002 target=blaze') &&
    line.includes('kill=unproven reason=left_tracked_set_no_death_event')
  report(
    pass,
    '3b. the §9 outcome set is total and the evidence line always states kill=unproven',
    `lost=${lost} despawned=${despawned} invalid=${invalid} timeout=${timeout} interrupted=${interrupted}\n      | ${line}`,
  )
}

// ===========================================================================
// 4. HUNT_DROP verifies target AND drop
// ===========================================================================

{
  // A producer whose drop reaches the inventory: kill + drop both verified.
  const fixture = makeFight({ carried: { iron_sword: 1 }, hitsToKill: 1, dropItem: 'blaze_rod' })
  const result = await makeExecutor(fixture).claim(huntCandidate(31)).completion
  const combat = fixture.logger.matching('COMBAT_OUTCOME')
  const pass =
    result.status === 'done' &&
    result.entityDefeated === true &&
    result.combatOutcome === 'KILL_VERIFIED' &&
    result.dropAcquired === true &&
    result.itemsGained === 1 &&
    result.yieldItem === 'blaze_rod' &&
    result.skillOutcome === 'SUCCESS' &&
    combat.some((line) => line.includes('outcome=KILL_VERIFIED') && line.includes('dropAcquired=true'))
  report(
    pass,
    '4. HUNT_DROP: the kill AND the drop/inventory delta are both verified',
    `status=${result.status} outcome=${result.combatOutcome} dropAcquired=${result.dropAcquired} gained=${result.itemsGained} combat=${JSON.stringify(combat)}`,
  )
}

{
  // The kill is proven but the drop never reaches the inventory: the collect half
  // of the postcondition is explicitly NOT claimed.
  const fixture = makeFight({ carried: { iron_sword: 1 }, hitsToKill: 1 })
  const result = await makeExecutor(fixture).claim(huntCandidate(31)).completion
  const combat = fixture.logger.matching('COMBAT_OUTCOME')
  const truth = truthfulActionOutcome({
    kind: result.kind,
    status: result.status,
    verified: result.verified,
    itemsGained: result.itemsGained,
    blockRemoved: result.blockRemoved,
    progressed: result.progressed,
    entityDefeated: result.entityDefeated,
    damageObserved: result.damageObserved,
  })
  const pass =
    result.status === 'failed' &&
    result.failure === 'drop_not_acquired' &&
    result.verified === false &&
    result.entityDefeated === true &&
    result.dropAcquired === false &&
    result.itemsGained === 0 &&
    result.combatOutcome === 'DROP_NOT_ACQUIRED' &&
    result.skillOutcome === 'DROP_NOT_ACQUIRED' &&
    result.skillTerminalReason === 'drop_not_acquired' &&
    fixture.logger.has('HUNT_DROP_NOT_ACQUIRED') &&
    fixture.logger.has('HUNT_DROP_POSTCONDITION_UNMET') &&
    truth.resetsFailureMemory === false &&
    truth.replanProgress === true &&
    combat.some((line) => line.includes('outcome=DROP_NOT_ACQUIRED') && line.includes('drop=not_acquired'))
  report(
    pass,
    '4b. kill verified without the drop is DROP_NOT_ACQUIRED, never a banked item',
    `status=${result.status} failure=${result.failure} skill=${result.skillOutcome}/${result.skillTerminalReason} ` +
      `combat=${result.combatOutcome} dropAcquired=${result.dropAcquired} gained=${result.itemsGained} truth=${JSON.stringify(truth)}`,
  )
}

// ===========================================================================
// 10/11/12. exact item: equip + verify, no substitute, exact slot
// ===========================================================================

{
  // (10) exactly ONE carried weapon class -> equip that exact item to the hand,
  // verified against the live held item, with no second selection.
  const fixture = makeFight({ carried: { iron_sword: 1, iron_pickaxe: 1 }, heldItem: 'iron_pickaxe' })
  const result = await makeExecutor(fixture).claim(killCandidate(31)).completion
  const steps = fixture.logger.matching('SKILL_STEP')
  const pass =
    result.status === 'done' &&
    fixture.held() === 'iron_sword' &&
    fixture.logger.lines.some((line) => line === 'EQUIP_WEAPON item=iron_sword replaced=iron_pickaxe reason=combat') &&
    steps.some((line) => line.includes('step=equip') && line.includes('equip=iron_sword')) &&
    fixture.equips() === 1
  report(
    pass,
    '10. one carried weapon class -> the EXACT item is equipped to the hand and verified',
    `status=${result.status} held=${fixture.held()} equips=${fixture.equips()}`,
  )
}

{
  // (11) the selected item is absent -> ITEM_UNAVAILABLE and no substitute.
  const fixture = makeFight({})
  const result = await makeExecutor(fixture).claim(armorCandidate('iron_chestplate', 'torso')).completion
  const pass =
    result.status === 'failed' &&
    result.failure === 'item_unavailable' &&
    result.skillOutcome === 'CAPABILITY_LOST' &&
    result.skillTerminalReason === 'capability_lost' &&
    fixture.equips() === 0 &&
    fixture.armorSlots[6] === null
  report(
    pass,
    '11. an absent selected item is ITEM_UNAVAILABLE with no substitute chosen',
    `status=${result.status} failure=${result.failure} outcome=${result.skillOutcome}/${result.skillTerminalReason} equips=${fixture.equips()}`,
  )
}

{
  // (12) exact armour into the correct slot; no other slot touched and no
  // upgrade objective invented.
  const fixture = makeFight({ carried: { iron_chestplate: 1, diamond_chestplate: 1 } })
  const result = await makeExecutor(fixture).claim(armorCandidate('iron_chestplate', 'torso')).completion
  const filled = fixture.armorSlots.map((slot, index) => (slot === null ? null : index)).filter((index) => index !== null)
  const pass =
    result.status === 'done' &&
    result.verified === true &&
    fixture.armorSlots[6]?.name === 'iron_chestplate' &&
    filled.length === 1 &&
    filled[0] === 6 &&
    fixture.equips() === 1
  report(
    pass,
    '12. exact armour goes into the exact slot; no invented upgrade objective',
    `status=${result.status} torso=${fixture.armorSlots[6]?.name ?? 'empty'} filledSlots=${JSON.stringify(filled)}`,
  )
}

// ===========================================================================
// 24/26/27. lifecycle + the #11 invariants
// ===========================================================================

{
  // (24) a lease/generation transfer mid-Skill: the second selection supersedes
  // the first, which settles LEASE_REVOKED and performs no further mutation.
  const fixture = makeFight({ carried: { iron_sword: 1 }, hitsToKill: 99 })
  const executor = makeExecutor(fixture)
  const first = executor.claim(killCandidate(31))
  const swingsAtSupersede = fixture.attacks()
  const second = executor.claim(armorCandidate('iron_chestplate', 'torso'))
  const firstResult = await first.completion
  await second.completion
  const pass =
    firstResult.status === 'cancelled' &&
    firstResult.skillOutcome === 'LEASE_REVOKED' &&
    fixture.logger.matching('SKILL_END').some((line) => line.includes('outcome=LEASE_REVOKED')) &&
    fixture.attacks() <= swingsAtSupersede + 1
  report(
    pass,
    '24. a lease transfer mid-Skill settles LEASE_REVOKED and stops mutating',
    `first=${firstResult.status}/${firstResult.skillOutcome} swings=${swingsAtSupersede}->${fixture.attacks()}`,
  )
}

{
  // (26) INVARIANT: a Skill cannot silently change target identity. e31 vs e77 are
  // different causal identities even though both are `blaze`.
  const committed = targetIdentityOf(killCandidate(31), { dimension: 'minecraft:the_nether', worldEpoch: 1 })
  const other = targetIdentityOf(killCandidate(77), { dimension: 'minecraft:the_nether', worldEpoch: 1 })
  const violation = targetIdentityViolation(committed, other)
  const pass =
    violation !== null &&
    violation.startsWith('target_identity_changed:') &&
    targetIdentityViolation(committed, { ...committed }) === null
  report(
    pass,
    '26. invariant: an entity target identity compares the exact id, never the mob type',
    `committed=${committed.kind === 'entity' ? committed.entityId : 'n/a'} other=${other.kind === 'entity' ? other.entityId : 'n/a'} violation=${violation}`,
  )
}

{
  // (27) INVARIANT: no mutation outside the declared envelope. A KILL(e31)
  // envelope may damage e31 ONLY; e77 and every dig/place class fail closed.
  const envelope = envelopeForCandidate(killCandidate(31))
  const pass =
    effectViolation(envelope, { type: 'attack', entityId: 31 }) === null &&
    effectViolation(envelope, { type: 'attack', entityId: 77 }) === 'attack_entity_not_declared:e77' &&
    effectViolation(envelope, { type: 'dig', position: { x: 1, y: 64, z: 0 }, blockName: 'stone' }) === 'dig_cell_not_declared:1,64,0' &&
    effectViolation(envelope, { type: 'place', position: { x: 1, y: 64, z: 0 }, itemName: 'cobblestone' }) ===
      'place_cell_not_declared:1,64,0' &&
    effectViolation(envelope, { type: 'station', station: 'furnace' }) === 'station_not_declared:furnace'
  report(
    pass,
    '27. invariant: a KILL envelope grants damage on ITS entity only, nothing else',
    `own=${effectViolation(envelope, { type: 'attack', entityId: 31 })} other=${effectViolation(envelope, { type: 'attack', entityId: 77 })} dig=${effectViolation(envelope, { type: 'dig', position: { x: 1, y: 64, z: 0 }, blockName: 'stone' })}`,
  )
}

// ===========================================================================
// 11. weapon selection: ONE class is mechanical, TWO are policy-visible
// ===========================================================================

{
  // TWO strategically distinct classes carried and nothing weapon-like in hand:
  // code must NOT rank a sword against an axe.
  const fixture = makeFight({ carried: { iron_sword: 1, stone_axe: 1 }, heldItem: 'cobblestone' })
  const result = await makeExecutor(fixture).claim(killCandidate(31)).completion
  const pass =
    result.status === 'failed' &&
    result.failure === 'weapon_choice_required' &&
    fixture.attacks() === 0 &&
    fixture.equips() === 0 &&
    fixture.logger.has('WEAPON_CHOICE_REQUIRED reason=strategically_distinct_weapon_classes alternatives=[HOLD_ITEM:stone_axe,HOLD_ITEM:iron_sword]') &&
    carriedWeaponClasses({ iron_sword: 1, stone_axe: 1 }).length === 2 &&
    weaponHoldAlternatives({ iron_sword: 1, stone_axe: 1 }).join('|') === 'HOLD_ITEM:stone_axe|HOLD_ITEM:iron_sword'
  report(
    pass,
    '11a. two distinct weapon CLASSES -> SKILL_POLICY_BOUNDARY, no silent pick, no swing',
    `status=${result.status} failure=${result.failure} swings=${fixture.attacks()} equips=${fixture.equips()} marker=${JSON.stringify(fixture.logger.matching('WEAPON_CHOICE_REQUIRED'))}`,
  )
}

{
  // The hand ALREADY holds a carried weapon: changing nothing is not a choice, so
  // the fight proceeds (and cannot loop on the boundary).
  const fixture = makeFight({ carried: { iron_sword: 1, stone_axe: 1 }, heldItem: 'iron_sword' })
  const result = await makeExecutor(fixture).claim(killCandidate(31)).completion
  const pass =
    result.status === 'done' &&
    result.combatOutcome === 'KILL_VERIFIED' &&
    fixture.attacks() >= 1 &&
    fixture.equips() === 0 &&
    holdsCarriedWeapon('iron_sword', { iron_sword: 1, stone_axe: 1 }) === true &&
    holdsCarriedWeapon('cobblestone', { iron_sword: 1 }) === false &&
    !fixture.logger.has('WEAPON_CHOICE_REQUIRED')
  report(
    pass,
    '11b. the hand already holds a carried weapon -> no re-rank, no boundary, fight proceeds',
    `status=${result.status} outcome=${result.combatOutcome} swings=${fixture.attacks()} equips=${fixture.equips()}`,
  )
}

{
  // Same class, different tier: mechanically ordered by damage (no durability or
  // repair economy exists), so this stays HOW and never reaches Jev.
  const fixture = makeFight({ carried: { diamond_sword: 1, stone_sword: 1 }, heldItem: 'cobblestone' })
  const result = await makeExecutor(fixture).claim(killCandidate(31)).completion
  const pass =
    result.status === 'done' &&
    fixture.held() === 'diamond_sword' &&
    weaponClass('diamond_sword') === 'sword' &&
    weaponClass('stone_axe') === 'axe' &&
    carriedWeaponClasses({ diamond_sword: 1, stone_sword: 1 }).join(',') === 'sword' &&
    !fixture.logger.has('WEAPON_CHOICE_REQUIRED')
  report(
    pass,
    '11c. same weapon class, different tier -> mechanical damage order, still HOW',
    `status=${result.status} held=${fixture.held()} classes=${carriedWeaponClasses({ diamond_sword: 1, stone_sword: 1 }).join(',')}`,
  )
}

// ===========================================================================
// Live ask A: a vanished survival choice ends TYPED, never a silent no-action
// ===========================================================================

{
  const chosen = { id: 'ATTACK:e15787', kind: 'ATTACK', targetEntityId: 15787, meta: { entityId: 15787 } }
  const sameId = { id: 'ATTACK:e15787', kind: 'ATTACK', targetEntityId: 15787, meta: { entityId: 15787 } }
  const otherMob = { id: 'ATTACK:e14544', kind: 'ATTACK', targetEntityId: 14544, meta: { entityId: 14544 } }
  const same = regroundVanishedSurvivalChoice(chosen, [otherMob, sameId])
  const gone = regroundVanishedSurvivalChoice(chosen, [otherMob])
  const noRetreat = regroundVanishedSurvivalChoice(
    { id: 'RETREAT:x', kind: 'RETREAT', meta: { threatEntityId: 5 } },
    [otherMob],
  )
  const goneLine = formatSurvivalNoGroundedAction(
    'ATTACK:e15787',
    gone,
    5,
    { threatId: 15787, threatName: 'skeleton', threatDistance: 2.38, inContact: true } as never,
    { health: 12, food: 3 } as never,
  )
  const sameLine = formatSurvivalReground(
    'ATTACK:e15787',
    same,
    5,
    { threatId: 15787, threatName: 'skeleton', threatDistance: 2.38, inContact: true } as never,
    { health: 12, food: 3 } as never,
  )
  const pass =
    // the SAME id is restored, never a different mob
    same.candidateId === 'ATTACK:e15787' &&
    same.outcome === 'REGROUNDED' &&
    same.reason === 'same_target_attack' &&
    // the exact entity is gone -> typed TARGET_LOST, and no substitute is chosen
    gone.candidateId === null &&
    gone.outcome === 'TARGET_LOST' &&
    gone.entityId === 15787 &&
    // no grounded response of the chosen kind at all -> CAPABILITY_LOST
    noRetreat.candidateId === null &&
    noRetreat.outcome === 'CAPABILITY_LOST' &&
    goneLine.includes('outcome=TARGET_LOST') &&
    goneLine.includes('contact=true') &&
    sameLine.includes('outcome=REGROUNDED')
  report(
    pass,
    'A. a vanished survival choice regrounds the SAME identity or ends TYPED (never silent)',
    `${goneLine}\n      | ${sameLine}`,
  )
}

// ===========================================================================
// Live ask B: a kill the body cannot reach is not offered as a kill
// ===========================================================================

/**
 * A WorldState in the shape `generateGroundedCandidates` expects for a collect
 * goal with one sensed producer at `distanceBlocks`.
 */
function worldWithProducer(distanceBlocks: number, dimension = 'minecraft:the_nether'): WorldState {
  const position = { x: distanceBlocks, y: 64, z: 0 }
  const goal = {
    id: `g1:collect:blaze_rod`,
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
  } as never
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: {
      position: { x: 0, y: 64, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      health: 20,
      food: 20,
      saturation: 5,
      oxygen: 20,
      onGround: true,
      inWater: false,
      dimension,
      heldItem: { name: 'iron_sword', count: 1, slot: 36 },
      armor: { head: null, torso: null, legs: null, feet: null },
      effects: [],
    },
    inventory: { slots: [], counts: { iron_sword: 1 }, totalItems: 1 },
    entities: [
      {
        id: 16002,
        name: 'blaze',
        kind: 'hostile',
        username: null,
        position,
        distance: distanceBlocks,
        hostile: true,
        lineOfSight: true,
      },
    ],
    blocks: [],
    terrain: { standable: [] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: { targetItem: 'blaze_rod', requiredCount: 7, haveCount: 0 } as never,
    goalQueue: { depth: 1, current: goal, empty: false, hasImpossible: false, done: 0, goals: [goal] },
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
  } as unknown as WorldState
}

function optionsWithProbe(probe: 'reachable' | 'no_path' | null): CandidateOptions {
  return {
    ...defaultCandidateOptions,
    reachability: {
      memory: null,
      pathProbe: probe === null ? null : () => probe,
      attackPathProbe: probe === null ? null : () => probe,
      stationApproach: null,
      digApproach: null,
    },
  } as unknown as CandidateOptions
}

{
  // The measured shape: a producer ~37 blocks away (body 25.5,54.9,-12.5 vs last
  // known 60.5,59,-23.5) with a clear-ish route that the probe cannot confirm.
  const far = generateGroundedCandidates(worldWithProducer(37), optionsWithProbe('no_path'))
  const farAttack = far.candidates.find((candidate) => candidate.kind === 'ATTACK')
  const farWithheld = far.withheld.find((entry) => entry.candidate.kind === 'ATTACK')
  const near = generateGroundedCandidates(worldWithProducer(12), optionsWithProbe('no_path'))
  const nearAttack = near.candidates.find((candidate) => candidate.kind === 'ATTACK')
  const proven = generateGroundedCandidates(worldWithProducer(37), optionsWithProbe('reachable'))
  const provenAttack = proven.candidates.find((candidate) => candidate.kind === 'ATTACK')
  // An UNAVAILABLE probe is not a verdict: exactly like every locomotion
  // candidate, it must not delete the only productive action.
  const noVerdict = generateGroundedCandidates(worldWithProducer(37), optionsWithProbe(null))
  const noVerdictAttack = noVerdict.candidates.find((candidate) => candidate.kind === 'ATTACK')
  const pass =
    // beyond the budget with no positive proof -> withheld with the typed reason
    farAttack === undefined &&
    farWithheld?.result.reason === 'hunt_approach_budget' &&
    farWithheld?.result.missingCapabilities.some((capability) => capability.kind === 'open_path') === true &&
    // inside the budget -> offered unchanged (the case that already works)
    nearAttack?.id === 'ATTACK:e16002' &&
    // beyond the budget WITH a positive route proof -> offered
    provenAttack?.id === 'ATTACK:e16002' &&
    noVerdictAttack?.id === 'ATTACK:e16002' &&
    HUNT_APPROACH_BUDGET === 24
  report(
    pass,
    'B. a producer beyond the hunt approach budget is withheld unless a route is PROVEN',
    `far=${farAttack?.id ?? 'none'} reason=${farWithheld?.result.reason ?? 'none'} near=${nearAttack?.id ?? 'none'} proven=${provenAttack?.id ?? 'none'} noVerdict=${noVerdictAttack?.id ?? 'none'} budget=${HUNT_APPROACH_BUDGET}`,
  )
}

{
  // A hostile IN CONTACT must always produce an ATTACK, whatever the probe says.
  const contact = generateGroundedCandidates(worldWithProducer(2), optionsWithProbe('no_path'))
  const contactAttack = contact.candidates.find((candidate) => candidate.kind === 'ATTACK')
  const contactNoProbe = generateGroundedCandidates(worldWithProducer(2), optionsWithProbe(null))
  const contactNoProbeAttack = contactNoProbe.candidates.find((candidate) => candidate.kind === 'ATTACK')
  const pass =
    contactAttack?.id === 'ATTACK:e16002' &&
    contactNoProbeAttack?.id === 'ATTACK:e16002' &&
    MELEE_THREAT_REACH >= 2
  report(
    pass,
    'B2. a hostile in CONTACT always produces an ATTACK, even with no route probe',
    `withProbe=${contactAttack?.id ?? 'none'} noProbe=${contactNoProbeAttack?.id ?? 'none'}`,
  )
}

// ===========================================================================
// Live ask A2 (operator-confirmed, DEATH 32): a hostile IN CONTACT at 0.57m with
// `freshOffer=1` must never leave the tick actionless.
// ===========================================================================

{
  // The measured branch: the chosen survival action cannot be re-grounded and the
  // restricted fresh offer holds ONE candidate that is not an equivalent.
  const chosenRetreat = { id: 'RETREAT:p23_57_-20', kind: 'RETREAT', targetEntityId: null, meta: { threatEntityId: 15787 } }
  const loneControl = [{ id: 'ESCALATE', kind: 'ESCALATE' }]
  const reground = regroundVanishedSurvivalChoice(chosenRetreat, [{ id: 'WAIT', kind: 'WAIT' }])
  const fallback = survivalControlFallback({
    reground,
    threatInContact: true,
    freshCandidates: loneControl,
  })
  // health 4.37 / contact 0.57 is exactly the measured state
  const contactAt057 = true
  const pass =
    // the re-ground genuinely failed (the old behaviour was `candidateId: null`)
    reground.candidateId === null &&
    reground.outcome === 'CAPABILITY_LOST' &&
    // and the tick now produces an ACTION instead of nothing
    fallback.candidateId === 'ESCALATE' &&
    fallback.reason === 'control_action_escalate' &&
    contactAt057
  report(
    pass,
    'A2. measured branch (freshOffer=1, not equivalent, hostile in contact) produces an action, never a silent no-op',
    `reground=${reground.candidateId ?? 'null'}/${reground.outcome} fallback=${fallback.candidateId ?? 'null'}/${fallback.reason}`,
  )
}

{
  // The invariant, stated as the OLD behaviour being impossible: with a hostile in
  // contact, a vanished survival choice can never yield "no action".
  const chosenAttack = { id: 'ATTACK:e15787', kind: 'ATTACK', targetEntityId: 15787, meta: { entityId: 15787 } }
  const loneNotEquivalent = [{ id: 'ATTACK:e14544', kind: 'ATTACK' }]
  const attackReground = regroundVanishedSurvivalChoice(chosenAttack, loneNotEquivalent)
  const attackFallback = survivalControlFallback({
    reground: attackReground,
    threatInContact: true,
    freshCandidates: [...loneNotEquivalent, { id: 'WAIT', kind: 'WAIT' }],
  })
  // a hostile NOT in contact keeps the ordinary behaviour (no control action)
  const calmFallback = survivalControlFallback({
    reground: attackReground,
    threatInContact: false,
    freshCandidates: [{ id: 'ESCALATE', kind: 'ESCALATE' }],
  })
  // a non-survival choice is untouched by this rule
  const otherFallback = survivalControlFallback({
    reground: regroundVanishedSurvivalChoice({ id: 'MINE:x', kind: 'MINE' }, []),
    threatInContact: true,
    freshCandidates: [{ id: 'ESCALATE', kind: 'ESCALATE' }],
  })
  const noCandidate = survivalControlFallback({
    reground: attackReground,
    threatInContact: true,
    freshCandidates: [],
  })
  const pass =
    // §9: the different entity is NEVER adopted
    attackReground.candidateId === null &&
    attackReground.outcome === 'TARGET_LOST' &&
    attackReground.entityId === 15787 &&
    attackFallback.candidateId === 'WAIT' &&
    attackFallback.reason === 'control_action_wait' &&
    calmFallback.candidateId === null &&
    calmFallback.reason === 'threat_not_in_contact' &&
    otherFallback.candidateId === null &&
    otherFallback.reason === 'not_a_survival_action' &&
    // genuinely nothing offered: the caller must re-ask immediately (typed end)
    noCandidate.candidateId === null &&
    noCandidate.reason === 'no_control_action_offered'
  report(
    pass,
    'A3. never-actionless rule: in contact -> control action; no substitute entity; calm/no-action cases unchanged',
    `attack=${attackFallback.candidateId ?? 'null'}/${attackFallback.reason} calm=${calmFallback.reason} other=${otherFallback.reason} empty=${noCandidate.reason}`,
  )
}

// ===========================================================================
// CAN legality: a dig never proceeds with a non-harvesting item in hand
// ===========================================================================

{
  const block = {
    name: 'stone',
    position: new P(1, 64, 0),
    boundingBox: 'block',
    diggable: true,
    harvestTools: { [REGISTRY.itemsByName.wooden_pickaxe.id]: true, [REGISTRY.itemsByName.stone_pickaxe.id]: true },
  }
  const fixture = makeFight({ carried: { diamond_sword: 1 }, heldItem: 'diamond_sword' })
  // the MINE candidate declares the pickaxe contract; the sword is in hand
  const mine: Candidate = {
    id: 'MINE:1_64_0',
    kind: 'MINE',
    label: 'mine stone',
    targetName: 'stone',
    target: { x: 1, y: 64, z: 0 },
    targetEntityId: null,
    itemName: 'cobblestone',
    requiresTool: true,
    toolName: 'pickaxe',
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 1, digBlockName: 'stone', decisionEpoch: 1, worldEpoch: 1 },
  }
  const executor = makeExecutor(fixture)
  // drive the legality guard directly: it is the single dig choke point
  const guard = executor as unknown as {
    requireHarvestTool: (b: unknown, epoch: number, signal: AbortSignal) => Promise<void>
  }
  let thrown: string | null = null
  try {
    await guard.requireHarvestTool(block, 1, new AbortController().signal)
  } catch (error) {
    thrown = error instanceof Error ? (error as { code?: string }).code ?? error.message : String(error)
  }
  report(
    thrown === 'dig_no_tool' && fixture.held() === 'diamond_sword' && fixture.logger.matching('DIG_TOOL_LEGALITY').length === 0,
    'CAN-a. a sword in hand with no admissible tool carried -> typed dig_no_tool, no dig',
    `thrown=${thrown} held=${fixture.held()}`,
  )
}

{
  const block = {
    name: 'stone',
    position: new P(1, 64, 0),
    boundingBox: 'block',
    diggable: true,
    harvestTools: { [REGISTRY.itemsByName.iron_pickaxe.id]: true },
  }
  const fixture = makeFight({ carried: { iron_pickaxe: 1, diamond_sword: 1 }, heldItem: 'diamond_sword' })
  const executor = makeExecutor(fixture)
  const guard = executor as unknown as {
    requireHarvestTool: (b: unknown, epoch: number, signal: AbortSignal) => Promise<void>
  }
  // epoch 0 = the executor's own idle epoch (no action claimed in this unit probe)
  await guard.requireHarvestTool(block, 0, new AbortController().signal)
  report(
    fixture.logger.matching('DIG_TOOL_LEGALITY').length === 1 && fixture.held() === 'iron_pickaxe',
    'CAN-b. a carried admissible tool replaces the sword before the dig (legality, not preference)',
    `markers=${JSON.stringify(fixture.logger.matching('DIG_TOOL_LEGALITY'))} held=${fixture.held()}`,
  )
}

{
  // A block with no harvestTools contract (dirt/leaves) is untouched: any item,
  // including the hand, is legal there.
  const block = { name: 'dirt', position: new P(1, 64, 0), boundingBox: 'block', diggable: true }
  const fixture = makeFight({ carried: { diamond_sword: 1 }, heldItem: 'diamond_sword' })
  const executor = makeExecutor(fixture)
  const guard = executor as unknown as {
    requireHarvestTool: (b: unknown, epoch: number, signal: AbortSignal) => Promise<void>
  }
  await guard.requireHarvestTool(block, 0, new AbortController().signal)
  report(
    fixture.logger.matching('DIG_TOOL_LEGALITY').length === 0 && fixture.held() === 'diamond_sword',
    'CAN-c. a block with no harvest-tool contract is untouched (no invented tool requirement)',
    `markers=${fixture.logger.matching('DIG_TOOL_LEGALITY').length} held=${fixture.held()}`,
  )
}

// ===========================================================================
// ATTACK offer (operator directive): the hostile flag is a FACT, not the gate
// ===========================================================================

function worldWithEntities(
  entities: Array<Record<string, unknown>>,
  health = 20,
  food = 20,
  options: { collectGoal?: boolean } = {},
): WorldState {
  const world = worldWithProducer(4)
  ;(world as unknown as { entities: unknown[] }).entities = entities
  ;(world as unknown as { self: { health: number; food: number } }).self = {
    ...(world as unknown as { self: Record<string, unknown> }).self,
    health,
    food,
  }
  if (options.collectGoal === false) {
    // No collect goal: the same entity must then be a PLAIN grounded ATTACK, with
    // no producer/drop contract invented for it.
    const goal = {
      id: 'g1:mine:cobblestone',
      kind: 'mine',
      description: 'mine cobblestone',
      targetItem: 'cobblestone',
      requiredCount: 8,
      startCount: 0,
      haveCount: 0,
      status: 'active',
      origin: 'llm',
      createdAt: 0,
      updatedAt: 0,
      detail: null,
    } as never
    ;(world as unknown as { goal: unknown }).goal = { targetItem: 'cobblestone', requiredCount: 8, haveCount: 0 }
    ;(world as unknown as { goalQueue: unknown }).goalQueue = {
      depth: 1,
      current: goal,
      empty: false,
      hasImpossible: false,
      done: 0,
      goals: [goal],
    }
  }
  return world
}

{
  // The zombie_villager shape: NOT flagged hostile, but it ENGAGED the body.
  const engaged = {
    id: 77,
    name: 'zombie_villager',
    kind: 'mob',
    username: null,
    position: { x: 2, y: 64, z: 0 },
    distance: 2,
    hostile: false,
    attackedSelf: true,
    lineOfSight: true,
  }
  const passive = {
    id: 78,
    name: 'cow',
    kind: 'mob',
    username: null,
    position: { x: 3, y: 64, z: 0 },
    distance: 3,
    hostile: false,
    lineOfSight: true,
  }
  const grounded = generateGroundedCandidates(worldWithEntities([engaged, passive]), optionsWithProbe('reachable'))
  const engagedAttack = grounded.candidates.find((candidate) => candidate.targetEntityId === 77)
  const passiveAttack = grounded.candidates.find((candidate) => candidate.targetEntityId === 78)
  const pass =
    // the offer no longer depends on the hostile flag to EXIST
    engagedAttack?.id === 'ATTACK:e77' &&
    engagedAttack.meta.hostile === false &&
    engagedAttack.meta.attackedSelf === true &&
    engagedAttack.meta.attackable === true &&
    // a plain passive mob is offered too, with hostile=false as a FACT
    passiveAttack?.id === 'ATTACK:e78' &&
    passiveAttack.meta.hostile === false &&
    passiveAttack.meta.targetHostile === undefined &&
    passiveAttack.meta.attackedSelf === undefined &&
    passiveAttack.meta.reachability === 'contact' &&
    // and nothing ranked them: the ids are the entity ids, in sensor order
    grounded.candidates.filter((candidate) => candidate.kind === 'ATTACK').map((candidate) => candidate.id).join(',') ===
      'ATTACK:e77,ATTACK:e78'
  report(
    pass,
    'OFFER-a. the hostile flag is a FACT: an engaged non-hostile and a passive mob both get grounded ATTACK offers',
    `engaged=${engagedAttack?.id ?? 'none'}/${JSON.stringify(engagedAttack?.meta?.hostile)} attackedSelf=${engagedAttack?.meta?.attackedSelf ?? 'none'} ` +
      `passive=${passiveAttack?.id ?? 'none'}/${JSON.stringify(passiveAttack?.meta?.hostile)} reach=${passiveAttack?.meta?.reachability ?? 'none'} ` +
      `order=${grounded.candidates.filter((c) => c.kind === 'ATTACK').map((c) => c.id).join(',')}`,
  )
}

{
  // Entity truth: non-mob families are not attackable, and the drop fact is
  // carried when the entity is a known producer.
  const item = { id: 90, name: 'item', kind: 'object', username: null, position: { x: 1, y: 64, z: 0 }, distance: 1, hostile: false }
  const orb = { id: 91, name: 'experience_orb', kind: 'orb', username: null, position: { x: 1, y: 64, z: 0 }, distance: 1, hostile: false }
  const frame = { id: 92, name: 'item_frame', kind: 'object', username: null, position: { x: 1, y: 64, z: 0 }, distance: 1, hostile: false }
  const arrow = { id: 93, name: 'arrow', kind: 'projectile', username: null, position: { x: 1, y: 64, z: 0 }, distance: 1, hostile: false }
  const blaze = { id: 94, name: 'blaze', kind: 'hostile', username: null, position: { x: 4, y: 64, z: 0 }, distance: 4, hostile: true }
  const grounded = generateGroundedCandidates(worldWithEntities([item, orb, frame, arrow, blaze]), optionsWithProbe('reachable'))
  const attackIds = grounded.candidates.filter((candidate) => candidate.kind === 'ATTACK').map((candidate) => candidate.id)
  const blazeAttack = grounded.candidates.find((candidate) => candidate.targetEntityId === 94)
  const pass =
    attackIds.join(',') === 'ATTACK:e94' &&
    isAttackableEntity({ name: 'item', kind: 'object' }) === false &&
    isAttackableEntity({ name: 'experience_orb', kind: 'orb' }) === false &&
    isAttackableEntity({ name: 'item_frame', kind: 'object' }) === false &&
    isAttackableEntity({ name: 'arrow', kind: 'projectile' }) === false &&
    isAttackableEntity({ name: 'armor_stand', kind: 'object' }) === false &&
    isAttackableEntity({ name: 'zombie_villager', kind: 'mob' }) === true &&
    // the drop fact is producer truth, not a preference
    producerDropFor('blaze') === 'blaze_rod' &&
    producerDropFor('enderman') === 'ender_pearl' &&
    producerDropFor('cow') === null &&
    blazeAttack?.meta.dropItem === 'blaze_rod'
  report(
    pass,
    'OFFER-b. entity truth bounds the offer: items/orbs/frames/projectiles are not attackable, producers carry their drop',
    `attacks=[${attackIds.join(',')}] drop=${String(blazeAttack?.meta?.dropItem ?? 'none')} item=${isAttackableEntity({ name: 'item', kind: 'object' })} ` +
      `orb=${isAttackableEntity({ name: 'experience_orb', kind: 'orb' })} frame=${isAttackableEntity({ name: 'item_frame', kind: 'object' })} ` +
      `arrow=${isAttackableEntity({ name: 'arrow', kind: 'projectile' })} zombieVillager=${isAttackableEntity({ name: 'zombie_villager', kind: 'mob' })}`,
  )
}

{
  // The goalDrop producer hunt is UNCHANGED: same id, same goalDrop contract.
  const blaze = { id: 94, name: 'blaze', kind: 'hostile', username: null, position: { x: 4, y: 64, z: 0 }, distance: 4, hostile: true }
  const grounded = generateGroundedCandidates(worldWithProducer(4), optionsWithProbe('reachable'))
  const hunt = grounded.candidates.find((candidate) => candidate.kind === 'ATTACK')
  const extra = generateGroundedCandidates(worldWithEntities([blaze], 20, 20, { collectGoal: false }), optionsWithProbe('reachable'))
  const extraHunt = extra.candidates.find((candidate) => candidate.kind === 'ATTACK')
  const pass =
    hunt?.id === 'ATTACK:e16002' &&
    hunt.meta.goalDrop === 'blaze_rod' &&
    hunt.meta.producerMob === 'blaze' &&
    hunt.meta.requiresKill === true &&
    // the same entity as a plain offer (no collect goal) keeps the plain shape
    extraHunt?.id === 'ATTACK:e94' &&
    extraHunt.meta.goalDrop === undefined &&
    extraHunt.meta.attackable === true
  report(
    pass,
    'OFFER-c. the goalDrop producer hunt keeps its id/contract; the same entity without a collect goal is a plain ATTACK',
    `hunt=${hunt?.id ?? 'none'} goalDrop=${String(hunt?.meta?.goalDrop ?? 'none')} plain=${extraHunt?.id ?? 'none'} plainGoalDrop=${String(extraHunt?.meta?.goalDrop ?? 'none')}`,
  )
}

process.stdout.write(`${'-'.repeat(84)}\n`)
process.stdout.write(`${total - failures}/${total} combat-closure cases passed\n`)
if (failures > 0) process.exit(1)
