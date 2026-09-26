import type { InventoryReachMission } from './scheduler.ts'
import type { ReachRuntimeSnapshot, ReachRoute } from './controller.ts'
import { countMissionInventoryResource, missionResourceSourceMatches } from './transition.ts'
import type { ReachIdentity } from './transition.ts'

/** Backend-independent coordinates used at the Reach projection boundary. */
export interface ReachMissionPosition {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** A verified resource-source observation copied from the runtime adapter. */
export interface ReachMissionSourceFact {
  readonly name: string
  readonly yieldedItem: string | null
  readonly position: ReachMissionPosition
  readonly inReach: boolean
  readonly visible: boolean
}

/** A grounded candidate copied from a runtime-specific candidate adapter. */
export interface ReachMissionRouteFact {
  readonly routeId: string
  readonly kind: string
  readonly target: ReachMissionPosition | null
  readonly sourceName: string | null
  readonly sourcePosition: ReachMissionPosition | null
  readonly explore: boolean
}

export interface ReachMissionSnapshotOptions {
  readonly desiredPredicateIdentity?: string
  readonly previousFrontierId?: string | null
  readonly tactic?: ReachRoute['tactic']
  readonly parentMissionSatisfied?: { readonly evidenceId: string }
  readonly safetyInterruption?: { readonly reason: string; readonly evidenceId: string }
  readonly infeasibility?: { readonly reason: string; readonly evidenceId: string }
}

export interface ReachMissionSnapshotInput {
  readonly mission: InventoryReachMission
  /** Identity stamped on the observation; may be the last known identity during identity-loss handling. */
  readonly identity: ReachIdentity
  /** Live identity of the sensor result. Null means no candidate has a valid fresh witness. */
  readonly witnessIdentity: ReachIdentity | null
  readonly tick: number
  readonly observedAtMs: number
  readonly bodyPosition: ReachMissionPosition
  readonly bodyHealth: number
  readonly inventoryCounts: Readonly<Record<string, number>>
  readonly knownSourceNames: readonly string[]
  readonly sources: readonly ReachMissionSourceFact[]
  readonly routes: readonly ReachMissionRouteFact[]
  readonly options?: ReachMissionSnapshotOptions
}

export interface ReachMissionSnapshotProjection {
  readonly snapshot: ReachRuntimeSnapshot
  readonly groundedRouteIds: readonly string[]
  readonly missionSatisfiedEvidenceId?: string
  readonly ensuresAlreadyTrueEvidenceId?: string
}

function distance(a: ReachMissionPosition, b: ReachMissionPosition): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function sameIdentity(a: ReachIdentity, b: ReachIdentity): boolean {
  return a.worldKey === b.worldKey &&
    a.dimension === b.dimension &&
    a.worldEpoch === b.worldEpoch &&
    a.generationId === b.generationId &&
    a.leaseId === b.leaseId
}

function matchingSource(input: ReachMissionSnapshotInput, route: ReachMissionRouteFact): ReachMissionSourceFact | null {
  if (route.sourceName === null || route.sourcePosition === null) return null
  if (!missionResourceSourceMatches(input.mission.item, route.sourceName, null, input.knownSourceNames)) return null
  return input.sources.find((source) =>
    source.name === route.sourceName &&
    source.position.x === route.sourcePosition!.x &&
    source.position.y === route.sourcePosition!.y &&
    source.position.z === route.sourcePosition!.z,
  ) ?? null
}

/**
 * Pure Mission→Reach evidence projection. It knows only JSON-like Mission,
 * identity, position, inventory, source and candidate facts; no Minecraft
 * client, WorldState, block/entity type, or candidate-generation API crosses
 * this VTR boundary.
 */
export function projectReachMissionSnapshot(input: ReachMissionSnapshotInput): ReachMissionSnapshotProjection {
  const options = input.options ?? {}
  const required = Math.max(1, Math.floor(input.mission.count))
  const have = countMissionInventoryResource(input.inventoryCounts, input.mission.item)
  const missionSatisfiedEvidenceId = have >= required
    ? `inventory:${input.observedAtMs}:${input.mission.item}=${have}/${required}`
    : undefined
  const eligible = input.routes.flatMap((route): ReachRoute[] => {
    if (
      route.kind !== 'MOVE' ||
      route.target === null ||
      route.explore ||
      input.witnessIdentity === null ||
      !sameIdentity(input.identity, input.witnessIdentity)
    ) return []
    const source = matchingSource(input, route)
    if (source === null) return []
    const evidenceId = `sensor:block:${input.tick}:${source.name}@${source.position.x},${source.position.y},${source.position.z}`
    const witness = {
      witnessId: `${source.name}@${source.position.x},${source.position.y},${source.position.z}`,
      target: { x: source.position.x, y: source.position.y, z: source.position.z },
      desiredPredicateIdentity: options.desiredPredicateIdentity ?? `unbound-reach-predicate:${input.mission.item}`,
      evidenceId,
      observedIdentity: input.witnessIdentity,
      observedAtMs: input.observedAtMs,
    }
    const waypointEvidenceId = `grounded-waypoint:${input.tick}:${route.routeId}`
    return [{
      routeId: route.routeId,
      groundingPredicateId: `reach.route:${route.routeId}`,
      waypointGroundingPredicateId: `reach.waypoint:${route.routeId}`,
      witness,
      waypoint: {
        waypointId: route.routeId,
        target: { x: route.target.x, y: route.target.y, z: route.target.z },
        evidenceId: waypointEvidenceId,
      },
      tactic: options.tactic ?? 'walk',
      effectKind: 'locomotion',
      estimatedDistance: distance(input.bodyPosition, route.target),
      resources: {},
      risk: {},
    }]
  })
  const inReachSources = input.sources.filter((source) =>
    source.inReach && source.visible && missionResourceSourceMatches(input.mission.item, source.name, source.yieldedItem, input.knownSourceNames),
  )
  const predicates: Record<string, { truth: 'true' | 'false' | 'unknown'; evidenceId: string | null }> = {
    'mission.unsatisfied': {
      truth: have < required ? 'true' : 'false',
      evidenceId: `inventory:${input.observedAtMs}:${input.mission.item}=${have}/${required}`,
    },
    'reach.source-grounded': {
      truth: eligible.length > 0 ? 'true' : 'unknown',
      evidenceId: eligible.length > 0 ? `grounding:${input.tick}:${eligible.map((route) => route.routeId).join(',')}` : null,
    },
    'body.alive': {
      truth: input.bodyHealth > 0 ? 'true' : 'false',
      evidenceId: `body:${input.observedAtMs}:health=${input.bodyHealth}`,
    },
    'reach.resource-source': {
      truth: inReachSources.length > 0 ? 'true' : 'false',
      evidenceId: inReachSources.length > 0
        ? `verify:${input.tick}:${inReachSources.map((source) => `${source.name}@${source.position.x},${source.position.y},${source.position.z}`).join(',')}`
        : `verify:${input.tick}:no-interaction-reach-source`,
    },
  }
  for (const route of eligible) {
    predicates[`reach.route:${route.routeId}`] = { truth: 'true', evidenceId: route.witness.evidenceId }
    predicates[`reach.waypoint:${route.routeId}`] = { truth: 'true', evidenceId: `grounded-waypoint:${input.tick}:${route.routeId}` }
  }
  const matchingSources = input.sources.filter((source) =>
    missionResourceSourceMatches(input.mission.item, source.name, source.yieldedItem, input.knownSourceNames),
  )
  const nearest = matchingSources.reduce<number | null>((best, source) => {
    const current = distance(input.bodyPosition, source.position)
    return best === null || current < best ? current : best
  }, null)
  const firstRouteId = eligible[0]?.routeId ?? null
  const snapshot: ReachRuntimeSnapshot = {
    observation: { identity: input.identity, observedAtMs: input.observedAtMs, predicates },
    routes: eligible,
    progress: {
      predicateDistance: nearest,
      reachability: eligible.length > 0 ? 'reachable' : 'unknown',
      frontierId: firstRouteId ?? options.previousFrontierId ?? null,
      evidenceId: `reach-progress:${input.tick}:${firstRouteId ?? 'no-grounded-route'}`,
    },
    ...(options.parentMissionSatisfied === undefined ? {} : { parentMissionSatisfied: options.parentMissionSatisfied }),
    ...(options.safetyInterruption === undefined ? {} : { safetyInterruption: options.safetyInterruption }),
    ...(options.infeasibility === undefined ? {} : { infeasibility: options.infeasibility }),
  }
  const ensuresAlreadyTrueEvidenceId = inReachSources.length > 0
    ? `verify:${input.tick}:reach.resource-source-already-true`
    : undefined
  return {
    snapshot,
    groundedRouteIds: eligible.map((route) => route.routeId),
    ...(missionSatisfiedEvidenceId === undefined ? {} : { missionSatisfiedEvidenceId }),
    ...(ensuresAlreadyTrueEvidenceId === undefined ? {} : { ensuresAlreadyTrueEvidenceId }),
  }
}
