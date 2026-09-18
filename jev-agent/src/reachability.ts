// reachability.ts - the deterministic affordance gate (#11 v2, owner's root
// cause: "AIBuddy tries to go to places it cannot reach").
//
// A locomotion target is an affordance, not a wish. This module decides, from
// FACTS (pathfinder probe result, vertical gap + whether an ascend/descend plan
// is mechanically available, required tool tier for any block that must be
// broken, standable approach cells, hazard flags), whether a candidate target is
// mechanically reachable right now:
//
//   reachable    -> evaluateReachability(...).reachable === true
//   unreachable  -> a typed reason + the capabilities that would make it
//                   reachable (obtain a tool, gain a placeable block, clear
//                   headroom, ...). Never a silent retry.
//
// Live evidence for the bug this gates (run-mu5qd4ah-3xdh / buddy-driver
// logs/jev/run.jsonl, main d8a7a72): the bot at y=9-14 was presented
// `RETRIEVE:known:station:furnace:b29_61_35` (dy=52) 245x, plus 1982x
// `packet locomotion blocked before (29,61,35)`, 509x `no jump headroom at
// (39,11,34)`, and `PILLAR_REFUSED reason=no_footing|no_headroom cause=needs_tool`
// while holding no pickaxe - the ascend plan could never execute, yet the target
// was re-offered every tick.
//
// Pure: no bot, no clock, no model. Same facts in -> same verdict out.
import type { HarvestTool, Vec3Json } from './state.ts'
import { PICKAXE_RANKS, distance } from './state.ts'

export type ReachabilityReason =
  | 'reachable'
  | 'no_path'
  | 'needs_ascend'
  | 'needs_descend'
  | 'missing_tool'
  | 'no_standable_approach'
  | 'out_of_reach'
  | 'hazard_blocked'

/** Vertical gap (blocks) a `canDig=false` body change can walk without a plan. */
export const ASCEND_GAP_LIMIT = 4
export const DESCEND_GAP_LIMIT = 4
/** A hazard this close to the destination blocks it (mirrors policy LAVA_PROXIMITY). */
export const HAZARD_PROXIMITY = 1.5

/** Something the body lacks that would make a target reachable if acquired. */
export type Capability =
  | { kind: 'tool'; tool: HarvestTool; tier: number }
  | { kind: 'placeable_block' }
  | { kind: 'headroom'; cell: Vec3Json | null }
  | { kind: 'safe_column' }
  | { kind: 'ascend_plan' }
  | { kind: 'descend_plan' }
  | { kind: 'open_path' }
  | { kind: 'standable_approach' }

/** A block that must be broken before the target is reachable, with its tool facts. */
export interface ReachabilityBarrier {
  position: Vec3Json
  name: string
  requiredTool: HarvestTool | null
  /** minimum rank on the PICKAXE_RANKS scale when `requiredTool === 'pickaxe'` */
  requiredTier: number | null
}

export interface ReachabilityTarget {
  candidateId: string
  kind: string
  /** destination cell; null means "not a locomotion target" (always feasible) */
  position: Vec3Json | null
  barrier: ReachabilityBarrier | null
}

/** World facts about the destination and the body's current column. */
export interface ReachabilityWorld {
  self: Vec3Json
  /** standable feet cell at/adjacent to the target, null when none exists */
  approach: Vec3Json | null
  /** interaction reach from the eyes (blocks) */
  reach: number
  /** a hazard cell is adjacent to the destination */
  hazardAtTarget: boolean
  /** solid support under the bot's feet (pillar/footing precondition) */
  footingSolid: boolean
  /** the bot's own column has jump headroom */
  headroomClear: boolean
}

export interface AscendAbility {
  available: boolean
  /** every missing prerequisite (placeable block, headroom cell, safe column, plan) */
  missing: Capability[]
}

export interface DescendAbility {
  available: boolean
  missing: Capability[]
}

export interface ReachabilityAbilities {
  ascend: AscendAbility
  descend: DescendAbility
}

export type PathProbeResult = 'reachable' | 'no_path' | 'unknown'

export interface ReachabilityResult {
  reachable: boolean
  reason: ReachabilityReason
  missingCapabilities: Capability[]
}

const REACHABLE: ReachabilityResult = { reachable: true, reason: 'reachable', missingCapabilities: [] }

function unreachable(reason: ReachabilityReason, missingCapabilities: Capability[]): ReachabilityResult {
  return { reachable: false, reason, missingCapabilities }
}

/** Best held rank for a tool family; -1 means the family is not held at all. */
export function bestToolTier(counts: Readonly<Record<string, number>>, tool: HarvestTool): number {
  let best = -1
  for (const [name, count] of Object.entries(counts)) {
    if (count <= 0) continue
    if (tool === 'pickaxe') {
      const rank = PICKAXE_RANKS[name]
      if (rank !== undefined && rank > best) best = rank
      continue
    }
    if (name.endsWith(`_${tool}`) && best < 0) best = 0
  }
  return best
}

/** The `tool` capability for a barrier the inventory cannot break, or null. */
function missingToolCapability(
  barrier: ReachabilityBarrier | null,
  inventory: Readonly<Record<string, number>>,
): Capability | null {
  if (barrier === null || barrier.requiredTool === null) return null
  const required = barrier.requiredTier ?? 0
  if (bestToolTier(inventory, barrier.requiredTool) >= required) return null
  return { kind: 'tool', tool: barrier.requiredTool, tier: required }
}

function ascendCapabilities(ability: AscendAbility): Capability[] {
  if (ability.available) return []
  return ability.missing.length > 0 ? ability.missing : [{ kind: 'ascend_plan' }]
}

function descendCapabilities(ability: DescendAbility): Capability[] {
  if (ability.available) return []
  return ability.missing.length > 0 ? ability.missing : [{ kind: 'descend_plan' }]
}

/**
 * The mechanic decision. Precedence is deterministic and fact-ordered:
 * hazard > missing tool for a mandatory break > vertical gap > path > approach.
 */
export function evaluateReachability(
  target: ReachabilityTarget,
  world: ReachabilityWorld,
  inventory: Readonly<Record<string, number>>,
  abilities: ReachabilityAbilities,
  pathProbe: PathProbeResult,
): ReachabilityResult {
  if (target.position === null) return REACHABLE
  if (world.hazardAtTarget) return unreachable('hazard_blocked', [])

  const toolCapability = missingToolCapability(target.barrier, inventory)
  if (toolCapability !== null) return unreachable('missing_tool', [toolCapability])

  const dy = Math.round(target.position.y - world.self.y)
  if (dy > ASCEND_GAP_LIMIT) {
    if (!abilities.ascend.available) {
      return unreachable('needs_ascend', ascendCapabilities(abilities.ascend))
    }
  } else if (dy < -DESCEND_GAP_LIMIT && !abilities.descend.available) {
    return unreachable('needs_descend', descendCapabilities(abilities.descend))
  }

  if (pathProbe === 'no_path') {
    return unreachable('no_path', [{ kind: 'open_path' }])
  }
  if (world.approach === null) {
    return unreachable(pathProbe === 'reachable' ? 'out_of_reach' : 'no_standable_approach', [
      { kind: 'standable_approach' },
    ])
  }
  if (distance(world.approach, target.position) > world.reach && distance(world.self, target.position) > world.reach) {
    return unreachable('out_of_reach', [{ kind: 'standable_approach' }])
  }
  return REACHABLE
}

/** Compact serialization of one capability, used in markers and fingerprints. */
export function capabilityKey(capability: Capability): string {
  switch (capability.kind) {
    case 'tool':
      return `tool:${capability.tool}@${capability.tier}`
    case 'placeable_block':
      return 'placeable_block'
    case 'headroom':
      return capability.cell === null
        ? 'headroom'
        : `headroom@${capability.cell.x},${capability.cell.y},${capability.cell.z}`
    case 'safe_column':
      return 'safe_column'
    case 'ascend_plan':
      return 'ascend_plan'
    case 'descend_plan':
      return 'descend_plan'
    case 'open_path':
      return 'open_path'
    case 'standable_approach':
      return 'standable_approach'
  }
}

export function formatMissingCapabilities(capabilities: readonly Capability[]): string {
  return `[${capabilities.map(capabilityKey).join(',')}]`
}

function targetLabel(position: Vec3Json | null): string {
  return position === null ? 'none' : `${position.x},${position.y},${position.z}`
}

/** The observability marker for one reachability evaluation. */
export function formatReachability(target: ReachabilityTarget, result: ReachabilityResult): string {
  return `REACHABILITY target=${targetLabel(target.position)} reachable=${result.reachable} reason=${result.reason} missing=${formatMissingCapabilities(result.missingCapabilities)}`
}

/** The observability marker for a candidate the affordance gate withheld. */
export function formatCandidateWithheld(candidateId: string, reason: ReachabilityReason): string {
  return `CANDIDATE_WITHHELD reason=${reason} candidate=${candidateId}`
}

/** Stable, semantic state fingerprint for a target's reachability verdict (#11 v2 §6). */
export interface ReachabilityFingerprintInput {
  target: ReachabilityTarget
  result: ReachabilityResult
  inventory: Readonly<Record<string, number>>
  world: ReachabilityWorld
  /** fact: a placeable block exists (selectPlaceableBlock(...) !== null) */
  placeableBlock: boolean
}

/**
 * Relevant facts only: target cell, verdict, missing capabilities, the vertical
 * gap BUCKET (so a 1-block shuffle does not reset the proof), the held tier of
 * every missing tool family and whether a placeable block exists. Wall clock and
 * bot position are deliberately excluded: an unchanged state keeps suppressing,
 * a genuinely changed state (new tool/block/headroom) re-opens the target.
 */
export function reachabilityFingerprint(input: ReachabilityFingerprintInput): string {
  const position = input.target.position
  const gap = position === null ? 0 : Math.round(position.y - input.world.self.y)
  const gapBucket =
    gap > ASCEND_GAP_LIMIT ? 'ascend_far' : gap < -DESCEND_GAP_LIMIT ? 'descend_far' : String(gap)
  const missing = input.result.missingCapabilities.map(capabilityKey).sort().join(',')
  const tools = input.result.missingCapabilities
    .filter((capability): capability is Extract<Capability, { kind: 'tool' }> => capability.kind === 'tool')
    .map((capability) => `${capability.tool}:${bestToolTier(input.inventory, capability.tool)}`)
    .sort()
    .join(',')
  return [
    'rv1',
    targetLabel(position),
    input.result.reason,
    `missing=[${missing}]`,
    `gap=${gapBucket}`,
    `place=${input.placeableBlock ? 1 : 0}`,
    `tools=[${tools}]`,
    `hazard=${input.world.hazardAtTarget ? 1 : 0}`,
    `approach=${input.world.approach === null ? 0 : 1}`,
    `head=${input.world.headroomClear ? 1 : 0}`,
    `foot=${input.world.footingSolid ? 1 : 0}`,
  ].join('|')
}
