// betaHysteresis.ts - issue #24: hysteresis state machine for the beta
// termination controller.
//
// Measured 2026-09-18 (host pid=441190, main 10698f9):
//
//   JEV_HEADS action=ESCALATE abandon=1 decision=continue abandonRequested=true
//             betaAuthority=false betaShadowed=true   (repeats)
//
// The policy flips between `abandon` and `continue` for the SAME option with no
// smoothing: shadow mode suppresses the abandon, the option keeps failing
// (`verified=false progressDelta=0`), and a legitimate abandon is never honored.
//
// #24 requires the controller to decide with explicit hysteresis instead of a
// raw β crossing:
//
//   observe  - idle; a single abandon request only starts a streak.
//   armed    - K-1 or fewer consecutive abandon requests; decision is continue.
//   abandoned- a committed abandon. The decision STICKS for at least
//              `dwellCycles` cycles (anti-flapping) and is only released by
//              genuine progress.
//
// Committing needs `commitStreak` consecutive abandon requests OR an
// `unproductiveAttempts` count at/above `unproductiveLimit` (deterministic
// corroboration from the #79 attempt tracker). Once committed, a single
// contradictory observation must NOT flip the decision back: during the dwell
// it is ignored outright, and after the dwell it takes `commitStreak`
// consecutive contradictions to release.
//
// Genuine progress (`verified=true` or an inventory/state change) is strong
// evidence and resets to `observe` from ANY state, including a committed
// abandon. This module is pure and clock-free: `stepBetaHysteresis` is a
// deterministic function of (previous state, observation, config), so replaying
// the same input sequence always yields the same states and decision. The
// enforcement wiring lives in the sibling #79 `abandonPolicy.ts` lane; this
// module is the state machine it (or a later integration lane) composes with.

/** Consecutive abandon requests required before the decision flips. */
export const BETA_COMMIT_STREAK_DEFAULT = 3

/** Minimum cycles a committed abandon stays sticky (anti-flapping). */
export const BETA_DWELL_CYCLES_DEFAULT = 3

/** Unverified zero-progress attempts that corroborate an abandon request. */
export const BETA_UNPRODUCTIVE_LIMIT_DEFAULT = 3

export type BetaHysteresisState = 'observe' | 'armed' | 'abandoned'
export type BetaHysteresisDecision = 'continue' | 'abandon'

export interface BetaHysteresisConfig {
  /** K: consecutive abandon requests that commit the decision. */
  commitStreak: number
  /** D: minimum cycles a committed abandon is held before release is possible. */
  dwellCycles: number
  /** N: unproductive attempts that corroborate a single request. */
  unproductiveLimit: number
}

function positiveInt(value: unknown, fallback: number): number {
  const raw = Number(value)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : fallback
}

/**
 * Explicit thresholds, overridable for calibration. Defaults are the safe,
 * conservative values: 3 requests, 3 dwell cycles, 3 unproductive attempts.
 */
export function resolveBetaHysteresisConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BetaHysteresisConfig {
  return {
    commitStreak: positiveInt(env.BUDDY_BETA_COMMIT_STREAK, BETA_COMMIT_STREAK_DEFAULT),
    dwellCycles: positiveInt(env.BUDDY_BETA_DWELL_CYCLES, BETA_DWELL_CYCLES_DEFAULT),
    unproductiveLimit: positiveInt(env.BUDDY_UNPRODUCTIVE_ATTEMPT_LIMIT, BETA_UNPRODUCTIVE_LIMIT_DEFAULT),
  }
}

/** One decision cycle of evidence for a single option. */
export interface BetaHysteresisObservation {
  optionId: string
  /** did the raw beta vote cross its threshold this cycle? */
  abandonRequested: boolean
  /** genuine progress: `verified=true` or an inventory/state change. */
  progress: boolean
  /** consecutive unverified zero-progress attempts (from the attempt tracker). */
  unproductiveAttempts: number
}

export interface BetaHysteresisMachineState {
  optionId: string
  state: BetaHysteresisState
  /** consecutive abandon requests (frozen at the value that committed). */
  streak: number
  /** remaining dwell cycles while committed. */
  dwell: number
  /** consecutive contradictions observed after the dwell elapsed. */
  contradictions: number
  decision: BetaHysteresisDecision
}

/** The neutral starting point: no request, no commit. */
export function initialBetaHysteresis(optionId: string): BetaHysteresisMachineState {
  return { optionId, state: 'observe', streak: 0, dwell: 0, contradictions: 0, decision: 'continue' }
}

function observe(optionId: string): BetaHysteresisMachineState {
  return initialBetaHysteresis(optionId)
}

function commit(
  optionId: string,
  streak: number,
  config: BetaHysteresisConfig,
): BetaHysteresisMachineState {
  return {
    optionId,
    state: 'abandoned',
    streak,
    dwell: config.dwellCycles,
    contradictions: 0,
    decision: 'abandon',
  }
}

/**
 * Advance the state machine one cycle. Deterministic and clock-free.
 *
 * Precedence: genuine progress > an abandon request > a contradiction. A
 * committed (`abandoned`) decision ignores contradictions during its dwell and
 * after it until `commitStreak` of them accumulate, so one contradictory
 * observation can never flip a committed decision.
 */
export function stepBetaHysteresis(
  previous: BetaHysteresisMachineState | null,
  observation: BetaHysteresisObservation,
  config: BetaHysteresisConfig = resolveBetaHysteresisConfig(),
): BetaHysteresisMachineState {
  const prior = previous ?? initialBetaHysteresis(observation.optionId)

  // Genuine progress is strong evidence: reset from ANY state to observe.
  if (observation.progress) return observe(observation.optionId)

  switch (prior.state) {
    case 'observe': {
      if (!observation.abandonRequested) return observe(observation.optionId)
      const streak = 1
      const corroborated = observation.unproductiveAttempts >= config.unproductiveLimit
      if (streak >= config.commitStreak || corroborated) return commit(observation.optionId, streak, config)
      return { optionId: observation.optionId, state: 'armed', streak, dwell: 0, contradictions: 0, decision: 'continue' }
    }

    case 'armed': {
      if (!observation.abandonRequested) return observe(observation.optionId)
      const streak = prior.streak + 1
      const corroborated = observation.unproductiveAttempts >= config.unproductiveLimit
      if (streak >= config.commitStreak || corroborated) return commit(observation.optionId, streak, config)
      return { optionId: observation.optionId, state: 'armed', streak, dwell: 0, contradictions: 0, decision: 'continue' }
    }

    case 'abandoned': {
      if (observation.abandonRequested) {
        return {
          optionId: observation.optionId,
          state: 'abandoned',
          streak: prior.streak + 1,
          dwell: prior.dwell,
          contradictions: 0,
          decision: 'abandon',
        }
      }
      // A contradictory observation. During the dwell it cannot release the
      // decision at all (anti-flapping); after the dwell it still needs
      // `commitStreak` consecutive contradictions.
      if (prior.dwell > 0) {
        return {
          optionId: observation.optionId,
          state: 'abandoned',
          streak: prior.streak,
          dwell: prior.dwell - 1,
          contradictions: prior.contradictions,
          decision: 'abandon',
        }
      }
      const contradictions = prior.contradictions + 1
      if (contradictions >= config.commitStreak) return observe(observation.optionId)
      return {
        optionId: observation.optionId,
        state: 'abandoned',
        streak: prior.streak,
        dwell: 0,
        contradictions,
        decision: 'abandon',
      }
    }
  }
}

/** The auditable one-line instrumentation required by #24. */
export function formatBetaHysteresis(state: BetaHysteresisMachineState): string {
  return (
    `BETA_HYSTERESIS optionId=${state.optionId} state=${state.state} ` +
    `streak=${state.streak} dwell=${state.dwell} decision=${state.decision}`
  )
}
