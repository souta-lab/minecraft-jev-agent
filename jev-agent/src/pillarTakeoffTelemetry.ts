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
// Trace support (additive, observation only): the bounded `PillarJumpTrace`
// already produced by `jumpWithGroundCorrection` is summarised here so the live
// `PILLAR_TAKEOFF` / `PILLAR_FAIL` lines can show WHICH tick clamped the body.
// The trace types are reused from `pillarJump.ts` verbatim; this module never
// re-derives physics, only reads and packages the recorded samples.
import type { PillarJumpTrace, PillarJumpTraceEvent, PillarJumpTraceSample } from './pillarJump.ts'

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
  failureStep: string | null
  failureReason: string | null
  /**
   * Optional additive input: the bounded, attempt-local trace from
   * `PillarJumpOutcome.trace`. Absent (or null) means `no_trace` - it is never
   * required, so existing callers keep working unchanged.
   */
  jumpTrace?: PillarJumpTrace | null
}

/**
 * Typed, mutually exclusive classification of the takeoff evidence.
 *
 * The first three are the two causes of `no_rise` plus the "no data" case:
 *   - `gate_never_fired`        no sample shows a launch actuation at all
 *   - `gate_fired_move_clamped` the gate fired yet the body never rose
 *   - `no_trace`                no trace was supplied to inspect
 * `gate_fired_and_rose` is the remaining state (a launch that did rise, i.e. the
 * success / non-`no_rise` case) so the field is always one of a closed union
 * rather than an implicit `undefined`.
 */
export type PillarTakeoffDiscriminator =
  | 'no_trace'
  | 'gate_never_fired'
  | 'gate_fired_move_clamped'
  | 'gate_fired_and_rose'

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
  /** physicsTick observations in the trace; null when no trace was supplied */
  traceTicks: number | null
  /** samples that show a launch actuation (gate or its fallback); null when no trace */
  traceGateFires: number | null
  /** highest observed rise (blocks) in the trace; null when no trace was supplied */
  traceMaxRise: number | null
  /** true when the source trace or its compact string hit a bound */
  traceTruncated: boolean
  /** bounded, single-line per-sample trace; `none` when no trace was supplied */
  traceCompact: string
  /** typed classification of the takeoff evidence (see the union above) */
  takeoffDiscriminator: PillarTakeoffDiscriminator
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

/** Hard cap for the compact per-sample trace appended to one log line. */
export const MAX_TRACE_COMPACT_CHARS = 1600

/** One character per trace event; keeps the compact string greppable and short. */
const TRACE_EVENT_CODE: Record<PillarJumpTraceEvent, string> = {
  initial: 'i',
  control: 'c',
  physicsTick: 'p',
  forcedMove: 'f',
  poll: 'o',
  impulse: 'm',
}

const roundTrace = (value: number): number => Math.round(value * 1000) / 1000

/**
 * Did THIS observation show a launch actuation?
 *
 * Sound rule, read straight from the samples (no physics is invented here):
 *   - an `impulse` observation (or a populated `velocityYBefore`, which is only
 *     ever set on an impulse observation) is this module's own write of the
 *     exact vanilla impulse `Math.fround(0.42)` after the body was observed
 *     grounded, so the launch path demonstrably ran;
 *   - `initial`/`control` are recorded before any physics can apply the jump, so
 *     a positive velocity there would be pre-existing state, not a gate fire;
 *   - every later observation with `velocityY > 0` can only come from a jump
 *     impulse: gravity is strictly negative and `clearControlStates` runs before
 *     the attempt, so an upward velocity cannot be anything else.
 *
 * A gate fire that was clamped before the first observation AND never reached the
 * fallback impulse is, by construction, absent from these samples - the trace
 * records the gate's *effect*. In that case "no sample shows the gate firing" is
 * the honest answer (`gate_never_fired`), which is exactly what this reports.
 */
function sampleShowsGateFire(sample: PillarJumpTraceSample): boolean {
  if (sample.event === 'impulse' || sample.velocityYBefore !== undefined) return true
  if (sample.event === 'initial' || sample.event === 'control') return false
  return sample.velocityY > 0
}

/** One compact, single-line token per trace sample (never contains a newline). */
function formatCompactTraceSample(sample: PillarJumpTraceSample): string {
  const flags =
    (sample.grounded ? 'G' : '-') +
    (sample.airborne ? 'A' : '-') +
    (sample.onGroundBefore ? 'B' : '-') +
    (sample.onGroundAfter ? 'P' : '-')
  const velocityBefore =
    sample.velocityYBefore === undefined ? '' : `v${roundTrace(sample.velocityYBefore)}`
  return (
    `${sample.atMs}${TRACE_EVENT_CODE[sample.event]}` +
    `r${roundTrace(sample.rise)}` +
    `y${roundTrace(sample.velocityY)}` +
    `t${sample.ticks}i${sample.impulses}` +
    flags +
    velocityBefore
  )
}

interface PillarTakeoffTraceSummary {
  traceTicks: number | null
  traceGateFires: number | null
  traceMaxRise: number | null
  traceTruncated: boolean
  traceCompact: string
  takeoffDiscriminator: PillarTakeoffDiscriminator
}

/**
 * Summarise an optional trace. Absent => `no_trace` with null measurements (an
 * absent trace is not a measurement of zero). Otherwise the summary is pure
 * arithmetic over the recorded samples and the compact string is capped at
 * `MAX_TRACE_COMPACT_CHARS`, with truncation marked both in-band (`~`) and via
 * `traceTruncated`.
 */
function summarizePillarJumpTrace(trace: PillarJumpTrace | null | undefined): PillarTakeoffTraceSummary {
  if (trace === null || trace === undefined) {
    return {
      traceTicks: null,
      traceGateFires: null,
      traceMaxRise: null,
      traceTruncated: false,
      traceCompact: 'none',
      takeoffDiscriminator: 'no_trace',
    }
  }
  let traceTicks = 0
  let traceGateFires = 0
  let traceMaxRise = Number.NEGATIVE_INFINITY
  let anyAirborne = false
  for (const sample of trace.samples) {
    if (sample.event === 'physicsTick') traceTicks += 1
    if (sampleShowsGateFire(sample)) traceGateFires += 1
    if (sample.rise > traceMaxRise) traceMaxRise = sample.rise
    if (sample.airborne) anyAirborne = true
  }
  // An empty trace has no rise to report; use 0 rather than -Infinity.
  if (!Number.isFinite(traceMaxRise)) traceMaxRise = 0
  const takeoffDiscriminator: PillarTakeoffDiscriminator =
    traceGateFires === 0
      ? 'gate_never_fired'
      : traceMaxRise <= 0 && !anyAirborne
        ? 'gate_fired_move_clamped'
        : 'gate_fired_and_rose'
  const tokens: string[] = []
  let length = 0
  let stringTruncated = false
  for (const sample of trace.samples) {
    const token = formatCompactTraceSample(sample)
    const added = tokens.length === 0 ? token.length : token.length + 1
    if (length + added > MAX_TRACE_COMPACT_CHARS) {
      stringTruncated = true
      break
    }
    tokens.push(token)
    length += added
  }
  const truncated = trace.truncated || stringTruncated
  let traceCompact = tokens.length === 0 ? 'none' : tokens.join(';')
  if (truncated && traceCompact !== 'none') {
    traceCompact = `${traceCompact.slice(0, MAX_TRACE_COMPACT_CHARS - 1)}~`
  }
  return {
    traceTicks,
    traceGateFires,
    traceMaxRise,
    traceTruncated: truncated,
    traceCompact,
    takeoffDiscriminator,
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
    // Additive trace summary: appended after every pre-existing field so their
    // names, order and meaning are unchanged.
    ...summarizePillarJumpTrace(input.jumpTrace),
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
    // Additive tail: every existing field above is byte-for-byte unchanged and
    // still in the same order; the trace summary is appended after it.
    ` takeoffDiscriminator=${t.takeoffDiscriminator}` +
    ` traceTicks=${t.traceTicks === null ? 'null' : t.traceTicks}` +
    ` traceGateFires=${t.traceGateFires === null ? 'null' : t.traceGateFires}` +
    ` traceMaxRise=${t.traceMaxRise === null ? 'null' : t.traceMaxRise}` +
    ` traceTruncated=${String(t.traceTruncated)}` +
    ` trace=${t.traceCompact}`
  )
}
