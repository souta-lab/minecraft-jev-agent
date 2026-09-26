// hopPolicy.ts - the localized movement-skill policy for the vertical hop.
//
// Audit docs/history/milestones/M2-HEURISTIC-AUDIT.md: the hop timings (VERTICAL_HOP_RISE_MS/PUSH_MS)
// and the hold-forward choice were implicit executor constants. They are a
// movement RECIPE (TIMEOUT/search class) - allowed, but owned by one policy
// object that can log `{ chosen, rise_ms, push_ms, alternatives, reason }` so
// the skill can be replaced or tuned outside the executor.
//
// The hold-forward half is Minecraft/network truth, not a preference: the Leaf
// server rejects a movement packet that combines a blocked forward push with a
// jump (position teleport), and the movement harness measured rise=0 on 296/296
// released-forward free hops. The policy encodes that rule in one place.

export interface HopPolicy {
  /** jump-hold window before forward is released (ms) */
  riseMs: number
  /** airborne forward-push window after the jump (ms) */
  pushMs: number
}

export const DEFAULT_HOP_POLICY: HopPolicy = {
  riseMs: 180,
  pushMs: 260,
}

export interface HopPlanAlternative {
  option: string
  score: number
  reason: string
}

export interface HopPlan {
  chosen: 'hold-forward' | 'release-forward'
  holdForward: boolean
  /** single deterministic recipe: 1, kept so the decision shape is uniform */
  score: number
  riseMs: number
  pushMs: number
  alternatives: HopPlanAlternative[]
  reason: string
}

/** The vertical-hop body rule: a pinned body releases forward for the pure jump. */
export function hopHoldsForward(pinned: boolean): boolean {
  return !pinned
}

/**
 * Plan one vertical hop for the given body state. The timings are the audited
 * harness recipe; the alternative hold-forward choice is reported with the
 * live evidence that rules it out, once per hop.
 */
export function planVerticalHop(pinned: boolean, policy: HopPolicy = DEFAULT_HOP_POLICY): HopPlan {
  const holdForward = hopHoldsForward(pinned)
  const alternative: HopPlanAlternative = holdForward
    ? { option: 'release-forward', score: 1, reason: 'live released-forward free hop rise=0 on 296/296 attempts' }
    : { option: 'hold-forward', score: 1, reason: 'server rejects a blocked forward push combined with a jump' }
  return {
    chosen: holdForward ? 'hold-forward' : 'release-forward',
    holdForward,
    score: 1,
    riseMs: policy.riseMs,
    pushMs: policy.pushMs,
    alternatives: [alternative],
    reason: holdForward ? 'free_body_holds_forward_through_jump' : 'pinned_body_pure_vertical_jump',
  }
}

/** The one structured decision line; logged once per hop. */
export function formatHopPlan(plan: HopPlan): string {
  const alternatives = plan.alternatives.map((entry) => `${entry.option}@${entry.score}:${entry.reason}`).join(',')
  return `HOP_PLAN chosen=${plan.chosen} score=${plan.score} rise_ms=${plan.riseMs} push_ms=${plan.pushMs} alternatives=[${alternatives}] reason=${plan.reason}`
}
