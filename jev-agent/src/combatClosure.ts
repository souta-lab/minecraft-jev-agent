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
  if (!facts.tracked) return facts.reacquireExhausted ? 'TARGET_LOST' : 'TARGET_DESPAWNED'
  return 'COMBAT_TIMEOUT'
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
    case 'COMBAT_INTERRUPTED':
      return 'kill=unproven reason=safety_or_lease_preemption'
    case 'COMBAT_TIMEOUT':
      return 'kill=unproven reason=bounded_lease_expired'
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
