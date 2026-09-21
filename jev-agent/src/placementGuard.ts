// placementGuard.ts - M2 furnace-placement protection, bounded retry, and
// one-line abandon reasons (issues #43/#46, TODO "replan must not discard
// protected/prerequisite goals").
//
// Measured 2026-09-18 08:35 JST: the preferred smelt (`smelt 3 x iron_ingot`)
// had every input held (furnace:1, raw_iron:8, coal:7, cobblestone:112), its
// only unmet precondition was "a placed furnace", and the controller's beta
// abandon vote replanned away from `PLACE:furnace` instead of placing it - so
// FURNACE_READY never fired and the smelt could never run.
//
// A required precondition is NOT an option the model may give up: it is
// deterministic code (AGENTS.md section 8). This module is pure and
// bot-free so the protection, the retry bound and the abandon classification
// are unit-testable in isolation.
import type { Vec3Json } from './state.ts'

/** Bounded placement retries at nearby spots before the option may be abandoned. */
export const PLACE_RETRY_LIMIT = 5

/** The smelt whose placed-furnace precondition is protected. */
export const PROTECTED_SMELT_ITEM = 'iron_ingot'

export type AbandonReason = 'β' | 'no_progress' | 'unreachable' | 'blocked'

/** The minimal goal shape the guard needs (a QueuedGoal or a PlannedGoal). */
export interface GoalLike {
  kind?: string
  targetItem?: string | null
}

export interface PrerequisiteProtection {
  /** true when this option must not be abandoned/replanned away right now. */
  protect: boolean
  /** stable option name for the one-line audit log (e.g. `PLACE:furnace`). */
  option: string
  because: string
  /** the full `PRECONDITION_PROTECTED ...` line. */
  line: string
}

/**
 * Stable option name stripped of its grounded target, so the audit line is
 * `option=PLACE:furnace` even when the grounded candidate is
 * `PLACE:furnace:p29_61_35`.
 */
export function prerequisiteOptionName(actionId: string): string {
  if (actionId.startsWith('PLACE:furnace')) return 'PLACE:furnace'
  if (actionId.startsWith('CRAFT:furnace')) return 'CRAFT:furnace'
  if (actionId.startsWith('RETRIEVE:known:station:furnace')) return 'RETRIEVE:known:station:furnace'
  if (actionId.startsWith('PLACE:crafting_table')) return 'PLACE:crafting_table'
  return actionId
}

/**
 * True for the grounded options that exist solely to satisfy the smelt's
 * "placed furnace" precondition: crafting the furnace, placing a held one,
 * returning to a remembered one, or placing the held crafting table the craft
 * step needs when no table is in reach.
 */
export function isFurnacePrerequisiteOption(actionId: string | null): boolean {
  if (actionId === null) return false
  return (
    actionId.startsWith('PLACE:furnace') ||
    actionId.startsWith('CRAFT:furnace') ||
    actionId.startsWith('RETRIEVE:known:station:furnace') ||
    actionId.startsWith('PLACE:crafting_table')
  )
}

/** True when the active goal is the preferred smelt and no furnace is placed yet. */
export function smeltPrerequisiteTarget(goals: readonly GoalLike[], placedFurnaceCount: number): string | null {
  if (placedFurnaceCount > 0) return null
  const smelts = goals.filter(
    (goal) => goal.kind === 'smelt' && typeof goal.targetItem === 'string' && goal.targetItem.length > 0,
  )
  if (smelts.length === 0) return null
  const iron = smelts.find((goal) => goal.targetItem === PROTECTED_SMELT_ITEM)
  return (iron ?? smelts[0])?.targetItem ?? null
}

export function formatPreconditionProtected(option: string, because: string): string {
  return `PRECONDITION_PROTECTED option=${option} because=${because}`
}

/**
 * The deterministic guard: may this placement be abandoned right now? The
 * furnace option is protected whenever an unfinished smelt goal still needs a
 * placed furnace - whether the smelt is the queue head or sits behind the
 * place/craft prerequisite (the measured live shape).
 */
export function prerequisiteProtection(input: {
  actionId: string | null
  goals: readonly GoalLike[]
  placedFurnaceCount: number
}): PrerequisiteProtection {
  const option = input.actionId === null ? 'none' : prerequisiteOptionName(input.actionId)
  const target = smeltPrerequisiteTarget(input.goals, input.placedFurnaceCount)
  const protect = isFurnacePrerequisiteOption(input.actionId) && target !== null
  const because = target === null ? 'prerequisite_of none' : `prerequisite_of smelt_${target}`
  return { protect, option, because, line: formatPreconditionProtected(option, because) }
}

export interface AbandonGuardInput {
  actionId: string | null
  goals: readonly GoalLike[]
  placedFurnaceCount: number
  abandonRequested: boolean
}

export interface AbandonGuardDecision {
  /** true when the controller may adopt the abandon and replan. */
  adopt: boolean
  protection: PrerequisiteProtection
}

/** Combine the beta abandon vote with the deterministic prerequisite protection. */
export function shouldAdoptAbandon(input: AbandonGuardInput): AbandonGuardDecision {
  const protection = prerequisiteProtection({
    actionId: input.actionId,
    goals: input.goals,
    placedFurnaceCount: input.placedFurnaceCount,
  })
  return { adopt: input.abandonRequested && !protection.protect, protection }
}

/**
 * Why beta/controller chose abandon. `unreachable` and `blocked` are read from
 * the deterministic failure signals; otherwise it is beta's own vote, or the
 * progress-stall escalation that fed it.
 */
export function classifyAbandonReason(input: {
  beta: number | null
  lastFailureCode: string | null
  candidateFailures: number
  escalationRecommended: boolean
}): AbandonReason {
  if (input.lastFailureCode === 'path_no_path' || input.lastFailureCode === 'path_stuck') return 'unreachable'
  if (input.candidateFailures > 0) return 'blocked'
  if (input.escalationRecommended) return 'no_progress'
  return 'β'
}

export function formatAbandonReason(option: string, reason: AbandonReason): string {
  return `ABANDON_REASON option=${option} reason=${reason}`
}

/** The smelt actually opened a usable furnace; `source` proves held vs remembered. */
export function formatFurnaceReady(source: string, at: Vec3Json): string {
  return `FURNACE_READY source=${source} at=${at.x},${at.y},${at.z}`
}

/**
 * Typed retirement marker for the bounded-attempt contract. `PLACE_RETRY` is a
 * counter line; `PLACE_RETRIES_EXHAUSTED` is the terminal line that proves the
 * option/candidate was actually retired instead of being re-offered forever.
 * Measured live 2026-09-21 (gen-mubgovmf-x6b5rr): `PLACE_RETRY ... limit=5`
 * reached `count=18` because the counter kept advancing past the bound and no
 * layer retired the candidate (`PLACE:obsidian:build:4@p26_66_9`).
 */
export const PLACE_RETRIES_EXHAUSTED = 'PLACE_RETRIES_EXHAUSTED'

export function formatPlaceRetry(at: Vec3Json, reason: string): string {
  return `PLACE_RETRY at=${at.x},${at.y},${at.z} reason=${reason}`
}

/** One retire line per exhausted candidate/option, never per retry. */
export function formatPlaceRetriesExhausted(input: {
  at: Vec3Json
  actionId: string
  item: string | null
  count: number
  limit: number
  reason: string
}): string {
  const item = input.item ?? 'unknown'
  return `${PLACE_RETRIES_EXHAUSTED} at=${input.at.x},${input.at.y},${input.at.z} item=${item} count=${input.count}/${input.limit} actionId=${input.actionId} reason=${input.reason} -> retire candidate`
}

export interface PlaceRetryDecision {
  /** true while the placement may be retried at a nearby spot. */
  retry: boolean
  /**
   * true on the first decision past the bound. The caller MUST retire the
   * candidate/option here; otherwise the counter is advisory and the contract
   * is not enforced.
   */
  exhausted: boolean
  /**
   * 1-based retry ordinal. Clamped at `limit + 1` so a retired family cannot
   * keep counting to 18 (or beyond) after it should have stopped.
   */
  count: number
  limit: number
  line: string
  /** `PLACE_RETRIES_EXHAUSTED ...` when exhausted, null while retrying. */
  exhaustedLine: string | null
}

/**
 * Bound the placement retries: a failed placement at one spot relocates and
 * retries at another, and only after `limit` retries may the option be
 * abandoned. Requirement 2 of the M2 blocker.
 */
export function evaluatePlaceRetry(input: {
  at: Vec3Json
  reason: string
  priorRetries: number
  limit?: number
  actionId?: string
  item?: string | null
}): PlaceRetryDecision {
  const limit = input.limit ?? PLACE_RETRY_LIMIT
  const retry = input.priorRetries < limit
  const exhausted = !retry
  const count = Math.min(input.priorRetries + 1, limit + 1)
  return {
    retry,
    exhausted,
    count,
    limit,
    line: formatPlaceRetry(input.at, input.reason),
    exhaustedLine: exhausted
      ? formatPlaceRetriesExhausted({
          at: input.at,
          actionId: input.actionId ?? 'unknown',
          item: input.item ?? null,
          count,
          limit,
          reason: input.reason,
        })
      : null,
  }
}

/**
 * The bounded-attempt ledger for placement families. It owns the whole contract
 * in ONE place so `PLACE_RETRY` (still retrying) and
 * `PLACE_RETRIES_EXHAUSTED` (retired) cannot diverge:
 *
 *  - counts are per item (a failed spot relocates and retries the same item);
 *  - counts clamp at `limit + 1`, so the ordinal cannot grow past the bound;
 *  - the first past-bound failure retires the item family AND the exact
 *    candidate id, and returns the retire line exactly once;
 *  - a verified placement clears both the counter and the retirement, so a
 *    later legitimate attempt for the same item is not permanently blocked.
 */
export class PlaceRetryLedger {
  private readonly limit: number
  private readonly counts = new Map<string, number>()
  private readonly retiredItems = new Set<string>()
  private readonly retiredActions = new Set<string>()
  private readonly announced = new Set<string>()

  constructor(limit: number = PLACE_RETRY_LIMIT) {
    this.limit = Number.isInteger(limit) && limit >= 1 ? limit : PLACE_RETRY_LIMIT
  }

  /** Record one failed placement attempt and return the bounded decision. */
  noteFailure(input: {
    item: string | null
    actionId: string
    at: Vec3Json
    reason: string
  }): PlaceRetryDecision & { actionId: string; item: string | null } {
    const key = input.item ?? input.actionId
    const prior = this.counts.get(key) ?? 0
    const decision = evaluatePlaceRetry({
      at: input.at,
      reason: input.reason,
      priorRetries: prior,
      limit: this.limit,
      actionId: input.actionId,
      item: input.item,
    })
    this.counts.set(key, decision.count)
    if (decision.exhausted) {
      this.retiredActions.add(input.actionId)
      if (input.item !== null) this.retiredItems.add(input.item)
    }
    // The retire line is emitted once per exhausted family, never once per
    // subsequent failure (which is what made the live counter look advisory).
    const exhaustedLine = decision.exhaustedLine !== null && !this.announced.has(key) ? decision.exhaustedLine : null
    if (exhaustedLine !== null) this.announced.add(key)
    return { ...decision, exhaustedLine, actionId: input.actionId, item: input.item }
  }

  /** A verified placement ends the failure run for this item. */
  noteVerified(item: string | null): void {
    if (item === null) return
    this.counts.delete(item)
    this.retiredItems.delete(item)
    this.announced.delete(item)
  }

  /** true when the item family has exhausted its bounded placement attempts. */
  isItemRetired(item: string | null): boolean {
    return item !== null && this.retiredItems.has(item)
  }

  isActionRetired(actionId: string): boolean {
    return this.retiredActions.has(actionId)
  }

  /** The retired item set the candidate generator must not offer again. */
  retiredItemSet(): ReadonlySet<string> {
    return this.retiredItems
  }

  /** true when ANY placement family is past its bound (the protection release). */
  anyExhausted(): boolean {
    for (const count of this.counts.values()) {
      if (count > this.limit) return true
    }
    return false
  }

  countFor(item: string | null): number {
    return item === null ? 0 : (this.counts.get(item) ?? 0)
  }

  limitFor(): number {
    return this.limit
  }

  reset(): void {
    this.counts.clear()
    this.retiredItems.clear()
    this.retiredActions.clear()
    this.announced.clear()
  }
}
