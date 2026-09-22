// system2-harness/grounding.ts - code owns grounding; the model may only
// reference refs deterministic code already exposed (#439 sections 5/27/28).
//
// Rules enforced here:
//   * a grounded ref that is not in the index FAILS CLOSED (unknown_grounded_ref);
//   * a grounded ref whose fact is known-absent fails closed with truth evidence;
//   * several valid candidates with no explicit model choice become an explicit
//     `choice` binding whose selectionAuthority is `jev_pi` - never a hidden
//     nearest-site preference;
//   * nothing at all becomes a symbolic search Objective, never a coordinate.

import type { GroundedRef, GroundedRefKind, PredicateArgScalar, TargetBinding } from './contract.ts'
import type { StationKind } from './predicateRegistry.ts'

export interface GroundedPortalSite {
  readonly refId: string
  /** Code-owned verification. `false` means known-not-verified, not "unknown". */
  readonly verified: boolean
  readonly dimension: string
  readonly frameBlocks?: number
}

export interface GroundedStation {
  readonly refId: string
  readonly kind: StationKind
  /** Code-owned usability (exists + reachable enough to be usable). */
  readonly usable: boolean
  readonly dimension: string
}

export interface GroundedOreCluster {
  readonly refId: string
  readonly item: string
  readonly dimension: string
  readonly observed: boolean
}

export interface GroundedEntity {
  readonly refId: string
  readonly entityClass: string
  readonly dimension: string
}

export interface GroundedPosition {
  readonly refId: string
  readonly x: number
  readonly y: number
  readonly z: number
  readonly dimension: string
  /** Where this ref came from, for the artifact (death point, station site...). */
  readonly source: string
}

export interface GroundedRegion {
  readonly refId: string
  readonly description: string
  readonly dimension: string
}

export interface GroundedOptionRef {
  readonly refId: string
  readonly optionInstanceId: string
}

/**
 * The deterministic world-memory view System2 is allowed to reference. Plain
 * data only: no Mineflayer objects, no live block handles.
 */
export interface GroundedWorldIndex {
  readonly worldKey: string
  readonly dimension: string
  readonly worldEpoch: number
  readonly portalSites: readonly GroundedPortalSite[]
  readonly stations: readonly GroundedStation[]
  readonly oreClusters: readonly GroundedOreCluster[]
  readonly entities: readonly GroundedEntity[]
  readonly positions: readonly GroundedPosition[]
  readonly regions: readonly GroundedRegion[]
  readonly optionRefs: readonly GroundedOptionRef[]
}

export function emptyWorldIndex(worldKey = 'local:overworld', dimension = 'overworld', worldEpoch = 0): GroundedWorldIndex {
  return {
    worldKey,
    dimension,
    worldEpoch,
    portalSites: [],
    stations: [],
    oreClusters: [],
    entities: [],
    positions: [],
    regions: [],
    optionRefs: [],
  }
}

export type RefResolution =
  | {
      readonly status: 'resolved'
      readonly ref: GroundedRef
      readonly facts: Readonly<Record<string, PredicateArgScalar>>
    }
  | { readonly status: 'not_found'; readonly ref: GroundedRef }
  | { readonly status: 'known_absent'; readonly ref: GroundedRef; readonly reason: string }

function baseFacts(ref: GroundedRef): Record<string, PredicateArgScalar> {
  return { refKind: ref.refKind, refId: ref.refId }
}

/**
 * Resolve one grounded ref against the live index. Unknown ids never become
 * targets: they are discarded by the compiler as `unknown_grounded_ref`.
 */
export function resolveGroundedRef(ref: GroundedRef, index: GroundedWorldIndex): RefResolution {
  switch (ref.refKind) {
    case 'portal_site': {
      const site = index.portalSites.find((candidate) => candidate.refId === ref.refId)
      if (site === undefined) return { status: 'not_found', ref }
      const facts: Record<string, PredicateArgScalar> = {
        ...baseFacts(ref),
        verified: site.verified,
        dimension: site.dimension,
        frameBlocks: site.frameBlocks ?? 0,
      }
      if (!site.verified) {
        return { status: 'known_absent', ref, reason: `portal site ${ref.refId} exists in world memory but is not code-verified` }
      }
      return { status: 'resolved', ref, facts }
    }
    case 'station': {
      const station = index.stations.find((candidate) => candidate.refId === ref.refId)
      if (station === undefined) return { status: 'not_found', ref }
      const facts: Record<string, PredicateArgScalar> = {
        ...baseFacts(ref),
        stationKind: station.kind,
        usable: station.usable,
        dimension: station.dimension,
      }
      if (!station.usable) {
        return { status: 'known_absent', ref, reason: `station ${ref.refId} (${station.kind}) is known but not usable` }
      }
      return { status: 'resolved', ref, facts }
    }
    case 'ore_cluster': {
      const cluster = index.oreClusters.find((candidate) => candidate.refId === ref.refId)
      if (cluster === undefined) return { status: 'not_found', ref }
      const facts: Record<string, PredicateArgScalar> = {
        ...baseFacts(ref),
        item: cluster.item,
        dimension: cluster.dimension,
        observed: cluster.observed,
      }
      return { status: 'resolved', ref, facts }
    }
    case 'entity': {
      const entity = index.entities.find((candidate) => candidate.refId === ref.refId)
      if (entity === undefined) return { status: 'not_found', ref }
      return {
        status: 'resolved',
        ref,
        facts: { ...baseFacts(ref), entityClass: entity.entityClass, dimension: entity.dimension },
      }
    }
    case 'position': {
      const position = index.positions.find((candidate) => candidate.refId === ref.refId)
      if (position === undefined) return { status: 'not_found', ref }
      return {
        status: 'resolved',
        ref,
        facts: { ...baseFacts(ref), source: position.source, dimension: position.dimension },
      }
    }
    case 'region': {
      const region = index.regions.find((candidate) => candidate.refId === ref.refId)
      if (region === undefined) return { status: 'not_found', ref }
      return { status: 'resolved', ref, facts: { ...baseFacts(ref), description: region.description } }
    }
    case 'option': {
      const option = index.optionRefs.find((candidate) => candidate.refId === ref.refId)
      if (option === undefined) return { status: 'not_found', ref }
      return { status: 'resolved', ref, facts: { ...baseFacts(ref), optionInstanceId: option.optionInstanceId } }
    }
  }
}

/** Every ref of a kind the index currently exposes, in deterministic id order. */
export function refsOfKind(refKind: GroundedRefKind, index: GroundedWorldIndex): readonly GroundedRef[] {
  const refs: GroundedRef[] = []
  const push = (refId: string): void => {
    refs.push({ kind: 'grounded', refKind, refId })
  }
  switch (refKind) {
    case 'portal_site':
      for (const site of index.portalSites) push(site.refId)
      break
    case 'station':
      for (const station of index.stations) push(station.refId)
      break
    case 'ore_cluster':
      for (const cluster of index.oreClusters) push(cluster.refId)
      break
    case 'entity':
      for (const entity of index.entities) push(entity.refId)
      break
    case 'position':
      for (const position of index.positions) push(position.refId)
      break
    case 'region':
      for (const region of index.regions) push(region.refId)
      break
    case 'option':
      for (const option of index.optionRefs) push(option.refId)
      break
  }
  return refs.sort((left, right) => left.refId.localeCompare(right.refId))
}

/**
 * Verified candidates of a kind: the only refs a semantic operation may bind to
 * without a further truth check. Deterministic id order, no distance ranking.
 */
export function verifiedRefsOfKind(refKind: GroundedRefKind, index: GroundedWorldIndex): readonly GroundedRef[] {
  return refsOfKind(refKind, index).filter((ref) => resolveGroundedRef(ref, index).status === 'resolved')
}

export interface CandidateExposure {
  readonly refKind: GroundedRefKind
  readonly verified: readonly GroundedRef[]
  readonly presentButUnverified: readonly GroundedRef[]
}

/**
 * Expose the candidate set for a symbolic target so the *model* (or Jev, via the
 * `choice` binding) selects among grounded ids instead of the harness silently
 * picking the nearest one (#439 section 27).
 */
export function exposeCandidates(refKind: GroundedRefKind, index: GroundedWorldIndex): CandidateExposure {
  const all = refsOfKind(refKind, index)
  const verified: GroundedRef[] = []
  const presentButUnverified: GroundedRef[] = []
  for (const ref of all) {
    if (resolveGroundedRef(ref, index).status === 'resolved') verified.push(ref)
    else presentButUnverified.push(ref)
  }
  return { refKind, verified, presentButUnverified }
}

export function groundedBinding(ref: GroundedRef, index: GroundedWorldIndex): TargetBinding | null {
  const resolution = resolveGroundedRef(ref, index)
  if (resolution.status !== 'resolved') return null
  return { kind: 'grounded', ref: resolution.ref, facts: resolution.facts }
}

export function choiceBinding(candidates: readonly GroundedRef[]): TargetBinding {
  return { kind: 'choice', candidates: [...candidates], selectionAuthority: 'jev_pi' }
}
