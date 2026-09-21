// strategicStall.ts - issue #360: state-conditioned strategic non-progress.
//
// Measured live (m3-live, `run.jsonl`, window 2026-09-21T12:46:21.695Z ->
// 2026-09-21T13:34:50.960Z, 48.5 min): 1888 verified MOVE arrivals, 1533 blocks
// travelled, 0.815 blocks net displacement, `goal`/`search` progress 0, 401
// `OSCILLATION_DETECTED`, and one Option (`system2:recover_vertical_access`,
// plan `g2:surface:log`) authoritative the whole time. Every beta vote said
// continue (max 0.36 < 0.5). The body was walking ~1.5 km inside a one-block
// pocket while every deterministic counter was quiet.
//
// Why the existing counters cannot see it:
//   - `updateStallSignal` measures `Date.now() - lastProgressAt`, and every
//     verified MOVE arrival is classified `progress=body`, which resets
//     `lastProgressAt` (controller-legacy.ts onActionComplete);
//   - `ActionFailureEscalation` needs a typed action FAILURE;
//   - `WaitStreakEscalation` needs a chosen WAIT;
//   - `ReplanThrottle` needs a replan to be attempted and suppressed.
// A loop of successful body-only MOVEs between a handful of cells has none of
// those: it is `execution=success` forever.
//
// This module is the deterministic, pure *evidence* owner for the missing
// concept: verified body motion that keeps returning to the SAME small set of
// states with zero goal/search progress. It is state-conditioned (a recurrence
// window of fingerprints), NOT a wall-clock timer and NOT a raw move count, and
// it never chooses WHAT comes next or ranks candidates. The controller feeds the
// evidence to Jev beta (`authorityState`), and only code-proven exhaustion
// crosses the System2 lifecycle boundary (`semanticExhausted`).
import type { ProgressKind } from './actionPostcondition.ts'

/**
 * How many consecutive body-only decisions may recur inside the same small set
 * of states before the local recovery is code-proven non-progressing.
 *
 * Live shape: A<->B and A<->B<->C at ~1.35 s/decision. 24 decisions is ~32 s of
 * unbroken state recurrence with zero semantic progress, well above the existing
 * 3-cycle oscillation detector and far below the 48.5 min live freeze.
 */
export const STRATEGIC_STALL_HORIZON_DEFAULT = 24

/**
 * How many DISTINCT state fingerprints may appear inside the window and still
 * count as "the same pocket". 3 covers the measured A<->B<->C (`MOVE:p3_67_17`,
 * `MOVE:p3_67_18`, `MOVE:p2_67_18`) and A<->B shapes while a real route grows
 * its distinct-state count monotonically.
 */
export const STRATEGIC_STALL_MAX_DISTINCT_STATES_DEFAULT = 3

/**
 * Minimum body-progress decisions required in the window. A WAIT-only or
 * failure-only stall has no body progress and belongs to the existing WAIT /
 * ACTION_FAILURE counters; this evidence is specifically the
 * "successful-actuation / zero-semantic-progress" phenotype.
 */
export const STRATEGIC_STALL_MIN_BODY_PROGRESS_DEFAULT = 6

/** `BUDDY_STRATEGIC_STALL_HORIZON` overrides N; invalid values fall back. */
export function resolveStrategicStallHorizon(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = Number(env.BUDDY_STRATEGIC_STALL_HORIZON ?? STRATEGIC_STALL_HORIZON_DEFAULT)
  return Number.isInteger(raw) && raw >= 1 ? raw : STRATEGIC_STALL_HORIZON_DEFAULT
}

/** `BUDDY_STRATEGIC_STALL_MAX_DISTINCT` overrides N; invalid values fall back. */
export function resolveStrategicStallMaxDistinctStates(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_STRATEGIC_STALL_MAX_DISTINCT ?? STRATEGIC_STALL_MAX_DISTINCT_STATES_DEFAULT)
  return Number.isInteger(raw) && raw >= 1 ? raw : STRATEGIC_STALL_MAX_DISTINCT_STATES_DEFAULT
}

/** `BUDDY_STRATEGIC_STALL_MIN_BODY` overrides N; invalid values fall back. */
export function resolveStrategicStallMinBodyProgress(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_STRATEGIC_STALL_MIN_BODY ?? STRATEGIC_STALL_MIN_BODY_PROGRESS_DEFAULT)
  return Number.isInteger(raw) && raw >= 0 ? raw : STRATEGIC_STALL_MIN_BODY_PROGRESS_DEFAULT
}

/**
 * One settled decision, reduced to the facts this evidence needs. `stateKey` is
 * the caller's compact trajectory fingerprint (the quantized position key the
 * oscillation detector already uses), so sub-block jitter cannot inflate the
 * distinct-state count.
 */
export interface StrategicStallObservation {
  /** canonical current Option instance (`g2:surface:log`); a change re-arms */
  optionInstanceId: string | null
  /** compact recurrent-state key (quantized position) */
  stateKey: string
  /** typed progress kinds of the settled action (`goal` / `search` / `body` / `none`) */
  progressKinds: readonly ProgressKind[]
}

/**
 * The exact code-owned evidence block handed to Jev beta and logged. It is
 * descriptive: it says how much of the recent trajectory was body-only
 * recurrence with no semantic progress, never which Option to choose instead.
 */
export interface StrategicStallEvidence {
  optionInstanceId: string | null
  /** settled decisions in the current recurrence window */
  windowSize: number
  /** distinct state keys inside the window */
  distinctStates: number
  /** window decisions that showed body progress (verified actuation) */
  bodyProgressDecisions: number
  /** window decisions that showed goal or search progress (a real boundary) */
  semanticProgressDecisions: number
  /** the bounded window this recurrence is measured against (grows per fired boundary) */
  horizon: number
  /** the distinct-state bound for "one pocket" */
  maxDistinctStates: number
  /**
   * True when a full window of decisions returned to at most `maxDistinctStates`
   * states, showed at least `minBodyProgress` verified body-progress decisions,
   * and made zero goal/search progress. This is the code-owned proof the
   * semantic layer may use as an exhaustion boundary.
   */
  exhausted: boolean
  /**
   * Fired boundaries for this Option since the last semantic progress / Option
   * change. Grows while the same pocket persists, so the controller can bound
   * repeated System2 consultations.
   */
  exhaustedRepeats: number
}

export const STRATEGIC_NON_PROGRESS_MARKER = 'STRATEGIC_NON_PROGRESS'
export const STRATEGIC_NON_PROGRESS_EXHAUSTED_MARKER = 'STRATEGIC_NON_PROGRESS_EXHAUSTED'

/** Counter/evidence line: the recurrence window itself, greppable and exact. */
export function formatStrategicNonProgressEvidence(goalKey: string, evidence: StrategicStallEvidence): string {
  return (
    `${STRATEGIC_NON_PROGRESS_MARKER} goal=${goalKey} window=${evidence.windowSize}/${evidence.horizon} ` +
    `distinct=${evidence.distinctStates}/${evidence.maxDistinctStates} body=${evidence.bodyProgressDecisions} ` +
    `goal_or_search=${evidence.semanticProgressDecisions}`
  )
}

/** Boundary line: the code-owned recurrence horizon is exhausted. */
export function formatStrategicNonProgressExhausted(goalKey: string, evidence: StrategicStallEvidence): string {
  return (
    `${STRATEGIC_NON_PROGRESS_EXHAUSTED_MARKER} goal=${goalKey} repeats=${evidence.exhaustedRepeats} ` +
    `window=${evidence.windowSize}/${evidence.horizon} distinct=${evidence.distinctStates}/${evidence.maxDistinctStates} ` +
    `body=${evidence.bodyProgressDecisions} -> wake System2`
  )
}

/**
 * How much longer the window must grow after each exhausted consultation on the
 * SAME Option. The live loop produced 401 oscillation detections in 48.5 min; an
 * unbounded "ask System2 every 24 decisions" would trade one failure (silence)
 * for another (spam). Each fired boundary doubles the required window, bounded
 * at `2 ** STRATEGIC_STALL_MAX_BACKOFF_EXPONENT`, mirroring the existing bounded
 * semantic-budget protection (`mercuryWaitLimitBackoffDelayMs`).
 */
export const STRATEGIC_STALL_MAX_BACKOFF_EXPONENT = 4

/** The window required before the next boundary on one unchanged Option. */
export function strategicStallRequiredWindow(horizon: number, exhaustedRepeats: number): number {
  const exponent = Math.min(Math.max(0, exhaustedRepeats), STRATEGIC_STALL_MAX_BACKOFF_EXPONENT)
  return horizon * 2 ** exponent
}

interface WindowEntry {
  stateKey: string
  body: boolean
  semantic: boolean
}

/**
 * State-recurrence tracker for one Option. Pure and injectable: the caller
 * supplies the observations and reads `evidence()`; there is no clock and no bot.
 *
 * Semantics:
 *   - the window is the last `horizon` settled decisions for the current Option;
 *   - `goal` / `search` progress inside the window prevents exhaustion (a real
 *     progress boundary), while `body` / `none` do not reset anything, so
 *     successful body motion alone cannot clear strategic non-progress;
 *   - a different Option instance clears the window and the exhaustion count;
 *   - `exhausted` becomes true only when the window is full, holds at most
 *     `maxDistinctStates` distinct states, made zero semantic progress, and had
 *     at least `minBodyProgress` body-progress decisions;
 *   - `acknowledgeExhaustion()` records a fired boundary (so the next one needs a
 *     longer window) and clears the window without inventing progress.
 */
export class StrategicStallTracker {
  private readonly horizon: number
  private readonly maxDistinctStates: number
  private readonly minBodyProgress: number
  private readonly window: WindowEntry[] = []
  private optionInstanceId: string | null = null
  private exhaustedRepeats = 0

  constructor(
    horizon: number = STRATEGIC_STALL_HORIZON_DEFAULT,
    maxDistinctStates: number = STRATEGIC_STALL_MAX_DISTINCT_STATES_DEFAULT,
    minBodyProgress: number = STRATEGIC_STALL_MIN_BODY_PROGRESS_DEFAULT,
  ) {
    this.horizon = Number.isInteger(horizon) && horizon >= 1 ? horizon : STRATEGIC_STALL_HORIZON_DEFAULT
    this.maxDistinctStates =
      Number.isInteger(maxDistinctStates) && maxDistinctStates >= 1
        ? maxDistinctStates
        : STRATEGIC_STALL_MAX_DISTINCT_STATES_DEFAULT
    this.minBodyProgress =
      Number.isInteger(minBodyProgress) && minBodyProgress >= 0
        ? minBodyProgress
        : STRATEGIC_STALL_MIN_BODY_PROGRESS_DEFAULT
  }

  /** Re-arm when the active Option instance changes (System2 replaced the plan). */
  setOption(optionInstanceId: string | null): void {
    if (optionInstanceId === this.optionInstanceId) return
    this.optionInstanceId = optionInstanceId
    this.window.length = 0
    this.exhaustedRepeats = 0
  }

  /** Record one settled decision and return the updated evidence. */
  note(observation: StrategicStallObservation): StrategicStallEvidence {
    this.setOption(observation.optionInstanceId)
    this.window.push({
      stateKey: observation.stateKey,
      body: observation.progressKinds.includes('body'),
      semantic: observation.progressKinds.includes('goal') || observation.progressKinds.includes('search'),
    })
    const required = this.requiredWindow()
    while (this.window.length > required) this.window.shift()
    return this.evidence()
  }

  /** Current evidence without recording anything. Never mutates. */
  evidence(): StrategicStallEvidence {
    const required = this.requiredWindow()
    const distinct = new Set(this.window.map((entry) => entry.stateKey)).size
    const body = this.window.filter((entry) => entry.body).length
    const semantic = this.window.filter((entry) => entry.semantic).length
    const exhausted =
      this.window.length >= required &&
      distinct <= this.maxDistinctStates &&
      semantic === 0 &&
      body >= this.minBodyProgress
    return {
      optionInstanceId: this.optionInstanceId,
      windowSize: this.window.length,
      distinctStates: distinct,
      bodyProgressDecisions: body,
      semanticProgressDecisions: semantic,
      horizon: required,
      maxDistinctStates: this.maxDistinctStates,
      exhausted,
      exhaustedRepeats: this.exhaustedRepeats,
    }
  }

  /**
   * A boundary fired for the current exhaustion. The window is cleared (the
   * evidence was consumed) and the next window on the same Option must be twice
   * as long, so a persistent pocket cannot hot-loop System2 consultations.
   */
  acknowledgeExhaustion(): StrategicStallEvidence {
    this.exhaustedRepeats += 1
    this.window.length = 0
    return this.evidence()
  }

  reset(): void {
    this.window.length = 0
    this.exhaustedRepeats = 0
  }

  private requiredWindow(): number {
    return strategicStallRequiredWindow(this.horizon, this.exhaustedRepeats)
  }
}
