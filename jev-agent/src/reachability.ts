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

/**
 * Eye→block-AABB distance from an explicit eye position (the reach test). The
 * #244 interaction-stand geometry, shared here so the station approach
 * (executor) and the dig-access search (candidates) use ONE implementation.
 */
export function faceDistanceFromEye(eye: Vec3Json, block: Vec3Json): number {
  const x = Math.max(block.x, Math.min(eye.x, block.x + 1))
  const y = Math.max(block.y, Math.min(eye.y, block.y + 1))
  const z = Math.max(block.z, Math.min(eye.z, block.z + 1))
  return Math.hypot(eye.x - x, eye.y - y, eye.z - z)
}

/** Eye→block-AABB distance from a candidate stand's eyes (its interaction reach). */
export function interactionFaceDistance(stand: Vec3Json, block: Vec3Json): number {
  return faceDistanceFromEye({ x: stand.x + 0.5, y: stand.y + 1.62, z: stand.z + 0.5 }, block)
}

/** The four horizontal interaction offsets the #244 stand search examines. */
export const INTERACTION_STAND_OFFSETS: readonly Vec3Json[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
]

/** The three stances (feet levels) the #244 stand search examines per offset. */
export const INTERACTION_STAND_DY: readonly number[] = [0, 1, -1]

/** Something the body lacks that would make a target reachable if acquired. */
export type Capability =
  | { kind: 'tool'; tool: HarvestTool; tier: number }
  | { kind: 'placeable_block' }
  | { kind: 'headroom'; cell: Vec3Json | null }
  | {
      kind: 'safe_column'
      /** no usable ascent geometry, or geometry whose blocker needs a tool */
      reason: SafeColumnRefusalReason
      /** the column cell the classification examined; null only for legacy callers */
      cell: Vec3Json | null
      /** required tool family when `reason === 'no_tool'` */
      tool: HarvestTool | null
      /** minimum rank when `tool === 'pickaxe'` */
      tier: number | null
    }
  | { kind: 'ascend_plan' }
  | { kind: 'descend_plan' }
  | { kind: 'open_path' }
  | { kind: 'standable_approach' }

/**
 * Why a `safe_column` is missing, named so the marker is actionable: the
 * geometry is absent (`no_clearance`) or present without the held tool
 * (`no_tool`). A bare `safe_column` token is forbidden.
 */
export type SafeColumnRefusalReason = 'no_clearance' | 'no_tool'

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

/**
 * The station family a sensed block belongs to. A station target is not an
 * ordinary locomotion cell: it is usable only from a real interaction stand, so
 * the approach facts below are collected per family.
 */
export type StationKindName = 'furnace' | 'crafting_table'

/**
 * The station-approach facts the sensor JSON cannot carry. The executor already
 * knows how to *open* a station (`interactionStandCandidates`, #244); the
 * controller exposes the same geometry here, before candidate selection, so an
 * unreachable sensed station is never committed to and path_stuck'd.
 *
 * `approach` is a passable, supported stand whose interaction face is within
 * reach, or null when no such stand exists. `path` is the `canDig=false`
 * pathfinder verdict for walking to that stand; null means "not probed".
 */
export interface StationApproachFact {
  approach: Vec3Json | null
  path: PathProbeResult | null
}

export type StationApproachProbe = (station: Vec3Json, kind: StationKindName) => StationApproachFact

/** The exact reason a sensed station's approach was refused. */
export type StationApproachRefusal = 'no_interaction_stand' | 'no_path_to_stand'

/**
 * The observability marker for a sensed station whose approach was refused
 * before it could be selected. Never silent: the coordinate, family and the
 * mechanical fact that refused it are all named.
 */
export function formatStationUnreachable(
  kind: StationKindName,
  station: Vec3Json,
  reason: StationApproachRefusal,
): string {
  return `STATION_UNREACHABLE kind=${kind} id=b${Math.round(station.x)}_${Math.round(station.y)}_${Math.round(station.z)} reason=${reason}`
}

/**
 * The stand geometry for a blocked DIG target, generalised from the #244
 * interaction stand: the cell from which the target becomes diggable, plus the
 * `canDig=false` path verdict for walking to it. `approach` null means no such
 * stand exists; `path: 'no_path'` means it exists but cannot be walked to.
 */
export interface DigApproachFact {
  approach: Vec3Json | null
  path: PathProbeResult | null
}

/** Live dig-access probe; the controller wires it to `interactionStandCandidates` (#244). */
export type DigApproachProbe = (block: Vec3Json) => DigApproachFact

/** The exact reason a blocked dig target has no reachable access. */
export type DigAccessRefusal = 'no_interaction_stand' | 'no_path_to_stand'

/**
 * The observability marker for a dig target retired for lack of access. Never
 * silent: the coordinate and the mechanical fact that refused it are both named.
 */
export function formatDigAccessRetired(block: Vec3Json, reason: DigAccessRefusal): string {
  return `DIG_ACCESS_RETIRED reason=${reason} target=${Math.round(block.x)},${Math.round(block.y)},${Math.round(block.z)}`
}

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

/**
 * The `tool` capability for a barrier the inventory cannot break, or null.
 * Exported so every candidate kind attributes its tool need from its OWN
 * barrier (a MINE candidate's block, never a sibling candidate's path).
 */
export function missingToolCapability(
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
    case 'safe_column': {
      // A bare `safe_column` was not actionable (the live starvation carried it
      // with no cell and no tool); the key always names the fact it refused.
      const at = capability.cell === null ? '' : `@${capability.cell.x},${capability.cell.y},${capability.cell.z}`
      if (capability.reason === 'no_tool') {
        return `safe_column:no_tool${at}:${capability.tool ?? 'tool'}@${capability.tier ?? 0}`
      }
      return `safe_column:no_clearance${at}`
    }
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
