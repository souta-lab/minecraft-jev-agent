/** World blocks that are durable stations, not disposable route terrain. */
export const PROTECTED_STATION_BLOCKS: ReadonlySet<string> = new Set([
  'crafting_table',
  'furnace',
  'blast_furnace',
  'smoker',
])

export function isProtectedStationBlock(name: string): boolean {
  const normalized = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name
  return PROTECTED_STATION_BLOCKS.has(normalized)
}

// ---------------------------------------------------------------------------
// live-structure membership: a general source-protection predicate
// ---------------------------------------------------------------------------
//
// `PROTECTED_STATION_BLOCKS` above protects a block by its NAME. That is not
// enough for a structure the agent depends on: an obsidian block in a live
// portal FRAME and an identical obsidian block in a wall are the same name, and
// only one of them may be harvested. The fact that distinguishes them is
// MEMBERSHIP in a structure the world model currently validates, not the block's
// name or the word used to describe the structure.
//
// A structure validator (today the Nether-portal frame validator; any other
// validated structure later) contributes its member cells as
// `LiveStructureMember` facts. The sourcing layer (candidates.ts) refuses those
// cells generically - it never matches on `kind`, so it cannot special-case a
// feature. This predicate is a world-model truth, never a preference:
//
//   a block is excluded as a collect/mine source IFF its cell is a member of a
//   structure the world model currently holds as LIVE.
//
// A structure stops being live when its required geometry stops validating in
// the model (damaged, partially built, or removed), which is exactly the case
// where harvesting its blocks is legitimate deconstruction.

/** One world cell that belongs to a currently-valid structure. */
export interface LiveStructureMember {
  /** Diagnostic structure kind (for example `nether_portal`). Never matched on. */
  kind: string
  position: { x: number; y: number; z: number }
}

/** Stable key for one world cell; the same encoding used for block ids. */
export function liveStructureCellKey(position: { x: number; y: number; z: number }): string {
  return `${position.x},${position.y},${position.z}`
}

/**
 * Index every live-structure member by cell for O(1) source checks. The first
 * structure to claim a cell wins; membership is a boolean fact, so the winner's
 * kind is diagnostic only.
 */
export function liveStructureMemberIndex(
  members: readonly LiveStructureMember[] | undefined,
): ReadonlyMap<string, string> {
  const index = new Map<string, string>()
  for (const member of members ?? []) {
    const key = liveStructureCellKey(member.position)
    if (!index.has(key)) index.set(key, member.kind)
  }
  return index
}

/** The general source-protection predicate. Pure; true means "not a source". */
export function isLiveStructureMember(
  index: ReadonlyMap<string, string>,
  position: { x: number; y: number; z: number },
): boolean {
  return index.has(liveStructureCellKey(position))
}
