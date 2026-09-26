import { createReachTransitionContract } from './transition.ts'
import type { ReachIdentity, ReachPredicate, ReachTransitionContract } from './transition.ts'

/** Structural Mission input accepted by the VTR scheduler; benchmark ladders are intentionally absent. */
export interface InventoryReachMission {
  readonly id: string
  readonly kind: 'inventory_at_least'
  readonly item: string
  readonly count: number
}

export interface InventoryReachTransitionInput {
  readonly mission: InventoryReachMission
  readonly interactionReach: number
  /** Resource ontology grounded by the runtime adapter and bound into the predicate. */
  readonly sourceNames: readonly string[]
  readonly identity: ReachIdentity
  readonly transitionId: string
}

export interface InventoryReachTransitionPlan {
  readonly desiredPredicate: ReachPredicate
  readonly contract: ReachTransitionContract
}

/**
 * Derive the generic navigation Transition from an unsatisfied inventory Mission.
 * The mission's desired count is a prerequisite here; the contract's ensures is
 * the deterministic source-reach predicate, independent of benchmark milestones.
 */
export function createInventoryReachTransition(input: InventoryReachTransitionInput): InventoryReachTransitionPlan {
  const { mission, interactionReach, sourceNames, identity, transitionId } = input
  if (mission.id.trim() === '' || mission.item.trim() === '' || !Number.isSafeInteger(mission.count) || mission.count < 1) {
    throw new TypeError('Reach Mission must have a stable id, item, and positive integer count')
  }
  if (!Number.isFinite(interactionReach) || interactionReach <= 0) {
    throw new TypeError('Reach interaction radius must be positive and finite')
  }
  const normalizedSourceNames = [...new Set(sourceNames.filter((name) => name.trim() !== ''))].sort()
  const desiredPredicate: ReachPredicate = {
    id: 'reach.resource-source',
    proposition: {
      kind: 'within-interaction-reach-of-resource-source',
      item: mission.item,
      sourceNames: normalizedSourceNames,
      interactionReach,
    },
    expected: true,
  }
  const contract = createReachTransitionContract({
    transitionId,
    desiredPredicate,
    requires: [
      { id: 'mission.unsatisfied', proposition: { kind: 'inventory-below', item: mission.item, count: mission.count }, expected: true },
      { id: 'reach.source-grounded', proposition: { kind: 'grounded-source-approach', item: mission.item, sourceNames: normalizedSourceNames }, expected: true },
    ],
    ensures: [desiredPredicate],
    invariants: [{ id: 'body.alive', proposition: { kind: 'health-above-zero' }, expected: true }],
    admissibleEffects: [{ kind: 'locomotion', maxUses: null }],
    budget: { maxMechanicalSteps: 24, maxElapsedMs: 120_000, resources: {}, risk: { damage: 1 } },
    controller: {
      allowedTactics: ['walk', 'path_replan', 'jump', 'detour'],
      allowTemporaryWaypointChanges: true,
      allowWitnessSubstitution: true,
    },
    identity,
  })
  return { desiredPredicate, contract }
}
