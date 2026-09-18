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
  return actionId
}

/**
 * True for the grounded options that exist solely to satisfy the smelt's
 * "placed furnace" precondition: crafting the furnace, placing a held one, or
 * returning to a remembered one.
 */
export function isFurnacePrerequisiteOption(actionId: string | null): boolean {
  if (actionId === null) return false
  return (
    actionId.startsWith('PLACE:furnace') ||
    actionId.startsWith('CRAFT:furnace') ||
    actionId.startsWith('RETRIEVE:known:station:furnace')
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

export function formatPlaceRetry(at: Vec3Json, reason: string): string {
  return `PLACE_RETRY at=${at.x},${at.y},${at.z} reason=${reason}`
}

export interface PlaceRetryDecision {
  /** true while the placement may be retried at a nearby spot. */
  retry: boolean
  /** 1-based retry ordinal. */
  count: number
  line: string
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
}): PlaceRetryDecision {
  const limit = input.limit ?? PLACE_RETRY_LIMIT
  const count = input.priorRetries + 1
  return { retry: count <= limit, count, line: formatPlaceRetry(input.at, input.reason) }
}
