// descendPlan.ts - Issue #41: make a `descend_to:Y=<n>` predicate goal executable.
//
// The stock generator only offered a DESCEND when the four *cardinal* staircase
// steps were safe and the per-goal no-progress budget had not latched. At y=55
// with the budget latched (or every cardinal step unsafe) that left WAIT as the
// only candidate, so the goal could never reach its target Y and the loop wedged.
//
// This module owns the deterministic, model-free half of the fix:
//
//   1. candidate selection for a predicate descend: prefer an aligned cardinal
//      staircase step, fall back to the bot's own column ("dig down"), and never
//      let a stale failure count suppress the only body change available;
//   2. the Y-progress assertion: the feet Y must keep decreasing, or the caller
//      logs `DESCEND_STALLED` and switches strategy instead of WAITing.
//
// Pure: no bot, no clock. `pickBestDescendStep` is a function of its inputs so
// the candidate rule is unit-testable without a live world.
import type { DescentOption, Vec3Json } from './state.ts'
import { distance } from './state.ts'

/** Ticks a descend goal may make no vertical progress before it is called stalled. */
export const DESCEND_STALL_TICKS_DEFAULT = 20

/**
 * Ticks a descend goal may offer NO executable descend candidate before it is
 * called stalled. Deliberately smaller than the generic WAIT wedge limit so the
 * escalation (and its DESCEND_STALLED log) wins the race against a wedge abort.
 */
export const DESCEND_NO_CANDIDATE_TICKS_DEFAULT = 4

/** `BUDDY_DESCEND_STALL_TICKS` overrides the window; invalid values fall back. */
export function resolveDescendStallTicks(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_DESCEND_STALL_TICKS ?? DESCEND_STALL_TICKS_DEFAULT)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DESCEND_STALL_TICKS_DEFAULT
}

/** `BUDDY_DESCEND_NO_CANDIDATE_TICKS` overrides the no-candidate window. */
export function resolveDescendNoCandidateTicks(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_DESCEND_NO_CANDIDATE_TICKS ?? DESCEND_NO_CANDIDATE_TICKS_DEFAULT)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DESCEND_NO_CANDIDATE_TICKS_DEFAULT
}

/** Log the Y-delta heartbeat at most every N ticks while a descend goal is active. */
export const DESCEND_PROGRESS_LOG_TICKS = 5

export interface DescendProgressState {
  /** best (lowest) feet Y seen so far for the active descend goal */
  bestY: number
  /** consecutive observations without losing a whole block */
  ticks: number
}

export type DescendProgressOutcome = 'progress' | 'tracking' | 'stalled'

export interface DescendProgressDecision extends DescendProgressState {
  outcome: DescendProgressOutcome
}

/**
 * Pure vertical-progress assertion for an active descend predicate. A loss of at
 * least one whole block is `progress`; otherwise the counter advances and
 * `stalled` is emitted once `stallTicks` consecutive observations made no
 * progress. The counter resets on both outcomes so the assertion re-arms.
 */
export function evaluateDescendProgress(input: {
  previous: DescendProgressState
  y: number
  stallTicks: number
}): DescendProgressDecision {
  const { previous, y, stallTicks } = input
  if (y <= previous.bestY - 1) return { bestY: y, ticks: 0, outcome: 'progress' }
  const ticks = previous.ticks + 1
  if (ticks >= stallTicks) return { bestY: previous.bestY, ticks: 0, outcome: 'stalled' }
  return { bestY: previous.bestY, ticks, outcome: 'tracking' }
}

/** The exact log line emitted when a descend goal makes no vertical progress. */
export function formatDescendStalled(y: number, targetY: number, ticks: number): string {
  return `DESCEND_STALLED y=${y} target_y=${targetY} ticks=${ticks}`
}

/** The exact log line emitted on each descent heartbeat: how far Y has moved. */
export function formatDescendProgress(y: number, targetY: number, delta: number, ticks: number): string {
  return `DESCEND_PROGRESS y=${y} target_y=${targetY} delta=${delta} ticks=${ticks}`
}

/** Straight down is the bot's own column: no horizontal offset. */
export function isStraightDown(step: DescentOption): boolean {
  return step.dx === 0 && step.dz === 0
}

export interface DescendScoreInput {
  /** the goal wants to lose altitude (predicate below the bot, or a target below) */
  wantDown: boolean
  hasTunnelTarget: boolean
  /** the active goal is an explicit `descend_to:Y=<n>` predicate */
  predicateDescend: boolean
  /** nearest target resource, used to align the staircase with the ore bearing */
  target: Vec3Json | null
  feet: Vec3Json
}

/**
 * Score one descent step: lower is better. A downward step wins when the goal
 * wants altitude loss; alignment toward the target resource is a bonus; the
 * bot's own column (straight down) carries a small penalty so a diagonal
 * staircase is preferred whenever one is safe.
 */
export function scoreDescendStep(step: DescentOption, input: DescendScoreInput): number {
  const modePenalty =
    step.mode === 'down'
      ? input.wantDown
        ? 0
        : 2
      : input.wantDown && (input.hasTunnelTarget || input.predicateDescend)
        ? 2
        : 0
  let alignment = 0
  if (input.target !== null) {
    const tdx = input.target.x - input.feet.x
    const tdz = input.target.z - input.feet.z
    const dot = step.dx * Math.sign(tdx) + step.dz * Math.sign(tdz)
    alignment = dot > 0 ? -1 : dot < 0 ? 1 : 0
  }
  const straightPenalty = isStraightDown(step) ? 1 : 0
  return modePenalty * 10 + alignment * 4 + straightPenalty + distance(step.step, input.feet) * 0.1
}

/**
 * Pick the best step from an already-safe pool. Returns null on an empty pool.
 * Eligibility (down vs level, fixed direction, oscillation) is decided by the
 * caller's pool; this function only ranks. Pure: same input -> same step.
 */
export function pickBestDescendStep(
  steps: readonly DescentOption[],
  input: DescendScoreInput,
): DescentOption | null {
  let best: DescentOption | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const step of steps) {
    const score = scoreDescendStep(step, input)
    if (score < bestScore) {
      bestScore = score
      best = step
    }
  }
  return best
}
