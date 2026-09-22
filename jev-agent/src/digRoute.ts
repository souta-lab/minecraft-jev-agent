// digRoute.ts - the general "no walkable route, so change the TERRAIN" affordance.
//
// MEASURED (run-muc9k936-1f3vb, main ebec6f2, m3-live): the body had climbed its
// own 1-wide shaft to y=66 and was sealed inside it. The gate was KNOWN and
// `portal_verified=true` at (25,66,9), 21 blocks away, and every route arm failed
// the same way:
//
//   goal: active g1:place:nether_portal | enter_portal (rung enter_nether)
//   body: pos=11.7,66.0,24.8  (distance to the gate NOT decreasing for 12 heartbeats)
//   offer cycle: ['ENTER:26,67,9','WAIT'] -> PATH_CALLBACK phase=failed outcome=noPath
//                -> ROUTE_STAGE_FAILED kind=ENTER_PORTAL -> ROUTE_SPENT
//                -> ['WAIT','ESCALATE'] -> System2 "no path to portal..."
//                -> the route memory's 120 s TTL expires -> ENTER is offered again
//   escalation after the first: PLAN_THROTTLED reason=action_impossible because=no_new_info
//
// WHY NO CANDIDATE EXISTS (the mechanical fact, not a policy choice):
//
//   `state.ts#buildTerrain` (5x5x3, `isUsableStand`) is the ONLY source of the
//   standable cells every walk arm reads. Inside a 1-wide shaft every neighbour
//   column at feet level is solid, so the sensed standable set is the body's own
//   cell. `candidates.ts#travelApproachLeg` skips `cellKey(spot) === standKey`
//   ("a leg to the cell the body already occupies is not a route change"), so
//   `best === null` and the arm returns nothing; `entryCandidates` then reports
//   `ROUTE_ESCALATE reason=all_routes_spent` and every bounded recovery family is
//   starved. The portal's `planVerticalApproach` cannot help either: the entry is
//   ONE block above the feet, so `dy = 1` selects a `pillar` leg, and the sealed
//   shaft has no placeable surface (live `PILLAR_FAIL ... step=place
//   reason=refused ... the block is still air`).
//
// What the sensor DOES know is everything this module needs:
//
//   - the target cell and therefore the bearing (`dx`,`dz`) and the vertical gap;
//   - `state.descent` (`state.ts#buildDescent`): one pre-computed option per
//     cardinal direction x {down, level} plus the body's own column. Each option
//     carries the concrete geometry (`wall`/`head`/`floor`/`step`), the primary
//     block and its harvest requirement, and the SAFE verdict with its TYPED
//     refusal (`unbreakable` / `no_support` / `open_floor` / `hazard` /
//     `protected`) - i.e. exactly "what is diggable and what is safe to stand in
//     afterwards";
//   - `strandedOnColumn` (`candidates.ts`): the body's own cell is the only
//     sensed standable cell, i.e. the shaft is SEALED.
//
// So the missing affordance is not a new mechanic: it is AIMING the existing,
// already-safe bounded dig step at the goal's target instead of at a resource
// direction. A level option IS "tunnel one block forward" and a down option is
// "staircase one block down/forward" - the executor's `runDescend` already digs
// the 1x2 profile and steps into it, the guard already re-validates it against
// `state.descent`, and the zero-progress route ledger already spends it.
//
// AUTHORITY: code owns CAN/TRUE/SAFE here - which cells exist, which of them are
// breakable with the held tools, which direction STRICTLY reduces the distance to
// the target, and which of those the sensor proved safe. Jev still owns WHICH of
// the grounded candidates to take (this module only grounds one more), and
// System2 still owns WHAT the goal is. There is no portal/M3 branch and no
// hard-coded coordinate or bearing: the only target is the goal's own target
// cell, and the only direction is the sign of `target - feet`.
//
// BOUNDED BY CONSTRUCTION (never an infinite loop): every step must STRICTLY
// reduce the distance to the target, so the body either reaches the target's own
// column (nothing left to reduce -> typed `no_step` refusal) or the world refuses
// the step. The step identity is also the ordinary zero-progress route identity
// (`kind=DESCEND`, primary dig cell, stand cell, route signature), so a step that
// already proved zero observable change from this stand cell is withheld, and a
// body that cannot dig at all (bedrock, no tool, lava) gets a typed refusal and
// the existing escalation instead of a substituted loop.
//
// Pure: no bot, no clock, no model. Same facts in -> same route (or refusal) out.

import type { DescentOption, HarvestTool, Vec3Json } from './state.ts'
import { descentDigPlan, descentPrimaryCell, distance } from './state.ts'

/**
 * The mechanical shape of one grounded dig step toward a target.
 *
 *   `shaft_exit` the LATERAL dig that opens a sealed shaft wall (`sealed` body);
 *   `tunnel`     a lateral corridor step toward the bearing (level step);
 *   `staircase`  a step that also lowers the body (down step toward the bearing).
 *
 * A `bridge` (a level route whose landing cell has no floor) is deliberately NOT
 * a kind here: creating the floor needs a PLACE, not a dig, and the sensor
 * already names that world fact with its typed `no_support` refusal. Reporting
 * `no_support` is the honest output; inventing a dig that cannot create a floor
 * would not be.
 */
export type DigRouteKind = 'shaft_exit' | 'tunnel' | 'staircase'

/** Typed cause of a dig route that could not be grounded. */
export type DigRouteRefusalReason =
  /** lava/water in the step column (the sensor's own verdict) */
  | 'hazard'
  /** the binding cell can never be broken: bedrock/barrier */
  | 'unbreakable'
  /** the landing cell has no solid support (a dig cannot create a floor) */
  | 'no_support'
  /** the floor is already open: the step would be an uncontrolled fall */
  | 'open_floor'
  /** the step would break a protected station block */
  | 'protected'
  /** the block is breakable but the held tools cannot finish the dig */
  | 'no_tool'
  /** no safe step reduces the distance to the target any further */
  | 'no_step'
  /** the body is already at the target (the ordinary walk/vertical plan owns it) */
  | 'arrived'
  /** every step that would reduce the distance is already spent at this stand cell */
  | 'spent'

/**
 * How much closer to the target a step must land before it counts as advancing.
 * A cardinal step toward a shallow bearing gains less than a full block, so the
 * rule is "strictly closer by a real margin", never "moved one block".
 */
export const DIG_ROUTE_MIN_ADVANCE = 0.25

/**
 * Stop grounding a dig route once the body is this close to the target: the
 * ordinary walk / vertical approach owns the last block, and a dig there would
 * be tunnelling into the destination.
 */
export const DIG_ROUTE_ARRIVE_DISTANCE = 1.5

/**
 * Horizontal tolerance for treating the target as being in the body's own
 * column, where the only distance-reducing step is straight down.
 */
export const DIG_ROUTE_SAME_COLUMN_TOLERANCE = 1.5

export interface DigRouteStep {
  kind: DigRouteKind
  /** the cardinal direction of the dig (`E|W|N|S|D`), straight from the sensor */
  dir: DescentOption['dir']
  mode: 'down' | 'level'
  /** the feet cell the body stands in after the step */
  cell: Vec3Json
  /** the primary block this step digs (the candidate's own target cell) */
  dig: Vec3Json
  block: string | null
  harvestTool: HarvestTool | null
  harvestTier: number | null
  /** every cell of the 1x2 profile, passage first (the executor digs exactly these) */
  digCells: Vec3Json[]
  /** feet-cell distance to the target before the step */
  fromDistance: number
  /** feet-cell distance to the target after the step (strictly smaller) */
  toDistance: number
  /**
   * The sensor option this route was grounded from, so the caller builds the
   * candidate through the SAME `descendCandidateFromStep` the collect descent
   * uses - one mechanic, one guard check, one route identity.
   */
  step: DescentOption
}

export interface DigRouteRefusal {
  reason: DigRouteRefusalReason
  /** the target the route was aimed at */
  target: Vec3Json
  /** the ideal bearing from the body to the target (`E`/`W`/`N`/`S`/`D`) */
  bearing: string
  /** the refused cell, when the geology names one */
  cell: Vec3Json | null
  /** the refused block, when the geology names one */
  block: string | null
  /** the sensor's own human-readable cause (never a synthesized one) */
  detail: string
}

export type DigRouteDecision =
  | { kind: 'route'; route: DigRouteStep }
  | { kind: 'refuse'; refusal: DigRouteRefusal }

export interface DigRouteInput {
  /** live body position (fractional is fine; the feet cell is floored) */
  selfPosition: Vec3Json
  /** the goal's own target cell (portal interior, remembered resource, ...) */
  target: Vec3Json
  /** the sensor's pre-computed steps (`WorldState.descent`) */
  descent: readonly DescentOption[] | null | undefined
  /**
   * True when the body's own cell is the only sensed standable cell
   * (`candidates.ts#strandedOnColumn`): a lateral dig is then a shaft exit.
   */
  sealed?: boolean
  /**
   * True when this step's route already proved zero observable change from this
   * stand cell (the ordinary zero-progress route identity). A spent step is never
   * re-grounded here; the body must move before it is offered again.
   */
  isSpent?: (step: DescentOption) => boolean
  minAdvance?: number
  arriveDistance?: number
}

/** The ideal bearing from the body to the target, as a typed fact for the log. */
export function digRouteBearing(from: Vec3Json, target: Vec3Json): string {
  const dx = target.x - from.x
  const dz = target.z - from.z
  if (dx === 0 && dz === 0) return 'D'
  const ns = dz < 0 ? 'N' : dz > 0 ? 'S' : ''
  const ew = dx > 0 ? 'E' : dx < 0 ? 'W' : ''
  return `${ns}${ew}`
}

function refusedStepReason(step: DescentOption): DigRouteRefusalReason {
  return step.refusal ?? 'no_step'
}

function stepKind(step: DescentOption, sealed: boolean): DigRouteKind {
  if (step.mode === 'down') return 'staircase'
  return sealed ? 'shaft_exit' : 'tunnel'
}

/**
 * Ground ONE bounded dig step that strictly reduces the distance to `target`.
 *
 * Deterministic order: every candidate is the sensor's own safe step; the winner
 * is the one that lands CLOSEST to the target (with a small tie-break on the
 * step's own travel and a mild preference for a level tunnel over dropping a
 * block when both close the same distance). Nothing here is a policy ranking of
 * semantic actions - these are all the same mechanical action pointed in
 * different directions, and the closest landing cell is simply the one that
 * advances the route.
 */
export function planDigRoute(input: DigRouteInput): DigRouteDecision {
  const feet: Vec3Json = {
    x: Math.floor(input.selfPosition.x),
    y: Math.floor(input.selfPosition.y),
    z: Math.floor(input.selfPosition.z),
  }
  const target = input.target
  const bearing = digRouteBearing(feet, target)
  const minAdvance = input.minAdvance ?? DIG_ROUTE_MIN_ADVANCE
  const arriveDistance = input.arriveDistance ?? DIG_ROUTE_ARRIVE_DISTANCE
  const sealed = input.sealed === true
  const fromDistance = distance(feet, target)
  const refuse = (
    reason: DigRouteRefusalReason,
    cell: Vec3Json | null,
    block: string | null,
    detail: string,
  ): DigRouteDecision => ({
    kind: 'refuse',
    refusal: { reason, target, bearing, cell, block, detail },
  })

  if (fromDistance <= arriveDistance) {
    return refuse('arrived', feet, null, `body is ${round2(fromDistance)}m from the target (arrival distance ${arriveDistance})`)
  }

  const sx = Math.sign(target.x - feet.x)
  const sz = Math.sign(target.z - feet.z)
  const horizontal = Math.hypot(target.x - feet.x, target.z - feet.z)

  // The best REFUSED step that was geometrically a route: it is what the typed
  // refusal must name, so the cause is the cell that would have advanced the
  // body rather than an arbitrary cardinal direction.
  let bestRefused: DescentOption | null = null
  let bestRefusedDistance = Number.POSITIVE_INFINITY
  let spentStep: DescentOption | null = null
  let bearingStepSeen = false

  let best: DescentOption | null = null
  let bestScore = Number.POSITIVE_INFINITY

  for (const step of input.descent ?? []) {
    const ownColumn = step.dx === 0 && step.dz === 0
    if (ownColumn) {
      // Straight down only advances a target in the body's own column below it.
      if (horizontal > DIG_ROUTE_SAME_COLUMN_TOLERANCE) continue
      if (target.y >= step.step.y) continue
    } else {
      // The direction must actually close the bearing. A step with no component
      // toward the target cannot reduce the distance and is not a route.
      if (step.dx * sx + step.dz * sz <= 0) continue
    }
    bearingStepSeen = true
    const toDistance = distance(step.step, target)
    if (!(toDistance <= fromDistance - minAdvance)) continue
    if (!step.safe) {
      if (toDistance < bestRefusedDistance) {
        bestRefusedDistance = toDistance
        bestRefused = step
      }
      continue
    }
    if (input.isSpent?.(step) === true) {
      if (spentStep === null || toDistance < distance(spentStep.step, target)) spentStep = step
      continue
    }
    const score = toDistance + distance(step.step, feet) * 0.05 + (step.mode === 'level' ? 0 : 0.2)
    if (score < bestScore) {
      bestScore = score
      best = step
    }
  }

  if (best !== null) {
    const primary = descentPrimaryCell(best)
    return {
      kind: 'route',
      route: {
        kind: stepKind(best, sealed),
        dir: best.dir,
        mode: best.mode,
        cell: best.step,
        dig: primary,
        block: best.digName ?? null,
        harvestTool: best.digHarvestTool ?? null,
        harvestTier: best.digHarvestTier ?? null,
        digCells: descentDigPlan(best).map((entry) => entry.cell),
        fromDistance,
        toDistance: distance(best.step, target),
        step: best,
      },
    }
  }

  if (spentStep !== null) {
    return refuse(
      'spent',
      spentStep.step,
      spentStep.digName ?? null,
      'every step toward the target from this stand cell already proved zero observable change',
    )
  }
  if (bestRefused !== null) {
    const primary = descentPrimaryCell(bestRefused)
    return refuse(
      refusedStepReason(bestRefused),
      primary,
      bestRefused.digName ?? null,
      bestRefused.reason,
    )
  }
  if (!bearingStepSeen) {
    return refuse(
      'no_step',
      null,
      null,
      `no sensed step reduces the ${round2(fromDistance)}m distance (bearing ${bearing})`,
    )
  }
  return refuse(
    'no_step',
    null,
    null,
    `every sensed step toward the target stays at or above ${round2(fromDistance)}m from it`,
  )
}

/**
 * `DIG_ROUTE reason=<reason> target=x,y,z bearing=<dir> cell=x,y,z block=<name>
 *  kind=<kind> mode=<mode> from_d=<n> to_d=<n>`
 *
 * The route the offer grounded: the exact cell the body will stand in, the block
 * being removed, and the distance to the target before/after - so "the distance
 * strictly decreases as it advances" is observable per action.
 */
export function formatDigRoute(route: DigRouteStep, reason: string, target: Vec3Json): string {
  return (
    `DIG_ROUTE reason=${reason} target=${cell(target)} bearing=${route.dir} ` +
    `cell=${cell(route.cell)} block=${route.block ?? 'unknown'} kind=${route.kind} mode=${route.mode} ` +
    `from_d=${round2(route.fromDistance)} to_d=${round2(route.toDistance)}`
  )
}

/**
 * `DIG_ROUTE_REFUSED reason=<reason> target=x,y,z bearing=<dir> cell=x,y,z
 *  block=<name> detail=<sensor cause>`
 */
export function formatDigRouteRefused(refusal: DigRouteRefusal): string {
  return (
    `DIG_ROUTE_REFUSED reason=${refusal.reason} target=${cell(refusal.target)} bearing=${refusal.bearing} ` +
    `cell=${refusal.cell === null ? 'none' : cell(refusal.cell)} block=${refusal.block ?? 'unknown'} ` +
    `detail=${refusal.detail}`
  )
}

/**
 * `DIG_ROUTE_PROGRESS from_d=<n> to_d=<n> target=x,y,z cell=x,y,z`
 *
 * Emitted when a settled dig route measurably advanced the body: `from_d` is the
 * distance recorded when the route was offered and `to_d` the distance after the
 * action. A route that did NOT reduce the distance never emits it.
 */
export function formatDigRouteProgress(
  fromDistance: number,
  toDistance: number,
  target: Vec3Json,
  cell_: Vec3Json,
): string {
  return (
    `DIG_ROUTE_PROGRESS from_d=${round2(fromDistance)} to_d=${round2(toDistance)} ` +
    `target=${cell(target)} cell=${cell(cell_)}`
  )
}

function cell(position: Vec3Json): string {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
