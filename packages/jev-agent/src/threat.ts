// threat.ts - SAFE: the code-owned fact "a hostile mob is on top of the body".
//
// Measured live (m3-live, `run-mubobiq6-12onv`, source 220b9db, permanent night,
// `difficulty=normal`, `spawn-monsters=true`): eight deaths in seven minutes,
// every one of them `cause=damage` with no weapon and no armour. The executed
// action trace in one of those windows is the whole failure:
//
//   22:19:36 trigger=damage_taken attacker=spider 1.52m
//   22:19:39 generated ATTACK:e33467 (zombie 0.78m) + RETREAT x3 (1.4m..2.4m away)
//   22:19:41 JEV_HEADS action=ATTACK:e33467 -> replan; ACTION_COMMIT held RETREAT
//   22:19:44 DEATH pos=28.7,65.0,11.4 healthBefore=2.17
//   22:20:35 RETREAT:p4_69_-9 (0.71m away) -> "arrival start=(4.5,69,-8.5) end=(4.5,69,-8.5) moved=0m"
//   22:20:42 DEATH pos=4.5,69.0,-8.5
//
// Two independent defects made that shape possible:
//
//   1. The response was PER-TICK. `restrictCandidatesDuringImmediateThreat`
//      (candidates.ts) only arms while a hostile is inside 3.2 m in the CURRENT
//      snapshot. The moment the mob falls outside it the body goes back to
//      digging/retrieving/crafting, the zombie follows, lands another hit, and
//      health erodes 20 -> 18 -> 16 -> 2 -> death. Nothing owned "the body is in
//      a fight", so there was no state to keep the body answering the threat.
//   2. The offered "retreat" could not retreat. `pickRetreats` only ever sees
//      `state.terrain.standable`, which the sensor samples in a 5x5x3 window
//      around the body (state.ts `buildTerrain`), so every "retreat to safety"
//      was 1.4-2.4 m away while the zombie was inside 0.8 m - a shuffle inside
//      melee reach, executed as `moved=0m`.
//
// This module is the deterministic owner of the missing facts. It never picks
// WHAT to do: it reports the threat (name, distance, contact/danger, weapon
// needed to answer it), keeps a bounded danger STATE with a real exit condition
// (hysteresis instead of a per-tick filter), grounds keep-distance destinations
// that actually gain separation, and formats the typed markers.
//
// Design boundary, same as `criticalDamage.ts`:
//   - code owns CAN/SAFE: is this entity a threat, is the body in contact, which
//     destinations genuinely move it away, which weapon does the body hold;
//   - Jev owns WHICH grounded survival action (ATTACK / RETREAT / ESCALATE);
//   - System2 owns WHAT NEXT when the local layer proves it cannot end the
//     situation (the `THREAT_NO_ESCAPE` capability gap).
import type { ActiveItemUseState, EntityState, LastDamageEvidence, Vec3Json } from './state.ts'

/**
 * Hostile melee reach. A hostile inside this envelope is already hitting the
 * body, so a work action is not a safe response (the pre-existing
 * `IMMEDIATE_HOSTILE_RANGE`; kept as one number).
 */
export const MELEE_THREAT_REACH = 3.2

/**
 * The bounded danger radius. A walking hostile inside 8 m closes to melee in
 * ~2 s, i.e. inside one policy decision, so the survival offer must contain a
 * grounded answer here rather than only at contact range.
 */
export const THREAT_DANGER_RADIUS = 8

/**
 * A hostile that has actually engaged the body is response-worthy far beyond
 * melee range: a skeleton opens fire at roughly 10-16 m. This is the response
 * envelope (the pre-existing `THREAT_RESPONSE_RANGE`).
 */
export const THREAT_RESPONSE_RANGE = 24

/** How long a damage observation keeps a hostile response-worthy. */
export const THREAT_MEMORY_MS = 8000

/**
 * The sustained-clear interval a danger state needs before it may leave. This is
 * the hysteresis: a single snapshot without the mob is NOT an exit (that is the
 * measured per-tick failure), the whole envelope must stay clear for 8 s.
 */
export const THREAT_CLEAR_MS = 8000

/**
 * Distance at which a destination is outside a hostile's reach with margin. A
 * retreat that does not reach this must at least gain `MIN_KEEP_DISTANCE_GAIN`.
 */
export const THREAT_STANDOFF_RANGE = 4

/**
 * A keep-distance destination must gain at least this much separation from the
 * threat. The measured live "retreats" gained 0.25-1.6 m and left the body in
 * melee reach; `+0.25 m` is not a retreat.
 */
export const MIN_KEEP_DISTANCE_GAIN = 2

/**
 * Sensor window (blocks) for threat escape cells.
 *
 * Measured live (`portal-p4`, overworld coastal pocket): a drowned tracked the
 * body from ~37 m (`THREAT_RANGED_UNANSWERED distance=37.65`) while every
 * RETREAT destination came from a 6 m scan - each leg gained at most ~6 m of
 * separation and the tracker re-closed it before the next epoch, so four
 * respawns died inside the same ~15 m pocket in 3.5 min. Hostile follow range
 * is ~35-40 m, so a keep-distance leg has to reach cells far enough away that
 * separation can grow past the tracker's engagement instead of orbiting inside
 * it. 16 m keeps a melee skirmish honest (a 2 m zombie still only needs ~6 m of
 * room) while giving a distant tracker legs that buy ~15-20 m at a time.
 */
export const THREAT_ESCAPE_RADIUS = 16

/** Vertical half-window of the escape scan, matching `buildTerrain`. */
export const THREAT_ESCAPE_DY = 1

/** Upper bound on escape cells kept, so the offer cannot be crowded. */
export const THREAT_ESCAPE_MAX_CELLS = 12

/**
 * How far an UNSEEN attacker's stated damage origin may sit and still anchor the
 * sensor's local escape scan. A ghast fires from 64 m (`threatAttackRange`), so
 * this must clear that: the destinations stay local to the body (the scan is
 * `THREAT_ESCAPE_RADIUS` around it), only the sight-line origin is far away.
 */
export const UNSENSED_THREAT_ANCHOR_RANGE = 96

/**
 * Separation an unseen attacker's damage origin must buy for a destination to
 * count as keep-distance. Smaller than the sensed-threat `MIN_KEEP_DISTANCE_GAIN`
 * because a distant origin cannot be outrun at all: the local scan can only
 * offer a lateral step, and a lateral step still moves the body off the firing
 * line the attack just travelled along. Cover (real block truth) remains the
 * load-bearing qualification for these origins.
 */
export const UNSENSED_MIN_KEEP_DISTANCE_GAIN = 0.5

/**
 * Bounded "the goal is stalled" window used by the danger-state restriction.
 * Identical to the controller's default `stallMs` (`LOCAL_PROGRESS_STALL`);
 * injected as an option so the two can never drift.
 */
export const DEFAULT_THREAT_STALL_MS = 25000

export const THREAT_NEARBY = 'THREAT_NEARBY'
/**
 * A hostile that DAMAGED the body while sitting outside its own response
 * envelope: the body is being hit by something the local safety layer can name
 * but cannot answer, because every grounded response (`ATTACK`, keep-distance
 * retreat) is grounded from sensed positions inside the envelope.
 *
 * Measured live (`run-muc3qbug-18vg3`, the 18 s Nether death window): a ghast
 * (`attackerId=49201 attackerName=ghast`) took the body 9.5 HP -> 7.5 HP, and
 * the entity never appeared in the sensor at all - `entityRadius` was 24 m while
 * a ghast fires from 64 m. No `THREAT_NEARBY` line was ever emitted for it, so
 * nothing in the run said the body was being shelled by an invisible mob.
 *
 * This is the typed GAP, not a fabricated route: no candidate is invented for a
 * mob whose position the body cannot see. It names the attacker, the distance
 * when known, and the standoff the body would need to answer it from.
 */
export const THREAT_RANGED_UNANSWERED = 'THREAT_RANGED_UNANSWERED'
export const THREAT_NO_ESCAPE = 'THREAT_NO_ESCAPE'
export const THREAT_OCCLUDED = 'THREAT_OCCLUDED'
export const THREAT_CLEAR = 'THREAT_CLEAR'

/**
 * The measured DAMAGE RACE: a hostile is on the body, health is dropping, and the
 * candidate layer is offering escapes. This marker answers the one question the
 * existing threat vocabulary cannot: what the candidate layer can PROVE about the
 * escapes it offers while damage lands - how many grounded keep-distance
 * destinations exist, how much separation the best one buys, whether any leaves the
 * threat's reach at decision time, and which KIND of source is landing the damage.
 *
 * Measured live (`buddy.log` 2026-09-22T10:49:53-59, the closest fortress approach
 * of the run): `THREAT_NEARBY threat=magma_cube distance=2.98 contact=true
 * weapon=stone_pickaxe health=16.704` -> `8.316` -> `DEATH` in ~4 s, while every
 * tick offered three `RETREAT` cells and `SURVIVAL_REGROUND
 * reason=same_threat_keep_distance` re-grounded the chosen retreat onto a cell at
 * the SAME or a shorter distance (2.98 m -> 2.06 m). Nothing in the record said
 * "the escape did not buy separation", so the death read as an unavoidable hit.
 *
 * It deliberately does NOT predict that the body will get away (see
 * `assessSurvivalRace`): a mob that closes between ticks follows a destination that
 * was outside its reach when the tick was decided, which is exactly what the
 * measured magma_cube did. Code owns the observation; the verdict is the record's.
 */
export const SURVIVAL_DAMAGE_RACE = 'SURVIVAL_DAMAGE_RACE'

/**
 * The typed capability gap when the body is in contact with a hostile and the
 * candidate layer grounds NO escape destination at all. Distinct from
 * `THREAT_NO_ESCAPE` (which is about the whole restricted offer collapsing to an
 * escalation): this one is specifically "there is no landable keep-distance cell",
 * and it is what makes "it could not have escaped" an observation instead of an
 * assumption. `outcome=CAPABILITY_LOST` is carried in the line, matching the
 * re-ground vocabulary.
 */
export const SURVIVAL_ESCAPE_NONE = 'SURVIVAL_ESCAPE_NONE'

/**
 * WHICH KIND of thing is landing the damage. `mob` and `player` are decided from
 * the SENSED entity the attribution names (`EntityState.username` is non-null only
 * for a player entity; `hostile` is the sensor's own classification), never from a
 * name shape. `environment` is the repo's existing convention for damage with no
 * attributed attacker (`criticalDamage.ts`), and `unattributed` is the measured
 * operator-bow shape: a named source the sensor never witnessed.
 */
export type DamageSourceKind = 'mob' | 'player' | 'environment' | 'unattributed'

export interface DamageSourceFacts {
  source: DamageSourceKind
  /** the attributed attacker's name, or null when there is none */
  name: string | null
  /** the attributed attacker's entity id, or null when there is none */
  id: number | null
  /** how the classification was reached (greppable, never guessed) */
  evidence: 'sensed_player' | 'sensed_hostile' | 'sensed_entity' | 'unattributed' | 'none'
}

/**
 * Classify the most recent damage attribution against the SENSED entity snapshot.
 *
 * A player entity is one the sensor saw with a `username` (Mineflayer exposes that
 * field only for players); a mob is a sensed entity the sensor classified hostile;
 * any other sensed entity is still a mob-class source (`sensed_entity`) because it
 * is a real world entity, not the environment. A named source that is NOT in the
 * snapshot is `unattributed` - the measured case where the operator shoots from
 * outside the sensor radius, and the one shape that must not be silently folded
 * into "environment".
 */
export function classifyDamageSource(
  lastDamage: Pick<LastDamageEvidence, 'sourceId' | 'sourceName'> | null | undefined,
  entities: readonly Pick<EntityState, 'id' | 'name' | 'username' | 'hostile'>[],
): DamageSourceFacts {
  if (lastDamage === null || lastDamage === undefined) {
    return { source: 'environment', name: null, id: null, evidence: 'none' }
  }
  const id = lastDamage.sourceId ?? null
  const name = lastDamage.sourceName ?? null
  const sensed =
    (id === null ? undefined : entities.find((entity) => entity.id === id)) ??
    (name === null ? undefined : entities.find((entity) => entity.name === name))
  if (sensed === undefined) {
    if (name === null) return { source: 'environment', name: null, id: null, evidence: 'none' }
    return { source: 'unattributed', name, id, evidence: 'unattributed' }
  }
  if (sensed.username !== null && sensed.username !== undefined) {
    return { source: 'player', name: sensed.name, id: sensed.id, evidence: 'sensed_player' }
  }
  if (sensed.hostile === true) {
    return { source: 'mob', name: sensed.name, id: sensed.id, evidence: 'sensed_hostile' }
  }
  return { source: 'mob', name: sensed.name, id: sensed.id, evidence: 'sensed_entity' }
}

/** The minimum a RETREAT candidate must expose for the race assessment. */
export interface EscapeCandidateFacts {
  /** extra separation (metres) this destination buys over standing still */
  separationGain: number
  /** the destination is outside the threat's own reach */
  outsideReach: boolean
}

export interface SurvivalRaceFacts {
  threatName: string | null
  threatId: number | null
  distance: number | null
  contact: boolean
  body: BodySurvivalFacts
  weapon: WeaponFacts
  damage: DamageSourceFacts
  /**
   * How long ago the last landed hit was observed (`null` when none was recorded).
   * This is the observed half of "health is dropping": a value inside the threat
   * memory window means damage is landing NOW, and it is a measurement rather than
   * an inference from proximity.
   */
  damageAgoMs: number | null
  /** grounded keep-distance destinations on offer right now */
  escapeCount: number
  /** how many of them leave the threat's reach */
  escapesOutsideReach: number
  /**
   * The best separation any grounded escape buys (rounded), or null when none
   * exists. Reported because it is the quantity the measured `SURVIVAL_REGROUND
   * reason=same_threat_keep_distance` loop silently lost: the body re-chose cells
   * at the SAME or a shorter distance (2.98 m -> 2.06 m).
   */
  bestSeparationGain: number | null
  /**
   * What the CANDIDATE LAYER can prove about escaping, and nothing more:
   *
   *   `outside_reach` - a grounded destination sits outside the threat's reach
   *   `inside_reach`  - escapes exist but every one of them is inside the reach
   *   `none`          - no grounded keep-distance destination exists at all
   *
   * This is deliberately NOT a verdict that the body will get away: a mob that
   * closes between ticks can follow a destination that was outside its reach when
   * the tick was decided (that is exactly what the measured magma_cube did), and
   * predicting the next position is not something this layer can observe. The
   * marker therefore states the destination fact and the honest `reason`, and
   * `SURVIVAL_ESCAPE_NONE` states the only case that is decidable.
   */
  escape: 'outside_reach' | 'inside_reach' | 'none'
  reason: 'escape_leaves_threat_reach' | 'escape_stays_in_contact' | 'no_grounded_escape'
}

/**
 * Assess what the candidate layer can prove about escaping the damage it is
 * taking. Pure: every input is a code-owned observation, and the result names the
 * fact that decided it.
 */
export function assessSurvivalRace(input: {
  evidence: Pick<ThreatStateEvidence, 'threatName' | 'threatId' | 'threatDistance' | 'inContact'> | null
  body: BodySurvivalFacts
  weapon: WeaponFacts
  damage: DamageSourceFacts
  escapes: readonly EscapeCandidateFacts[]
  /** ms since the last landed hit, or null when none is recorded */
  damageAgoMs?: number | null
}): SurvivalRaceFacts {
  const { evidence } = input
  const distance = evidence?.threatDistance ?? null
  const outsideReach = input.escapes.filter((escape) => escape.outsideReach).length
  const gains = input.escapes.map((escape) => escape.separationGain).filter((gain) => Number.isFinite(gain))
  const best = gains.length === 0 ? null : Math.max(...gains)
  const base = {
    threatName: evidence?.threatName ?? null,
    threatId: evidence?.threatId ?? null,
    distance,
    contact: evidence?.inContact === true,
    body: input.body,
    weapon: input.weapon,
    damage: input.damage,
    damageAgoMs: input.damageAgoMs ?? null,
    escapeCount: input.escapes.length,
    escapesOutsideReach: outsideReach,
    bestSeparationGain: best === null ? null : Math.round(best * 100) / 100,
  }
  if (input.escapes.length === 0) {
    return { ...base, escape: 'none', reason: 'no_grounded_escape' }
  }
  if (outsideReach > 0) {
    return { ...base, escape: 'outside_reach', reason: 'escape_leaves_threat_reach' }
  }
  return { ...base, escape: 'inside_reach', reason: 'escape_stays_in_contact' }
}

/** `SURVIVAL_DAMAGE_RACE ...` - the grounded escape-versus-damage fact. */
export function formatSurvivalDamageRace(facts: SurvivalRaceFacts): string {
  const distance = facts.distance === null ? 'unknown' : `${round2(facts.distance)}m`
  const gain = facts.bestSeparationGain === null ? 'unknown' : `+${facts.bestSeparationGain}m`
  const damageAgo = facts.damageAgoMs === null ? 'none' : `${Math.round(facts.damageAgoMs)}ms`
  return (
    `${SURVIVAL_DAMAGE_RACE} threat=${facts.threatName ?? 'unknown'} threatId=${facts.threatId ?? 'none'} ` +
    `distance=${distance} contact=${facts.contact} damageAgo=${damageAgo} source=${facts.damage.source} ` +
    `sourceName=${facts.damage.name ?? 'none'} sourceEvidence=${facts.damage.evidence} health=${round2(facts.body.health)} ` +
    `food=${facts.body.food} regenerating=${facts.body.regenerating} weapon=${facts.weapon.name ?? 'fists'} ` +
    `swingDamage=${facts.weapon.damage ?? FIST_DAMAGE} escapes=${facts.escapeCount} ` +
    `escapesOutsideReach=${facts.escapesOutsideReach} bestSeparationGain=${gain} ` +
    `escape=${facts.escape} reason=${facts.reason}`
  )
}

/** `SURVIVAL_ESCAPE_NONE ... outcome=CAPABILITY_LOST` - no landable escape exists. */
export function formatSurvivalEscapeNone(facts: SurvivalRaceFacts): string {
  const distance = facts.distance === null ? 'unknown' : `${round2(facts.distance)}m`
  return (
    `${SURVIVAL_ESCAPE_NONE} threat=${facts.threatName ?? 'unknown'} threatId=${facts.threatId ?? 'none'} ` +
    `distance=${distance} contact=${facts.contact} source=${facts.damage.source} health=${round2(facts.body.health)} ` +
    `food=${facts.body.food} weapon=${facts.weapon.name ?? 'fists'} reason=${facts.reason} ` +
    `outcome=CAPABILITY_LOST -> no grounded keep-distance cell exists; the missing affordance is named, not re-offered`
  )
}

/** Vanilla 1.21 unarmed player attack damage. */
export const FIST_DAMAGE = 1

/**
 * Vanilla natural health regeneration needs a full-enough hunger bar (food >= 18
 * and a non-empty saturation buffer). Measured live: the resident held food 0-2
 * for the whole attrition window, `EAT_REFUSED reason=no_food` fired 174 times,
 * no `EAT` action ever executed, and health only ever returned to 20 on respawn.
 * A body below this threshold therefore CANNOT heal between hits, which is the
 * code-owned reason a "trade hits with the mob" plan is not survivable.
 */
export const REGEN_FOOD_THRESHOLD = 18

/** The body's own survival facts at decision time; CAN only, never a choice. */
export interface BodySurvivalFacts {
  health: number
  food: number
  /** natural regeneration is possible right now (food >= `REGEN_FOOD_THRESHOLD`) */
  regenerating: boolean
}

export function bodySurvivalFacts(self: { health: number; food: number }): BodySurvivalFacts {
  const food = Number.isFinite(self.food) ? self.food : 0
  return {
    health: Number.isFinite(self.health) ? self.health : 0,
    food,
    regenerating: food >= REGEN_FOOD_THRESHOLD,
  }
}

/**
 * Vanilla 1.21 sword attack damage. Only the families this module can pin down
 * are listed: an unknown held item reports `damage: null` instead of a guess.
 */
const SWORD_DAMAGE: Readonly<Record<string, number>> = {
  wooden_sword: 4,
  golden_sword: 4,
  stone_sword: 5,
  iron_sword: 6,
  diamond_sword: 7,
  netherite_sword: 8,
}

/** How the body's held item answers a hostile: a code-owned CAN fact. */
export type WeaponKind = 'fists' | 'sword' | 'tool' | 'block' | 'item'

export interface WeaponFacts {
  /** held item name, or null for bare hands */
  name: string | null
  /** display label for the candidate line: 'fists' or the item name */
  label: string
  kind: WeaponKind
  /** vanilla attack damage when this module can pin it, else null (never guessed) */
  damage: number | null
}

const TOOL_SUFFIXES = ['_pickaxe', '_axe', '_shovel', '_hoe'] as const

/**
 * What the body can hit with right now. `held` is the live main-hand item
 * (`SelfState.heldItem`), so this is inventory truth, not a preference: a body
 * holding a stone sword is offered the same ATTACK as a body holding nothing,
 * with the weapon named in the candidate facts.
 */
export function weaponFacts(held: string | null | undefined): WeaponFacts {
  if (held === null || held === undefined || held.length === 0) {
    return { name: null, label: 'fists', kind: 'fists', damage: FIST_DAMAGE }
  }
  if (held.endsWith('_sword')) {
    return { name: held, label: held, kind: 'sword', damage: SWORD_DAMAGE[held] ?? null }
  }
  for (const suffix of TOOL_SUFFIXES) {
    if (held.endsWith(suffix)) return { name: held, label: held, kind: 'tool', damage: null }
  }
  if (held.endsWith('_block') || held.endsWith('_planks') || held.endsWith('_log') || held.endsWith('cobblestone')) {
    return { name: held, label: held, kind: 'block', damage: null }
  }
  return { name: held, label: held, kind: 'item', damage: null }
}

/**
 * Bounded standoff range per hostile family. A creeper must be answered from
 * further out than a zombie (blast vs melee), and a ranged attacker outranges
 * any local walk, so its standoff is the bow envelope.
 */
export function threatStandoffRange(name: string): number {
  const mob = name.toLowerCase()
  if (mob === 'creeper') return 6
  if (
    mob === 'skeleton' ||
    mob === 'stray' ||
    mob === 'bogged' ||
    mob === 'pillager' ||
    mob === 'witch' ||
    mob === 'blaze' ||
    mob === 'ghast' ||
    mob === 'phantom' ||
    mob === 'llama' ||
    mob === 'trader_llama'
  ) {
    return 12
  }
  return THREAT_STANDOFF_RANGE
}

/** The entity facts this module reads; a structural subset of `EntityState`. */
export type ThreatEntityLike = Pick<
  EntityState,
  'id' | 'name' | 'hostile' | 'distance' | 'position' | 'attackedSelf' | 'lineOfSight' | 'heldItem' | 'activeItemUse'
>

export type ThreatEntryReason = 'contact' | 'danger' | 'engaged'
export type ThreatExitReason = 'sustained_clear'

/**
 * Is this hostile a threat the body must be able to answer? Code owns only the
 * grounded predicate; the choice of ATTACK/RETREAT stays with Jev.
 *
 *   immediate   - already inside melee reach
 *   attributed  - the recorded damage source is this exact entity
 *   engaged     - the body was damaged inside `THREAT_MEMORY_MS` and this
 *                 hostile has line of sight (used when Mineflayer did not
 *                 attribute the attacker; `lineOfSight === undefined` is
 *                 UNKNOWN and does not invent a threat)
 *
 * `nowMs` is injectable so fixtures do not depend on wall clock.
 */
export function isResponseWorthyThreat(
  state: Pick<{ entities: readonly ThreatEntityLike[]; signals: { lastDamage?: LastDamageEvidence | null } }, 'entities' | 'signals'>,
  entity: Pick<ThreatEntityLike, 'id' | 'name' | 'hostile' | 'distance' | 'attackedSelf' | 'lineOfSight'>,
  nowMs = Date.now(),
): boolean {
  if (!entity.hostile) return false
  if (!Number.isFinite(entity.distance) || entity.distance > THREAT_RESPONSE_RANGE) return false
  if (entity.distance <= MELEE_THREAT_REACH) return true
  if (entity.attackedSelf === true) return true
  const last = state.signals.lastDamage ?? null
  if (last === null || !Number.isFinite(last.atMs) || nowMs - last.atMs > THREAT_MEMORY_MS) return false
  // Attribution unknown -> require positive sight evidence; never invent one.
  return entity.lineOfSight === true
}

/** A hostile inside the bounded danger radius (an imminent threat, engaged or not). */
export function isDangerousThreat(entity: Pick<ThreatEntityLike, 'hostile' | 'distance'>): boolean {
  return entity.hostile && Number.isFinite(entity.distance) && entity.distance <= THREAT_DANGER_RADIUS
}

/** Hostiles inside the danger radius, nearest first. */
export function dangerousThreats(
  entities: readonly ThreatEntityLike[],
): ThreatEntityLike[] {
  return entities.filter(isDangerousThreat).sort((a, b) => a.distance - b.distance)
}

/** Nearest hostile inside the danger radius, or null. */
export function nearestDangerousThreat(entities: readonly ThreatEntityLike[]): ThreatEntityLike | null {
  return dangerousThreats(entities)[0] ?? null
}

/**
 * Every threat the body must answer right now, nearest first: hostiles inside
 * the bounded danger radius (engaged or not) plus response-worthy hostiles
 * anywhere inside the response envelope. This is the union the candidate layer
 * grounds keep-distance destinations from, so "a zombie is 6 m away and closing"
 * is answerable before it lands the first hit.
 */
export function activeThreats(
  entities: readonly ThreatEntityLike[],
  lastDamage: LastDamageEvidence | null | undefined,
  nowMs: number,
): ThreatEntityLike[] {
  const signals = { lastDamage: lastDamage ?? null }
  const seen = new Set<number>()
  const out: ThreatEntityLike[] = []
  for (const entity of entities) {
    if (seen.has(entity.id)) continue
    if (!isDangerousThreat(entity) && !isResponseWorthyThreat({ entities, signals }, entity, nowMs)) continue
    seen.add(entity.id)
    out.push(entity)
  }
  return out.sort((a, b) => a.distance - b.distance)
}

/** The exact code-owned danger state handed to the candidate layer and logged. */
export interface ThreatStateEvidence {
  /** true while the body is in a fight the local layer must keep answering */
  active: boolean
  /** how long the state has been active, ms (0 when inactive) */
  activeMs: number
  /** nearest dangerous/engaged hostile: identity and distance, or null when clear */
  threatId: number | null
  threatName: string | null
  threatDistance: number | null
  /** that threat holds an item (a skeleton's bow, a zombie's sword), or null */
  threatHeldItem: string | null
  /** server-observed active hand item use, or null when this version did not expose it */
  threatActiveItemUse?: ActiveItemUseState | null
  /** the threat hit the body (Mineflayer attribution), or has line of sight after damage */
  threatEngaged: boolean
  threatLineOfSight: boolean | null
  /** the threat is inside melee reach right now */
  inContact: boolean
  /** the threat is inside the bounded danger radius right now */
  inDanger: boolean
  /** hostiles inside the danger radius right now */
  hostileCount: number
  /** the sustained-clear interval this state needs before it may leave */
  clearMs: number
  /** how long the envelope has been continuously clear (0 while a threat is present) */
  clearForMs: number
  /** why the state was entered (null when never entered / already exited) */
  entryReason: ThreatEntryReason | null
  /** why the state last left (null while it has never left) */
  exitReason: ThreatExitReason | null
  /** when the current/last active window started, ms epoch */
  enteredAtMs: number | null
}

export interface ThreatObservation {
  /** wall-clock ms of this decision tick */
  atMs: number
  entities: readonly ThreatEntityLike[]
  lastDamage?: LastDamageEvidence | null
}

/**
 * The bounded danger STATE.
 *
 * Enter when a hostile is inside `THREAT_DANGER_RADIUS`, or when a hostile is
 * response-worthy (attributed attacker / line of sight after damage) anywhere
 * inside `THREAT_RESPONSE_RANGE`. Stay active while that predicate holds. Leave
 * only on a grounded exit: the whole envelope has been continuously clear for
 * `THREAT_CLEAR_MS`.
 *
 * Why a state and not a per-tick predicate: the measured live failure was
 * exactly per-tick. The body retreated once while a zombie was inside 3.2 m,
 * then went straight back to digging the moment the mob stepped outside that
 * snapshot, took the next hit, and died with health 2.17 after repeating this
 * for a minute. A continued clear interval is the difference between "the mob
 * is not in this frame" and "the fight is over".
 *
 * Pure and injectable: the caller supplies observations and reads `evidence()`;
 * there is no clock and no bot.
 */
export class ThreatTracker {
  private active = false
  private enteredAtMs: number | null = null
  private clearSinceMs: number | null = null
  private entryReason: ThreatEntryReason | null = null
  private exitReason: ThreatExitReason | null = null
  private hostileCount = 0
  private last: ThreatStateEvidence | null = null

  constructor(private readonly clearMs: number = THREAT_CLEAR_MS) {}

  note(observation: ThreatObservation): ThreatStateEvidence {
    const atMs = Number.isFinite(observation.atMs) ? observation.atMs : 0
    this.hostileCount = dangerousThreats(observation.entities).length
    const threat = activeThreats(observation.entities, observation.lastDamage ?? null, atMs)[0] ?? null
    if (threat !== null) {
      if (!this.active) {
        this.active = true
        this.enteredAtMs = atMs
        this.exitReason = null
      }
      this.entryReason = isDangerousThreat(threat)
        ? threat.distance <= MELEE_THREAT_REACH
          ? 'contact'
          : 'danger'
        : 'engaged'
      this.clearSinceMs = null
      this.last = this.build(atMs, threat)
      return this.last
    }

    // No threat in this snapshot. The envelope must stay clear for the whole
    // bounded interval: a single quiet frame is not an exit.
    if (this.active) {
      this.clearSinceMs ??= atMs
      if (atMs - this.clearSinceMs >= this.clearMs) {
        this.active = false
        this.exitReason = 'sustained_clear'
        this.enteredAtMs = null
        this.entryReason = null
        this.clearSinceMs = null
      }
    }
    this.last = this.build(atMs, null)
    return this.last
  }

  /** Current evidence without recording anything. Never mutates. */
  evidence(): ThreatStateEvidence {
    return this.last ?? this.build(0, null)
  }

  reset(): void {
    this.active = false
    this.enteredAtMs = null
    this.clearSinceMs = null
    this.entryReason = null
    this.exitReason = null
    this.hostileCount = 0
    this.last = null
  }

  private build(atMs: number, threat: ThreatEntityLike | null): ThreatStateEvidence {
    return {
      active: this.active,
      activeMs: this.active && this.enteredAtMs !== null ? Math.max(0, atMs - this.enteredAtMs) : 0,
      threatId: threat?.id ?? null,
      threatName: threat?.name ?? null,
      threatDistance: threat?.distance ?? null,
      threatHeldItem: threat?.heldItem ?? null,
      threatActiveItemUse: threat?.activeItemUse ?? null,
      threatEngaged: threat?.attackedSelf === true,
      threatLineOfSight: typeof threat?.lineOfSight === 'boolean' ? threat.lineOfSight : null,
      inContact: threat !== null && threat.distance <= MELEE_THREAT_REACH,
      inDanger: threat !== null && isDangerousThreat(threat),
      hostileCount: this.hostileCount,
      clearMs: this.clearMs,
      clearForMs: this.clearSinceMs === null ? 0 : Math.max(0, atMs - this.clearSinceMs),
      entryReason: this.entryReason,
      exitReason: this.exitReason,
      enteredAtMs: this.enteredAtMs,
    }
  }
}

/** `THREAT_NEARBY threat=zombie distance=0.78m ...` - the honest proximity line. */
export function formatThreatNearby(
  goalKey: string,
  evidence: ThreatStateEvidence,
  weapon: WeaponFacts,
  body: BodySurvivalFacts,
): string {
  const name = evidence.threatName ?? 'unknown'
  const distance = evidence.threatDistance === null ? 'unknown' : `${round2(evidence.threatDistance)}m`
  const held = evidence.threatHeldItem === null ? 'none' : evidence.threatHeldItem
  const damage = weapon.damage === null ? 'unknown' : String(weapon.damage)
  return (
    `${THREAT_NEARBY} goal=${goalKey} threat=${name} id=${evidence.threatId ?? 'none'} distance=${distance} ` +
    `contact=${evidence.inContact} danger=${evidence.inDanger} hostiles=${evidence.hostileCount} ` +
    `engaged=${evidence.threatEngaged} los=${evidence.threatLineOfSight === null ? 'unknown' : evidence.threatLineOfSight} ` +
    `threatHeld=${held} weapon=${weapon.label} weaponKind=${weapon.kind} weaponDamage=${damage} ` +
    `health=${round2(body.health)} food=${body.food} regenerating=${body.regenerating} ` +
    `activeMs=${evidence.activeMs} -> danger memory stays active until the envelope is clear for ${evidence.clearMs}ms; current CAN is grounded separately`
  )
}

/**
 * The conservative distance tracker sees a hostile, but current CAN proves every
 * danger-radius hostile is behind occlusion with no melee route and there was no
 * recent hit. Work may continue for THIS snapshot; the tracker is intentionally
 * left active so LOS/path/contact becoming true re-arms survival immediately.
 */
export function formatThreatOccluded(
  goalKey: string,
  evidence: ThreatStateEvidence,
  entityIds: readonly number[],
): string {
  const name = evidence.threatName ?? 'unknown'
  const distance = evidence.threatDistance === null ? 'unknown' : `${round2(evidence.threatDistance)}m`
  return (
    `${THREAT_OCCLUDED} goal=${goalKey} threat=${name} ids=[${entityIds.join(',')}] distance=${distance} ` +
    `los=${evidence.threatLineOfSight === null ? 'unknown' : evidence.threatLineOfSight} engaged=${evidence.threatEngaged} ` +
    `reason=no_los_no_path -> threat memory stays active, but this snapshot does not suppress grounded goal work`
  )
}

/** `THREAT_NO_ESCAPE ...` - the capability gap when no grounded answer exists. */
export function formatThreatNoEscape(
  goalKey: string,
  evidence: ThreatStateEvidence,
  weapon: WeaponFacts,
  reason: string,
): string {
  const name = evidence.threatName ?? 'unknown'
  const distance = evidence.threatDistance === null ? 'unknown' : `${round2(evidence.threatDistance)}m`
  return (
    `${THREAT_NO_ESCAPE} goal=${goalKey} threat=${name} distance=${distance} inContact=${evidence.inContact} ` +
    `weapon=${weapon.label} reason=${reason} -> only a bounded ESCALATE is offered; code grounds no attack/keep-distance route`
  )
}

/** `THREAT_CLEAR ...` - the bounded exit, so a post-mortem can see the fight end. */
export function formatThreatClear(goalKey: string, evidence: ThreatStateEvidence): string {
  return (
    `${THREAT_CLEAR} goal=${goalKey} clearMs=${evidence.clearMs} clearForMs=${evidence.clearForMs} ` +
    `-> the danger state left on a sustained-clear envelope`
  )
}

// ---------------------------------------------------------------------------
// SURVIVAL_REGROUND: a chosen survival action that vanished before execution.
// ---------------------------------------------------------------------------
//
// Measured live (m3-live, `run-muc3qbug-18vg3`, source 35dfd29, the body's first
// 18 s in `minecraft:the_nether`; `logs/jev/run.jsonl`):
//
//   03:28:24.147 trigger=damage_taken preempts action#2 RETRIEVE:known:blaze_rod:b35_60_-23
//   03:28:24.971 JEV_HEADS action=RETREAT:p16_59_3 -> action chosen
//   03:28:25.162 chosen candidate RETREAT:p16_59_3 vanished between the Jev answer and execution
//   03:28:26.173 JEV_HEADS action=RETREAT:p17_59_2 -> action chosen
//   03:28:26.354 chosen candidate RETREAT:p17_59_2 vanished between the Jev answer and execution
//   03:28:27.421 JEV_HEADS action=RETREAT:p16_59_3 -> action chosen
//   03:28:27.619 chosen candidate RETREAT:p16_59_3 vanished between the Jev answer and execution
//   03:28:29.061 JEV_HEADS action=RETREAT:p22_60_-11 -> action chosen
//   03:28:29.295 chosen candidate RETREAT:p22_60_-11 vanished between the Jev answer and execution
//   03:28:30.828 JEV_HEADS action=RETREAT:p18_60_-11 -> action chosen
//   03:28:32.130 chosen candidate RETREAT:p18_60_-11 vanished between the Jev answer and execution
//   03:28:32.634 DEATH pos=23.5,59.0,-3.7 dimension=minecraft:the_nether
//
// Every retreat the body chose was dropped, so the tick ended with NO action at
// all while a spider was inside melee contact (THREAT_NEARBY distance=1.38m
// contact=true) and a ghast was shelling it. Buddy.log's ACTION counter went
// `n=5136` (03:28:16.875) -> `n=5137` (03:28:31.301): 14.4 s with nothing
// executing, and health 18 -> 7.5 in that window. The run contains 630 such
// drops, i.e. this is a systemic no-action path, not a Nether-specific one.
//
// Why the id vanishes: a RETREAT candidate is `RETREAT:p<x>_<y>_<z>` and its
// destination comes from `state.terrain.escapeCells` - a `radius`-6 box anchored
// on the body's CURRENT block (`state.ts` `buildEscapeCells`). At most
// `MAX_RETREAT_CANDIDATES` cells are kept, and they are the ones FARTHEST from
// the threat, i.e. always on the box boundary. One block of knockback from a mob
// bite re-anchors the box, and every boundary cell - hence every id - changes.
// `ATTACK:e<entityId>` is stable in shape but drops when the target leaves the
// sensor or dies.
//
// What was missing: nothing owned "the action Jev chose no longer exists, but
// the body is still in the fight". The revalidation guard could only reject, and
// a rejected tick executes nothing. This module owns the missing deterministic
// repair: re-ground the SAME survival action (same kind, same threat/target
// intent) from the FRESH offer, or report that no grounded survival action
// exists at all. It never picks a different semantic action and never ranks
// between kinds - `RETREAT` stays a retreat, `ATTACK` stays an attack on the
// same entity.

export const SURVIVAL_REGROUND = 'SURVIVAL_REGROUND'
export const SURVIVAL_NO_GROUNDED_ACTION = 'SURVIVAL_NO_GROUNDED_ACTION'
export const GUARD_REJECTIONS = 'GUARD_REJECTIONS'

// ---------------------------------------------------------------------------
// MOB_IDENTITY_CHURN: a mob whose ENTITY ID changes while its CAUSAL IDENTITY
// (kind + place) does not, and the body is fighting it.
// ---------------------------------------------------------------------------
//
// Measured (m3-live `buddy-driver/buddy.log`, the Nether magma-cube fights). The
// log carries 41 `THREAT_NEARBY threat=magma_cube` lines and the id is a NEW
// entity every engagement while `threat=magma_cube` never changes:
//
//   threatId 6313 -> 6759 -> 7466 -> … -> 41425 -> 42895 -> 45891 -> 48411 -> 49561 -> 52841
//
// and the "the chosen ATTACK's entity id vanished" shape is live in the same log:
//
//   07:57:38.109 SURVIVAL_NO_GROUNDED_ACTION chosenId=ATTACK:e15787 kind=ATTACK
//                reason=no_grounded_equivalent freshOffer=1 threat=skeleton
//                distance=2.38 contact=true health=2.51
//   11:04:04.464 SURVIVAL_NO_GROUNDED_ACTION chosenId=ATTACK:e49561 kind=ATTACK
//                reason=no_grounded_equivalent outcome=TARGET_LOST freshOffer=1
//                threat=magma_cube distance=2.32 contact=true
//
// (Honest scope of the second line: it landed 0.45 s AFTER that host's `DEATH`
// + respawn, so it is evidence of the SHAPE - a typed TARGET_LOST for an entity
// id that no longer exists - not of the kill mechanism. The magma cube's id
// churn itself is the measured part: 11:03:51 `threatId=49561 in contact` and
// 11:13:25 `threatId=52841` are two different entities of one unchanging
// `threat=magma_cube` in the same pocket.)
//
// A magma cube (like a slime) is REPLACED when its size state changes: the
// parent entity is removed by the server and the smaller cubes are NEW entities
// with fresh ids (the id is allocated at spawn and never reused). What survives
// the replacement is everything the candidate layer already carries:
//   - `targetName` ('magma_cube') - mineflayer sets it from the entity TYPE
//     (`mineflayer/lib/plugins/entities.js` `setEntityData`), so it is stable;
//   - `meta.targetKind` ('Hostile mobs' - the minecraft-data category), stable;
//   - `target` (the sensed position) - the children spawn inside/at the parent;
//   - the threat tracker's own record (`ThreatStateEvidence`) - it re-derives the
//     nearest active threat from EVERY snapshot, so it names the new id on the
//     next tick and never remembers the old one.
// What does NOT survive is the entity id - and the id is the only thing
// `regroundVanishedSurvivalChoice` compared, so the honest `TARGET_LOST` was
// produced for a threat that was still standing on the body.
//
// This is the bounded, code-owned repair. It is NOT a new target choice: the
// rule only fires for a survival ATTACK on a HOSTILE (`meta.targetHostile`) -
// never for a producer/food hunt, whose candidate is a claim about ONE instance
// (candidates.ts: "the committed ENTITY ID is the target for the whole Skill …
// never adopts another instance of the mob") - and only when ALL of these hold:
//
//   1. the previous entity is PROVEN gone: its id is absent from the client's
//      tracked set (`bot.entities`), which only the server's `entity_destroy`
//      produces. `null`/UNKNOWN refuses. "No longer in the 24 m sensor" is NOT
//      this fact and never adopts.
//   2. the replacement has the SAME mob name (and the same entity kind when both
//      sides carry one) - a different kind can never be adopted, whatever its
//      position.
//   3. the replacement is within `IDENTITY_CHURN_RADIUS` of the position the
//      vanished candidate recorded for the threat.
//   4. the churn happened inside `IDENTITY_CHURN_WINDOW_MS`. Both timestamps are
//      snapshot times the code owns (`WorldState.timestampMs`); unknown refuses.
//   5. the replacement is NEW: its id was not in the decision-time snapshot. A
//      same-kind bystander that was already standing next to the threat at
//      decision time is therefore never adopted (two same-name entities inside
//      `IDENTITY_CHURN_RADIUS` would both have been sensed).
//   6. the replacement is a candidate of the FRESH restricted offer, i.e. the
//      reply is a real grounded ATTACK that survived the same threat envelopes
//      and the reachability gate. Nothing is invented for an unsensed mob.
//
// Residual risk, stated rather than hidden: if the server destroys the committed
// id AND a NEW same-kind entity appears within `IDENTITY_CHURN_RADIUS` inside the
// window, the two are treated as one causal threat. That is exactly the split
// signature; the alternative (a typed TARGET_LOST while a same-kind hostile is in
// melee contact) is the measured stand-still. The rule cannot fire for a
// different kind, for a pre-existing entity, for a live old id, or outside the
// bounded window, and it never widens the effect envelope: the adopted candidate
// is the one the fresh offer already grounded.
//
// Pinned by `test-threat-response-grounding.mts` (i)-(vii).

/** Bounded radius (blocks) in which a same-kind entity is the same causal threat. */
export const IDENTITY_CHURN_RADIUS = 3
/** Bounded window (ms) inside which an id churn may be adopted. */
export const IDENTITY_CHURN_WINDOW_MS = 3000
/** `MOB_IDENTITY_CHURN from=… to=… mob=… kind=… moved=…m elapsedMs=… rule=…`. */
export const MOB_IDENTITY_CHURN = 'MOB_IDENTITY_CHURN'

/**
 * The survival kinds whose candidate id is anchored to volatile sensed truth
 * (an escape cell recomputed around a moving body, a sensed entity that can
 * leave the sensor). Their ids may legitimately change between the Jev answer
 * and execution, so an id mismatch is a mechanical identity failure, not a
 * semantic invalidity.
 */
export const SURVIVAL_REGROUNDABLE_KINDS: ReadonlySet<string> = new Set(['ATTACK', 'RETREAT'])

/** The subset of `Candidate` the re-grounding rule reads. */
export interface SurvivalChoiceLike {
  id: string
  kind: string
  targetEntityId?: number | null | undefined
  /** the sensed mob type name the candidate answers (`Candidate.targetName`) */
  targetName?: string | null | undefined
  /** the sensed position the candidate recorded (`Candidate.target`) */
  target?: Vec3Json | null | undefined
  meta?: Readonly<Record<string, unknown>> | undefined
}

/**
 * The code-owned facts that make an identity churn safe to adopt. Every field is
 * either a fact the sensor already carried (`name`/`kind`/position), a fact the
 * controller proves from the client's tracked set (`goneEvidence`, `newEntity`),
 * or a bounded time the snapshots own (`elapsedMs`).
 */
export interface MobIdentityChurnFacts {
  /** the destroyed entity id the vanished choice answered */
  fromEntityId: number
  /** the fresh candidate's entity id for the same causal threat */
  toEntityId: number
  /** the mob type both entities are (never inferred: both candidates carry it) */
  name: string
  /** the entity kind/category both entities are, or null when not exposed */
  kind: string | null
  /** distance between the last recorded threat position and the fresh position */
  distance: number
  /** ms between the decision-time snapshot and this revalidation */
  elapsedMs: number
  rule: 'same_kind_near_last_position'
  /** how the previous entity is proven gone (never "out of sensor range") */
  goneEvidence: 'not_in_client_tracked_set'
  /** how the replacement is proven to have appeared during the churn window */
  newEntity: 'absent_from_decision_snapshot'
}

/**
 * What the caller can prove about the entity the vanished choice answered. All
 * fields are required for an adoption: an UNKNOWN (`null`/absent) refuses rather
 * than guesses.
 */
export interface MobIdentityContext {
  /**
   * Is the previous entity id still in the client's TRACKED set right now
   * (`bot.entities`)? `false` is the server's own `entity_destroy` for that id.
   * `null`/absent is UNKNOWN and never adopts.
   */
  previousEntityTracked?: boolean | null | undefined
  /** entity ids the DECISION-time snapshot carried; the replacement must be new */
  knownEntityIds?: ReadonlySet<number> | null | undefined
  /** wall-clock ms of the decision-time snapshot (`WorldState.timestampMs`) */
  chosenAtMs?: number | null | undefined
  /** wall-clock ms of this revalidation (`WorldState.timestampMs`) */
  nowMs?: number | null | undefined
}

export type SurvivalRegroundReason =
  | 'not_a_survival_action'
  | 'same_target_attack'
  /** the same causal threat under a NEW entity id (bounded churn adoption) */
  | 'same_kind_near_last_position_attack'
  /** the committed keep-distance cell itself is still grounded (no retarget) */
  | 'same_cell_keep_distance'
  | 'same_threat_keep_distance'
  | 'any_threat_keep_distance'
  | 'no_grounded_equivalent'

/**
 * issue #436 section 9/14 + #437 section 2: the TYPED terminal outcome of a
 * survival choice whose candidate vanished between the Jev answer and execution.
 *
 * A reground must never be silent: either the SAME causal identity (or the same
 * volatile escape kind) was restored, or the choice ended for a typed reason that
 * policy can act on. `TARGET_LOST` says the exact entity the response was
 * answering is gone - it is emphatically NOT a kill and NOT a licence to swing at
 * whatever mob is nearest.
 */
export type SurvivalVanishedOutcome =
  /** the same survival action was restored from the fresh offer */
  | 'REGROUNDED'
  /**
   * the same survival action was restored for the SAME CAUSAL THREAT under a new
   * entity id (`MOB_IDENTITY_CHURN`). Distinct from `REGROUNDED` on purpose: the
   * committed entity id is gone, so a post-mortem must be able to tell "the same
   * identity came back" apart from "the same mob kind at the same place came
   * back", and the churn facts are carried in `identityChurn`.
   */
  | 'REGROUNDED_IDENTITY_CHURN'
  /** the exact entity the chosen ATTACK answered is no longer offered */
  | 'TARGET_LOST'
  /** no grounded response of the chosen kind exists at all any more */
  | 'CAPABILITY_LOST'
  /** the vanished choice was not a survival action */
  | 'NOT_A_SURVIVAL_ACTION'

export interface SurvivalRegroundResult {
  /** the fresh candidate that carries the same survival action, or null */
  candidateId: string | null
  /** the survival kind that was re-grounded, or null when the choice was not one */
  kind: 'ATTACK' | 'RETREAT' | null
  reason: SurvivalRegroundReason
  /** the entity the vanished choice was answering, when it carried one */
  entityId: number | null
  /** the typed terminal outcome of this re-ground (never "nothing happened") */
  outcome: SurvivalVanishedOutcome
  /**
   * the identity-churn facts when (and only when) the re-ground adopted the same
   * causal threat under a new entity id; null on every other path
   */
  identityChurn: MobIdentityChurnFacts | null
}

function numericMeta(meta: Readonly<Record<string, unknown>> | undefined, key: string): number | null {
  const raw = meta?.[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

/** The entity id an `ATTACK:e<id>` choice answers: typed meta first, id as fallback. */
function attackEntityId(chosen: SurvivalChoiceLike): number | null {
  const fromMeta = numericMeta(chosen.meta, 'entityId')
  if (fromMeta !== null) return fromMeta
  if (typeof chosen.targetEntityId === 'number' && Number.isFinite(chosen.targetEntityId)) {
    return chosen.targetEntityId
  }
  const parsed = /^ATTACK:e(\d+)$/.exec(chosen.id)
  return parsed === null ? null : Number(parsed[1])
}

/** The mob type name a candidate answers, from the sensed facts it carries. */
function attackTargetName(choice: SurvivalChoiceLike): string | null {
  if (typeof choice.targetName === 'string' && choice.targetName.length > 0) return choice.targetName
  const producer = choice.meta?.['producerMob']
  return typeof producer === 'string' && producer.length > 0 ? producer : null
}

/** The minecraft-data entity category a candidate answers, or null (UNKNOWN). */
function attackTargetKind(choice: SurvivalChoiceLike): string | null {
  const kind = choice.meta?.['targetKind']
  return typeof kind === 'string' && kind.length > 0 ? kind : null
}

/**
 * Is this candidate an ATTACK whose causal identity is a HOSTILE THREAT (rather
 * than one instance of a producer/food hunt)? Only these may be re-grounded onto
 * a churned entity id: for a `goalDrop`/food candidate the individual instance IS
 * the claim (see `candidates.ts`), so adopting another one would be the measured
 * `HUNT_RETARGET` failure - a semantic retarget - and stays forbidden.
 */
function isHostileThreatAttack(choice: SurvivalChoiceLike): boolean {
  if (choice.kind !== 'ATTACK') return false
  if (choice.meta?.['targetHostile'] !== true) return false
  if (choice.meta?.['goalDrop'] !== undefined) return false
  if (choice.meta?.['foodAnimal'] === true) return false
  if (choice.meta?.['foodRoute'] !== undefined) return false
  return true
}

function position(choice: SurvivalChoiceLike): Vec3Json | null {
  const target = choice.target
  if (target === null || target === undefined) return null
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.z)) return null
  return target
}

/**
 * The bounded identity-churn adoption: which fresh candidate, if any, is the
 * SAME causal threat as the vanished ATTACK under a new entity id.
 *
 * Pure and total. Every condition is a fact the caller proved (see the section
 * comment above `IDENTITY_CHURN_RADIUS`); anything unknown refuses, so this can
 * never adopt an unrelated entity, a different kind, or a threat whose old entity
 * is still alive.
 */
export function identityChurnCandidate(
  chosen: SurvivalChoiceLike | null,
  fresh: readonly SurvivalChoiceLike[],
  context: MobIdentityContext | null | undefined,
): { candidate: SurvivalChoiceLike; facts: MobIdentityChurnFacts } | null {
  if (chosen === null || context === null || context === undefined) return null
  if (!isHostileThreatAttack(chosen)) return null
  const fromEntityId = attackEntityId(chosen)
  if (fromEntityId === null) return null
  // 1. the previous entity is proven GONE (the server destroyed that exact id).
  if (context.previousEntityTracked !== false) return null
  // 4. the churn happened inside the bounded window (snapshot times, code-owned).
  const nowMs = context.nowMs
  const chosenAtMs = context.chosenAtMs
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return null
  if (typeof chosenAtMs !== 'number' || !Number.isFinite(chosenAtMs)) return null
  const elapsedMs = nowMs - chosenAtMs
  if (elapsedMs < 0 || elapsedMs > IDENTITY_CHURN_WINDOW_MS) return null
  const fromPosition = position(chosen)
  const name = attackTargetName(chosen)
  if (fromPosition === null || name === null) return null
  const kind = attackTargetKind(chosen)
  // 5. the replacement appeared during the window: it was NOT in the snapshot the
  // vanished candidate was chosen from. An UNKNOWN snapshot refuses.
  const known = context.knownEntityIds
  if (known === null || known === undefined) return null

  for (const candidate of fresh) {
    if (candidate === chosen) continue
    if (!isHostileThreatAttack(candidate)) continue
    const toEntityId = attackEntityId(candidate)
    if (toEntityId === null || toEntityId === fromEntityId) continue
    // 2. never a different kind: the mob name (and the entity kind when exposed)
    // must be exactly the same.
    if (attackTargetName(candidate) !== name) continue
    const candidateKind = attackTargetKind(candidate)
    if (kind !== null && candidateKind !== null && candidateKind !== kind) continue
    // 3. the same place: within the bounded radius of the last recorded position.
    const toPosition = position(candidate)
    if (toPosition === null) continue
    const moved = distance(fromPosition, toPosition)
    if (!(moved <= IDENTITY_CHURN_RADIUS)) continue
    // 5. not an entity that was already standing there at decision time.
    if (known.has(toEntityId)) continue
    return {
      candidate,
      facts: {
        fromEntityId,
        toEntityId,
        name,
        kind: candidateKind ?? kind,
        distance: moved,
        elapsedMs,
        rule: 'same_kind_near_last_position',
        goneEvidence: 'not_in_client_tracked_set',
        newEntity: 'absent_from_decision_snapshot',
      },
    }
  }
  return null
}

/**
 * Re-ground a vanished chosen survival action from the fresh offer.
 *
 * RETREAT prefers heading continuity: the committed destination when it is
 * still grounded, else the fresh retreat nearest it, else the offer order
 * (farthest-from-threat first, `selectKeepDistanceSpots`). The measured body
 * was re-deciding every ~1 s while being knocked back, and every retarget
 * revoked the in-flight leg - so the replacement rule deliberately does NOT
 * require *better* than the dropped one (another way to end the tick with no
 * action). A grounded survival action of the same kind, as close to the
 * already-chosen heading as possible, is enough; Jev re-chooses on the next
 * decision.
 */
export function regroundVanishedSurvivalChoice(
  chosen: SurvivalChoiceLike | null,
  fresh: readonly SurvivalChoiceLike[],
  context?: MobIdentityContext | null,
): SurvivalRegroundResult {
  if (chosen === null) {
    return {
      candidateId: null,
      kind: null,
      reason: 'not_a_survival_action',
      entityId: null,
      outcome: 'NOT_A_SURVIVAL_ACTION',
      identityChurn: null,
    }
  }
  if (!SURVIVAL_REGROUNDABLE_KINDS.has(chosen.kind)) {
    return {
      candidateId: null,
      kind: null,
      reason: 'not_a_survival_action',
      entityId: null,
      outcome: 'NOT_A_SURVIVAL_ACTION',
      identityChurn: null,
    }
  }

  if (chosen.kind === 'ATTACK') {
    const entityId = attackEntityId(chosen)
    const same = fresh.find(
      (candidate) => candidate.kind === 'ATTACK' && entityId !== null && attackEntityId(candidate) === entityId,
    )
    if (same !== undefined) {
      return {
        candidateId: same.id,
        kind: 'ATTACK',
        reason: 'same_target_attack',
        entityId,
        outcome: 'REGROUNDED',
        identityChurn: null,
      }
    }
    // The exact entity id is gone. For a HOSTILE threat that is the NORMAL case
    // when the mob's identity churns by design (a magma cube/slime is REPLACED
    // when its size state changes: same name, same kind, same place, new id), so
    // before declaring the premise destroyed, try the bounded adoption rule above
    // - same hostile kind, at (within `IDENTITY_CHURN_RADIUS` of) the position the
    // candidate recorded, inside `IDENTITY_CHURN_WINDOW_MS`, with the old entity
    // PROVEN gone from the client's tracked set and the replacement proven NEW.
    // Jev chose to fight THAT threat; this keeps fighting it. Nothing else is
    // adopted: a different kind, a live old entity, a pre-existing bystander, a
    // producer/food hunt instance and an unsensed mob all still end TARGET_LOST.
    const churn = identityChurnCandidate(chosen, fresh, context)
    if (churn !== null) {
      return {
        candidateId: churn.candidate.id,
        kind: 'ATTACK',
        reason: 'same_kind_near_last_position_attack',
        entityId,
        outcome: 'REGROUNDED_IDENTITY_CHURN',
        identityChurn: churn.facts,
      }
    }
    // The exact entity the response answered is gone (killed / despawned / left
    // the client's tracked set with no same-kind replacement), and no bounded
    // churn adoption is provable. Retargeting another mob would be a new WHICH
    // decision, so nothing is re-grounded - and the typed outcome says so instead
    // of leaving the tick silent: TARGET_LOST, never a kill and never a
    // substitute target.
    return {
      candidateId: null,
      kind: 'ATTACK',
      reason: 'no_grounded_equivalent',
      entityId,
      outcome: 'TARGET_LOST',
      identityChurn: null,
    }
  }

  const retreats = fresh.filter((candidate) => candidate.kind === 'RETREAT')
  const threatEntityId = numericMeta(chosen.meta, 'threatEntityId')
  // Heading continuity first: the destination Jev already committed to is still
  // grounded, so re-committing it lets the in-flight leg keep running. The
  // measured death loop (v2-n1, 21 deaths to a respawn swarm) retargeted EVERY
  // re-ground onto a different cell - each swap revoked the lease mid-leg, so
  // ~3 s of walking bought ~2 m before the next damage wake churned again.
  const sameCell = retreats.find((candidate) => candidate.id === chosen.id)
  if (sameCell !== undefined) {
    return {
      candidateId: sameCell.id,
      kind: 'RETREAT',
      reason: 'same_cell_keep_distance',
      entityId: threatEntityId ?? numericMeta(sameCell.meta, 'threatEntityId'),
      outcome: 'REGROUNDED',
      identityChurn: null,
    }
  }
  // The committed cell left the offer (positions moved). The replacement that
  // preserves the escape heading is the grounded retreat NEAREST that cell -
  // the walk re-paths a few blocks instead of reversing onto another cell.
  const origin = position(chosen)
  const nearest = (list: readonly SurvivalChoiceLike[]): SurvivalChoiceLike | undefined => {
    if (list.length === 0) return undefined
    if (origin === null) return list[0]
    let best = list[0] as SurvivalChoiceLike
    let bestDistance = Number.POSITIVE_INFINITY
    for (const candidate of list) {
      const spot = position(candidate)
      if (spot === null) continue
      const d = distance(spot, origin)
      if (d < bestDistance) {
        bestDistance = d
        best = candidate
      }
    }
    return best
  }
  if (threatEntityId !== null) {
    const sameThreat = nearest(
      retreats.filter((candidate) => numericMeta(candidate.meta, 'threatEntityId') === threatEntityId),
    )
    if (sameThreat !== undefined) {
      return {
        candidateId: sameThreat.id,
        kind: 'RETREAT',
        reason: 'same_threat_keep_distance',
        entityId: threatEntityId,
        outcome: 'REGROUNDED',
        identityChurn: null,
      }
    }
  }
  const first = nearest(retreats)
  if (first !== undefined) {
    return {
      candidateId: first.id,
      kind: 'RETREAT',
      reason: 'any_threat_keep_distance',
      entityId: threatEntityId ?? numericMeta(first.meta, 'threatEntityId'),
      outcome: 'REGROUNDED',
      identityChurn: null,
    }
  }
  // No grounded keep-distance action exists at all: the CAPABILITY the chosen
  // response required is gone, which is a typed return to policy - not a silent
  // empty tick while a hostile is on the body.
  return {
    candidateId: null,
    kind: 'RETREAT',
    reason: 'no_grounded_equivalent',
    entityId: threatEntityId,
    outcome: 'CAPABILITY_LOST',
    identityChurn: null,
  }
}

/**
 * The grounded CONTROL action a tick executes when a chosen survival action can
 * neither be re-grounded nor served by the restricted fresh offer while a hostile
 * is IN CONTACT.
 *
 * This is the measured death shape (operator report + run log: a wither skeleton
 * at 0.57m, health 4.37, `freshOffer=1`, the lone candidate not an equivalent of
 * the chosen `RETREAT:p23_57_-20` -> `candidateId: null` -> NO action -> DEATH 32),
 * and the same shape at 2.38m / health 2.51 for `ATTACK:e15787`.
 *
 * The control action mutates nothing: `ESCALATE`/`WAIT` only hand the decision
 * back to the semantic layer, so executing one is not a fight/flight choice, not
 * a target choice and not a destination choice. It exists so a tick can never end
 * actionless with a hostile on the body.
 */
export interface SurvivalControlFallbackInput {
  reground: SurvivalRegroundResult
  /** the threat envelope says a hostile is inside contact range right now */
  threatInContact: boolean
  /** the RESTRICTED fresh offer the re-ground ran against */
  freshCandidates: readonly { id: string; kind: string }[]
  /**
   * The code-owned ESCALATE the CALLER can still execute. Measured live
   * (`controller.ts`, documented in-tree): a chosen survival action that
   * cannot be re-grounded at contact left the tick with nothing, because the
   * contact envelope had already filtered WAIT/ESCALATE out - while a reachable
   * ATTACK sat in the offer and the body was killed in the same second.
   *
   * `ESCALATE` mutates nothing, picks no fight/flight answer, no target and no
   * destination (it only hands the decision back to the semantic layer), so a tick
   * ending actionless with a hostile in contact is strictly worse than executing
   * it. This is NOT a substituted action: it is the same control action the
   * generator itself synthesizes when the contact filter grounds no combat option
   * at all (`candidates.ts` `restrictCandidatesDuringImmediateThreat`).
   */
  codeOwnedEscalate?: { id: string; kind: string } | null
}

export interface SurvivalControlFallback {
  candidateId: string | null
  /** why a control action was or was not taken (greppable) */
  reason:
    | 'regrounded'
    | 'control_action_escalate'
    | 'control_action_escalate_code_owned'
    | 'control_action_wait'
    | 'not_a_survival_action'
    | 'threat_not_in_contact'
    | 'no_control_action_offered'
}

/**
 * Decide the fallback for one vanished survival choice. Pure; the CALLER owns the
 * re-ground attempt (this only answers "what if nothing could serve it").
 */
export function survivalControlFallback(input: SurvivalControlFallbackInput): SurvivalControlFallback {
  if (input.reground.candidateId !== null) return { candidateId: null, reason: 'regrounded' }
  if (input.reground.kind === null) return { candidateId: null, reason: 'not_a_survival_action' }
  if (!input.threatInContact) return { candidateId: null, reason: 'threat_not_in_contact' }
  const escalate = input.freshCandidates.find((candidate) => candidate.kind === 'ESCALATE')
  if (escalate !== undefined) return { candidateId: escalate.id, reason: 'control_action_escalate' }
  const wait = input.freshCandidates.find((candidate) => candidate.kind === 'WAIT')
  if (wait !== undefined) return { candidateId: wait.id, reason: 'control_action_wait' }
  // The contact envelope filtered both control kinds out. The code-owned ESCALATE
  // is still executable (see the input contract): an actionless tick with a
  // hostile in contact is the measured death shape.
  if (input.codeOwnedEscalate !== null && input.codeOwnedEscalate !== undefined) {
    return { candidateId: input.codeOwnedEscalate.id, reason: 'control_action_escalate_code_owned' }
  }
  return { candidateId: null, reason: 'no_control_action_offered' }
}

/** `SURVIVAL_REGROUND from=... to=... kind=... reason=... offer=... threat=...`. */
export function formatSurvivalReground(
  from: string,
  result: SurvivalRegroundResult,
  freshOfferSize: number,
  evidence: ThreatStateEvidence | null,
  body: BodySurvivalFacts,
): string {
  const threat = evidence?.threatName ?? 'none'
  const distance = evidence?.threatDistance === null || evidence?.threatDistance === undefined
    ? 'unknown'
    : `${round2(evidence.threatDistance)}m`
  return (
    `${SURVIVAL_REGROUND} from=${from} to=${result.candidateId ?? 'none'} kind=${result.kind ?? 'none'} ` +
    `reason=${result.reason} outcome=${result.outcome} offer=${freshOfferSize} threat=${threat} threatId=${evidence?.threatId ?? 'none'} ` +
    `distance=${distance} contact=${evidence?.inContact ?? false} health=${round2(body.health)} food=${body.food}`
  )
}

/**
 * `MOB_IDENTITY_CHURN from=e49561 to=e49572 mob=magma_cube kind=Hostile mobs
 * moved=0.4m elapsedMs=210 rule=same_kind_near_last_position
 * gone=not_in_client_tracked_set new=absent_from_decision_snapshot` - the bounded
 * identity rule that kept the body fighting the same causal threat.
 *
 * The fields are the whole proof: WHICH id vanished, WHICH id replaced it, the
 * mob type/kind both entities share, how far the replacement is from the position
 * the vanished candidate recorded, how long after the decision-time snapshot the
 * churn was observed, the rule name, and the two fail-closed facts (`gone`, `new`)
 * that keep the rule from adopting a live, a different-kind, or a pre-existing
 * entity. Mirrored, so a post-mortem of a churn fight reads it in `buddy.log`.
 */
export function formatMobIdentityChurn(
  from: string,
  facts: MobIdentityChurnFacts,
  evidence: ThreatStateEvidence | null,
  body: BodySurvivalFacts,
): string {
  const distance = evidence?.threatDistance === null || evidence?.threatDistance === undefined
    ? 'unknown'
    : `${round2(evidence.threatDistance)}m`
  return (
    `${MOB_IDENTITY_CHURN} from=${from} to=ATTACK:e${facts.toEntityId} mob=${facts.name} kind=${facts.kind ?? 'unknown'} ` +
    `fromEntityId=${facts.fromEntityId} toEntityId=${facts.toEntityId} moved=${round2(facts.distance)}m ` +
    `elapsedMs=${Math.round(facts.elapsedMs)} rule=${facts.rule} gone=${facts.goneEvidence} new=${facts.newEntity} ` +
    `threat=${evidence?.threatName ?? 'none'} threatId=${evidence?.threatId ?? 'none'} distance=${distance} ` +
    `contact=${evidence?.inContact ?? false} health=${round2(body.health)} food=${body.food} ` +
    `-> the same causal threat under a new entity id; never a different kind, never a live old entity, never an entity already known at decision time`
  )
}

/**
 * `SURVIVAL_NO_GROUNDED_ACTION ...` - the tick ended with no survival action at
 * all. This is a typed capability gap, never a silent drop: the body is in a
 * fight the deterministic layer cannot ground an answer for.
 */
export function formatSurvivalNoGroundedAction(
  from: string,
  result: SurvivalRegroundResult,
  freshOfferSize: number,
  evidence: ThreatStateEvidence | null,
  body: BodySurvivalFacts,
): string {
  const threat = evidence?.threatName ?? 'unknown'
  const distance = evidence?.threatDistance === null || evidence?.threatDistance === undefined
    ? 'unknown'
    : `${round2(evidence.threatDistance)}m`
  return (
    `${SURVIVAL_NO_GROUNDED_ACTION} chosen=${from} kind=${result.kind ?? 'none'} reason=${result.reason} outcome=${result.outcome} ` +
    `offer=${freshOfferSize} threat=${threat} threatId=${evidence?.threatId ?? 'none'} distance=${distance} ` +
    `contact=${evidence?.inContact ?? false} health=${round2(body.health)} food=${body.food} ` +
    `-> no grounded attack/keep-distance action for this tick`
  )
}

/**
 * The distance a hostile family can ANSWER from. Distinct from the bounded
 * response envelope (`THREAT_RESPONSE_RANGE`): a ghast fires from up to 64 m,
 * so a hostile that hit the body from beyond this envelope is a real,
 * attributable attacker the local layer cannot ground an answer for.
 */
export function threatAttackRange(name: string): number {
  const mob = name.toLowerCase()
  if (mob === 'ghast') return 64
  return threatStandoffRange(mob) * 2
}

export interface UnansweredRangedThreat {
  id: number
  name: string
  distance: number
  /** the separation the body would need to answer this family from */
  standoff: number
}

/**
 * Hostiles that damaged the body (Mineflayer attribution) while sitting outside
 * the bounded response envelope. Code-owned truth only: `attackedSelf` is the
 * recorded attacker, never a guess, so a distant zombie cannot be blamed for a
 * spider bite.
 */
export function unansweredRangedThreats(
  entities: readonly ThreatEntityLike[],
): UnansweredRangedThreat[] {
  const out: UnansweredRangedThreat[] = []
  for (const entity of entities) {
    if (!entity.hostile) continue
    if (entity.attackedSelf !== true) continue
    if (!Number.isFinite(entity.distance)) continue
    // The ARMING envelope stays `THREAT_RESPONSE_RANGE` for every family: a
    // response is only armed when the local layer can actually ground one. What
    // this rule adds is the opposite direction - naming the attacker that hit the
    // body from beyond that envelope, where no grounded answer exists yet.
    if (entity.distance <= THREAT_RESPONSE_RANGE) continue
    out.push({
      id: entity.id,
      name: entity.name,
      distance: entity.distance,
      standoff: threatStandoffRange(entity.name),
    })
  }
  return out.sort((a, b) => a.distance - b.distance)
}

/**
 * The typed facts the body has about an attacker that damaged it while being
 * absent from its own sensor snapshot.
 *
 * This is NOT an invented entity. Every field comes from the recorded damage
 * attribution (`signals.lastDamage`) plus the body's own inventory truth, and
 * the entity list is consulted only to CONFIRM the attacker is not in it. The
 * measured shape (`THREAT_RANGED_UNANSWERED threat=ender_dragon distance=null
 * sensed=false` then `DEATH_CAUSE killer=ender_dragon killerEvidence=mineflayer
 * killerId=39414`) is exactly this: an attacker the sensor never placed,
 * hitting the body.
 */
export interface UnsensedAttacker {
  /** the attacker's entity id from the damage attribution, or null when absent */
  id: number | null
  name: string
  /** wall-clock ms of the damage observation this came from */
  atMs: number
  /** how old that observation is, ms (null when the timestamp is unusable) */
  ageMs: number | null
  /**
   * WHERE the damage came from, when the server stated it (`damage_event`
   * `sourcePosition`, or the resolved source entity's position). `null` is
   * UNKNOWN, never "no threat": without it no direction can be grounded, and
   * the evidence must say so instead of guessing one.
   */
  position: Vec3Json | null
  /** the code-owned reason a position is unknown, or null when one is known */
  positionMissingReason: string | null
  /** the separation the body would need to answer this family from */
  standoff: number
  /** the distance this family can attack from (a ghast fires from 64 m) */
  attackRange: number
}

/** The facts `unsensedAttackerFacts` reads; a structural subset of WorldState. */
export interface UnsensedAttackerObservation {
  entities: readonly ThreatEntityLike[]
  signals: {
    lastDamage?: LastDamageEvidence | null
    threat?: ThreatStateEvidence | null
  }
  timestampMs: number
}

/**
 * SAFE: the attacker that damaged the body and is NOT in its sensor snapshot.
 *
 * Returns `null` unless ALL of these hold, so nothing here can fabricate a
 * threat or resurrect a stale one:
 *
 *   * a damage attribution exists with a name or an id (an unattributed hit -
 *     fire, lava, a fall - is the environmental owner's fact, not this one);
 *   * it is inside `THREAT_MEMORY_MS` of the current tick;
 *   * NO sensed entity carries that id, and no sensed hostile carries that name.
 *
 * The entity check is deliberately one-sided: a sensor that witnessed the
 * attacker is the stronger evidence and owns the response, so this fact falls
 * silent the moment the attacker becomes visible - which is what keeps the
 * sensed engage/cover paths unchanged.
 *
 * `position` is copied from the damage attribution and is never derived from
 * proximity, the attacker's attack range, or the body's facing. When it is
 * absent, `positionMissingReason` names the missing fact instead of
 * substituting one.
 */
export function unsensedAttackerFacts(observation: UnsensedAttackerObservation): UnsensedAttacker | null {
  const damage = observation.signals.lastDamage ?? null
  if (damage === null || damage === undefined) return null
  const name = typeof damage.sourceName === 'string' && damage.sourceName.length > 0 ? damage.sourceName : null
  const id = typeof damage.sourceId === 'number' && Number.isFinite(damage.sourceId) ? damage.sourceId : null
  if (name === null && id === null) return null
  const atMs = Number.isFinite(damage.atMs) ? damage.atMs : null
  if (atMs === null) return null
  const ageMs = observation.timestampMs - atMs
  if (ageMs > THREAT_MEMORY_MS) return null
  if (id !== null && observation.entities.some((entity) => entity.id === id)) return null
  if (name !== null && observation.entities.some((entity) => entity.hostile && entity.name === name)) return null
  const position = normalPosition(damage.sourcePosition)
  return {
    id,
    name: name ?? `entity:${id ?? 'unknown'}`,
    atMs,
    ageMs: Math.max(0, ageMs),
    position,
    positionMissingReason:
      position === null ? 'damage_event.sourcePosition absent and source entity position unavailable' : null,
    standoff: threatStandoffRange(name ?? 'unknown'),
    attackRange: threatAttackRange(name ?? 'unknown'),
  }
}

function normalPosition(value: Vec3Json | null | undefined): Vec3Json | null {
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y) || !Number.isFinite(value.z)) return null
  return { x: value.x, y: value.y, z: value.z }
}

/**
 * `THREAT_RANGED_UNANSWERED ...` - a named attacker the body cannot answer.
 * `sensed=false` means even the entity is outside perception, so only the
 * damage attribution names it.
 *
 * The added fields state what the body can still DO about it, because "the
 * attacker is invisible" and "the body has no answer" are different facts and
 * the run log must not conflate them:
 *
 *   sourcePos=known|unknown    is the damage origin a grounded coordinate?
 *   response=<grounded route>|break_contact|no_destination|none
 *   missing=<the absent fact>  only when no destination could be grounded
 */
export function formatThreatRangedUnanswered(input: {
  goalKey: string
  threat: UnansweredRangedThreat | null
  /** the recorded damage source, when the entity itself was not sensed */
  sourceName: string | null
  body: BodySurvivalFacts
  weapon: WeaponFacts
  /** the unsensed-attacker facts, when this line is about one */
  attacker?: UnsensedAttacker | null
  /** what the body can still do about it (see `unsensedThreatResponse`) */
  response?: UnansweredThreatResponse
}): string {
  const name = input.threat?.name ?? input.sourceName ?? 'unknown'
  // Whole metres: the marker is deduped on its whole line, so a sub-metre
  // distance wobble must not produce a line per tick.
  const distance = input.threat === null ? 'unsensed' : `${Math.round(input.threat.distance)}m`
  const standoff = input.threat === null ? String(threatStandoffRange(name)) : String(input.threat.standoff)
  const range = String(threatAttackRange(name))
  const damage = input.weapon.damage === null ? 'unknown' : String(input.weapon.damage)
  const attacker = input.attacker ?? null
  const positionFact =
    attacker === null ? '' : ` sourcePos=${attacker.position === null ? 'unknown' : positionLabel(attacker.position)}`
  const responseFact = input.response === undefined ? '' : ` response=${input.response.kind}`
  const missingFact =
    input.response === undefined || input.response.missing.length === 0
      ? ''
      : ` missing=${input.response.missing.join('+')}`
  return (
    `${THREAT_RANGED_UNANSWERED} goal=${input.goalKey} threat=${name} distance=${distance} ` +
    `sensed=${input.threat !== null} standoff=${standoff} attackRange=${range}${positionFact} ` +
    `weapon=${input.weapon.label} weaponKind=${input.weapon.kind} weaponDamage=${damage} ` +
    `health=${round2(input.body.health)} food=${input.body.food} regenerating=${input.body.regenerating}` +
    `${responseFact}${missingFact} -> no grounded attack/keep-distance route outside the response envelope; typed gap, no action invented`
  )
}

function positionLabel(position: Vec3Json): string {
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

// ---------------------------------------------------------------------------
// SAFE: what an UNSEEN attacker can still be answered with.
// ---------------------------------------------------------------------------
//
// Measured (main `cd7b38b`, operator-summoned ender dragon + ghasts in the
// Nether):
//
//   THREAT_RANGED_UNANSWERED threat=ender_dragon distance=null sensed=false
//   CRITICAL_DAMAGE health=1.67 food=20 source=ender_dragon damage=2
//   CANDIDATE_WITHHELD candidate=ATTACK:e44077 reason=no_path
//   DEATH_CAUSE killer=ender_dragon killerEvidence=mineflayer killerId=39414 threat=null
//
// Three separate truths had to be separated:
//
//   1. `unansweredRangedThreats` reads `entity.attackedSelf`, and that fact is
//      projected onto SENSED entities only (`buildEntities`). An attacker that
//      never enters the snapshot therefore produces `[]` however hard it hits,
//      so the marker could only ever name it through the `sourceName` fallback.
//   2. Nothing owned "the body is being hit by an unseen attacker, so its
//      destination must break contact or line of sight". The route generator
//      reads a threat POSITION (`activeThreats` -> `pickRetreats` ->
//      `selectKeepDistanceSpots`), so an attacker with no sensed position
//      grounded no keep-distance route at all.
//   3. The offer then collapsed to the bounded `ESCALATE`, i.e. the body stood
//      still in the open and absorbed the next hit.
//
// This section owns the deterministic answer to (2). It never picks WHAT the
// body does and never invents a coordinate:
//
//   * a KNOWN damage origin grounds a real directional response - the existing
//     cover/keep-distance solver, fed with that position as the thing to move
//     away from and to ray cover against;
//   * an UNKNOWN damage origin grounds no direction, so the body gets a bounded
//     break-contact restriction (no work action, no standing-still WAIT) and the
//     typed evidence names the exact missing fact.

/** The kind of grounded response an unsensed attacker has. */
export type UnsensedThreatResponseKind =
  /** a cell exists that breaks the attacker's line of sight (real block truth) */
  | 'cover'
  /** a cell exists that genuinely gains separation from a known damage origin */
  | 'keep_distance'
  /** a KNOWN origin exists, but no qualifying destination could be grounded */
  | 'no_destination'
  /** the origin is UNKNOWN, so no direction can be grounded: break contact only */
  | 'break_contact'
  /** no visible attacker and no recorded attacker: nothing to answer */
  | 'none'

/**
 * The code-owned answer facts for an unsensed attacker. `missing` names the
 * ABSENT facts (never a guess), so the run log distinguishes "the body has no
 * answer" from "the body was never told where the attack came from".
 */
export interface UnansweredThreatResponse {
  kind: UnsensedThreatResponseKind
  /** the absent facts, most load-bearing first */
  missing: string[]
  /** true when a destination is grounded by this fact */
  grounded: boolean
}

/**
 * SAFE: can the body ground ANY physical response to an attacker it cannot see?
 *
 * `groundedDestinations` is how many destinations the existing keep-distance
 * solver produced from the damage origin - real cells that gain separation or
 * break its sight line - and `coverCells` how many of those are cover. Code owns
 * only these facts; WHICH destination (or none) stays Jev's choice.
 */
export function unsensedThreatResponse(input: {
  attacker: UnsensedAttacker | null
  /** destinations `selectKeepDistanceSpots` grounded from the damage origin */
  groundedDestinations: number
  /** the sensor's own cover cells for this origin (real block truth) */
  coverCells: number
  /** the body's grounded locomotion actions currently on offer */
  availableMoves: number
}): UnansweredThreatResponse {
  if (input.attacker === null) return { kind: 'none', missing: [], grounded: false }
  if (input.attacker.position === null) {
    return {
      kind: 'break_contact',
      // Named in the order the layers would consume them: without a position
      // there is no direction, and without a direction there is no cover ray,
      // no separation gain and no standoff to reach.
      missing: ['damage_source_position', 'attack_direction', 'keep_distance_destination'],
      grounded: false,
    }
  }
  if (input.groundedDestinations > 0) {
    return { kind: input.coverCells > 0 ? 'cover' : 'keep_distance', missing: [], grounded: true }
  }
  return {
    kind: 'no_destination',
    missing:
      input.availableMoves > 0 ? ['keep_distance_destination'] : ['keep_distance_destination', 'locomotion_route'],
    grounded: false,
  }
}

/**
 * `THREAT_BREAK_CONTACT ...` - the body is being hit by an attacker it cannot
 * place, no direction could be grounded, and the bounded break-contact
 * restriction is arming so the body cannot stand still in the open.
 *
 * The marker exists because the alternative is silence: the measured death had a
 * named killer in `DEATH_CAUSE` and nothing anywhere saying the body had no
 * physical answer while it was being hit.
 */
export const THREAT_BREAK_CONTACT = 'THREAT_BREAK_CONTACT'

export function formatThreatBreakContact(input: {
  goalKey: string
  attacker: UnsensedAttacker
  response: UnansweredThreatResponse
  body: BodySurvivalFacts
  weapon: WeaponFacts
  /** the grounded locomotion actions the restricted offer still carries */
  availableMoves: readonly string[]
}): string {
  const id = input.attacker.id === null ? 'none' : String(input.attacker.id)
  const age = input.attacker.ageMs === null ? 'unknown' : String(Math.round(input.attacker.ageMs))
  const damage = input.weapon.damage === null ? 'unknown' : String(input.weapon.damage)
  const moves = input.availableMoves.length === 0 ? 'none' : input.availableMoves.join(',')
  return (
    `${THREAT_BREAK_CONTACT} goal=${input.goalKey} threat=${input.attacker.name} attackerId=${id} ` +
    `sourcePos=${input.attacker.position === null ? 'unknown' : positionLabel(input.attacker.position)} ` +
    `missing=[${input.response.missing.join(',')}] moves=[${moves}] ` +
    `weapon=${input.weapon.label} weaponDamage=${damage} health=${round2(input.body.health)} food=${input.body.food} ` +
    `ageMs=${age} -> no direction could be grounded from the damage attribution; the body must keep moving, not stand still`
  )
}

// ---------------------------------------------------------------------------
// DEATH_CAUSE: the generation-side death telemetry.
// ---------------------------------------------------------------------------
//
// The host's `DEATH` line carries what the HOST owns: position, dimension,
// inventory, `cause=damage|lava|water|void` from block probes. It cannot carry
// the attributed attacker or the fight state, because those live here.
//
// Measured live (`run-muc3qbug-18vg3`, 03:28:32.634Z): `DEATH
// pos=23.5,59.0,-3.7 dimension=minecraft:the_nether cause=damage
// healthBefore=0.5` - and nothing in buddy.log said a spider had been inside
// melee contact for the previous 8 s or that a ghast had shelled the body from
// outside perception. The next post-mortem had to reconstruct the cause from
// `run.jsonl` by hand. This marker is that reconstruction, written once.

export const DEATH_CAUSE = 'DEATH_CAUSE'

export interface DeathCauseInput {
  dimension: string
  position: Vec3Json
  health: number
  food: number
  /** why the body died, from the host's own probe (`damage`/`lava`/... ) */
  hostCause: string | null
  /** the recorded damage attribution, when Mineflayer attributed one */
  lastDamage: LastDamageEvidence | null
  /** the code-owned danger state at death */
  threat: ThreatStateEvidence | null
  /** hostiles the last sensor snapshot could see, nearest first */
  hostiles: readonly { name: string; distance: number; hostile: boolean }[]
  weapon: WeaponFacts
  /** armour pieces worn at death, 0-4 */
  wornArmorCount: number
  /** age of the damage attribution at death, ms, or null when none */
  damageAgeMs: number | null
  /**
   * SAFE: the environmental cause the body was standing in at death (`fire` /
   * `lava` / `drowning`), or null when it was in none. Used ONLY when
   * Mineflayer attributed no attacker, so `killer=` names fire/lava/drowning
   * with the same evidence the body's own hazard state carries - never as a
   * guess over a real attribution.
   */
  envHazard?: string | null
}

/**
 * `DEATH_CAUSE dimension=... pos=... killer=... threat=... hostiles=[...]` -
 * one line that names the cause with evidence, or states explicitly that the
 * killer is unknown (`killer=unattributed`) instead of leaving a post-mortem to
 * infer it from `cause=damage`.
 *
 * Measured live (`run-mucaq28q-1ftq1`): the Nether deaths carried
 * `killer=null killerId=null` while the body was burning/standing in lava -
 * fire and lava have no attacking entity, so the entity-keyed attribution was
 * empty. When the body's own environmental hazard state has a damage-dealing
 * kind and no attacker was recorded, that hazard is the killer and
 * `killerEvidence=environment` says so; a real attribution always wins.
 */
export function formatDeathCause(input: DeathCauseInput): string {
  const hostiles = input.hostiles
    .filter((entity) => entity.hostile)
    .slice(0, 4)
    .map((entity) => `${entity.name}:${Math.round(entity.distance)}m`)
    .join(',')
  const environmental = input.lastDamage === null ? (input.envHazard ?? null) : null
  const killer = input.lastDamage?.sourceName ?? environmental ?? 'unattributed'
  const killerEvidence =
    input.lastDamage?.sourceName != null ? 'mineflayer' : environmental !== null ? 'environment' : 'none'
  return (
    `${DEATH_CAUSE} dimension=${input.dimension} pos=${input.position.x},${input.position.y},${input.position.z} ` +
    `health=${round2(input.health)} food=${input.food} hostCause=${input.hostCause ?? 'unknown'} ` +
    `killer=${killer} killerEvidence=${killerEvidence} killerId=${input.lastDamage?.sourceId ?? 'none'} damageAgeMs=${input.damageAgeMs ?? 'none'} ` +
    `threat=${input.threat?.threatName ?? 'none'} threatDistance=${input.threat?.threatDistance ?? 'none'} ` +
    `contact=${input.threat?.inContact ?? false} threatActiveMs=${input.threat?.activeMs ?? 0} ` +
    `weapon=${input.weapon.label} weaponDamage=${input.weapon.damage ?? 'unknown'} armor=${input.wornArmorCount}/4 ` +
    `hostiles=[${hostiles}]`
  )
}

export interface ThreatSeparationConstraint {
  position: Vec3Json
  standoff: number
}

/**
 * A retreat destination must not turn an already active secondary threat into a
 * closer/inside-standoff threat. When already inside standoff, require no loss
 * of separation; when outside, preserve the standoff boundary. Cover only
 * excuses the primary threat with a direct sensor proof.
 */
export function retreatPreservesThreatSeparation(
  self: Vec3Json,
  destination: Vec3Json,
  threats: readonly ThreatSeparationConstraint[],
): boolean {
  return threats.every((threat) => {
    const currentDistance = distance(self, threat.position)
    const nextDistance = distance(destination, threat.position)
    const minimum = currentDistance >= threat.standoff ? threat.standoff : currentDistance
    // Block-center coordinates can leave a sub-ulp difference on an equal
    // distance step. Tolerate numerical noise, never a meaningful approach.
    return nextDistance + 1e-9 >= minimum
  })
}

export interface KeepDistanceInput {
  /** body position (feet) */
  self: Vec3Json
  /** the threat to move away from, or null when only a hazard applies */
  threat: Vec3Json | null
  /**
   * Other active threats that a retreat must not make more dangerous. A cell is
   * rejected when it would enter their standoff range from outside it, or move
   * closer while the body is already inside that range. The primary threat may
   * use a separately proven cover cell; no cover fact is inferred for these
   * additional threats.
   */
  additionalThreats?: readonly ThreatSeparationConstraint[]
  /** standable cells the sensor sampled (the local 5x5x3 window) */
  standable: readonly Vec3Json[]
  /** threat-escape cells: the wider scan, already filtered to genuine separation */
  escapeCells?: readonly Vec3Json[]
  /**
   * SAFE/CAN: cells the sensor proved are NOT in the threat's line of sight - a
   * sight line from the threat's own eye position hits solid geometry before the
   * cell (real block truth, never a guess; a cell the sensor could not ray is
   * simply absent, so unknown never counts as cover).
   *
   * This is the fact that makes a RANGED attacker answerable at all. Measured
   * live (`run-mucgir1z-1p7oh`): a skeleton engaged the body from ~9 m inside a
   * Nether portal room. Distance alone cannot answer it - the body cannot outrun
   * an arrow and the room gives it no separation - while stepping out of the
   * attacker's sight line genuinely stops the attack. Without this fact the only
   * "reposition" the code could ground in that room was a cell of the portal.
   */
  occludedCells?: readonly Vec3Json[]
  /**
   * SAFE: cells where standing realizes a DIMENSION TRANSFER (a lit portal block,
   * `netherPortalPlan.isDimensionTransferBlock`). A keep-distance destination
   * must never be one: "move away from the threat" realized as a dimension
   * change abandons the whole objective and, in a portal room, walks straight
   * back into the same fight (measured `run-mucgir1z-1p7oh`: 186 transitions,
   * 30-90 s apart). Crossing is a semantic disengage owned by Jev/System2 - the
   * explicit `ENTER_PORTAL` candidate - never a mechanical keep-distance leg.
   */
  transferCells?: readonly Vec3Json[]
  /** separation gain required when a destination does not reach standoff */
  minGain?: number
  /** absolute separation that counts as "outside reach" for this threat */
  standoff?: number
  max?: number
}

export interface KeepDistanceSpot {
  spot: Vec3Json
  /** distance from the destination to the threat */
  separation: number
  /** separation gained over standing still */
  gain: number
  /** separation reaches the standoff range (outside the threat's reach) */
  outsideReach: boolean
  /** the destination came from the wider threat-escape scan */
  escape: boolean
  /** the threat's sight line to this destination is blocked (code-owned cover) */
  occluded: boolean
}

/**
 * Ground the destinations that actually keep distance from a threat.
 *
 * A destination qualifies when ANY of these holds:
 *   * it gains a real amount of separation (`MIN_KEEP_DISTANCE_GAIN`);
 *   * it reaches the threat's standoff range while not moving closer;
 *   * it is not in the threat's line of sight while not moving closer
 *     (`occludedCells`, the fact that answers a ranged attacker).
 *
 * The pre-existing rule (`separation > current + 0.25`) admitted 1.4 m shuffles
 * inside melee reach and labelled them "retreat to safety", which is the measured
 * `moved=0m` death. A dimension-transfer cell never qualifies at all: crossing a
 * dimension is not a keep-distance realization (see `transferCells`).
 *
 * Deterministic and bounded: the caller still owns WHICH destination is taken
 * (Jev), and the returned list is capped so the offer cannot be crowded.
 */
export function selectKeepDistanceSpots(input: KeepDistanceInput): KeepDistanceSpot[] {
  const threat = input.threat
  if (threat === null) return []
  const minGain = input.minGain ?? MIN_KEEP_DISTANCE_GAIN
  const standoff = input.standoff ?? THREAT_STANDOFF_RANGE
  const max = Math.max(0, input.max ?? 3)
  if (max === 0) return []
  const current = distance(input.self, threat)
  const transfer = new Set((input.transferCells ?? []).map(cellKey))
  const occluded = new Set((input.occludedCells ?? []).map(cellKey))
  const seen = new Set<string>()
  const scored: KeepDistanceSpot[] = []
  const consider = (spot: Vec3Json, escape: boolean): void => {
    const key = cellKey(spot)
    if (seen.has(key)) return
    seen.add(key)
    // A transfer cell is not a destination this solver may offer, whatever its
    // separation: the realization would leave the dimension, not keep distance.
    if (transfer.has(key)) return
    // A RETREAT cannot silently improve separation from its primary threat by
    // walking into another active hostile's reach. This is a mechanical safety
    // constraint only; Jev still chooses among the cells that satisfy it.
    if (!retreatPreservesThreatSeparation(input.self, spot, input.additionalThreats ?? [])) return
    const separation = distance(spot, threat)
    const gain = separation - current
    const outsideReach = separation >= standoff
    const inCover = occluded.has(key)
    // Cover qualifies on its own. It is a real block-truth fact ("this cell is
    // not in the attacker's sight line", never a guess - an un-rayable cell is
    // simply absent), and it is the ONE fact that answers a ranged attacker the
    // body cannot outrun. The earlier `gain > 0` conjunct made cover unusable
    // against precisely the attacker this rule exists for: an origin far enough
    // away that no local cell gains radial separation. A lateral step that stops
    // the attack is not "moving closer" in any sense that matters.
    const qualifies = gain >= minGain || (outsideReach && gain > 0) || inCover
    if (!qualifies) return
    scored.push({ spot, separation, gain, outsideReach, escape, occluded: inCover })
  }
  for (const spot of input.escapeCells ?? []) consider(spot, true)
  for (const spot of input.standable) consider(spot, false)
  // Farthest from the threat first: this is a CAN narrowing (at most `max`
  // destinations are handed to Jev), not a preference among action kinds.
  const bySeparation = (a: KeepDistanceSpot, b: KeepDistanceSpot): number => b.separation - a.separation
  const plain = scored.filter((entry) => !entry.occluded).sort(bySeparation)
  const covered = scored.filter((entry) => entry.occluded).sort(bySeparation)
  // The STEP representative: the qualifying destination nearest the body. The
  // separation sort alone hands the gate only the scan's farthest cells, and
  // measured live (portal-p5) those 10-22 m destinations all failed
  // no_path/path_timeout inside a broken-terrain pocket while nearer steps
  // that could chain out never reached the offer. Reserving one slot for the
  // nearest qualifying cell guarantees a realizable leg is always present;
  // farthest-first still dominates the remaining slots on open ground.
  const step = plain.reduce<KeepDistanceSpot | null>(
    (nearest, entry) =>
      nearest === null || distance(entry.spot, input.self) < distance(nearest.spot, input.self) ? entry : nearest,
    null,
  )
  const rest = step === null ? plain : plain.filter((entry) => entry !== step)
  // COVER RESERVES THE FIRST SLOT. Cover and separation are different facts with
  // the same effect (the attack stops), but only one of them is measured ALONG
  // the axis the attack travels: a cell out of the sight line stops a ranged
  // attacker the body cannot outrun at ANY separation, while a "farther" cell
  // still in the firing line does not. Sorting purely by separation put the
  // scan's boundary cells - the farthest by construction - ahead of every cover
  // cell, so with an unsensed attacker (whose local cells barely move the radial
  // number) cover was grounded and then never offered. One reserved slot is the
  // smallest change that makes the fact representable; the rest of the offer
  // keeps the measured separation ordering exactly.
  if (covered.length === 0) return [...rest.slice(0, Math.max(0, max - 1)), ...(step === null ? [] : [step])].slice(0, max)
  return max === 0 ? [] : [covered[0] as KeepDistanceSpot, ...(step === null ? [] : [step]), ...covered.slice(1), ...rest].slice(0, max)
}

function cellKey(spot: Vec3Json): string {
  return `${spot.x},${spot.y},${spot.z}`
}

function distance(a: Vec3Json, b: Vec3Json): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
