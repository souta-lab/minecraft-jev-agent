// milestone-predicate-eval.ts — generation-side milestone predicate evaluation.
//
// This is the half of the milestone-predicate evidence producer that REUSES the
// ladder's own predicates (`RUNGS[].satisfied`). It lives on the generation side
// because the ladder lives there: importing it into the HOST would pull the
// planner/jev graph into the host process, which the host/generation boundary
// forbids. The HOST only persists what this returns.
//
// No new milestone semantics are introduced: every predicate id maps to an
// EXISTING rung and reports that rung's own `satisfied(counts, world)`.
import { RUNGS } from './planner.ts'
import type { Counts } from './planner.ts'
import type { ResidentWorldMemory } from './resident-types.ts'
import type { MilestonePredicateId, MilestonePredicateObservation } from './milestone-predicates.ts'

interface PredicateSpec {
  id: MilestonePredicateId
  milestone: 'M2' | 'M3'
  /** The EXISTING ladder rung whose `satisfied` predicate this observation reuses. */
  rungId: string
  /**
   * Inventory thresholds can be honestly reported as `false` while the run is
   * live (all observed counts are below the target). A transition predicate
   * (portal verified / Nether reached) is reported `null` when absent: the
   * absence of a transition is not proof that it never happened.
   */
  falsifiableWhenAbsent: boolean
  items: readonly string[]
}

const PREDICATE_SPECS: readonly PredicateSpec[] = [
  { id: 'portal_verified', milestone: 'M2', rungId: 'nether_portal', falsifiableWhenAbsent: false, items: ['nether_portal', 'flint_and_steel', 'obsidian'] },
  { id: 'nether_reached', milestone: 'M3', rungId: 'enter_nether', falsifiableWhenAbsent: false, items: [] },
  { id: 'blaze_rods', milestone: 'M3', rungId: 'blaze_rods', falsifiableWhenAbsent: true, items: ['blaze_rod'] },
  { id: 'ender_pearls', milestone: 'M3', rungId: 'ender_pearls', falsifiableWhenAbsent: true, items: ['ender_pearl'] },
  { id: 'ender_eyes', milestone: 'M3', rungId: 'ender_eyes', falsifiableWhenAbsent: true, items: ['ender_eye'] },
]

/**
 * Evaluate the M2/M3 milestone predicates from live inventory + durable world
 * memory. Reuses the ladder's own `satisfied(counts, world)` predicates, so the
 * observation can never drift from the frontier the controller runs.
 */
export function evaluateMilestonePredicates(
  counts: Counts,
  world: ResidentWorldMemory,
  atMs: number,
): MilestonePredicateObservation[] {
  const observedAt = new Date(atMs).toISOString()
  return PREDICATE_SPECS.map((spec) => {
    const rung = RUNGS.find((candidate) => candidate.id === spec.rungId) ?? null
    const held = rung === null ? null : rung.satisfied(counts, world)
    const satisfied = held === true ? true : held === false && spec.falsifiableWhenAbsent ? false : null
    const itemCounts: Record<string, number> = {}
    for (const item of spec.items) itemCounts[item] = counts[item] ?? 0
    return {
      id: spec.id,
      milestone: spec.milestone,
      satisfied,
      observedAtMs: satisfied === null ? null : atMs,
      observedAt: satisfied === null ? null : observedAt,
      source: rung === null ? `host-observe:rung-missing:${spec.rungId}` : `host-observe:rung:${rung.id}`,
      evidence: {
        rungId: spec.rungId,
        rungPredicate: held === true,
        dimension: world.dimension ?? null,
        portalVerified: world.portalVerified === true,
        items: itemCounts,
      },
    }
  })
}
