// test-edge-fall-guard.mts - a locomotion leg must not step off an edge whose
// landing is a drop THIS body cannot survive.
//
// THE MEASURED DEATH (main 67388ac, live run): the body had climbed/pillared to
// y79 above the operator's floated Nether gate and laid bridges at that height,
// then
//
//   04:28:19 (26.3,79.0,-4.5) overworld -> 04:28:38 (-7.5,51.0,-5.5)  (28 blocks down)
//   04:28:38 DEATH pos=26.3,79.0,-4.5   (deaths 142 -> 143; keepInventory held the kit)
//   LADDER_INVENTORY_SETTLE reason=death readings=11 changed=false empty=false itemCount=27
//
// It fell off the structure it had built and died. On the operator's tightened
// acceptance (new seed/world, NO assists, `keepInventory` OFF) the same fall costs
// the whole kit.
//
// THE MISSING FACT (file:line, measured before this change):
//   * `src/stepLanding.ts:83-94` - `StepLandingVerdict` had `{reason, block,
//     support}` and NO depth: the scan at `:139-156` walked the column down to the
//     first block that stops the fall and returned its NAME, so a 1-block step
//     down and an 8-block drop onto the same stone produced the identical
//     `{reason: null}`. The drop was MEASURED and then thrown away.
//   * `src/stepLanding.ts:159` - `unsafe_landing` fires only when the WHOLE bounded
//     window is observed empty: a void refusal, never a damage decision.
//   * `src/executor.ts:2064` / `:792-793` - the only "how far may the body drop"
//     number in the repository was the PLANNER's `maxDropDown = 8`, a planning
//     bound, never a survival bound.
//   * `src/policy.ts:342-361`, `src/reachability.ts:439-450`, `criticalDamage.ts`,
//     `envHazard.ts` - no fall-damage model anywhere: grep for `fallDamage`,
//     `SAFE_FALL`, `fallDistance`, `dropHeight`, `survivable` across the repo is
//     EMPTY. A fall was never a typed outcome either; it became visible only as a
//     DEATH, whose cause vocabulary (`buddy-driver/agent-runner.mts:1172-1193`)
//     has no `fall` member.
//   * `src/executor.ts:10415 stockPathTo` (`setGoal`) - the UNGUARDED live-default
//     actuator: `pathTo` tries it FIRST and the guarded control walk is only the
//     fallback, so the primary MOVE/RETREAT/BRIDGE leg had no landing guard at all.
//
// Cases (charter):
//   (i)   THE MEASURED SHAPE: a body at full health on a high unsupported edge
//         walking toward a cell whose landing is a fatal drop -> the leg is
//         withheld TYPED (`fall_lethal`) naming the edge, the predicted drop, the
//         health and the fatal fact, the body does not step, and the alternatives
//         (retreat / bridge / deliberate descent) stay offered;
//   (ii)  the same walk where the drop IS survivable -> byte-identical;
//   (iii) a 1-block step down and an ordinary walk + 3-block drop -> byte-identical
//         (even at health 1: this guard must not make the body timid);
//   (iv)  a low-health body where a previously survivable drop is now fatal ->
//         withheld (the SAME grid, only the health changed);
//   (v)   the retreat and the bridge advance are covered by the same fact.
//
// Run: bun ./test-edge-fall-guard.mts
import { mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import type { Candidate } from './src/candidates.ts'
import { Executor, defaultExecutorOptions } from './src/executor.ts'
import { mirroredEventToken, moveFailureReason, MIRRORED_MARKERS } from './src/controller.ts'
import {
  armorFallMitigation,
  classifyStepLanding,
  fallDamageHp,
  fallSurvivability,
  formatMoveLegStopped,
  maxSurvivableDrop,
  MOVE_LEG_STOPPED,
  STEP_SUPPORT_NONE,
  STEP_SUPPORT_UNKNOWN,
} from './src/stepLanding.ts'
import type { StepLandingBlock, StepLandingReads } from './src/stepLanding.ts'
import { CRITICAL_DAMAGE_HEALTH } from './src/criticalDamage.ts'
import { EventLogger, JsonlWriter } from './src/jev.ts'
import type { Vec3Json } from './src/state.ts'
import { fixtureClaim } from './test-claim-context.mts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

// ---------------------------------------------------------------------------
// rule-level table: the pure classifier + the pure fall-damage facts
// ---------------------------------------------------------------------------
function block(name: string, boundingBox: string): StepLandingBlock {
  return { name, boundingBox }
}
const AIR = block('air', 'empty')
const STONE = block('stone', 'block')
const LEAVES = block('oak_leaves', 'block')
const LAVA = block('lava', 'empty')
const WATER = block('water', 'empty')
const HAY = block('hay_block', 'block')
/** `landing, head, below...` */
const window = (...cells: Array<StepLandingBlock | null>): StepLandingReads => ({
  landing: cells[0] ?? null,
  head: cells[1] ?? null,
  below: cells.slice(2),
})
/** `drop` blocks of air under the landing, then `floor`. */
const dropOnto = (drop: number, floor: StepLandingBlock = STONE): StepLandingReads =>
  window(AIR, AIR, ...Array.from({ length: drop }, () => AIR as StepLandingBlock | null), floor)
const armor = (material: string | null): Parameters<typeof armorFallMitigation>[0] => {
  if (material === null) return null
  if (material === 'turtle_helmet') return { head: piece('turtle_helmet'), torso: null, legs: null, feet: null }
  return {
    head: piece(`${material}_helmet`),
    torso: piece(`${material}_chestplate`),
    legs: piece(`${material}_leggings`),
    feet: piece(`${material}_boots`),
  }
}
function piece(name: string): { name: string; count: number; slot: number } {
  return { name, count: 1, slot: 5 }
}

{
  // --- the drop is now RECORDED (the fact that was missing) -----------------
  const flat = classifyStepLanding(window(AIR, AIR, STONE))
  check(
    '(rule) a flat step is a drop of 0: the floor is directly under the landing cell',
    flat.reason === null && flat.drop === 0 && flat.dropAtLeast === false && flat.support === 'stone',
    `reason=${flat.reason ?? 'none'} drop=${flat.drop} support=${flat.support}`,
  )
  const dip = classifyStepLanding(window(AIR, AIR, AIR, STONE))
  check(
    '(rule) a 1-block dip is a drop of 1, not merely "supported"',
    dip.reason === null && dip.drop === 1 && dip.dropAtLeast === false,
    `drop=${dip.drop} support=${dip.support}`,
  )
  const three = classifyStepLanding(dropOnto(3))
  const seven = classifyStepLanding(dropOnto(7))
  const measured = classifyStepLanding(dropOnto(27))
  check(
    '(rule) 3 / 7 / 27-block drops are MEASURED as 3 / 7 / 27 - the depth the old verdict discarded',
    three.drop === 3 && seven.drop === 7 && measured.drop === 27,
    `drop3=${three.drop} drop7=${seven.drop} drop27=${measured.drop} (all reason=${measured.reason ?? 'none'})`,
  )
  const voidStep = classifyStepLanding(window(AIR, AIR, AIR, AIR, AIR, AIR, AIR, AIR, AIR, AIR))
  check(
    '(rule) an observed-empty window is still `unsafe_landing`, now with a proven LOWER BOUND',
    voidStep.reason === 'unsafe_landing' && voidStep.support === STEP_SUPPORT_NONE && voidStep.drop === 8 && voidStep.dropAtLeast,
    `reason=${voidStep.reason} drop=${voidStep.drop} atLeast=${voidStep.dropAtLeast}`,
  )
  const unloaded = classifyStepLanding(window(AIR, AIR, null, null, LAVA))
  check(
    '(rule) UNKNOWN is still not false: an unloaded cell ends the scan, and the observed emptiness above it is a lower bound',
    unloaded.reason === null && unloaded.support === STEP_SUPPORT_UNKNOWN && unloaded.drop === 0 && unloaded.dropAtLeast,
    `reason=${unloaded.reason ?? 'none'} drop=${unloaded.drop} atLeast=${unloaded.dropAtLeast}`,
  )
  const stepUp = classifyStepLanding(window(STONE, AIR, AIR))
  check(
    '(rule) a collidable landing cell is a step-up: drop 0 (nothing falls)',
    stepUp.reason === null && stepUp.drop === 0,
    `reason=${stepUp.reason ?? 'none'} drop=${stepUp.drop}`,
  )
  const landingHazard = classifyStepLanding(window(LAVA, AIR, STONE))
  const fallHazard = classifyStepLanding(window(AIR, AIR, AIR, AIR, AIR, LAVA, STONE))
  const canopy = classifyStepLanding(window(AIR, AIR, LEAVES))
  check(
    '(rule) every PRE-EXISTING verdict is unchanged: hazard_between / hazard_between / legal canopy',
    landingHazard.reason === 'hazard_between' &&
      landingHazard.block === 'lava' &&
      fallHazard.reason === 'hazard_between' &&
      fallHazard.block === 'lava' &&
      canopy.reason === null &&
      canopy.support === 'oak_leaves',
    `landing=${landingHazard.reason} fall=${fallHazard.reason} canopy=${canopy.reason ?? 'none'}`,
  )

  // --- the vanilla damage model (absent from the repo before) ---------------
  check(
    '(rule) vanilla fall damage: 0 up to 3 blocks, then 1 HP per block',
    fallDamageHp(3, null) === 0 && fallDamageHp(4, null) === 1 && fallDamageHp(7, null) === 4 && fallDamageHp(27, null) === 24,
    `3=${fallDamageHp(3, null)} 4=${fallDamageHp(4, null)} 7=${fallDamageHp(7, null)} 27=${fallDamageHp(27, null)}`,
  )
  check(
    '(rule) the block below is a fact: water negates the fall, hay bale reduces it, stone does not',
    fallDamageHp(27, 'water') === 0 && fallDamageHp(27, 'slime_block') === 0 && fallDamageHp(27, 'hay_block') === 5 && fallDamageHp(27, 'stone') === 24,
    `water=${fallDamageHp(27, 'water')} slime=${fallDamageHp(27, 'slime_block')} hay=${fallDamageHp(27, 'hay_block')} stone=${fallDamageHp(27, 'stone')}`,
  )
  check(
    '(rule) worn armour is a fact: full diamond = 20 points + 8 toughness, iron = 15/0, unknown material = 0 (fail closed)',
    armorFallMitigation(armor('diamond')).points === 20 &&
      armorFallMitigation(armor('diamond')).toughness === 8 &&
      armorFallMitigation(armor('iron')).points === 15 &&
      armorFallMitigation(armor('iron')).toughness === 0 &&
      armorFallMitigation(armor('mystery')).points === 0 &&
      armorFallMitigation(armor('turtle_helmet')).points === 2 &&
      armorFallMitigation(null).points === 0,
    `diamond=${JSON.stringify(armorFallMitigation(armor('diamond')))} iron=${JSON.stringify(armorFallMitigation(armor('iron')))} unknown=${armorFallMitigation(armor('mystery')).points} turtle=${armorFallMitigation(armor('turtle_helmet')).points}`,
  )
  check(
    `(rule) the survivable drop is health-derived: 16 at health 20, 6 at health 10, 0 at the critical floor ${CRITICAL_DAMAGE_HEALTH}, unknown health = unknown`,
    maxSurvivableDrop(20) === 16 &&
      maxSurvivableDrop(10) === 6 &&
      maxSurvivableDrop(CRITICAL_DAMAGE_HEALTH) === 0 &&
      maxSurvivableDrop(null) === null &&
      maxSurvivableDrop(20, armorFallMitigation(armor('diamond')).points, 8)! > maxSurvivableDrop(20)!,
    `h20=${maxSurvivableDrop(20)} h10=${maxSurvivableDrop(10)} hCrit=${maxSurvivableDrop(CRITICAL_DAMAGE_HEALTH)} unknown=${maxSurvivableDrop(null)} diamond20=${maxSurvivableDrop(20, 20, 8)}`,
  )

  // --- the survivability verdict -------------------------------------------
  const verdict = (reads: StepLandingReads, body: Parameters<typeof fallSurvivability>[1]) =>
    fallSurvivability(classifyStepLanding(reads), body)
  const flatV = verdict(window(AIR, AIR, STONE), { health: 1 })
  const threeV = verdict(dropOnto(3), { health: 1 })
  check(
    '(rule) a flat step and a 3-block drop are NOT fatal at ANY health - the guard adds no timidity',
    flatV.fatal === false && threeV.fatal === false && threeV.damage === 0,
    `flat=${flatV.fatal} drop3=${threeV.fatal} damage=${threeV.damage}`,
  )
  const measuredV = verdict(dropOnto(27), { health: 20 })
  check(
    '(i-rule) THE MEASURED DROP: 27 blocks onto stone at full health is fatal (24 damage on 20 HP)',
    measuredV.fatal === true &&
      measuredV.fatalFact === 'drop_exceeds_health' &&
      measuredV.drop === 27 &&
      measuredV.damage === 24 &&
      measuredV.health === 20 &&
      measuredV.safeDrop === 16,
    `fatal=${measuredV.fatal} fact=${measuredV.fatalFact} drop=${measuredV.drop} damage=${measuredV.damage} health=${measuredV.health} safe=${measuredV.safeDrop}`,
  )
  const survivableV = verdict(dropOnto(7), { health: 20 })
  const fatalLowV = verdict(dropOnto(7), { health: 10 })
  check(
    '(iv-rule) the SAME drop (4 damage) is survivable at health 20 and fatal at health 10 - the fact is the body, not the place',
    survivableV.fatal === false && survivableV.damage === 4 && fatalLowV.fatal === true && fatalLowV.fatalFact === 'drop_exceeds_health',
    `h20 fatal=${survivableV.fatal} h10 fatal=${fatalLowV.fatal} damage=${survivableV.damage}`,
  )
  const armorV = verdict(dropOnto(27), { health: 20, armor: armor('diamond') })
  check(
    '(rule) the same 27-block drop is SURVIVABLE in full diamond (7.5 HP of 20) - armour is a fact, and the guard is not timid',
    armorV.fatal === false && armorV.armorPoints === 20 && armorV.damage !== null && armorV.damage < 10,
    `fatal=${armorV.fatal} armorPoints=${armorV.armorPoints} damage=${armorV.damage?.toFixed(2)}`,
  )
  // `below` = [air x5, null]: five OBSERVED empty cells then an unloaded one, so
  // the fall is at least 5 blocks whatever the unloaded cell holds.
  const unloadedDeepV = verdict(window(AIR, AIR, AIR, AIR, AIR, AIR, AIR, null), { health: 8 })
  const unloadedShallowV = verdict(window(AIR, AIR, null), { health: 2 })
  check(
    '(rule) an UNLOADED column is priced by its proven lower bound: 5 observed empties are already fatal at health 8, 0 are not at health 2',
    unloadedDeepV.fatal === true &&
      unloadedDeepV.fatalFact === 'drop_deeper_than_survivable' &&
      unloadedDeepV.drop === 5 &&
      unloadedDeepV.dropAtLeast === true &&
      unloadedShallowV.fatal === false,
    `deep fatal=${unloadedDeepV.fatal} drop=${unloadedDeepV.drop} atLeast=${unloadedDeepV.dropAtLeast} shallow=${unloadedShallowV.fatal}`,
  )
  const unknownHealthV = verdict(dropOnto(27), {})
  const waterV = verdict(window(AIR, AIR, ...Array.from({ length: 27 }, () => AIR as StepLandingBlock | null), WATER), { health: 6 })
  check(
    '(rule) UNKNOWN is not false: an unobserved health never refuses, and water under the fall is never fatal',
    unknownHealthV.fatal === false && unknownHealthV.safeDrop === null && waterV.fatal === false && waterV.damage === 0,
    `unknownHealth=${unknownHealthV.fatal} water=${waterV.fatal}`,
  )
  const heldV = verdict(dropOnto(27), { health: 20, heldItem: 'water_bucket' })
  check(
    '(rule) a held water bucket is NAMED as a mitigation and does NOT license the walk (the walk places nothing)',
    heldV.fatal === true && heldV.mitigation === 'water_bucket' && formatMoveLegStopped({
      reason: 'fall_lethal',
      from: { x: 26, y: 79, z: -5 },
      to: { x: 27, y: 79, z: -5 },
      block: 'air',
      support: 'stone',
      fall: heldV,
    }).includes('mitigation=water_bucket'),
    `fatal=${heldV.fatal} mitigation=${heldV.mitigation}`,
  )
}

// ---------------------------------------------------------------------------
// the marker contract: typed, mirrored, and the OLD lines byte-identical
// ---------------------------------------------------------------------------
{
  const line = formatMoveLegStopped({
    reason: 'fall_lethal',
    from: { x: 30, y: 55, z: -20 },
    to: { x: 31, y: 55, z: -20 },
    block: 'air',
    support: 'stone',
    fall: fallSurvivability(classifyStepLanding(dropOnto(27)), { health: 20 }),
  })
  check(
    '(marker) the exact `fall_lethal` line names the edge cells, the drop, the health, the damage, the safe bound, the fatal fact and the alternatives',
    line ===
      'MOVE_LEG_STOPPED reason=fall_lethal from=30,55,-20 to=31,55,-20 block=air support=stone drop=27 health=20 damage=24 safe=16 armor=0 fact=drop_exceeds_health alternatives=retreat,bridge,descend',
    `line="${line}"`,
  )
  check(
    '(marker) the line is a MIRRORED host event (the live sink would otherwise drop it)',
    MIRRORED_MARKERS.has(MOVE_LEG_STOPPED) && mirroredEventToken(line) === MOVE_LEG_STOPPED,
    `registered=${MIRRORED_MARKERS.has(MOVE_LEG_STOPPED)} token=${mirroredEventToken(line) ?? 'dropped'}`,
  )
  check(
    '(contract) the new typed reason is an executor FailureCode that charges the movement memory boundedly',
    moveFailureReason('fall_lethal') === 'no_progress' &&
      readFileSync(join(import.meta.dir, 'src', 'executor.ts'), 'utf8').includes("| 'fall_lethal'"),
    `moveFailureReason=${moveFailureReason('fall_lethal')} declared=${readFileSync(join(import.meta.dir, 'src', 'executor.ts'), 'utf8').includes("| 'fall_lethal'")}`,
  )
  const legacyHazard = formatMoveLegStopped({
    reason: 'hazard_between',
    from: { x: 30, y: 55, z: -20 },
    to: { x: 31, y: 55, z: -20 },
    block: 'lava',
    support: STEP_SUPPORT_NONE,
  })
  const legacyVoid = formatMoveLegStopped({
    reason: 'unsafe_landing',
    from: { x: 30, y: 55, z: -20 },
    to: { x: 31, y: 55, z: -20 },
    block: 'air',
    support: STEP_SUPPORT_NONE,
  })
  check(
    '(contract) the PRE-EXISTING reasons keep their byte-identical lines (the live/waypoint fixtures assert these exactly)',
    legacyHazard === 'MOVE_LEG_STOPPED reason=hazard_between from=30,55,-20 to=31,55,-20 block=lava support=none' &&
      legacyVoid === 'MOVE_LEG_STOPPED reason=unsafe_landing from=30,55,-20 to=31,55,-20 block=air support=none',
    `hazard="${legacyHazard}" void="${legacyVoid}"`,
  )
}

// ---------------------------------------------------------------------------
// a grid + control-state bot whose world model is the body's own high bridge.
// ---------------------------------------------------------------------------
interface GridCell {
  name: string
  boundingBox: string
}
type Grid = Map<string, GridCell>

function solid(name: string): GridCell {
  return { name, boundingBox: name === 'air' || name === 'lava' || name === 'fire' || name === 'water' ? 'empty' : 'block' }
}
function fill(grid: Grid, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, name: string): void {
  for (let x = x0; x <= x1; x += 1) {
    for (let y = y0; y <= y1; y += 1) {
      for (let z = z0; z <= z1; z += 1) grid.set(`${x},${y},${z}`, solid(name))
    }
  }
}

interface BodyFacts {
  /** live health, or null/undefined for the UNKNOWN-is-not-false fixture */
  health?: number | null
  armor?: ReturnType<typeof armor>
  heldItem?: string | null
}

interface Fixture {
  bot: Bot
  position: Vec3
  trace: string[]
  pathCalls: () => number
  /** the LIVE pinned `movements.maxDropDown` (the pre-commit survival bound) */
  dropBound: () => number | null
  grid: Grid
}

const STEP = 0.25

function makeBot(feet: Vec3Json, grid: Grid, body: BodyFacts = {}): Fixture {
  const position = new Vec3(feet.x + 0.5, feet.y, feet.z + 0.5)
  const trace: string[] = []
  let pathCalls = 0
  let heading = { x: 0, z: 0 }
  const at = (x: number, y: number, z: number): GridCell | null => grid.get(`${x},${y},${z}`) ?? null
  const open = (x: number, y: number, z: number): boolean => {
    const found = at(x, y, z)
    return found === null || found.boundingBox === 'empty'
  }
  const blockAt = (v: { x: number; y: number; z: number }) => {
    const found = at(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z))
    if (found === null) return null
    return {
      name: found.name,
      boundingBox: found.boundingBox,
      diggable: false,
      position: new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)),
    }
  }
  const listeners = new Map<string, Set<(arg?: unknown) => void>>()
  const emit = (event: string, arg?: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(arg)
  }
  const armorPieces = body.armor ?? null
  const bot = {
    registry,
    game: { dimension: 'minecraft:overworld' as string },
    physicsEnabled: true,
    health: body.health === null ? undefined : body.health,
    food: 20,
    entity: {
      position,
      yaw: 0,
      pitch: 0,
      onGround: true,
      width: 0.6,
      height: 1.8,
      velocity: new Vec3(0, 0, 0),
      offset: (x: number, y: number, z: number) => position.offset(x, y, z),
      clone: () => position.clone(),
      distanceTo: (other: { x: number; y: number; z: number }) => position.distanceTo(other as Vec3),
    },
    _client: { write: () => true },
    entities: {},
    // The worn-armour read is the sensor's own (`state.ts buildArmor`: player
    // window 0, slots 5-8); a fixture with no armor leaves `slots` undefined.
    inventory: {
      items: () => [],
      count: () => 0,
      ...(armorPieces === null
        ? {}
        : { slots: [null, null, null, null, null, armorPieces.head, armorPieces.torso, armorPieces.legs, armorPieces.feet] }),
    },
    heldItem: body.heldItem === undefined || body.heldItem === null ? null : { name: body.heldItem, count: 1, slot: 36 },
    blockAt,
    on: (event: string, listener: (arg?: unknown) => void) => {
      const set = listeners.get(event) ?? new Set<(arg?: unknown) => void>()
      set.add(listener)
      listeners.set(event, set)
    },
    removeListener: (event: string, listener: (arg?: unknown) => void) => {
      listeners.get(event)?.delete(listener)
    },
    setControlState: (control: string, state: boolean) => {
      if (!state) return
      trace.push(control)
      const feetY = Math.floor(position.y + 0.1)
      if (control === 'jump') {
        const cx = Math.floor(position.x + heading.x)
        const cz = Math.floor(position.z + heading.z)
        const ahead = at(cx, feetY, cz)
        if (ahead !== null && ahead.boundingBox !== 'empty' && open(cx, feetY + 1, cz) && open(cx, feetY + 2, cz)) {
          position.y = feetY + 1
        }
        return
      }
      if (control !== 'forward' && control !== 'back') return
      const sign = control === 'forward' ? 1 : -1
      const nx = position.x + heading.x * STEP * sign
      const nz = position.z + heading.z * STEP * sign
      const cx = Math.floor(nx)
      const cz = Math.floor(nz)
      if (control === 'forward') {
        const ahead = at(cx, feetY, cz)
        if (ahead !== null && ahead.boundingBox !== 'empty' && open(cx, feetY + 1, cz) && open(cx, feetY + 2, cz)) {
          position.y = feetY + 1
        } else if (open(cx, feetY, cz) && open(cx, feetY - 1, cz)) {
          const floor = at(cx, feetY - 2, cz)
          if (floor !== null && floor.boundingBox !== 'empty') position.y = feetY - 1
        }
      }
      position.x = nx
      position.z = nz
    },
    clearControlStates: () => undefined,
    canDigBlock: () => false,
    lookAt: async (point: { x: number; z: number }) => {
      const dx = point.x - position.x
      const dz = point.z - position.z
      const length = Math.hypot(dx, dz) || 1
      heading = { x: dx / length, z: dz / length }
    },
    digTime: () => 50,
    dig: async () => undefined,
    stopDigging: () => undefined,
    equip: async () => undefined,
    pathfinder: {
      movements: null as unknown,
      setMovements: (movements: unknown) => {
        bot.pathfinder.movements = movements
      },
      // The stock pathfinder is the live DEFAULT actuator (`stockPathTo`), and it
      // fails as it does live when no route exists - which is what hands the leg
      // to the physics control walk (`walkByControls`) below.
      setGoal: () => {
        queueMicrotask(() => emit('path_update', { status: 'noPath' }))
      },
      stop: () => undefined,
      // `noPath` (canDig=false) hands the leg to the control walker - the
      // measured actuator shape.
      getPathTo: () => {
        pathCalls += 1
        return { status: 'noPath', path: [] }
      },
    },
  }
  const dropBound = (): number | null => {
    const movements = (bot.pathfinder as { movements?: { maxDropDown?: number } | null }).movements
    return typeof movements?.maxDropDown === 'number' ? movements.maxDropDown : null
  }
  return { bot: bot as unknown as Bot, position, trace, pathCalls: () => pathCalls, dropBound, grid }
}

const TARGET: Vec3Json = { x: 38, y: 55, z: -20 }

function legCandidate(target: Vec3Json, kind: 'RETRIEVE' | 'RETREAT'): Candidate {
  return {
    id: `${kind}:known:blaze_rod:b${target.x}_${target.y}_${target.z}`,
    kind,
    label: `${kind} the remembered blaze rod at (${target.x},${target.y},${target.z})`,
    targetName: kind === 'RETRIEVE' ? 'blaze_rod' : null,
    target,
    targetEntityId: null,
    itemName: 'blaze_rod',
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: {},
  }
}

interface LegRun {
  status: string
  failure: string | null
  verified: boolean
  moved: number
  trace: string[]
  pathCalls: number
  dropBound: number | null
  messages: string[]
  stopLines: string[]
}

async function runLeg(
  feet: Vec3Json,
  grid: Grid,
  body: BodyFacts = {},
  {
    stubGuard = false,
    kind = 'RETRIEVE' as 'RETRIEVE' | 'RETREAT',
    actuation = 'packet' as 'packet' | 'pathfinder',
  } = {},
): Promise<LegRun> {
  const dir = mkdtempSync(join(tmpdir(), 'edge-fall-guard-'))
  const fixture = makeBot(feet, grid, body)
  const logger = new EventLogger(new JsonlWriter(join(dir, 'agent.jsonl')), false)
  const executor = new Executor(fixture.bot, logger, {
    ...defaultExecutorOptions,
    actuation,
    packetStepMs: 1,
  })
  if (stubGuard) {
    ;(executor as unknown as { guardStepLanding: () => void }).guardStepLanding = () => undefined
  }
  const start = fixture.position.clone()
  const result = await fixtureClaim(executor, legCandidate(TARGET, kind)).completion
  const messages = (await Bun.file(join(dir, 'agent.jsonl')).text())
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { message?: string }).message ?? '')
  return {
    status: result.status,
    failure: result.failure,
    verified: result.verified,
    moved: fixture.position.distanceTo(start),
    trace: fixture.trace,
    pathCalls: fixture.pathCalls(),
    dropBound: fixture.dropBound(),
    messages,
    stopLines: messages.filter((line) => line.startsWith(MOVE_LEG_STOPPED)),
  }
}

const FEET: Vec3Json = { x: 30, y: 55, z: -20 }

/**
 * The body's OWN structure at y79 in the measured run: a floor at y54 for
 * x26..30, air above, and the world's ground far below x>=31. `groundAt` places
 * the floor the landing column ends on.
 */
function highEdge(groundAt: number): Grid {
  const grid: Grid = new Map()
  fill(grid, 26, 30, 54, 54, -21, -19, 'stone')
  fill(grid, 26, 30, 55, 58, -21, -19, 'air')
  // The fall column is OBSERVED air all the way down to the ground: a cell that
  // is absent from the grid would be an unloaded chunk (UNKNOWN, never a
  // refusal), which is a different fixture - see (ii)'s unknown-health case.
  fill(grid, 31, 40, groundAt + 1, 58, -21, -19, 'air')
  fill(grid, 31, 40, groundAt, groundAt, -21, -19, 'stone')
  return grid
}

// ---------------------------------------------------------------------------
// (i) THE MEASURED SHAPE: full health on the high edge, a fatal drop below.
// ---------------------------------------------------------------------------
{
  // the measured 28-block fall: the walkway lip at y55, the ground at y26.
  const grid = highEdge(26)
  const guarded = await runLeg(FEET, grid, { health: 20 })
  const stop = guarded.stopLines[0] ?? ''
  check(
    '(i) THE MEASURED SHAPE: the leg is WITHHELD typed `fall_lethal`, the body does not step, the decision returns to policy',
    guarded.status === 'failed' &&
      guarded.failure === 'fall_lethal' &&
      guarded.trace.length === 0 &&
      guarded.moved < 0.001 &&
      stop.startsWith('MOVE_LEG_STOPPED reason=fall_lethal from=30,55,-20 to=31,55,-20 block=air support=none'),
    `status=${guarded.status} failure=${guarded.failure ?? 'none'} controls=[${guarded.trace.join(',')}] moved=${guarded.moved.toFixed(3)} stop=[${stop}]`,
  )
  check(
    '(i) the refusal names the predicted drop (a proven lower bound), the body health and the fact that made it fatal',
    stop.includes('drop>=17') &&
      stop.includes('health=20') &&
      stop.includes('damage>=14') &&
      stop.includes('safe=16') &&
      stop.includes('fact=drop_deeper_than_survivable'),
    `stop=[${stop}]`,
  )
  check(
    '(i) the refusal leaves the other option classes OFFERED (it refuses one step, never the mission) and names them',
    stop.endsWith('alternatives=retreat,bridge,descend'),
    `stop=[${stop}]`,
  )
  check(
    '(i) the stop adds NO A*: only the walker\'s own two probes ran (entry plan + first replan)',
    guarded.pathCalls === 2,
    `getPathTo calls=${guarded.pathCalls}`,
  )
  const unguarded = await runLeg(FEET, grid, { health: 20 }, { stubGuard: true })
  check(
    '(i BEFORE-WITNESS) with the guard stubbed out the SAME fixture walks the body off the edge - the measured defect',
    unguarded.trace.includes('forward') && unguarded.moved > 0.5 && unguarded.stopLines.length === 0,
    `controls=[${unguarded.trace.join(',')}] moved=${unguarded.moved.toFixed(2)} stops=${unguarded.stopLines.length}`,
  )
}

// ---------------------------------------------------------------------------
// (i-PHYSICS) the same measured shape on the LIVE DEFAULT actuator: the stock
// pathfinder fails and the leg falls back to the physics control walk, which
// holds `forward` and would walk the body off the edge.
// ---------------------------------------------------------------------------
{
  const grid = highEdge(26)
  const guarded = await runLeg(FEET, grid, { health: 20 }, { actuation: 'pathfinder' })
  const stop = guarded.stopLines[0] ?? ''
  check(
    '(i-physics) on the stock-default actuator the physics walker is stopped BEFORE any control state',
    guarded.status === 'failed' &&
      guarded.failure === 'fall_lethal' &&
      guarded.trace.length === 0 &&
      guarded.moved < 0.001 &&
      stop.includes('from=30,55,-20 to=31,55,-20') &&
      stop.includes('drop>=17') &&
      stop.includes('health=20') &&
      stop.endsWith('alternatives=retreat,bridge,descend'),
    `status=${guarded.status} failure=${guarded.failure ?? 'none'} controls=[${guarded.trace.join(',')}] moved=${guarded.moved.toFixed(3)} stop=[${stop}]`,
  )
  const unguarded = await runLeg(FEET, grid, { health: 20 }, { actuation: 'pathfinder', stubGuard: true })
  check(
    '(i-physics BEFORE-WITNESS) with the guard stubbed the SAME fixture holds `forward` and walks the body off the edge - the measured death',
    unguarded.trace.includes('forward') && unguarded.moved > 0.5 && unguarded.stopLines.length === 0,
    `controls=[${unguarded.trace.join(',')}] moved=${unguarded.moved.toFixed(2)} stops=${unguarded.stopLines.length}`,
  )
  check(
    '(i-physics) a body it could survive keeps the movement policy unchanged: the drop bound stays the pinned 8',
    guarded.dropBound === 8,
    `movements.maxDropDown=${guarded.dropBound}`,
  )
}

// ---------------------------------------------------------------------------
// (ii) the same walk where the drop IS survivable -> byte-identical.
// ---------------------------------------------------------------------------
{
  // 7 blocks onto stone = 4 damage: survivable at full health, well inside the
  // planner's own 8-block bound (so every pre-existing predicate said yes).
  const grid = highEdge(47)
  const guarded = await runLeg(FEET, grid, { health: 20 })
  const unguarded = await runLeg(FEET, grid, { health: 20 }, { stubGuard: true })
  check(
    '(ii) a SURVIVABLE drop is unchanged: byte-identical control trace, no marker, the body still moves',
    guarded.stopLines.length === 0 &&
      guarded.trace.length > 0 &&
      guarded.trace.join(',') === unguarded.trace.join(',') &&
      guarded.status === unguarded.status &&
      guarded.moved > 0.5,
    `stops=${guarded.stopLines.length} status=${guarded.status}/${unguarded.status} moved=${guarded.moved.toFixed(2)} guarded=[${guarded.trace.join(',')}] unguarded=[${unguarded.trace.join(',')}]`,
  )
  check(
    '(ii) the same grid with UNKNOWN health is also unchanged (UNKNOWN is not false)',
    (await runLeg(FEET, grid)).stopLines.length === 0,
    'no health observed -> no refusal',
  )
}

// ---------------------------------------------------------------------------
// (iii) a 1-block step down and an ordinary walk: byte-identical at ANY health.
// ---------------------------------------------------------------------------
{
  const grid = new Map<string, GridCell>()
  fill(grid, 26, 30, 54, 54, -21, -19, 'stone')
  fill(grid, 26, 30, 55, 58, -21, -19, 'air')
  // a TWO-wide missing floor whose support is one block down (the 1-block dip)
  fill(grid, 31, 32, 53, 53, -21, -19, 'stone')
  fill(grid, 31, 32, 54, 58, -21, -19, 'air')
  fill(grid, 33, 40, 54, 54, -21, -19, 'stone')
  fill(grid, 33, 40, 55, 58, -21, -19, 'air')
  const guarded = await runLeg(FEET, grid, { health: 1 })
  const unguarded = await runLeg(FEET, grid, { health: 1 }, { stubGuard: true })
  check(
    '(iii) a 1-block step down at health 1 is unchanged: same trace, no marker, arrival',
    guarded.stopLines.length === 0 &&
      guarded.status === 'done' &&
      guarded.verified === true &&
      guarded.trace.length > 0 &&
      guarded.trace.join(',') === unguarded.trace.join(','),
    `stops=${guarded.stopLines.length} status=${guarded.status} health=1 guarded=[${guarded.trace.join(',')}]`,
  )
  // ordinary flat + 1-block step-UP terrain, full health: the canonical walk.
  const rise = new Map<string, GridCell>()
  fill(rise, 26, 33, 54, 54, -21, -19, 'stone')
  fill(rise, 26, 33, 55, 58, -21, -19, 'air')
  fill(rise, 34, 40, 55, 55, -21, -19, 'stone')
  fill(rise, 34, 40, 56, 59, -21, -19, 'air')
  const walked = await runLeg(FEET, rise, { health: 20 })
  const walkedUnguarded = await runLeg(FEET, rise, { health: 20 }, { stubGuard: true })
  check(
    '(iii) ordinary flat + step-up terrain is byte-identical and still arrives',
    walked.stopLines.length === 0 &&
      walked.status === 'done' &&
      walked.verified === true &&
      walked.trace.join(',') === walkedUnguarded.trace.join(',') &&
      walked.trace.includes('jump'),
    `stops=${walked.stopLines.length} status=${walked.status} verified=${walked.verified} jumps=${walked.trace.filter((c) => c === 'jump').length}`,
  )
}

// ---------------------------------------------------------------------------
// (iv) a low-health body: the SAME drop that was survivable is now fatal.
// ---------------------------------------------------------------------------
{
  const grid = highEdge(47) // the identical 7-block drop as (ii)
  const healthy = await runLeg(FEET, grid, { health: 20 })
  const hurt = await runLeg(FEET, grid, { health: 10 })
  const stop = hurt.stopLines[0] ?? ''
  check(
    '(iv) the SAME grid and drop: survivable at health 20, WITHHELD typed at health 10',
    healthy.stopLines.length === 0 &&
      healthy.moved > 0.5 &&
      hurt.status === 'failed' &&
      hurt.failure === 'fall_lethal' &&
      hurt.trace.length === 0 &&
      stop ===
        'MOVE_LEG_STOPPED reason=fall_lethal from=30,55,-20 to=31,55,-20 block=air support=stone drop=7 health=10 damage=4 safe=6 armor=0 fact=drop_exceeds_health alternatives=retreat,bridge,descend',
    `healthy stops=${healthy.stopLines.length} moved=${healthy.moved.toFixed(2)} hurt failure=${hurt.failure ?? 'none'} stop=[${stop}]`,
  )
  check(
    '(iv) the fatal fact is the body state, never the coordinate: same grid object, same drop, same edge cell',
    healthy.stopLines.length === 0 && stop.includes('to=31,55,-20') && stop.includes('drop=7') && stop.includes('health=10'),
    `edge=31,55,-20 drop=7 health=10`,
  )
}

// ---------------------------------------------------------------------------
// (v) the retreat and the bridge advance are covered by the same fact.
// ---------------------------------------------------------------------------
{
  const grid = highEdge(26)
  const retreat = await runLeg(FEET, grid, { health: 20 }, { kind: 'RETREAT', actuation: 'pathfinder' })
  const stop = retreat.stopLines[0] ?? ''
  check(
    '(v) the RETREAT leg is stopped by the SAME fact and the same typed reason (RETREAT shares the MOVE body, executor.ts:2711)',
    retreat.status === 'failed' &&
      retreat.failure === 'fall_lethal' &&
      retreat.trace.length === 0 &&
      retreat.moved < 0.001 &&
      stop.includes('reason=fall_lethal') &&
      stop.includes('from=30,55,-20 to=31,55,-20') &&
      stop.includes('drop>=17') &&
      stop.includes('health=20') &&
      stop.endsWith('alternatives=retreat,bridge,descend'),
    `failure=${retreat.failure ?? 'none'} controls=[${retreat.trace.join(',')}] moved=${retreat.moved.toFixed(3)} stop=[${stop}]`,
  )
  // THE PRE-COMMIT HALF: every stock `setGoal` site pins the planner's own drop
  // bound to what THIS body survives, so a fatal drop is not even plannable. A
  // healthy body (safe drop 16 > 8) keeps the pinned 8 - no route changes.
  const hurtBound = await runLeg(FEET, grid, { health: 10 }, { actuation: 'pathfinder' })
  check(
    '(v) the pre-COMMIT drop bound follows the body: 8 at full health, 6 at health 10 (the deepest drop it survives)',
    hurtBound.dropBound === 6 && (await runLeg(FEET, grid, { health: 20 }, { actuation: 'pathfinder' })).dropBound === 8,
    `health10 maxDropDown=${hurtBound.dropBound} health20 maxDropDown=8`,
  )
  check(
    '(v) with the bound pinned to 6 the same edge is refused by the geometry letter too (the planner now has no such route)',
    hurtBound.failure === 'fall_lethal' || hurtBound.failure === 'unsafe_landing',
    `failure=${hurtBound.failure ?? 'none'} stop=[${hurtBound.stopLines[0] ?? ''}]`,
  )
  // The BRIDGE advance is the same `pathTo` -> guarded-actuator path, and every
  // `setGoal` site now pins the planner's drop bound to what the body survives.
  const source = readFileSync(join(import.meta.dir, 'src', 'executor.ts'), 'utf8')
  const guardCallSites = [...source.matchAll(/this\.guardStepLanding\(/g)].length
  const bridgeLeg = source.slice(source.indexOf('private async runBridgeLeg('), source.indexOf('private async runBridgeLeg(') + 26000)
  const bridgeAdvance = [...bridgeLeg.matchAll(/await this\.pathTo\(/g)].length
  const pinSites = [...source.matchAll(/this\.applySurvivableDropBound\(\)/g)].length
  check(
    '(v) the bridge advance goes through the SAME guarded actuator path (`pathTo`), and every stock `setGoal` site pins the survivable drop bound',
    guardCallSites === 2 && // the 2 guarded actuators every advance funnels through
      bridgeAdvance >= 2 &&
      pinSites === 3 && // the 3 stock `setGoal` sites
      source.includes('private async runBridgeLeg(') &&
      /await this\.pathTo\((target|span\.landing), epoch, signal, 'GoalBlock'/.test(bridgeLeg),
    `guardSites=${guardCallSites} bridgePathTo=${bridgeAdvance} dropBoundPins=${pinSites}`,
  )
}

process.stdout.write('------------------------------------------------------------------------\n')
process.stdout.write(`edge fall guard cases: ${failures === 0 ? 'all passed' : `${failures} failed`}\n`)
if (failures > 0) process.exit(1)
