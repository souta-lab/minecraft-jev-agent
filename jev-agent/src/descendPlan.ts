// descendPlan.ts - Issue #41: make a `descend_to:Y=<n>` predicate goal executable.
//
// The stock generator only offered a DESCEND when the four *cardinal* staircase
// steps were safe and the per-goal no-progress budget had not latched. At y=55
// with the budget latched (or every cardinal step unsafe) that left WAIT as the
// only candidate, so the goal could never reach its target Y and the loop wedged.
//
// This module owns only pure progress and obstruction facts. Grounded recovery
// alternatives are enumerated in candidates.ts and semantic choice stays with
// Jev; this module does not rank descent modes or pick a replacement heading.
//
// A running Skill may keep its selected heading while an equivalent safe step is
// available. When that contract cannot continue, candidate generation reports
// the typed obstruction and returns materially distinct grounded alternatives.
// Pure: no bot, no clock.
import type { DescentDir, DescentOption, DescentRefusalReason, Vec3Json } from './state.ts'

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

/**
 * Why a held heading could not be continued. The sensor's typed refusal when the
 * world itself obstructs the step, or `no_step` when the heading has no option in
 * the current pool at all. This is the ONLY licence to change the plan heading.
 */
export type DescentHeadingChangeReason = DescentRefusalReason | 'no_step' | 'oscillation' | 'cap' | 'budget'

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
/** The exact `DESCEND_HEADING` line: the heading of the selected candidate. */
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
