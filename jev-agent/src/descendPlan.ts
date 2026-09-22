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
//      logs `DESCEND_STALLED` and switches strategy instead of WAITing;
//   3. the HEADING PLAN of a running descent: one heading is held for as long as
//      the world offers a safe step under it, and a change is a typed event with
//      the concrete obstruction that forced it. Measured live
//      (run-muc3qbug-18vg3, main ab19403) the last 60 descend steps were
//      `W 23 | E 17 | N 12 | S 8`: every tick re-picked a heading because the
//      only memory of a chosen heading was a successful-completion record and
//      the pool silently widened whenever that heading had no safe step. The
//      result was a winding one-block-per-level bowl instead of a staircase.
//
// Pure: no bot, no clock. `pickBestDescendStep` and `resolveDescentHeading` are
// functions of their inputs so the candidate rules are unit-testable without a
// live world.
import type { DescentDir, DescentOption, DescentRefusalReason, Vec3Json } from './state.ts'
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

/**
 * Why a held heading could not be continued. The sensor's typed refusal when the
 * world itself obstructs the step, or `no_step` when the heading has no option in
 * the current pool at all. This is the ONLY licence to change the plan heading.
 */
export type DescentHeadingChangeReason = DescentRefusalReason | 'no_step' | 'oscillation' | 'cap'

/** A typed heading change: the obstruction that forced it, with its world cell. */
export interface DescentHeadingChange {
  from: DescentDir
  to: DescentDir
  reason: DescentHeadingChangeReason
  /** the refused cell of the abandoned heading, null when geometrically absent */
  cell: Vec3Json | null
  /** the block that obstructed it, null when unknown */
  block: string | null
}

export type DescentHeadingStatus = 'new' | 'held' | 'changed'

export interface DescentHeadingPlan {
  /** the heading this step belongs to (held when the plan could continue) */
  dir: DescentDir
  status: DescentHeadingStatus
  /** the plan heading before this step, null when the plan just started */
  from: DescentDir | null
  /** non-null exactly when `status === 'changed'` */
  change: DescentHeadingChange | null
}

/** The concrete obstruction of a heading, read from the sensor's refused option. */
export interface DescentHeadingObstruction {
  reason: DescentHeadingChangeReason
  cell: Vec3Json | null
  block: string | null
}

/**
 * Resolve the heading of the next descent step.
 *
 * The rule is deliberately not a score: while the world offers ANY safe step
 * under the previous heading, that heading is held (`held`, no change event).
 * Only when the previous heading has no safe/eligible step does the plan move to
 * another heading, and that move carries the typed obstruction that caused it -
 * so a heading change can always be attributed to a world fact instead of a
 * silent re-pick. `null` previous means the plan is starting and the caller's
 * existing selection rule (score, then deterministic scan order) owns the first
 * heading.
 */
export function resolveDescentHeading(input: {
  previous: DescentDir | null
  /** headings with at least one safe, eligible step this tick, in pool order */
  available: readonly DescentDir[]
  /** why the previous heading is unavailable (only read when it is) */
  obstruction: DescentHeadingObstruction | null
}): DescentHeadingPlan | null {
  const first = input.available[0]
  if (first === undefined) return null
  if (input.previous === null) return { dir: first, status: 'new', from: null, change: null }
  if (input.available.includes(input.previous)) {
    return { dir: input.previous, status: 'held', from: input.previous, change: null }
  }
  const obstruction = input.obstruction ?? { reason: 'no_step', cell: null, block: null }
  return {
    dir: first,
    status: 'changed',
    from: input.previous,
    change: {
      from: input.previous,
      to: first,
      reason: obstruction.reason,
      cell: obstruction.cell,
      block: obstruction.block,
    },
  }
}

/** The exact `DESCEND_HEADING` line: the plan heading of the step about to run. */
export function formatDescentHeading(plan: DescentHeadingPlan): string {
  const held = plan.status === 'held' || plan.status === 'new'
  const change =
    plan.change === null
      ? ''
      : ` from=${plan.change.from} reason=${plan.change.reason}` +
        `${plan.change.cell === null ? '' : ` cell=${plan.change.cell.x},${plan.change.cell.y},${plan.change.cell.z}`}` +
        `${plan.change.block === null ? '' : ` block=${plan.change.block}`}`
  return `DESCEND_HEADING dir=${plan.dir} held=${held}${change}`
}

/**
 * The obstruction of one heading, from the sensor's full option list (safe AND
 * refused). A refused step carries `refusal` + the human-readable `reason`; the
 * dig cell is the step's primary cell. Pure.
 */
export function descentHeadingObstruction(
  steps: readonly DescentOption[],
  dir: DescentDir,
): DescentHeadingObstruction {
  const candidates = steps.filter((step) => step.dir === dir)
  if (candidates.length === 0) return { reason: 'no_step', cell: null, block: null }
  const refused = candidates.find((step) => !step.safe)
  if (refused === undefined) return { reason: 'no_step', cell: null, block: null }
  const cell = refused.mode === 'down' ? refused.floor : (refused.wallSolid ? refused.wall : refused.head)
  return {
    reason: refused.refusal ?? 'no_step',
    cell,
    block: refused.digName ?? null,
  }
}
