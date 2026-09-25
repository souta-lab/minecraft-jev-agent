import type { Candidate } from '../candidates.ts'
import type { WorldState } from '../state.ts'
import { missionResourceSourceMatches } from './reach.ts'

/**
 * Temporary strangler boundary for the old Jev candidate plane.
 *
 * While VTR has first refusal on a Mission's Reach predicate, the legacy plane
 * must not re-offer that same source-approach MOVE after VTR declines to commit
 * this tick. Other grounded legacy work remains eligible. Delete this filter
 * when the legacy candidate/claim path no longer owns Mission semantics and the
 * VTR scheduler uses the typed Minecraft runtime ports end to end.
 */
export function filterLegacyReachCandidates(input: {
  readonly candidates: readonly Candidate[]
  readonly world: Pick<WorldState, 'blocks'>
  readonly missionItem: string
  readonly missionSourceNames: readonly string[]
  readonly vtrOwnsReachMove: boolean
}): { readonly candidates: Candidate[]; readonly withheld: Candidate[] } {
  if (!input.vtrOwnsReachMove) return { candidates: [...input.candidates], withheld: [] }

  const candidates: Candidate[] = []
  const withheld: Candidate[] = []
  for (const candidate of input.candidates) {
    if (isLegacyMissionReachSourceMove(candidate, input.world, input.missionItem, input.missionSourceNames)) {
      withheld.push(candidate)
    } else {
      candidates.push(candidate)
    }
  }
  return { candidates, withheld }
}

/** Match only a grounded MOVE to a currently observed source for this Mission. */
export function isLegacyMissionReachSourceMove(
  candidate: Candidate,
  world: Pick<WorldState, 'blocks'>,
  item: string,
  sourceNames: readonly string[],
): boolean {
  if (candidate.kind !== 'MOVE' || candidate.target === null || candidate.meta.explore === true) return false
  const name = typeof candidate.meta.targetBlockName === 'string' ? candidate.meta.targetBlockName : candidate.targetName
  const x = candidate.meta.targetBlockX
  const y = candidate.meta.targetBlockY
  const z = candidate.meta.targetBlockZ
  return (
    missionResourceSourceMatches(item, name, null, sourceNames) &&
    typeof x === 'number' && typeof y === 'number' && typeof z === 'number' &&
    world.blocks.some((block) => block.name === name && block.position.x === x && block.position.y === y && block.position.z === z)
  )
}
