// betaAuthority.ts - correctness gate for the `abandon_option` beta vote (#22).
//
// Issue #22 (and #24) require beta to be SHADOW-ONLY until calibration data
// justifies giving it authority. This module is the single place that decides
// whether a raw beta crossing may drive a replan:
//
//   * beta is always RECORDED (BETA_SHADOW), never silently discarded;
//   * with `betaAuthority: false` (the default) beta CANNOT replan/abandon,
//     regardless of how high the probability is;
//   * with `betaAuthority: true` beta may replan, but only when the existing
//     deterministic prerequisite guard (#46/#55) clears it.
//
// Pure and bot-free so the shadow/authority split and the heads line are
// unit-testable without a live controller.
import { prerequisiteProtection } from './placementGuard.ts'
import type { GoalLike, PrerequisiteProtection } from './placementGuard.ts'

export interface BetaAuthorityInput {
  /** explicit opt-in; false keeps beta shadow-only (the #22 default) */
  betaAuthority: boolean
  /** did the raw beta probability cross its named threshold? (`abandonRequested`) */
  abandonRequested: boolean
  /** grounded action id the beta vote was conditioned on. */
  actionId: string | null
  /** active/unfinished goals, for the prerequisite protection check. */
  goals: readonly GoalLike[]
  /** how many furnaces are placed right now, for the protection check. */
  placedFurnaceCount: number
}

export interface BetaAuthorityDecision {
  /** true only when beta has authority AND the deterministic guard clears it. */
  adopt: boolean
  /** true when beta voted abandon but shadow mode suppressed it (record-only). */
  shadowed: boolean
  /** deterministic prerequisite protection, always evaluated for logging. */
  protection: PrerequisiteProtection
}

/**
 * The one gate between the beta vote and a replan. Shadow mode (the default)
 * returns `adopt: false` unconditionally; authority mode still defers to the
 * prerequisite guard, so a β=1 can never discard `PLACE:furnace`.
 */
export function betaAuthorityDecision(input: BetaAuthorityInput): BetaAuthorityDecision {
  const protection = prerequisiteProtection({
    actionId: input.actionId,
    goals: input.goals,
    placedFurnaceCount: input.placedFurnaceCount,
  })
  if (!input.abandonRequested) return { adopt: false, shadowed: false, protection }
  if (!input.betaAuthority) return { adopt: false, shadowed: true, protection }
  return { adopt: !protection.protect, shadowed: false, protection }
}

/**
 * `JEV_HEADS action=<id> abandon=<p> -> <replan|continue>`. The decision shown
 * is the controller's ACTUAL decision: in shadow mode a β=1 reports `continue`,
 * so an audit cannot mistake the vote for an abandonment.
 */
export function formatJevHeads(action: string, abandon: number | null, adopt: boolean): string {
  return `JEV_HEADS action=${action} abandon=${abandon ?? 'null'} -> ${adopt ? 'replan' : 'continue'}`
}
