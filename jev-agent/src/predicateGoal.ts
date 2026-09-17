// predicateGoal.ts - Issue #41: predicate-based goal success.
//
// Some objectives are not item counts: descending to an ore level, entering a
// dimension, locating a structure. This module owns the deterministic, code-only
// evaluation of those predicates plus the plan helper that builds a descend goal
// from known ore coordinates. No bot, no model, no clock.
import { ORE_SOURCES } from './state.ts'
import type { Vec3Json } from './state.ts'

/** Spatial predicate whose truth is read from a plain snapshot, never a model. */
export type SpatialPredicate =
  | { readonly kind: 'levelAtMost'; readonly y: number; readonly dimension: string | null }

export interface PredicateSnapshot {
  position: Vec3Json | null
  dimension: string | null
}

export interface PredicateEvaluation {
  satisfied: boolean
  dimensionOk: boolean
  y: number | null
  detail: string
}

/** Ore levels used when WorldMemory has no discovered coordinate for the ore. */
export const ORE_CANONICAL_Y: Readonly<Record<string, number>> = { raw_iron: 32, diamond: 8 }

/** Descend a couple of blocks past the ore level so the ore sits within reach. */
export const ORE_DESCENT_MARGIN = 2

/** A known cell that can ground an ore descent target. */
export interface KnownOrePosition {
  name: string
  y: number
  dimension?: string
}

export function normalizeDimension(dimension: string): string {
  return dimension.replace(/^minecraft:/, '').toLowerCase()
}

export function levelAtMost(y: number, dimension: string | null = null): SpatialPredicate {
  return { kind: 'levelAtMost', y, dimension }
}

/** The predicate a goal carries, or null when the goal is item-counted. */
export function predicateForGoal(goal: {
  kind?: string
  targetY?: number | null
  dimension?: string | null
}): SpatialPredicate | null {
  if (goal.kind !== 'descend') return null
  const y = goal.targetY
  if (typeof y !== 'number' || !Number.isFinite(y)) return null
  return levelAtMost(y, goal.dimension ?? null)
}

export function describeSpatialPredicate(predicate: SpatialPredicate): string {
  return `descend_to:Y=${predicate.y}`
}

export function evaluateSpatialPredicate(predicate: SpatialPredicate, snapshot: PredicateSnapshot): PredicateEvaluation {
  const dimensionOk =
    predicate.dimension === null ||
    (snapshot.dimension !== null && normalizeDimension(snapshot.dimension) === normalizeDimension(predicate.dimension))
  const y = snapshot.position === null ? null : snapshot.position.y
  const levelOk = y !== null && y <= predicate.y
  const satisfied = dimensionOk && levelOk
  return {
    satisfied,
    dimensionOk,
    y,
    detail: `predicate=${describeSpatialPredicate(predicate)} dimension=${snapshot.dimension ?? 'null'} dimensionOk=${dimensionOk} y=${y ?? 'null'} targetY=${predicate.y} satisfied=${satisfied}`,
  }
}

/**
 * The Y a descend goal should reach for an ore item: a couple of blocks below the
 * deepest known coordinate of that ore, else the canonical ore band. Bounded to
 * the overworld floor so a malformed memory cannot ask for the void.
 */
export function oreDescentTargetY(
  item: string,
  known: readonly KnownOrePosition[],
  dimension: string,
): number {
  const blockNames = ORE_SOURCES[item] ?? []
  const ys = known
    .filter((resource) => blockNames.includes(resource.name))
    .filter(
      (resource) =>
        resource.dimension === undefined ||
        normalizeDimension(resource.dimension) === normalizeDimension(dimension),
    )
    .map((resource) => resource.y)
  const target = ys.length > 0 ? Math.min(...ys) - ORE_DESCENT_MARGIN : (ORE_CANONICAL_Y[item] ?? 16)
  return Math.max(-59, Math.min(320, target))
}
