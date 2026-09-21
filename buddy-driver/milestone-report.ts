// milestone-report.ts - what the control socket's `milestone` reply advertises.
//
// The reply is served by the HOST (`agent-runner.mts`), but the frontier that
// owns what is outstanding work lives in the reloadable generation. This module
// is the one pure seam between the two, so the reply shape is testable without
// importing the host script.
//
// Live defect (run-mubhn83u, source 0ffa709): the M2 gate was lit and verified
// and the frontier had advanced past the iron rungs, yet the reply still read
// `{"milestone":"blaze_rods","milestoneIndex":14,"goalItem":"iron_ingot",
// "goalCount":3}` - the host's static `GOAL_ITEM`/`GOAL_COUNT` constants. The
// generation's own frontier projection was already correct in the same process:
// `ROOT_GOAL_PROJECTED source=ladder-frontier goalItem=obsidian goalCount=10
// legacyGoalItem=iron_ingot legacyGoalCount=3 rungId=nether_portal`. The scalar
// therefore advertised a satisfied rung as work that must be done while the
// resident was descending for `raw_iron` it no longer needed.
import type { GenerationStatus } from './resident-types.ts'
import type { GoalQueueSnapshot } from '../jev-agent/src/goalQueue.ts'

/**
 * The legacy root goal a frontier projects: the first item-bearing goal of the
 * rung(s) the frontier still has ahead, else the caller's fallback.
 */
export function projectedRootGoal(
  status: Pick<GenerationStatus, 'goalItem' | 'goalCount'> | null | undefined,
  fallback: { goalItem: string; goalCount: number },
): { goalItem: string; goalCount: number } {
  const item = status?.goalItem
  const count = status?.goalCount
  if (typeof item !== 'string' || item.length === 0) return fallback
  if (typeof count !== 'number' || !Number.isFinite(count)) return fallback
  return { goalItem: item, goalCount: Math.max(1, Math.floor(count)) }
}

export interface MilestoneReport {
  milestone: string | null
  milestoneIndex: number
  /** frontier-projected goal, never a stale historical mission scalar */
  goalItem: string
  goalCount: number
  ledgerMirror: GoalQueueSnapshot | null
}

/**
 * The complete `milestone` / `goal` control reply payload. `status` is the live
 * generation's last reported status (null before the first observation tick or
 * before the frontier can project a goal), in which case the caller's fallback
 * is the only truthful value available.
 */
export function milestoneReport(args: {
  milestone: string | null
  milestoneIndex: number
  ledgerMirror: GoalQueueSnapshot | null
  status: Pick<GenerationStatus, 'goalItem' | 'goalCount'> | null | undefined
  fallback: { goalItem: string; goalCount: number }
}): MilestoneReport {
  const rootGoal = projectedRootGoal(args.status, args.fallback)
  return {
    milestone: args.milestone,
    milestoneIndex: args.milestoneIndex,
    goalItem: rootGoal.goalItem,
    goalCount: rootGoal.goalCount,
    ledgerMirror: args.ledgerMirror,
  }
}
