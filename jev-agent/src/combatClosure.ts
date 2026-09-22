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
