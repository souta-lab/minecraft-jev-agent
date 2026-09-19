// pillarTakeoffTelemetry.ts - instrumentation-only evidence for the classified
// PILLAR takeoff failure (`PILLAR_FAIL step=takeoff reason=no_rise`).
//
// This module is PURE and DETERMINISTIC so a simulated attempt can be asserted
// without a live server. It measures and classifies; it never changes behaviour
// (no control writes, no velocity writes, no policy).
//
// Observation API (read-only, structural - no unsafe casts):
//   `ControlStateLike` is the minimal shape this module needs. Mineflayer's
//   `bot.controlState` satisfies it, and a fixture can satisfy it with a plain
//   object literal, which is what makes the type boundary testable.
//
// Vertical trace (additive, m2-vertical-trace): an optional bounded per-tick
// trace from `pillarJump.ts` is summarised here and encoded compactly, so the
// PILLAR_TAKEOFF / PILLAR_FAIL records can name whether the jump gate never
// fired or fired but the move was clamped. Absent trace => null/0 defaults.
import { formatVerticalTraceCompact } from './pillarJump.ts'
import type { PillarVerticalTrace } from './pillarJump.ts'

/** Read-only, optional control state. Mineflayer's `controlState` satisfies this. */
export interface ControlStateLike {
  readonly controlState?: {
    readonly forward?: boolean
    readonly back?: boolean
    readonly left?: boolean
    readonly right?: boolean
    readonly jump?: boolean
    readonly sprint?: boolean
    readonly sneak?: boolean
  }
}

/** The subset of control state the takeoff telemetry correlates. */
export interface ControlSnapshot {
  forward: boolean | null
  jump: boolean | null
}

export interface Velocity3 {
  x: number
  y: number
  z: number
}

export interface Position3 {
  x: number
  y: number
  z: number
}

/**
 * Residual horizontal speed above this is treated as a leak at takeoff.
 * The bare-movement experiment (mcbot/movement-test/README.md) shows a pure
 * jump is accepted while a jump combined with a blocked forward push is
 * rejected, so any horizontal residue at the launch instant is the hypothesis
 * variable - not an assertion about causation.
 */
export const HORIZONTAL_VELOCITY_EPSILON = 0.01

export interface PillarTakeoffTelemetryInput {
  attemptId: string
  launchVelocity: Velocity3
  endVelocity: Velocity3
  launchControls: ControlSnapshot
  endControls: ControlSnapshot
  launchPosition: Position3
  endPosition: Position3
  forcedRepositions: number
  peakRise: number
  /** bounded within-attempt vertical trace (observation only; optional) */
  verticalTrace?: PillarVerticalTrace
  failureStep: string | null
  failureReason: string | null
}

export interface PillarTakeoffTelemetry {
  attemptId: string
  launchVelocityX: number
  launchVelocityY: number
  launchVelocityZ: number
  endVelocityX: number
  endVelocityY: number
  endVelocityZ: number
  forwardState: boolean | null
  jumpState: boolean | null
  endForwardState: boolean | null
  endJumpState: boolean | null
  forcedRepositions: number
  peakRise: number
  failureStep: string | null
  failureReason: string | null
  /** horizontal speed at the launch instant (hypothesis variable) */
  launchHorizontalSpeed: number
  /** horizontal speed at the end of the attempt (hypothesis variable) */
  endHorizontalSpeed: number
  /** true when horizontal velocity or forward control leaks during the attempt */
  horizontalLeak: boolean
  /**
   * Which mutually-exclusive takeoff cause the vertical trace supports:
   * `gate_never_fired`, `gate_fired_move_clamped`, `rise_observed`,
   * `no_physics_tick`, `inconclusive`; null when no trace was supplied.
   */
  takeoffDiscriminator: string | null
  traceTicks: number
  traceGateFires: number
  traceCollidedVerticallyTicks: number
  traceImpulseWrites: number
  traceMaxVelocityYAfterTick: number
  traceMaxRise: number
  /** compact bounded one-line trace; null when no trace was supplied */
  verticalTrace: string | null
}

/**
 * One attemptId per takeoff attempt. `sequence` is the attempt-local monotonic
 * counter, so relocation/retry loops under the same candidateId+epoch still get
 * distinct ids (required to correlate launch and end telemetry of ONE attempt).
 */
export function makePillarAttemptId(candidateId: string, epoch: number, sequence: number): string {
  return `${candidateId}#${epoch}#${sequence}`
}

/** Read-only control-state observation. Never writes controls. */
export function readControlState(bot: ControlStateLike): ControlSnapshot {
  const state = bot.controlState
  return {
    forward: state?.forward ?? null,
    jump: state?.jump ?? null,
  }
}

export function buildPillarTakeoffTelemetry(input: PillarTakeoffTelemetryInput): PillarTakeoffTelemetry {
  const launchHorizontalSpeed = Math.hypot(input.launchVelocity.x, input.launchVelocity.z)
  const endHorizontalSpeed = Math.hypot(input.endVelocity.x, input.endVelocity.z)
  // Leakage is taken at ANY observed point of the attempt: residual horizontal
  // velocity at launch or end, or an active forward control at launch or end.
  // The launch/end components stay separate in the record, so the flag is the
  // aggregate "was any horizontal/control leak observed?" answer.
  const horizontalLeak =
    launchHorizontalSpeed > HORIZONTAL_VELOCITY_EPSILON ||
    endHorizontalSpeed > HORIZONTAL_VELOCITY_EPSILON ||
    input.launchControls.forward === true ||
    input.endControls.forward === true
  return {
    attemptId: input.attemptId,
    launchVelocityX: input.launchVelocity.x,
    launchVelocityY: input.launchVelocity.y,
    launchVelocityZ: input.launchVelocity.z,
    endVelocityX: input.endVelocity.x,
    endVelocityY: input.endVelocity.y,
    endVelocityZ: input.endVelocity.z,
    forwardState: input.launchControls.forward,
    jumpState: input.launchControls.jump,
    endForwardState: input.endControls.forward,
    endJumpState: input.endControls.jump,
    forcedRepositions: input.forcedRepositions,
    peakRise: input.peakRise,
    failureStep: input.failureStep,
    failureReason: input.failureReason,
    launchHorizontalSpeed,
    endHorizontalSpeed,
    horizontalLeak,
    takeoffDiscriminator: input.verticalTrace?.discriminator ?? null,
    traceTicks: input.verticalTrace?.ticksObserved ?? 0,
    traceGateFires: input.verticalTrace?.gateFires ?? 0,
    traceCollidedVerticallyTicks: input.verticalTrace?.collidedVerticallyTicks ?? 0,
    traceImpulseWrites: input.verticalTrace?.impulseWrites ?? 0,
    traceMaxVelocityYAfterTick: input.verticalTrace?.maxVelocityYAfterTick ?? 0,
    traceMaxRise: input.verticalTrace?.maxRise ?? 0,
    verticalTrace: input.verticalTrace === undefined ? null : formatVerticalTraceCompact(input.verticalTrace),
  }
}

/** Single line for the existing mirrored launch/pillar marker path. */
export function formatPillarTakeoffTelemetry(t: PillarTakeoffTelemetry): string {
  return (
    `PILLAR_TAKEOFF attemptId=${t.attemptId}` +
    ` launchVel=${t.launchVelocityX},${t.launchVelocityY},${t.launchVelocityZ}` +
    ` endVel=${t.endVelocityX},${t.endVelocityY},${t.endVelocityZ}` +
    ` forward=${String(t.forwardState)} jump=${String(t.jumpState)}` +
    ` forcedRepositions=${t.forcedRepositions} peakRise=${t.peakRise}` +
    ` horizontalLeak=${String(t.horizontalLeak)}` +
    ` discriminator=${t.takeoffDiscriminator ?? 'none'}` +
    (t.verticalTrace === null ? '' : ` trace=${t.verticalTrace}`)
  )
}
