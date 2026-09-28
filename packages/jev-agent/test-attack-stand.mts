// test-attack-stand.mts - THE STANCE: a swing only from a position that can land it.
//
// MEASURED FAILURE this file pins (operator screenshot + the same window's log,
// Nether tunnel): a magma cube EMBEDDED IN THE WALL beside/below the body, and
//
//   SKILL_END actionId=ATTACK:e85793 ... outcome=MECHANICALLY_BLOCKED failure=verify_failed   (x2)
//   SKILL_END actionId=ATTACK:e85793 ... outcome=MECHANICALLY_BLOCKED failure=out_of_reach
//
// plus the same class on endermen earlier: `pathfinder goal WAS set 5x, distance
// froze at 6.11 m for ~47 s, ZERO swings`.
//
// The reachability gate was PRESENT and working (`CANDIDATE_WITHHELD
// candidate=ATTACK:e103761 kind=ATTACK reachable=false reason=no_path`), and it
// was not enough, because it answered the wrong question: "can the body path to
// within 2.9 m of the entity's feet" is not "is there a cell the body can stand
// on, legally, from which the entity is inside the melee envelope AND visible".
//
// The fixtures below hold the boundaries the fix must keep apart:
//
//   (i)   the screenshot shape - a hostile in contact but occluded/inside blocks
//         -> the ATTACK is WITHHELD with the typed `no_attack_stand` reason and a
//         mirrored `NO_ATTACK_STAND` line naming the entity, the melee constant,
//         the nearest stance and why it failed; the body's other grounded work
//         stays offered
//   (ii)  a hostile genuinely adjacent and visible -> the ATTACK is offered AND
//         the executor lands it (the operator-praised "attacks as soon as you get
//         close")
//   (iii) the enderman shape - entity sensed inside the walk budget, stances exist
//         but none is reachable -> withheld typed, NOT a 47-second zero-swing lease
//   (iv)  ordinary same-level combat is byte-identical when no stance probe is
//         wired (the pre-existing gate, reason for reason)
//   (v)   the reach constant is the executor's own swing bound, used as-is
//
//   bun test-attack-stand.mts
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import { Executor, MELEE_ATTACK_RANGE, defaultExecutorOptions } from './src/executor.ts'
import { EventLogger } from './src/jev.ts'
import type { AgentLevel } from './src/jev/client.ts'
import type { AttackStandFact, AttackStandWorld } from './src/combatClosure.ts'
import {
  MELEE_ATTACK_REACH,
  NO_ATTACK_STAND,
  formatNoAttackStand,
  selectAttackStand,
  stanceMeleeDistance,
} from './src/combatClosure.ts'
import type { Candidate, CandidateOptions, ReachabilityGateOptions } from './src/candidates.ts'
import { defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import type { WorldState } from './src/state.ts'
import { mirroredEventToken } from './src/controller.ts'
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
}

// ---------------------------------------------------------------------------
// A synthetic block world, read the way the LIVE probe reads the real one: the
// same three questions (`standable` / `hazard` / `visible`) answered from block
// truth, and the same `selectAttackStand` search the controller wires. Nothing
// here re-implements the gate; the fixture only supplies the world.
// ---------------------------------------------------------------------------

/**
 * A world of named SOLID cells over air. `hazards` marks cells whose block is a
 * hazard, and the body/stance standability rule is the sensor's own: feet and
 * head clear, solid support below.
 */
function blockWorld(input: {
  solid: ReadonlySet<string>
  hazards?: ReadonlySet<string>
}): {
  solid: (x: number, y: number, z: number) => boolean
  standable: (x: number, y: number, z: number) => boolean
  hazard: (x: number, y: number, z: number) => boolean
  /** the eye ray, blocked by ANY solid cell it passes through */
  visibleFrom: (x: number, y: number, z: number, aim: { x: number; y: number; z: number }) => boolean
} {
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`
  const solid = (x: number, y: number, z: number): boolean => input.solid.has(key(x, y, z))
  const hazards = input.hazards ?? new Set<string>()
  return {
    solid,
    standable: (x, y, z) => !solid(x, y, z) && !solid(x, y + 1, z) && solid(x, y - 1, z),
    hazard: (x, y, z) => hazards.has(key(x, y, z)) || hazards.has(key(x, y + 1, z)) || hazards.has(key(x, y - 1, z)),
    // The cover logic's own ray: step the segment and stop at the first solid
    // cell. Coarse (block resolution), which is exactly what `world.raycast`
    // answers for the live probe.
    visibleFrom: (x, y, z, aim) => {
      const eye = { x: x + 0.5, y: y + 1.62, z: z + 0.5 }
      const dx = aim.x - eye.x
      const dy = aim.y - eye.y
      const dz = aim.z - eye.z
      const range = Math.hypot(dx, dy, dz)
      if (!Number.isFinite(range) || range <= 0) return true
      const steps = Math.ceil(range * 8)
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps
        const cx = Math.floor(eye.x + dx * t)
        const cy = Math.floor(eye.y + dy * t)
        const cz = Math.floor(eye.z + dz * t)
        const insideEntityCell = cx === Math.floor(aim.x) && cy === Math.floor(aim.y) && cz === Math.floor(aim.z)
        if (insideEntityCell) return true
        if (solid(cx, cy, cz)) return false
      }
      return true
    },
  }
}

/** The stance search the controller runs, wired to a synthetic world. */
function stanceProbeFor(
  world: ReturnType<typeof blockWorld>,
  body: { x: number; y: number; z: number },
  height = 1.8,
): (query: { entityId: number; position: { x: number; y: number; z: number } }) => AttackStandFact | null {
  return (query) =>
    selectAttackStand({
      entity: { position: query.position, height },
      feet: body,
      reach: MELEE_ATTACK_REACH,
      world: {
        standable: world.standable,
        hazard: world.hazard,
        visible: (x, y, z) =>
          world.visibleFrom(x, y, z, {
            x: query.position.x,
            y: query.position.y + height / 2,
            z: query.position.z,
          }),
      },
    })
}

// ---------------------------------------------------------------------------
// World fixture for the candidate gate.
// ---------------------------------------------------------------------------

const BODY = { x: 0.5, y: 34, z: 0.5 }

/**
 * The body in a Nether tunnel with one sensed hostile at `mob` and the block
 * world `world`. `goal` is the collect goal the producer route needs (a hunt), or
 * null for an ordinary hostile reaction.
 */
function tunnel(input: {
  mob: { id: number; name: string; position: { x: number; y: number; z: number }; hostile?: boolean }
  world: ReturnType<typeof blockWorld>
  goalItem?: string
  body?: { x: number; y: number; z: number }
  carried?: Record<string, number>
  /** the cells the sensor reports the body can stand on (defaults to the body's own) */
  standable?: Array<{ x: number; y: number; z: number }>
}): WorldState {
  const body = input.body ?? BODY
  const goal = {
    id: `g1:collect:${input.goalItem ?? 'none'}`,
    kind: 'collect',
    description: `collect 7 x ${input.goalItem ?? 'none'}`,
    targetItem: input.goalItem ?? 'cobblestone',
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
  const entity = {
    id: input.mob.id,
    name: input.mob.name,
    kind: 'hostile',
    username: null,
    position: input.mob.position,
    distance:
      Math.round(
        Math.hypot(
          input.mob.position.x - body.x,
          input.mob.position.y - body.y,
          input.mob.position.z - body.z,
        ) * 100,
      ) / 100,
    hostile: input.mob.hostile ?? true,
    lineOfSight: input.world.visibleFrom(
      Math.floor(body.x),
      Math.floor(body.y),
      Math.floor(body.z),
      { x: input.mob.position.x, y: input.mob.position.y + 0.9, z: input.mob.position.z },
    ),
  }
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: {
      position: body,
      eyePosition: { x: body.x, y: body.y + 1.62, z: body.z },
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
      heldItem: { name: 'iron_sword', count: 1, slot: 36 },
      armor: { head: null, torso: null, legs: null, feet: null },
      effects: [],
    },
    inventory: {
      slots: [],
      counts: { iron_sword: 1, ...carried },
      totalItems: 1 + Object.values(carried).reduce((sum, count) => sum + count, 0),
    },
    entities: [entity],
    blocks: [],
    // The body's own feet cell, as the real scanner always reports it.
    terrain: {
      standable: input.standable ?? [{ x: Math.floor(body.x), y: Math.floor(body.y), z: Math.floor(body.z) }],
    },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: { targetItem: input.goalItem ?? 'cobblestone', requiredCount: 7, haveCount: 0 } as never,
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

function gateOptions(input: {
  stance?: ((query: { entityId: number; position: { x: number; y: number; z: number } }) => AttackStandFact | null) | null
  probe?: 'reachable' | 'no_path' | null
}): CandidateOptions {
  const reachability: ReachabilityGateOptions = {
    memory: null,
    pathProbe: input.probe === undefined || input.probe === null ? null : () => input.probe as 'reachable' | 'no_path',
    attackPathProbe:
      input.probe === undefined || input.probe === null ? null : () => input.probe as 'reachable' | 'no_path',
    stationApproach: null,
    digApproach: null,
    attackStandProbe: input.stance ?? null,
  }
  return { ...defaultCandidateOptions, reachability } as unknown as CandidateOptions
}

let total = 0
let failures = 0
const report = (pass: boolean, name: string, detail: string): void => {
  total += 1
  if (!pass) failures += 1
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}\n`)
  process.stdout.write(`      ${detail}\n`)
}

// ===========================================================================
// (i) THE SCREENSHOT SHAPE: a magma cube embedded in the wall beside the body.
//     In contact, occluded from every stance -> WITHHELD, typed, mirrored.
// ===========================================================================
const MAGMA = { id: 85793, name: 'magma_cube', position: { x: 2.5, y: 34, z: 0.5 } }
{
  // The tunnel floor the body stands on, the wall between it and the mob, and -
  // the screenshot fact - the mob's OWN cell is solid rock: the entity is inside
  // the wall, so no stance's eye ray can reach its body. The corridor behind the
  // body is open, so the tick still has real work and a real retreat to offer.
  const world = blockWorld({
    solid: new Set([
      '-3,33,0', '-2,33,0', '-1,33,0', '0,33,0', '1,33,0', '2,33,0', '3,33,0',
      // the entity's own 1x2 column: the mob is embedded in it
      '2,34,0', '2,35,0',
      // the tunnel walls
      '1,34,1', '1,35,1', '2,34,1', '2,35,1',
      '1,34,-1', '1,35,-1', '2,34,-1', '2,35,-1',
      '3,34,0', '3,35,0', '3,34,1', '3,35,1', '3,34,-1', '3,35,-1',
    ]),
  })
  const state = tunnel({
    mob: MAGMA,
    world,
    standable: [
      { x: 0, y: 34, z: 0 },
      { x: -1, y: 34, z: 0 },
      { x: -2, y: 34, z: 0 },
      { x: -1, y: 34, z: 1 },
      { x: -1, y: 34, z: -1 },
      { x: 0, y: 34, z: 1 },
      { x: 0, y: 34, z: -1 },
    ],
  })
  const grounded = generateGroundedCandidates(state, gateOptions({ stance: stanceProbeFor(world, BODY) }))
  const attack = grounded.candidates.find((candidate) => candidate.kind === 'ATTACK')
  const withheld = grounded.withheld.find((entry) => entry.candidate.kind === 'ATTACK')
  const evidence = withheld?.candidate.attackStandRefusal
  const line = evidence === undefined ? '' : formatNoAttackStand(evidence)
  const pass =
    attack === undefined &&
    withheld?.result.reason === 'no_attack_stand' &&
    withheld.result.missingCapabilities.some((capability) => capability.kind === 'standable_approach') === true &&
    evidence?.refusal === 'no_line_of_sight' &&
    evidence?.entityId === MAGMA.id &&
    evidence?.reach === MELEE_ATTACK_REACH &&
    evidence?.nearest?.cell.z === 0 &&
    evidence?.nearest?.reason === 'occluded' &&
    line.startsWith(`${NO_ATTACK_STAND} actionId=ATTACK:e85793 entity=e85793 target=magma_cube`) &&
    line.includes(`reach=${MELEE_ATTACK_REACH}`) &&
    line.includes('reason=no_line_of_sight') &&
    line.includes('nearest_stand=0,34,0') &&
    line.includes('nearest_refusal=occluded') &&
    line.includes('stand=none') &&
    // the operator's exact complaint: the attempt must not be grounded at all
    grounded.candidates.every((candidate) => candidate.id !== `ATTACK:e${MAGMA.id}`)
  report(
    pass,
    '(i) a hostile in contact but embedded/occluded is WITHHELD: no_attack_stand, mirrored with the geometry',
    `reason=${withheld?.result.reason ?? 'none'} refusal=${evidence?.refusal ?? 'none'} nearest=${evidence?.nearest?.cell.x},${evidence?.nearest?.cell.y},${evidence?.nearest?.cell.z}:${evidence?.nearest?.reason ?? 'none'} line="${line}"`,
  )
  report(
    mirroredEventToken(line) === NO_ATTACK_STAND,
    '(i) the withhold is MIRRORED (run-scoped evidence), not a private candidate-layer line',
    `mirroredEventToken=${String(mirroredEventToken(line))}`,
  )
  // The alternatives the body actually has are still offered: the fight is gone,
  // the rest of the offer is not. The corridor behind the body gives a real
  // retreat route, and it survives the withhold.
  report(
    grounded.candidates.length > 0 &&
      grounded.candidates.some((candidate) => candidate.kind === 'RETREAT' || candidate.kind === 'MOVE') &&
      grounded.withheld.length === 1 &&
      grounded.withheld[0]?.candidate.id === `ATTACK:e${MAGMA.id}`,
    '(i) the body keeps the alternatives it has: the ATTACK and nothing else is withheld',
    `offered=[${grounded.candidates.map((candidate) => candidate.kind).join(',')}] withheld=[${grounded.withheld.map((entry) => entry.candidate.id).join(',')}]`,
  )
}

// ===========================================================================
// (ii) GENUINELY ADJACENT AND VISIBLE: the praised reaction is preserved - the
//      ATTACK is offered AND the executor lands it.
// ===========================================================================
{
  const ZOMBIE = { id: 4242, name: 'zombie', position: { x: 1.5, y: 34, z: 0.5 } }
  // Same tunnel, but the mob's own cell is open air: it is standing next to the
  // body in the tunnel, visible, inside melee reach.
  const world = blockWorld({
    solid: new Set([
      '0,33,0', '1,33,0', '2,33,0', '3,33,0',
      '1,34,1', '1,35,1', '2,34,1', '2,35,1',
      '1,34,-1', '1,35,-1', '2,34,-1', '2,35,-1',
      '0,34,1', '0,35,1', '0,34,-1', '0,35,-1',
      '2,34,0', '2,35,0',
    ]),
  })
  const state = tunnel({ mob: ZOMBIE, world })
  const grounded = generateGroundedCandidates(state, gateOptions({ stance: stanceProbeFor(world, BODY) }))
  const attack = grounded.candidates.find((candidate) => candidate.kind === 'ATTACK')
  const fact = stanceProbeFor(world, BODY)({ entityId: ZOMBIE.id, position: ZOMBIE.position })
  const offered =
    attack !== undefined &&
    attack.targetEntityId === ZOMBIE.id &&
    fact?.stand !== null &&
    fact?.onBody === true &&
    fact?.stand?.x === 0 &&
    fact?.stand?.y === 34 &&
    fact?.stand?.z === 0
  report(
    offered,
    '(ii) a hostile adjacent and visible is OFFERED (the operator-praised reaction)',
    `attack=${attack?.id ?? 'none'} stand=${fact?.stand?.x},${fact?.stand?.y},${fact?.stand?.z} onBody=${String(fact?.onBody)} distance=${String(fact?.standDistance)}`,
  )

  // ... and the executor LANDS it: the ATTACK lease swings and verifies.
  const emitter = new EventEmitter()
  let swings = 0
  let hits = 0
  const mob = {
    id: ZOMBIE.id,
    name: ZOMBIE.name,
    kind: 'hostile',
    height: 1.8,
    isValid: true,
    position: new P(ZOMBIE.position.x, ZOMBIE.position.y, ZOMBIE.position.z),
  }
  const bot = emitter as EventEmitter & Record<string, unknown>
  Object.assign(bot, {
    registry: REGISTRY,
    health: 20,
    physicsEnabled: true,
    entity: {
      id: 1,
      position: new P(BODY.x, BODY.y, BODY.z),
      yaw: 0,
      pitch: 0,
      onGround: true,
      width: 0.6,
      height: 1.8,
    },
    entities: { [ZOMBIE.id]: mob },
    game: { dimension: 'minecraft:the_nether' },
    inventory: { slots: [], items: () => [], count: () => 0 },
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
      if (entity.id !== ZOMBIE.id) return
      swings += 1
      hits += 1
      setTimeout(() => {
        emitter.emit('entityHurt', mob, (bot as unknown as { entity: unknown }).entity)
        if (hits >= 3) {
          delete (bot.entities as Record<number, unknown>)[ZOMBIE.id]
          emitter.emit('entityDead', mob)
        }
      }, 3)
    },
    stopDigging: () => undefined,
    setControlState: () => undefined,
  })
  Object.defineProperty(bot, 'heldItem', { get: () => ({ name: 'iron_sword', count: 1, slot: 36 }), configurable: true })
  const logger = new CapturingLogger()
  const executor = new Executor(bot as unknown as Bot, logger, {
    ...defaultExecutorOptions,
    goalItem: 'cobblestone',
    verifyTimeoutMs: 300,
    pickupPathTimeoutMs: 300,
  })
  const candidate = attack as Candidate
  const completion = await fixtureClaim(executor, candidate).completion
  const leaseLines = logger.lines.filter((entry) => entry.startsWith('ATTACK_LEASE'))
  report(
    completion.status === 'done' && completion.verified === true && swings > 0 && leaseLines.length > 0,
    '(ii) the executor LANDS the swing from that stance (verified), so the offered ATTACK is real',
    `status=${completion.status} verified=${String(completion.verified)} swings=${swings} lease=${leaseLines[0] ?? 'none'}`,
  )
}

// ===========================================================================
// (iii) THE ENDERMAN SHAPE: the entity is sensed INSIDE the walk budget (6.11 m,
//       the measured distance) and stances exist, but none can be walked to ->
//       withheld typed, never a 47-second zero-swing lease.
// ===========================================================================
{
  const ENDERMAN = { id: 1758, name: 'enderman', position: { x: 6.11, y: 34, z: 0.5 } }
  const world = blockWorld({
    solid: new Set([
      '0,33,0', '1,33,0', '2,33,0', '3,33,0', '4,33,0', '5,33,0', '6,33,0', '7,33,0',
    ]),
  })
  // The statuses are separated by the route verdict, which is the enderman's own
  // fact: a stance exists and is visible, but every route to it is `no_path`.
  const state = tunnel({ mob: ENDERMAN, world, goalItem: 'ender_pearl' })
  const reachable = generateGroundedCandidates(
    state,
    gateOptions({ stance: stanceProbeFor(world, BODY), probe: 'reachable' }),
  )
  const withheldRun = generateGroundedCandidates(
    state,
    gateOptions({ stance: stanceProbeFor(world, BODY), probe: 'no_path' }),
  )
  const hunt = reachable.candidates.find((candidate) => candidate.kind === 'ATTACK')
  const withheld = withheldRun.withheld.find((entry) => entry.candidate.kind === 'ATTACK')
  const withheldReason: string = withheld?.result.reason ?? 'none'
  const evidence = withheld?.candidate.attackStandRefusal
  const line = evidence === undefined ? '' : formatNoAttackStand(evidence)
  const pass =
    // inside the hunt's own walking budget (<= 24) this is NOT a budget refusal
    ENDERMAN.position.x <= 24 &&
    hunt !== undefined &&
    hunt.meta.goalDrop === 'ender_pearl' &&
    withheldReason === 'no_attack_stand' &&
    evidence?.refusal === 'no_reachable_stand' &&
    evidence?.stand !== null &&
    evidence.path === 'no_path' &&
    line.includes('reason=no_reachable_stand') &&
    line.includes('path=no_path') &&
    // NOTHING to lease: the zero-swing attempt cannot be started
    withheldRun.candidates.every((candidate) => candidate.id !== `ATTACK:e${ENDERMAN.id}`)
  report(
    pass,
    '(iii) the enderman shape inside the walk budget is WITHHELD typed: no reachable stance, no lease',
    `offered_when_reachable=${hunt?.id ?? 'none'} reason=${withheldReason} refusal=${evidence?.refusal ?? 'none'} stand=${evidence?.stand?.x},${evidence?.stand?.y},${evidence?.stand?.z} path=${evidence?.path ?? 'none'}`,
  )
}

// ===========================================================================
// (iv) ORDINARY SAME-LEVEL COMBAT IS UNCHANGED when no stance probe is wired:
//      the pre-existing gate, verdict for verdict.
// ===========================================================================
{
  const ZOMBIE = { id: 777, name: 'zombie', position: { x: 4, y: 34, z: 0.5 } }
  const world = blockWorld({ solid: new Set(['0,33,0', '1,33,0', '2,33,0', '3,33,0', '4,33,0']) })
  const noProbe = tunnel({ mob: ZOMBIE, world })
  const contact = generateGroundedCandidates(noProbe, gateOptions({ probe: 'reachable' }))
  const blocked = generateGroundedCandidates(noProbe, gateOptions({ probe: 'no_path' }))
  const unknown = generateGroundedCandidates(noProbe, gateOptions({ probe: null }))
  const contactAttack = contact.candidates.find((candidate) => candidate.kind === 'ATTACK')
  const blockedWithheld = blocked.withheld.find((entry) => entry.candidate.kind === 'ATTACK')
  const unknownAttack = unknown.candidates.find((candidate) => candidate.kind === 'ATTACK')
  const pass =
    // beyond contact with a route proof: reachable, exactly as before
    contactAttack !== undefined &&
    contactAttack.affordance?.reason === 'reachable' &&
    contactAttack.affordance?.feasible === true &&
    // beyond contact with `no_path`: the historical typed refusal, untouched
    blockedWithheld?.result.reason === 'no_path' &&
    blockedWithheld.result.missingCapabilities.length === 1 &&
    blockedWithheld.result.missingCapabilities[0]?.kind === 'open_path' &&
    // no probe at all: no verdict, no refusal (nothing is deleted on a missing fact)
    unknownAttack !== undefined &&
    unknown.withheld.every((entry) => entry.candidate.kind !== 'ATTACK') &&
    // and no candidate anywhere carries the new evidence field
    [...contact.candidates, ...blocked.candidates, ...unknown.candidates].every(
      (candidate) => candidate.attackStandRefusal === undefined,
    )
  report(
    pass,
    '(iv) ordinary same-level combat is byte-identical with no stance probe (no new refusal, no new field)',
    `contact=${contactAttack?.affordance?.reason ?? 'absent'} no_path=${blockedWithheld?.result.reason ?? 'none'} missing=[${(blockedWithheld?.result.missingCapabilities ?? []).map((capability) => capability.kind).join(',')}] unknown=${unknownAttack?.id ?? 'absent'}`,
  )
}

// ===========================================================================
// (v) THE REACH CONSTANT is the executor's own swing bound, used as-is, and the
//     stance boundary is the executor's own comparison.
// ===========================================================================
{
  const world = blockWorld({ solid: new Set(['0,33,0', '1,33,0', '2,33,0', '3,33,0']) })
  // A stance EXACTLY at the envelope is a swing the executor takes (`>` is its
  // refusal operator, so `<= 3.1` swings); one cell beyond it is not a stance.
  const aim = { x: 3.6, y: 34, z: 0.5 }
  const atEnvelope = selectAttackStand({
    entity: { position: aim, height: 1.8 },
    feet: BODY,
    reach: MELEE_ATTACK_REACH,
    world: {
      // only the body's own cell is a legal stance: 3.6 - 0.5 = 3.1 exactly
      standable: (x, y, z) => x === 0 && y === 34 && z === 0,
      hazard: () => false,
      visible: () => true,
    },
  })
  const beyondEnvelope = selectAttackStand({
    // The entity sits beyond the body's OWN envelope too (4.0 - 0.5 = 3.5 >
    // 3.1), so the contact rule cannot reach it, and the only standable cell
    // (7,34,0) is likewise outside the entity's envelope: 7.5 - 4.0 = 3.5.
    entity: { position: { x: 4.0, y: 34, z: 0.5 }, height: 1.8 },
    feet: BODY,
    reach: MELEE_ATTACK_REACH,
    world: {
      standable: (x, y, z) => x === 7 && y === 34 && z === 0,
      hazard: () => false,
      visible: () => true,
    },
  })
  // The entity's own 1x2 column is never offered as a place to hit it from, and
  // the nearest stance to the BODY wins.
  const ownColumn = selectAttackStand({
    entity: { position: { x: 2.5, y: 34, z: 0.5 }, height: 1.8 },
    feet: BODY,
    reach: MELEE_ATTACK_REACH,
    world: { standable: () => true, hazard: () => false, visible: () => true },
  })
  const pass =
    MELEE_ATTACK_REACH === MELEE_ATTACK_RANGE &&
    MELEE_ATTACK_REACH === 3.1 &&
    atEnvelope.stand !== null &&
    atEnvelope.stand.x === 0 &&
    atEnvelope.standDistance !== null &&
    Math.abs(atEnvelope.standDistance - MELEE_ATTACK_REACH) < 1e-6 &&
    atEnvelope.standDistance <= MELEE_ATTACK_REACH &&
    beyondEnvelope.stand === null &&
    beyondEnvelope.refusal === 'no_standable_cell' &&
    ownColumn.stand !== null &&
    ownColumn.stand.x === 0 &&
    ownColumn.stand.y === 34 &&
    ownColumn.stand.z === 0 &&
    ownColumn.onBody === true &&
    world.solid(0, 33, 0) === true
  report(
    pass,
    '(v) the reach constant is the executor swing bound, aliased (one number) and inclusive at the boundary',
    `MELEE_ATTACK_REACH=${MELEE_ATTACK_REACH} MELEE_ATTACK_RANGE=${MELEE_ATTACK_RANGE} atEnvelope=${String(atEnvelope.stand?.x)}@${String(atEnvelope.standDistance)} beyond=${beyondEnvelope.refusal ?? 'none'} ownColumn=${ownColumn.stand?.x},${ownColumn.stand?.y},${ownColumn.stand?.z} onBody=${String(ownColumn.onBody)}`,
  )
}

// ===========================================================================
// (v-b) THE PURE VERDICT TABLE: the three ways a stance search can fail, plus
//       the nearest-first order and the hazard rule.
// ===========================================================================
{
  const aim = { x: 2.5, y: 34, z: 0.5 }
  // The body's OWN cell is exempt from `standable` (contact rule, v-c): a body
  // physically at a position can swing from it even over an open floor. The
  // pure "no standable cell inside the envelope" refusal is still pinned by
  // `far` below, where the only legal cell is outside the envelope entirely.
  const noStand = selectAttackStand({
    entity: { position: aim, height: 1.8 },
    feet: BODY,
    reach: MELEE_ATTACK_REACH,
    world: { standable: () => false, hazard: () => false, visible: () => true },
  })
  const hazard = selectAttackStand({
    entity: { position: aim, height: 1.8 },
    feet: BODY,
    reach: MELEE_ATTACK_REACH,
    world: { standable: () => true, hazard: () => true, visible: () => true },
  })
  const occluded = selectAttackStand({
    entity: { position: aim, height: 1.8 },
    feet: BODY,
    reach: MELEE_ATTACK_REACH,
    world: { standable: () => true, hazard: () => false, visible: () => false },
  })
  const far = selectAttackStand({
    entity: { position: { x: 6.11, y: 34, z: 0.5 }, height: 1.8 },
    feet: BODY,
    reach: MELEE_ATTACK_REACH,
    // Only the body's own cell is a legal stance, and it is 6.11 m from the
    // entity: NOTHING inside the melee envelope is standable at all. This is the
    // "no stand within melee reach" half of the measured enderman shape, and it
    // is the geometric fact, independent of any route probe.
    world: {
      standable: (x, y, z) => x === 0 && y === 34 && z === 0,
      hazard: () => false,
      visible: () => true,
    },
  })
  const pass =
    noStand.stand !== null &&
    noStand.onBody === true &&
    hazard.stand === null &&
    hazard.refusal === 'hazardous_stand' &&
    occluded.stand === null &&
    occluded.refusal === 'no_line_of_sight' &&
    occluded.nearest?.reason === 'occluded' &&
    far.stand === null &&
    far.refusal === 'no_standable_cell' &&
    // the nearest cell inside the envelope is solid rock, which is the fact
    far.nearest?.reason === 'not_standable'
  report(
    pass,
    '(v-b) the pure stance verdict names WHICH fact refused it: no_standable_cell / hazardous_stand / no_line_of_sight',
    `noStand=${noStand.refusal ?? 'none'}/${String(noStand.nearest?.reason)} hazard=${hazard.refusal ?? 'none'} occluded=${occluded.refusal ?? 'none'}/${String(occluded.nearest?.reason)} far=${far.refusal ?? 'none'} nearest=${far.nearest === null ? 'none' : `${far.nearest.cell.x},${far.nearest.cell.y},${far.nearest.cell.z}:${far.nearest.reason}`}`,
  )
}

// ===========================================================================
// (v-c) THE CONTACT RULE: a body already inside the attacker's own cell needs
//       no stance at all. Measured p20 live (~22:50Z): zombie e1445 at
//       (1.7,64,28.7) vs body at (1.4,64,28.7) - same cell, contact range. The
//       entity-column skip excluded the ONLY stance the body occupied, the
//       open-floor descent made that column `not_standable`, the nearest legal
//       stand was `no_path`, and ATTACK was withheld while the body died at
//       hp 8 carrying a wooden_sword. `standable` is locomotion legality for a
//       cell the body would have to be placed on; it cannot refute the cell
//       the body physically occupies. Occlusion and hazard still refuse it.
// ===========================================================================
{
  const contact = selectAttackStand({
    entity: { position: { x: 1.7, y: 64, z: 28.7 }, height: 1.8 },
    feet: { x: 1.4, y: 64, z: 28.7 },
    reach: MELEE_ATTACK_REACH,
    // Nothing near the body is a legal stand (open floor under the descent):
    // the shared cell is feet-over-air, and every neighbour is the same.
    world: { standable: () => false, hazard: () => false, visible: () => true },
  })
  const occludedContact = selectAttackStand({
    entity: { position: { x: 1.7, y: 64, z: 28.7 }, height: 1.8 },
    feet: { x: 1.4, y: 64, z: 28.7 },
    reach: MELEE_ATTACK_REACH,
    // Same shape but no line of sight: the embedded-target protection still
    // applies - presence does not override geometry. Neighbour cells are legal
    // stands so the ONLY failing fact is the ray itself.
    world: { standable: () => true, hazard: () => false, visible: () => false },
  })
  const hazardContact = selectAttackStand({
    entity: { position: { x: 1.7, y: 64, z: 28.7 }, height: 1.8 },
    feet: { x: 1.4, y: 64, z: 28.7 },
    reach: MELEE_ATTACK_REACH,
    // And a hazardous own column still refuses (the escape arm owns burning).
    world: { standable: () => true, hazard: () => true, visible: () => true },
  })
  const pass =
    contact.stand !== null &&
    contact.onBody === true &&
    contact.stand.x === 1 &&
    contact.stand.y === 64 &&
    contact.stand.z === 28 &&
    occludedContact.stand === null &&
    occludedContact.refusal === 'no_line_of_sight' &&
    hazardContact.stand === null &&
    hazardContact.refusal === 'hazardous_stand'
  report(
    pass,
    '(v-c) a body sharing the attacker cell swings without a standable stance; occlusion/hazard still refuse',
    `contact=${contact.stand ? `${contact.stand.x},${contact.stand.y},${contact.stand.z} onBody=${contact.onBody}` : `null/${contact.refusal}`} occluded=${occludedContact.refusal ?? 'none'} hazard=${hazardContact.refusal ?? 'none'}`,
  )
}

process.stdout.write(`${total - failures}/${total} attack-stand cases passed\n`)
if (failures > 0) process.exit(1)
