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
import { jumpWithGroundCorrection } from './pillarJump.ts'
import type { JumpBotLike, PillarJumpDeps, Vec3Like } from './pillarJump.ts'

/**
 * The apex window. A verified vertex needs all three: a rise of at least
 * `PILLAR_APEX_MIN_RISE` from the launch point (a 0.42 jump peaks ~1.25 blocks),
 * a velocity at or below `PILLAR_APEX_VY_MAX` (positive -> non-positive
 * crossing), and a velocity not below `PILLAR_APEX_FALL_VY` (the vertex, not
 * the fall). `velocity.y <= 0.01` alone is also true while standing and while
 * plummeting, which is how the old wait placed at the bottom of the arc.
 */
export const PILLAR_APEX_MIN_RISE = 0.5
export const PILLAR_APEX_VY_MAX = 0.01
export const PILLAR_APEX_FALL_VY = -0.25

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
  | { ok: true; fromY: number; toY: number; apexRise: number; samples: number }
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
  const fail = (step: PillarFailStep, reason: string, samples: number, detail?: string): PillarStepOutcome => ({
    ok: false,
    fail: {
      step,
      reason,
      y: bot.entity.position.y,
      rise: bot.entity.position.y - launchY,
      samples,
      detail,
    },
  })
  // The place must target the cell above the support block AND above the launch
  // feet cell: anything else places beside the body and can never be landed on.
  if (face.x !== 0 || face.y !== 1 || face.z !== 0 || plan.placeCell.y < plan.feetCell.y) {
    return fail('place', 'wrong_cell', 0)
  }

  const jump = await jumpWithGroundCorrection(bot, deps)
  if (!jump.airborne) return fail('takeoff', jump.failure ?? 'no_rise', jump.samples)

  deps.ensureOwned?.()
  const apexDeadline = deps.now() + deps.apexBudgetMs
  let apexSamples = 0
  let apexRise = 0
  let sawRise = false
  let atApex = false
  while (deps.now() < apexDeadline) {
    deps.ensureOwned?.()
    apexSamples += 1
    const vy = bot.entity.velocity.y
    const rise = bot.entity.position.y - launchY
    if (rise > apexRise) apexRise = rise
    if (rise >= PILLAR_APEX_MIN_RISE) sawRise = true
    if (sawRise && vy <= PILLAR_APEX_VY_MAX && vy >= PILLAR_APEX_FALL_VY) {
      atApex = true
      break
    }
    if (vy < PILLAR_APEX_FALL_VY) {
      // Already past the vertex: placing now puts the block wherever the body
      // happens to be, which is exactly the "no level gained" live failure.
      return fail('apex', sawRise ? 'apex_missed' : 'falling_before_place', apexSamples)
    }
    await deps.sleep(deps.pollMs)
  }
  if (!atApex) return fail('apex', sawRise ? 'apex_timeout' : 'no_rise', apexSamples)

  let placeSamples = 0
  try {
    await deps.place(face)
  } catch (error) {
    return fail('place', 'refused', placeSamples, error instanceof Error ? error.message : String(error))
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
      }
    }
    await deps.sleep(deps.pollMs)
  }
  return fail('landing', 'not_on_block', placeSamples + landingSamples)
}
