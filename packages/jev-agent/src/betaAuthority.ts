// betaAuthority.ts - the gate between the `abandon_option` beta vote and a replan.
//
// The decision policy's vote to end the current Option is policy input: it may
// drive a replan only when the deterministic prerequisite guard (#46/#55)
// clears it, so a beta=1 can never discard a protected prerequisite such as
// `PLACE:furnace`. The vote is always recorded; it never terminates a kernel
// transition or declares SUCCESS. There is no shadow/authority selector.
//
// Pure and bot-free so the gate and the heads line are unit-testable.
import { prerequisiteProtection } from './placementGuard.ts'
import type { GoalLike, PrerequisiteProtection } from './placementGuard.ts'

export interface BetaAuthorityInput {
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
  /** true only when beta voted abandon AND the deterministic guard clears it. */
  adopt: boolean
  /** deterministic prerequisite protection, always evaluated for logging. */
  protection: PrerequisiteProtection
}

/**
 * The one gate between the beta vote and a replan: it defers to the
 * prerequisite guard, so a β=1 can never discard `PLACE:furnace`.
 */
export function betaAuthorityDecision(input: BetaAuthorityInput): BetaAuthorityDecision {
  const protection = prerequisiteProtection({
    actionId: input.actionId,
    goals: input.goals,
    placedFurnaceCount: input.placedFurnaceCount,
  })
  if (!input.abandonRequested) return { adopt: false, protection }
  return { adopt: !protection.protect, protection }
}

/**
 * `JEV_HEADS action=<id> abandon=<p> -> <replan|continue>`. The decision shown
 * is the controller's ACTUAL decision (a guard-protected β=1 reports
 * `continue`), so an audit cannot mistake the vote for an abandonment.
 */
export function formatJevHeads(action: string, abandon: number | null, adopt: boolean): string {
  return `JEV_HEADS action=${action} abandon=${abandon ?? 'null'} -> ${adopt ? 'replan' : 'continue'}`
}
