// criticalDamage.ts - SAFE: the body keeps losing health at critical health.
//
// Measured live (m3-live, `run-mubj6ucc-si3e`, source e37e0237, worktree
// 59784e7; `buddy-driver/logs/jev/run.jsonl`):
//
//   18:20:44.778Z hp_changed {health:13, previousHealth:14, food:0, delta:-1}
//   18:20:48.811Z hp_changed {health:12, previousHealth:13, food:0, delta:-1}
//   18:20:56.780Z hp_changed {health:10, previousHealth:11, food:0, delta:-1}
//   18:21:04.780Z hp_changed {health:8,  previousHealth:9,  food:0, delta:-1}
//   18:21:12.810Z hp_changed {health:6,  previousHealth:7,  food:0, delta:-1}
//   18:21:16.778Z hp_changed {health:5,  previousHealth:6,  food:0, delta:-1}
//   18:20:45.638Z trigger=damage_taken -> action=WAIT kind=WAIT | do nothing for one tick
//
// The 15 s HEARTBEAT sampling aliased those 1 HP starvation ticks into
// "health=14 -> 10 -> 6 -> 2 -> 1" (~4-point losses). The body was not being hit:
// every `mob_appeared` line in that window says "outside reaction range"
// (nearest zombie 29.3 m) and the world read shows an open pocket (air at
// y=52..55 under a stone ceiling at y=56), so neither a mob nor suffocation nor
// a >3-block fall explains it. `food:0` on `hp_changed` while `damage_taken`
// stays unattributed is starvation.
//
// What was missing: NOTHING owned "the body is at critical health and still
// taking damage, and the plan is not ending it". Every existing bound needs a
// different fact - `WAIT_EXHAUSTED` needs a chosen WAIT, `ACTION_FAILURE_*` a
// typed action failure, `PLACE_RETRIES_*` a placement failure, `LOCAL_RECOVERY_*`
// a suppressed replan - so at health 1, food 0, the resident answered each
// damage event with WAIT forever.
//
// This module is the deterministic, pure *evidence* owner for that missing
// fact. It counts consecutive damage observations at critical health for one
// plan and proves exhaustion; it never chooses WHAT comes next and never ranks
// candidates. The controller feeds the evidence to the candidate layer (only
// damage-ending routes stay offered) and crosses the System2 lifecycle boundary
// once per exhaustion with the typed `CRITICAL_DAMAGE_EXHAUSTED` marker.
//
// Same family as the landed SUBMERGED work (`src/candidates.ts`
// `restrictCandidatesDuringSubmersion`, `src/policy.ts` guard code `SUBMERGED`,
// `src/scheduler.ts` `LOW_AIR_PREEMPT`): a sensor fact, a candidate/CAN
// restriction, a guard precondition and a typed marker.

/**
 * At this health the body cannot absorb another damage event. Identical to the
 * scheduler's default `criticalHealth` in `shouldInterruptAttackLease` and to
 * `CRITICAL_COMBAT_HEALTH` in `candidates.ts`: one number for "critical", owned
 * here as the survival floor instead of being re-typed at each call site.
 */
export const CRITICAL_DAMAGE_HEALTH = 6

/**
 * How many consecutive damage observations at critical health one unchanged
 * plan may absorb before the local layer is code-proven unable to end it.
 *
 * Live shape: starvation deals 1 HP every 4 s, so 3 observations is ~12 s and
 * ~3 HP - enough to prove the plan is not ending the damage, far above one
 * unlucky hit, and far below the measured 62 s slide from 14 HP to 1 HP.
 */
export const CRITICAL_DAMAGE_LIMIT_DEFAULT = 3

/**
 * How much longer the count must grow after each exhausted consultation on the
 * SAME plan. Mirrors `strategicStallRequiredWindow`: an unbounded "escalate
 * every 3 damage ticks" would trade one failure (silence) for another (System2
 * spam). Each fired boundary doubles the requirement, bounded at 2**4.
 */
export const CRITICAL_DAMAGE_MAX_BACKOFF_EXPONENT = 4

export const CRITICAL_DAMAGE_MARKER = 'CRITICAL_DAMAGE'
export const CRITICAL_DAMAGE_EXHAUSTED_MARKER = 'CRITICAL_DAMAGE_EXHAUSTED'

/** The window required before the next boundary on one unchanged plan. */
export function criticalDamageRequiredLimit(limit: number, exhaustedRepeats: number): number {
  const exponent = Math.min(Math.max(0, exhaustedRepeats), CRITICAL_DAMAGE_MAX_BACKOFF_EXPONENT)
  return limit * 2 ** exponent
}

/** `BUDDY_CRITICAL_DAMAGE_LIMIT` overrides N; invalid values fall back. */
export function resolveCriticalDamageLimit(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_CRITICAL_DAMAGE_LIMIT ?? CRITICAL_DAMAGE_LIMIT_DEFAULT)
  return Number.isInteger(raw) && raw >= 1 ? raw : CRITICAL_DAMAGE_LIMIT_DEFAULT
}

/**
 * One damage observation, reduced to the facts this evidence needs. `health` /
 * `previousHealth` come straight from the scheduler's `hp_changed` detail (or
 * `health` alone from `damage_taken`); `planKey` is the controller's plan/goal
 * identity, so a semantic replan re-arms the count instead of firing on damage
 * the previous plan already absorbed.
 */
export interface CriticalDamageObservation {
  /** live health from the bot, HP (20 = full) */
  health: number
  /** health before this observation, or null when unknown */
  previousHealth: number | null
  /** plan/goal identity; a change re-arms the count */
  planKey: string
  /** live food level, or null when the sensor has no reading */
  food?: number | null
  /** Mineflayer-attributed attacker name, or null for environmental damage */
  sourceName?: string | null
}

/**
 * The exact code-owned evidence block handed to the candidate layer and logged.
 * Descriptive only: it says how much damage at critical health one plan has
 * absorbed, never which action to choose instead.
 */
export interface CriticalDamageEvidence {
  planKey: string
  /** live health at the last observation */
  health: number
  /** the critical-health floor this evidence is measured against */
  criticalHealth: number
  /** consecutive damage observations at critical health for this plan */
  consecutiveDamage: number
  /** the bounded count this plan must reach before the boundary fires */
  limit: number
  /** live food level, or null when unknown (0 = starving) */
  food: number | null
  /** attributed attacker name, or null for environmental/unattributed damage */
  sourceName: string | null
  /**
   * True when the last observation was fresh damage at or below the critical
   * floor. This is the sensor fact `restrictCandidatesDuringCriticalDamage`
   * reads: the body is in a damaging state right now.
   */
  active: boolean
  /**
   * True when this plan has absorbed `limit` consecutive damage observations at
   * critical health without ending them. This is the code-owned proof the
   * semantic layer may use as an exhaustion boundary.
   */
  exhausted: boolean
  /** Fired boundaries for this plan since the last plan change / health gain. */
  exhaustedRepeats: number
}

/** Evidence line: the damage-at-critical-health state itself, greppable and exact. */
export function formatCriticalDamageEvidence(goalKey: string, evidence: CriticalDamageEvidence): string {
  const source = evidence.sourceName ?? 'environment'
  const food = evidence.food === null ? 'unknown' : String(evidence.food)
  return (
    `${CRITICAL_DAMAGE_MARKER} goal=${goalKey} health=${evidence.health}/${evidence.criticalHealth} ` +
    `damage=${evidence.consecutiveDamage}/${evidence.limit} food=${food} source=${source} ` +
    `-> only routes that can end the damage stay offered`
  )
}

/** Boundary line: the plan is code-proven unable to end the damage. */
export function formatCriticalDamageExhausted(goalKey: string, evidence: CriticalDamageEvidence): string {
  const source = evidence.sourceName ?? 'environment'
  const food = evidence.food === null ? 'unknown' : String(evidence.food)
  return (
    `${CRITICAL_DAMAGE_EXHAUSTED_MARKER} goal=${goalKey} health=${evidence.health}/${evidence.criticalHealth} ` +
    `damage=${evidence.consecutiveDamage}/${evidence.limit} food=${food} source=${source} ` +
    `repeats=${evidence.exhaustedRepeats} -> wake System2`
  )
}

const INACTIVE = {
  consecutiveDamage: 0,
  active: false,
  exhausted: false,
} as const

/**
 * Damage-at-critical-health tracker for one plan. Pure and injectable: the
 * caller supplies observations and reads `evidence()`; there is no clock and no
 * bot.
 *
 * Semantics:
 *   - only a NEGATIVE health step at or below `criticalHealth` advances the
 *     count (that is a damage observation, not merely being hurt earlier);
 *   - any health gain, or any health above the floor, clears the count (real
 *     recovery is progress and must not be escalated on);
 *   - a different `planKey` re-arms the count and the repeat budget, so a
 *     semantic replan is given a fresh chance instead of inheriting the
 *     previous plan's exhaustion;
 *   - `exhausted` becomes true only when the count reaches the bounded
 *     `limit`, which grows after each fired boundary on the SAME plan;
 *   - `acknowledgeEscalation()` records a fired boundary and clears the count,
 *     so the next boundary needs a longer run and no hot wake loop is possible.
 */
export class CriticalDamageTracker {
  private readonly limit: number
  private planKey = ''
  private health = Number.NaN
  private food: number | null = null
  private sourceName: string | null = null
  private count = 0
  private exhaustedRepeats = 0

  constructor(limit: number = CRITICAL_DAMAGE_LIMIT_DEFAULT) {
    this.limit = Number.isInteger(limit) && limit >= 1 ? limit : CRITICAL_DAMAGE_LIMIT_DEFAULT
  }

  /** Re-arm when the active plan/goal changes (a semantic replan replaced it). */
  setPlan(planKey: string): void {
    if (planKey === this.planKey) return
    this.planKey = planKey
    this.count = 0
    this.exhaustedRepeats = 0
  }

  /** Record one damage/health observation and return the updated evidence. */
  note(observation: CriticalDamageObservation): CriticalDamageEvidence {
    this.setPlan(observation.planKey)
    this.food = typeof observation.food === 'number' && Number.isFinite(observation.food) ? observation.food : null
    this.sourceName =
      typeof observation.sourceName === 'string' && observation.sourceName.length > 0 ? observation.sourceName : null
    const health = Number.isFinite(observation.health) ? observation.health : this.health
    const previous = observation.previousHealth
    if (Number.isFinite(health)) {
      this.health = health
      if (health > CRITICAL_DAMAGE_HEALTH) {
        // Recovered above the floor: the damaging state is over.
        this.count = 0
      } else if (typeof previous === 'number' && Number.isFinite(previous)) {
        if (health < previous) this.count += 1
        else if (health > previous) this.count = 0
        // health === previous: still critical, no fresh damage -> unchanged.
      }
    }
    return this.evidence()
  }

  /** Current evidence without recording anything. Never mutates. */
  evidence(): CriticalDamageEvidence {
    const health = Number.isFinite(this.health) ? this.health : 0
    const required = criticalDamageRequiredLimit(this.limit, this.exhaustedRepeats)
    const critical = Number.isFinite(this.health) && health <= CRITICAL_DAMAGE_HEALTH
    const active = critical && this.count > 0
    return {
      planKey: this.planKey,
      health,
      criticalHealth: CRITICAL_DAMAGE_HEALTH,
      consecutiveDamage: active ? this.count : INACTIVE.consecutiveDamage,
      limit: required,
      food: this.food,
      sourceName: this.sourceName,
      active,
      exhausted: active && this.count >= required,
      exhaustedRepeats: this.exhaustedRepeats,
    }
  }

  /**
   * A boundary fired for the current exhaustion. The count is cleared (the
   * evidence was consumed) and the next boundary on the SAME plan needs twice
   * as many observations, so a persistent damaging state cannot hot-loop
   * System2 consultations.
   */
  acknowledgeEscalation(): CriticalDamageEvidence {
    this.exhaustedRepeats += 1
    this.count = 0
    return this.evidence()
  }

  reset(): void {
    this.count = 0
    this.exhaustedRepeats = 0
  }
}
