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
import type { EntityState, LastDamageEvidence, Vec3Json } from './state.ts'

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

/** Sensor window (blocks) for threat escape cells. */
export const THREAT_ESCAPE_RADIUS = 6

/** Vertical half-window of the escape scan, matching `buildTerrain`. */
export const THREAT_ESCAPE_DY = 1

/** Upper bound on escape cells kept, so the offer cannot be crowded. */
export const THREAT_ESCAPE_MAX_CELLS = 12

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
  'id' | 'name' | 'hostile' | 'distance' | 'position' | 'attackedSelf' | 'lineOfSight' | 'heldItem'
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
  meta?: Readonly<Record<string, unknown>> | undefined
}

export type SurvivalRegroundReason =
  | 'not_a_survival_action'
  | 'same_target_attack'
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

/**
 * Re-ground a vanished chosen survival action from the fresh offer.
 *
 * `fresh` is scanned in the order the generator produced it, so the destination
 * preference that already narrowed the offer (farthest-from-threat first,
 * `selectKeepDistanceSpots`) is preserved instead of being re-derived here. The
 * rule is deliberately NOT "pick the safest fresh action": the measured body was
 * re-deciding every ~1 s while being knocked back, and any requirement that the
 * replacement be *better* than the dropped one is another way to end the tick
 * with no action. Any grounded survival action of the same kind is enough; Jev
 * re-chooses on the next decision.
 */
export function regroundVanishedSurvivalChoice(
  chosen: SurvivalChoiceLike | null,
  fresh: readonly SurvivalChoiceLike[],
): SurvivalRegroundResult {
  if (chosen === null) {
    return { candidateId: null, kind: null, reason: 'not_a_survival_action', entityId: null, outcome: 'NOT_A_SURVIVAL_ACTION' }
  }
  if (!SURVIVAL_REGROUNDABLE_KINDS.has(chosen.kind)) {
    return { candidateId: null, kind: null, reason: 'not_a_survival_action', entityId: null, outcome: 'NOT_A_SURVIVAL_ACTION' }
  }

  if (chosen.kind === 'ATTACK') {
    const entityId = attackEntityId(chosen)
    const same = fresh.find(
      (candidate) => candidate.kind === 'ATTACK' && entityId !== null && attackEntityId(candidate) === entityId,
    )
    if (same !== undefined) {
      return { candidateId: same.id, kind: 'ATTACK', reason: 'same_target_attack', entityId, outcome: 'REGROUNDED' }
    }
    // The exact entity the response answered is gone (killed / left the sensor).
    // Retargeting another mob would be a new WHICH decision, so nothing is
    // re-grounded - and the typed outcome says so instead of leaving the tick
    // silent: TARGET_LOST, never a kill and never a substitute target.
    return { candidateId: null, kind: 'ATTACK', reason: 'no_grounded_equivalent', entityId, outcome: 'TARGET_LOST' }
  }

  const retreats = fresh.filter((candidate) => candidate.kind === 'RETREAT')
  const threatEntityId = numericMeta(chosen.meta, 'threatEntityId')
  if (threatEntityId !== null) {
    const sameThreat = retreats.find(
      (candidate) => numericMeta(candidate.meta, 'threatEntityId') === threatEntityId,
    )
    if (sameThreat !== undefined) {
      return {
        candidateId: sameThreat.id,
        kind: 'RETREAT',
        reason: 'same_threat_keep_distance',
        entityId: threatEntityId,
        outcome: 'REGROUNDED',
      }
    }
  }
  const first = retreats[0]
  if (first !== undefined) {
    return {
      candidateId: first.id,
      kind: 'RETREAT',
      reason: 'any_threat_keep_distance',
      entityId: threatEntityId ?? numericMeta(first.meta, 'threatEntityId'),
      outcome: 'REGROUNDED',
    }
  }
  // No grounded keep-distance action exists at all: the CAPABILITY the chosen
  // response required is gone, which is a typed return to policy - not a silent
  // empty tick while a hostile is on the body.
  return { candidateId: null, kind: 'RETREAT', reason: 'no_grounded_equivalent', entityId: threatEntityId, outcome: 'CAPABILITY_LOST' }
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
}

export interface SurvivalControlFallback {
  candidateId: string | null
  /** why a control action was or was not taken (greppable) */
  reason:
    | 'regrounded'
    | 'control_action_escalate'
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
 * `THREAT_RANGED_UNANSWERED ...` - a named attacker the body cannot answer.
 * `sensed=false` means even the entity is outside perception, so only the
 * damage attribution names it.
 */
export function formatThreatRangedUnanswered(input: {
  goalKey: string
  threat: UnansweredRangedThreat | null
  /** the recorded damage source, when the entity itself was not sensed */
  sourceName: string | null
  body: BodySurvivalFacts
  weapon: WeaponFacts
}): string {
  const name = input.threat?.name ?? input.sourceName ?? 'unknown'
  // Whole metres: the marker is deduped on its whole line, so a sub-metre
  // distance wobble must not produce a line per tick.
  const distance = input.threat === null ? 'unsensed' : `${Math.round(input.threat.distance)}m`
  const standoff = input.threat === null ? String(threatStandoffRange(name)) : String(input.threat.standoff)
  const range = String(threatAttackRange(name))
  const damage = input.weapon.damage === null ? 'unknown' : String(input.weapon.damage)
  return (
    `${THREAT_RANGED_UNANSWERED} goal=${input.goalKey} threat=${name} distance=${distance} ` +
    `sensed=${input.threat !== null} standoff=${standoff} attackRange=${range} ` +
    `weapon=${input.weapon.label} weaponKind=${input.weapon.kind} weaponDamage=${damage} ` +
    `health=${round2(input.body.health)} food=${input.body.food} regenerating=${input.body.regenerating} ` +
    `-> no grounded attack/keep-distance route outside the response envelope; typed gap, no action invented`
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

export interface KeepDistanceInput {
  /** body position (feet) */
  self: Vec3Json
  /** the threat to move away from, or null when only a hazard applies */
  threat: Vec3Json | null
  /** standable cells the sensor sampled (the local 5x5x3 window) */
  standable: readonly Vec3Json[]
  /** threat-escape cells: the wider scan, already filtered to genuine separation */
  escapeCells?: readonly Vec3Json[]
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
}

/**
 * Ground the destinations that actually keep distance from a threat.
 *
 * A destination qualifies when EITHER it reaches the threat's standoff range
 * while not moving closer, OR it gains a real amount of separation
 * (`MIN_KEEP_DISTANCE_GAIN`). The pre-existing rule (`separation > current +
 * 0.25`) admitted 1.4 m shuffles inside melee reach and labelled them
 * "retreat to safety", which is the measured `moved=0m` death.
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
  const seen = new Set<string>()
  const scored: KeepDistanceSpot[] = []
  const consider = (spot: Vec3Json, escape: boolean): void => {
    const key = `${spot.x},${spot.y},${spot.z}`
    if (seen.has(key)) return
    seen.add(key)
    const separation = distance(spot, threat)
    const gain = separation - current
    const outsideReach = separation >= standoff
    const qualifies = gain >= minGain || (outsideReach && gain > 0)
    if (!qualifies) return
    scored.push({ spot, separation, gain, outsideReach, escape })
  }
  for (const spot of input.escapeCells ?? []) consider(spot, true)
  for (const spot of input.standable) consider(spot, false)
  // Farthest from the threat first: this is a CAN narrowing (at most `max`
  // destinations are handed to Jev), not a preference among action kinds.
  scored.sort((a, b) => b.separation - a.separation)
  return scored.slice(0, max)
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
