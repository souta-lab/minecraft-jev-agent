// jev-harness/calibration.ts - ONE versioned calibration layer (#438 section 11/12/13).
//
// "No call site gets to invent `if p > 0.47`, `if confidence < 0.34`,
// `multiply score by 1.2` based on one incident."
//
// Every transform and every threshold used in production lives here, is
// addressed as `id@version`, and is recorded on the artifact. A head selects a
// transform by id+version; nothing else may threshold a probability.
//
// Two structural rules are enforced by construction and by CI:
//   * a transform is a pure numeric mapping - it cannot produce a "safe",
//     "admissible", or "bypassGuard" verdict, so high confidence can never
//     bypass Guard (#438 section 12);
//   * a low probability is never turned into abstention (#438 section 13) -
//     abstention only exists when a head declares provider abstention and the
//     provider actually abstains.

import type { CandidateProbability, ScoreScale, TerminationProposal } from './contract.ts'

export const CALIBRATION_LAYER_VERSION = 1

export type CalibrationKind = 'identity' | 'choice' | 'threshold' | 'score_level'

export interface CalibrationContext {
  readonly probabilities?: Readonly<Record<string, number>>
  readonly candidateOrder?: readonly string[]
  readonly scale?: ScoreScale
  readonly threshold?: number
}

export interface CalibrationTransform {
  readonly id: string
  readonly version: number
  readonly kind: CalibrationKind
  /** Numeric, pure, side-effect free. */
  readonly apply: (input: number, context: CalibrationContext) => number
  /**
   * Experimental transforms exist so #423/#363 can A/B them offline against
   * captured artifacts. A production head must never reference one.
   */
  readonly experimental: boolean
  readonly description: string
}

export class UnknownCalibrationError extends Error {
  constructor(id: string, version: number) {
    super(`unregistered calibration transform ${id}@${version}`)
    this.name = 'UnknownCalibrationError'
  }
}

export const IDENTITY_TRANSFORM: CalibrationTransform = {
  id: 'identity_v1',
  version: 1,
  kind: 'identity',
  apply: (input) => input,
  experimental: false,
  description: 'No-op passthrough. Exists so "no transform" is still a recorded, versioned choice.',
}

export const CHOICE_DISTRIBUTION_TRANSFORM: CalibrationTransform = {
  id: 'choice_distribution_v1',
  version: 1,
  kind: 'choice',
  // Identity on the probability itself: the raw provider distribution is kept
  // unpreserved-modified (I7). Ranking happens in `rankDistribution`.
  apply: (input) => input,
  experimental: false,
  description:
    'Identity on each choice probability. The raw distribution is preserved; only a deterministic ranking is derived.',
}

export const SCORE_LEVEL_TRANSFORM: CalibrationTransform = {
  id: 'score_level_v1',
  version: 1,
  kind: 'score_level',
  // Ordered scales are fractional positions; rounding to the nearest declared
  // level label is a *representation* step, not a policy change.
  apply: (input, context) => {
    const scale = context.scale
    if (scale === undefined) return input
    const rounded = Math.round(input)
    return Math.min(scale.max, Math.max(scale.min, rounded))
  },
  experimental: false,
  description: 'Rounds a fractional ordered-scale score onto the declared level index.',
}

export const BETA_THRESHOLD_TRANSFORM: CalibrationTransform = {
  id: 'beta_threshold_v1',
  version: 1,
  kind: 'threshold',
  apply: (input) => input,
  experimental: false,
  description:
    'Identity mapping raw P(terminate=true) -> calibrated probability. The threshold is a separate recorded parameter ' +
    '(Option contract first, registry default second). A future probability remap must be a NEW transform id/version ' +
    'with replay evidence under #423.',
}

/**
 * Experimental monotone recalibration used ONLY for offline A/B on captured
 * artifacts. No production head references it; CI asserts that.
 */
export const BETA_THRESHOLD_EXPERIMENTAL_V2: CalibrationTransform = {
  id: 'beta_threshold_v2',
  version: 2,
  kind: 'threshold',
  apply: (input) => input * input,
  experimental: true,
  description: 'EXPERIMENTAL: squares the raw beta probability. Replay/A-B only; never production-authoritative.',
}

export const BOOLEAN_THRESHOLD_TRANSFORM: CalibrationTransform = {
  id: 'boolean_threshold_v1',
  version: 1,
  kind: 'threshold',
  apply: (input) => input,
  experimental: false,
  description: 'Identity mapping for shadow boolean heads (retreat). The proposal comes from the recorded threshold.',
}

export const STRATEGY_CHANGE_THRESHOLD_TRANSFORM: CalibrationTransform = {
  id: 'strategy_change_threshold_v1',
  version: 1,
  kind: 'threshold',
  apply: (input) => input,
  experimental: false,
  description:
    'Identity mapping for the legacy System2 strategy_change boolean. Replaces `resolveStrategyChangeThreshold()` at ' +
    'migration time (Phase D).',
}

export const CALIBRATION_TRANSFORMS: readonly CalibrationTransform[] = [
  IDENTITY_TRANSFORM,
  CHOICE_DISTRIBUTION_TRANSFORM,
  SCORE_LEVEL_TRANSFORM,
  BETA_THRESHOLD_TRANSFORM,
  BETA_THRESHOLD_EXPERIMENTAL_V2,
  BOOLEAN_THRESHOLD_TRANSFORM,
  STRATEGY_CHANGE_THRESHOLD_TRANSFORM,
]

const TRANSFORM_INDEX: ReadonlyMap<string, CalibrationTransform> = new Map(
  CALIBRATION_TRANSFORMS.map((transform) => [`${transform.id}@${transform.version}`, transform]),
)

export function lookupTransform(id: string, version: number): CalibrationTransform | null {
  return TRANSFORM_INDEX.get(`${id}@${version}`) ?? null
}

export function requireTransform(id: string, version: number): CalibrationTransform {
  const transform = lookupTransform(id, version)
  if (transform === null) throw new UnknownCalibrationError(id, version)
  return transform
}

// ---------------------------------------------------------------------------
// parameters (thresholds) - centralised, versioned, recorded
// ---------------------------------------------------------------------------

export interface ThresholdParameter {
  readonly id: string
  readonly version: number
  readonly value: number
  readonly description: string
}

export class InvalidThresholdError extends Error {
  constructor(id: string, value: number) {
    super(`threshold parameter ${id} must be finite and within [0,1], got ${String(value)}`)
    this.name = 'InvalidThresholdError'
  }
}

/** The registry defaults. Option contracts may override beta per Option (#11). */
export const DEFAULT_THRESHOLDS: Readonly<Record<string, ThresholdParameter>> = Object.freeze({
  beta_abandon_default: {
    id: 'beta_abandon_default',
    version: 1,
    value: 0.5,
    description:
      'Bootstrap/rollback beta threshold used only when the exact Option contract carries no valid abortThreshold. ' +
      'Replaces ABANDON_THRESHOLD_DEFAULT at migration time.',
  },
  boolean_default: {
    id: 'boolean_default',
    version: 1,
    value: 0.5,
    description: 'Default threshold for shadow boolean heads (retreat).',
  },
  strategy_change_default: {
    id: 'strategy_change_default',
    version: 1,
    value: 0.5,
    description: 'Replaces STRATEGY_CHANGE_THRESHOLD_DEFAULT at migration time.',
  },
})

export function assertValidThreshold(id: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new InvalidThresholdError(id, value)
  return value
}

export interface ThresholdResolution {
  readonly value: number
  readonly parameterId: string
  readonly parameterVersion: number
  readonly source: 'option_contract' | 'registry_default'
}

/**
 * Beta threshold resolution: the exact Option contract wins; the registry default
 * is only the bootstrap/rollback path (same precedence the current authority
 * kernel implements in `authorityDecisionMeta`).
 */
export function resolveBetaThreshold(
  optionAbortThreshold: number | null | undefined,
  parameters: Readonly<Record<string, ThresholdParameter>> = DEFAULT_THRESHOLDS,
): ThresholdResolution {
  if (typeof optionAbortThreshold === 'number' && Number.isFinite(optionAbortThreshold) && optionAbortThreshold >= 0 && optionAbortThreshold <= 1) {
    return {
      value: optionAbortThreshold,
      parameterId: 'option_contract.abortThreshold',
      parameterVersion: 1,
      source: 'option_contract',
    }
  }
  return resolveThreshold('beta_abandon_default', parameters)
}

export function resolveThreshold(
  id: string,
  parameters: Readonly<Record<string, ThresholdParameter>> = DEFAULT_THRESHOLDS,
): ThresholdResolution {
  const parameter = parameters[id] ?? DEFAULT_THRESHOLDS[id]
  if (parameter === undefined) throw new UnknownCalibrationError(id, 1)
  assertValidThreshold(id, parameter.value)
  return { value: parameter.value, parameterId: parameter.id, parameterVersion: parameter.version, source: 'registry_default' }
}

export function thresholdProposal(probability: number, threshold: number): TerminationProposal {
  return probability >= threshold ? 'terminate' : 'continue'
}

// ---------------------------------------------------------------------------
// deterministic distribution ranking
// ---------------------------------------------------------------------------

/**
 * Rank a distribution deterministically: descending probability, ties broken by
 * the request's canonical candidate order. Ties must not be broken by insertion
 * order (that would smuggle the generating code's preference into the harness,
 * #438 section 14).
 */
export function rankDistribution(
  probabilities: Readonly<Record<string, number>>,
  canonicalOrder: readonly string[],
): readonly CandidateProbability[] {
  const index = new Map(canonicalOrder.map((id, position) => [id, position]))
  const entries: CandidateProbability[] = []
  for (const id of canonicalOrder) {
    const probability = probabilities[id]
    if (probability === undefined) continue
    entries.push({ candidateId: id, probability })
  }
  entries.sort((a, b) => {
    if (b.probability !== a.probability) return b.probability - a.probability
    return (index.get(a.candidateId) ?? 0) - (index.get(b.candidateId) ?? 0)
  })
  return entries
}

/** The transform's numeric output for a record, with the version recorded. */
export interface AppliedCalibration {
  readonly transformId: string
  readonly transformVersion: number
  readonly input: number | null
  readonly output: number | null
  readonly threshold: number | null
  readonly thresholdParameterId: string | null
  readonly thresholdParameterVersion: number | null
  readonly thresholdSource: 'option_contract' | 'registry_default' | null
}
