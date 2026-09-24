// test-airborne-engagement.mts - THE AIRBORNE RANGED HOSTILE: reaching a target
// whose hitbox is above the body's, and collecting what it drops.
//
// CAPABILITY CLASS (not a mob): "kill a ranged hostile that flies and shoots, in a
// hazardous enclosed structure, then collect its drop". The mechanism generalises
// to any entity whose hitbox sits ABOVE the body's - a hovering blaze or ghast, a
// phantom, a skeleton on a ledge - because the fix is a property of the BODY's
// reach, not of the mob.
//
// MEASURED STOP POINT this file reproduces (live record, 2026-09-21/22, HEAD
// 38cbb22; see the lane report for the full counts):
//
//   - the blaze IS sensed (746 `mob_appeared entity=blaze`, 1257 Jev projection
//     entries `"name":"blaze","kind":"Hostile mobs"`) and an ATTACK IS offered and
//     chosen for it (36 distinct `ATTACK:e<N>` ids, 31 chosen);
//   - every one of the 19 `HUNT_END` lines in the whole run is `target=blaze`, and
//     every one ends `swings=0 hits=0` (14 out_of_range, 4 no_reacquire,
//     1 unreachable). `ATTACK_HIT` matches a sensed blaze id 0 times out of 76;
//     `ATTACK_TARGET_DEAD` 0 out of 15 - the melee path kills other mobs, never a
//     blaze;
//   - the closest geometry the body EVER reached against a blaze is
//     `HUNT_CONTACT_UNREACHABLE actionId=ATTACK:e85793 entity=e85793 target=blaze
//      evidence=vertical_gap ... horizontal=1.70 gap_y=4 melee=3.1 walk_gap=3.1`
//     - i.e. the body stood 1.70 m horizontally from a blaze whose feet were FOUR
//     levels above its own, and the code proved "no stance can land a swing".
//
// Feet-to-feet that gap is 4.35 m > 3.1. Measured from the body's own upper half
// (eye height 1.62) it is 2.93 m <= 3.1 - an ordinary swing. The target was not
// unhittable; the MEASUREMENT was one body-height short.
//
// Fixtures:
//   (i)   a flying ranged hostile at the edge of, and inside, melee reach - with a
//         legal stance and with none
//   (ii)  the measured live shape, BEFORE and AFTER
//   (iii) a killed mob's drop collected end to end
//   (iv)  the control: an ordinary ground mob is byte-identical
//   (v)   no mob is special-cased: the same geometry gives the same verdict for
//         every name (the fix is a body property)
//
//   bun test-airborne-engagement.mts
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import { Executor, defaultExecutorOptions } from './src/executor.ts'
import { EventLogger } from './src/jev.ts'
import type { Candidate } from './src/candidates.ts'
import type { AgentLevel } from './src/jev-legacy.ts'
import {
  MELEE_ATTACK_REACH,
  MELEE_REACH_UP,
  bodyMeleeDistance,
  bodyReachDistance,
  formatMeleeVerticalReach,
  MELEE_VERTICAL_REACH,
  meleeContactDistance,
  meleeHorizontalBudget,
  meleeReachDistance,
  meleeVerticalReachGap,
  meleeWalkGap,
  selectAttackStand,
  stanceMeleeDistance,
  stanceReachDistance,
} from './src/combatClosure.ts'
import { mirroredEventToken } from './src/controller-legacy.ts'

const require = createRequire(import.meta.url)
const REGISTRY = require('minecraft-data')('1.21.11')

class P {
  constructor(public x: number, public y: number, public z: number) {}
  clone(): P {
    return new P(this.x, this.y, this.z)
  }
  set(x: number, y: number, z: number): P {
    this.x = x
    this.y = y
    this.z = z
    return this
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
  has(fragment: string): boolean {
    return this.lines.some((line) => line.includes(fragment))
  }
  containing(fragment: string): string[] {
    return this.lines.filter((line) => line.includes(fragment))
  }
}

/** A sensed hostile, exactly the shape the sensor publishes. */
function sensed(
  id: number,
  name: string,
  position: { x: number; y: number; z: number },
  bodyPosition: { x: number; y: number; z: number },
): Record<string, unknown> {
  return {
    id,
    name,
    kind: 'hostile',
    username: null,
    position,
    distance:
      Math.round(
        Math.hypot(position.x - bodyPosition.x, position.y - bodyPosition.y, position.z - bodyPosition.z) * 100,
      ) / 100,
    hostile: true,
    lineOfSight: true,
  }
}

// ---------------------------------------------------------------------------
// Executor fixture: the REAL Executor driven by a fake mineflayer bot, so the
// ATTACK lease's own verdicts and the HUNT_DROP postcondition can be asserted.
// ---------------------------------------------------------------------------

interface FightFixture {
  bot: Bot
  logger: CapturingLogger
  attacks: () => number
  dropped: () => number
}

function makeFight(options: {
  body: { x: number; y: number; z: number }
  mob: { x: number; y: number; z: number }
  mobName?: string
  carried?: Record<string, number>
  hitsToKill?: number
  dropItem?: string
}): FightFixture {
  const emitter = new EventEmitter()
  const carried = options.carried ?? {}
  const dropItem = options.dropItem ?? 'blaze_rod'
  const dropItemId = REGISTRY.itemsByName[dropItem]?.id ?? -1
  const mobName = options.mobName ?? 'blaze'
  let dropped = 0
  let swings = 0
  let hitsTaken = 0
  const hitsToKill = options.hitsToKill ?? 2
  const items = Object.entries(carried).map(([name, count], index) => ({
    name,
    type: REGISTRY.itemsByName[name]?.id ?? 1,
    count,
    slot: 36 + index,
  }))
  const attacksByEntity = new Map<number, number>()
  const mob = {
    id: 31,
    name: mobName,
    kind: 'hostile',
    height: 1.8,
    isValid: true,
    position: new P(options.mob.x, options.mob.y, options.mob.z),
  }
  const bot = emitter as EventEmitter & Record<string, any>
  Object.assign(bot, {
    registry: REGISTRY,
    health: 20,
    oxygenLevel: 20,
    physicsEnabled: true,
    entity: {
      id: 1,
      position: new P(options.body.x, options.body.y, options.body.z),
      yaw: 0,
      pitch: 0,
      onGround: true,
      width: 0.6,
      height: 1.8,
    },
    entities: { 31: mob },
    game: { dimension: 'minecraft:the_nether' },
    inventory: {
      slots: [],
      items: () => [...items],
      count: (id: number) =>
        items.filter((item) => item.type === id).reduce((sum, item) => sum + item.count, 0) +
        (id === dropItemId ? dropped : 0),
    },
    blockAt: () => null,
    pathfinder: {
      setMovements: () => undefined,
      setGoal: () => undefined,
      stop: () => undefined,
      getPathTo: () => ({ status: 'success', path: [] }),
    },
    lookAt: async () => undefined,
    equip: async () => undefined,
    attack: (entity: { id: number }) => {
      swings += 1
      attacksByEntity.set(entity.id, (attacksByEntity.get(entity.id) ?? 0) + 1)
      if (entity.id !== mob.id) return
      hitsTaken += 1
      setTimeout(() => {
        emitter.emit('entityHurt', mob, bot.entity)
        if (hitsTaken >= hitsToKill) {
          dropped += 1
          delete (bot.entities as Record<number, unknown>)[mob.id]
          emitter.emit('entityDead', mob)
        }
      }, 3)
    },
    stopDigging: () => undefined,
    setControlState: () => undefined,
  })
  Object.defineProperty(bot, 'heldItem', { get: () => null, configurable: true })
  return {
    bot: bot as unknown as Bot,
    logger: new CapturingLogger(),
    attacks: () => swings,
    dropped: () => dropped,
  }
}

function huntCandidate(entityId: number, distance: number, targetName = 'blaze'): Candidate {
  return {
    id: `ATTACK:e${entityId}`,
    kind: 'ATTACK',
    label: `hunt ${targetName} ${distance}m away for blaze_rod`,
    targetName,
    target: { x: 0, y: 64, z: 0 },
    targetEntityId: entityId,
    itemName: 'blaze_rod',
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: {
      tick: 1,
      entityId,
      distance,
      goalDrop: 'blaze_rod',
      requiresKill: true,
      decisionEpoch: 3,
      worldEpoch: 1,
    },
  }
}

function runHunt(fixture: FightFixture, candidate: Candidate) {
  const executor = new Executor(fixture.bot, fixture.logger, {
    ...defaultExecutorOptions,
    goalItem: 'blaze_rod',
    verifyTimeoutMs: 300,
    pickupPathTimeoutMs: 300,
    huntReacquireMs: 250,
  })
  return executor.claim(candidate).completion
}

let total = 0
let failures = 0
const report = (pass: boolean, name: string, detail: string): void => {
  total += 1
  if (!pass) failures += 1
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}\n`)
  process.stdout.write(`      ${detail}\n`)
}

const BODY = { x: 0.5, y: 60, z: 0.5 }

/** The reach maths is a BODY property: the name is never an input. */
const mobs = ['blaze', 'ghast', 'phantom', 'skeleton', 'magma_cube'] as const

// ===========================================================================
// (i) A FLYING RANGED HOSTILE at the edge of, and inside, melee reach - with a
//     legal stance and with none.
// ===========================================================================
{
  // The live shape: 4 levels above the body's feet, 1.70 m horizontally.
  const base = { position: { x: BODY.x + 1.7, y: BODY.y + 4, z: BODY.z }, height: 1.8 }
  // The measured setting: a hovering producer over a walkway, so the ONLY footing
  // inside the envelope is the cell the body already stands on (the live
  // `HUNT_CONTACT_UNREACHABLE` case had `ascent_refusal=none placeable=cobblestone`
  // and no stance at all). A world where every cell floats would let the search
  // prefer a cell in mid-air, which is not the question this fixture asks.
  const ownCellOnly = {
    standable: (x: number, y: number, z: number) => x === 0 && y === 60 && z === 0,
    hazard: () => false,
    visible: () => true,
  }
  const noStanceWorld = { standable: () => false, hazard: () => false, visible: () => true }

  const inside = selectAttackStand({ entity: base, feet: BODY, reach: MELEE_ATTACK_REACH, world: ownCellOnly })
  const none = selectAttackStand({ entity: base, feet: BODY, reach: MELEE_ATTACK_REACH, world: noStanceWorld })

  // "At the edge": the body's own cell is exactly at the envelope boundary. The
  // boundary entity is 3.1 corrected metres away, so a target 4 up needs
  // horizontal = sqrt(3.1^2 - 2.38^2) = 1.9875.
  const edgeHorizontal = meleeHorizontalBudget(4)
  const edge = selectAttackStand({
    entity: { position: { x: BODY.x + edgeHorizontal, y: BODY.y + 4, z: BODY.z }, height: 1.8 },
    feet: BODY,
    reach: MELEE_ATTACK_REACH,
    world: ownCellOnly,
  })
  const beyond = selectAttackStand({
    entity: { position: { x: BODY.x + edgeHorizontal + 0.001, y: BODY.y + 4, z: BODY.z }, height: 1.8 },
    feet: BODY,
    reach: MELEE_ATTACK_REACH,
    world: ownCellOnly,
  })

  const pass =
    // the fix's whole point: the body's OWN cell is now a legal stance for a
    // target 4 levels above it - before the correction the search found none
    inside.stand !== null &&
    inside.onBody === true &&
    inside.stand.y === 60 &&
    inside.refusal === null &&
    inside.standDistance !== null &&
    Math.abs(inside.standDistance - 2.925) < 0.01 &&
    inside.standDistance <= MELEE_ATTACK_REACH &&
    // ... and a world with no standable cell still refuses, typed
    none.stand === null &&
    none.refusal === 'no_standable_cell' &&
    // inclusive at the boundary, exclusive one thousandth beyond it
    edge.stand !== null &&
    Math.abs((edge.standDistance ?? 0) - MELEE_ATTACK_REACH) < 1e-6 &&
    beyond.stand === null &&
    beyond.refusal === 'no_standable_cell'
  report(
    pass,
    '(i) a flying ranged hostile 4 levels above: a stance EXISTS from the body own cell, and no stance is refused typed',
    `inside=${String(inside.stand?.x)},${String(inside.stand?.y)},${String(inside.stand?.z)} onBody=${String(inside.onBody)} d=${String(inside.standDistance)} ` +
      `none=${none.refusal ?? 'none'} edgeD=${String(edge.standDistance)} budget=${edgeHorizontal.toFixed(4)} beyond=${beyond.refusal ?? 'none'}`,
  )
}

// ===========================================================================
// (ii) THE MEASURED LIVE SHAPE, BEFORE and AFTER.
//      Live: `HUNT_CONTACT_UNREACHABLE actionId=ATTACK:e85793 ... horizontal=1.70
//      gap_y=4 melee=3.1` - the lease ended with 0 swings.
// ===========================================================================
{
  const horizontal = 1.7
  const gapY = 4
  const feetToFeet = Math.hypot(horizontal, gapY)
  const corrected = meleeReachDistance(horizontal, gapY)
  // BEFORE: the model the live record was produced by - feet-to-feet 3-D.
  const beforeRefused = feetToFeet > MELEE_ATTACK_REACH
  const afterRefused = corrected > MELEE_ATTACK_REACH
  const pass =
    Math.abs(feetToFeet - 4.35) < 0.01 &&
    beforeRefused === true &&
    afterRefused === false &&
    Math.abs(corrected - 2.93) < 0.01 &&
    // and the lease-ending proof no longer fires for this gap
    meleeVerticalReachGap(gapY) <= MELEE_ATTACK_REACH &&
    meleeWalkGap() > gapY
  report(
    pass,
    '(ii) the measured live shape BEFORE/AFTER: gap_y=4 horizontal=1.70 was refused at 4.35 m and is grounded at 2.93 m',
    `before(3-D feet-to-feet)=${feetToFeet.toFixed(2)} refused=${String(beforeRefused)} | after(reach)=${corrected.toFixed(2)} refused=${String(afterRefused)} ` +
      `verticalGap=${meleeVerticalReachGap(gapY)} walkGap=${meleeWalkGap()}`,
  )
}

// ===========================================================================
// (ii-b) the SAME lease, end to end: the live shape now lands swings and kills.
//        This is the measurement's own counterfactual, executed on the real
//        Executor.
// ===========================================================================
{
  const fixture = makeFight({
    body: BODY,
    mob: { x: BODY.x + 1.7, y: BODY.y + 4, z: BODY.z },
    hitsToKill: 2,
  })
  const result = await runHunt(fixture, huntCandidate(31, 4.35))
  const vertical = fixture.logger.containing(MELEE_VERTICAL_REACH)
  const outcome = fixture.logger.containing('COMBAT_OUTCOME')
  const pass =
    fixture.attacks() >= 2 &&
    result.status === 'done' &&
    outcome.some((line) => line.includes('outcome=KILL_VERIFIED')) &&
    !fixture.logger.has('HUNT_CONTACT_UNREACHABLE') &&
    vertical[0] !== undefined &&
    vertical[0].includes('gap_y=4') &&
    vertical[0].includes(`reach_up=${MELEE_REACH_UP}`) &&
    vertical[0].includes('outcome=grounded') &&
    vertical[0].includes('distance=4.35') &&
    mirroredEventToken(vertical[0]) === MELEE_VERTICAL_REACH
  report(
    pass,
    '(ii-b) the same live shape leased: swings land, the kill verifies, and the vertical reach is MIRRORED evidence',
    `swings=${fixture.attacks()} status=${result.status} outcome=${outcome[0] ?? 'none'}\n      | ${vertical[0] ?? 'no vertical line'}`,
  )
}

// ===========================================================================
// (iii) A KILLED MOB'S DROP, COLLECTED END TO END: the kill verifies AND the
//       declared drop reaches the inventory through the existing PICKUP path -
//       no second collection mechanism is introduced here.
// ===========================================================================
{
  const fixture = makeFight({
    body: BODY,
    mob: { x: BODY.x + 1.7, y: BODY.y + 4, z: BODY.z },
    hitsToKill: 1,
  })
  const result = await runHunt(fixture, huntCandidate(31, 4.35))
  const pass =
    result.status === 'done' &&
    fixture.dropped() === 1 &&
    fixture.logger.containing('COMBAT_OUTCOME').some((line) => line.includes('for=blaze_rod'))
  report(
    pass,
    '(iii) the killed mob drop is collected end to end: kill verified, drop in the inventory',
    `status=${result.status} dropped=${fixture.dropped()} outcome=${fixture.logger.containing('COMBAT_OUTCOME')[0] ?? 'none'}`,
  )
}

// ===========================================================================
// (iv) THE CONTROL: an ordinary GROUND mob is byte-identical. Both measures are
//      the same expression at gapY <= 0, and the executor's own distances and
//      decisions do not move.
// ===========================================================================
{
  // The measures agree EXACTLY (not approximately) at and below the body's level.
  const exact: boolean[] = []
  for (const gapY of [0, -1, -2, -3, -5]) {
    for (const horizontal of [0, 0.5, 1.7, 2.9, 3.1]) {
      const stance = { x: Math.floor(BODY.x), y: Math.floor(BODY.y), z: Math.floor(BODY.z) }
      const entity = { x: BODY.x + horizontal, y: BODY.y + gapY, z: BODY.z }
      // The code paths the executor and the stance gate ACTUALLY call: for a
      // level/downward target they delegate to the pre-correction measurement
      // verbatim, so the equality is exact, not approximate. `meleeContactDistance`
      // is the executor's own envelope test and must return the historical 3-D
      // distance unchanged.
      exact.push(
        bodyReachDistance(BODY, entity) === bodyMeleeDistance(BODY, entity) &&
          stanceReachDistance(stance, entity) === stanceMeleeDistance(stance, entity) &&
          meleeContactDistance({ distance: bodyMeleeDistance(BODY, entity), horizontal, gapY }) ===
            bodyMeleeDistance(BODY, entity),
      )
    }
  }
  // And the ATTACK lease on a same-level mob behaves as before: close, then swing
  // from inside the envelope.
  const ground = makeFight({ body: BODY, mob: { x: BODY.x + 2.5, y: BODY.y, z: BODY.z }, hitsToKill: 2 })
  const result = await runHunt(ground, huntCandidate(31, 2.5, 'zombie'))
  const pass =
    exact.every((value) => value) &&
    meleeContactDistance({ distance: Math.hypot(2.5, 0), horizontal: 2.5, gapY: 0 }) === Math.hypot(2.5, 0) &&
    Math.abs(meleeVerticalReachGap(0)) < 1e-12 &&
    ground.attacks() >= 2 &&
    result.status === 'done' &&
    // the vertical marker is about UPWARD gaps only: a ground mob never emits it
    !ground.logger.has(MELEE_VERTICAL_REACH)
  report(
    pass,
    '(iv) the GROUND-MOB control: identical measure at gapY<=0 (exact), same lease, and no vertical marker',
    `exact=${exact.filter(Boolean).length}/${exact.length} contact(2.5,0)=${meleeContactDistance({ distance: 2.5, horizontal: 2.5, gapY: 0 })} swings=${ground.attacks()} status=${result.status} verticalLines=${ground.logger.containing(MELEE_VERTICAL_REACH).length}`,
  )
}

// ===========================================================================
// (v) NO MOB IS SPECIAL-CASED: the whole verdict is a function of the BODY and
//     the GEOMETRY. The same position gives the same distance and the same
//     stance verdict for every name, and the marker carries no name-specific
//     branch.
// ===========================================================================
{
  const verdicts = mobs.map((name) => {
    const entity = { position: { x: BODY.x + 1.7, y: BODY.y + 4, z: BODY.z }, height: 1.8 }
    const fact = selectAttackStand({
      entity,
      feet: BODY,
      reach: MELEE_ATTACK_REACH,
      world: { standable: () => true, hazard: () => false, visible: () => true },
    })
    const line = formatMeleeVerticalReach({
      outcome: 'grounded',
      actionId: 'ATTACK:e1',
      entityId: 1,
      targetName: name,
      distance: Math.hypot(1.7, 4),
      reachDistance: meleeReachDistance(1.7, 4),
      horizontal: 1.7,
      gapY: 4,
      meleeReach: MELEE_ATTACK_REACH,
      reachUp: MELEE_REACH_UP,
    })
    return { name, d: fact.standDistance, stand: fact.stand !== null, token: mirroredEventToken(line) }
  })
  const unique = new Set(verdicts.map((verdict) => `${String(verdict.d)}|${String(verdict.stand)}|${String(verdict.token)}`))
  const pass = unique.size === 1 && verdicts.every((verdict) => verdict.stand && verdict.token === MELEE_VERTICAL_REACH)
  report(
    pass,
    '(v) the fix is a BODY property, not a mob rule: five different names give one identical verdict',
    `distinct=${unique.size} ${verdicts.map((verdict) => `${verdict.name}:${verdict.d?.toFixed(3)}`).join(' ')}`,
  )
}

// ===========================================================================
// (v-b) THE SAFETY LAYER IS INTACT: the correction is MONOTONE (it can only move
//       a target INTO the envelope) and the proof threshold still refuses what is
//       genuinely out of reach.
// ===========================================================================
{
  const monotone: boolean[] = []
  for (let gapY = -8; gapY <= 8; gapY += 1) {
    monotone.push(meleeVerticalReachGap(gapY) <= Math.abs(gapY) + 1e-12)
  }
  const pass =
    monotone.every((value) => value) &&
    // 4 is hittable standing, 5 is not - the honest whole-block split
    meleeVerticalReachGap(4) <= MELEE_ATTACK_REACH &&
    meleeVerticalReachGap(5) > MELEE_ATTACK_REACH &&
    meleeVerticalReachGap(9) > MELEE_ATTACK_REACH &&
    meleeVerticalReachGap(28) > MELEE_ATTACK_REACH &&
    // and the marker says so in the refusing direction too
    formatMeleeVerticalReach({
      outcome: 'refused',
      actionId: 'ATTACK:e1',
      entityId: 1,
      targetName: 'blaze',
      distance: Math.hypot(0.81, 28),
      reachDistance: meleeReachDistance(0.81, 28),
      horizontal: 0.81,
      gapY: 28,
      meleeReach: MELEE_ATTACK_REACH,
      reachUp: MELEE_REACH_UP,
    }).includes('outcome=refused')
  report(
    pass,
    '(v-b) monotone by construction and honest at the boundary: 4 walkable, 5/9/28 still out of reach',
    `monotone=${monotone.filter(Boolean).length}/${monotone.length} gap4=${meleeVerticalReachGap(4)} gap5=${meleeVerticalReachGap(5)} gap9=${meleeVerticalReachGap(9)} gap28=${meleeVerticalReachGap(28)}`,
  )
}

// ===========================================================================
// (v-c) THE LEASE DOES NOT CLAIM WHAT IT CANNOT REACH: a target still beyond the
//       corrected envelope ends typed, with no swing and no invented kill.
// ===========================================================================
{
  const fixture = makeFight({ body: BODY, mob: { x: BODY.x, y: BODY.y + 9, z: BODY.z }, hitsToKill: 2 })
  const result = await runHunt(fixture, huntCandidate(31, 9))
  const pass =
    fixture.attacks() === 0 &&
    result.status !== 'done' &&
    fixture.logger.has('HUNT_CONTACT_UNREACHABLE') &&
    fixture.logger.containing('HUNT_CONTACT_UNREACHABLE')[0]?.includes('gap_y=9') === true
  report(
    pass,
    '(v-c) a target past the corrected envelope is still proven unreachable: 0 swings, typed, no fake kill',
    `swings=${fixture.attacks()} status=${result.status} line=${fixture.logger.containing('HUNT_CONTACT_UNREACHABLE')[0] ?? 'none'}`,
  )
}

process.stdout.write(`${'-'.repeat(84)}\n`)
process.stdout.write(`${total - failures}/${total} airborne-engagement cases passed\n`)
process.exit(failures === 0 ? 0 : 1)
