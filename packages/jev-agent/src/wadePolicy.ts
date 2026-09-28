// wadePolicy.ts - the PER-NEIGHBOR deep-water verdict for the path planner.
//
// THE MEASURED DEATH (portal-p19.2 live, run-mul2ky3e-6sas, 2026-09-28):
//
//   the body followed an ordinary MOVE leg into the water channel at
//   (9.5,59.3,-42.3); `ASCEND:breath` fired with air 8 -> 5 and the body
//   still drowned ~14 s later (`AI_Cap drowned`).
//
// Stock `mineflayer-pathfinder` (2.4.5) makes entry cheap and exit
// unplannable: `getMoveForward` emits a liquid destination for
// `liquidCost = 1`, but every vertical move refuses a liquid node
// (`dont go underwater` in `getMoveUp`/`getMoveDown`/`getMoveJumpUp`). Once
// the head goes under, the planner's only remaining degree of freedom is
// bottom-walking horizontally - it can never route the body back to the
// surface, so the submersion escape arm is left holding a hop it may not be
// able to finish. A movement policy that cannot plan underwater must not
// claim deep-water destinations in the first place.
//
// This module owns exactly ONE question per planned neighbor: is that
// destination a BOUNDED WADE - water at the feet cell over a solid floor with
// the head cell in air? That shape is mechanically safe (no breath drain) and
// is the shape the env-hazard fire escape relies on when it offers "step into
// the water to put the fire out". Every other liquid destination - head
// submerged, deeper water below, lava, or an unobserved column the wade proof
// cannot establish - is removed from the neighbor set, so a deep-water route
// degrades to the ordinary typed no-path/stuck refusal and the candidate
// layer's retry/alternate-site machinery owns what happens next.
//
// It NEVER chooses: filtering a neighbor is a feasibility fact, not a semantic
// preference - Jev still selects WHICH of the surviving grounded actions runs
// (#436).
//
// NOT UNKNOWN-IS-FALSE, deliberately: a liquid feet cell whose head or floor
// the world never proved safe IS refused. The measured alternative was a
// corpse, and the refusal direction is the survivable one for the only
// capability the executor actually has (wading, not swimming).

/** The block slice the verdict needs - a mineflayer `SafeBlock` or a fixture. */
export interface WadeProbeBlock {
  /** fluid flag (stock `liquids` set: water + lava) */
  readonly liquid?: boolean
  /** solid/collidable flag (`boundingBox !== 'empty'` upstream) */
  readonly physical?: boolean
  /** block name when the probe carries one; absent names are not refused */
  readonly name?: string
}

/** A cell the planner may occupy: feet position of a planned neighbor. */
export interface WadeMoveCell {
  readonly x: number
  readonly y: number
  readonly z: number
}

/**
 * Fluids a depth-1 wade may stand in. Lava is never wadeable regardless of
 * measured depth (contact burns even at ankle depth; it is also already in
 * the planner's `blocksToAvoid`, so refusing it here is belt-and-suspenders,
 * never a new permission). Flowing water still reads `water` upstream, but
 * `flowing_water` is kept for probes that report it distinctly.
 */
const WADEABLE_FLUIDS = new Set(['water', 'flowing_water'])

/**
 * True when the destination cell is a wade the body can survive: liquid feet
 * (a wadeable fluid), a proven non-liquid head cell, and a proven solid floor
 * directly below. Anything unproven or deeper answers false - the caller then
 * refuses the move rather than gambling on breath.
 */
export function isBoundedWadeDestination(
  feet: WadeProbeBlock | null,
  head: WadeProbeBlock | null,
  below: WadeProbeBlock | null,
): boolean {
  if (feet === null || feet.liquid !== true) return false
  if (feet.name !== undefined && !WADEABLE_FLUIDS.has(feet.name)) return false
  if (head === null || head.liquid === true) return false
  return below !== null && below.physical === true
}

/**
 * Remove every neighbor whose destination is a liquid cell that is NOT a
 * bounded wade. Destinations that are dry or provably shallow pass through
 * unchanged; `probe` is the planner's own `getBlock` (block at an absolute
 * cell, `null`/absent when unobserved).
 */
export function filterSubmersionDestinations<M extends WadeMoveCell>(
  moves: readonly M[],
  probe: (x: number, y: number, z: number) => WadeProbeBlock | null,
): M[] {
  return moves.filter((move) => {
    const feet = probe(move.x, move.y, move.z)
    if (feet === null || feet.liquid !== true) return true
    return isBoundedWadeDestination(
      feet,
      probe(move.x, move.y + 1, move.z),
      probe(move.x, move.y - 1, move.z),
    )
  })
}
