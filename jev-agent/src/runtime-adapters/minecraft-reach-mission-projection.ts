import type { Candidate, CandidateOptions } from '../candidates.ts'
import {
  applyGroundedThreatRestriction,
  generateGroundedCandidates,
  restrictCandidatesAtCriticalHealth,
  restrictCandidatesDuringCriticalDamage,
  restrictCandidatesDuringEnvHazard,
  restrictCandidatesDuringSubmersion,
  restrictCandidatesDuringUnseenAttacker,
} from '../candidates.ts'
import { envelopeForCandidate } from '../skillCommitment.ts'
import { scannedBlockNames } from '../state.ts'
import type { WorldState } from '../state.ts'
import { projectReachMissionSnapshot } from '../vtr/reach-mission-projection.ts'
import type { ReachMissionRouteFact, ReachMissionSnapshotOptions } from '../vtr/reach-mission-projection.ts'
import type { ReachRuntimeSnapshot } from '../vtr/reach-controller.ts'
import type { ReachRuntimeActionSnapshot } from '../vtr/reach-runtime-ports.ts'
import type { ReachIdentity, ReachTransitionContract } from '../vtr/reach.ts'
import { countMissionInventoryResource } from '../vtr/reach.ts'
import type { InventoryReachMission } from '../vtr/reach-scheduler.ts'
import { missionResourceSourceMatches } from '../vtr/reach.ts'

/**
 * Mineflayer-era observation/candidate adapter for the production Reach slice.
 * Minecraft `WorldState` and Candidate types terminate here; VTR consumes the
 * backend-neutral snapshot produced by `projectReachMissionSnapshot`.
 *
 * Deletion condition: replace this adapter when the canonical Minecraft
 * Runtime Adapter exposes typed resource-source, locomotion-route, inventory,
 * body, identity and viability facts directly to ReachMissionRuntime. Until
 * then it is the only translation point for the legacy candidate schema.
 */
export interface MinecraftReachMissionProjectionInput {
  readonly mission: InventoryReachMission
  readonly world: WorldState
  readonly candidateOptions: CandidateOptions
  readonly identity: ReachIdentity
  readonly witnessIdentity: ReachIdentity | null
  readonly contract: ReachTransitionContract | null
  readonly previousFrontierId: string | null
  readonly previousActionFailure: string | null
  readonly snapshotOptions?: ReachMissionSnapshotOptions
}

export interface MinecraftReachMissionRouteProjectionInput extends Omit<MinecraftReachMissionProjectionInput, 'candidateOptions'> {
  readonly candidates: readonly Candidate[]
  readonly inadmissibleCandidates?: readonly Candidate[]
}

export interface MinecraftReachMissionProjection {
  readonly snapshot: ReachRuntimeSnapshot
  /** Candidate DTOs whose route/witness facts survived pure projection. */
  readonly candidates: readonly Candidate[]
  readonly sourceCandidates: readonly Candidate[]
  readonly inadmissibleCandidates: readonly Candidate[]
  readonly missionSourceNames: readonly string[]
  readonly missionSatisfiedEvidenceId?: string
  readonly ensuresAlreadyTrueEvidenceId?: string
}

function distance(a: { readonly x: number; readonly y: number; readonly z: number }, b: { readonly x: number; readonly y: number; readonly z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

export function minecraftMissionSourceNames(item: string): readonly string[] {
  const names = new Set(scannedBlockNames(item) ?? [])
  if (item.endsWith('_log')) names.add(item)
  return [...names].sort()
}

/**
 * Derive whether a legacy MOVE's real Executor envelope is locomotion only.
 * Explicit NONE sentinels do not grant dig/place authority.
 */
export function reachMoveFitsLocomotionContract(candidate: Candidate): boolean {
  if (candidate.kind !== 'MOVE' || candidate.meta.mayPlaceBlocks === true || candidate.id.startsWith('BRIDGE:')) return false
  const envelope = envelopeForCandidate(candidate)
  return (envelope.mayDigBlocks?.length ?? 0) === 0 &&
    envelope.mayDigGroundedRoute !== true &&
    (envelope.mayPlaceBlocks?.length ?? 0) === 0 &&
    envelope.mayPlaceGroundedRoute !== true
}

/** Match a grounded mission-source MOVE to an exact currently sensed source cell. */
export function isMissionReachSourceCandidate(
  candidate: Candidate,
  world: Pick<WorldState, 'blocks'>,
  item: string,
  sourceNames: readonly string[],
): boolean {
  if (candidate.kind !== 'MOVE' || candidate.target === null || candidate.meta.explore === true) return false
  const sourceName = typeof candidate.meta.targetBlockName === 'string' ? candidate.meta.targetBlockName : candidate.targetName
  const x = candidate.meta.targetBlockX
  const y = candidate.meta.targetBlockY
  const z = candidate.meta.targetBlockZ
  return missionResourceSourceMatches(item, sourceName, null, sourceNames) &&
    typeof x === 'number' && Number.isFinite(x) &&
    typeof y === 'number' && Number.isFinite(y) &&
    typeof z === 'number' && Number.isFinite(z) &&
    world.blocks.some((block) => block.name === sourceName && block.position.x === x && block.position.y === y && block.position.z === z)
}

export function hasReachableMissionSource(
  world: Pick<WorldState, 'blocks'>,
  item: string,
  sourceNames: readonly string[] = minecraftMissionSourceNames(item),
): boolean {
  return world.blocks.some((block) =>
    missionResourceSourceMatches(item, block.name, block.yield, sourceNames) && block.inReach && block.visible !== false,
  )
}

/**
 * Strangler boundary at the legacy candidate/claim edge. The V4.1.2 kernel is
 * the sole Reach authority for the configured Mission, so a grounded
 * same-mission-source MOVE is withheld from legacy scheduling unconditionally
 * — a denied/held VTR decision must never fall back into a same-body
 * same-predicate legacy walk.
 *
 * Delete this filter when the legacy candidate/claim path no longer owns
 * Mission semantics and scheduler dispatch crosses only typed runtime ports.
 */
export function filterLegacyReachCandidates(input: {
  readonly candidates: readonly Candidate[]
  readonly world: Pick<WorldState, 'blocks'>
  readonly missionItem: string
  readonly missionSourceNames: readonly string[]
}): { readonly candidates: Candidate[]; readonly withheld: Candidate[] } {
  const candidates: Candidate[] = []
  const withheld: Candidate[] = []
  for (const candidate of input.candidates) {
    if (isMissionReachSourceCandidate(candidate, input.world, input.missionItem, input.missionSourceNames)) withheld.push(candidate)
    else candidates.push(candidate)
  }
  return { candidates, withheld }
}

export function isMissionReachWalkAction(
  action: ReachRuntimeActionSnapshot,
  item: string,
  dimension: string,
  worldEpoch: number,
  sourceNames: readonly string[],
): boolean {
  const commitment = action.commitment
  if (action.authority === 'vtr-reach' || action.kind !== 'MOVE' || commitment?.skillKind !== 'walk_to') return false
  const sourceName = commitment.params.targetName
  if (typeof sourceName !== 'string' || !missionResourceSourceMatches(item, sourceName, null, sourceNames)) return false
  return commitment.target.kind === 'position' &&
    commitment.target.dimension === dimension &&
    commitment.target.worldEpoch === worldEpoch
}

function routeFact(candidate: Candidate): ReachMissionRouteFact {
  const x = candidate.meta.targetBlockX
  const y = candidate.meta.targetBlockY
  const z = candidate.meta.targetBlockZ
  return {
    routeId: candidate.id,
    kind: candidate.kind,
    target: candidate.target,
    sourceName: typeof candidate.meta.targetBlockName === 'string' ? candidate.meta.targetBlockName : candidate.targetName,
    sourcePosition: typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y) && typeof z === 'number' && Number.isFinite(z)
      ? { x, y, z }
      : null,
    explore: candidate.meta.explore === true,
  }
}

/**
 * Assemble Reach candidate and evidence DTOs from the legacy typed observation.
 * This function is deterministic and owns no body/client reference.
 */
export function projectMinecraftReachMission(input: MinecraftReachMissionProjectionInput): MinecraftReachMissionProjection {
  const { mission, world } = input
  const sourceNames = minecraftMissionSourceNames(mission.item)
  const grounded = generateGroundedCandidates(world, input.candidateOptions)
  const threatOffer = applyGroundedThreatRestriction(world, grounded.candidates, grounded.withheld)
  let sourceCandidates = threatOffer.candidates
    .filter((candidate) => isMissionReachSourceCandidate(candidate, world, mission.item, sourceNames))
    .filter(reachMoveFitsLocomotionContract)
  sourceCandidates = restrictCandidatesAtCriticalHealth(world, sourceCandidates)
  sourceCandidates = restrictCandidatesDuringSubmersion(world, sourceCandidates)
  sourceCandidates = restrictCandidatesDuringCriticalDamage(world, sourceCandidates)
  sourceCandidates = restrictCandidatesDuringUnseenAttacker(world, sourceCandidates)
  sourceCandidates = restrictCandidatesDuringEnvHazard(world, sourceCandidates)
  sourceCandidates.sort((a, b) =>
    distance(world.self.position, a.target!) - distance(world.self.position, b.target!) || a.id.localeCompare(b.id),
  )

  const inadmissibleCandidates = input.contract === null
    ? grounded.candidates.filter((candidate) =>
        isMissionReachSourceCandidate(candidate, world, mission.item, sourceNames) &&
        !reachMoveFitsLocomotionContract(candidate),
      )
    : []
  return projectMinecraftReachRoutes({
    ...input,
    candidates: sourceCandidates,
    inadmissibleCandidates,
  })
}

/** Project a typed candidate-provider result without rerunning candidate generation. */
export function projectMinecraftReachRoutes(input: MinecraftReachMissionRouteProjectionInput): MinecraftReachMissionProjection {
  const { mission, world } = input
  const sourceNames = minecraftMissionSourceNames(mission.item)
  const sources = world.blocks.map((block) => ({
    name: block.name,
    yieldedItem: block.yield ?? null,
    position: block.position,
    inReach: block.inReach,
    visible: block.visible !== false,
  }))
  const required = Math.max(1, Math.floor(mission.count))
  const have = countMissionInventoryResource(world.inventory.counts, mission.item)
  const missionSatisfiedEvidenceId = have >= required
    ? `inventory:${world.timestampMs}:${mission.item}=${have}/${required}`
    : undefined
  const snapshotOptions = {
    ...(input.contract !== null && missionSatisfiedEvidenceId !== undefined
      ? { parentMissionSatisfied: { evidenceId: missionSatisfiedEvidenceId } }
      : {}),
    ...input.snapshotOptions,
  }
  const projection = projectReachMissionSnapshot({
    mission,
    identity: input.identity,
    witnessIdentity: input.witnessIdentity,
    tick: world.tick,
    observedAtMs: world.timestampMs,
    bodyPosition: world.self.position,
    bodyHealth: world.self.health,
    inventoryCounts: world.inventory.counts,
    knownSourceNames: sourceNames,
    sources,
    routes: input.candidates.map(routeFact),
    options: {
      ...(input.contract === null ? {} : { desiredPredicateIdentity: input.contract.desiredPredicateIdentity }),
      previousFrontierId: input.previousFrontierId,
      tactic: input.previousActionFailure === null ? 'walk' : 'path_replan',
      ...snapshotOptions,
    },
  })
  const routeIds = new Set(projection.groundedRouteIds)
  const candidates = input.candidates.filter((candidate) => routeIds.has(candidate.id))
  return {
    snapshot: projection.snapshot,
    candidates,
    sourceCandidates: input.candidates,
    inadmissibleCandidates: input.inadmissibleCandidates ?? [],
    missionSourceNames: sourceNames,
    ...(projection.missionSatisfiedEvidenceId === undefined ? {} : { missionSatisfiedEvidenceId: projection.missionSatisfiedEvidenceId }),
    ...(projection.ensuresAlreadyTrueEvidenceId === undefined ? {} : { ensuresAlreadyTrueEvidenceId: projection.ensuresAlreadyTrueEvidenceId }),
  }
}

/** Options that depend on Mineflayer path probes stay injected as typed values. */
