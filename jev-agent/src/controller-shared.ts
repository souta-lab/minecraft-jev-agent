// controller-shared.ts — option builders shared by the legacy decision loop and
// the VTR Reach controller plane. Pure functions; no authority ownership.
//
// The option inputs are deliberately narrow structural slices so neither the
// legacy controller nor the Reach plane needs the other's concrete options
// type. Callers pass their full options object.

import { defaultSensorOptions } from './state.ts'
import type { DimensionProvenance, SensorOptions } from './state.ts'
import { defaultCandidateOptions } from './candidates.ts'
import type { CandidateOptions, ReachabilityGateOptions } from './candidates.ts'
import type { RecipeIndex } from './crafting.ts'
import type { GoalState } from './state.ts'
import type { GoalQueueState } from './goalQueue.ts'
import type { PortalEntryPlan, PortalFrameValidation } from './netherPortalPlan.ts'
import type { PrereqRankPolicy } from './prereqOption.ts'

export interface SensorOptionSlice {
  readonly scanRadius: number
  readonly reach: number
  readonly dimensionProvenance?: DimensionProvenance | null
}

export function sensorOptions(options: SensorOptionSlice, worldRevision: number | null = null): SensorOptions {
  return {
    ...defaultSensorOptions,
    scanRadius: options.scanRadius,
    reach: options.reach,
    worldRevision,
    // Only the decision-time build carries provenance: `sensorOptions(...)` is
    // also used for standalone portal-frame projections outside `buildWorldState`,
    // where the read gate is not armed and the reads are unchanged.
    dimensionProvenance: options.dimensionProvenance ?? null,
  }
}

export interface CandidateOptionSlice {
  readonly reach: number
  readonly prereqRankPolicy: PrereqRankPolicy
}

export function candidateOptions(
  options: CandidateOptionSlice,
  recipes: RecipeIndex,
  unreachableStations: ReadonlySet<string> = new Set<string>(),
  reachability: ReachabilityGateOptions | null = null,
  blacklistedMoveTargets: ReadonlySet<string> = new Set<string>(),
  portalFrame: PortalFrameValidation | null = null,
  searchedSurfaceTargets: ReadonlySet<string> = new Set<string>(),
  portalEntry: PortalEntryPlan | null = null,
  retiredPlaceItems: ReadonlySet<string> = new Set<string>(),
): CandidateOptions {
  return {
    ...defaultCandidateOptions,
    reach: options.reach,
    recipes,
    unreachableStations,
    blacklistedMoveTargets,
    searchedSurfaceTargets,
    reachability,
    portalFrame,
    portalEntry,
    retiredPlaceItems,
    prereqRankPolicy: options.prereqRankPolicy,
  }
}

/** Hard upper bound for settling a committed safety Skill during model recovery. */
export const MODEL_RECOVERY_DRAIN_GRACE_MS = 1_000

export function currentFocusItem(goal: GoalState, queue: GoalQueueState): string | null {
  return queue.current?.targetItem ?? goal.targetItem ?? null
}
