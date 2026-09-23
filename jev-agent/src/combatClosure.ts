// combatClosure.ts - issue #436 section 9: honest combat outcomes.
//
// Section 9 makes the boundary explicit:
//
//   "target selection is semantic; target completion is mechanical"
//
//   "Do not collapse: entity disappeared -> we killed it, where Mineflayer cannot
//    causally prove death."
//
//   "Use typed outcomes such as: KILL_VERIFIED, TARGET_DESPAWNED, TARGET_LOST,
//    TARGET_INVALIDATED, COMBAT_INTERRUPTED, COMBAT_TIMEOUT."
//
// This module owns ONLY that vocabulary and its classification from facts the
// executor actually observed. It never chooses a target, never ranks mobs, and
// never turns "the entity left the tracked set" into a kill.
//
// The kill proof is the server's own `entityDead` event for the EXACT committed
// entity id. Nothing weaker counts:
//
//   entityDead on the committed id                  -> KILL_VERIFIED
//   the committed id left the tracked set, no death -> TARGET_DESPAWNED
//   same-identity re-acquire exhausted, still gone  -> TARGET_LOST
//   the committed id exists but is no longer valid  -> TARGET_INVALIDATED
//   safety/lease preempted the commitment           -> COMBAT_INTERRUPTED
//   the bounded lease expired, target alive         -> COMBAT_TIMEOUT
//   kill verified but the HUNT_DROP item is not in the inventory -> DROP_NOT_ACQUIRED
//
// It additionally owns the STANCE vocabulary (`AttackStandFact` and friends
// below): the same "CAN this fight physically happen" question asked
// horizontally, from a cell the body can legally stand on and see the target
// from. Type-only import, so this stays a leaf module with no runtime deps.
import type { Vec3Json } from './state.ts'

/**
 * The hunt's APPROACH BUDGET in blocks: a committed producer inside this distance
 * can be walked into melee range inside one bounded hunt lease, so the kill is
 * mechanically groundable. Beyond it the candidate layer requires a POSITIVE route
 * proof before offering the kill (see `candidates.ts`).
 *
 * This is the same envelope the executor's bounded same-identity re-acquire used
 * (`HUNT_REACQUIRE_RADIUS`), published here so the CANDIDATE-side reachability
 * contract and the executor cannot drift apart. It is a mechanical walking budget,
 * not a policy preference and not M3-specific: the measured failure was a producer
 * ~37 blocks away offered as a kill that produced 0 swings.
 */
export const HUNT_APPROACH_BUDGET = 24

/**
 * THE melee envelope: the distance from which `bot.attack` actually lands a blow.
 *
 * This is the executor's own swing bound - `executor.ts` publishes it as
 * `MELEE_ATTACK_RANGE` and swings whenever the 3-D feet-to-feet distance is at or
 * inside it (`runAttack`). It is defined HERE, next to `HUNT_APPROACH_BUDGET`,
 * for the same reason: the CANDIDATE-side "can a swing land from here" gate and
 * the executor's swing loop must answer with ONE number, or the gate admits a
 * stance the executor refuses to swing from (the measured `out_of_reach`
 * zero-swing lease) or refuses a stance the executor would have swung from
 * (deleting a grounded attack). `executor.ts` aliases this constant; there is no
 * second copy of the number.
 *
 * It is NOT `threat.ts MELEE_THREAT_REACH` (3.2): that is the danger/contact
 * envelope the threat tracker and the keep-distance solver share, deliberately a
 * little wider than the swing bound so a mob already on the body always produces
 * a reaction. Contact and hittability are separate facts and stay separate.
 */
export const MELEE_ATTACK_REACH = 3.1

/**
 * THE BODY'S OWN VERTICAL REACH: how much of a contact gap the body already spans
 * without moving, because the swing and the aim point both originate from the
 * body's UPPER half, not from its feet.
 *
 * `MELEE_ATTACK_REACH` above is the LENGTH of the reach. This is its ORIGIN, and
 * the two must be read together or the envelope is geometrically wrong:
 *
 *   a target level with the body   feet-to-feet IS the distance that matters
 *   a target ABOVE the body        feet-to-feet charges the body for the height
 *                                  it ALREADY has (`runAttack` looks at, and
 *                                  swings from, an eye-level origin: `bot.lookAt`
 *                                  targets `position + height / 2`), so the gap it
 *                                  must actually close is `gapY - MELEE_REACH_UP`
 *
 * The value is the player's own eye height. It is a property of the BODY, not of
 * any mob, which is what makes the correction general: it applies to every target
 * whose hitbox sits above the body's hitbox - a flying or hovering hostile (blaze,
 * ghast, phantom, vex), a mob on a ledge or a wall above, anything in a tree.
 *
 * Measured live before this existed (the blaze chain, `buddy.log`): every blaze
 * hunt ended `HUNT_END ... target=blaze swings=0 hits=0` (19/19), and the geometry
 * proof that ended one of them named `gap_y=4` with `horizontal=1.70`
 * (`HUNT_CONTACT_UNREACHABLE actionId=ATTACK:e85793`). Feet-to-feet that is
 * 4.35 m > 3.1 -> "no stance can land a swing"; measured from the body's own upper
 * half it is 2.93 m <= 3.1 -> an ordinary swing. The target was not unhittable;
 * the MEASUREMENT was one body-height short.
 */
export const MELEE_REACH_UP = 1.62

/**
 * The vertical component of a contact gap AFTER crediting the body's own height.
 *
 * Monotone by construction: the result is never LARGER than `|gapY|`, so this can
 * only ever move a target INTO the envelope, never out of it. Every offer the
 * feet-to-feet measure grounded stays grounded, exactly, at `gapY <= 0` (level and
 * downward encounters: the `gapY > 0` branch is not taken and `Math.abs` is
 * precisely the term the old 3-D `hypot` used).
 */
export function meleeVerticalReachGap(gapY: number): number {
  if (gapY > 0) return Math.max(0, gapY - MELEE_REACH_UP)
  return Math.abs(gapY)
}

/**
 * THE MELEE DISTANCE: the number the executor's swing test and the stance gate
 * both compare against `MELEE_ATTACK_REACH`.
 *
 * `horizontal` is the horizontal feet-to-feet separation (the same quantity
 * whether measured from the body or from a stance cell); `gapY` is the whole-block
 * vertical separation (`contactGapY`). For a level encounter this is the old
 * feet-to-feet 3-D distance to the last bit; for an elevated target it is the gap
 * the body's upper half must actually close.
 */
export function meleeReachDistance(horizontal: number, gapY: number): number {
  return Math.hypot(horizontal, meleeVerticalReachGap(gapY))
}

/**
 * The largest vertical gap a WALK-only close can express: the melee envelope PLUS
 * the body's own height. A walk cannot change the body's level, and the distance
 * to a target is at least `gapY - MELEE_REACH_UP`, so a gap beyond this is
 * unreachable from EVERY horizontal position - which is what makes
 * `HUNT_CONTACT_UNREACHABLE evidence=vertical_gap` a proof and not a heuristic.
 *
 * This is the corrected form of the theorem this module used to state with
 * `walkGap = meleeReach`: with the tree's constants the corrected threshold is
 * 4.72, so whole-block gaps split `4 = walkable` / `5 = not` - the honest split,
 * and the opposite verdict the old form reached for the measured 4-block blaze.
 */
export function meleeWalkGap(meleeReach: number = MELEE_ATTACK_REACH): number {
  return meleeReach + MELEE_REACH_UP
}

/**
 * The HORIZONTAL budget of the melee envelope for a target this far above the
 * body: how close the body's own level must get to the target's horizontal
 * position for a swing to land.
 *
 * The pathfinder's approach goal is a 3-D ball (`GoalFollow.isEnd` compares
 * `dx*dx + dy*dy + dz*dz` against `range*range`), so a goal expressed as the bare
 * melee reach can NEVER be satisfied for a target above it: radius 2.9 around a
 * target 4 blocks up has no standable node at all, and the closing leg burns its
 * whole lease without arriving. This is the horizontal half such a ball must be
 * widened to, and it is the same envelope the swing test uses - one geometry, two
 * readers.
 */
export function meleeHorizontalBudget(gapY: number, meleeReach: number = MELEE_ATTACK_REACH): number {
  const vertical = meleeVerticalReachGap(gapY)
  return Math.sqrt(Math.max(0, meleeReach * meleeReach - vertical * vertical))
}

/** The §9 outcome of one bounded combat commitment against ONE entity id. */
export type CombatOutcome =
  /** the server `entityDead` event fired for the committed entity id */
  | 'KILL_VERIFIED'
  /** the committed id left the client's tracked set with no death event */
  | 'TARGET_DESPAWNED'
  /** the committed id vanished and the bounded same-identity re-acquire failed */
  | 'TARGET_LOST'
  /** the committed id is present but no longer a valid attack target */
  | 'TARGET_INVALIDATED'
  /**
   * The committed id is tracked and alive, but NO grounded remedy can bring the
   * body's melee envelope onto it from here: the contact gap has a vertical
   * component the walk cannot express (the target is above the body's level) and
   * the ONE vertical planner every ascent uses (`verticalPlan.ts`) grounds no
   * route to that level.
   *
   * This is a §9 vocabulary gap, not a policy: none of the other outcomes says
   * it. Measured live, every blaze hunt ended `HUNT_END ... reason=out_of_range
   * swings=0 hits=0` (21 occurrences) because a hovering producer is exactly
   * this case and the typed fact had no name - so a 0-swing lease looked like a
   * failed attempt instead of a target the body cannot reach at all.
   */
  | 'TARGET_UNREACHABLE'
  /** a hard-safety interrupt or lease revocation preempted the commitment */
  | 'COMBAT_INTERRUPTED'
  /** the bounded lease expired with the target still tracked and alive */
  | 'COMBAT_TIMEOUT'
  /** the exact target was verified dead but the declared drop never reached the inventory */
  | 'DROP_NOT_ACQUIRED'

/** §9: outcomes that prove the committed entity died. Only ONE of them does. */
export const KILL_PROVEN_OUTCOMES: ReadonlySet<CombatOutcome> = new Set<CombatOutcome>(['KILL_VERIFIED'])

/** §9: outcomes that mean "the entity is gone and we did NOT prove we killed it". */
export const TARGET_GONE_OUTCOMES: ReadonlySet<CombatOutcome> = new Set<CombatOutcome>([
  'TARGET_DESPAWNED',
  'TARGET_LOST',
  'TARGET_INVALIDATED',
])

export function targetGoneWithoutKill(outcome: CombatOutcome): boolean {
  return TARGET_GONE_OUTCOMES.has(outcome)
}

/**
 * The `FailureCode` a combat outcome maps to, or null when it is a completion.
 * `DROP_NOT_ACQUIRED` is deliberately NOT a failure of the KILL: the body did
 * defeat the exact entity, so the mechanical kill completed and only the drop
 * half of a `HUNT_DROP` postcondition is unmet. It is reported as a typed fact
 * (and keeps `semanticProgress=false`), never as a kill failure or a fake
 * collect success.
 */
export function combatFailureCode(outcome: CombatOutcome): string | null {
  switch (outcome) {
    case 'KILL_VERIFIED':
    case 'DROP_NOT_ACQUIRED':
      return null
    case 'TARGET_DESPAWNED':
      return 'target_despawned'
    case 'TARGET_LOST':
      return 'target_gone'
    case 'TARGET_INVALIDATED':
      return 'target_invalidated'
    case 'TARGET_UNREACHABLE':
      return 'target_unreachable'
    case 'COMBAT_INTERRUPTED':
      return 'combat_interrupted'
    case 'COMBAT_TIMEOUT':
      return 'combat_timeout'
  }
}

export interface CombatOutcomeFacts {
  /** the server sent `entityDead` for the committed entity id during this lease */
  entityDefeated: boolean
  /** the committed id is in the client's tracked entity set right now */
  tracked: boolean
  /** the bounded same-identity re-acquire ran and could not restore the id */
  reacquireExhausted: boolean
  /** the entity exists but is not a valid/attackable target (e.g. already dead) */
  invalidated: boolean
  /** a hard-safety interrupt or a revoked lease ended the commitment */
  interrupted: boolean
  /**
   * the commitment ended because no grounded remedy reaches melee contact
   * (`TARGET_UNREACHABLE`): the target is tracked, alive and simply out of the
   * body's reach from every level the body can legally stand on. Optional so a
   * caller that cannot observe the geometry keeps the historical facts shape.
   */
  unreachable?: boolean
  /** swings actually landed on the committed id during the lease */
  hits: number
}

/**
 * §9 classification. Pure and total, so the evidence and the result can never
 * disagree about whether a kill happened.
 *
 * Order matters: a verified death wins over everything (the entity is by
 * definition untracked after death), then an explicit safety/lease interrupt,
 * then the invalidation/vanished cases, then the plain bounded timeout.
 */
export function classifyCombatOutcome(facts: CombatOutcomeFacts): CombatOutcome {
  if (facts.entityDefeated) return 'KILL_VERIFIED'
  if (facts.interrupted) return 'COMBAT_INTERRUPTED'
  if (facts.invalidated) return 'TARGET_INVALIDATED'
  // An unreachable target is TRACKED and ALIVE: it is neither gone nor invalid,
  // and calling it a timeout would report a bounded attempt where the body never
  // had a way to swing. It wins over the tracked/despawned split for that reason.
  if (facts.unreachable === true) return 'TARGET_UNREACHABLE'
  if (!facts.tracked) return facts.reacquireExhausted ? 'TARGET_LOST' : 'TARGET_DESPAWNED'
  return 'COMBAT_TIMEOUT'
}

/**
 * THE CONTACT GEOMETRY of one fight: can the body's melee envelope be brought
 * onto the target at all, and if not, WHICH mechanical component is missing?
 *
 * This is CAN, not a preference. `HUNT_APPROACH_BUDGET` is a WALKING budget
 * (issue #436 section 9 measured it as "one bounded hunt lease can walk this
 * far"), but the hunt gate compared it against the raw 3-D distance. A producer
 * that hovers above the walkway is therefore "inside the budget" while the walk
 * can never close its vertical component - the measured shape of every blaze
 * hunt: `HUNT_END reason=out_of_range swings=0 hits=0` (21 times).
 *
 * The bound is a theorem, not a heuristic. A walk cannot change the body's LEVEL,
 * and the 3-D distance to the target is at least the vertical component of the
 * gap:
 *
 *   gapY <= meleeReach   the body can stand at the target's own horizontal
 *                        position at ITS level and be within the melee envelope,
 *                        so a walk-only close is expressible.
 *   gapY >  meleeReach   the distance is > meleeReach at EVERY horizontal
 *                        position, so no walk can ever produce a swing. The body
 *                        must GAIN HEIGHT, which only the vertical planner can
 *                        ground (reuse a tunnel / cut an up-staircase / pillar
 *                        with a held block) - and that is a MOVE-family remedy,
 *                        not something a melee ATTACK lease can express.
 *
 * The gap is measured between INTEGER levels, so `gapY > meleeReach` is the same
 * verdict for every melee constant in the tree (3.1 in the executor, 3.2 in the
 * gate): a 3-block gap is walkable, a 4-block gap is not. No mob is special-cased
 * and no remedy is invented here.
 */
export type ContactApproach =
  /** the melee envelope already contains the target */
  | 'contact'
  /** the walk closes the whole gap: its vertical component fits the melee envelope */
  | 'walk'
  /** the gap exceeds the melee envelope and a grounded vertical route EXISTS */
  | 'ascent_required'
  /** the gap exceeds the melee envelope and the vertical planner grounds NOTHING */
  | 'no_grounded_remedy'

export interface ContactGeometryFacts {
  /** 3-D distance to the target, as the executor measures it */
  distance: number
  /** the melee envelope the executor can swing inside */
  meleeReach: number
  /** target level minus body level, in whole blocks; positive means ABOVE */
  gapY: number
  /** the vertical component a walk-only close can still express (the melee envelope) */
  walkGap: number
  /** the vertical planner refused to ground a route to the target's level */
  ascentRefused: boolean
}

/** Pure and total: same geometry in, same contact verdict out. */
export function classifyContactApproach(facts: ContactGeometryFacts): ContactApproach {
  if (facts.distance <= facts.meleeReach) return 'contact'
  if (facts.gapY <= facts.walkGap) return 'walk'
  return facts.ascentRefused ? 'no_grounded_remedy' : 'ascent_required'
}

/** The vertical component of a contact gap, in whole blocks, from two feet Ys. */
export function contactGapY(bodyFeetY: number, targetFeetY: number): number {
  return Math.floor(targetFeetY) - Math.floor(bodyFeetY)
}

// ---------------------------------------------------------------------------
// THE STANCE: the horizontal half of the same question.
//
// `classifyContactApproach` above answers the VERTICAL component of a contact
// gap (can a walk bring the melee envelope onto the target's LEVEL). It does not
// answer whether any legal, walkable STANCE exists from which the target is
// inside the envelope and actually visible - and "a path to some adjacent cell"
// is not that fact.
//
// Measured live (operator screenshot + log, Nether tunnel): a magma cube
// embedded in the wall beside the body. `distance <= MELEE_THREAT_REACH` made
// the gate return `reachable` unconditionally, the body leased the ATTACK, and
// every swing ended `MECHANICALLY_BLOCKED failure=verify_failed` /
// `out_of_reach` - health and ticks spent from a position the target could not
// be hit from. The same class on an enderman: the entity was sensed at 6.11 m,
// `pathfinder goal WAS set 5x`, the distance froze for ~47 s and ZERO swings
// landed, because no stance inside the melee envelope was reachable at all.
//
// So the OFFER is grounded on a stance, not on proximity:
//
//   standable + hazard-free + inside the melee envelope + line of sight
//   + (the body is already there, or the body can walk to it)
//
// The search reuses the tree's existing machinery and adds no parallel
// geometry: standability is the sensor's own `isStandable` rule, the hazard
// classes are `envHazard.ts`'s, the ray is the SAME `world.raycast` the threat
// cover logic casts, the reach measurement is the executor's own feet-to-feet
// distance, and the route verdict is the gate's existing path probe.
// ---------------------------------------------------------------------------

/** Why no stance can produce a blow on the entity. Typed; never a silent drop. */
export type AttackStandRefusal =
  /** no cell inside the melee envelope is a legal stance at all */
  | 'no_standable_cell'
  /** stances exist, but the nearest one is a hazard column */
  | 'hazardous_stand'
  /** legal stances exist, but the entity is occluded from every one of them */
  | 'no_line_of_sight'
  /** a legal, visible stance exists but the body cannot walk to it */
  | 'no_reachable_stand'

/** The single stance fact a refusal is reported from. */
export interface AttackStandRejection {
  cell: Vec3Json
  /** eye-to-aim-point distance from that stance, the way the executor measures it */
  distance: number
  reason: 'not_standable' | 'hazard' | 'occluded' | 'out_of_reach'
}

/** The stance verdict for one entity. `stand === null` means NO stance exists. */
export interface AttackStandFact {
  /** the nearest legal, hittable stance to the BODY, or null when none exists */
  stand: Vec3Json | null
  /** the melee distance from that stance to the entity's aim point */
  standDistance: number | null
  /** the body already stands on that stance, so a swing can land right now */
  onBody: boolean
  /** the nearest stance the search examined and refused, when it examined one */
  nearest: AttackStandRejection | null
  /** why no stance qualified; null exactly when `stand !== null` */
  refusal: AttackStandRefusal | null
}

/**
 * The world questions a stance search asks. The host wires these to live truth;
 * a fixture injects its own. Exactly the shape `InteractionStandProbe` uses for
 * block interaction stands (`executor.ts`), extended with the one fact a melee
 * stance needs and a block stand does not: whether the target is visible from it.
 */
export interface AttackStandWorld {
  /** THE standability rule (`state.ts isStandable`): feet+head passable over solid support */
  standable(x: number, y: number, z: number): boolean
  /** a hazard block occupies the stance's own column (fire / lava class) */
  hazard(x: number, y: number, z: number): boolean
  /** the same world raycast the cover logic uses: eyes at this stance -> the entity */
  visible(x: number, y: number, z: number): boolean
}

export interface AttackStandInput {
  /**
   * The sensed entity: its feet position and its own height. The aim point is
   * `position + height / 2` - the SAME point `runAttack` looks at before it
   * swings, so the visibility test and the swing agree about what is aimed at.
   */
  entity: { position: Vec3Json; height: number }
  /** the body's own feet position; the nearest stance to it is preferred */
  feet: Vec3Json
  /** the melee envelope (`MELEE_ATTACK_REACH`) */
  reach: number
  world: AttackStandWorld
}

/** The executor's own contact measurement, from a stance's block centre. */
export function stanceMeleeDistance(stance: Vec3Json, entityPosition: Vec3Json): number {
  return Math.hypot(
    entityPosition.x - (stance.x + 0.5),
    entityPosition.y - stance.y,
    entityPosition.z - (stance.z + 0.5),
  )
}

/**
 * The SAME measurement with the body's own height credited (`meleeReachDistance`):
 * the horizontal half of `stanceMeleeDistance` against the corrected vertical gap.
 *
 * At or below the stance's level this DELEGATES to `stanceMeleeDistance` verbatim,
 * so a level or downward target is not merely equal but bit-for-bit identical to
 * the pre-correction measurement - every existing offer keeps its exact number.
 * Above it, the gap loses the part the body's own height already spans.
 */
export function stanceReachDistance(stance: Vec3Json, entityPosition: Vec3Json): number {
  if (contactGapY(stance.y, entityPosition.y) <= 0) return stanceMeleeDistance(stance, entityPosition)
  return meleeReachDistance(
    Math.hypot(entityPosition.x - (stance.x + 0.5), entityPosition.z - (stance.z + 0.5)),
    contactGapY(stance.y, entityPosition.y),
  )
}

/**
 * The executor's own contact measurement, VERBATIM (`runAttack`): both endpoints
 * are feet positions. Used for the stance the body is already standing on, where
 * the body's real float position is known - a cell centre is only the estimate
 * for a cell the body would have to walk to, and using it for the body's own cell
 * would refuse a swing the executor takes at its own boundary.
 */
export function bodyMeleeDistance(bodyFeet: Vec3Json, entityPosition: Vec3Json): number {
  return Math.hypot(
    entityPosition.x - bodyFeet.x,
    entityPosition.y - bodyFeet.y,
    entityPosition.z - bodyFeet.z,
  )
}

/**
 * The body-position form of `stanceReachDistance`: the same correction applied to
 * the body's real float feet, for the stance the body is already standing on.
 * Delegates to `bodyMeleeDistance` verbatim at or below the body's level.
 */
export function bodyReachDistance(bodyFeet: Vec3Json, entityPosition: Vec3Json): number {
  if (contactGapY(bodyFeet.y, entityPosition.y) <= 0) return bodyMeleeDistance(bodyFeet, entityPosition)
  return meleeReachDistance(
    Math.hypot(entityPosition.x - bodyFeet.x, entityPosition.z - bodyFeet.z),
    contactGapY(bodyFeet.y, entityPosition.y),
  )
}

/**
 * THE EXECUTOR'S ENVELOPE TEST, as one call: the corrected distance for a target
 * ABOVE the body, and the executor's own historical 3-D feet-to-feet distance for
 * one at or below it.
 *
 * `distance` is that 3-D value (the loop already measures it for logging and for
 * the closing-stall tracker), `horizontal` its horizontal component. Passing both
 * keeps the level/downward case bit-for-bit identical rather than merely equal.
 */
export function meleeContactDistance(facts: {
  distance: number
  horizontal: number
  gapY: number
}): number {
  if (facts.gapY <= 0) return facts.distance
  return meleeReachDistance(facts.horizontal, facts.gapY)
}

/**
 * Every stance inside the melee envelope of the entity, nearest to the BODY
 * first, and the verdict for the nearest one that qualifies. Pure: the same
 * inputs always give the same `AttackStandFact`, and no bot, clock or model is
 * read here.
 *
 * The entity's OWN 1x2 column is not a stance - it is what the swing lands on -
 * and is excluded before any world read, so a mob standing in an open cell can
 * never offer its own cell as the position to hit it from.
 */
export function selectAttackStand(input: AttackStandInput): AttackStandFact {
  const entityFeet = {
    x: Math.floor(input.entity.position.x),
    y: Math.floor(input.entity.position.y),
    z: Math.floor(input.entity.position.z),
  }
  const bodyFeet = {
    x: Math.floor(input.feet.x),
    y: Math.floor(input.feet.y),
    z: Math.floor(input.feet.z),
  }
  const span = Math.ceil(input.reach)
  const stances: { cell: Vec3Json; distance: number; fromBody: number }[] = []
  for (let dy = -span; dy <= span; dy += 1) {
    for (let dx = -span; dx <= span; dx += 1) {
      for (let dz = -span; dz <= span; dz += 1) {
        const cell = { x: entityFeet.x + dx, y: entityFeet.y + dy, z: entityFeet.z + dz }
        // The entity's own body column: the swing's target, not a place to stand.
        if (dx === 0 && dz === 0 && (dy === 0 || dy === 1)) continue
        const onBody = cell.x === bodyFeet.x && cell.y === bodyFeet.y && cell.z === bodyFeet.z
        // The body's own stance is measured from where the body IS (the executor's
        // own expression); a stance it would walk to is measured from the cell.
        // BOTH credit the body's own height against a target above it, which is the
        // same measure `runAttack` compares against the same constant.
        const distance = onBody
          ? bodyReachDistance(input.feet, input.entity.position)
          : stanceReachDistance(cell, input.entity.position)
        if (distance > input.reach) continue
        stances.push({
          cell,
          distance,
          fromBody: Math.hypot(cell.x + 0.5 - input.feet.x, cell.z + 0.5 - input.feet.z),
        })
      }
    }
  }
  // Nearest to the BODY first, then nearest to the entity, then the stance that
  // needs the least VERTICAL move from where the body already is, then lowest.
  //
  // The vertical term is not decoration: crediting the body's own height makes a
  // cell one block BELOW the body measure the same as the body's own cell when the
  // target is one block ABOVE it, and without this the lowest cell won the tie and
  // the search preferred stepping DOWN over swinging from where the body stands.
  // Preferring the body's own level restores that: the same hittability for less
  // movement is the mechanically cheaper stance, and it is what the pre-existing
  // ordering picked before the reach correction existed.
  stances.sort(
    (a, b) =>
      a.fromBody - b.fromBody ||
      a.distance - b.distance ||
      Math.abs(a.cell.y - bodyFeet.y) - Math.abs(b.cell.y - bodyFeet.y) ||
      a.cell.y - b.cell.y,
  )

  let nearest: AttackStandRejection | null = null
  for (const stance of stances) {
    const onBody =
      stance.cell.x === bodyFeet.x && stance.cell.y === bodyFeet.y && stance.cell.z === bodyFeet.z
    // A stance the body is ALREADY in is still required to be standable and
    // hazard-free: uniform rule, no special case. A body standing in fire has a
    // grounded escape (RETREAT / the hazard-escape candidates), and trading hits
    // while burning is not the only position it can swing from.
    if (!input.world.standable(stance.cell.x, stance.cell.y, stance.cell.z)) {
      nearest ??= { cell: stance.cell, distance: stance.distance, reason: 'not_standable' }
      continue
    }
    if (input.world.hazard(stance.cell.x, stance.cell.y, stance.cell.z)) {
      nearest ??= { cell: stance.cell, distance: stance.distance, reason: 'hazard' }
      continue
    }
    if (!input.world.visible(stance.cell.x, stance.cell.y, stance.cell.z)) {
      // The screenshot shape: an entity in contact but with solid geometry
      // between the eyes and it. No swing from here can land.
      nearest ??= { cell: stance.cell, distance: stance.distance, reason: 'occluded' }
      continue
    }
    return { stand: stance.cell, standDistance: stance.distance, onBody, nearest, refusal: null }
  }
  return {
    stand: null,
    standDistance: null,
    onBody: false,
    nearest,
    refusal:
      nearest === null
        ? 'no_standable_cell'
        : nearest.reason === 'hazard'
          ? 'hazardous_stand'
          : nearest.reason === 'occluded'
            ? 'no_line_of_sight'
            : 'no_standable_cell',
  }
}

/** `NO_ATTACK_STAND` - the typed line for an attack no stance can land. */
export const NO_ATTACK_STAND = 'NO_ATTACK_STAND'

/**
 * The evidence one `no_attack_stand` withhold is mirrored with. Everything a
 * reviewer needs to see WHY the ATTACK was withheld without re-deriving the
 * geometry: the entity, the melee constant that decided it, the stance the
 * search refused, and - for `no_reachable_stand` - the stance that WAS legal
 * and visible together with the route verdict that refused it.
 */
export interface AttackStandEvidence {
  actionId: string
  entityId: number
  targetName: string | null
  entityPosition: Vec3Json
  /** the melee envelope the verdict was reached with (`MELEE_ATTACK_REACH`) */
  reach: number
  refusal: AttackStandRefusal
  nearest: AttackStandRejection | null
  /** the legal, visible stance that was refused for lack of a route, if any */
  stand: Vec3Json | null
  /** the gate's own route verdict for that stance */
  path: string | null
}

/**
 * The observability line for an ATTACK withheld BY CAN because no stance both
 * reaches the entity and can hit it. Mirrors `formatContactUnreachable`: it
 * names the entity, the constant, the nearest stance the search examined and
 * the fact that refused it, so a zero-swing lease is never the first evidence
 * that the body could not hit the target.
 */
export function formatNoAttackStand(evidence: AttackStandEvidence): string {
  const at = `${round2(evidence.entityPosition.x)},${round2(evidence.entityPosition.y)},${round2(evidence.entityPosition.z)}`
  const nearest =
    evidence.nearest === null
      ? 'none'
      : `${evidence.nearest.cell.x},${evidence.nearest.cell.y},${evidence.nearest.cell.z}`
  const nearestDistance = evidence.nearest === null ? 'none' : String(round2(evidence.nearest.distance))
  const nearestRefusal = evidence.nearest === null ? 'none' : evidence.nearest.reason
  const stand =
    evidence.stand === null ? 'none' : `${evidence.stand.x},${evidence.stand.y},${evidence.stand.z}`
  return (
    `${NO_ATTACK_STAND} actionId=${evidence.actionId} entity=e${evidence.entityId} ` +
    `target=${evidence.targetName ?? 'unknown'} at=${at} reach=${evidence.reach} reason=${evidence.refusal} ` +
    `nearest_stand=${nearest} nearest_distance=${nearestDistance} nearest_refusal=${nearestRefusal} ` +
    `stand=${stand} path=${evidence.path ?? 'unknown'} ` +
    `-> no stance within melee reach can land a swing on this entity; withheld by CAN, never leased as a 0-swing attempt`
  )
}

/** `HUNT_CONTACT_UNREACHABLE` - the typed line for a target no remedy reaches. */
export const HUNT_CONTACT_UNREACHABLE = 'HUNT_CONTACT_UNREACHABLE'

/**
 * WHICH proof established that the body's melee envelope cannot be brought onto
 * the target. Deliberately a ONE-member vocabulary, because code may only promote
 * what it can PROVE:
 *
 *   `vertical_gap` the geometry alone proves it: the target is more than the melee
 *       envelope above the body, a walk cannot change the body's level, and the
 *       3-D distance is at least the vertical component - so no horizontal
 *       position can produce a swing, and only a height gain could (which the
 *       melee ATTACK lease cannot express).
 *
 * A bounded approach that produces no closure is NOT promoted to this vocabulary:
 * that is an observation about the body's progress, not a proof that no route
 * exists, and the pinned `out_of_range` meaning ("stayed tracked but never entered
 * melee range inside the lease") already states it honestly.
 */
export type ContactUnreachableEvidence = 'vertical_gap'

/**
 * The observability line for a fight the body's melee envelope provably cannot
 * reach. It names the geometry (distance, its vertical component), WHICH proof
 * established the verdict, and the vertical planner's OWN typed refusal, so a
 * run-scoped reader can tell an unreachable producer from a 0-swing attempt
 * without inferring anything.
 */
export function formatContactUnreachable(input: {
  actionId: string
  entityId: number
  targetName: string | null
  evidence: ContactUnreachableEvidence
  approach: ContactApproach
  distance: number
  gapY: number
  /** horizontal component of the gap, when the caller measured it */
  horizontal?: number | null
  meleeReach: number
  walkGap: number
  /** the vertical planner's own refusal (`no_placeable` / `unsafe_column`) */
  ascentRefusal: string | null
  /** the carried block a pillar would consume, or null when none is held */
  placeable: string | null
}): string {
  const horizontal = input.horizontal === undefined || input.horizontal === null ? '' : ` horizontal=${round2(input.horizontal)}`
  return (
    `${HUNT_CONTACT_UNREACHABLE} actionId=${input.actionId} entity=e${input.entityId} ` +
    `target=${input.targetName ?? 'unknown'} evidence=${input.evidence} approach=${input.approach} ` +
    `distance=${round2(input.distance)}${horizontal} gap_y=${round2(input.gapY)} melee=${input.meleeReach} ` +
    `walk_gap=${input.walkGap} ` +
    `ascent_refusal=${input.ascentRefusal ?? 'none'} placeable=${input.placeable ?? 'none'} ` +
    `-> no grounded remedy brings melee contact onto this target; withheld by CAN, never leased as a 0-swing attempt`
  )
}

/** `MELEE_VERTICAL_REACH` - the typed line for a swing the body's OWN height grounds. */
export const MELEE_VERTICAL_REACH = 'MELEE_VERTICAL_REACH'

/**
 * WHICH way the corrected envelope decided one target's hittability.
 *
 * Deliberately the two facts a reviewer needs and nothing else:
 *   `grounded`  the corrected distance is inside the envelope and the feet-to-feet
 *               distance was NOT - i.e. the body's own height is the only reason
 *               this swing is legal. Without this line such a swing is
 *               indistinguishable in the record from an ordinary same-level one.
 *   `refused`   even after crediting the body's height the target is outside the
 *               envelope - the honest "still too far", which is what keeps the
 *               correction from being read as "everything is reachable now".
 */
export type MeleeVerticalReachOutcome = 'grounded' | 'refused'

/**
 * The observability line for the VERTICAL half of the melee envelope: it names the
 * entity, the distance as the executor measures it (feet-to-feet, 3-D), the
 * corrected distance the envelope is actually compared against, the vertical gap,
 * the body's own reach-up, and the melee constant - so a run-scoped reader can
 * tell "the body's own height is why this landed" from "the target was close" and
 * from "the target is still out of reach", without re-deriving any geometry.
 *
 * No mob is named by this vocabulary. A hovering blaze, a ghast, a phantom and a
 * skeleton on a ledge produce the same line with a different `target=`.
 */
export function formatMeleeVerticalReach(input: {
  outcome: MeleeVerticalReachOutcome
  actionId: string
  entityId: number
  targetName: string | null
  /** the executor's own measurement: 3-D feet-to-feet */
  distance: number
  /** the same gap with the body's own height credited (`meleeReachDistance`) */
  reachDistance: number
  horizontal: number
  gapY: number
  meleeReach: number
  /** how much of the vertical gap the body's own height already spans */
  reachUp: number
}): string {
  return (
    `${MELEE_VERTICAL_REACH} outcome=${input.outcome} actionId=${input.actionId} entity=e${input.entityId} ` +
    `target=${input.targetName ?? 'unknown'} distance=${round2(input.distance)} horizontal=${round2(input.horizontal)} ` +
    `gap_y=${round2(input.gapY)} reach_up=${input.reachUp} reach_distance=${round2(input.reachDistance)} melee=${input.meleeReach} ` +
    (input.outcome === 'grounded'
      ? `-> the target sits above the body's feet; the body's own height spans the first ${input.reachUp} of the gap, so this swing is inside the melee envelope`
      : `-> still outside the melee envelope after crediting the body's own height; the gap is real, not a measurement artifact`)
  )
}

/**
 * `COMBAT_OUTCOME` - one line per bounded combat commitment, naming the exact
 * entity id, how the lease ended, and that a vanished entity is NOT a kill.
 */
export function formatCombatOutcome(input: {
  outcome: CombatOutcome
  actionId: string
  entityId: number
  targetName: string | null
  swings: number
  hits: number
  /** how many times the SAME identity was re-acquired (never a different entity) */
  reacquires: number
  lastKnown: { x: number; y: number; z: number }
  ms: number
  /** for a HUNT_DROP: the item the declared postcondition names */
  goalDrop?: string | null
  /** for a HUNT_DROP: whether the drop reached the inventory (verified delta) */
  dropAcquired?: boolean
}): string {
  const drop = input.goalDrop === undefined || input.goalDrop === null ? '' : ` for=${input.goalDrop}`
  const acquired = input.dropAcquired === undefined ? '' : ` dropAcquired=${input.dropAcquired}`
  return (
    `COMBAT_OUTCOME outcome=${input.outcome} actionId=${input.actionId} entity=e${input.entityId} ` +
    `target=${input.targetName ?? 'unknown'}${drop} swings=${input.swings} hits=${input.hits} ` +
    `reacquires=${input.reacquires}${acquired} ` +
    `lastKnown=${round2(input.lastKnown.x)},${round2(input.lastKnown.y)},${round2(input.lastKnown.z)} ms=${input.ms} ` +
    `${killClaim(input.outcome)}`
  )
}

/** The one-word truth statement appended to every outcome line. */
function killClaim(outcome: CombatOutcome): string {
  switch (outcome) {
    case 'KILL_VERIFIED':
      return 'kill=verified'
    case 'DROP_NOT_ACQUIRED':
      return 'kill=verified drop=not_acquired'
    case 'TARGET_DESPAWNED':
      return 'kill=unproven reason=left_tracked_set_no_death_event'
    case 'TARGET_LOST':
      return 'kill=unproven reason=same_identity_reacquire_exhausted'
    case 'TARGET_INVALIDATED':
      return 'kill=unproven reason=target_became_invalid'
    case 'TARGET_UNREACHABLE':
      return 'kill=unproven reason=no_grounded_remedy_reaches_melee_contact'
    case 'COMBAT_INTERRUPTED':
      return 'kill=unproven reason=safety_or_lease_preemption'
    case 'COMBAT_TIMEOUT':
      return 'kill=unproven reason=bounded_lease_expired'
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
