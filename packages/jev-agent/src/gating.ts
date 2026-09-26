// gating.ts - diagnostic classification for `score` answers.
//
// A `score` answer is two-dimensional:
//
//     value       - the fractional position in [0, levels-1]
//     confidence  - TypeSafe's *calibrated* certainty in that score
//
// Score and confidence remain model evidence. This module records their values
// and a diagnostic confidence band; it never authorizes or selects an action.
// Only deterministic, code-owned safety truth may restrict a grounded choice or
// interrupt a committed Skill.
//
// The threshold is deliberately named and exported so it can be re-calibrated
// from the decision log once real data accumulates (the log records predicted
// confidence next to the observed outcome, which is exactly a reliability
// diagram: bin by confidence, measure the empirical success rate per bin).
import { BOOLEAN_HIGH, BOOLEAN_LOW, DANGER_LEVELS } from './jev.ts'
import type { JevAnswer } from './jev.ts'

/**
 * Diagnostic confidence band boundary. Crossing it does not give the score
 * production authority; raw value/confidence remain evidence only.
 */
export const DANGER_CONFIDENCE_THRESHOLD = 0.4

export interface GatedScore {
  /** the ordered level labels the score indexes into */
  legend: string[]
  /** raw fractional score, or null when no usable score was returned */
  value: number | null
  /** the nearest level label for the raw score */
  level: string | null
  /** calibrated confidence, or null when the provider reported none */
  confidence: number | null
  /** the threshold this score was compared against */
  threshold: number
  /** true only when confidence is a number AND >= threshold; diagnostic only */
  confidenceQualified: boolean
  /** human-readable explanation, suitable for the decision log */
  reason: string
}

/**
 * Classify the reported confidence for diagnostics. This result must not be
 * used to replace Jev pi's choice or to assert Minecraft danger as truth.
 *
 * Missing confidence remains unqualified; even a qualified score has no action
 * authority.
 */
export function gateScore(answer: JevAnswer | undefined, threshold: number): GatedScore {
  if (answer === undefined || answer.type !== 'score') {
    return {
      legend: [...DANGER_LEVELS],
      value: null,
      level: null,
      confidence: null,
      threshold,
      confidenceQualified: false,
      reason: 'no score answer was returned',
    }
  }
  const legend = answer.legend ?? []
  const value = typeof answer.value === 'number' ? answer.value : null
  const level = value === null ? null : levelLabel(legend, value)
  const confidence = answer.confidence
  if (confidence === null) {
    return {
      legend,
      value,
      level,
      confidence,
      threshold,
      confidenceQualified: false,
      reason: 'no confidence reported; score retained as unqualified evidence',
    }
  }
  if (confidence < threshold) {
    return {
      legend,
      value,
      level,
      confidence,
      threshold,
      confidenceQualified: false,
      reason: `confidence ${confidence} < ${threshold}: diagnostic confidence band not reached`,
    }
  }
  return {
    legend,
    value,
    level,
    confidence,
    threshold,
    confidenceQualified: true,
    reason: `confidence ${confidence} >= ${threshold}; diagnostic only, no action authority`,
  }
}

/** Gate the `danger` question with the named threshold. */
export function gateDanger(answer: JevAnswer | undefined): GatedScore {
  return gateScore(answer, DANGER_CONFIDENCE_THRESHOLD)
}

export type BooleanBand = 'strong_false' | 'uncertain' | 'strong_true'

export interface GatedBoolean {
  probability: number | null
  band: BooleanBand | null
  strong: boolean
  uncertain: boolean
  reason: string
}

/**
 * Boolean answers expose only P(true) (no calibrated per-outcome confidence).
 * Read them through the 0.30/0.70 uncertainty zone instead of
 * `threshold + providerMetadata.confidence`.
 */
export function gateBoolean(answer: JevAnswer | undefined): GatedBoolean {
  if (answer === undefined || answer.type !== 'boolean') {
    return { probability: null, band: null, strong: false, uncertain: false, reason: 'no boolean answer was returned' }
  }
  const probability = typeof answer.probability === 'number' ? answer.probability : null
  if (probability === null) {
    return { probability, band: null, strong: false, uncertain: false, reason: 'boolean answer carried no probability' }
  }
  if (probability >= BOOLEAN_HIGH) {
    return { probability, band: 'strong_true', strong: true, uncertain: false, reason: `P(true)=${probability} >= ${BOOLEAN_HIGH}` }
  }
  if (probability <= BOOLEAN_LOW) {
    return { probability, band: 'strong_false', strong: true, uncertain: false, reason: `P(true)=${probability} <= ${BOOLEAN_LOW}` }
  }
  return {
    probability,
    band: 'uncertain',
    strong: false,
    uncertain: true,
    reason: `P(true)=${probability} inside the uncertainty zone (${BOOLEAN_LOW}, ${BOOLEAN_HIGH})`,
  }
}

/**
 * Map a fractional score back to its nearest level label. Scores are
 * probability-weighted means of the level indices, so we round to nearest.
 */
export function levelLabel(legend: readonly string[], value: number): string | null {
  if (legend.length === 0) return null
  const index = Math.max(0, Math.min(legend.length - 1, Math.round(value)))
  return legend[index] ?? null
}
