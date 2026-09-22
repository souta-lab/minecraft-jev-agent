// pillarApex.ts - the verified apex placement of one PILLAR_UP step.
//
// Live M2 failure this module closes (main d8a7a72, after the takeoff
// correction landed): PILLAR_UP executed ~900x, PILLAR_UP_STEP stayed 0, one
// place DID consume an item (`cobblestonex63 -> cobblestonex62`), and every
// attempt ended in `PILLAR_UP made no progress`. The place was gated on
// `velocity.y <= 0.01`, which is also true while standing and while falling, so
// the block could be placed at the bottom of the arc or after the body had
// already passed the vertex; the landing test was an unverified absolute
// `y in [placeY+1 +/- 0.1]` window. Nothing named the failing sub-step.
//
// `pillarStepUp` verifies all four sub-steps - takeoff, apex, place, landing -
// and reports the failed one as `PILLAR_FAIL step=...`, so a consumed item can
// never again read as an unattributed no-progress action.
import { jumpWithGroundCorrection, TAKEOFF_RISE } from './pillarJump.ts'
import type { JumpBotLike, PillarJumpDeps, PillarJumpTrace, Vec3Like } from './pillarJump.ts'

/**
 * The apex window. A verified vertex needs all three: the body must have risen
 * clear of the cell the block will occupy, a velocity at or below
 * `PILLAR_APEX_VY_MAX` (positive -> non-positive crossing), and a velocity not
 * below `PILLAR_APEX_FALL_VY` (the vertex, not the fall). `velocity.y <= 0.01`
 * alone is also true while standing and while plummeting, which is how the old
 * wait placed at the bottom of the arc.
 *
 * `PILLAR_APEX_MIN_RISE` is the rise of an UNOBSTRUCTED jump (a 0.42 jump peaks
 * ~1.25 blocks); it is only a reference. It must not cap the demand: live
 * `run-mu84l153-qry3` proved a ceiling clamps the arc to ~0.46 while the feet
 * still clear the place cell, so a fixed 0.5 marked that real apex as
 * `falling_before_place`. The runtime demand is derived from the geometry by
 * `requiredApexRise(...)`. Capping that demand at 0.5 is also wrong in the
 * other direction (live `run-mu85r15x-qvje`): a launch from the true stance
 * (launchY 58, placeCell 58) needs a 1.0 rise to clear the cell top at 59, and a
 * 0.5 cap would accept a place at feet 58.5 - still inside [58,59] - which the
 * server refuses.
 */
export const PILLAR_APEX_MIN_RISE = 0.5
export const PILLAR_APEX_VY_MAX = 0.01
export const PILLAR_APEX_FALL_VY = -0.25

/**
 * The rise (from the launch position) the feet must reach so the placed block
 * does not intersect them: the feet have to clear the top face of the place
 * cell (`placeCell.y + 1`). `launchY` is the live feet position, so a body that
 * already floats high in its cell needs less rise. The demand is the exact
 * geometric clearance (floored at the takeoff jitter threshold) - it is never
 * capped below that clearance, because a smaller demand would accept a place
 * while the feet are still inside the cell the server must fill.
 */
export function requiredApexRise(launchY: number, placeCellY: number): number {
  return Math.max(TAKEOFF_RISE, placeCellY + 1 - launchY)
}

/**
 * The highest rise the takeoff observer already recorded AFTER the last server
 * position reset. prismarine-physics catches up to four ticks per frame, so the
 * whole ascending arc can complete between two takeoff polls; the trace sees
 * the apex even when the apex loop's first sample is already on the descent
 * (live: trace peak 0.464 while the first apex sample read 0.231). A
 * `forcedMove` teleport resets the flight, so the segment before it is void.
 */
export function takeoffObservedRise(trace: PillarJumpTrace): number {
  let peak = 0
  for (const sample of trace.samples) {
    if (sample.event === 'forcedMove') {
      peak = 0
      continue
    }
    if (sample.rise > peak) peak = sample.rise
  }
  return peak
}

/**
 * The takeoff trace is a COMPLETE arc only when it observed the post-vertex
 * descent (a physics tick with negative velocity) and a `forcedMove` did not
 * void the segment. `jumpWithGroundCorrection` returns the moment the body
 * leaves the ground, so a fast single-tick takeoff records only the ascent and
 * understates the peak - that peak is not a trustworthy ceiling. A complete arc
 * is what makes `takeoffObservedRise` evidence of the column's real ceiling.
 */
export function pillarArcComplete(trace: PillarJumpTrace): boolean {
  if (trace.truncated) return false
  // A forcedMove resets the peak (`takeoffObservedRise`), so ANY reset makes the
  // recorded peak untrustworthy - regardless of where in the trace it landed.
  if (trace.samples.some((sample) => sample.event === 'forcedMove')) return false
  let rose = false
  for (const sample of trace.samples) {
    if (sample.rise > 0) rose = true
    if (rose && sample.event === 'physicsTick' && sample.velocityY < 0) return true
  }
  return false
}

/**
 * The evidence an unsatisfiable-column retire is decided from: the clearance
 * the server refused against versus what the column's arc actually achieved.
 */
export interface PillarRefusalEvidence {
  /** feet cell the server authoritatively grounds the body in */
  feetCellY: number
  /** the cell the refused block must occupy */
  placeCellY: number
  /** highest rise this attempt's takeoff trace observed */
  achievableRise: number
  /** true when the trace captured the post-vertex descent (a complete arc) */
  arcComplete: boolean
  /** forced position resets during the attempt void the trace segment */
  forcedRepositions: number
}

/**
 * The exact clearance the feet must produce to place the block at `placeCellY`,
 * measured from the feet CELL (`placeCellY + 1 - feetCellY`). The server
 * validates the refusal against its grounded stance, not the fractional client
 * float, so clearing the cell from the body's own cell floor is the demand a
 * refused placement already failed. Never capped below the geometric clearance.
 */
export function requiredColumnClearance(feetCellY: number, placeCellY: number): number {
  return requiredApexRise(feetCellY, placeCellY)
}

/**
 * A `place refused` failure proves the column unsatisfiable only when the
 * required clearance exceeds the highest rise the arc actually achieved AND the
 * measurement is trustworthy (a complete arc with no forced reposition). A
 * column that produced the clearance is never retired: its refusal is a
 * timing/sync refusal, not a ceiling failure, and one unlucky attempt must not
 * condemn a satisfiable column.
 */
export function isPillarRefusalUnsatisfiable(
  fail: Pick<PillarFail, 'step' | 'reason'>,
  evidence: PillarRefusalEvidence,
): boolean {
  if (fail.step !== 'place' || fail.reason !== 'refused') return false
  if (!evidence.arcComplete || evidence.forcedRepositions > 0) return false
  return requiredColumnClearance(evidence.feetCellY, evidence.placeCellY) > evidence.achievableRise
}

/**
 * The retire marker: names the unsatisfiable cause and the measured demand so a
 * refused retry can no longer be silent while the column is relocated.
 */
export function formatPillarRetire(cell: Vec3Like, evidence: PillarRefusalEvidence): string {
  const required = requiredColumnClearance(evidence.feetCellY, evidence.placeCellY)
  return (
    `PILLAR_RETIRE cell=${cell.x},${cell.y},${cell.z} reason=unsatisfiable_clearance` +
    ` required=${round2(required)} achievable=${round2(evidence.achievableRise)} arc=complete`
  )
}

/** Landing tolerance around `placeCell.y + 1` (server sync offsets are <= 1/8). */
export const PILLAR_LANDING_Y_TOLERANCE = 0.2

/** Which PILLAR_UP sub-step failed. */
export type PillarFailStep = 'takeoff' | 'apex' | 'place' | 'landing'

export interface PillarFail {
  step: PillarFailStep
  reason: string
  y: number
  rise: number
  samples: number
  detail?: string
  /** takeoff observations for this exact pillar attempt, when available */
  jumpTrace?: PillarJumpTrace
}

/**
 * A takeoff can fail before any placement side effect. A bounded relocation
 * may therefore retry from a different grounded column; apex and landing
 * failures must remain terminal for the current column because they may already
 * have mutated world state.
 *
 * A `place refused` failure is also relocatable when the supplied evidence
 * proves the column's clearance demand exceeds the arc it can produce (see
 * `isPillarRefusalUnsatisfiable`). Without evidence the refusal stays terminal,
 * so a bare `{ step: 'place', reason: 'refused' }` never relocates.
 */
export function shouldRelocatePillarAfterFailure(
  fail: Pick<PillarFail, 'step' | 'reason'>,
  evidence?: PillarRefusalEvidence,
): boolean {
  if (fail.step === 'takeoff' && ['no_physics_tick', 'no_support', 'no_rise'].includes(fail.reason)) return true
  return evidence !== undefined && isPillarRefusalUnsatisfiable(fail, evidence)
}

/** One same-column retry for a server-refused placement that provably had no side effect. */
export const PILLAR_PLACE_REFUSAL_RETRY_LIMIT = 1

export type PillarFailureRecovery = 'retry_same_column' | 'relocate' | 'stop'

/**
 * Decide the bounded recovery after one pillar sub-step failure. A server-refused
 * place is retryable only when the target cell is still empty, the column was
 * not proven geometrically unsatisfiable, and the one retry budget remains.
 * `not_landed` is intentionally excluded: a placement may already exist.
 */
export function decidePillarFailureRecovery(
  fail: Pick<PillarFail, 'step' | 'reason'>,
  evidence: PillarRefusalEvidence,
  blockPlaced: boolean,
  sameColumnRetries: number,
): PillarFailureRecovery {
  if (shouldRelocatePillarAfterFailure(fail, evidence)) return 'relocate'
  if (
    fail.step === 'place' &&
    fail.reason === 'refused' &&
    !blockPlaced &&
    sameColumnRetries < PILLAR_PLACE_REFUSAL_RETRY_LIMIT
  ) {
    return 'retry_same_column'
  }
  return 'stop'
}

/** The exact live marker emitted when a PILLAR_UP sub-step fails. */
export function formatPillarFail(fail: PillarFail): string {
  return `PILLAR_FAIL step=${fail.step} reason=${fail.reason} y=${round2(fail.y)} rise=${round2(fail.rise)} samples=${fail.samples}`
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export interface PillarStepPlan {
  /** floored feet cell at launch */
  feetCell: Vec3Like
  /** the cell the new block must occupy (`resolvePillarStep(...).placeY`) */
  placeCell: Vec3Like
  /**
   * the support block cell; the only accepted placement is its top face, so
   * `placeCell - support` must be exactly (0,1,0)
   */
  support: Vec3Like
}

export interface PillarStepUpDeps extends PillarJumpDeps {
  /** bounded apex window after the verified takeoff */
  apexBudgetMs: number
  /** bounded settle after the place before declaring the block missing */
  placeSettleMs: number
  /** bounded landing window after the block is verified in the cell */
  landingBudgetMs: number
  /** send the placement against `face`; must reject when the server refused it */
  place: (face: Vec3Like) => Promise<void>
  /** true when a full solid block now occupies the place cell */
  blockPlaced: () => boolean
  /** ownership check between awaits */
  ensureOwned?: () => void
}

export type PillarStepOutcome =
  | { ok: true; fromY: number; toY: number; apexRise: number; samples: number; jumpTrace: PillarJumpTrace }
  | { ok: false; fail: PillarFail }

/**
 * One PILLAR_UP step, fully verified: take off, place the block inside a
 * verified apex window, confirm the block exists in the target cell, then land
 * on it.
 */
export async function pillarStepUp(
  bot: JumpBotLike,
  deps: PillarStepUpDeps,
  plan: PillarStepPlan,
): Promise<PillarStepOutcome> {
  const launchY = bot.entity.position.y
  const landingY = plan.placeCell.y + 1
  const face: Vec3Like = {
    x: plan.placeCell.x - plan.support.x,
    y: plan.placeCell.y - plan.support.y,
    z: plan.placeCell.z - plan.support.z,
  }
  const fail = (
    step: PillarFailStep,
    reason: string,
    samples: number,
    detail?: string,
    jumpTrace?: PillarJumpTrace,
  ): PillarStepOutcome => ({
    ok: false,
    fail: {
      step,
      reason,
      y: bot.entity.position.y,
      rise: bot.entity.position.y - launchY,
      samples,
      detail,
      jumpTrace,
    },
  })
  // The place must target the cell above the support block AND above the launch
  // feet cell: anything else places beside the body and can never be landed on.
  if (face.x !== 0 || face.y !== 1 || face.z !== 0 || plan.placeCell.y < plan.feetCell.y) {
    return fail('place', 'wrong_cell', 0)
  }

  const jump = await jumpWithGroundCorrection(bot, deps)
  if (!jump.airborne) {
    return fail(
      'takeoff',
      jump.failure ?? 'no_rise',
      jump.samples,
      `ticks=${jump.ticks} impulses=${jump.impulses} peakRise=${round2(jump.peakRise)}`,
      jump.trace,
    )
  }

  deps.ensureOwned?.()
  // The takeoff verifier can return after the apex when prismarine-physics
  // catches up several ticks in one frame, so the peak it already observed seeds
  // the reported apexRise rather than being discarded. It must NOT satisfy the
  // place gate: the peak is history, while the server validates the placement
  // against the feet position at the moment the packet arrives. Requiring the
  // CURRENT rise to clear `placeCell.y + 1` is what makes the gate and the
  // server agree. The demand is the exact geometric clearance to the cell top.
  const requiredRise = requiredApexRise(launchY, plan.placeCell.y)
  const apexDeadline = deps.now() + deps.apexBudgetMs
  let apexSamples = 0
  let apexRise = takeoffObservedRise(jump.trace)
  let atApex = false
  // Why the apex never arrived, as live facts rather than "no_rise":
  //   * an idle physics loop (dead/dying body, stalled doPhysics) never
  //     integrates the arc - the live run at health 1 / food 0 observed
  //     `traceTicks=1` and the body frozen at the launch height;
  //   * a clientbound position packet storm (a server reset/teleport, counted
  //     by `forcedMove`) zeroes the velocity and restarts the flight, so the
  //     measured rise is not the column's ceiling.
  // Both are transient environment facts and must not be read as "this column
  // cannot be climbed" (`no_rise`), which is what drives relocation.
  let apexTicks = 0
  let apexForcedMoves = 0
  const onApexTick = (): void => {
    apexTicks += 1
  }
  const onApexForcedMove = (): void => {
    apexForcedMoves += 1
  }
  bot.on('physicsTick', onApexTick)
  bot.on('forcedMove', onApexForcedMove)
  try {
    while (deps.now() < apexDeadline) {
      deps.ensureOwned?.()
      apexSamples += 1
      const vy = bot.entity.velocity.y
      const rise = bot.entity.position.y - launchY
      if (rise > apexRise) apexRise = rise
      if (rise >= requiredRise && vy <= PILLAR_APEX_VY_MAX && vy >= PILLAR_APEX_FALL_VY) {
        atApex = true
        break
      }
      if (vy < PILLAR_APEX_FALL_VY) {
        // Already past the vertex: placing now puts the block wherever the body
        // happens to be, which is exactly the "no level gained" live failure.
        // `apexRise` (including the takeoff-observed peak) only names whether the
        // arc ever cleared the cell; it never authorises a below-clearance place.
        return fail('apex', apexRise >= requiredRise ? 'apex_missed' : 'falling_before_place', apexSamples, undefined, jump.trace)
      }
      await deps.sleep(deps.pollMs)
    }
  } finally {
    bot.removeListener('physicsTick', onApexTick)
    bot.removeListener('forcedMove', onApexForcedMove)
  }
  if (!atApex) {
    if (apexForcedMoves > 0) {
      return fail('apex', 'flight_reset', apexSamples, `forcedMoves=${apexForcedMoves}`, jump.trace)
    }
    if (apexTicks === 0) {
      return fail('apex', 'physics_stalled', apexSamples, `apexTicks=0 forcedMoves=${apexForcedMoves}`, jump.trace)
    }
    return fail('apex', apexRise >= requiredRise ? 'apex_timeout' : 'no_rise', apexSamples, undefined, jump.trace)
  }

  let placeSamples = 0
  try {
    await deps.place(face)
  } catch (error) {
    return fail('place', 'refused', placeSamples, error instanceof Error ? error.message : String(error), jump.trace)
  }
  const placeDeadline = deps.now() + deps.placeSettleMs
  let placed = false
  for (;;) {
    deps.ensureOwned?.()
    placeSamples += 1
    if (deps.blockPlaced()) {
      placed = true
      break
    }
    if (deps.now() >= placeDeadline) break
    await deps.sleep(deps.pollMs)
  }
  if (!placed) return fail('place', 'not_landed', placeSamples)

  const landingDeadline = deps.now() + deps.landingBudgetMs
  let landingSamples = 0
  while (deps.now() < landingDeadline) {
    deps.ensureOwned?.()
    landingSamples += 1
    const y = bot.entity.position.y
    if (
      Math.abs(y - landingY) <= PILLAR_LANDING_Y_TOLERANCE &&
      bot.entity.velocity.y <= PILLAR_APEX_VY_MAX &&
      deps.blockPlaced()
    ) {
      return {
        ok: true,
        fromY: launchY,
        toY: y,
        apexRise,
        samples: jump.samples + apexSamples + placeSamples + landingSamples,
        jumpTrace: jump.trace,
      }
    }
    await deps.sleep(deps.pollMs)
  }
  return fail('landing', 'not_on_block', placeSamples + landingSamples, undefined, jump.trace)
}
