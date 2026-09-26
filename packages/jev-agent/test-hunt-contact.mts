// test-hunt-contact.mts - the CONTACT GEOMETRY of a fight, and the honest
// unreachable outcome.
//
// MEASURED FAILURE this file pins. Over the whole live M3 history no blaze hunt
// ever landed a swing:
//
//   HUNT_END reason=out_of_range actionId=ATTACK:e6768 target=blaze for=blaze_rod
//     swings=0 hits=0 reacquired=0 lastKnown=36.3,60,-37.045 ms=10043
//   ... 17/17 blaze hunts swings=0 hits=0 (13 out_of_range, 4 no_reacquire)
//
// The gate bounded the approach with `HUNT_APPROACH_BUDGET` (a WALKING distance)
// but compared it against the raw 3-D distance, and the ATTACK lease's own
// envelope (`GoalFollow` + `bot.attack`, weapon-only equip list) can neither gain
// height nor realize a route it cannot walk inside the lease. So the commitment
// ran to its deadline and reported `out_of_range` - which reads as a failed
// attempt rather than a target no remedy reaches.
//
// The fixtures below hold the four boundaries the fix must keep apart:
//
//   (i)   a target above the walk envelope WITH a grounded vertical route -> the
//         route is offered as an ordinary MOVE-family reposition, and once the
//         body is at that level the ATTACK is offered and LANDS SWINGS
//   (ii)  a target above the walk envelope with NO grounded route -> a typed
//         "cannot reach" outcome, never a 0-swing lease that looks like one
//   (iii) a target inside the melee envelope -> unchanged
//   (iv)  the new capability's own mechanical facts (pure verdict table, the §9
//         TARGET_UNREACHABLE outcome, and the executor's runtime proof)
//   (v)   no code ranking between attack and reposition: both offered, Jev chooses
//
//   bun test-hunt-contact.mts
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import { Executor, defaultExecutorOptions, formatHuntEnd } from './src/executor.ts'
import { EventLogger } from './src/jev.ts'
import type { AgentLevel } from './src/jev/client.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import { defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import type { WorldState } from './src/state.ts'
import {
  classifyCombatOutcome,
  classifyContactApproach,
  combatFailureCode,
  contactGapY,
  formatCombatOutcome,
  formatContactUnreachable,
  HUNT_CONTACT_UNREACHABLE,
} from './src/combatClosure.ts'
import type { ContactGeometryFacts } from './src/combatClosure.ts'
import { mirroredEventToken } from './src/controller-legacy.ts'
import { fixtureClaim } from './test-claim-context.mts'

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
  set(x: number, y: number, z: number): P {
    this.x = x
    this.y = y
    this.z = z
    return this
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

// ---------------------------------------------------------------------------
// World fixtures. The body stands on the fortress walkway; the producer hovers
// `gapY` blocks above it and `horizontal` blocks away, exactly the measured shape
// (a blaze over the lava basin, never visible: `lineOfSight=false` in 221/221
// live samples, closest ever 21.32 m horizontally).
// ---------------------------------------------------------------------------

function producer(
  id: number,
  position: { x: number; y: number; z: number },
  bodyPosition: { x: number; y: number; z: number },
): Record<string, unknown> {
  return {
    id,
    name: 'blaze',
    kind: 'hostile',
    username: null,
    position,
    distance: Math.round(Math.hypot(position.x - bodyPosition.x, position.y - bodyPosition.y, position.z - bodyPosition.z) * 100) / 100,
    hostile: true,
    lineOfSight: false,
  }
}

/**
 * A live-shaped collect world: the body at `body` on the walkway, the sensed
 * producers in `entities`, and whatever the body carries in `carried`.
 */
function world(input: {
  body: { x: number; y: number; z: number }
  entities: Array<Record<string, unknown>>
  carried?: Record<string, number>
  held?: string | null
}): WorldState {
  const goal = {
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
  } as never
  const carried = input.carried ?? {}
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: {
      position: input.body,
      // the real sensor always carries the eye position; `ascentRouteTo` reads it
      // for the candidate's `inReach` fact.
      eyePosition: { x: input.body.x, y: input.body.y + 1.62, z: input.body.z },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      health: 20,
      food: 20,
      saturation: 5,
      oxygen: 20,
      onGround: true,
      inWater: false,
      dimension: 'minecraft:the_nether',
      heldItem: input.held === null || input.held === undefined ? null : { name: input.held, count: 1, slot: 36 },
      armor: { head: null, torso: null, legs: null, feet: null },
      effects: [],
    },
    inventory: {
      slots: [],
      counts: carried,
      totalItems: Object.values(carried).reduce((sum, count) => sum + count, 0),
    },
    entities: input.entities,
    blocks: [],
    // The sensor reports the cells the body can STAND on, and the ascend
    // ability's own `footingSolid` fact is read from them: without the body's own
    // feet cell the pillar plan is (correctly) judged unexecutable. The real
    // scanner always includes it.
    terrain: {
      standable: [{ x: Math.floor(input.body.x), y: Math.floor(input.body.y), z: Math.floor(input.body.z) }],
    },
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

// ---------------------------------------------------------------------------
// Executor fixture: the REAL Executor driven by a fake mineflayer bot, so the
// ATTACK lease's own verdicts (`COMBAT_OUTCOME`, `HUNT_END`) can be asserted.
// ---------------------------------------------------------------------------

interface FightFixture {
  bot: Bot
  logger: CapturingLogger
  attacks: () => number
  attacksOn: (entityId: number) => number
  elapsedMs: () => number
}

function makeFight(options: {
  body: { x: number; y: number; z: number }
  mob: { x: number; y: number; z: number }
  carried?: Record<string, number>
  hitsToKill?: number
  dropItem?: string
}): FightFixture {
  const emitter = new EventEmitter()
  const carried = options.carried ?? {}
  const dropItemId = options.dropItem === undefined ? -1 : REGISTRY.itemsByName[options.dropItem]?.id ?? -1
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
    name: 'blaze',
    kind: 'hostile',
    height: 1.8,
    isValid: true,
    position: new P(options.mob.x, options.mob.y, options.mob.z),
  }
  const bot = emitter as EventEmitter & Record<string, any>
  let tickMs = 0
  Object.assign(bot, {
    registry: REGISTRY,
    health: 20,
    physicsEnabled: true,
    entity: { id: 1, position: new P(options.body.x, options.body.y, options.body.z), yaw: 0, pitch: 0, onGround: true, width: 0.6, height: 1.8 },
    entities: { 31: mob },
    game: { dimension: 'minecraft:the_nether' },
    inventory: {
      slots: [],
      items: () => [...items],
      count: (id: number) => items.filter((item) => item.type === id).reduce((sum, item) => sum + item.count, 0) + (id === dropItemId ? dropped : 0),
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
          if (dropItemId !== -1) dropped += 1
          delete (bot.entities as Record<number, unknown>)[mob.id]
          emitter.emit('entityDead', mob)
        }
      }, 3)
    },
    stopDigging: () => undefined,
    setControlState: () => undefined,
  })
  Object.defineProperty(bot, 'heldItem', { get: () => null, configurable: true })
  const started = Date.now()
  return {
    bot: bot as unknown as Bot,
    logger: new CapturingLogger(),
    attacks: () => swings,
    attacksOn: (entityId: number) => attacksByEntity.get(entityId) ?? 0,
    elapsedMs: () => (tickMs === 0 ? Date.now() - started : tickMs),
  }
}

function huntCandidate(entityId: number, distance: number, drop = 'blaze_rod'): Candidate {
  return {
    id: `ATTACK:e${entityId}`,
    kind: 'ATTACK',
    label: `hunt blaze ${distance}m away for ${drop}`,
    targetName: 'blaze',
    target: { x: 0, y: 66, z: 0 },
    targetEntityId: entityId,
    itemName: drop,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: { tick: 1, entityId, distance, goalDrop: drop, requiresKill: true, decisionEpoch: 3, worldEpoch: 1 },
  }
}

function runHunt(fixture: FightFixture, candidate: Candidate): Promise<Awaited<ReturnType<Executor['claim']>['completion']>> {
  const executor = new Executor(fixture.bot, fixture.logger, {
    ...defaultExecutorOptions,
    goalItem: 'blaze_rod',
    verifyTimeoutMs: 300,
    pickupPathTimeoutMs: 300,
    huntReacquireMs: 250,
  })
  return fixtureClaim(executor, candidate).completion
}

let total = 0
let failures = 0
const report = (pass: boolean, name: string, detail: string): void => {
  total += 1
  if (!pass) failures += 1
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}\n`)
  process.stdout.write(`      ${detail}\n`)
}

const ATTACK = (entityId: number, distance: number, gapY: number): Record<string, unknown> =>
  producer(entityId, { x: 0, y: 60 + gapY, z: 0 }, { x: 0, y: 60, z: 0 })
const BODY = { x: 0.5, y: 60, z: 0.5 }
const FLAT = { x: 2.5, y: 60, z: 0.5 }

// ===========================================================================
// (i) a hovering producer WITH a grounded vertical route: the reposition is
//     offered with its mechanical facts, and at that level the ATTACK lands
//     swings.
// ===========================================================================
{
  const hovering = generateGroundedCandidates(
    world({ body: BODY, entities: [ATTACK(94, 6, 6)], carried: { cobblestone: 64 } }),
    optionsWithProbe('reachable'),
  )
  const attack = hovering.candidates.find((candidate) => candidate.targetEntityId === 94)
  const withheld = hovering.withheld.find((entry) => entry.candidate.targetEntityId === 94)
  const reposition = hovering.candidates.find((candidate) => candidate.meta.contactAscent === true)
  const pass =
    // CAN: no melee lease from below the target's level ...
    attack === undefined &&
    withheld?.result.reason === 'needs_ascend' &&
    withheld.result.missingCapabilities.some((capability) => capability.kind === 'ascend_plan') === true &&
    // ... and the grounded vertical route IS enumerated, as an ordinary MOVE.
    reposition !== undefined &&
    reposition.kind === 'MOVE' &&
    reposition.id.startsWith('ASCEND:contact:') &&
    reposition.meta.vertical === 'pillar' &&
    reposition.meta.pillarToY === 66 &&
    reposition.meta.pillarPlaceName === 'cobblestone' &&
    reposition.meta.contactEntityId === 94 &&
    reposition.meta.contactGapY === 6 &&
    reposition.meta.contactApproach === 'ascent_required' &&
    hovering.contactRefusals.length === 0
  report(
    pass,
    '(i) a producer above the walk envelope with a grounded vertical route gets the reposition offer, never a 0-swing melee lease',
    `attack=${attack?.id ?? 'none'} withheld=${withheld?.result.reason ?? 'none'} reposition=${reposition?.id ?? 'none'} ` +
      `vertical=${String(reposition?.meta.vertical ?? 'none')} toY=${String(reposition?.meta.pillarToY ?? 'none')} ` +
      `place=${String(reposition?.meta.pillarPlaceName ?? 'none')} gapY=${String(reposition?.meta.contactGapY ?? 'none')} refusals=${hovering.contactRefusals.length}`,
  )
}

{
  // ... and once the body is at that level the SAME producer is melee-able: the
  // ATTACK is offered, leased, and LANDS SWINGS (the real Executor, fake bot).
  const atLevel = generateGroundedCandidates(
    world({ body: BODY, entities: [ATTACK(31, 2, 0)], carried: { cobblestone: 64 } }),
    optionsWithProbe('reachable'),
  )
  const offered = atLevel.candidates.find((candidate) => candidate.targetEntityId === 31)
  const fixture = makeFight({ body: BODY, mob: FLAT, hitsToKill: 2, dropItem: 'blaze_rod' })
  const result = await runHunt(fixture, huntCandidate(31, 2))
  const pass =
    offered?.id === 'ATTACK:e31' &&
    offered.meta.contactApproach === undefined &&
    result.status === 'done' &&
    result.combatOutcome === 'KILL_VERIFIED' &&
    fixture.attacksOn(31) >= 2 &&
    fixture.logger.containing('HUNT_END reason=killed').length === 1
  report(
    pass,
    '(i2) at the target level the ATTACK is offered and the lease lands its swings (killed)',
    `offered=${offered?.id ?? 'none'} status=${result.status} outcome=${String(result.combatOutcome)} swings=${fixture.attacks()} ` +
      `huntEnd=${fixture.logger.containing('HUNT_END').join(' | ') || 'none'}`,
  )
}

// ===========================================================================
// (ii) a hovering producer NO grounded remedy reaches: typed cannot-reach, and
//      NO lease is ever started for it.
// ===========================================================================
{
  const hovering = generateGroundedCandidates(
    world({ body: BODY, entities: [ATTACK(95, 6, 6)], carried: {} }),
    optionsWithProbe('reachable'),
  )
  const attack = hovering.candidates.find((candidate) => candidate.targetEntityId === 95)
  const withheld = hovering.withheld.find((entry) => entry.candidate.targetEntityId === 95)
  const first = hovering.contactRefusals[0]
  if (first === undefined) throw new Error('fixture (ii) produced no contact refusal')
  const refusal = first
  const line =
    refusal === undefined
      ? 'none'
      : formatContactUnreachable({
          actionId: `ATTACK:e${refusal.entityId}`,
          entityId: refusal.entityId,
          targetName: refusal.targetName,
          evidence: 'vertical_gap',
          approach: refusal.approach,
          distance: refusal.distance,
          gapY: refusal.gapY,
          meleeReach: 3.2,
          walkGap: 3.2,
          ascentRefusal: refusal.reason,
          placeable: refusal.placeable,
        })
  const pass =
    // the decisive fact: no ATTACK candidate exists, so no lease can start and the
    // run cannot record a 0-swing attempt that only LOOKS like one.
    attack === undefined &&
    withheld?.result.reason === 'needs_ascend' &&
    withheld.result.missingCapabilities.some((capability) => capability.kind === 'ascend_plan') === true &&
    hovering.contactRefusals.length === 1 &&
    refusal.reason === 'no_placeable' &&
    refusal.entityId === 95 &&
    refusal.gapY === 6 &&
    refusal.approach === 'no_grounded_remedy' &&
    refusal.placeable === null &&
    line.startsWith(`${HUNT_CONTACT_UNREACHABLE} actionId=ATTACK:e95 entity=e95 target=blaze evidence=vertical_gap approach=no_grounded_remedy`) &&
    line.includes('ascent_refusal=no_placeable placeable=none')
  report(
    pass,
    '(ii) a producer no grounded remedy reaches is a typed cannot-reach refusal, never a 0-swing lease',
    `attack=${attack?.id ?? 'none'} withheld=${withheld?.result.reason ?? 'none'} refusals=${hovering.contactRefusals.length} reason=${refusal?.reason ?? 'none'}\n      | ${line}`,
  )
}

// ===========================================================================
// (iii) a target inside the melee envelope is UNCHANGED.
// ===========================================================================
{
  const contact = generateGroundedCandidates(
    world({ body: BODY, entities: [ATTACK(96, 2, 0)], carried: {} }),
    optionsWithProbe('no_path'),
  )
  const offered = contact.candidates.find((candidate) => candidate.targetEntityId === 96)
  // A 3-block vertical component is still melee-able: the 3-D distance is at least
  // the gap, and 3 <= the melee envelope, so a walk that stands the body under the
  // target swings. Only gapY > meleeReach is provably out of reach.
  const ledge = generateGroundedCandidates(
    world({ body: BODY, entities: [ATTACK(97, 3, 3)], carried: {} }),
    optionsWithProbe('no_path'),
  )
  const ledgeOffered = ledge.candidates.find((candidate) => candidate.targetEntityId === 97)
  const pass =
    offered?.id === 'ATTACK:e96' &&
    offered.inReach === true &&
    contact.contactRefusals.length === 0 &&
    contact.withheld.length === 0 &&
    ledgeOffered?.id === 'ATTACK:e97' &&
    ledge.contactRefusals.length === 0
  report(
    pass,
    '(iii) a target in melee contact (and a 3-block ledge target) keeps the existing ATTACK, withheld by nothing',
    `contact=${offered?.id ?? 'none'} inReach=${String(offered?.inReach ?? 'none')} refusals=${contact.contactRefusals.length} ` +
      `withheld=${contact.withheld.length} ledge=${ledgeOffered?.id ?? 'none'} ledgeRefusals=${ledge.contactRefusals.length}`,
  )
}

// ===========================================================================
// (iv) the new capability's own mechanical facts.
// ===========================================================================
{
  const classify = (facts: Partial<ContactGeometryFacts>): string =>
    classifyContactApproach({ distance: 10, meleeReach: 3.2, gapY: 0, walkGap: 3.2, ascentRefused: false, ...facts })
  const table = [
    classify({ distance: 2 }),
    classify({ gapY: 3 }),
    classify({ gapY: 4 }),
    classify({ gapY: 4, ascentRefused: true }),
    classify({ gapY: 34, ascentRefused: true }),
    classify({ distance: 21.32, gapY: -1 }),
  ]
  const pass =
    table[0] === 'contact' &&
    table[1] === 'walk' &&
    table[2] === 'ascent_required' &&
    table[3] === 'no_grounded_remedy' &&
    table[4] === 'no_grounded_remedy' &&
    // the closest live sample: 21.32 m away, ONE block BELOW the body -> the gap
    // alone does not refuse it, so the distance/probe rule still owns that case.
    table[5] === 'walk' &&
    contactGapY(60.52, 59) === -1 &&
    contactGapY(57, 60.44) === 3 &&
    contactGapY(57, 66) === 9
  report(
    pass,
    '(iv) the contact verdict is pure and total over the gap: contact / walk / ascent_required / no_grounded_remedy',
    `table=[${table.join(',')}] gapY(60.52->59)=${contactGapY(60.52, 59)} gapY(57->60.44)=${contactGapY(57, 60.44)} gapY(57->66)=${contactGapY(57, 66)}`,
  )
}

{
  const unreachable = classifyCombatOutcome({
    entityDefeated: false,
    tracked: true,
    reacquireExhausted: false,
    invalidated: false,
    interrupted: false,
    unreachable: true,
    hits: 0,
  })
  const line = formatCombatOutcome({
    outcome: 'TARGET_UNREACHABLE',
    actionId: 'ATTACK:e22623',
    entityId: 22623,
    targetName: 'blaze',
    swings: 0,
    hits: 0,
    reacquires: 0,
    lastKnown: { x: 54.5, y: 66, z: -50.5 },
    ms: 120,
    goalDrop: 'blaze_rod',
  })
  const pass =
    unreachable === 'TARGET_UNREACHABLE' &&
    combatFailureCode('TARGET_UNREACHABLE') === 'target_unreachable' &&
    line.startsWith('COMBAT_OUTCOME outcome=TARGET_UNREACHABLE actionId=ATTACK:e22623 entity=e22623 target=blaze for=blaze_rod') &&
    line.includes('swings=0 hits=0') &&
    line.includes('kill=unproven reason=no_grounded_remedy_reaches_melee_contact')
  report(
    pass,
    '(iv2) §9 gains the missing outcome: a tracked, alive target no remedy reaches is TARGET_UNREACHABLE, not a timeout',
    `outcome=${unreachable} failureCode=${String(combatFailureCode('TARGET_UNREACHABLE'))}\n      | ${line}`,
  )
}

{
  // The executor's own proof: a producer 6 blocks ABOVE the body with nothing to
  // pillar with. The lease must end on the FIRST geometry observation with the
  // typed reason - not after burning the full hunt lease and reporting
  // `out_of_range swings=0` (measured: ms=10043..10100, 13 of 17 live hunts).
  const fixture = makeFight({ body: BODY, mob: { x: 0.5, y: 66, z: 0.5 }, carried: {}, hitsToKill: 2 })
  const result = await runHunt(fixture, huntCandidate(31, 5.83))
  const unreachableLines = fixture.logger.containing(HUNT_CONTACT_UNREACHABLE)
  const huntEnd = fixture.logger.containing('HUNT_END')
  const unreachableLine = unreachableLines[0] ?? 'none'
  const huntEndLine = huntEnd[0] ?? 'none'
  const pass =
    fixture.attacks() === 0 &&
    unreachableLines.length === 1 &&
    unreachableLine.includes('evidence=vertical_gap') &&
    unreachableLine.includes('approach=no_grounded_remedy') &&
    unreachableLine.includes('gap_y=6') &&
    unreachableLine.includes('ascent_refusal=no_placeable placeable=none') &&
    huntEnd.length === 1 &&
    huntEndLine.startsWith('HUNT_END reason=unreachable actionId=ATTACK:e31 target=blaze for=blaze_rod swings=0 hits=0') &&
    result.status === 'failed' &&
    result.combatOutcome === 'TARGET_UNREACHABLE' &&
    result.entityDefeated === false
  report(
    pass,
    '(iv3) the lease PROVES it cannot reach: typed HUNT_END reason=unreachable on the first observation, swings=0',
    `status=${result.status} outcome=${String(result.combatOutcome)} swings=${fixture.attacks()}\n      | ${unreachableLines[0] ?? 'no line'}\n      | ${huntEnd[0] ?? 'no HUNT_END'}`,
  )
}

// ===========================================================================
// (v) no code ranking between attack and reposition: both offered, Jev chooses.
// ===========================================================================
{
  const both = generateGroundedCandidates(
    world({
      body: BODY,
      // a producer INSIDE the melee envelope (the ATTACK is executable now) ...
      entities: [ATTACK(98, 2, 0), ATTACK(99, 6, 6)],
      // ... and a hovering one whose vertical remedy exists.
      carried: { cobblestone: 64 },
    }),
    optionsWithProbe('reachable'),
  )
  const melee = both.candidates.find((candidate) => candidate.targetEntityId === 98)
  const reposition = both.candidates.find((candidate) => candidate.meta.contactAscent === true)
  const hoveringWithheld = both.withheld.find((entry) => entry.candidate.targetEntityId === 99)
  const ids = both.candidates.map((candidate) => candidate.id)
  const pass =
    // BOTH are on offer in the SAME decision: the reposition never suppresses the
    // executable fight, and the executable fight never suppresses the remedy.
    melee?.id === 'ATTACK:e98' &&
    reposition !== undefined &&
    ids.includes('ATTACK:e98') &&
    ids.some((id) => id.startsWith('ASCEND:contact:')) &&
    // ONE offer for the level, not one per entity: N identical pillars would bias
    // the choice with duplicates rather than a ranking.
    both.candidates.filter((candidate) => candidate.meta.contactAscent === true).length === 1 &&
    // the hovering producer's ATTACK is withheld for a MECHANICAL reason only.
    hoveringWithheld?.result.reason === 'needs_ascend' &&
    both.contactRefusals.length === 0
  report(
    pass,
    '(v) the ATTACK and the reposition are both offered for the same tick; code ranks neither',
    `offered=[${ids.join(',')}] melee=${melee?.id ?? 'none'} reposition=${reposition?.id ?? 'none'} ` +
      `hoverWithheld=${hoveringWithheld?.result.reason ?? 'none'} refusals=${both.contactRefusals.length}`,
  )
}

{
  // The same non-ranking fact at the executor evidence layer: the two vocabulary
  // lines are disjoint, so neither a kill nor an unreachable target can ever be
  // read as the other.
  const killed = formatHuntEnd({
    actionId: 'ATTACK:e31',
    targetName: 'blaze',
    goalDrop: 'blaze_rod',
    reason: 'killed',
    swings: 3,
    hits: 3,
    reacquired: 0,
    lastKnown: { x: 1, y: 64, z: 0 },
    ms: 900,
  })
  const unreachable = formatHuntEnd({
    actionId: 'ATTACK:e31',
    targetName: 'blaze',
    goalDrop: 'blaze_rod',
    reason: 'unreachable',
    swings: 0,
    hits: 0,
    reacquired: 0,
    lastKnown: { x: 1, y: 64, z: 0 },
    ms: 120,
  })
  const pass =
    killed.startsWith('HUNT_END reason=killed actionId=ATTACK:e31 target=blaze for=blaze_rod swings=3 hits=3') &&
    unreachable.startsWith('HUNT_END reason=unreachable actionId=ATTACK:e31 target=blaze for=blaze_rod swings=0 hits=0') &&
    killed !== unreachable
  report(pass, '(v2) the hunt reason vocabulary separates a landed kill from an unreachable target', `${killed}\n      | ${unreachable}`)
}

{
  // The vocabulary's honest BOUNDARY. `unreachable` is reserved for the PROVEN
  // geometry; a producer at the body's own level that the bounded lease simply
  // never walked to keeps the pinned `out_of_range` meaning ("stayed tracked but
  // never entered melee range inside the lease"). This is the guard against
  // over-claiming: a stall is an observation about progress, not a proof that no
  // route exists, and `test-pearl-route.mts` (b4) pins that distinction.
  //
  // Measured: 8 of the 17 live blaze hunts started at lease gapY <= 3 (0,0,1,1,1,2,3,3)
  // with 21.32-47.64 m of HORIZONTAL separation and `lineOfSight=false` in 221/221
  // samples. Those are a route/closure problem for the travel family, not a contact
  // vocabulary problem, and they must NOT be relabelled here.
  const stalled = makeFight({ body: BODY, mob: { x: 0.5, y: 61, z: 30.5 }, carried: {}, hitsToKill: 2 })
  const result = await runHunt(stalled, huntCandidate(31, 30.5))
  const huntEndLine = stalled.logger.containing('HUNT_END')[0] ?? 'none'
  const pass =
    // gapY=1 -> the geometry proof cannot fire, so no HUNT_CONTACT_UNREACHABLE and
    // no `unreachable` claim; the typed `out_of_range` semantic is preserved.
    stalled.logger.containing(HUNT_CONTACT_UNREACHABLE).length === 0 &&
    result.combatOutcome !== 'TARGET_UNREACHABLE' &&
    huntEndLine.startsWith('HUNT_END reason=out_of_range actionId=ATTACK:e31 target=blaze for=blaze_rod swings=0 hits=0') &&
    stalled.attacks() === 0
  report(
    pass,
    '(vi) a same-level producer the lease never walked to keeps the pinned out_of_range meaning, not an over-claimed unreachable',
    `status=${result.status} outcome=${String(result.combatOutcome)} swings=${stalled.attacks()}\n      | ${huntEndLine}`,
  )
}

{
  // MIRRORED, not merely emitted. A typed reason that only reaches the generation
  // console is not run-scoped evidence: the measured route-family incident was a
  // recorder line whose marker was absent from MIRRORED_MARKERS, so the resident
  // log showed zero of them. Both halves of the new vocabulary must survive the
  // mirror gate.
  const unreachableLine = formatContactUnreachable({
    actionId: 'ATTACK:e22623',
    entityId: 22623,
    targetName: 'blaze',
    evidence: 'vertical_gap',
    approach: 'no_grounded_remedy',
    distance: 45.25,
    gapY: 9,
    horizontal: 44.12,
    meleeReach: 3.1,
    walkGap: 3.1,
    ascentRefusal: 'no_placeable',
    placeable: null,
  })
  const huntEndLine = formatHuntEnd({
    actionId: 'ATTACK:e22623',
    targetName: 'blaze',
    goalDrop: 'blaze_rod',
    reason: 'unreachable',
    swings: 0,
    hits: 0,
    reacquired: 0,
    lastKnown: { x: 54.5, y: 66, z: -50.5 },
    ms: 0,
  })
  const pass =
    mirroredEventToken(unreachableLine) === 'HUNT_CONTACT_UNREACHABLE' &&
    mirroredEventToken(huntEndLine) === 'HUNT_END' &&
    // the measured live line shape is reproduced: the 9 hunts that started at
    // lease gapY >= 4 are exactly the ones this names.
    unreachableLine.includes('distance=45.25 horizontal=44.12 gap_y=9') &&
    unreachableLine.includes('evidence=vertical_gap')
  report(
    pass,
    '(vii) both halves of the new vocabulary are MIRRORED run-scoped evidence, not console-only lines',
    `unreachableToken=${String(mirroredEventToken(unreachableLine))} huntEndToken=${String(mirroredEventToken(huntEndLine))}\n      | ${unreachableLine}`,
  )
}

process.stdout.write(`${'-'.repeat(96)}\n`)
process.stdout.write(`${total - failures}/${total} hunt-contact cases passed\n`)
if (failures > 0) process.exit(1)
