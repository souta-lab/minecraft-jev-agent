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
//
// The PLACE-ATTEMPT contract. The measured window is the 791-record live run
// (`/home/s0u7a/mc-ai-worktrees/m3-live/buddy-driver/buddy.log`): 410
// `place/refused` and 277 `apex/apex_missed`, of which `placeY == floor(launchY)`
// in 405 of the refusals (the step fills the cell the feet occupy), fail-time
// `rise` 0 - the body back at its launch height - in 222, `endVelocityY` -0.0784
// (the first post-landing gravity tick) in 54, `traceMaxRise >= the exact
// clearance` in 258 of the 277 apex records, and `forcedRepositions == 0` in 705
// of 791. The gate used to authorise the packet from ONE sampled position with a
// demand of EXACTLY `placeCell.y + 1` - zero margin above the cell top - while
// mineflayer wrote the packet several position updates later:
//
//   `bot.placeBlock` -> `_genericPlace` awaits `bot.lookAt`
//   (lib/plugins/generic_place.js:37) -> `bot.look` awaits `lookingTask.promise`
//   (lib/plugins/physics.js:386), resolved by the `move` event emitted inside
//   `tickPhysics` -> `updatePosition` (physics.js:91-93,116). The continuation
//   runs only after that frame's whole catch-up loop (physics.js:74-79,
//   PHYSICS_CATCHUP_TICKS = 4), and every tick of that frame sent a position
//   packet - the position the server validates the placement against.
//
// A 0.42 jump clears a one-block cell by ~0.25 blocks (about three position
// updates of slack), so a handshake longer than the margin wrote the packet with
// the body's own AABB back inside the destination cell and the server refused.
// Reproduced exactly on the dominant live geometry - `placeY == floor(launchY)`
// in 405/410 refusals: `PILLAR_FAIL step=place reason=refused y=67 rise=0
// samples=0` with the attempt-time feet exactly 1.0 below the cell top. That is
// why the log could not tell the mechanisms apart: the record carried the LAUNCH
// Y and the post-refusal Y, never the attempt-time Y.
//
// The contract is therefore the body's OCCUPANCY - the fact the server itself
// validates - and it must hold over the actuator's whole remaining gap, not at
// one sample.
import { jumpWithGroundCorrection, TAKEOFF_RISE } from './pillarJump.ts'
import type { JumpBotLike, PillarJumpDeps, PillarJumpTrace, Vec3Like } from './pillarJump.ts'

/**
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
/** A settled body is one whose descent has stopped (`vy` at or below this). */
export const PILLAR_APEX_VY_MAX = 0.01
/**
 * The descent speed past which a sample is EVIDENCE of a hard fall (a ceiling
 * slam, a server correction), not a place gate. It deliberately no longer bounds
 * the attempt: the attempt is bounded by the body's occupancy (see
 * `pillarPlaceCellCleared`), which is the fact the server validates.
 */
export const PILLAR_APEX_FALL_VY = -0.25

/**
 * Minecraft's per-tick player gravity and air drag, exactly as prismarine-physics
 * applies them: `vel.y -= physics.gravity` then `vel.y *= physics.airdrag`
 * (prismarine-physics index.js:601-603), with `gravity: 0.08` (index.js:62) and
 * `airdrag: Math.fround(1 - 0.02)` (index.js:63). The drag is a FLOAT32 constant
 * and the live jumpTrace velocities only match it as one
 * (`0.33319999363422365`, not the double `0.33319998714923854`), so it is pinned
 * as the engine's own expression rather than as `0.98`.
 */
export const PILLAR_GRAVITY_PER_TICK = 0.08
export const PILLAR_DRAG_PER_TICK = Math.fround(1 - 0.02)

/**
 * The bounded gap this module assumes between the moment the clearance is
 * sampled and the moment the `block_place` packet is written, when the actuator
 * goes through mineflayer's look handshake. It is a DECLARED bound, not a
 * measured one: the handshake ends on the first `move` event after the sent yaw
 * converges, and `lastSentYaw` advances at most
 * `PHYSICS_TIMESTEP * physics.yawSpeed = 0.05 * 3.0 = 0.15` rad/tick
 * (physics.js:190-196), so a large look change costs many ticks. Four covers the
 * physics catch-up loop; a caller that cannot bound the handshake must declare
 * this and accept that a one-block column may then be reported `apex_missed`
 * rather than attempted.
 */
export const PILLAR_PLACE_LOOK_HANDSHAKE_TICKS = 4

/**
 * The gap when the placement is written inside the clearance sample's own tick
 * (no look handshake): the sample IS the position the server validates against,
 * so the contract collapses to the exact occupancy predicate.
 */
export const PILLAR_PLACE_SAME_TICK = 0

/**
 * The position delta after `ticks` physics updates starting from `velocityY`
 * with no collision: the free trajectory. Positive while the body still rises.
 */
export function pillarTrajectoryDelta(velocityY: number, ticks: number): number {
  let position = 0
  let velocity = velocityY
  for (let index = 0; index < ticks; index += 1) {
    position += velocity
    velocity = (velocity - PILLAR_GRAVITY_PER_TICK) * PILLAR_DRAG_PER_TICK
  }
  return position
}

/**
 * The LOWEST position delta the body can have over the next `ticks` updates.
 *
 * A ceiling can zero the rise at any tick and hand the body straight back to
 * gravity, so the free trajectory is not a lower bound. Enumerating the
 * collision tick `j` (rise freely for `j` updates, then fall from rest for
 * `ticks - j`) reduces to the minimum of two cases: for a rising body the worst
 * case is the immediate slam (fall from rest across the whole window), and for a
 * descending body it is the free trajectory (which only steepens). Both are
 * computed here; `ticks <= 0` is exactly zero, so a same-tick attempt has no
 * modelled pessimism at all.
 */
export function pillarWorstPlaceDelta(velocityY: number, ticks: number): number {
  if (ticks <= 0) return 0
  return Math.min(pillarTrajectoryDelta(velocityY, ticks), pillarTrajectoryDelta(0, ticks))
}

/**
 * The placement contract: the packet may be sent only when the body's own
 * bounding box does not intersect the destination cell - at the sampled moment
 * AND at the worst moment of the actuator's remaining gap.
 *
 * The body's AABB is `[feetY, feetY + 1.8]` and the destination cell is
 * `[placeCellY, placeCellY + 1]`, so no overlap is exactly
 * `feetY >= placeCellY + 1`. With `handshakeTicks = 0` (the decision and the
 * packet share a tick) this is the exact predicate the server applies; with a
 * declared gap it demands the worst-case clearance over that gap, which turns
 * "the server refused a place we could not keep" into a typed pre-attempt
 * refusal.
 */
export function pillarPlaceCellCleared(input: {
  feetY: number
  velocityY: number
  placeCellY: number
  handshakeTicks: number
}): boolean {
  const lowestFeet = input.feetY + pillarWorstPlaceDelta(input.velocityY, input.handshakeTicks)
  return lowestFeet >= input.placeCellY + 1
}

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

/**
 * Why a `place` sub-step failed. `refused` means the SERVER refused the packet
 * (a policy/geometry answer); `body_in_cell` means the attempt-time occupancy
 * contract rejected it here, before any packet was written. They must stay
 * distinguishable: `refused` is the server answering a question we asked
 * correctly, `body_in_cell` is us having asked it too late.
 */
export type PillarPlaceFailReason = 'refused' | 'not_landed' | 'wrong_cell' | 'body_in_cell'

export interface PillarFail {
  step: PillarFailStep
  reason: string
  y: number
  rise: number
  samples: number
  detail?: string
  /** takeoff observations for this exact pillar attempt, when available */
  jumpTrace?: PillarJumpTrace
  /**
   * The body's OWN feet Y at the moment the placement was attempted, or at the
   * moment the attempt was refused before any packet. This is the number the
   * live log was missing: `y`/`rise` are read after the place has settled (the
   * body may already have fallen back), so they cannot testify about the
   * attempt.
   */
  attemptFeetY?: number
  /** The clearance the attempt had to produce: `placeCell.y + 1`. */
  attemptCellTop?: number
  /** The declared actuator gap the contract was evaluated against, in ticks. */
  attemptHandshakeTicks?: number
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

/** The precision the attempt-time feet Y is named with (1/10000 block). */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000
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
  /**
   * The bounded number of position updates the actuator may take between this
   * module's clearance sample and the `block_place` packet. `0`
   * (`PILLAR_PLACE_SAME_TICK`) means the decision and the packet share a tick, so
   * the sampled occupancy IS what the server validates. Any positive value makes
   * the contract demand the worst-case clearance over that whole gap.
   */
  placeHandshakeTicks: number
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
    attempt?: { feetY: number; cellTop: number; handshakeTicks: number },
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
      ...(attempt === undefined
        ? {}
        : {
            attemptFeetY: attempt.feetY,
            attemptCellTop: attempt.cellTop,
            attemptHandshakeTicks: attempt.handshakeTicks,
          }),
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
  // placement contract: the peak is history, while the server validates the
  // placement against the body's occupancy at the moment the packet arrives.
  // `requiredRise` is kept only as the diagnostic demand: it says whether the
  // arc EVER cleared the cell, which is what separates an unsatisfiable column
  // (`apex_missed` / `falling_before_place`) from an actuator that could not be
  // held to the contract.
  const requiredRise = requiredApexRise(launchY, plan.placeCell.y)
  const attemptCellTop = plan.placeCell.y + 1
  const handshakeTicks = deps.placeHandshakeTicks
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
      const feetY = bot.entity.position.y
      const rise = feetY - launchY
      if (rise > apexRise) apexRise = rise
      // The attempt is authorised by the body's OCCUPANCY, never by a velocity
      // window: `feetY >= placeCell.y + 1` is the fact the server validates, and
      // it is evaluated across the actuator's whole declared gap so the packet
      // cannot be written after the body has fallen back into the cell. Accepting
      // during the ASCENT is what makes the window usable at all - a one-block
      // arc clears the cell top by only ~0.25 blocks, and excluding the ascent
      // (the old `vy <= 0.01` vertex rule) left a two-tick window that the
      // actuator's own await outlived.
      if (pillarPlaceCellCleared({ feetY, velocityY: vy, placeCellY: plan.placeCell.y, handshakeTicks })) {
        atApex = true
        break
      }
      if (vy < 0) {
        // The arc is spent: the body is descending, so the worst-case clearance
        // over the actuator's gap can only shrink from here. `apexRise`
        // (including the takeoff-observed peak) says whether the ARC ever
        // cleared the cell - it never authorises a below-clearance attempt.
        const hardFall = vy < PILLAR_APEX_FALL_VY ? ` hardFallVy=${round2(vy)}` : ''
        return fail(
          'apex',
          apexRise >= requiredRise ? 'apex_missed' : 'falling_before_place',
          apexSamples,
          `feetY=${round4(feetY)} cellTop=${attemptCellTop} arcPeakRise=${round4(apexRise)} requiredRise=${round4(requiredRise)} handshakeTicks=${handshakeTicks}${hardFall}`,
          jump.trace,
          { feetY, cellTop: attemptCellTop, handshakeTicks },
        )
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

  // The ATTEMPT contract, checked where the attempt happens. The gate above
  // authorised a moment; this re-reads the body in the same tick as the packet,
  // so a placement the server would refuse for occupying the destination cell is
  // never sent - it is reported as the typed `body_in_cell` with the attempt-time
  // Y, instead of consuming the arc and surfacing as a server policy refusal.
  const attemptFeetY = bot.entity.position.y
  if (attemptFeetY < attemptCellTop) {
    return fail(
      'place',
      'body_in_cell',
      0,
      `attemptFeetY=${round4(attemptFeetY)} cellTop=${attemptCellTop} shortfall=${round4(attemptCellTop - attemptFeetY)} handshakeTicks=${handshakeTicks}`,
      jump.trace,
      { feetY: attemptFeetY, cellTop: attemptCellTop, handshakeTicks },
    )
  }

  let placeSamples = 0
  try {
    await deps.place(face)
  } catch (error) {
    return fail(
      'place',
      'refused',
      placeSamples,
      error instanceof Error ? error.message : String(error),
      jump.trace,
      { feetY: attemptFeetY, cellTop: attemptCellTop, handshakeTicks },
    )
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
    // The arc happens here as well: keep reporting the real peak, so `apexRise`
    // is the step's ceiling and not merely the first authorised sample (a
    // same-tick attempt is authorised on the ascent, well below the vertex).
    const settledFeetY = bot.entity.position.y
    if (settledFeetY - launchY > apexRise) apexRise = settledFeetY - launchY
    if (deps.now() >= placeDeadline) break
    await deps.sleep(deps.pollMs)
  }
  if (!placed) {
    return fail('place', 'not_landed', placeSamples, undefined, jump.trace, {
      feetY: attemptFeetY,
      cellTop: attemptCellTop,
      handshakeTicks,
    })
  }

  const landingDeadline = deps.now() + deps.landingBudgetMs
  let landingSamples = 0
  while (deps.now() < landingDeadline) {
    deps.ensureOwned?.()
    landingSamples += 1
    const y = bot.entity.position.y
    // `apexRise` is this step's real arc ceiling, not the first sample the
    // contract authorised: a same-tick attempt is authorised on the ascent, so
    // the vertex is still ahead and must be observed here.
    if (y - launchY > apexRise) apexRise = y - launchY
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
  return fail(
    'landing',
    'not_on_block',
    placeSamples + landingSamples,
    `attemptFeetY=${round4(attemptFeetY)} cellTop=${attemptCellTop} landedFeetY=${round4(bot.entity.position.y)}`,
    jump.trace,
    { feetY: attemptFeetY, cellTop: attemptCellTop, handshakeTicks },
  )
}
