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
// breakable with the held tools, which step STRICTLY reduces the distance to the
// target, and which of those the sensor proved safe. Jev still owns WHICH of the
// grounded candidates to take (this module only grounds one more), and System2
// still owns WHAT the goal is. There is no portal/M3 branch and no hard-coded
// coordinate or bearing: the only target is the goal's own target cell, and the
// only direction is the sign of `target - feet`.
//
// A PATH MAY STEP ASIDE FIRST: when the best-closing step is refused, the
// next-best step that still STRICTLY reduces the distance is the route (the
// `detour`/`skipped` fields). Two-step convergence through a lateral cell is
// ordinary navigation, and it is bounded by the same rule because the distance
// taken away at each step is real. MEASURED LIVE (gen-mucb6gbb-wfobkj): the body
// at (24,67,9) in the M3 pocket with the gate's obsidian column at (25,67,9) had
// its best-closing east step refused (`no_tool`, obsidian needs pickaxe tier 4)
// and the arm refused as a whole while the walkable open face of the gate sat one
// cell aside.
//
// BOUNDED BY CONSTRUCTION (never an infinite loop): every step must STRICTLY
// reduce the distance to the target, so the body either reaches the target's own
// column (nothing left to reduce -> typed `no_step` refusal) or the world refuses
// the step. The step identity is also the ordinary zero-progress route identity
// (`kind=DESCEND`, primary dig cell, stand cell, route signature), so a step that
// already proved zero observable change from this stand cell is withheld, and a
// body that cannot dig at all (bedrock, no tool, lava) gets a typed refusal and
// the existing escalation instead of a substituted loop. A detour is a DIFFERENT
// step identity, so the budget still applies per step.
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
   * WALL ENTRY (`wallEntry.ts`): mining the adjacent solid block would pour a
   * neighbouring fluid into the pocket the dig opens. The mechanics rule is
   * face-adjacency of a fluid to a cell of the new pocket - a fluid two cells away
   * with the solid cell between them still solid cannot reach it, which is why this
   * is a per-cell verdict and not the sensor's 3x3x3 proximity one.
   */
  | 'would_flood'
  /**
   * WALL ENTRY: nothing to open in this direction - the 1x2 profile is already open
   * passage, so the ordinary walk machinery owns the step (a `walk` step, not a dig).
   */
  | 'no_wall'
  /**
   * WALL ENTRY: no adjacent wall can be opened at all - every neighbour is open
   * air/fluid, unobserved, unbreakable, floorless, spent, protected, undiggable or
   * not measurably closer to the target. `detail` carries the per-direction ledger.
   */
  | 'no_grounded_route'

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
  /**
   * True when the reducing step that closes the bearing BEST could not be taken
   * (its geology is refused, the held tools cannot finish its profile, or it
   * already proved zero change here) and the route offered is the next-best
   * step that still strictly reduces the distance. The detour is a DIFFERENT
   * route identity, so the ordinary spend budget still applies to each step.
   */
  detour: boolean
  /** Why the best-closing step was stepped around (null when it was taken). */
  skipped: DigRouteSkip | null
  /**
   * TRUE when this route is a WALL ENTRY: the same 1x2 level profile, but grounded
   * by the per-cell rule in `wallEntry.ts` because the sensor's proximity `hazard`
   * verdict refused that step even though the pocket the dig opens is provably dry.
   * The mechanical action, the dig plan, the step cell, the executor and the route
   * identity are identical to an ordinary level tunnel - only the evidence differs.
   */
  entry?: boolean
  /** the wall/head/floor/flood evidence of an entry route (absent otherwise) */
  entryEvidence?: string
}

export interface DigRouteSkip {
  dir: DescentOption['dir']
  mode: 'down' | 'level'
  reason: DigRouteRefusalReason
  block: string | null
  /** the exact cause, for the typed refusal line (never a synthesized one) */
  detail: string
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
  /**
   * Live dig feasibility of one sensor step: the caller's tool/legality gate.
   * Returns a typed refusal when the step's whole 1x2 dig profile cannot be
   * executed (no harvest tool for a cell), or null when it can. A probed-refused
   * step is treated exactly like a sensor-refused one: it is never the route and
   * its reason becomes the `skipped` cause of the detour that replaces it.
   */
  stepRefusal?: (step: DescentOption) => DigRouteSkip | null
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
 * Deterministic order: every candidate is a sensor step that STRICTLY reduces the
 * distance; the winner is the one that lands CLOSEST to the target (with a small
 * tie-break on the step's own travel and a mild preference for a level tunnel over
 * dropping a block when both close the same distance). Nothing here is a policy
 * ranking of semantic actions - these are all the same mechanical action pointed
 * in different directions, and the closest landing cell is simply the one that
 * advances the route.
 *
 * THE DETOUR RULE: when the best-closing step cannot be taken - the sensor refuses
 * its geology, the held tools cannot finish its profile (`stepRefusal`), or it
 * already proved zero observable change here - the next-best step that still
 * strictly reduces the distance IS the route, and `detour`/`skipped` record what
 * was stepped around. A route may step aside first; it may not step away (the
 * strict-reduction rule is what bounds it). When NO safe, feasible, unspent step
 * reduces the distance the typed refusal names the best-closing step's own cause.
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

  const horizontal = Math.hypot(target.x - feet.x, target.z - feet.z)

  // The reducing step that closes the bearing BEST is the primary route. When it
  // cannot be taken (the sensor refuses the geology, the held tools cannot finish
  // it, or it already proved zero change here) the next-best SAFE, feasible,
  // unspent step that still STRICTLY reduces the distance is the DETOUR route.
  // `closest` records that best-closing step with the reason it was skipped, so
  // the typed refusal (when nothing is left) names the real blocker and the
  // marker (when a detour is taken) names what was stepped around.
  //
  // MEASURED LIVE (run-mucaq28q-1ftq1 / gen-mucb6gbb-wfobkj, the M3 pocket): the
  // body at (24,67,9) with the gate's own obsidian column at (25,67,9) between it
  // and the interior (26,67,9). The east step closes the bearing (2.0 -> 1.0) but
  // needs pickaxe tier 4 (`DIG_ROUTE_REFUSED reason=no_tool ... block=obsidian`),
  // and before this rule the arm refused as a whole even when the terrain offered
  // another reducing step.
  let closest: { step: DescentOption; toDistance: number; status: DigRouteSkip | null } | null = null

  let best: DescentOption | null = null
  let bestScore = Number.POSITIVE_INFINITY

  for (const step of input.descent ?? []) {
    const ownColumn = step.dx === 0 && step.dz === 0
    if (ownColumn) {
      // Straight down only advances a target in the body's own column below it.
      if (horizontal > DIG_ROUTE_SAME_COLUMN_TOLERANCE) continue
      if (target.y >= step.step.y) continue
    }
    const toDistance = distance(step.step, target)
    // The single geometric rule: the step must STRICTLY reduce the distance to the
    // goal's own target. That is what bounds the route (the distance is bounded
    // below by zero and every taken step removes at least DIG_ROUTE_MIN_ADVANCE),
    // and it is what makes a detour safe to take: a step that does not reduce the
    // distance is never a route, whatever it does for the bearing. The bearing dot
    // product is deliberately NOT a filter (the distance test subsumes it for
    // cardinal steps), so the rule stays bearing-agnostic and a detour is chosen
    // on the geometry alone.
    if (!(toDistance <= fromDistance - minAdvance)) continue
    const status: DigRouteSkip | null = !step.safe
      ? { dir: step.dir, mode: step.mode, reason: refusedStepReason(step), block: step.digName ?? null, detail: step.reason }
      : (input.stepRefusal?.(step) ??
        (input.isSpent?.(step) === true
          ? {
              dir: step.dir,
              mode: step.mode,
              reason: 'spent' as DigRouteRefusalReason,
              block: step.digName ?? null,
              detail: 'this step already proved zero observable change from this stand cell',
            }
          : null))
    if (closest === null || toDistance < closest.toDistance) closest = { step, toDistance, status }
    if (status !== null) continue
    const score = toDistance + distance(step.step, feet) * 0.05 + (step.mode === 'level' ? 0 : 0.2)
    if (score < bestScore) {
      bestScore = score
      best = step
    }
  }

  if (best !== null) {
    const primary = descentPrimaryCell(best)
    const detour = closest !== null && closest.step !== best
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
        detour,
        skipped: detour ? (closest?.status ?? null) : null,
        step: best,
      },
    }
  }

  if (closest !== null && closest.status !== null) {
    const primary = descentPrimaryCell(closest.step)
    return refuse(closest.status.reason, primary, closest.status.block, closest.status.detail)
  }
  if (closest === null) {
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
 *  kind=<kind> mode=<mode> from_d=<n> to_d=<n>[ detour=true skipped=<dir>:<reason>]`
 *
 * The route the offer grounded: the exact cell the body will stand in, the block
 * being removed, and the distance to the target before/after - so "the distance
 * strictly decreases as it advances" is observable per action. `detour`/`skipped`
 * are appended only when the best-closing step could not be taken and the route
 * offered is the next-best step that still strictly reduces the distance.
 */
export function formatDigRoute(route: DigRouteStep, reason: string, target: Vec3Json): string {
  const detour =
    route.detour && route.skipped !== null
      ? ` detour=true skipped=${route.skipped.dir}:${route.skipped.reason}`
      : ''
  // A WALL ENTRY says so on its own line, with the evidence the per-cell rule used:
  // the line is the one a reviewer greps to tell "the body mined the wall because the
  // pocket is provably dry" from "the body took an ordinary tunnel step".
  const entry =
    route.entry === true
      ? ` entry=true kind_detail=wall_entry evidence=${route.entryEvidence ?? 'none'}`
      : ''
  return (
    `DIG_ROUTE reason=${reason} target=${cell(target)} bearing=${route.dir} ` +
    `cell=${cell(route.cell)} block=${route.block ?? 'unknown'} kind=${route.kind} mode=${route.mode} ` +
    `from_d=${round2(route.fromDistance)} to_d=${round2(route.toDistance)}${detour}${entry}`
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
