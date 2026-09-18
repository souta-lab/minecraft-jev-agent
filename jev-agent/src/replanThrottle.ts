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
    if (goal.kind !== 'collect') return false
    const item = goal.targetItem ?? null
    if (item === null) return false
    return item !== currentItem
  })
}
