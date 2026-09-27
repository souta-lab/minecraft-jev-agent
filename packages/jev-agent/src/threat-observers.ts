// threat-observers.ts — legacy threat/environmental-hazard observation.
//
// Extracted from `controller.ts`. These functions turn sensed threat,
// critical-damage, ranged-contact, and env-hazard evidence into tracker
// updates (`ThreatTracker` / `CriticalDamageTracker` / `EnvHazardTracker`),
// signal writes, dedup'd log rows, and typed escalation calls. They own no
// authority: reflexes and retreats are still decided by the caller; this
// module only observes, attributes, and reports.
//
// The host members mirror the former private-method surface one-for-one so
// the plain-object fixture seam is unchanged.

import type { Bot } from 'mineflayer'
import { envHazardEscapeRoutes, envHazardEscapeSpots, IMMEDIATE_HOSTILE_RANGE } from './candidates.ts'
import type { Candidate, EnvHazardReflex, ThreatOffer } from './candidates.ts'
import {
  CRITICAL_DAMAGE_EXHAUSTED_MARKER,
  CriticalDamageTracker,
  formatCriticalDamageEvidence,
  formatCriticalDamageExhausted,
  sampleHealthTransition,
} from './criticalDamage.ts'
import {
  ENV_HAZARD_CLEAR,
  ENV_HAZARD_NO_EXIT,
  EnvHazardTracker,
  envHazardDamageSource,
  formatEnvHazard,
  formatEnvHazardClear,
  formatEnvHazardNoExit,
  formatEnvHazardReflexEvidence,
} from './envHazard.ts'
import type { EventLogger } from './jev.ts'
import type { BlacklistedMoveTargets } from './moveFailMemory.ts'
import {
  formatReflex,
  formatSkillInterrupt,
  formatSkillPolicyBoundary,
  formatSkillStep,
  formatSkillStepAuthority,
  SKILL_INTERRUPT,
  SKILL_POLICY_BOUNDARY,
} from './netherPortalPlan.ts'
import type { SkillPolicyBoundaryReason } from './netherPortalPlan.ts'
import type { InFlightAction } from './policy.ts'
import type { DecisionTrigger } from './scheduler.ts'
import { BODY_STARVING, bodyStarving, formatBodyStarving } from './state.ts'
import type { AgentSignals, Vec3Json, WorldState } from './state.ts'
import {
  assessSurvivalRace,
  bodySurvivalFacts,
  classifyDamageSource,
  formatSurvivalDamageRace,
  formatSurvivalEscapeNone,
  formatThreatBreakContact,
  formatThreatClear,
  formatThreatNearby,
  formatThreatNoEscape,
  formatThreatOccluded,
  formatThreatRangedUnanswered,
  SURVIVAL_DAMAGE_RACE,
  SURVIVAL_ESCAPE_NONE,
  THREAT_BREAK_CONTACT,
  THREAT_CLEAR,
  THREAT_CLEAR_MS,
  THREAT_NEARBY,
  THREAT_OCCLUDED,
  ThreatTracker,
  unansweredRangedThreats,
  unsensedAttackerFacts,
  unsensedThreatResponse,
  weaponFacts,
} from './threat.ts'
import type { MobIdentityContext } from './threat.ts'
import type { EscalationReason } from './escalation.ts'

/** Narrow host surface for the threat/env-hazard observer slice. */
export interface ThreatObserverHost {
  bot: Bot
  logger: EventLogger
  tickCounter: number
  signals: AgentSignals
  queue: { readonly current: { readonly id?: string; readonly kind?: string } | null }
  readonly threat: ThreatTracker
  readonly criticalDamage: CriticalDamageTracker
  readonly envHazard: EnvHazardTracker

  // Observer state (dedup keys and trackers carried on the shell).
  threatWasActive: boolean
  lastThreatLine: string | null
  lastThreatGapLine: string | null
  lastRangedThreatLine: string | null
  lastBreakContactLine: string | null
  lastThreatOccludedLine: string | null
  lastSurvivalRaceLine: string | null
  lastCriticalDamageLine: string | null
  lastReflexLine: string | null
  lastEnvBoundaryLine: string | null
  lastEnvHazardLine: string | null
  lastEnvHazardGapLine: string | null
  lastObservedHealth: number | null
  damageObservedThisTick: boolean
  waitSuppressed: boolean

  // Callbacks that stay on the shell.
  currentGoalKey(): string
  blacklistedMoveTargets(state: WorldState): BlacklistedMoveTargets
  escalate(reason: EscalationReason, detail: string): void

  // Inter-module observer calls dispatched through the shell.
  envHazardAttribution(): string | null
  observeCriticalDamage(trigger: DecisionTrigger, detail: Record<string, unknown>): void
}

export function observeThreat(host: ThreatObserverHost, trigger: DecisionTrigger, detail: Record<string, unknown>, currentHealth: number): void {
    const now = Date.now()
    if (trigger === 'damage_taken') {
      const sourceId =
        typeof detail.attackerId === 'number' && Number.isFinite(detail.attackerId) ? detail.attackerId : null
      const sourceName = typeof detail.attackerName === 'string' && detail.attackerName.length > 0 ? detail.attackerName : null
      const sourcePosition = damageOrigin(detail.attackerPosition)
      host.signals.lastDamage = {
        atMs: now,
        health: currentHealth,
        sourceId,
        sourceName,
        // The server-stated damage ORIGIN (the scheduler reads it off the
        // `damage_event` packet, which mineflayer's `entityHurt` drops). This is
        // the fact that lets the body ground a direction to break contact with an
        // attacker it cannot see. Absent means UNKNOWN - the field is left off
        // rather than filled with a guess.
        ...(sourcePosition === null ? {} : { sourcePosition }),
      }
      return
    }
    if (trigger !== 'hp_changed') return
    const delta = typeof detail.delta === 'number' ? detail.delta : 0
    if (delta >= 0) return
    const previous = host.signals.lastDamage ?? null
    const sameBurst = previous !== null && now - previous.atMs <= 1500
    host.signals.lastDamage = {
      atMs: now,
      health: typeof detail.health === 'number' ? detail.health : currentHealth,
      sourceId: sameBurst ? previous.sourceId : null,
      sourceName: sameBurst ? previous.sourceName : null,
      // Attribution follows the same-burst rule as identity: a negative health
      // step inside the same hit burst keeps the origin the damage event stated,
      // and a step outside it keeps nothing (an origin without a source is not
      // an attacker).
      ...(sameBurst && previous?.sourcePosition !== undefined && previous.sourcePosition !== null
        ? { sourcePosition: previous.sourcePosition }
        : {}),
    }
  }

  /**
   * SAFE: the bounded danger STATE no other counter owns.
   *
   * `restrictCandidatesDuringImmediateThreat` is a per-tick predicate: it arms
   * while a hostile is inside `IMMEDIATE_HOSTILE_RANGE` in the CURRENT snapshot.
   * Measured live, that let the body retreat once and go straight back to
   * digging the moment the mob's snapshot moved outside it; the zombie followed,
   * landed the next hit, and health eroded 20 -> 18 -> 16 -> 2 -> death over a
   * minute (eight deaths in seven minutes, `run-mubobiq6-12onv`). This tracker
   * owns the missing state: enter on the threat predicate, stay while any
   * hostile is inside the bounded danger radius or has engaged the body, and
   * leave only after the whole envelope has been continuously clear for
   * `THREAT_CLEAR_MS`.
   *
   * The typed `THREAT_NEARBY` line is emitted on a change with the mob name,
   * distance, contact/danger flags, the code-owned weapon the body holds and
   * whether the body can regenerate at all - so a post-mortem never has to guess
   * what killed the body or what it was holding. `THREAT_CLEAR` records the
   * bounded exit.
   */

export function observeThreatState(host: ThreatObserverHost, state: WorldState): void {
    const evidence = host.threat.note({
      atMs: state.timestampMs,
      entities: state.entities,
      lastDamage: state.signals.lastDamage ?? null,
    })
    host.signals.threat = evidence
    state.signals = { ...state.signals, threat: evidence }
    const goalKey = host.currentGoalKey()
    if (!evidence.active) {
      host.lastThreatLine = null
      if (host.threatWasActive) {
        host.threatWasActive = false
        host.logger.info(
          'agent',
          formatThreatClear(goalKey, evidence),
          { clearMs: evidence.clearMs, clearForMs: evidence.clearForMs },
          host.tickCounter,
        )
      }
      return
    }
    host.threatWasActive = true
    const weapon = weaponFacts(state.self.heldItem?.name ?? null)
    const line = formatThreatNearby(goalKey, evidence, weapon, bodySurvivalFacts(state.self))
    // Bounded dedup: the line carries `activeMs`, which changes every decision,
    // so the signature drops it and keeps the facts a post-mortem needs
    // (identity, whole-metre distance, contact/danger, envelope size, weapon). A
    // mob hovering at the same distance does not re-log every tick.
    const signature = [
      evidence.threatId,
      evidence.threatName,
      evidence.inContact ? 'contact' : evidence.inDanger ? 'danger' : 'engaged',
      evidence.threatDistance === null ? 'na' : Math.round(evidence.threatDistance),
      evidence.hostileCount,
      weapon.name ?? 'fists',
    ].join('|')
    if (signature === host.lastThreatLine) return
    host.lastThreatLine = signature
    host.logger.warn(
      'agent',
      line,
      {
        threat: evidence.threatName,
        threatId: evidence.threatId,
        distance: evidence.threatDistance,
        contact: evidence.inContact,
        danger: evidence.inDanger,
        entryReason: evidence.entryReason,
        activeMs: evidence.activeMs,
        weapon: state.self.heldItem?.name ?? 'fists',
        food: state.self.food,
        health: state.self.health,
      },
      host.tickCounter,
    )
  }

  /**
   * The code-owned identity facts the bounded mob-churn rule reads
   * (`threat.ts` `MobIdentityContext`).
   *
   * `previousEntityTracked` is read from the CLIENT's tracked set (`bot.entities`),
   * never from the sensor snapshot: the sensor is a bounded radius, so "gone from
   * the snapshot" cannot be told apart from "walked 30 m away", while
   * `bot.entities[id] === undefined` means the server destroyed that exact id
   * (`entity_destroy`). An entity that is present but `isValid === false` counts as
   * gone for the same reason; anything the controller cannot resolve (no candidate
   * entity id) stays `null` = UNKNOWN, and the rule refuses.
   *
   * `knownEntityIds` is the DECISION-time snapshot, so the rule can require the
   * replacement to be an entity that appeared during the churn window instead of a
   * bystander of the same kind that was already standing there.
   */

export function observeUnansweredRangedThreat(host: ThreatObserverHost, state: WorldState): void {
    const unanswered = unansweredRangedThreats(state.entities)
    const threat = unanswered[0] ?? null
    const sourceName = state.signals.lastDamage?.sourceName ?? null
    // The unsensed case: the attacker is named by the damage attribution and is
    // NOT in the sensor snapshot. `unsensedAttackerFacts` owns that predicate
    // (identity + recency + absence), so the marker, the offer restriction and
    // the death telemetry all read ONE fact instead of three near-copies.
    const attacker = unsensedAttackerFacts(state)
    const unsensed = threat === null && attacker !== null
    if (threat === null && !unsensed) {
      host.lastRangedThreatLine = null
      return
    }
    // What the body can still DO: the sensor builds its escape/cover cells for
    // the attributed origin too, so a non-empty escape set is a real grounded
    // destination. No cells means no direction could be grounded - which the
    // marker says explicitly instead of implying there is no threat.
    const escapeCells = state.terrain.escapeCells ?? []
    const coverCells = state.terrain.threatCoverCells ?? []
    const response = unsensedThreatResponse({
      attacker,
      groundedDestinations: attacker?.position === null ? 0 : escapeCells.length + coverCells.length,
      coverCells: coverCells.length,
      availableMoves: escapeCells.length + coverCells.length,
    })
    const line = formatThreatRangedUnanswered({
      goalKey: host.currentGoalKey(),
      threat,
      sourceName: unsensed ? (attacker?.name ?? sourceName) : null,
      body: bodySurvivalFacts(state.self),
      weapon: weaponFacts(state.self.heldItem?.name ?? null),
      attacker,
      response: attacker === null ? undefined : response,
    })
    if (line === host.lastRangedThreatLine) return
    host.lastRangedThreatLine = line
    host.logger.warn(
      'agent',
      line,
      {
        threat: threat?.name ?? attacker?.name ?? sourceName,
        distance: threat?.distance ?? null,
        sensed: threat !== null,
        standoff: threat?.standoff ?? attacker?.standoff ?? null,
        sourcePosition: attacker?.position ?? null,
        response: attacker === null ? null : response.kind,
        missing: response.missing,
        health: state.self.health,
        weapon: state.self.heldItem?.name ?? 'fists',
        source: sourceName,
      },
      host.tickCounter,
    )
    // The bounded break-contact evidence: no destination could be grounded from
    // the damage attribution, so the body's only answer is to keep moving. This
    // is the typed statement that the body is NOT idle, and exactly which facts
    // were missing to do better.
    if (attacker === null || response.grounded || response.kind !== 'break_contact') {
      host.lastBreakContactLine = null
      return
    }
    const moves = (state.terrain.escapeCells ?? []).map((cell) => `${cell.x},${cell.y},${cell.z}`)
    const breakLine = formatThreatBreakContact({
      goalKey: host.currentGoalKey(),
      attacker,
      response,
      body: bodySurvivalFacts(state.self),
      weapon: weaponFacts(state.self.heldItem?.name ?? null),
      availableMoves: moves,
    })
    if (breakLine === host.lastBreakContactLine) return
    host.lastBreakContactLine = breakLine
    host.logger.warn(
      'guard',
      breakLine,
      {
        marker: THREAT_BREAK_CONTACT,
        threat: attacker.name,
        attackerId: attacker.id,
        sourcePosition: attacker.position,
        missing: response.missing,
        response: response.kind,
        health: state.self.health,
        food: state.self.food,
      },
      host.tickCounter,
    )
  }

  /** Current CAN says the conservative proximity threat is occluded/unreachable. */

export function logThreatOccluded(host: ThreatObserverHost, offer: ThreatOffer): void {
    if (offer.occluded === null || offer.threat === null) {
      host.lastThreatOccludedLine = null
      return
    }
    const line = formatThreatOccluded(host.currentGoalKey(), offer.threat, offer.occluded.entityIds)
    if (line === host.lastThreatOccludedLine) return
    host.lastThreatOccludedLine = line
    host.logger.info(
      'agent',
      line,
      {
        marker: THREAT_OCCLUDED,
        threat: offer.threat.threatName,
        ids: offer.occluded.entityIds,
        distance: offer.threat.threatDistance,
        reason: offer.occluded.reason,
      },
      host.tickCounter,
    )
  }

  /**
   * Mirror the escape-versus-damage fact while a hostile is ON the body: the
   * measured shape is a body whose every grounded `RETREAT` was re-grounded onto a
   * cell that never broke contact (`buddy.log` 2026-09-22T10:49:5x: distance 2.98 m
   * -> 2.06 m, health 16.704 -> 8.316 -> dead in ~4 s). Without this line the death
   * is indistinguishable from a body that had nowhere to go, and the difference
   * decides whether the fix is "ground a real escape" or "the race was lost".
   *
   * Emitted only while the threat is ACTIVE and in CONTACT: an ordinary danger-band
   * tick is not a race, and the marker must not become per-tick noise. When the body
   * has no landable escape at all the same facts are mirrored as
   * `SURVIVAL_ESCAPE_NONE ... outcome=CAPABILITY_LOST`.
   */

export function logSurvivalRace(host: ThreatObserverHost, state: WorldState, offer: ThreatOffer): void {
    const evidence = offer.threat
    if (evidence === null || evidence.active !== true || !evidence.inContact) {
      host.lastSurvivalRaceLine = null
      return
    }
    const escapes = offer.candidates
      .filter((candidate) => candidate.kind === 'RETREAT')
      .map((candidate) => ({
        separationGain:
          typeof candidate.meta.separationGain === 'number' && Number.isFinite(candidate.meta.separationGain)
            ? candidate.meta.separationGain
            : 0,
        outsideReach: candidate.meta.outsideReach === true,
      }))
    const lastDamage = state.signals.lastDamage ?? null
    const facts = assessSurvivalRace({
      evidence,
      body: bodySurvivalFacts(state.self),
      weapon: weaponFacts(state.self.heldItem?.name ?? null),
      damage: classifyDamageSource(lastDamage, state.entities),
      escapes,
      damageAgoMs:
        lastDamage === null || !Number.isFinite(lastDamage.atMs) ? null : Math.max(0, state.timestampMs - lastDamage.atMs),
    })
    const line = facts.escape === 'none' ? formatSurvivalEscapeNone(facts) : formatSurvivalDamageRace(facts)
    if (line === host.lastSurvivalRaceLine) return
    host.lastSurvivalRaceLine = line
    host.logger.warn(
      'agent',
      line,
      {
        marker: facts.escape === 'none' ? SURVIVAL_ESCAPE_NONE : SURVIVAL_DAMAGE_RACE,
        threat: facts.threatName,
        threatId: facts.threatId,
        distance: facts.distance,
        contact: facts.contact,
        source: facts.damage.source,
        sourceName: facts.damage.name,
        health: facts.body.health,
        food: facts.body.food,
        weapon: facts.weapon.name,
        escapes: facts.escapeCount,
        escapesOutsideReach: facts.escapesOutsideReach,
        bestSeparationGain: facts.bestSeparationGain,
        escape: facts.escape,
        damageAgoMs: facts.damageAgoMs,
        reason: facts.reason,
      },
      host.tickCounter,
    )
  }

  /**
   * Mirror the code-owned threat capability gap: the body is under threat and
   * the deterministic layer could ground neither an attack nor a keep-distance
   * route, so only a bounded ESCALATE is offered. This is the honest replacement
   * for the old fallback that returned the work set while a zombie was inside
   * melee reach.
   */

export function logThreatGap(host: ThreatObserverHost, state: WorldState, offer: ThreatOffer): void {
    if (offer.gap === null || offer.threat === null) {
      host.lastThreatGapLine = null
      return
    }
    const line = formatThreatNoEscape(
      host.currentGoalKey(),
      offer.threat,
      weaponFacts(state.self.heldItem?.name ?? null),
      `${offer.gap.reason}${offer.inContact ? '@contact' : '@danger'}`,
    )
    if (line === host.lastThreatGapLine) return
    host.lastThreatGapLine = line
    host.logger.warn(
      'agent',
      line,
      {
        threat: offer.threat.threatName,
        distance: offer.threat.threatDistance,
        inContact: offer.inContact,
        reason: offer.gap.reason,
      },
      host.tickCounter,
    )
  }

  /**
   * SAFE: the survival fact no other counter owns. `damage_taken` / `hp_changed`
   * carry the health step, so this records consecutive damage at critical health
   * for the ACTIVE plan; the code-owned `bodyStarving` sensor fact is fed on
   * every decision so the durable critical STARVING state arms the same counter
   * even when no damage event arrives (the measured live plateau: health 1,
   * food 0, no further `hp_changed`). Once the bounded count is exhausted it logs
   * the typed `CRITICAL_DAMAGE_EXHAUSTED` (or `BODY_STARVING` when the hunger bar
   * is empty), removes WAIT for one decision, and wakes System2 through the same
   * `escalate()` path #326/#337 use. The choice of WHAT ends the damage stays
   * with Jev; this only proves the current plan is not ending it.
   *
   * Health is de-duplicated against the controller's own last observation, not
   * `detail.previousHealth`: both triggers can be delivered for one damage event
   * (and the scheduler's coalescing keeps only `damage_taken`), so counting the
   * step itself is what makes one hit cost exactly one.
   */

export function observeCriticalDamage(host: ThreatObserverHost, trigger: DecisionTrigger, detail: Record<string, unknown>): void {
    const rawHealth = typeof detail.health === 'number' && Number.isFinite(detail.health) ? detail.health : host.bot.health
    const health = typeof rawHealth === 'number' && Number.isFinite(rawHealth) ? rawHealth : Number.NaN
    const rawFood = typeof detail.food === 'number' && Number.isFinite(detail.food) ? detail.food : host.bot.food
    const food = typeof rawFood === 'number' && Number.isFinite(rawFood) ? rawFood : null
    const planKey = `${host.currentGoalKey()}|${host.queue.current?.id ?? 'none'}`
    if (trigger === 'damage_taken' || trigger === 'hp_changed') {
      // A fresh damage observation advances the event counter exactly once per
      // health step. Only damage triggers may overwrite `lastObservedHealth`: a
      // non-damage tick that did so would erase the step before it is counted.
      const previousHealth = host.lastObservedHealth
      if (Number.isFinite(health)) host.lastObservedHealth = health
      // The environmental-hazard tracker counts the SAME observation. A real
      // negative health step is damage; a `damage_taken` event with no comparable
      // step (a respawn/hot-reload boundary) is still a hit.
      if (
        (typeof previousHealth === 'number' && Number.isFinite(previousHealth) && health < previousHealth) ||
        (trigger === 'damage_taken' && !(typeof previousHealth === 'number' && Number.isFinite(previousHealth)))
      ) {
        host.damageObservedThisTick = true
      }
      host.criticalDamage.note({
        health,
        previousHealth,
        planKey,
        food,
        // SAFE: Mineflayer's attribution wins; when there is none and the body's
        // own hazard state names a damage-dealing environmental cause, that cause
        // is the honest source (`source=fire` instead of the measured
        // `source=environment` while burning). `envHazardDamageSource` refuses to
        // attribute damage to a hazard that cannot deal it (`adjacent_lava`
        // alone).
        sourceName: host.signals.lastDamage?.sourceName ?? host.envHazardAttribution(),
      })
    }
    // SAFE: the critical STARVING state is a durable sensor fact, not an event.
    // On this server starvation damage floors at 1 HP, so the measured live body
    // (health 1, food 0, no food item, no `hp_changed` for a whole generation)
    // never armed the event counter and idled with no escalation. Feeding the
    // state fact on every decision - not only on a damage trigger - lets the same
    // bounded boundary fire; a grounded food route that actually ends the
    // starvation clears the fact and resets the count on the next decision.
    const starving = food !== null && bodyStarving({ food, health })
    const evidence = host.criticalDamage.noteStarving({ planKey, health, food, starving })
    host.signals.criticalDamage = evidence
    const goalKey = host.currentGoalKey()
    if (!evidence.active) {
      host.lastCriticalDamageLine = null
      return
    }
    const entity = host.bot.entity
    const at = entity === undefined ? { x: 0, y: 0, z: 0 } : entity.position
    const line =
      evidence.food !== null && bodyStarving({ food: evidence.food, health: evidence.health })
        ? formatBodyStarving({ food: evidence.food, health: evidence.health }, at)
        : formatCriticalDamageEvidence(goalKey, evidence)
    if (line !== host.lastCriticalDamageLine) {
      host.lastCriticalDamageLine = line
      host.logger.warn(
        'agent',
        line,
        {
          health: evidence.health,
          food: evidence.food,
          source: evidence.sourceName,
          damage: evidence.consecutiveDamage,
          limit: evidence.limit,
        },
        host.tickCounter,
      )
    }
    if (!evidence.exhausted) return
    host.logger.warn(
      'agent',
      formatCriticalDamageExhausted(goalKey, evidence),
      {
        health: evidence.health,
        food: evidence.food,
        source: evidence.sourceName,
        damage: evidence.consecutiveDamage,
        limit: evidence.limit,
        boundary: 'semantic_boundary',
      },
      host.tickCounter,
    )
    // Consume the evidence (the next boundary needs a longer run on the same
    // plan) and force the next decision to pick a real candidate, so the body
    // cannot settle into an unbounded WAIT while it keeps losing health.
    host.signals.criticalDamage = host.criticalDamage.acknowledgeEscalation()
    host.lastCriticalDamageLine = null
    host.waitSuppressed = true
    host.escalate(
      'progress_stall',
      `CRITICAL_DAMAGE_EXHAUSTED goal=${goalKey} health=${evidence.health} food=${evidence.food ?? 'unknown'} damage=${evidence.consecutiveDamage}/${evidence.limit} source=${evidence.sourceName ?? 'environment'}`,
    )
  }

  /**
   * SAFE (issue #436 §8/§17): the hard-safety reflex telemetry.
   *
   * Three lines, all emitted only after the guard accepted the candidate so a
   * line can never claim an action the mechanical checks refused:
   *
   *   SKILL_STEP ... authority=HARD_SAFETY_REFLEX budget=1
   *     the §17 layer: this step was an immediate safety stabilisation, not a
   *     mechanical continuation of the selected Skill;
   *   REFLEX ownerSkill=<the interrupted skill> reason=hard_safety action=<what>
   *     evidence=<the block/flag that proved it>
   *     the §8 proof: code was allowed to finish exactly this action;
   *   SKILL_INTERRUPT + SKILL_POLICY_BOUNDARY skill=... reason=hard_safety_interrupt
   *     alternatives=[...]
   *     the boundary: the in-flight Skill was preempted and the decision returns
   *     to the semantic controller with the other grounded routes exposed.
   *
   * The REFLEX line is de-duplicated by its own facts so a persistent hazard
   * does not re-log every tick.
   */

export function logReflex(host: ThreatObserverHost, 
    reflex: EnvHazardReflex,
    state: WorldState,
    inFlight: InFlightAction | null,
    alternatives: readonly string[],
  ): void {
    const interruptReason: SkillPolicyBoundaryReason = 'hard_safety_interrupt'
    const evidence = formatEnvHazardReflexEvidence(host.envHazard.evidence())
    const ownerSkill = inFlight?.id ?? state.currentOption?.templateId ?? host.currentGoalKey()
    const line = formatReflex({
      ownerSkill,
      reason: 'hard_safety',
      action: reflex.candidate.id,
      evidence,
    })
    if (line !== host.lastReflexLine) {
      host.lastReflexLine = line
      host.logger.warn(
        'policy',
        line,
        {
          ownerSkill,
          reason: 'hard_safety',
          action: reflex.candidate.id,
          kind: reflex.kind,
          escapeKind: reflex.escapeKind,
          evidence,
          goal: host.currentGoalKey(),
        },
        host.tickCounter,
      )
    }
    host.logger.warn(
      'policy',
      formatSkillStep(
        ownerSkill,
        'env_hazard_stabilize',
        formatSkillStepAuthority('HARD_SAFETY_REFLEX', evidence, 'stabilize_one_step', { budget: 1 }),
      ),
      {
        ownerSkill,
        authority: 'HARD_SAFETY_REFLEX',
        stepKind: 'env_hazard_stabilize',
        budget: 1,
        action: reflex.candidate.id,
        kind: reflex.kind,
        target: reflex.candidate.target,
      },
      host.tickCounter,
    )
    if (inFlight === null) return
    host.logger.warn(
      'policy',
      `${formatSkillInterrupt(inFlight.id, reflex.kind)} -> kind=${inFlight.kind} reflex=${reflex.candidate.id}`,
      {
        reason: reflex.kind,
        interrupted: inFlight.id,
        interruptedKind: inFlight.kind,
        reflex: reflex.candidate.id,
      },
      host.tickCounter,
    )
    // §8: the reflex may preempt, but the decision then returns to the semantic
    // controller - which the boundary line records with the remaining grounded
    // routes exposed.
    host.logger.warn(
      'policy',
      formatSkillPolicyBoundary({
        skill: inFlight.id,
        reason: interruptReason,
        alternatives,
      }),
      { skill: inFlight.id, reason: 'hard_safety_interrupt', alternatives, authority: 'HARD_SAFETY_REFLEX' },
      host.tickCounter,
    )
  }

  /**
   * SAFE (issue #436 §8/§17): the boundary where code must NOT take over.
   *
   * The body is in an environmental hazard with an in-flight Skill, and the exit
   * is not a unique immediate stabilisation - either several grounded routes
   * exist (Jev's WHICH) or none does (the typed `ENV_HAZARD_NO_EXIT` gap). This
   * line names that boundary and exposes the grounded alternatives so a reviewer
   * can see that code returned the decision instead of picking a destination.
   */

export function logEnvHazardBoundary(host: ThreatObserverHost, 
    state: WorldState,
    candidates: readonly Candidate[],
    inFlight: InFlightAction | null,
  ): void {
    const hazard = state.self.envHazard ?? null
    if (hazard?.active !== true || hazard.escapeRequired !== true || inFlight === null) return
    const routes = envHazardEscapeRoutes(state, candidates)
    const reason: SkillPolicyBoundaryReason =
      routes.length === 0 ? 'no_grounded_escape' : 'multiple_grounded_escapes'
    const line = formatSkillPolicyBoundary({
      skill: inFlight.id,
      reason,
      alternatives: routes.map((route) => route.id),
    })
    if (line === host.lastEnvBoundaryLine) return
    host.lastEnvBoundaryLine = line
    host.logger.warn(
      'policy',
      line,
      {
        skill: inFlight.id,
        reason,
        alternatives: routes.map((route) => route.id),
        kind: hazard.kinds.join('+'),
      },
      host.tickCounter,
    )
  }

  /**
   * The synthetic decision a hard-safety reflex carries: the SAME downstream
   * pipeline (decision record, guard, executor claim) with an explicit
   * provenance that is neither Jev nor the deterministic fallback, and NO model
   * call. `answers.action` is the one authoritative choice the executor reads.
   */

export function envHazardAttribution(host: ThreatObserverHost): string | null {
    const evidence = host.envHazard.evidence()
    if (!evidence.active) return null
    return envHazardDamageSource(evidence.kinds)
  }

  /**
   * SAFE: the body's own environmental-hazard telemetry (fire / lava / burning /
   * drowning).
   *
   * Measured live (`run-mucaq28q-1ftq1`, main 99f0020): the body burned to death
   * in the Nether, every tick arrived as `source=environment`, and a scan of the
   * whole run found FIRE 0 | LAVA 0 | HAZARD_FIRE 0 | IN_FIRE 0 | BURN 0 - the
   * system had NO state for it. This mirrors the sensed fact as `ENV_HAZARD`
   * (with the exits the world actually grounds), the typed CAN gap
   * `ENV_HAZARD_NO_EXIT` when it grounds none, and `ENV_HAZARD_CLEAR` when the
   * body gets out. It never invents a route and never ranks one: the exits are
   * ordinary candidates and the choice among them stays Jev's
   * (`envHazardReflexAction` fires only when exactly one is grounded).
   */

export function observeEnvHazard(host: ThreatObserverHost, state: WorldState): void {
    const hazard = state.self.envHazard ?? null
    const evidence = host.envHazard.note({
      atMs: state.timestampMs,
      hazard,
      damageObserved: host.damageObservedThisTick,
    })
    host.damageObservedThisTick = false
    const goalKey = host.currentGoalKey()
    if (evidence.active) {
      const escapes = envHazardEscapeSpots(state, host.blacklistedMoveTargets(state))
      const line = formatEnvHazard(goalKey, evidence, escapes)
      if (line !== host.lastEnvHazardLine) {
        host.lastEnvHazardLine = line
        host.logger.warn(
          'agent',
          line,
          {
            kind: evidence.kinds.join('+'),
            cell: evidence.cell,
            block: evidence.block,
            damage: evidence.damage,
            activeMs: evidence.activeMs,
            onFire: evidence.onFire,
            headWet: evidence.headInWater,
            airAbove: evidence.airAbove,
            exits: escapes.length,
            waterExit: escapes.some((escape) => escape.water),
          },
          host.tickCounter,
        )
      }
      if (evidence.escapeRequired && escapes.length === 0) {
        const gap = formatEnvHazardNoExit(goalKey, evidence, state.envHazardCells?.length ?? 0)
        if (gap !== host.lastEnvHazardGapLine) {
          host.lastEnvHazardGapLine = gap
          host.logger.warn(
            'agent',
            gap,
            { kind: evidence.kinds.join('+'), cell: evidence.cell, reason: 'no_safe_adjacent_cell' },
            host.tickCounter,
          )
        }
      } else {
        host.lastEnvHazardGapLine = null
      }
      return
    }
    host.lastEnvHazardLine = null
    host.lastEnvHazardGapLine = null
    const cleared = host.envHazard.takeCleared()
    if (cleared !== null) {
      host.logger.info(
        'agent',
        formatEnvHazardClear(cleared),
        {
          lastKind: cleared.kinds.join('+'),
          lastCell: cleared.cell,
          lastBlock: cleared.block,
          damage: cleared.damage,
          activeMs: cleared.activeMs,
        },
        host.tickCounter,
      )
    }
  }

  /**
   * Health events are authoritative when delivered. A direct per-tick sample is
   * the fail-safe for hot-reload/respawn windows where Mineflayer changes
   * `bot.health` but the scheduler event is not observed by this generation.
   * The pure transition helper prevents an initial seed or an unchanged sample
   * from inventing damage; only a real delta enters the existing tracker.
   */

export function sampleHealthFallback(host: ThreatObserverHost): void {
    const health = host.bot.health
    const transition = sampleHealthTransition(host.lastObservedHealth, health)
    if (host.lastObservedHealth === null && Number.isFinite(health)) {
      host.lastObservedHealth = health
    }
    if (!transition.observe) return
    host.observeCriticalDamage('hp_changed', {
      health,
      previousHealth: transition.previousHealth,
      food: host.bot.food,
      delta: transition.delta,
    })
  }

  /**
   * M2 capability trap observable. The deterministic predicate decides; this
   * method only feeds it the live y / target / refusal flag and reacts with the
   * `CAPABILITY_GAP` marker plus a strategic replan. It is not a movement
   * heuristic and it never claims success.
   */
/**
 * The damage ORIGIN a scheduler trigger carries, validated, or null.
 *
 * The scheduler only ever sets `attackerPosition` from a finite server-stated
 * coordinate (the `damage_event` packet's `sourcePosition`, or the resolved
 * source entity's position), but this is the boundary where an untrusted
 * payload could reach the durable signal: a non-finite or malformed value is
 * dropped here so "unknown" stays unknown instead of poisoning a distance
 * comparison downstream.
 */
function damageOrigin(value: unknown): Vec3Json | null {
  if (typeof value !== 'object' || value === null) return null
  const point = value as { x?: unknown; y?: unknown; z?: unknown }
  if (typeof point.x !== 'number' || typeof point.y !== 'number' || typeof point.z !== 'number') return null
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) return null
  return { x: point.x, y: point.y, z: point.z }
}
