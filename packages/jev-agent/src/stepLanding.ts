// stepLanding.ts - the PER-STEP landing verdict for the locomotion leg.
//
// THE MEASURED DEFECT (live run run-mucdemk5-1kg6b, Nether):
//
//   07:48:52 HEARTBEAT pos=30.2,55.9,-20.1   <- standing ON the fortress walkway,
//                                               on a RETRIEVE:known:blaze_rod:b37_55_-25 leg
//   <2 s later the body's own cell reads (32,30,-22)   <- a ~26-block drop INSIDE that leg
//   07:48:57 DEATH pos=32.3,28.3,-20.8       <- the lava lake under the fortress
//
// The candidate layer had ALREADY withheld every basin MOVE
// (`CANDIDATE_WITHHELD ... reason=hazard_blocked`) and refused the ascents
// (`needs_ascend ["safe_column:no_clearance@..."]`), so the body was never
// OFFERED a move into the lava. The fall happened while FOLLOWING the committed
// leg: `policy.ts guardMove` validates only the FINAL target cell
// (`nearestHazardTo` over `state.blocks` + the 5x5x3 `state.terrain.standable`
// window), and the per-tick actuators validated only headroom / face geometry -
// never the LANDING of the step they were about to take.
//
// This module owns exactly ONE question, asked once per step BEFORE the body is
// actuated: does the step's landing column hold REAL ground within the movement
// policy's own drop bound, and is the landing cell itself free of a hazard?
//
// It reuses the fact owners instead of inventing a second world model:
//   * `state.ts PROBE_HAZARDS`  - the hazard block vocabulary (`hazardAt`);
//   * `state.ts PROBE_FLUIDS`   - the fluids the submersion machinery owns;
//   * `state.ts isPassable`     - passable == empty bounding box (UNKNOWN is not
//                                 passable there; here UNKNOWN is not a refusal).
//
// It NEVER re-plans: a refusal stops the leg where the body stands and returns a
// typed reason to the policy layer, which owns WHICH grounded action/destination
// comes next (#436: that is Jev's WHICH, not the actuator's). The ordinary
// withheld-candidate/escalation path already reports an impossible route.
//
// UNKNOWN IS NOT FALSE: an unloaded/unobserved cell (`null`) is never a hazard
// and never a refusal - the step behaves exactly as it did before this guard.
//
// THE SECOND MEASURED DEATH (main 67388ac, live run): the body had pillared to
// y79 above the operator's floated Nether gate and bridged at that height, then
//
//   04:28:19 (26.3,79.0,-4.5) overworld -> 04:28:38 (-7.5,51.0,-5.5)  (28 blocks down)
//   04:28:38 DEATH pos=26.3,79.0,-4.5  (deaths 142 -> 143; keepInventory held the kit)
//
// The guard above answers "is there a bottom, and is it lava?" - never "how far
// is the bottom?". `classifyStepLanding` walks the column down to the first block
// that stops the fall and then throws the DISTANCE away: it returns that block's
// NAME (`support`), so a 1-block step down and an 8-block drop onto the same
// stone produce the identical `{ reason: null }`. Nothing in the repository
// converts a drop into damage, and nothing compares a drop against the body's own
// health, so a leg could commit to a landing that kills the body while every
// existing predicate - hazard, standability, `maxDropDown`, sprint, jump - said
// yes. That is the missing fact this module now owns:
//
//   * {@link fallDamageHp}        - vanilla fall damage for a MEASURED drop;
//   * {@link armorFallMitigation} - the worn armour's reduction of it;
//   * {@link maxSurvivableDrop}   - the deepest drop the body may take and stay
//                                   above the ONE critical-health floor;
//   * {@link fallSurvivability}   - the verdict: is THIS landing fatal?
//
// It is a DAMAGE model, not a second geometry: the drop it prices is the drop the
// existing scan already measures, the hazard/fluid vocabulary is the sensor's own
// (`PROBE_HAZARDS`/`PROBE_FLUIDS`), and the health floor is `criticalDamage.ts`'s
// single `CRITICAL_DAMAGE_HEALTH`. A body whose health is unknown is NOT refused
// (UNKNOWN is not false, exactly as for an unloaded cell); a PROVEN drop -
// including a proven LOWER BOUND read off the observed emptiness above an
// unloaded cell - is.
import { CRITICAL_DAMAGE_HEALTH } from './criticalDamage.ts'
import type { ArmorState, Vec3Json } from './state.ts'
import { PROBE_FLUIDS, PROBE_HAZARDS } from './state.ts'

/**
 * The typed reasons a locomotion leg stops on, reusing the vocabulary the portal
 * walk-in lane established (`netherPortalPlan.ts PortalWalkInRefusal`):
 *   * `hazard_between` - a hazard cell lies ON the step: the landing cell or the
 *                        body's head cell is a hazard block, or the fall from the
 *                        landing cell crosses/ends in one (the measured shape).
 *   * `unsafe_landing` - no real support at any depth the movement policy itself
 *                        would accept: the step lands over the void / a chasm.
 *   * `fall_lethal`    - the landing IS a measured drop and that drop would take
 *                        the body to (or below) `CRITICAL_DAMAGE_HEALTH`: the
 *                        step would kill it or leave it one hit from death. The
 *                        drop is a real distance the scan already walked; the
 *                        body facts are its health, its worn armour and what it
 *                        holds. Refused by {@link fallSurvivability}, never by
 *                        the geometry classifier itself.
 */
export type MoveLegStopReason = 'hazard_between' | 'unsafe_landing' | 'fall_lethal'

/** The mirrored marker a stopped leg emits (registered in `MIRRORED_MARKERS`). */
export const MOVE_LEG_STOPPED = 'MOVE_LEG_STOPPED'

/** `support=` when the bounded column under the landing held no support at all. */
export const STEP_SUPPORT_NONE = 'none'
/** `support=`/`block=` when the fact was never observed (unloaded). */
export const STEP_SUPPORT_UNKNOWN = 'unknown'

/**
 * The option classes a `fall_lethal` refusal leaves OPEN. The guard refuses ONE
 * step, never the mission: a body at a lethal edge may still retreat, bridge
 * around it or descend deliberately (the descent scaffold deliberately places its
 * own floor, which is a different move from walking off). Naming them on the line
 * is EVIDENCE that the refusal is narrow - the guard does not rank or choose any
 * of them (#436: WHICH is Jev's).
 */
export const FALL_ALTERNATIVES = ['retreat', 'bridge', 'descend'] as const
export const FALL_ALTERNATIVES_TOKEN = FALL_ALTERNATIVES.join(',')

/** The block slice the landing rules need (a Mineflayer `Block` or a fixture cell). */
export interface StepLandingBlock {
  name: string
  boundingBox: string
}

/**
 * The already-sensed facts one step's landing verdict is built from. The caller
 * reads exactly these cells; the classifier does no world access, so it is pure
 * and fixture-testable without a bot.
 */
export interface StepLandingReads {
  /** the block the body would occupy at the landing (the step's feet cell) */
  landing: StepLandingBlock | null
  /** the block at `landing.y + 1` (the body's head cell at the landing) */
  head: StepLandingBlock | null
  /**
   * The column strictly UNDER the landing feet cell, nearest first, bounded by
   * the caller to the movement policy's own `maxDropDown` (`executor
   * ensureMovements`), so every drop the `canDig=false` planner would itself
   * plan stays legal and ordinary terrain is untouched.
   */
  below: readonly (StepLandingBlock | null)[]
}

export interface StepLandingVerdict {
  /** null = the step is legal (ordinary terrain: no marker, no refusal) */
  reason: MoveLegStopReason | null
  /** the block that produced the refusal (`null` when nothing was refused) */
  block: string | null
  /**
   * The block that would stop the fall under the landing cell: a block name,
   * `none` (the bounded column was fully observed and held nothing), or
   * `unknown` (the scan ended on an unloaded cell, or never ran).
   */
  support: string
  /**
   * THE MEASURED DROP (blocks the body falls before something stops it), read
   * off the SAME column walk this verdict already performed: the index of the
   * first block in `below` that stops the fall. `0` = the floor is directly under
   * the landing feet cell (an ordinary step), `3` = a 3-block drop onto the block
   * at `below[3]`. `null` = no drop was measured (the landing cell itself is a
   * hazard, a face to step up, or was never observed).
   */
  drop: number | null
  /**
   * True when `drop` is a proven LOWER BOUND rather than the landing depth: the
   * scan ran into an unloaded cell with `drop` blocks of observed emptiness above
   * it, so the body falls AT LEAST that far (a lower bound is a proven fact even
   * though the exact landing is unobserved). The monotonicity of falling is what
   * makes this decidable without a second world model.
   */
  dropAtLeast: boolean
}

/** True when a block name is a hazard: the sensor's own hazard vocabulary. */
export function isStepHazardBlock(name: string | null | undefined): boolean {
  return typeof name === 'string' && PROBE_HAZARDS.has(name)
}

/** True when a block is a fluid the body can occupy (water; submersion owns it). */
function isStepFluidBlock(name: string | null | undefined): boolean {
  return typeof name === 'string' && PROBE_FLUIDS.has(name)
}

/** True when a block physically stops a falling body (any non-empty bounding box). */
function isCollidable(block: StepLandingBlock): boolean {
  return block.boundingBox !== 'empty'
}

/**
 * Classify one step's landing BEFORE it is taken.
 *
 * Every branch is a measured fact, and the two non-marker branches that matter
 * most are:
 *   * a COLLIDABLE landing cell is a face/step-up, not a step INTO it: the
 *     existing headroom + climb machinery owns that geometry (and a 1-block
 *     step-up lands ON TOP of it), so the guard must not read it as a fall;
 *   * a cell that is neither a hazard, nor collidable, nor a fluid, nor unknown
 *     is simply more emptiness - the scan continues downward.
 */
export function classifyStepLanding(reads: StepLandingReads): StepLandingVerdict {
  const landing = reads.landing
  // UNKNOWN is not false: an unloaded landing cell is not a hazard.
  if (landing === null) {
    return { reason: null, block: null, support: STEP_SUPPORT_UNKNOWN, drop: null, dropAtLeast: false }
  }
  if (isStepHazardBlock(landing.name)) {
    // Stepping INTO a hazard: fire at the landing cell, lava on a solid ledge,
    // magma_block, a cactus cell. The landing cell is itself the hazard.
    return { reason: 'hazard_between', block: landing.name, support: STEP_SUPPORT_UNKNOWN, drop: null, dropAtLeast: false }
  }
  if (reads.head !== null && isStepHazardBlock(reads.head.name)) {
    // The body's head would be inside the hazard (lava/fire at landing.y + 1).
    return { reason: 'hazard_between', block: reads.head.name, support: STEP_SUPPORT_UNKNOWN, drop: null, dropAtLeast: false }
  }
  if (isCollidable(landing)) {
    // A step-up / wall face: existing climb + headroom logic owns it. Nothing
    // falls - the body lands ON the step it climbs - so the drop is 0.
    return { reason: null, block: null, support: landing.name, drop: 0, dropAtLeast: false }
  }
  for (const [index, cell] of reads.below.entries()) {
    // UNKNOWN is not false: an unloaded cell under the landing ends the scan and
    // the step proceeds exactly as today. What the scan DID observe is still a
    // fact: `index` blocks of emptiness above the unloaded cell bound the fall
    // from below, so the survivability verdict can price a proven lower bound.
    if (cell === null) {
      return { reason: null, block: null, support: STEP_SUPPORT_UNKNOWN, drop: index, dropAtLeast: true }
    }
    if (isStepHazardBlock(cell.name)) {
      // The fall from the landing cell crosses or ends in a hazard. The measured
      // walkway shape is exactly this: the walkway edge over the fortress lava
      // lake, with nothing but lava under the next step.
      return { reason: 'hazard_between', block: cell.name, support: STEP_SUPPORT_NONE, drop: index, dropAtLeast: false }
    }
    // ANY collidable block stops the fall - leaf canopy included, because that
    // is locomotion truth (`state.ts isStandable` keeps a treetop walkable), not
    // the destination rule (`isUsableGroundSupport`).
    if (isCollidable(cell)) {
      return { reason: null, block: null, support: cell.name, drop: index, dropAtLeast: false }
    }
    // Water ends the fall as well: whether to enter water is the submersion
    // machinery's question (`state.ts bodySubmersion`), not this guard's.
    if (isStepFluidBlock(cell.name)) {
      return { reason: null, block: null, support: cell.name, drop: index, dropAtLeast: false }
    }
  }
  // The whole bounded window is passable emptiness: no real support at any depth
  // the planner itself would accept, so this step is a lethal drop. The fall is
  // at least as deep as the window that was observed empty.
  return {
    reason: 'unsafe_landing',
    block: landing.name,
    support: STEP_SUPPORT_NONE,
    drop: reads.below.length,
    dropAtLeast: true,
  }
}

// ---------------------------------------------------------------------------
// THE FALL-DAMAGE FACT: how far may THIS body fall, and would THIS landing kill it?
// ---------------------------------------------------------------------------

/**
 * A fall of this many blocks is free in vanilla (the immunity threshold). The
 * repo never encoded it before this module; `criticalDamage.ts:19` mentions it
 * only in prose, to argue that a fall did NOT explain a starvation slide.
 */
export const FALL_DAMAGE_FREE_BLOCKS = 3

/** Vanilla armour reduction: `min(20, points)/25` of the damage removed. */
export const FALL_ARMOR_DIVISOR = 25
/** ... with the armour points used for the reduction capped at 20. */
export const FALL_ARMOR_POINTS_CAP = 20

/**
 * The upper bound of the survivable-drop scan. A body with the deepest possible
 * health pool cannot survive a fall much past this (full health + full netherite
 * dies in the 40s), so the scan is bounded rather than open-ended.
 */
export const MAX_SURVIVABLE_DROP_SCAN = 96

/**
 * Vanilla armour defence points per material, in `ARMOR_SLOTS` order
 * (head, torso, legs, feet). Only the materials the game has; an UNKNOWN material
 * contributes 0 points (fail closed: the guard then assumes no reduction, i.e. it
 * refuses MORE often, never less - an unproven mitigation is not a mitigation).
 */
const ARMOR_DEFENSE_POINTS: Readonly<Record<string, readonly [number, number, number, number]>> = {
  leather: [1, 3, 2, 1],
  golden: [2, 5, 3, 1],
  chainmail: [2, 5, 4, 1],
  iron: [2, 6, 5, 2],
  diamond: [3, 8, 6, 3],
  netherite: [3, 8, 6, 3],
}
/** `turtle_helmet` is a helmet-only material, so it has its own row. */
const TURTLE_HELMET_DEFENSE_POINTS = 2

/**
 * Vanilla armour toughness, which softens the armour formula against a BIG hit
 * exactly like the measured one. 0 for every material that does not have any.
 */
const ARMOR_TOUGHNESS: Readonly<Record<string, number>> = {
  diamond: 2,
  netherite: 3,
}

/** The material prefix of an armour item name (`iron_chestplate` -> `iron`). */
function armorMaterial(name: string): string {
  const cut = name.indexOf('_')
  return cut <= 0 ? name : name.slice(0, cut)
}

/**
 * The worn armour's total defence points and toughness. Pure; reads only the
 * sensor's own {@link ArmorState} (`state.ts SelfState.armor`, built from the
 * mineflayer player-window slots 5-8), so the guard and the candidate layer can
 * never disagree about what the body is wearing.
 */
export function armorFallMitigation(armor: ArmorState | null | undefined): {
  points: number
  toughness: number
} {
  if (armor === null || armor === undefined) return { points: 0, toughness: 0 }
  const slots: readonly ('head' | 'torso' | 'legs' | 'feet')[] = ['head', 'torso', 'legs', 'feet']
  let points = 0
  let toughness = 0
  for (const [index, slot] of slots.entries()) {
    const piece = armor[slot]
    if (piece === null || piece === undefined || typeof piece.name !== 'string') continue
    const material = armorMaterial(piece.name)
    if (piece.name === 'turtle_helmet') {
      points += slot === 'head' ? TURTLE_HELMET_DEFENSE_POINTS : 0
      continue
    }
    const row = ARMOR_DEFENSE_POINTS[material]
    if (row === undefined) continue
    points += row[index] ?? 0
    toughness += ARMOR_TOUGHNESS[material] ?? 0
  }
  return { points: Math.min(points, FALL_ARMOR_POINTS_CAP), toughness }
}

/**
 * Blocks that break or soften a landing without being collidable floors. The
 * fluid class is the sensor's own (`PROBE_FLUIDS`, already the existing
 * "water ends the fall" branch); the rest are vanilla fall-damage reducers.
 * A block NOT in this table is treated as an ordinary hard landing (conservative:
 * an unknown block never licenses a deeper fall than the body's health allows).
 */
const FALL_DAMAGE_REDUCTION: Readonly<Record<string, number>> = {
  water: 1,
  flowing_water: 1,
  bubble_column: 1,
  cobweb: 1,
  slime_block: 1,
  powder_snow: 1,
  hay_block: 0.8,
  honey_block: 0.8,
}

/**
 * Vanilla fall damage in HP for a MEASURED drop: `0` up to
 * {@link FALL_DAMAGE_FREE_BLOCKS} blocks, then one HP per additional block. The
 * block that stops the fall can reduce or negate it ({@link FALL_DAMAGE_REDUCTION}).
 * Enchantments (Feather Falling / Protection) are NOT modelled because the repo's
 * `ArmorState`/`HeldItemState` carry no enchantment fact; ignoring them
 * over-estimates the damage, i.e. the guard refuses the more dangerous case.
 */
export function fallDamageHp(drop: number, landingBlock: string | null | undefined): number {
  if (!Number.isFinite(drop) || drop <= FALL_DAMAGE_FREE_BLOCKS) return 0
  const raw = drop - FALL_DAMAGE_FREE_BLOCKS
  const reduction =
    typeof landingBlock === 'string' ? (FALL_DAMAGE_REDUCTION[landingBlock] ?? 0) : 0
  if (reduction >= 1) return 0
  // Round UP every partial reduction: less assumed mitigation = fewer licensed falls.
  return Math.ceil(raw * (1 - reduction))
}

/**
 * The vanilla armour reduction of a fall, applied to the raw damage. Uses the
 * game's own formula, toughness included, because the measured death is exactly
 * the "big hit" case where toughness matters.
 */
export function armorReducedFallDamage(rawDamage: number, points: number, toughness = 0): number {
  if (rawDamage <= 0) return 0
  if (points <= 0) return rawDamage
  const effective = Math.min(
    FALL_ARMOR_POINTS_CAP,
    Math.max(points / 5, points - rawDamage / (2 + toughness)),
  )
  return rawDamage * (1 - effective / FALL_ARMOR_DIVISOR)
}

/**
 * The deepest drop this living body may take without damage, or with health
 * still ABOVE the critical-health floor afterwards. Harmless drops preserve an
 * already-critical body, matching fallSurvivability's zero-damage verdict.
 * The floor is the repository's single critical number
 * (`criticalDamage.ts CRITICAL_DAMAGE_HEALTH`: "at this health the body cannot
 * absorb another damage event"), so a damaging landing that leaves the body at or below it
 * is the fatal boundary - it either kills the body outright or leaves it one hit
 * from death. `null` when the health is unknown: the guard then refuses nothing
 * (UNKNOWN is not false).
 */
export function maxSurvivableDrop(
  health: number | null | undefined,
  armorPoints = 0,
  toughness = 0,
): number | null {
  if (typeof health !== 'number' || !Number.isFinite(health)) return null
  let best = 0
  for (let drop = 1; drop <= MAX_SURVIVABLE_DROP_SCAN; drop += 1) {
    const damage = armorReducedFallDamage(fallDamageHp(drop, null), armorPoints, toughness)
    if ((health > 0 && damage === 0) || health - damage > CRITICAL_DAMAGE_HEALTH) best = drop
    else break // damage is monotone in the drop, so no deeper drop can recover
  }
  return best
}

/**
 * The body facts the survivability verdict is built from. All optional: a caller
 * (or a fixture) that does not state them gets the UNKNOWN-is-not-false verdict,
 * never a fabricated refusal.
 */
export interface FallBodyFacts {
  /** live health in HP (20 = full), or null/undefined when never observed */
  health?: number | null
  /** the worn armour (`state.ts SelfState.armor`) */
  armor?: ArmorState | null
  /**
   * The item in the main hand, by name. Named here because it is a FACT about the
   * body's state that a reader of the refusal needs: a water bucket is what a
   * human uses to survive a fall. It does NOT license the step - a plain walk
   * commits to the landing and does not place anything - so the verdict stays
   * `fatal` and the refused alternatives stay offered (the deliberate water
   * descent is a different move the policy may choose).
   */
  heldItem?: string | null
}

/** Held items that can break a fall OUTSIDE this leg (a deliberate MLG descent). */
export const FALL_MITIGATION_ITEMS: ReadonlySet<string> = new Set(['water_bucket', 'powder_snow_bucket'])

/** The two proven shapes of a fatal landing. */
export type FallFatalFact = 'drop_exceeds_health' | 'drop_deeper_than_survivable'

export interface FallSurvivabilityVerdict {
  /** TRUE only when the measured/ bounded drop provably takes the body to <= the floor */
  fatal: boolean
  /** the drop priced by this verdict (`null` when the geometry measured none) */
  drop: number | null
  /** true when `drop` is a proven lower bound (the column hit an unloaded cell) */
  dropAtLeast: boolean
  /** HP the landing would deal after armour (`null` when no drop was measured) */
  damage: number | null
  /** the deepest drop that still leaves the body above the floor, or null when health is unknown */
  safeDrop: number | null
  /** the live health the verdict used, or null */
  health: number | null
  /** the floor this verdict is measured against (`criticalDamage.ts`) */
  criticalHealth: number
  /** worn-armour defence points the damage was reduced by */
  armorPoints: number
  /** a held item that could break the fall in a DIFFERENT (deliberate) move, or null */
  mitigation: string | null
  /** which fact made it fatal; null when it is not fatal */
  fatalFact: FallFatalFact | null
}

const NOT_FATAL: Omit<FallSurvivabilityVerdict, 'drop' | 'dropAtLeast' | 'damage' | 'safeDrop' | 'health' | 'armorPoints' | 'mitigation'> = {
  fatal: false,
  criticalHealth: CRITICAL_DAMAGE_HEALTH,
  fatalFact: null,
}

/**
 * THE SURVIVABILITY VERDICT for one step's landing, from the ALREADY MEASURED
 * geometry ({@link classifyStepLanding}) and the body's own state. Pure, no world
 * access, so the walk, the packet step, the bridge advance, the retreat and every
 * fixture read the same answer.
 *
 * Refuses exactly two proven shapes and nothing else:
 *   * `drop_exceeds_health` - the measured drop's damage would leave the body at
 *     or below `CRITICAL_DAMAGE_HEALTH`;
 *   * `drop_deeper_than_survivable` - the bottom is BELOW the read window or the
 *     column ran into an unloaded cell with more observed emptiness above it than
 *     the body survives, so the fall is provably too deep even though its exact
 *     bottom was never seen (falling is monotone).
 *
 * Everything else - a flat step, a 1-block dip, a survivable drop, a hazard or a
 * void (which the geometry verdict already refuses), an unloaded column that
 * could still hold a landing inside the survivable bound, and a body whose health
 * was never observed - returns `fatal: false` and changes nothing.
 */
export function fallSurvivability(
  verdict: StepLandingVerdict,
  body: FallBodyFacts = {},
): FallSurvivabilityVerdict {
  const health = typeof body.health === 'number' && Number.isFinite(body.health) ? body.health : null
  const { points, toughness } = armorFallMitigation(body.armor)
  const held = typeof body.heldItem === 'string' ? body.heldItem : null
  const mitigation = held !== null && FALL_MITIGATION_ITEMS.has(held) ? held : null
  const base = {
    drop: verdict.drop,
    dropAtLeast: verdict.dropAtLeast,
    health,
    armorPoints: points,
    mitigation,
  }
  if (verdict.drop === null || health === null) {
    // Nothing measured, or the body's own state is unknown: no refusal.
    return { ...NOT_FATAL, ...base, damage: null, safeDrop: null }
  }
  const safeDrop = maxSurvivableDrop(health, points, toughness)
  if (safeDrop === null) return { ...NOT_FATAL, ...base, damage: null, safeDrop: null }
  if (verdict.dropAtLeast) {
    // The bottom was never seen, but the observed emptiness above it already
    // proves a fall deeper than this body survives. The landing SURFACE is
    // unknown too, so the guard assumes an ordinary hard landing (no reduction):
    // what it prices is the damage the ALREADY-PROVEN depth alone deals. A
    // proven 3-block drop still prices 0 and is never a refusal.
    const damage = fallDamageHp(verdict.drop, null)
    const fatal = damage > 0 && health - damage <= CRITICAL_DAMAGE_HEALTH
    return {
      ...NOT_FATAL,
      ...base,
      fatal,
      damage,
      safeDrop,
      fatalFact: fatal ? 'drop_deeper_than_survivable' : null,
    }
  }
  const damage = armorReducedFallDamage(fallDamageHp(verdict.drop, verdict.support), points, toughness)
  // A landing that deals NO damage (a flat step, a 1-block dip, a fall of three
  // blocks or fewer, water) is never a refusal, whatever the health: the body
  // arrives exactly as hurt as it left, so the guard has nothing to say about it.
  const fatal = damage > 0 && health - damage <= CRITICAL_DAMAGE_HEALTH
  return { ...NOT_FATAL, ...base, fatal, damage, safeDrop, fatalFact: fatal ? 'drop_exceeds_health' : null }
}

export interface MoveLegStoppedInput {
  reason: MoveLegStopReason
  /** the body's own feet cell when the leg stopped */
  from: Vec3Json
  /** the landing cell the step refused */
  to: Vec3Json
  /** the block that produced the refusal (`unknown` when never observed) */
  block: string | null
  /** the verdict's `support` field */
  support: string
  /**
   * The fall facts, present exactly on a `fall_lethal` refusal so the line names
   * the edge, the predicted drop, the body's health and what made it fatal.
   */
  fall?: FallSurvivabilityVerdict | null
}

function formatCell(cell: Vec3Json): string {
  return `${cell.x},${cell.y},${cell.z}`
}

/** One decimal is enough for a damage/HP number and keeps the line stable. */
function formatHp(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/**
 * The `fall_lethal` tail: the edge's drop, the body's health, the damage it would
 * take, the deepest drop it could have survived, and the fact that made it fatal.
 * A proven LOWER BOUND is printed as `>=n` so a reader can never mistake a bounded
 * observation for an exact one.
 */
export function formatFallFacts(fall: FallSurvivabilityVerdict): string {
  const bound = fall.dropAtLeast ? '>=' : '='
  const drop = fall.drop === null ? STEP_SUPPORT_UNKNOWN : `${bound}${fall.drop}`
  const damage = fall.damage === null ? STEP_SUPPORT_UNKNOWN : `${bound}${formatHp(fall.damage)}`
  return (
    ` drop${drop} health=${fall.health === null ? STEP_SUPPORT_UNKNOWN : formatHp(fall.health)}` +
    ` damage${damage} safe=${fall.safeDrop === null ? STEP_SUPPORT_UNKNOWN : fall.safeDrop}` +
    ` armor=${fall.armorPoints} fact=${fall.fatalFact ?? 'none'}` +
    (fall.mitigation === null ? '' : ` mitigation=${fall.mitigation}`) +
    ` alternatives=${FALL_ALTERNATIVES_TOKEN}`
  )
}

/**
 * The exact `MOVE_LEG_STOPPED` line: a leg stopped before a step, typed. The
 * line names BOTH cells so a reader can tell "the body refused one step" from
 * "the leg never ran", and `block=`/`support=` say which world fact refused it.
 * A `fall_lethal` refusal appends the fall facts (drop, health, damage, safe
 * bound, armour, the fatal fact, any held mitigation, and the options it leaves
 * open); every other reason's line is byte-identical to before this fact existed.
 */
export function formatMoveLegStopped(input: MoveLegStoppedInput): string {
  return (
    `${MOVE_LEG_STOPPED} reason=${input.reason}` +
    ` from=${formatCell(input.from)} to=${formatCell(input.to)}` +
    ` block=${input.block ?? STEP_SUPPORT_UNKNOWN} support=${input.support}` +
    (input.fall === null || input.fall === undefined ? '' : formatFallFacts(input.fall))
  )
}
