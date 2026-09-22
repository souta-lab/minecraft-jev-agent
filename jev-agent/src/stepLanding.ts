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
import type { Vec3Json } from './state.ts'
import { PROBE_FLUIDS, PROBE_HAZARDS } from './state.ts'

/**
 * The typed reasons a locomotion leg stops on, reusing the vocabulary the portal
 * walk-in lane established (`netherPortalPlan.ts PortalWalkInRefusal`):
 *   * `hazard_between` - a hazard cell lies ON the step: the landing cell or the
 *                        body's head cell is a hazard block, or the fall from the
 *                        landing cell crosses/ends in one (the measured shape).
 *   * `unsafe_landing` - no real support at any depth the movement policy itself
 *                        would accept: the step lands over the void / a chasm.
 */
export type MoveLegStopReason = 'hazard_between' | 'unsafe_landing'

/** The mirrored marker a stopped leg emits (registered in `MIRRORED_MARKERS`). */
export const MOVE_LEG_STOPPED = 'MOVE_LEG_STOPPED'

/** `support=` when the bounded column under the landing held no support at all. */
export const STEP_SUPPORT_NONE = 'none'
/** `support=`/`block=` when the fact was never observed (unloaded). */
export const STEP_SUPPORT_UNKNOWN = 'unknown'

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
  if (landing === null) return { reason: null, block: null, support: STEP_SUPPORT_UNKNOWN }
  if (isStepHazardBlock(landing.name)) {
    // Stepping INTO a hazard: fire at the landing cell, lava on a solid ledge,
    // magma_block, a cactus cell. The landing cell is itself the hazard.
    return { reason: 'hazard_between', block: landing.name, support: STEP_SUPPORT_UNKNOWN }
  }
  if (reads.head !== null && isStepHazardBlock(reads.head.name)) {
    // The body's head would be inside the hazard (lava/fire at landing.y + 1).
    return { reason: 'hazard_between', block: reads.head.name, support: STEP_SUPPORT_UNKNOWN }
  }
  if (isCollidable(landing)) {
    // A step-up / wall face: existing climb + headroom logic owns it.
    return { reason: null, block: null, support: landing.name }
  }
  for (const cell of reads.below) {
    // UNKNOWN is not false: an unloaded cell under the landing ends the scan and
    // the step proceeds exactly as today.
    if (cell === null) return { reason: null, block: null, support: STEP_SUPPORT_UNKNOWN }
    if (isStepHazardBlock(cell.name)) {
      // The fall from the landing cell crosses or ends in a hazard. The measured
      // walkway shape is exactly this: the walkway edge over the fortress lava
      // lake, with nothing but lava under the next step.
      return { reason: 'hazard_between', block: cell.name, support: STEP_SUPPORT_NONE }
    }
    // ANY collidable block stops the fall - leaf canopy included, because that
    // is locomotion truth (`state.ts isStandable` keeps a treetop walkable), not
    // the destination rule (`isUsableGroundSupport`).
    if (isCollidable(cell)) return { reason: null, block: null, support: cell.name }
    // Water ends the fall as well: whether to enter water is the submersion
    // machinery's question (`state.ts bodySubmersion`), not this guard's.
    if (isStepFluidBlock(cell.name)) return { reason: null, block: null, support: cell.name }
  }
  // The whole bounded window is passable emptiness: no real support at any depth
  // the planner itself would accept, so this step is a lethal drop.
  return { reason: 'unsafe_landing', block: landing.name, support: STEP_SUPPORT_NONE }
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
}

function formatCell(cell: Vec3Json): string {
  return `${cell.x},${cell.y},${cell.z}`
}

/**
 * The exact `MOVE_LEG_STOPPED` line: a leg stopped before a step, typed. The
 * line names BOTH cells so a reader can tell "the body refused one step" from
 * "the leg never ran", and `block=`/`support=` say which world fact refused it.
 */
export function formatMoveLegStopped(input: MoveLegStoppedInput): string {
  return (
    `${MOVE_LEG_STOPPED} reason=${input.reason}` +
    ` from=${formatCell(input.from)} to=${formatCell(input.to)}` +
    ` block=${input.block ?? STEP_SUPPORT_UNKNOWN} support=${input.support}`
  )
}
