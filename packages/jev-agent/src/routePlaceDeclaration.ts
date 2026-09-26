// routePlaceDeclaration.ts - the ONE vocabulary for "the block(s) a locomotion
// route's OWN placement step consumes".
//
// WHY THIS MODULE EXISTS (measured defect, live run at main cd7b38b):
//
//   SKILL_ENVELOPE_VIOLATION actionId=RETRIEVE:known:blaze_rod:b35_60_-22
//     effect={"type":"equip","itemName":"cobblestone","destination":"hand"}
//     violation=equip_item_not_declared:cobblestone
//
//   `executor.ts#groundedEquipItems` authorized, for a route-opening locomotion
//   candidate (`meta.digRoute === true || meta.vertical !== undefined`), only the
//   carried TOOL families (`ROUTE_TOOL_SUFFIXES`) plus the single block a BRIDGE
//   MOVE declares (`meta.bridgeBlock`). A vertical PILLAR route therefore could
//   not equip the very block its own pillar step equips and places - the block the
//   route had ALREADY grounded and named in `meta.pillarPlaceName` (the exact key
//   `executor.ts#runVerticalLeg` reads before `pillarUp` equips it). The commitment
//   refused the equip, the route was spent, and the body could not climb.
//
// The fix is a DECLARATION, never a widening: a locomotion candidate authorizes
// exactly the blocks its own route named at candidate time. This module is the
// single reader of that declaration, so the executor's authorization, the
// commitment's `EffectEnvelope` and the run-scoped marker cannot drift apart:
//
//   * `meta.bridgeBlock`      - a BRIDGE MOVE's one block (`bridgeRoute.ts`), read
//                               by `executor.ts#runBridge`;
//   * `meta.pillarPlaceName`  - a PILLAR route's block (`candidates.ts#verticalPlanMeta`),
//                               read by `executor.ts#runVerticalLeg`;
//   * `meta.fallbackPillarPlaceName` - the same for the route's own grounded
//                               PILLAR FALLBACK (`candidates.ts#fallbackVerticalMeta`).
//
// "Any carried placeable block" is deliberately NOT a rule here: an ordinary walk
// (no declared route) still authorizes no equip, and a route that declared nothing
// placeable authorizes no block even when a `PILLAR_PLACE_PRIORITY` block is
// carried. When a route genuinely grounds several blocks, EVERY declared one is
// returned, in declaration order - this module never ranks and never picks.
//
// Pure: no bot, no inventory, no clock. The caller supplies the carried counts.

import { BRIDGE_BLOCK_META, BRIDGE_META } from './bridgeRoute.ts'
import { DESCEND_SCAFFOLD_BLOCK_META, DESCEND_SCAFFOLD_PLACE_META } from './descentScaffold.ts'

/** The pillar route's declared place block: the key `executor.ts#runVerticalLeg` reads. */
export const PILLAR_PLACE_NAME_META = 'pillarPlaceName'
/** The same declaration for the route's own grounded pillar FALLBACK column. */
export const FALLBACK_PILLAR_PLACE_NAME_META = 'fallbackPillarPlaceName'

/**
 * The marker that makes the declaration run-scoped evidence. Without it the only
 * thing a reviewer sees after this fix is a DIFFERENT `SKILL_COMMIT
 * effectEnvelopeHash=` value - not WHICH block the route declared or where the
 * authority came from. Registered in `controller.ts#MIRRORED_MARKERS`,
 * because an unmirrored marker never reaches `buddy.log`.
 */
export const ROUTE_PLACE_DECLARED = 'ROUTE_PLACE_DECLARED'

/** The candidate kinds whose OWN route may carry a placement step. */
const LOCOMOTION_KINDS: ReadonlySet<string> = new Set([
  'DESCEND',
  'STEP',
  'MOVE',
  'RETRIEVE',
  'RETREAT',
  'ENTER_PORTAL',
])

/** One declared block and the candidate-meta key that declared it (audit trail). */
export interface RoutePlaceDeclaration {
  /** the item name the route's own placement step consumes */
  block: string
  /** the meta key the declaration came from (never a synthesized reason) */
  source: string
}

function readMetaString(candidate: RoutePlaceCandidate, key: string): string | null {
  const value = candidate.meta[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Structural candidate shape, so the pure reader and the fixtures can both feed it. */
export interface RoutePlaceCandidate {
  kind: string
  meta: Record<string, string | number | boolean>
}

/**
 * Every block this locomotion candidate's own grounded route declared it may
 * consume, in declaration order (bridge first - it is the reference declaration -
 * then the pillar route, then its pillar fallback). De-duplicated by block name, so
 * a route that names the same block twice declares it once. Empty for a candidate
 * that is not a locomotion route, for a walk with no declared route, and for a
 * route that declared no placement at all.
 */
export function declaredRoutePlacements(candidate: RoutePlaceCandidate): RoutePlaceDeclaration[] {
  if (!LOCOMOTION_KINDS.has(candidate.kind)) return []
  const declarations: RoutePlaceDeclaration[] = []
  // The BRIDGE declaration: `meta.bridge === true` + the one block it consumes.
  if (candidate.meta[BRIDGE_META] === true) {
    const block = readMetaString(candidate, BRIDGE_BLOCK_META)
    if (block !== null) declarations.push({ block, source: BRIDGE_BLOCK_META })
  }
  // The DOWNWARD SELF-LANDING declaration: a DESCEND leg that creates the floor it
  // lands on. The exact cell it places into is declared too
  // (`DESCEND_SCAFFOLD_PLACE_META`), because a descent placement is a cell BELOW
  // the body that no other route can name - the envelope authorizes the block AND
  // the one cell, never "any carried placeable block".
  if (candidate.meta[DESCEND_SCAFFOLD_PLACE_META] !== undefined) {
    const block = readMetaString(candidate, DESCEND_SCAFFOLD_BLOCK_META)
    if (block !== null) declarations.push({ block, source: DESCEND_SCAFFOLD_BLOCK_META })
  }
  // The VERTICAL declaration: the same keys the executor's pillar leg reads.
  for (const key of [PILLAR_PLACE_NAME_META, FALLBACK_PILLAR_PLACE_NAME_META]) {
    const block = readMetaString(candidate, key)
    if (block !== null) declarations.push({ block, source: key })
  }
  const seen = new Set<string>()
  return declarations.filter((entry) => {
    if (seen.has(entry.block)) return false
    seen.add(entry.block)
    return true
  })
}

/** The declared block names alone (the shape the effect envelope authorizes). */
export function declaredRoutePlaceBlocks(candidate: RoutePlaceCandidate): string[] {
  return declaredRoutePlacements(candidate).map((entry) => entry.block)
}

/**
 * `ROUTE_PLACE_DECLARED actionId=<id> skill=<kind> blocks=<declared> source=<keys> carried=<held>`
 *
 * Emitted once per commitment build, when the selected locomotion route declared
 * a placement step. `blocks` is the DECLARED set (several names when the route
 * genuinely grounded several - code never ranks them), `source` names the exact
 * meta keys, and `carried` is which of them the body holds right now, so a
 * reviewer can tell "declared but not held" from "no declaration at all".
 */
export function formatRoutePlaceDeclared(input: {
  actionId: string
  skillKind: string
  declarations: readonly RoutePlaceDeclaration[]
  held: Readonly<Record<string, number>>
}): string {
  const blocks = input.declarations.map((entry) => entry.block).join(',')
  const sources = [...new Set(input.declarations.map((entry) => entry.source))].join(',')
  const carried = input.declarations
    .filter((entry) => (input.held[entry.block] ?? 0) > 0)
    .map((entry) => entry.block)
  return (
    `ROUTE_PLACE_DECLARED actionId=${input.actionId} skill=${input.skillKind} blocks=${blocks === '' ? 'none' : blocks}` +
    ` source=${sources === '' ? 'none' : sources} carried=${carried.length === 0 ? 'none' : carried.join(',')}`
  )
}
