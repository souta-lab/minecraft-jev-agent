// progressTaxonomy.ts - one typed vocabulary for action outcomes and progress.
//
// Issue #121: mechanical completion, verified postconditions, goal progress,
// search progress, reachability, and strategic stall used to be represented by
// several overlapping string unions.  This module is deliberately pure and
// bot-free.  It is a compatibility seam: existing marker strings may remain,
// while controller/recovery code can carry one typed classification alongside
// them.

export type ProgressFamily =
  | 'mechanical_action'
  | 'postcondition'
  | 'goal_progress'
  | 'search_frontier'
  | 'target_reachability'
  | 'initiation_precondition'
  | 'structural_impossibility'
  | 'semantic_abandon'
  | 'timeout_stall'
  | 'lifecycle'
  | 'unknown'

export type ProgressReasonCode =
  | 'mechanical_success'
  | 'mechanical_failure'
  | 'postcondition_verified'
  | 'postcondition_unverified'
  | 'goal_progress'
  | 'search_progress'
  | 'target_unreachable'
  | 'initiation_blocked'
  | 'structurally_impossible'
  | 'semantic_abandon'
  | 'timeout_stall'
  | 'cancelled'
  | 'inconclusive'

export type ProgressStatus = 'success' | 'failure' | 'blocked' | 'abandoned' | 'cancelled' | 'inconclusive'

export interface ProgressDelta {
  /** The action changed the body/world mechanically, even without goal evidence. */
  mechanical: boolean
  /** Positive verified change toward the active goal. */
  goal: number
  /** Positive verified discovery/frontier/search change. */
  search: number
}

export interface ProgressClassification {
  family: ProgressFamily
  code: ProgressReasonCode
  status: ProgressStatus
  verified: boolean
  /** Observable change is not the same thing as verified productive progress. */
  observable: boolean
  /** True only when a verified goal/search delta can advance the strategy. */
  productive: boolean
  /** Strategic no-progress timers may reset only for productive progress. */
  resetsStrategicStall: boolean
  delta: ProgressDelta
}

/** The outcome facts needed by the pure classifier. */
export interface ProgressObservation {
  status: string
  verified: boolean
  itemsGained?: number
  blockRemoved?: boolean
  progressed?: boolean
  goalProgressDelta?: number
  searchProgressDelta?: number
  failure?: string | null
  initiationBlocked?: boolean
  structurallyImpossible?: boolean
  abandonRequested?: boolean
}

const finitePositive = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : 0

/** Observable body/world change. It never proves a postcondition by itself. */
export function hasObservableProgress(
  input: Pick<ProgressObservation, 'itemsGained' | 'blockRemoved' | 'progressed'>,
): boolean {
  return (input.itemsGained ?? 0) > 0 || input.blockRemoved === true || input.progressed === true
}

function failureClassification(failure: string | null | undefined): Pick<ProgressClassification, 'family' | 'code' | 'status'> {
  switch (failure) {
    case 'cancelled':
      return { family: 'lifecycle', code: 'cancelled', status: 'cancelled' }
    case 'path_no_path':
    case 'out_of_reach':
    case 'target_gone':
    case 'tunnel_entry_refused':
      return { family: 'target_reachability', code: 'target_unreachable', status: 'blocked' }
    case 'path_timeout':
    case 'path_stuck':
    case 'dig_timeout':
    case 'smelt_timeout':
      return { family: 'timeout_stall', code: 'timeout_stall', status: 'failure' }
    case 'verify_failed':
      return { family: 'postcondition', code: 'postcondition_unverified', status: 'failure' }
    case 'unknown_event':
      return { family: 'unknown', code: 'inconclusive', status: 'inconclusive' }
    default:
      return { family: 'mechanical_action', code: 'mechanical_failure', status: 'failure' }
  }
}

function finish(
  base: Pick<ProgressClassification, 'family' | 'code' | 'status'> &
    Partial<Pick<ProgressClassification, 'verified'>>,
  observation: ProgressObservation,
  delta: ProgressDelta,
  observable: boolean,
): ProgressClassification {
  const verified = base.verified ?? observation.verified
  const productive = base.status === 'success' && verified && (delta.goal > 0 || delta.search > 0)
  return {
    ...base,
    verified,
    observable,
    productive,
    resetsStrategicStall: productive,
    delta,
  }
}

/**
 * Classify one settled action without granting authority to the classifier.
 * Code-owned postconditions and goal/search deltas remain the inputs; this
 * function only gives them one stable vocabulary for recovery and evidence.
 */
export function classifyProgress(observation: ProgressObservation): ProgressClassification {
  const delta: ProgressDelta = {
    mechanical: hasObservableProgress(observation),
    goal: finitePositive(observation.goalProgressDelta),
    search: finitePositive(observation.searchProgressDelta),
  }
  const observable = delta.mechanical

  if (observation.abandonRequested === true) {
    return finish(
      { family: 'semantic_abandon', code: 'semantic_abandon', status: 'abandoned', verified: observation.verified },
      observation,
      delta,
      observable,
    )
  }
  if (observation.structurallyImpossible === true) {
    return finish(
      { family: 'structural_impossibility', code: 'structurally_impossible', status: 'blocked', verified: observation.verified },
      observation,
      delta,
      observable,
    )
  }
  if (observation.initiationBlocked === true) {
    return finish(
      { family: 'initiation_precondition', code: 'initiation_blocked', status: 'blocked', verified: observation.verified },
      observation,
      delta,
      observable,
    )
  }
  if (observation.status === 'cancelled' || observation.failure === 'cancelled') {
    return finish(
      { family: 'lifecycle', code: 'cancelled', status: 'cancelled', verified: false },
      observation,
      delta,
      observable,
    )
  }
  if (observation.status === 'failed') {
    return finish(failureClassification(observation.failure), observation, delta, observable)
  }
  if (observation.status === 'done' && !observation.verified) {
    return finish(
      { family: 'postcondition', code: 'postcondition_unverified', status: 'failure', verified: false },
      observation,
      delta,
      observable,
    )
  }
  if (observation.status === 'done' && observation.verified) {
    if (delta.goal > 0) {
      return finish(
        { family: 'goal_progress', code: 'goal_progress', status: 'success', verified: true },
        observation,
        delta,
        observable,
      )
    }
    if (delta.search > 0) {
      return finish(
        { family: 'search_frontier', code: 'search_progress', status: 'success', verified: true },
        observation,
        delta,
        observable,
      )
    }
    return finish(
      { family: 'mechanical_action', code: 'mechanical_success', status: 'success', verified: true },
      observation,
      delta,
      observable,
    )
  }
  return finish(
    { family: 'unknown', code: 'inconclusive', status: 'inconclusive', verified: observation.verified },
    observation,
    delta,
    observable,
  )
}

/** Stable JSONL-friendly projection for evidence records and marker adapters. */
export function progressEvidence(classification: ProgressClassification): Record<string, unknown> {
  return {
    family: classification.family,
    reasonCode: classification.code,
    status: classification.status,
    verified: classification.verified,
    observable: classification.observable,
    productive: classification.productive,
    resetsStrategicStall: classification.resetsStrategicStall,
    goalProgressDelta: classification.delta.goal,
    searchProgressDelta: classification.delta.search,
    mechanicalProgress: classification.delta.mechanical,
  }
}
