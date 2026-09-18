// replanThrottle.ts - issue #44: bound the exception-driven replan rate.
//
// The #43 WAIT bound replaced an infinite WAIT loop with a replan loop: every
// WAIT_LIMIT woke System 2, which re-emitted the SAME blocked plan, which WAITed
// again, until the wedge counter restarted the generation (measured 27
// GENERATION_START / 5 min). The bug is not the bound, it is that a replan was
// allowed with no new information and produced no body change.
//
// This module is the deterministic, pure rule set:
//
//   1. THROTTLE   - at most one replan per `reason` per window (default 10 s);
//                   a same-reason call inside the window is refused and the
//                   caller reuses the current plan (`REPLAN_THROTTLED`).
//   2. NEW INFO   - even after the window, a replan needs a changed input:
//                   inventory delta, position delta beyond a threshold, a new
//                   known resource, or a different failure signature.
//   3. BODY DELTA - a replacement plan must contain at least one `collect` /
//                   `explore` goal that changes the resource source versus the
//                   blocked goal; otherwise the caller rejects it
//                   (`REPLAN_REJECTED no_body_delta`) and keeps the plan.
//
// No imports from the controller, no bot, no clock: `now` is injected, so the
// whole policy is unit-testable.
import { createHash } from 'node:crypto'

export const REPLAN_THROTTLE_WINDOW_MS_DEFAULT = 10_000
export const REPLAN_POSITION_DELTA_DEFAULT = 2

/** `BUDDY_REPLAN_THROTTLE_MS` overrides the window; invalid values fall back. */
export function resolveReplanThrottleMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = Number(env.BUDDY_REPLAN_THROTTLE_MS ?? REPLAN_THROTTLE_WINDOW_MS_DEFAULT)
  return Number.isFinite(raw) && raw >= 0 ? raw : REPLAN_THROTTLE_WINDOW_MS_DEFAULT
}

/** `BUDDY_REPLAN_POSITION_DELTA` overrides the block threshold; invalid values fall back. */
export function resolveReplanPositionDelta(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = Number(env.BUDDY_REPLAN_POSITION_DELTA ?? REPLAN_POSITION_DELTA_DEFAULT)
  return Number.isFinite(raw) && raw >= 0 ? raw : REPLAN_POSITION_DELTA_DEFAULT
}

export interface ReplanPosition {
  x: number
  y: number
  z: number
}

/** The inputs a replan claims changed. Everything here is cheap and already live. */
export interface ReplanInputs {
  inventory: Record<string, number>
  position: ReplanPosition | null
  knownResources: number
  failureSignature: string
  /**
   * M2 capability trap: a signature while the pure `evaluateCapabilityGap`
   * predicate proves the agent cannot ascend to its remembered target, else
   * null. A capability gap is information the throttle must not swallow.
   */
  capabilityGap: string | null
}

/** Canonical, order-independent inventory signature (counts > 0 only). */
export function inventorySignature(inventory: Record<string, number>): string {
  return Object.entries(inventory)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}=${count}`)
    .join(',')
}

/** Stable stateHash for a (reason, inputs) throttle key. */
export function hashReplanInputs(inputs: ReplanInputs): string {
  const payload = {
    inventory: inventorySignature(inputs.inventory),
    position:
      inputs.position === null
        ? null
        : `${Math.round(inputs.position.x)},${Math.round(inputs.position.y)},${Math.round(inputs.position.z)}`,
    knownResources: inputs.knownResources,
    failures: inputs.failureSignature,
    capabilityGap: inputs.capabilityGap,
  }
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
}

function movedBeyond(a: ReplanPosition | null, b: ReplanPosition | null, threshold: number): boolean {
  if (a === null || b === null) return a !== b
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz) > threshold
}

/** True when any input that could justify a different plan changed. */
export function replanInputsChanged(
  previous: ReplanInputs,
  current: ReplanInputs,
  positionDelta = REPLAN_POSITION_DELTA_DEFAULT,
): boolean {
  if (current.capabilityGap !== null) return true
  if (previous.capabilityGap !== current.capabilityGap) return true
  if (inventorySignature(previous.inventory) !== inventorySignature(current.inventory)) return true
  if (previous.knownResources !== current.knownResources) return true
  if (previous.failureSignature !== current.failureSignature) return true
  return movedBeyond(previous.position, current.position, positionDelta)
}

export type ReplanThrottleKind = 'fresh' | 'new_info' | 'window' | 'no_new_info'

export interface ReplanThrottleDecision {
  allow: boolean
  kind: ReplanThrottleKind
  ageMs: number
  stateHash: string
}

interface ThrottleRecord {
  at: number
  inputs: ReplanInputs
  stateHash: string
}

function cloneInputs(inputs: ReplanInputs): ReplanInputs {
  return {
    inventory: { ...inputs.inventory },
    position: inputs.position === null ? null : { ...inputs.position },
    knownResources: inputs.knownResources,
    failureSignature: inputs.failureSignature,
    capabilityGap: inputs.capabilityGap,
  }
}

/** The exact log line the controller emits so log evidence and tests agree. */
export function formatReplanThrottled(reason: string, decision: ReplanThrottleDecision): string {
  return `REPLAN_THROTTLED reason=${reason} ageMs=${decision.ageMs} -> reuse plan`
}

/**
 * Bounded replan rate. Keyed by summon `reason`; the recorded `stateHash`
 * (inventory + position + known resources + failure signature) is what the
 * acceptance means by `(reason, stateHash)`.
 */
export class ReplanThrottle {
  private readonly windowMs: number
  private readonly positionDelta: number
  private readonly records = new Map<string, ThrottleRecord>()

  constructor(windowMs: number = REPLAN_THROTTLE_WINDOW_MS_DEFAULT, positionDelta: number = REPLAN_POSITION_DELTA_DEFAULT) {
    this.windowMs = windowMs
    this.positionDelta = positionDelta
  }

  /** Query without recording. Never mutates. */
  check(reason: string, inputs: ReplanInputs, now = Date.now()): ReplanThrottleDecision {
    const stateHash = hashReplanInputs(inputs)
    const previous = this.records.get(reason)
    if (previous === undefined) return { allow: true, kind: 'fresh', ageMs: 0, stateHash }
    const ageMs = now - previous.at
    if (!replanInputsChanged(previous.inputs, inputs, this.positionDelta)) {
      return { allow: false, kind: 'no_new_info', ageMs, stateHash }
    }
    if (ageMs < this.windowMs) return { allow: false, kind: 'window', ageMs, stateHash }
    return { allow: true, kind: 'new_info', ageMs, stateHash }
  }

  /** Record that a replan happened at `now`. */
  record(reason: string, inputs: ReplanInputs, now = Date.now()): void {
    this.records.set(reason, { at: now, inputs: cloneInputs(inputs), stateHash: hashReplanInputs(inputs) })
  }

  /** Allow-and-record in one step: the controller's entry point. */
  tryReplan(reason: string, inputs: ReplanInputs, now = Date.now()): ReplanThrottleDecision {
    const decision = this.check(reason, inputs, now)
    if (decision.allow) this.record(reason, inputs, now)
    return decision
  }

  reset(): void {
    this.records.clear()
  }
}

export interface GoalLike {
  kind: string
  targetItem?: string | null
  requiredCount?: number
}

/**
 * Issue #44 requirement 3: a replacement plan must change the body. A
 * `collect` of a different resource than the blocked goal, or an `explore`
 * goal, changes position / resource source (descent, branch mine, retrieval,
 * surface trip). A stationary craft/smelt/place of the same target does not.
 * Exposed as a pure predicate so the planner and its tests share one rule.
 */
export function hasBodyDelta(planned: readonly GoalLike[], current: GoalLike | null): boolean {
  if (planned.length === 0) return false
  if (current === null) return true
  const currentItem = current.targetItem ?? null
  return planned.some((goal) => {
    if (goal.kind === 'explore') return true
    if (goal.kind === 'descend') return true
    if (goal.kind === 'place') return true
    if (goal.kind === 'surface') return true
    if (goal.kind !== 'collect') return false
    const item = goal.targetItem ?? null
    if (item === null) return false
    return item !== currentItem
  })
}

/**
 * M2 capability trap: the pure, deterministic rule that says "this is not a
 * movement problem any more". It is the truth owner for the trap; the retry /
 * score fields are a localized policy (heuristic-authority rule).
 */
export interface CapabilityGapPolicy {
  /** how far above the live feet a remembered target must be to count as an ascent */
  minClimbBlocks: number
  /** bounded observation window, in decision ticks */
  windowTicks: number
  /** altitude gain at or below this does not count as progress */
  altitudeEpsilon: number
  /** refused ascend attempts within the window that make the gap fire */
  minAscendRefusals: number
}

export const DEFAULT_CAPABILITY_GAP_POLICY: CapabilityGapPolicy = {
  minClimbBlocks: 8,
  windowTicks: 40,
  altitudeEpsilon: 0.9,
  minAscendRefusals: 3,
}

export interface CapabilityGapState {
  /** remembered target the window is tracking; a new target restarts the window */
  targetKey: string
  /** feet y when the window opened */
  startY: number
  /** highest feet y seen inside the window */
  bestY: number
  /** decision ticks observed inside the window */
  ticks: number
  /** refused ascend attempts observed inside the window */
  ascendRefusals: number
}

export interface CapabilityGapObservation {
  y: number
  targetY: number | null
  targetKey: string | null
  /** an ascend attempt was refused since the previous observation */
  ascendRefused: boolean
}

export interface CapabilityGapDecision {
  gap: boolean
  attempts: number
  targetY: number | null
  reason: 'ascend_blocked' | null
  state: CapabilityGapState | null
}

/** Exact marker the controller emits when the pure predicate fires. */
export function formatCapabilityGap(decision: CapabilityGapDecision): string {
  return `CAPABILITY_GAP reason=ascend_blocked attempts=${decision.attempts} target_y=${Math.round(decision.targetY ?? 0)}`
}

export const CAPABILITY_GAP_MARKER = 'CAPABILITY_GAP'

export interface CapabilityGapSignal {
  attempts: number
  targetY: number | null
}

/** Read the newest capability-gap marker out of a recent-events window, or null. */
export function parseCapabilityGap(events: readonly string[]): CapabilityGapSignal | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const line = events[index]
    if (line === undefined || !line.startsWith(`${CAPABILITY_GAP_MARKER} `)) continue
    const attempts = /attempts=(\d+)/.exec(line)
    const targetY = /target_y=(-?\d+)/.exec(line)
    return {
      attempts: attempts === null ? 0 : Number(attempts[1]),
      targetY: targetY === null ? null : Number(targetY[1]),
    }
  }
  return null
}

/**
 * Bounded-window trap detector. Fires only when a remembered target sits
 * `minClimbBlocks` above the agent, the window never gained altitude, AND at
 * least `minAscendRefusals` ascend attempts were refused. Any real altitude gain
 * or reaching the target restarts the window, so normal movement never fires it.
 */
export function evaluateCapabilityGap(
  previous: CapabilityGapState | null,
  observation: CapabilityGapObservation,
  policy: CapabilityGapPolicy = DEFAULT_CAPABILITY_GAP_POLICY,
): CapabilityGapDecision {
  const { y, targetY, targetKey } = observation
  if (targetY === null || targetKey === null || targetY - y < policy.minClimbBlocks) {
    return { gap: false, attempts: 0, targetY, reason: null, state: null }
  }
  const restart = previous === null || previous.targetKey !== targetKey
  const startY = restart ? y : previous.startY
  const bestY = restart ? y : Math.max(previous.bestY, y)
  const ticks = (restart ? 0 : previous.ticks) + 1
  const ascendRefusals = (restart ? 0 : previous.ascendRefusals) + (observation.ascendRefused ? 1 : 0)
  if (bestY - startY > policy.altitudeEpsilon || y >= targetY) {
    return { gap: false, attempts: 0, targetY, reason: null, state: { targetKey, startY: y, bestY: y, ticks: 0, ascendRefusals: 0 } }
  }
  const state: CapabilityGapState = { targetKey, startY, bestY, ticks, ascendRefusals }
  const gap = ticks >= policy.windowTicks && ascendRefusals >= policy.minAscendRefusals
  return { gap, attempts: ascendRefusals, targetY, reason: gap ? 'ascend_blocked' : null, state }
}
