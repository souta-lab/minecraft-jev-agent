// candidates.ts - the DETERMINISTIC candidate generator.
//
// Runs *before* the model. It enumerates only actions that are actually
// executable against the current world state, so the policy can never pick a
// block or entity that does not exist. Candidate ids encode the concrete
// target, which lets the guard re-validate the exact same object later:
//
//   MINE:b-31_68_12      mine the block at (-31, 68, 12)
//   MOVE:p12_70_8        walk to the standable spot (12, 70, 8)
//   CRAFT:oak_planks     craft one step toward the current craft subgoal
//   PLACE:crafting_table place the held station at a reachable support block
//   SMELT:iron_ingot     put input+fuel into the placed furnace and take output
//   DESCEND:E:down:b…    dig a staircase/tunnel step in a cardinal direction
//   RETREAT:p4_70_9      retreat to the standable spot (4, 70, 9)
//   ATTACK:e19           attack entity id 19
//   EAT:bread            eat one bread
//   WAIT                 do nothing this tick
//   ESCALATE             hand control to System 2
//
// Generation is GOAL-DIRECTED: the current goal-queue subgoal selects the
// resource to mine, the craft step to surface, or the smelt/place operation, so
// the list stays small and every entry makes progress. Safety actions
// (eat/retreat/attack) are always offered regardless of subgoal.
import type { CraftOp, RecipeIndex } from './crafting.ts'
import { describeCraftOp, planNextCraftStep } from './crafting.ts'
import type { BlockState, DescentOption, KnownResource, Vec3Json, WorldState } from './state.ts'
import { ORE_SOURCES, PICKAXE_RANKS, STONE_YIELDS, distance, isSensedStation } from './state.ts'
import { findInventoryFuel, matchesResourceClass, resourceMatches } from './resourceClass.ts'
import type { InventoryFuel } from './resourceClass.ts'
import { failureCount } from './failureMemory.ts'
import { selectDigTool } from './toolChoice.ts'
import { selectPlaceableBlock, planVerticalApproach, pillarColumnUnsafeFromBlocks } from './verticalPlan.ts'
import type { VerticalPlan } from './verticalPlan.ts'
import { FURNACE_STONE_COST, knownStationKey, planPrereqOptions, prereqSubjectForGoal } from './prereqOption.ts'
import type { KnownStationLike, PrereqInput, PrereqPath } from './prereqOption.ts'
import { pickBestDescendStep } from './descendPlan.ts'
import type { DescendScoreInput } from './descendPlan.ts'
import { DIG_PATH_CAP } from './worldMemory.ts'
import { fuelCountFor, smeltInputFor as smeltInputName, PICKAXE_TIER_ORDER } from './gameData.ts'
import { ASCEND_GAP_LIMIT, bestToolTier, capabilityKey, DESCEND_GAP_LIMIT, evaluateReachability, HAZARD_PROXIMITY, missingToolCapability, reachabilityFingerprint } from './reachability.ts'
import type { Capability, PathProbeResult, ReachabilityAbilities, ReachabilityBarrier, ReachabilityResult, ReachabilityTarget, ReachabilityWorld } from './reachability.ts'
import { StateFingerprintMemory } from './moveFailMemory.ts'

export type CandidateKind =
  | 'MINE'
  | 'MOVE'
  | 'CRAFT'
  | 'PLACE'
  | 'SMELT'
  | 'DESCEND'
  | 'STEP'
  | 'RETRIEVE'
  | 'ATTACK'
  | 'EAT'
  | 'RETREAT'
  | 'WAIT'
  | 'ESCALATE'

export interface CandidateAffordance {
  feasible: boolean
  reason: ReachabilityResult['reason']
  missingCapabilities: readonly Capability[]
}

export interface Candidate {
  id: string
  kind: CandidateKind
  /** one-line human description, used as the Jev choice criteria text */
  label: string
  targetName: string | null
  target: Vec3Json | null
  targetEntityId: number | null
  itemName: string | null
  requiresTool: boolean
  toolName: 'pickaxe' | 'axe' | 'shovel' | null
  /** minimum pickaxe rank required for `requiresTool` (see PICKAXE_RANKS) */
  toolTier?: number | null
  /** target was within reach when the sensor ran */
  inReach: boolean
  hasStandableAdjacent: boolean
  /** deterministic affordance facts: infeasible candidates are never presented */
  affordance?: CandidateAffordance
  meta: Record<string, string | number | boolean>
}

export interface CandidateOptions {
  reach: number
  maxMineCandidates: number
  maxAttackCandidates: number
  /** below this food level the bot is willing to eat */
  eatBelowFood: number
  /** nearest distance (m) at which an out-of-reach block earns a MOVE candidate */
  moveMinDistance?: number
  /** furthest distance (m) at which a walk-up MOVE is offered (chained moves) */
  moveMaxDistance?: number
  /** furthest distance (m) at which a buried block becomes a tunnel target */
  tunnelMaxDistance?: number
  /** upper bound on MOVE candidates, so navigation cannot crowd out the policy list */
  maxMoveCandidates?: number
  /** recipe lookup used to surface grounded CRAFT/PLACE steps (null disables) */
  recipes?: RecipeIndex | null
  /**
   * M2 blocker: `knownStationKey`s blacklisted by the controller's move-failure
   * memory. Passed explicitly (never read from a global) so the pure
   * prerequisite planner stops choosing an unreachable remembered station.
   */
  unreachableStations?: ReadonlySet<string>
  /** failures at one MOVE/RETRIEVE target before the generator stops offering it (default 4) */
  moveFailureLimit?: number
  /** failures at one DESCEND step before the generator stops offering it (default 3) */
  descendFailureLimit?: number
  /** failures at one placement spot before a fallback spot is used (default 2) */
  placeSpotRetryLimit?: number
  /** affordance gate facts: pathfinder probe + state-fingerprint suppression memory */
  reachability?: ReachabilityGateOptions | null
}

export interface ReachabilityGateOptions {
  /** pathfinder fact for a destination; absent = unknown (no probe) */
  pathProbe?: ((position: Vec3Json) => PathProbeResult) | null
  /** proven-unreachable (candidateId -> fingerprint) suppression memory */
  memory?: StateFingerprintMemory | null
}

export interface CandidateReachability {
  candidate: Candidate
  result: ReachabilityResult
  fingerprint: string
  withheld: boolean
  suppressed: boolean
}

export interface GroundedCandidatesResult {
  candidates: Candidate[]
  /** every affordance evaluation this cycle (facts for observability) */
  reachability: CandidateReachability[]
  /** the subset whose target is not mechanically reachable */
  withheld: CandidateReachability[]
  /**
   * Typed placement-geometry refusal: a held station could not be placed from
   * the terrain the sensor already knows. Non-null means the refusal was
   * surfaced (never silent), even when no alternative candidate exists.
   */
  placeRefusal: PlaceRefusal | null
}

/**
 * Why a held station could not be placed from the terrain the sensor already
 * knows, naming the exact cell the mechanical solve evaluated:
 *
 *   - `no_support`   no standable terrain is known; the only air cell (the bot's
 *                    own head space) has no block under it to place onto;
 *   - `no_clearance` the only known placeable cell is the bot's own body cell,
 *                    so the placement is blocked by the bot itself;
 *   - `out_of_reach` a valid placement cell exists but is beyond interaction
 *                    reach; the bot must walk closer first.
 */
export type PlaceRefusalReason = 'no_support' | 'no_clearance' | 'out_of_reach'

export interface PlaceRefusal {
  item: string
  reason: PlaceRefusalReason
  cell: Vec3Json
}

/** The exact `PLACE_REFUSED` observability line for one typed refusal. */
export function formatPlaceRefusal(refusal: PlaceRefusal): string {
  return `PLACE_REFUSED reason=${refusal.reason} cell=${refusal.cell.x},${refusal.cell.y},${refusal.cell.z} item=${refusal.item}`
}

const DEFAULT_MOVE_MIN_DISTANCE = 0
const DEFAULT_MOVE_MAX_DISTANCE = 48
const DEFAULT_TUNNEL_MAX_DISTANCE = 24
const DEFAULT_MAX_MOVE_CANDIDATES = 6
const DEFAULT_CANDIDATE_MOVE_FAILURE_LIMIT = 4
const DEFAULT_CANDIDATE_DESCEND_FAILURE_LIMIT = 3
const DEFAULT_PLACE_SPOT_RETRY_LIMIT = 2
/** Block within this horizontal distance of the bot counts as pickup-adjacent. */
const PICKUP_MINE_HORIZONTAL = 2.75
/** Vertical band (relative to the feet) in which a drop still lands in reach. */
const PICKUP_MINE_VERTICAL = 1.5

export const defaultCandidateOptions: CandidateOptions = {
  reach: 4.5,
  maxMineCandidates: 12,
  maxAttackCandidates: 4,
  eatBelowFood: 18,
  moveMinDistance: DEFAULT_MOVE_MIN_DISTANCE,
  moveMaxDistance: DEFAULT_MOVE_MAX_DISTANCE,
  tunnelMaxDistance: DEFAULT_TUNNEL_MAX_DISTANCE,
  maxMoveCandidates: DEFAULT_MAX_MOVE_CANDIDATES,
  moveFailureLimit: DEFAULT_CANDIDATE_MOVE_FAILURE_LIMIT,
  descendFailureLimit: DEFAULT_CANDIDATE_DESCEND_FAILURE_LIMIT,
  placeSpotRetryLimit: DEFAULT_PLACE_SPOT_RETRY_LIMIT,
  recipes: null,
}

const FOOD_ITEMS = new Set([
  'bread',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_chicken',
  'cooked_mutton',
  'cooked_rabbit',
  'cooked_cod',
  'cooked_salmon',
  'apple',
  'golden_apple',
  'carrot',
  'baked_potato',
  'melon_slice',
  'sweet_berries',
])

const HAZARD_DANGER_RADIUS = 3

export function blockId(prefix: 'b' | 'p', position: Vec3Json): string {
  return `${prefix}${position.x}_${position.y}_${position.z}`
}

function isExecutable(block: BlockState): boolean {
  return block.diggable && (block.inReach || block.hasAdjacentStandable)
}

export function countBlockedLogs(state: WorldState): number {
  return state.blocks.filter((block) => block.kind === 'log' && !isExecutable(block)).length
}

function mineLabel(block: BlockState): string {
  const where = `(${block.position.x},${block.position.y},${block.position.z})`
  const reach = block.inReach ? 'in reach' : `${block.distance}m away`
  const access = block.hasAdjacentStandable ? 'walk-up access' : 'no walk-up access'
  const tool = block.harvestTool === null ? 'hand-harvestable' : `needs a ${block.harvestTool}`
  return `mine ${block.name} at ${where}, ${reach}, ${access}, ${tool}`
}

function moveLabel(target: Vec3Json, role: string, botPosition: Vec3Json): string {
  return `${role} (${target.x},${target.y},${target.z}), ${distance(target, botPosition)}m away`
}

function moveToBlockLabel(block: BlockState, spot: Vec3Json): string {
  const where = `(${block.position.x},${block.position.y},${block.position.z})`
  const tool = block.harvestTool === null ? 'hand-harvestable' : `needs a ${block.harvestTool}`
  const reach = block.inReach ? 'not pickup-adjacent yet' : 'out of reach'
  return `walk to ${block.name} at ${where}, ${block.distance}m away (${reach}), stand at (${spot.x},${spot.y},${spot.z}), ${tool}`
}

function hasTool(state: WorldState, toolName: Candidate['toolName'], tier: number | null = null): boolean {
  if (toolName === null) return true
  const counts = state.inventory.counts
  if (tier === null || tier <= 0) {
    const suffix = `_${toolName}`
    return Object.keys(counts).some((name) => name.endsWith(suffix) && (counts[name] ?? 0) > 0)
  }
  return Object.entries(counts).some(([name, count]) => {
    if (count <= 0) return false
    const rank = PICKAXE_RANKS[name]
    return rank !== undefined && rank >= tier
  })
}

/**
 * Pure, deterministic. Same state in -> same candidate list out (ordering
 * included), which is what makes the guard and the calibration log meaningful.
 * The affordance gate (#11 v2) runs inside: only mechanically reachable targets
 * are presented, and withheld targets carry a typed reason + missing
 * capabilities instead of being silently retried.
 */
export function generateCandidates(
  state: WorldState,
  options: CandidateOptions = defaultCandidateOptions,
): Candidate[] {
  return generateGroundedCandidates(state, options).candidates
}

export function generateGroundedCandidates(
  state: WorldState,
  options: CandidateOptions = defaultCandidateOptions,
): GroundedCandidatesResult {
  const raw = generateRawCandidates(state, options)
  return applyReachabilityGate(raw.candidates, state, options, raw.placeRefusal)
}

function generateRawCandidates(
  state: WorldState,
  options: CandidateOptions = defaultCandidateOptions,
): RawCandidatesResult {
  let candidates: Candidate[] = []
  let placeRefusal: PlaceRefusal | null = null
  const current = state.goalQueue?.current ?? null
  const focusItem = current?.targetItem ?? state.goal.targetItem ?? null
  const goalKind = current?.kind ?? 'collect'
  const strategy = current?.strategy ?? null
  const descendTargetY = current?.kind === 'descend' ? (current.targetY ?? null) : null

  switch (goalKind) {
    case 'craft': {
      const craft = craftCandidates(state, options, focusItem)
      candidates.push(...craft.candidates)
      placeRefusal = craft.placeRefusal
      break
    }
    case 'smelt':
      candidates.push(...smeltCandidates(state, options, focusItem))
      break
    case 'place':
      candidates.push(...placeCandidates(state, options, focusItem))
      break
    default:
      candidates.push(...mineCandidates(state, options, focusItem, descendTargetY))
      break
  }

  if (strategy === 'explore_cave') {
    const explore = pickExplore(state, state.terrain.standable, focusItem, options.moveFailureLimit ?? DEFAULT_CANDIDATE_MOVE_FAILURE_LIMIT)
    if (explore !== null) {
      candidates.unshift({
        id: `EXPLORE_CAVE:${blockId('p', explore)}`,
        kind: 'MOVE',
        label: moveLabel(explore, 'explore a cave frontier', state.self.position),
        targetName: null,
        target: explore,
        targetEntityId: null,
        itemName: null,
        requiresTool: false,
        toolName: null,
        inReach: distance(explore, state.self.position) <= options.reach,
        hasStandableAdjacent: true,
        meta: { tick: state.tick, x: explore.x, y: explore.y, z: explore.z, strategy },
      })
    }
  }
  if (strategy === 'branch_mine') {
    candidates = candidates.map((candidate) =>
      candidate.kind === 'MINE' || candidate.kind === 'MOVE' || candidate.kind === 'DESCEND'
        ? { ...candidate, id: `BRANCH_MINE:${candidate.id}`, meta: { ...candidate.meta, strategy } }
        : candidate,
    )
  } else if (strategy === 'return_to_known_ore') {
    candidates = candidates.map((candidate) =>
      candidate.kind === 'RETRIEVE' ? { ...candidate, id: `RETURN_TO_KNOWN_ORE:${candidate.id}`, meta: { ...candidate.meta, strategy } } : candidate,
    )
  }

  const hostiles = state.entities.filter((entity) => entity.hostile)
  for (const entity of hostiles.slice(0, options.maxAttackCandidates)) {
    candidates.push({
      id: `ATTACK:e${entity.id}`,
      kind: 'ATTACK',
      label: `attack ${entity.name} ${entity.distance}m away at (${entity.position.x},${entity.position.y},${entity.position.z})`,
      targetName: entity.name,
      target: entity.position,
      targetEntityId: entity.id,
      itemName: null,
      requiresTool: false,
      toolName: null,
      inReach: entity.distance <= options.reach,
      hasStandableAdjacent: true,
      meta: { tick: state.tick, entityId: entity.id, distance: entity.distance },
    })
  }

  const foodName = pickFood(state)
  if (foodName !== null && state.self.food < options.eatBelowFood) {
    candidates.push({
      id: `EAT:${foodName}`,
      kind: 'EAT',
      label: `eat ${foodName} (food=${state.self.food})`,
      targetName: foodName,
      target: null,
      targetEntityId: null,
      itemName: foodName,
      requiresTool: false,
      toolName: null,
      inReach: true,
      hasStandableAdjacent: true,
      meta: { tick: state.tick, food: state.self.food },
    })
  }

  const danger = nearestDanger(state, HAZARD_DANGER_RADIUS)
  const retreat = pickRetreat(state, state.terrain.standable, danger)
  if (retreat !== null) {
    candidates.push({
      id: `RETREAT:${blockId('p', retreat)}`,
      kind: 'RETREAT',
      label: moveLabel(retreat, 'retreat to safety', state.self.position),
      targetName: null,
      target: retreat,
      targetEntityId: null,
      itemName: null,
      requiresTool: false,
      toolName: null,
      inReach: distance(retreat, state.self.position) <= options.reach,
      hasStandableAdjacent: true,
      meta: { tick: state.tick, x: retreat.x, y: retreat.y, z: retreat.z },
    })
  }

  // A known-resource retrieval is grounded even when other (non-progressing)
  // candidates exist: if the wanted block is not visible but its coordinate is
  // remembered, going there is strictly better than re-issuing the front goal.
  candidates.push(...retrievalCandidates(state, options, focusItem))
  if (candidates.length === 0) {
    const moveFailureLimit = options.moveFailureLimit ?? DEFAULT_CANDIDATE_MOVE_FAILURE_LIMIT
    const explore = pickExplore(state, state.terrain.standable, focusItem, moveFailureLimit)
    if (explore !== null && failureCount(state.signals.failedCandidates, `MOVE:${blockId('p', explore)}`) < moveFailureLimit) {
      candidates.push({
        id: `MOVE:${blockId('p', explore)}`,
        kind: 'MOVE',
        label: moveLabel(explore, 'walk toward unexplored terrain', state.self.position),
        targetName: null,
        target: explore,
        targetEntityId: null,
        itemName: null,
        requiresTool: false,
        toolName: null,
        inReach: distance(explore, state.self.position) <= options.reach,
        hasStandableAdjacent: true,
        meta: { tick: state.tick, x: explore.x, y: explore.y, z: explore.z },
      })
    }
  }

  candidates.push({
    id: 'WAIT',
    kind: 'WAIT',
    label: 'do nothing for one tick',
    targetName: null,
    target: null,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: state.tick, waitMs: 300 },
  })

  if (state.signals.escalationRecommended) {
    candidates.push({
      id: 'ESCALATE',
      kind: 'ESCALATE',
      label: `hand control to System 2 (${state.signals.lastFailureCode ?? 'unknown trigger'})`,
      targetName: null,
      target: null,
      targetEntityId: null,
      itemName: null,
      requiresTool: false,
      toolName: null,
      inReach: true,
      hasStandableAdjacent: true,
      meta: { tick: state.tick, reason: state.signals.lastFailureCode ?? 'unknown' },
    })
  }

  return { candidates, placeRefusal }
}

/**
 * MINE/MOVE/DESCEND candidates for the current collect subgoal only.
 *
 *  - a block is mined in place only when the bot is already standing next to it
 *    (`PICKUP_MINE_HORIZONTAL`/`PICKUP_MINE_VERTICAL`), so the drop lands inside
 *    the automatic-pickup volume instead of several metres away;
 *  - a reachable block that is *not* pickup-adjacent is demoted to a MOVE toward
 *    its standable spot, so the next sensor tick re-offers it as a safe MINE;
 *  - a block with no walk-up access is a tunnel target, and the generator emits
 *    a DESCEND staircase/tunnel step toward the nearest one.
 */
function mineCandidates(
  state: WorldState,
  options: CandidateOptions,
  focusItem: string | null,
  descendTargetY: number | null = null,
): Candidate[] {
  const mineable = state.blocks.filter(
    (block) => block.kind === 'log' || block.kind === 'stone' || block.kind === 'ore',
  )
  const matching = mineable.filter((block) => focusItem === null || resourceMatches(block.yield, focusItem))
  const fallback =
    focusItem === null && matching.length === 0 ? mineable.filter((block) => block.kind === 'log') : matching
  const pool = fallback
  const mineActions: Candidate[] = []
  const moveActions: Candidate[] = []
  const tunnelTargets: BlockState[] = []
  let moveCount = 0
  const self = state.self.position

  for (const block of pool) {
    if (mineActions.length + moveActions.length >= options.maxMineCandidates) break
    if (!block.diggable) continue
    const harvestTool = block.harvestTool ?? null
    const tier = block.harvestTier ?? null
    if (!hasTool(state, harvestTool, tier)) continue

    const requiresTool = harvestTool !== null
    const baseMeta = {
      tick: state.tick,
      x: block.position.x,
      y: block.position.y,
      z: block.position.z,
      diggable: block.diggable,
      yieldItem: block.yield ?? block.name,
    }

    const horizontal = Math.hypot(block.position.x + 0.5 - self.x, block.position.z + 0.5 - self.z)
    const vertical = Math.abs(block.position.y - self.y)
    const spot = block.adjacentStandable
    const spotHorizontal =
      spot === null ? Number.POSITIVE_INFINITY : Math.hypot(spot.x + 0.5 - self.x, spot.z + 0.5 - self.z)
    const atSpot = spot !== null && spotHorizontal <= 0.9 && Math.abs(spot.y - self.y) <= 1.5
    const pickupSafe =
      (horizontal <= PICKUP_MINE_HORIZONTAL && vertical <= PICKUP_MINE_VERTICAL) || atSpot

    // In reach, visible AND pickup-adjacent: mine it now. Anything farther would
    // drop the item outside the pickup volume, so it becomes a MOVE instead.
    if (block.inReach && block.visible !== false && pickupSafe) {
      mineActions.push({
        id: `MINE:${blockId('b', block.position)}`,
        kind: 'MINE',
        label: mineLabel(block),
        targetName: block.name,
        target: block.position,
        targetEntityId: null,
        itemName: null,
        requiresTool,
        toolName: harvestTool,
        toolTier: tier,
        inReach: true,
        hasStandableAdjacent: block.hasAdjacentStandable,
        meta: baseMeta,
      })
      continue
    }

    // Reachable but not pickup-adjacent (or out of reach): MOVE:<block id> is the
    // navigation decision. On arrival the next sensor tick re-offers MINE.
    const moveMin = options.moveMinDistance ?? DEFAULT_MOVE_MIN_DISTANCE
    const moveMax = options.moveMaxDistance ?? DEFAULT_MOVE_MAX_DISTANCE
    const maxMoves = options.maxMoveCandidates ?? DEFAULT_MAX_MOVE_CANDIDATES
    if (isExecutable(block) && block.hasAdjacentStandable) {
      if (block.distance < moveMin || block.distance > moveMax) {
        if (block.distance > moveMax) tunnelTargets.push(block)
        continue
      }
      if (moveCount >= maxMoves) continue
      if (failureCount(state.signals.failedCandidates, `MOVE:${blockId('b', block.position)}`) >= (options.moveFailureLimit ?? DEFAULT_CANDIDATE_MOVE_FAILURE_LIMIT)) continue
      if (spot === null || atSpot) continue
      moveCount += 1
      moveActions.push({
        id: `MOVE:${blockId('b', block.position)}`,
        kind: 'MOVE',
        label: moveToBlockLabel(block, spot),
        targetName: block.name,
        target: spot,
        targetEntityId: null,
        itemName: null,
        requiresTool,
        toolName: harvestTool,
        toolTier: tier,
        inReach: false,
        hasStandableAdjacent: true,
        meta: {
          ...baseMeta,
          x: spot.x,
          y: spot.y,
          z: spot.z,
          targetBlockX: block.position.x,
          targetBlockY: block.position.y,
          targetBlockZ: block.position.z,
          targetBlockName: block.name,
          distance: block.distance,
        },
      })
      continue
    }

    const tunnelMax = options.tunnelMaxDistance ?? DEFAULT_TUNNEL_MAX_DISTANCE
    if (block.distance <= tunnelMax) tunnelTargets.push(block)
  }

  const candidates = [...mineActions]
  // Route-opening options come BEFORE MOVE: a MOVE whose stand spot is behind a
  // 2-block face (or under a canopy ceiling) can never execute, so the cut/clear
  // that opens the route must be the first thing the policy sees.
  if (mineActions.length === 0) candidates.push(...headroomCandidates(state, options))
  if (moveActions.length > 0) candidates.push(...stepCutCandidates(state, options))
  candidates.push(...moveActions)
  if (candidates.length === 0) {
    candidates.push(...descendCandidates(state, options, focusItem, tunnelTargets, descendTargetY))
  }
  return candidates
}

/**
 * Canopy-pocket escape: a solid block above the bot vetoes every jump, so a
 * required step-up route cannot be walked. Mine the ceiling block(s) to open
 * the headroom. Only offered when the current goal has no in-reach MINE (i.e.
 * the only way forward is navigation), so normal mining keeps priority.
 */
function headroomCandidates(state: WorldState, options: CandidateOptions): Candidate[] {
  const cuts = (state.headroomCuts ?? []).filter((cut) => cut.safe)
  if (cuts.length === 0) return []
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  return cuts.slice(0, 2).map((cut) => ({
    id: `MINE:${blockId('b', cut.pos)}`,
    kind: 'MINE' as const,
    label: `mine the ${cut.name} ceiling block at (${cut.pos.x},${cut.pos.y},${cut.pos.z}) to open jump headroom and escape the pocket`,
    targetName: cut.name,
    target: cut.pos,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: distance(cut.pos, state.self.eyePosition) <= options.reach,
    hasStandableAdjacent: true,
    meta: {
      tick: state.tick,
      x: cut.pos.x,
      y: cut.pos.y,
      z: cut.pos.z,
      clearance: true,
      yieldItem: cut.name,
      distance: Math.hypot(cut.pos.x + 0.5 - feet.x, cut.pos.z + 0.5 - feet.z),
    },
  }))
}

/**
 * A `STEP` candidate removes the upper block of an adjacent 2-block vertical
 * face, turning it into a 1-block step. Without it the offered MOVE stand spot
 * is behind a rise no vanilla client can climb (jump apex 1.2522), so the route
 * is simply not executable.
 */
function stepCutCandidates(state: WorldState, options: CandidateOptions): Candidate[] {
  const cuts = (state.stepCuts ?? []).filter((cut) => cut.safe)
  if (cuts.length === 0) return []
  const focus = state.goalQueue?.current?.targetItem ?? state.goal.targetItem ?? null
  const target = nearestResource(state, focus)
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  const scored: Array<{ cut: NonNullable<WorldState['stepCuts']>[number]; score: number }> = []
  for (const cut of cuts) {
    const known = state.blocks.find(
      (block) =>
        block.position.x === cut.cut.x && block.position.y === cut.cut.y && block.position.z === cut.cut.z,
    )
    const tool = known?.harvestTool ?? null
    if (!hasTool(state, tool, tool === null ? null : known?.harvestTier ?? null)) continue
    let penalty = 0
    if (target !== null) {
      const tdx = target.position.x - feet.x
      const tdz = target.position.z - feet.z
      const dot = cut.dx * Math.sign(tdx) + cut.dz * Math.sign(tdz)
      penalty = dot > 0 ? 0 : 10
    }
    scored.push({ cut, score: penalty + distance(cut.step, state.self.position) })
  }
  if (scored.length === 0) return []
  scored.sort((a, b) => a.score - b.score)

  return scored.slice(0, 2).map(({ cut }) => {
    const known = state.blocks.find(
      (block) =>
        block.position.x === cut.cut.x && block.position.y === cut.cut.y && block.position.z === cut.cut.z,
    )
    const tool = known?.harvestTool ?? null
    return {
      id: `STEP:${cut.dir}:${blockId('b', cut.cut)}`,
      kind: 'STEP' as const,
      label: `cut a 1-block step into the ${cut.name} face (${cut.dir}) at (${cut.cut.x},${cut.cut.y},${cut.cut.z}); the blocked route becomes climbable`,
      targetName: cut.name,
      target: cut.cut,
      targetEntityId: null,
      itemName: null,
      requiresTool: tool !== null,
      toolName: tool,
      toolTier: known?.harvestTier ?? null,
      inReach: distance(cut.cut, state.self.eyePosition) <= options.reach,
      hasStandableAdjacent: true,
      meta: {
        tick: state.tick,
        x: cut.cut.x,
        y: cut.cut.y,
        z: cut.cut.z,
        dir: cut.dir,
        stepX: cut.step.x,
        stepY: cut.step.y,
        stepZ: cut.step.z,
        diggable: true,
      },
    }
  })
}

/**
 * One grounded staircase/tunnel step toward the nearest target resource.
 *
 * #3: `target === null` no longer means "descend". A downward step needs positive
 * evidence (a visible target below, or a remembered stone/ore level below for a
 * stone/ore goal); otherwise only level steps are offered. A per-subgoal
 * no-progress budget (`signals.descendLimitReached`) stops runaway descent.
 *
 * #4: once a dig direction is chosen it is held until the resource appears or the
 * `DIG_PATH_CAP` is reached, so the path cannot zigzag. Oscillation forces a
 * straight downward staircase.
 */
function descendCandidates(
  state: WorldState,
  options: CandidateOptions,
  focusItem: string | null,
  tunnelTargets: readonly BlockState[],
  descendTargetY: number | null = null,
): Candidate[] {
  if (focusItem === null && descendTargetY === null) return []
  // #41: the no-progress latch caps runaway descent for *item* goals. A predicate
  // `descend_to:Y=<n>` is the objective itself; suppressing its only body change
  // is exactly the permanent WAIT this issue fixes. The controller's stall
  // assertion bounds a genuinely impossible descent instead.
  if (state.signals.descendLimitReached === true && descendTargetY === null) return []
  const steps = (state.descent ?? []).filter((step) => step.safe)
  if (steps.length === 0) return []

  const target = tunnelTargets[0] ?? nearestResource(state, focusItem)
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  const knownStoneY = state.signals.knownStoneY ?? null
  const goalIsUnderground =
    focusItem !== null && (STONE_YIELDS.has(focusItem) || ORE_SOURCES[focusItem] !== undefined)
  const stoneGoal = focusItem !== null && STONE_YIELDS.has(focusItem)
  const targetBelow = target !== null && target.position.y < feet.y
  const knownStoneBelow = knownStoneY !== null && knownStoneY < feet.y && goalIsUnderground
  // #41: an explicit descend predicate is positive evidence for a downward step
  // even when no ore is visible, and (unlike a collect goal) it does not need one.
  const descendToY = descendTargetY !== null && state.self.position.y > descendTargetY
  const downEvidence = descendToY || targetBelow || (target === null && (knownStoneBelow || stoneGoal))
  const wantDown = descendToY || targetBelow || (target === null && downEvidence)
  const hasTunnelTarget = tunnelTargets.length > 0
  const oscillate = state.signals.digOscillate === true
  const fixedDir = state.signals.digDir ?? null
  const fixedCount = state.signals.digDirCount ?? 0

  let pool = steps.filter((step) => downEvidence || oscillate || step.mode !== 'down')
  if (oscillate) {
    pool = pool.filter((step) => step.mode === 'down' && (fixedDir === null || step.dir === fixedDir))
  } else if (fixedDir !== null && fixedCount > 0 && fixedCount < DIG_PATH_CAP) {
    pool = pool.filter((step) => step.dir === fixedDir)
  }
  if (pool.length === 0) pool = steps.filter((step) => downEvidence || oscillate || step.mode !== 'down')
  if (pool.length === 0) return []

  const scoreInput: DescendScoreInput = {
    wantDown,
    hasTunnelTarget,
    predicateDescend: descendTargetY !== null,
    target: target === null ? null : target.position,
    feet,
  }
  const notFailed = pool.filter(
    (step) =>
      failureCount(state.signals.failedCandidates, descendId(step)) <
      (options.descendFailureLimit ?? DEFAULT_CANDIDATE_DESCEND_FAILURE_LIMIT),
  )
  let best = pickBestDescendStep(notFailed, scoreInput)
  if (best === null && descendTargetY !== null) {
    // A predicate goal must yield a body change rather than WAIT. Retry over the
    // full safe pool even when stale failure memory suppressed every step; the
    // controller's DESCEND_STALLED assertion bounds a genuinely impossible descent.
    best = pickBestDescendStep(pool, scoreInput)
  }
  if (best === null) return []

  const primary = best.mode === 'down' ? best.floor : best.wallSolid ? best.wall : best.head
  const choice = selectDigTool(
    {
      name: best.digName ?? '',
      harvestTool: best.digHarvestTool ?? null,
      harvestTier: best.digHarvestTier ?? null,
      diggable: best.diggable === true,
    },
    (tool, tier) => hasTool(state, tool, tier),
  )
  if (!choice.ok) return []

  return [
    {
      id: descendId(best),
      kind: 'DESCEND',
      label: `${best.dir === 'D' ? 'dig straight down' : best.mode === 'down' ? 'dig a staircase step down' : 'tunnel one block forward'} toward ${focusItem ?? (descendTargetY === null ? 'unknown' : `descend_to:Y=${descendTargetY}`)} (${best.dir}), dig (${primary.x},${primary.y},${primary.z}) then stand at (${best.step.x},${best.step.y},${best.step.z})`,
      targetName: focusItem,
      target: primary,
      targetEntityId: null,
      itemName: null,
      requiresTool: choice.tool !== null,
      toolName: choice.tool,
      toolTier: choice.tier,
      inReach: distance(primary, state.self.eyePosition) <= options.reach,
      hasStandableAdjacent: true,
      meta: {
        tick: state.tick,
        mode: best.mode,
        dir: best.dir,
        dx: best.dx,
        dz: best.dz,
        focusItem: focusItem ?? 'unknown',
        predicate: descendTargetY === null ? 'none' : `descend_to:Y=${descendTargetY}`,
        descendTargetY: descendTargetY ?? 'none',
        digBlockName: best.digName ?? 'unknown',
        toolReason: choice.reason,
        staircase: oscillate || (best.mode === 'down' && fixedCount === 0),
        stepX: best.step.x,
        stepY: best.step.y,
        stepZ: best.step.z,
        wallX: best.wall.x,
        wallY: best.wall.y,
        wallZ: best.wall.z,
        headX: best.head.x,
        headY: best.head.y,
        headZ: best.head.z,
        floorX: best.floor.x,
        floorY: best.floor.y,
        floorZ: best.floor.z,
        wallSolid: best.wallSolid,
        headSolid: best.headSolid,
        floorSolid: best.floorSolid,
        digX: primary.x,
        digY: primary.y,
        digZ: primary.z,
        diggable: true,
        safe: best.safe,
      },
    },
  ]
}

function descendId(step: DescentOption): string {
  const primary = step.mode === 'down' ? step.floor : step.wall
  return `DESCEND:${step.mode}:${step.dir}:${blockId('b', primary)}`
}

/** PLACE candidate for a held station at a grounded spot (used for self-placed stations). */
function placeStationCandidate(
  state: WorldState,
  options: CandidateOptions,
  item: string,
  spot: Vec3Json,
  purpose: string,
): Candidate {
  return {
    id: `PLACE:${item}:${blockId('p', spot)}`,
    kind: 'PLACE',
    label: `place ${item} at (${spot.x},${spot.y},${spot.z}), ${distance(spot, state.self.position)}m away, then ${purpose}`,
    targetName: item,
    target: spot,
    targetEntityId: null,
    itemName: item,
    requiresTool: false,
    toolName: null,
    inReach: distance(spot, state.self.eyePosition) <= options.reach,
    hasStandableAdjacent: true,
    meta: { tick: state.tick, x: spot.x, y: spot.y, z: spot.z, purpose },
  }
}

/** One held-station placement solve: an in-reach spot, or the typed reason it was refused. */
interface HeldStationPlacement {
  spot: Vec3Json | null
  refusal: PlaceRefusal | null
  /** grounded alternative offered instead of silence (approach MOVE / clear-headroom MINE) */
  alternative: Candidate | null
}

/**
 * True when a block placed at `cell` would intersect the bot's own body. Mirrors
 * the sensor's `nearBody < 1.0` rule in `buildPlacementSpots`, so the terrain
 * solve can never pick the cell the bot is standing in.
 */
function placementIntersectsBody(cell: Vec3Json, self: Vec3Json): boolean {
  return distance({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, self) < 1.0
}

/** Nearest-first known placement cells: the strict live spots plus the sensed standable terrain. */
function knownPlacementCells(state: WorldState): Vec3Json[] {
  const seen = new Set<string>()
  const cells: Vec3Json[] = []
  for (const cell of [...state.placementSpots, ...state.terrain.standable]) {
    const key = blockId('p', cell)
    if (seen.has(key)) continue
    seen.add(key)
    cells.push(cell)
  }
  cells.sort((a, b) => distance(a, state.self.position) - distance(b, state.self.position))
  return cells
}

/**
 * The known standable cell that walks the bot toward an out-of-reach placement
 * cell: nearest to the target among the cells strictly closer to the target than
 * the bot is now. The target itself is the last resort - arriving there
 * re-senses its neighbourhood and the next solve step finds a neighbouring cell.
 */
function placementApproachCell(state: WorldState, target: Vec3Json): Vec3Json {
  const here = distance(state.self.position, target)
  const options = state.terrain.standable.filter(
    (cell) =>
      !placementIntersectsBody(cell, state.self.position) &&
      !(cell.x === target.x && cell.y === target.y && cell.z === target.z) &&
      distance(cell, target) < here,
  )
  options.sort((a, b) => distance(a, target) - distance(b, target))
  return options[0] ?? target
}

/** Grounded MOVE toward an out-of-reach placement cell; carries the refusal token in its meta. */
function placementApproachCandidate(
  state: WorldState,
  options: CandidateOptions,
  item: string,
  target: Vec3Json,
  purpose: string,
): Candidate {
  const approach = placementApproachCell(state, target)
  return {
    id: `MOVE:${blockId('p', approach)}`,
    kind: 'MOVE',
    label: `walk to (${approach.x},${approach.y},${approach.z}) to bring the placement cell (${target.x},${target.y},${target.z}) within reach, then place ${item} to ${purpose}`,
    targetName: null,
    target: approach,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: distance(approach, state.self.position) <= options.reach,
    hasStandableAdjacent: true,
    meta: {
      tick: state.tick,
      x: approach.x,
      y: approach.y,
      z: approach.z,
      placeRefused: 'out_of_reach',
      placeRefusedCell: blockId('p', target),
      placeItem: item,
    },
  }
}

/** Grounded clear-headroom alternative: the safe ceiling MINE that opens placement space when the bot blocks it. */
function placementHeadroomAlternative(
  state: WorldState,
  options: CandidateOptions,
  refusal: PlaceRefusal,
): Candidate | null {
  const cut = headroomCandidates(state, options)[0]
  if (cut === undefined) return null
  return {
    ...cut,
    meta: {
      ...cut.meta,
      placeRefused: refusal.reason,
      placeRefusedCell: blockId('p', refusal.cell),
      placeItem: refusal.item,
    },
  }
}

/**
 * The mechanical held-station placement solve over the terrain the sensor already
 * knows:
 *
 *   1. the strict live spots (`placementSpots`) keep their old priority;
 *   2. otherwise a sensed standable cell (air + 2-block clearance + solid support)
 *      outside the bot's body is a placement cell when it is within reach;
 *   3. an out-of-reach valid cell refuses with `out_of_reach` and offers the
 *      approach MOVE; the bot's own body cell refuses with `no_clearance` and
 *      offers the clear-headroom MINE; no standable terrain at all refuses with
 *      `no_support` at the bot's unsupported head cell.
 */
function heldStationPlacement(
  state: WorldState,
  options: CandidateOptions,
  item: string,
  purpose: string,
): HeldStationPlacement {
  const failureCountFor = (cell: Vec3Json): number =>
    state.signals.failedCandidates[`PLACE:${item}:${blockId('p', cell)}`] ?? 0
  const retryLimit = options.placeSpotRetryLimit ?? DEFAULT_PLACE_SPOT_RETRY_LIMIT

  if (state.placementSpots.length > 0) {
    const spot =
      state.placementSpots.find((cell) => failureCountFor(cell) < retryLimit) ?? state.placementSpots[0]
    if (spot !== undefined) return { spot, refusal: null, alternative: null }
  }

  let bodyCell: Vec3Json | null = null
  let outOfReach: Vec3Json | null = null
  for (const cell of knownPlacementCells(state)) {
    if (placementIntersectsBody(cell, state.self.position)) {
      bodyCell = bodyCell ?? cell
      continue
    }
    if (failureCountFor(cell) >= retryLimit) continue
    if (distance(cell, state.self.eyePosition) <= options.reach) {
      return { spot: cell, refusal: null, alternative: null }
    }
    outOfReach = outOfReach ?? cell
  }

  if (outOfReach !== null) {
    const refusal: PlaceRefusal = { item, reason: 'out_of_reach', cell: outOfReach }
    return { spot: null, refusal, alternative: placementApproachCandidate(state, options, item, outOfReach, purpose) }
  }

  if (bodyCell !== null) {
    const refusal: PlaceRefusal = { item, reason: 'no_clearance', cell: bodyCell }
    return { spot: null, refusal, alternative: placementHeadroomAlternative(state, options, refusal) }
  }

  const headCell: Vec3Json = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y) + 1,
    z: Math.floor(state.self.position.z),
  }
  const refusal: PlaceRefusal = { item, reason: 'no_support', cell: headCell }
  return { spot: null, refusal, alternative: placementHeadroomAlternative(state, options, refusal) }
}

/**
 * CRAFT/PLACE candidates driven by the pure recipe planner: exactly one grounded
 * step toward the current craft subgoal, or nothing when no step is executable
 * in this world state.
 */
function craftCandidates(
  state: WorldState,
  options: CandidateOptions,
  focusItem: string | null,
): CraftCandidatesResult {
  const none: CraftCandidatesResult = { candidates: [], placeRefusal: null }
  const recipes = options.recipes ?? null
  if (recipes === null || focusItem === null) return none
  const tableAvailable = state.craftingTables.some(isSensedStation)
  const plan = planNextCraftStep(recipes, focusItem, state.inventory.counts, tableAvailable)
  const op = plan.op

  // M2 craft deadlock: a recipe whose chosen variant needs a 3x3 station must
  // not collapse to WAIT while a usable table is held or remembered. Offer the
  // same station ladder the smelt prerequisite path uses before the plan;
  // falling through keeps (c), the existing craft-a-table-from-planks step.
  if (!tableAvailable && planRequiresTable(recipes, focusItem, state.inventory.counts)) {
    const acquisition = tableAcquisitionCandidates(state, options, focusItem)
    if (acquisition.candidates.length > 0 || acquisition.placeRefusal !== null) return acquisition
  }

  if (op === null) return none

  if (op.type === 'craft') {
    const nearestTable = state.craftingTables.find(isSensedStation) ?? null
    const table = op.requiresTable ? nearestTable : null
    // A station the bot must WALK to can be unreachable (a natural village table
    // behind a canopy / 2-block face). When the recipe needs a station, the bot
    // HOLDS its own crafting_table, the only known station is out of interaction
    // reach, and walking to it has already failed once, place our own station at
    // a nearby grounded spot instead. Gated on a prior failure so the common
    // walk-to-table path is untouched.
    const tableInReach = nearestTable !== null && distance(nearestTable, state.self.eyePosition) <= options.reach
    const holdsTable = (state.inventory.counts.crafting_table ?? 0) > 0
    const craftFailed = (state.signals.failedCandidates[`CRAFT:${op.item}`] ?? 0) > 0
    if (op.requiresTable && !tableInReach && holdsTable && craftFailed && state.placementSpots.length > 0) {
      const spot =
        state.placementSpots.find(
          (candidate) =>
            (state.signals.failedCandidates[`PLACE:crafting_table:${blockId('p', candidate)}`] ?? 0) <
            (options.placeSpotRetryLimit ?? DEFAULT_PLACE_SPOT_RETRY_LIMIT),
        ) ?? state.placementSpots[0]
      if (spot === undefined) return none
      return {
        candidates: [placeStationCandidate(state, options, 'crafting_table', spot, `craft ${focusItem}`)],
        placeRefusal: null,
      }
    }
  }

  const step = craftPlanStepCandidate(state, options, op, focusItem)
  return {
    candidates: step.candidate === null ? [] : [step.candidate],
    placeRefusal: step.refusal,
  }
}

/** One craft-plan step plus any placement refusal met while resolving it. */
interface CraftStep {
  candidate: Candidate | null
  refusal: PlaceRefusal | null
}

/** The craft path's candidates plus the typed placement refusal when a held station could not be placed. */
interface CraftCandidatesResult {
  candidates: Candidate[]
  placeRefusal: PlaceRefusal | null
}

/** Raw candidates plus the placement refusal one of them refused, for the gate to surface. */
interface RawCandidatesResult {
  candidates: Candidate[]
  placeRefusal: PlaceRefusal | null
}

/**
 * The single grounded candidate for one executable craft-plan op. The gate's
 * last-resort ladder calls it with the plan already computed as if no station
 * were available, so a table-requiring recipe falls back to crafting/placing the
 * station itself instead of waiting on an unreachable remembered one.
 */
function craftPlanStepCandidate(
  state: WorldState,
  options: CandidateOptions,
  op: CraftOp,
  focusItem: string,
): CraftStep {
  if (op.type === 'craft') {
    const table = op.requiresTable ? state.craftingTables.find(isSensedStation) ?? null : null
    if (op.requiresTable && table === null) return { candidate: null, refusal: null }
    const where = table === null ? 'inventory 2x2' : `at crafting_table (${table.x},${table.y},${table.z})`
    return {
      candidate: {
        id: `CRAFT:${op.item}`,
        kind: 'CRAFT',
        label: `${describeCraftOp(op)} ${where}, ${focusItem} subgoal`,
        targetName: op.item,
        target: table,
        targetEntityId: null,
        itemName: op.item,
        requiresTool: false,
        toolName: null,
        inReach: table === null || distance(table, state.self.eyePosition) <= options.reach,
        hasStandableAdjacent: true,
        meta: {
          tick: state.tick,
          craftItem: op.item,
          craftCount: op.count,
          requiresTable: op.requiresTable,
        },
      },
      refusal: null,
    }
  }

  const placement = heldStationPlacement(state, options, op.item, `craft ${focusItem}`)
  if (placement.spot !== null) {
    return {
      candidate: placeStationCandidate(state, options, op.item, placement.spot, `craft ${focusItem}`),
      refusal: null,
    }
  }
  return { candidate: placement.alternative, refusal: placement.refusal }
}

/**
 * The self-contained ladder step for the current craft goal, planned as if no
 * station were available. Its every input comes from the live inventory, so it
 * is executable NOW whenever it exists at all - the gate offers it before
 * declaring starvation.
 */
export function selfContainedCraftCandidates(
  state: WorldState,
  options: CandidateOptions,
): Candidate[] {
  const recipes = options.recipes ?? null
  const current = state.goalQueue?.current ?? null
  const focusItem = current?.targetItem ?? state.goal.targetItem ?? null
  if (recipes === null || focusItem === null || (current?.kind ?? 'collect') !== 'craft') return []
  const plan = planNextCraftStep(recipes, focusItem, state.inventory.counts, state.craftingTables.some(isSensedStation))
  if (plan.op === null) return []
  const step = craftPlanStepCandidate(state, options, plan.op, focusItem)
  return step.candidate === null ? [] : [step.candidate]
}

/**
 * #46: pick the placement spot with the fewest recorded failures so a failed
 * placement retries at a different nearby block instead of re-failing in place.
 */
function leastFailedPlacementSpot(state: WorldState, item: string): Vec3Json | null {
  const failed = state.signals.failedCandidates
  let best: Vec3Json | null = null
  let bestCount = Number.POSITIVE_INFINITY
  for (const spot of state.placementSpots) {
    const count = failed[`PLACE:${item}:${blockId('p', spot)}`] ?? 0
    if (count < bestCount) {
      best = spot
      bestCount = count
    }
  }
  return best
}

/**
 * PLACE candidate for a `place` subgoal (e.g. the M2 furnace). The item is in
 * the inventory and there is a grounded placement spot within reach.
 */
function placeCandidates(state: WorldState, options: CandidateOptions, focusItem: string | null): Candidate[] {
  if (focusItem === null) return []
  if ((state.inventory.counts[focusItem] ?? 0) <= 0) return []
  const spot = leastFailedPlacementSpot(state, focusItem)
  if (spot === null) return []
  return [
    {
      id: `PLACE:${focusItem}:${blockId('p', spot)}`,
      kind: 'PLACE',
      label: `place ${focusItem} at (${spot.x},${spot.y},${spot.z}), ${distance(spot, state.self.position)}m away`,
      targetName: focusItem,
      target: spot,
      targetEntityId: null,
      itemName: focusItem,
      requiresTool: false,
      toolName: null,
      inReach: distance(spot, state.self.eyePosition) <= options.reach,
      hasStandableAdjacent: true,
      meta: { tick: state.tick, x: spot.x, y: spot.y, z: spot.z },
    },
  ]
}

/**
 * SMELT candidate for a `smelt` subgoal: a placed furnace is in sensor range,
 * the input and a fuel item are in the inventory, and the output is still short.
 */
function smeltCandidates(state: WorldState, options: CandidateOptions, focusItem: string | null): Candidate[] {
  if (focusItem === null) return []
  const furnace = (state.furnaces ?? []).find(isSensedStation) ?? null
  if (furnace === null) return furnaceAcquisitionCandidates(state, options)
  const inputItem = smeltInputFor(state, focusItem)
  if (inputItem === null) return []
  const fuelItem = smeltFuelFor(state)
  if (fuelItem === null) return []

  const haveOutput = state.inventory.counts[focusItem] ?? 0
  const required = state.goalQueue?.current?.requiredCount ?? state.goal.requiredCount
  if (haveOutput >= required) return []
  const needed = Math.max(1, required - haveOutput)
  const available = state.inventory.counts[inputItem] ?? 0
  if (available <= 0) return []
  const count = Math.min(needed, available)
  const fuelCount = fuelCountFor(count, fuelItem)

  return [
    {
      id: `SMELT:${focusItem}`,
      kind: 'SMELT',
      label: `smelt ${count}x ${focusItem} from ${inputItem} in the furnace at (${furnace.x},${furnace.y},${furnace.z}) using ${fuelItem}`,
      targetName: focusItem,
      target: furnace,
      targetEntityId: null,
      itemName: focusItem,
      requiresTool: false,
      toolName: null,
      inReach: distance(furnace, state.self.eyePosition) <= options.reach,
      hasStandableAdjacent: true,
      meta: {
        tick: state.tick,
        furnaceX: furnace.x,
        furnaceY: furnace.y,
        furnaceZ: furnace.z,
        inputItem,
        inputCount: count,
        fuelItem,
        fuelCount,
        outputItem: focusItem,
        count,
        ...(state.signals.heldFurnacePlacedAt === blockId('b', furnace) ? { furnaceSource: 'held' } : {}),
      },
    },
  ]
}

function smeltInputFor(state: WorldState, focusItem: string): string | null {
  if (focusItem === 'charcoal') {
    const log = Object.keys(state.inventory.counts).find(
      (name) => name.endsWith('_log') && (state.inventory.counts[name] ?? 0) > 0,
    )
    return log ?? null
  }
  const mapped = smeltInputName(focusItem)
  if (mapped === null) return null
  return (state.inventory.counts[mapped] ?? 0) > 0 ? mapped : null
}

function smeltFuelFor(state: WorldState): string | null {
  return findInventoryFuel(state.inventory.counts)?.item ?? null
}

const EMPTY_STATIONS: ReadonlySet<string> = new Set<string>()

/** Remembered stations of one kind, nearest first. */
function knownStations(state: WorldState, station: string): KnownStationLike[] {
  const found: KnownStationLike[] = []
  for (const resource of state.signals.knownResources ?? []) {
    if (resource.kind !== 'station' || !resource.name.includes(station)) continue
    found.push({ name: resource.name, position: resource.position })
  }
  found.sort((a, b) => distance(a.position, state.self.position) - distance(b.position, state.self.position))
  return found
}

/**
 * Where the furnace craft step gets its 3x3 station. A sensed table is used in
 * place; a remembered reachable table is walked to; a held table is placed
 * first. Blacklisted stations are skipped, so the M2 blocker cannot re-select a
 * station the move-failure memory already proved unreachable.
 */
function craftingTableSource(
  state: WorldState,
  unreachableStations: ReadonlySet<string>,
  placeSpotRetryLimit: number,
): { kind: 'sensed' | 'remembered'; station: KnownStationLike } | { kind: 'held-place'; spot: Vec3Json } | null {
  const sensed = state.craftingTables.find(isSensedStation)
  if (sensed !== undefined) return { kind: 'sensed', station: { name: 'crafting_table', position: sensed } }
  const remembered = knownStations(state, 'crafting_table').find(
    (station) => !unreachableStations.has(knownStationKey(station)),
  )
  if (remembered !== undefined) return { kind: 'remembered', station: remembered }
  if ((state.inventory.counts.crafting_table ?? 0) <= 0) return null
  const spot =
    state.placementSpots.find(
      (candidate) =>
        (state.signals.failedCandidates[`PLACE:crafting_table:${blockId('p', candidate)}`] ?? 0) <
        placeSpotRetryLimit,
    ) ?? state.placementSpots[0]
  return spot === undefined ? null : { kind: 'held-place', spot }
}

/**
 * True when the recipe variant `planNextCraftStep` selected for this goal needs
 * a placed crafting_table. Re-planning with an assumed station (only the
 * `tableAvailable` flag changes) reports the chosen variant's own
 * `requiresTable`, so this never guesses from a second recipe lookup.
 */
function planRequiresTable(
  recipes: RecipeIndex,
  focusItem: string,
  counts: Readonly<Record<string, number>>,
): boolean {
  const op = planNextCraftStep(recipes, focusItem, counts, true).op
  return op !== null && op.type === 'craft' && op.requiresTable
}

/**
 * M2 craft deadlock: the station ladder for a table-requiring CRAFT goal,
 * mirroring the smelt prerequisite path (`craftFurnaceCandidate`):
 *
 *   (a) place a held crafting_table at a grounded spot (inventory first, #78);
 *   (b) walk to a remembered table the move-failure blacklist has not excluded;
 *   (c) else nothing - when the materials are held, `planNextCraftStep` already
 *       returns the 2x2 craft-table step and the caller falls through to it.
 *
 * `heldStationPlacement` is the same mechanical solve the place branch uses, so
 * a held table the known terrain can host is placed even when the strict live
 * spot scan is empty; a genuine geometry dead end is refused with its typed
 * reason and the grounded alternative instead of collapsing to nothing.
 */
function tableAcquisitionCandidates(
  state: WorldState,
  options: CandidateOptions,
  focusItem: string,
): CraftCandidatesResult {
  const holdsTable = (state.inventory.counts.crafting_table ?? 0) > 0
  const unreachableStations = options.unreachableStations ?? EMPTY_STATIONS
  const remembered = knownStations(state, 'crafting_table').find(
    (station) => !unreachableStations.has(knownStationKey(station)),
  )
  if (holdsTable) {
    const placement = heldStationPlacement(state, options, 'crafting_table', `craft ${focusItem}`)
    if (placement.spot !== null) {
      return {
        candidates: [placeStationCandidate(state, options, 'crafting_table', placement.spot, `craft ${focusItem}`)],
        placeRefusal: null,
      }
    }
    if (remembered !== undefined) {
      return { candidates: [knownStationRetrievalCandidate(state, options, remembered)], placeRefusal: null }
    }
    return {
      candidates: placement.alternative === null ? [] : [placement.alternative],
      placeRefusal: placement.refusal,
    }
  }
  if (remembered !== undefined) return { candidates: [knownStationRetrievalCandidate(state, options, remembered)], placeRefusal: null }
  return { candidates: [], placeRefusal: null }
}

/**
 * Issue #58: build the pure cost/feasibility input for the furnace precondition
 * from the live world state and the explicit station blacklist. `tableAvailable`
 * is true for any table the bot can actually reach (`craftingTableSource`), so
 * an unreachable remembered furnace no longer leaves `craft_and_place`
 * infeasible and the whole prerequisite collapsing to WAIT.
 */
export function furnacePrereqInputFromState(state: WorldState, options: CandidateOptions): PrereqInput {
  const counts = state.inventory.counts
  let stoneCount = 0
  for (const [name, count] of Object.entries(counts)) {
    if (count > 0 && matchesResourceClass(name, 'stone')) stoneCount += count
  }
  const unreachableStations = options.unreachableStations ?? EMPTY_STATIONS
  const furnaces = knownStations(state, 'furnace')
  const reachableFurnace = furnaces.find((station) => !unreachableStations.has(knownStationKey(station))) ?? null
  return {
    goal: state.goalQueue?.current ?? null,
    heldCount: counts.furnace ?? 0,
    placedCount: (state.furnaces ?? []).filter(isSensedStation).length,
    stoneCount,
    tableAvailable:
      craftingTableSource(
        state,
        unreachableStations,
        options.placeSpotRetryLimit ?? DEFAULT_PLACE_SPOT_RETRY_LIMIT,
      ) !== null,
    placementSpot: state.placementSpots.length > 0 ? leastFailedPlacementSpot(state, 'furnace') : null,
    knownStation: reachableFurnace ?? furnaces[0] ?? null,
    unreachableStations,
    self: state.self.position,
  }
}

/** One grounded candidate for each feasible path (craft_and_place = the CRAFT step). */
function candidatesForPrereqPath(
  state: WorldState,
  options: CandidateOptions,
  path: PrereqPath,
  input: PrereqInput,
): Candidate[] {
  switch (path) {
    case 'place_held':
      return placeCandidates(state, options, 'furnace')
    case 'use_known_station': {
      const known = input.knownStation
      return known === null ? [] : [knownStationRetrievalCandidate(state, options, known)]
    }
    case 'craft_and_place':
      return craftFurnaceCandidate(state, options)
  }
}

/** CRAFT/PLACE step toward a furnace: use a table in reach, walk to a remembered one, or place a held one. */
function craftFurnaceCandidate(state: WorldState, options: CandidateOptions): Candidate[] {
  const source = craftingTableSource(
    state,
    options.unreachableStations ?? EMPTY_STATIONS,
    options.placeSpotRetryLimit ?? DEFAULT_PLACE_SPOT_RETRY_LIMIT,
  )
  if (source === null) return []
  if (source.kind === 'held-place') {
    return [placeStationCandidate(state, options, 'crafting_table', source.spot, `craft ${FURNACE_STONE_COST} cobblestone into a furnace`)]
  }
  if (source.kind === 'remembered') {
    return [knownStationRetrievalCandidate(state, options, source.station)]
  }
  const table = source.station.position
  return [
    {
      id: 'CRAFT:furnace',
      kind: 'CRAFT',
      label: `craft 1 x furnace from ${FURNACE_STONE_COST} cobblestone at the crafting table, then place it`,
      targetName: 'furnace',
      target: table,
      targetEntityId: null,
      itemName: 'furnace',
      requiresTool: false,
      toolName: null,
      inReach: distance(table, state.self.eyePosition) <= options.reach,
      hasStandableAdjacent: true,
      meta: { tick: state.tick, craftItem: 'furnace', craftCount: 1, requiresTable: true, furnaceSource: 'craft', tableSource: 'sensed' },
    },
  ]
}

/**
 * Issue #58: enumerate EVERY feasible way to satisfy "a usable furnace is
 * available" (place held / use known station / craft-and-place), score them by
 * cost, and return the candidates cheapest-path-first. Each candidate carries
 * `meta.prereqPath` so the controller can log `PREREQ_OPTION` and suppress the
 * paths that lost.
 */
function furnaceAcquisitionCandidates(state: WorldState, options: CandidateOptions): Candidate[] {
  if (prereqSubjectForGoal(state.goalQueue?.current ?? null) === null) return []
  const input = furnacePrereqInputFromState(state, options)
  const decision = planPrereqOptions(input)
  const out: Candidate[] = []
  for (const option of decision.options) {
    if (!option.feasible) continue
    for (const candidate of candidatesForPrereqPath(state, options, option.path, input)) {
      out.push({
        ...candidate,
        meta: {
          ...candidate.meta,
          prereqPath: option.path,
          prereqCost: Math.round(option.cost * 10) / 10,
          ...(option.path === 'place_held' ? { furnaceSource: 'held' } : {}),
        },
      })
    }
  }
  return out
}

/**
 * Why a remembered non-furnace station is retrieved: a smelt goal walks to a
 * table to craft its furnace, a table-requiring craft goal walks to one to
 * craft its target.
 */
function stationRetrievalPurpose(state: WorldState): string {
  const goal = state.goalQueue?.current ?? null
  const focus = goal?.targetItem ?? state.goal.targetItem
  if (goal?.kind === 'craft' && typeof focus === 'string' && focus.length > 0) return `craft ${focus}`
  return 'craft a furnace'
}

/**
 * Flatten a vertical plan into candidate meta, mirroring the executor's
 * `vertical=reuse|staircase|staircase-up|pillar` contract.
 */
function verticalPlanMeta(
  vertical: VerticalPlan | null,
  fallbackFromY: number,
  fallbackToY: number,
): Record<string, string | number | boolean> {
  const meta: Record<string, string | number | boolean> = {
    vertical: vertical?.kind ?? 'none',
    verticalFromY: vertical?.fromY ?? fallbackFromY,
    verticalToY: vertical?.toY ?? fallbackToY,
  }
  switch (vertical?.kind) {
    case undefined:
      return meta
    case 'reuse':
      meta.tunnelX = vertical.tunnel.x
      meta.tunnelY = vertical.tunnel.y
      meta.tunnelZ = vertical.tunnel.z
      return meta
    case 'staircase':
      meta.stairDir = vertical.dir
      meta.stairFromY = vertical.fromY
      meta.stairToY = vertical.toY
      meta.stairDigX = vertical.dig.x
      meta.stairDigY = vertical.dig.y
      meta.stairDigZ = vertical.dig.z
      meta.stairStepX = vertical.step.x
      meta.stairStepY = vertical.step.y
      meta.stairStepZ = vertical.step.z
      meta.stairBlockName = vertical.digName ?? 'unknown'
      return meta
    case 'staircase-up':
      meta.upDir = vertical.dir
      meta.upFromY = vertical.fromY
      meta.upToY = vertical.toY
      meta.upDigX = vertical.dig.x
      meta.upDigY = vertical.dig.y
      meta.upDigZ = vertical.dig.z
      meta.upStepX = vertical.step.x
      meta.upStepY = vertical.step.y
      meta.upStepZ = vertical.step.z
      meta.upBlockName = vertical.digName ?? 'unknown'
      return meta
    case 'pillar':
      meta.pillarFromY = vertical.fromY
      meta.pillarToY = vertical.toY
      meta.pillarSteps = vertical.steps
      meta.pillarPlaceName = vertical.placeName
      meta.pillarPlaceCount = vertical.placeCount
      return meta
  }
}

function verticalPlanLabel(vertical: VerticalPlan | null): string {
  switch (vertical?.kind) {
    case undefined:
      return ''
    case 'reuse':
      return ` (reuse the tunnel at ${vertical.tunnel.x},${vertical.tunnel.y},${vertical.tunnel.z})`
    case 'staircase':
      return ` (dig a staircase down from y=${vertical.fromY} toward y=${vertical.toY})`
    case 'staircase-up':
      return ` (cut a staircase up at (${vertical.dig.x},${vertical.dig.y},${vertical.dig.z}) from y=${vertical.fromY} toward y=${vertical.toY})`
    case 'pillar':
      return ` (pillar up ${vertical.steps} block(s) from y=${vertical.fromY} toward y=${vertical.toY} with ${vertical.placeName})`
  }
}

function knownStationRetrievalCandidate(
  state: WorldState,
  options: CandidateOptions,
  known: KnownStationLike,
): Candidate {
  const isFurnace = known.name.includes('furnace')
  const purpose = isFurnace ? 'smelt' : stationRetrievalPurpose(state)
  const vertical = planVerticalApproach({
    selfFeetY: state.self.position.y,
    selfPosition: state.self.position,
    target: known.position,
    tunnel: state.signals.lastTunnel,
    descent: state.descent,
    stepCuts: state.stepCuts,
    placeable: selectPlaceableBlock(state.inventory.counts),
    columnSafe: !pillarColumnUnsafeFromBlocks(state.self.position, state.blocks),
  })
  const verticalMeta = verticalPlanMeta(vertical, Math.floor(state.self.position.y), known.position.y)
  return {
    id: `RETRIEVE:known:station:${known.name}:${blockId('b', known.position)}`,
    kind: 'RETRIEVE',
    label: `return to the remembered ${known.name} at (${known.position.x},${known.position.y},${known.position.z}) to ${purpose}, ${distance(known.position, state.self.position)}m away${verticalPlanLabel(vertical)}`,
    targetName: known.name,
    target: known.position,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: distance(known.position, state.self.eyePosition) <= options.reach,
    hasStandableAdjacent: true,
    meta: {
      tick: state.tick,
      retrieval: 'known',
      resource: isFurnace ? 'furnace' : 'crafting_table',
      resourceKind: 'station',
      knownName: known.name,
      ...(isFurnace ? { furnaceSource: 'known' } : { tableSource: 'remembered' }),
      x: known.position.x,
      y: known.position.y,
      z: known.position.z,
      ...verticalMeta,
    },
  }
}

function nearestResource(state: WorldState, focusItem: string | null): BlockState | null {
  let best: BlockState | null = null
  for (const block of state.blocks) {
    if (block.kind === 'hazard') continue
    if (focusItem !== null && !resourceMatches(block.yield, focusItem)) continue
    if (best === null || block.distance < best.distance) best = block
  }
  return best
}

interface RetrievalWant {
  item: string
  kind: 'ore' | 'log'
  blockNames: readonly string[]
}

function retrievalWant(focusItem: string | null): RetrievalWant | null {
  if (focusItem === null) return null
  const ores = ORE_SOURCES[focusItem]
  if (ores !== undefined) return { item: focusItem, kind: 'ore', blockNames: ores }
  if (
    focusItem === 'charcoal' ||
    focusItem === 'log' ||
    focusItem === 'planks' ||
    focusItem === 'fuel' ||
    focusItem.endsWith('_log')
  ) {
    return { item: focusItem, kind: 'log', blockNames: [] }
  }
  return null
}

const RETRIEVAL_NEED_CAP = 6

/** Issue #43: the live-inventory fuel, or null. */
export function fuelSatisfaction(state: WorldState): InventoryFuel | null {
  return findInventoryFuel(state.inventory.counts)
}

/** The exact skip line emitted when a fuel need is already covered by the inventory. */
export function formatFuelSatisfied(item: string, have: number): string {
  return `FUEL_SATISFIED item=${item} have=${have} -> skip`
}

/** True when the current subgoal exists only to obtain furnace fuel. */
export function goalWantsFuel(goal: { kind?: string; description?: string; targetItem?: string | null } | null): boolean {
  if (goal === null) return false
  if (goal.kind === 'smelt') return true
  return goalCollectsFuel(goal)
}

/** True when the subgoal is a collect whose completion is a fuel substitute. */
export function goalCollectsFuel(goal: { kind?: string; description?: string; targetItem?: string | null } | null): boolean {
  if (goal === null || goal.kind !== 'collect') return false
  if (goal.targetItem === 'fuel' || goal.targetItem === 'planks') return true
  return typeof goal.description === 'string' && /\(fuel\)/i.test(goal.description)
}

/**
 * Issue #43: a retrieval need that a held fuel item already satisfies, so the
 * surface/known trip must not be emitted. The caller only consults this for a
 * fuel need; a `charcoal` smelt still needs its own log input to be held.
 */
export function fuelNeedSatisfiedByInventory(state: WorldState, item: string): boolean {
  const fuel = fuelSatisfaction(state)
  if (fuel === null) return false
  if (item === 'charcoal') return hasLogInInventory(state)
  return true
}

function hasLogInInventory(state: WorldState): boolean {
  return Object.entries(state.inventory.counts).some(
    ([name, count]) => count > 0 && (name.endsWith('_log') || name.endsWith('_wood')),
  )
}

/**
 * Issue #14: the ordered list of items the body actually needs next - the
 * current subgoal first, then the queued goals. A `collect cobblestone (descend
 * toward ore levels)` proxy must not hide the real need (raw_iron) when a
 * remembered ore coordinate exists, so callers consult the queue, not only
 * `focusItem`. Pure.
 */
function retrievalNeeds(state: WorldState, focusItem: string | null): RetrievalWant[] {
  const current = state.goalQueue?.current ?? null
  const needs: Array<{ item: string; fuel: boolean }> = []
  const push = (item: string | null | undefined, fuel: boolean): void => {
    if (typeof item !== 'string' || item.length === 0 || needs.some((need) => need.item === item)) return
    needs.push({ item, fuel })
  }
  push(focusItem, goalWantsFuel(current))
  push(state.goal.targetItem, goalWantsFuel(current))
  for (const queued of state.goalQueue.goals) push(queued.targetItem, goalWantsFuel(queued))
  const wants: RetrievalWant[] = []
  for (const need of needs) {
    if (need.fuel && fuelNeedSatisfiedByInventory(state, need.item)) continue
    const want = retrievalWant(need.item)
    if (want !== null) wants.push(want)
    if (wants.length >= RETRIEVAL_NEED_CAP) break
  }
  return wants
}

function visibleBlockFor(state: WorldState, want: RetrievalWant): BlockState | null {
  if (want.kind === 'ore') {
    return state.blocks.find((block) => block.kind === 'ore' && resourceMatches(block.yield, want.item)) ?? null
  }
  return state.blocks.find((block) => block.kind === 'log') ?? null
}

function knownResourceFor(state: WorldState, want: RetrievalWant): KnownResource | null {
  const known = state.signals.knownResources ?? []
  let best: KnownResource | null = null
  for (const resource of known) {
    const matches = want.kind === 'ore' ? want.blockNames.includes(resource.name) : resource.name.endsWith('_log')
    if (!matches) continue
    if (resourceDepleted(state, resource)) continue
    if (best === null || distance(resource.position, state.self.position) < distance(best.position, state.self.position)) {
      best = resource
    }
  }
  return best
}

export const KNOWN_RESOURCE_PROOF_DISTANCE = 8

function resourceDepleted(
  state: WorldState,
  resource: KnownResource,
  proofDistance = KNOWN_RESOURCE_PROOF_DISTANCE,
): boolean {
  if (distance(resource.position, state.self.position) > proofDistance) return false
  return !state.blocks.some(
    (block) =>
      block.kind !== 'hazard' &&
      block.position.x === resource.position.x &&
      block.position.y === resource.position.y &&
      block.position.z === resource.position.z,
  )
}

/**
 * Issue #14 staleness: remembered ore/log cells close enough that the sensor
 * would have seen the block if it still existed, but which are absent from the
 * current block list (mined/replaced). The controller logs KNOWN_RESOURCE_STALE
 * for these and the durable store drops them. Pure.
 */
export function staleKnownResources(
  state: WorldState,
  proofDistance = KNOWN_RESOURCE_PROOF_DISTANCE,
): KnownResource[] {
  return (state.signals.knownResources ?? []).filter(
    (resource) => (resource.kind === 'ore' || resource.kind === 'log') && resourceDepleted(state, resource, proofDistance),
  )
}

function retrievalCandidatesForWant(state: WorldState, options: CandidateOptions, want: RetrievalWant): Candidate[] {
  if (visibleBlockFor(state, want) !== null) return []
  const known = knownResourceFor(state, want)
  if (known !== null) {
    const id = `RETRIEVE:known:${want.item}:${blockId('b', known.position)}`
    if (
      failureCount(state.signals.failedCandidates, id) >=
      (options.moveFailureLimit ?? DEFAULT_CANDIDATE_MOVE_FAILURE_LIMIT)
    )
      return []
    // Issue #45: a remembered resource below the current level needs a vertical
    // leg (reuse a tunnel, else dig a staircase step) or retrieval stalls at the
    // horizontal bearing and falls back to WAIT.
    const vertical = planVerticalApproach({
      selfFeetY: state.self.position.y,
      selfPosition: state.self.position,
      target: known.position,
      tunnel: state.signals.lastTunnel,
      descent: state.descent,
      stepCuts: state.stepCuts,
      placeable: selectPlaceableBlock(state.inventory.counts),
      columnSafe: !pillarColumnUnsafeFromBlocks(state.self.position, state.blocks),
    })
    const verticalMeta = verticalPlanMeta(vertical, Math.floor(state.self.position.y), known.position.y)
    const verticalLabel = verticalPlanLabel(vertical)
    return [
      {
        id,
        kind: 'RETRIEVE',
        label: `return to remembered ${known.name} at (${known.position.x},${known.position.y},${known.position.z}) for ${want.item}, ${distance(known.position, state.self.position)}m away${verticalLabel}`,
        targetName: known.name,
        target: known.position,
        targetEntityId: null,
        itemName: null,
        requiresTool: false,
        toolName: null,
        inReach: distance(known.position, state.self.eyePosition) <= options.reach,
        hasStandableAdjacent: true,
        meta: {
          tick: state.tick,
          retrieval: 'known',
          resource: want.item,
          resourceKind: want.kind,
          knownName: known.name,
          x: known.position.x,
          y: known.position.y,
          z: known.position.z,
          ...verticalMeta,
        },
      },
    ]
  }
  if (want.kind !== 'log') return []
  const spot = surfaceSpot(state, want.item, options.moveFailureLimit ?? DEFAULT_CANDIDATE_MOVE_FAILURE_LIMIT)
  if (spot === null) return []
  return [
    {
      id: `RETRIEVE:surface:${want.item}:${blockId('p', spot)}`,
      kind: 'RETRIEVE',
      label: `explore the surface for ${want.item} (logs are a surface resource; none visible from y=${Math.round(state.self.position.y)}), stand at (${spot.x},${spot.y},${spot.z})`,
      targetName: null,
      target: spot,
      targetEntityId: null,
      itemName: null,
      requiresTool: false,
      toolName: null,
      inReach: distance(spot, state.self.eyePosition) <= options.reach,
      hasStandableAdjacent: true,
      meta: {
        tick: state.tick,
        retrieval: 'surface',
        resource: want.item,
        resourceKind: 'log',
        surface: true,
        x: spot.x,
        y: spot.y,
        z: spot.z,
      },
    },
  ]
}

/**
 * Issue #14: offer a grounded return-to-known candidate for the earliest need
 * in the queue that has a remembered coordinate but no visible block. Returns
 * only the first satisfiable need so the probe stays bounded.
 */
function retrievalCandidates(state: WorldState, options: CandidateOptions, focusItem: string | null): Candidate[] {
  for (const want of retrievalNeeds(state, focusItem)) {
    const candidates = retrievalCandidatesForWant(state, options, want)
    if (candidates.length > 0) return candidates
  }
  return []
}

function surfaceSpot(state: WorldState, item: string, moveFailureLimit: number): Vec3Json | null {
  let best: Vec3Json | null = null
  for (const spot of state.terrain.standable) {
    if (spot.y <= state.self.position.y + 2) continue
    const id = `RETRIEVE:surface:${item}:${blockId('p', spot)}`
    if (failureCount(state.signals.failedCandidates, id) >= moveFailureLimit) continue
    if (best === null || spot.y > best.y) best = spot
  }
  return best
}

function pickFood(state: WorldState): string | null {
  let best: string | null = null
  let bestCount = 0
  for (const [name, count] of Object.entries(state.inventory.counts)) {
    if (!FOOD_ITEMS.has(name)) continue
    if (count > bestCount) {
      best = name
      bestCount = count
    }
  }
  return best
}

function nearestDanger(state: WorldState, radius: number): BlockState | null {
  let nearest: BlockState | null = null
  for (const block of state.blocks) {
    if (block.kind !== 'hazard') continue
    if (block.distance > radius) continue
    if (nearest === null || block.distance < nearest.distance) nearest = block
  }
  return nearest
}

function pickRetreat(
  state: WorldState,
  standable: Vec3Json[],
  danger: BlockState | null,
): Vec3Json | null {
  const hurt = state.self.health <= 6
  if (danger === null && !hurt) return null
  const threat = danger?.position ?? state.self.position
  let best: Vec3Json | null = null
  let bestScore = Number.NEGATIVE_INFINITY
  for (const spot of standable) {
    const score = distance(spot, threat)
    if (score > bestScore) {
      bestScore = score
      best = spot
    }
  }
  if (best === null) return null
  if (bestScore < HAZARD_DANGER_RADIUS) return null
  return best
}

/**
 * Exploration target when the subgoal produced nothing.
 *
 * Two properties are required and both were bugs before:
 *  1. the NEAREST useful standable target is preferred (the old farthest-first
 *     pick oscillated between two spots 181x/180x and never made progress);
 *  2. when the subgoal resource is known, the spot that most reduces the
 *     distance to that resource is preferred, so exploring walks toward the
 *     resource beyond the move band instead of wandering away from it.
 */
function pickExplore(
  state: WorldState,
  standable: Vec3Json[],
  focusItem: string | null,
  moveFailureLimit: number,
): Vec3Json | null {
  const options = standable.filter(
    (spot) =>
      distance(spot, state.self.position) > 1.5 &&
      failureCount(state.signals.failedCandidates, `MOVE:${blockId('p', spot)}`) < moveFailureLimit,
  )
  if (options.length === 0) return null

  const resource = nearestResource(state, focusItem)
  if (resource !== null) {
    const currentDistance = distance(state.self.position, resource.position)
    let best: Vec3Json | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const spot of options) {
      const toResource = distance(spot, resource.position)
      if (toResource >= currentDistance) continue
      const score = toResource + distance(spot, state.self.position) * 0.1
      if (score < bestScore) {
        bestScore = score
        best = spot
      }
    }
    if (best !== null) return best
  }

  let best: Vec3Json | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const spot of options) {
    const d = distance(spot, state.self.position)
    if (d < bestDistance) {
      bestDistance = d
      best = spot
    }
  }
  return best
}

// --- affordance gate (#11 v2): only mechanically reachable targets are presented
//
// Candidates are FACTS provided to Jev, so a locomotion target the body cannot
// physically reach with its current inventory/abilities must not be offered at
// all. The gate evaluates each MOVE/RETRIEVE/RETREAT target through the pure
// reachability module, withholds the infeasible ones with a typed reason and
// missing-capability list, offers the grounded capability-acquisition candidates
// that would fix them, and suppresses a proven-unreachable target while its
// semantic state fingerprint is unchanged.

const LOCOMOTION_GATED_KINDS: ReadonlySet<CandidateKind> = new Set<CandidateKind>([
  'MOVE',
  'RETRIEVE',
  'RETREAT',
])

/**
 * Candidate-local capability attribution, by kind:
 *   MINE              -> the harvest tool tier of the block IT names;
 *   MOVE/RETRIEVE/
 *   RETREAT           -> path/vertical feasibility of ITS OWN destination;
 *   CRAFT/PLACE/SMELT -> not gated: the generator emits them only when their
 *                        own recipe/input/station requirement is satisfiable
 *                        NOW, so they must never inherit a sibling's tool need.
 */
const REACHABILITY_GATED_KINDS: ReadonlySet<CandidateKind> = new Set<CandidateKind>([
  'MINE',
  ...LOCOMOTION_GATED_KINDS,
])

export interface ColumnFacts {
  placeable: ReturnType<typeof selectPlaceableBlock>
  columnSafe: boolean
  footingSolid: boolean
  headroomClear: boolean
  headroomCell: Vec3Json | null
}

interface ReachabilityGateContext {
  state: WorldState
  options: CandidateOptions
  memory: StateFingerprintMemory | null
  column: ColumnFacts
}

export function applyReachabilityGate(
  raw: readonly Candidate[],
  state: WorldState,
  options: CandidateOptions = defaultCandidateOptions,
  placeRefusal: PlaceRefusal | null = null,
): GroundedCandidatesResult {
  const context: ReachabilityGateContext = {
    state,
    options,
    memory: options.reachability?.memory ?? null,
    column: columnFacts(state),
  }
  const presented: Candidate[] = []
  const reachability: CandidateReachability[] = []
  const withheld: CandidateReachability[] = []

  const run = (candidates: readonly Candidate[]): void => {
    for (const candidate of candidates) {
      const record = evaluateCandidate(candidate, context)
      if (record === null) {
        presented.push(withAffordance(candidate, null))
        continue
      }
      reachability.push(record)
      if (record.result.reachable) {
        context.memory?.forget(candidate.id)
        presented.push(record.candidate)
        continue
      }
      record.withheld = true
      record.suppressed = context.memory?.isSuppressed(candidate.id, record.fingerprint) ?? false
      context.memory?.record(candidate.id, record.fingerprint, record.result.reason)
      withheld.push(record)
    }
  }

  run(raw)
  const acquisitions = capabilityAcquisitionCandidates(
    state,
    options,
    withheld,
    new Set(presented.map((candidate) => candidate.id)),
  )
  run(acquisitions)

  // Last-resort candidate-local ladder: one unreachable remembered station must
  // not starve a craft goal whose own recipe inputs are all held - the step that
  // crafts/places the station from those inputs is satisfiable NOW.
  if (presented.every((candidate) => candidate.kind === 'WAIT' || candidate.kind === 'ESCALATE')) {
    const seen = new Set([...presented.map((candidate) => candidate.id), ...withheld.map((entry) => entry.candidate.id)])
    run(selfContainedCraftCandidates(state, options).filter((candidate) => !seen.has(candidate.id)))
  }

  const waite = presented.filter((candidate) => candidate.kind === 'WAIT' || candidate.kind === 'ESCALATE')
  const productive = presented.filter((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')
  const candidates = [...productive, ...waite]
  if (
    withheld.length > 0 &&
    productive.length === 0 &&
    !waite.some((candidate) => candidate.kind === 'ESCALATE')
  ) {
    candidates.push(escalateRefusal(state, withheld))
  }
  return { candidates, reachability, withheld, placeRefusal }
}

/** null when the candidate carries no capability precondition of its own. */
function evaluateCandidate(
  candidate: Candidate,
  context: ReachabilityGateContext,
): CandidateReachability | null {
  const position = candidate.target
  if (position === null || !REACHABILITY_GATED_KINDS.has(candidate.kind)) return null
  if (candidate.kind === 'MINE') return evaluateMineCandidate(candidate, context)
  const target = reachabilityTargetFor(context.state, candidate)
  const world = reachabilityWorldFor(context.state, candidate, context.options.reach, context.column)
  const abilities = deriveReachabilityAbilities(context.state, position, context.column)
  const probe = context.options.reachability?.pathProbe?.(position) ?? 'unknown'
  const result = evaluateReachability(target, world, context.state.inventory.counts, abilities, probe)
  return reachabilityRecord(candidate, target, world, result, context)
}

/**
 * A MINE candidate is dug in place: its only precondition is the harvest tool
 * tier of the block IT names. Path, vertical gap and standable approach are NOT
 * part of its contract, so it must not be run through the locomotion evaluator
 * (that would withhold a block already in reach).
 */
function evaluateMineCandidate(
  candidate: Candidate,
  context: ReachabilityGateContext,
): CandidateReachability | null {
  const barrier = barrierForCandidate(context.state, candidate)
  if (barrier === null) return null
  const missing = missingToolCapability(barrier, context.state.inventory.counts)
  const result: ReachabilityResult =
    missing === null
      ? { reachable: true, reason: 'reachable', missingCapabilities: [] }
      : { reachable: false, reason: 'missing_tool', missingCapabilities: [missing] }
  const target: ReachabilityTarget = { candidateId: candidate.id, kind: candidate.kind, position: candidate.target, barrier }
  const world = reachabilityWorldFor(context.state, candidate, context.options.reach, context.column)
  return reachabilityRecord(candidate, target, world, result, context)
}

function reachabilityRecord(
  candidate: Candidate,
  target: ReachabilityTarget,
  world: ReachabilityWorld,
  result: ReachabilityResult,
  context: ReachabilityGateContext,
): CandidateReachability {
  return {
    candidate: withAffordance(candidate, result),
    result,
    fingerprint: reachabilityFingerprint({
      target,
      result,
      inventory: context.state.inventory.counts,
      world,
      placeableBlock: context.column.placeable !== null,
    }),
    withheld: false,
    suppressed: false,
  }
}

function withAffordance(candidate: Candidate, result: ReachabilityResult | null): Candidate {
  const affordance: CandidateAffordance =
    result === null
      ? { feasible: true, reason: 'reachable', missingCapabilities: [] }
      : {
          feasible: result.reachable,
          reason: result.reason,
          missingCapabilities: result.missingCapabilities,
        }
  return { ...candidate, affordance }
}

function reachabilityTargetFor(state: WorldState, candidate: Candidate): ReachabilityTarget {
  return {
    candidateId: candidate.id,
    kind: candidate.kind,
    position: candidate.target,
    barrier: barrierForCandidate(state, candidate),
  }
}

/**
 * The block a candidate must break, resolved ONLY from the candidate's own
 * coordinates: `meta.targetBlock*` when the candidate walks toward a block, else
 * its own destination cell (a MINE candidate targets the block itself). Never a
 * block the candidate does not name.
 */
function barrierForCandidate(state: WorldState, candidate: Candidate): ReachabilityBarrier | null {
  const x = candidate.meta.targetBlockX
  const y = candidate.meta.targetBlockY
  const z = candidate.meta.targetBlockZ
  const cell =
    typeof x === 'number' && typeof y === 'number' && typeof z === 'number'
      ? { x, y, z }
      : candidate.kind === 'MINE'
        ? candidate.target
        : null
  const block =
    cell === null
      ? undefined
      : state.blocks.find(
          (entry) => entry.position.x === cell.x && entry.position.y === cell.y && entry.position.z === cell.z,
        )
  if (block === undefined || block.harvestTool == null) return null
  return {
    position: block.position,
    name: block.name,
    requiredTool: block.harvestTool,
    requiredTier: block.harvestTier ?? null,
  }
}

function columnFacts(state: WorldState): ColumnFacts {
  const feet = {
    x: Math.floor(state.self.position.x),
    y: Math.floor(state.self.position.y),
    z: Math.floor(state.self.position.z),
  }
  const ownCut = (state.headroomCuts ?? []).find(
    (cut) => cut.pos.x === feet.x && cut.pos.z === feet.z && (cut.pos.y === feet.y + 1 || cut.pos.y === feet.y + 2),
  )
  return {
    placeable: selectPlaceableBlock(state.inventory.counts),
    columnSafe: !pillarColumnUnsafeFromBlocks(state.self.position, state.blocks),
    footingSolid: state.terrain.standable.some((spot) => {
      const cell = { x: Math.floor(spot.x), y: Math.floor(spot.y), z: Math.floor(spot.z) }
      return cell.x === feet.x && cell.z === feet.z && (cell.y === feet.y || cell.y === feet.y - 1)
    }),
    headroomClear: ownCut === undefined,
    headroomCell: ownCut?.pos ?? null,
  }
}

function reachabilityWorldFor(
  state: WorldState,
  candidate: Candidate,
  reach: number,
  column: ColumnFacts,
): ReachabilityWorld {
  const position = candidate.target
  return {
    self: state.self.position,
    approach: candidate.hasStandableAdjacent ? position : null,
    reach,
    hazardAtTarget:
      position !== null &&
      state.blocks.some((block) => block.kind === 'hazard' && distance(block.position, position) <= HAZARD_PROXIMITY),
    footingSolid: column.footingSolid,
    headroomClear: column.headroomClear,
  }
}

export function deriveReachabilityAbilities(
  state: WorldState,
  target: Vec3Json,
  column: ColumnFacts = columnFacts(state),
): ReachabilityAbilities {
  const counts = state.inventory.counts
  const dy = Math.round(target.y - state.self.position.y)
  const plan = planVerticalApproach({
    selfFeetY: state.self.position.y,
    selfPosition: state.self.position,
    target,
    tunnel: state.signals.lastTunnel,
    descent: state.descent,
    stepCuts: state.stepCuts,
    placeable: column.placeable,
    columnSafe: column.columnSafe,
  })

  // A pillar plan is only mechanically executable from a supported, safe column
  // with jump headroom. Live evidence: PILLAR_UP was planned 1647x but refused
  // with `reason=no_footing` / `reason=no_headroom cause=needs_tool`, so a plan
  // alone must not count as an available ascend ability.
  const ascendPlanAvailable =
    plan !== null &&
    (plan.kind !== 'pillar' || (column.columnSafe && column.footingSolid && column.headroomClear))

  const ascendMissing: Capability[] = []
  if (dy > ASCEND_GAP_LIMIT && !ascendPlanAvailable) {
    if (column.placeable === null) ascendMissing.push({ kind: 'placeable_block' })
    if (!column.columnSafe) ascendMissing.push({ kind: 'safe_column' })
    else if (!column.footingSolid) ascendMissing.push({ kind: 'safe_column' })
    if (!column.headroomClear) {
      ascendMissing.push({ kind: 'headroom', cell: column.headroomCell })
      const cell = column.headroomCell
      const blocker =
        cell === null
          ? undefined
          : state.blocks.find(
              (block) =>
                block.position.x === cell.x && block.position.y === cell.y && block.position.z === cell.z,
            )
      if (blocker?.harvestTool != null) {
        const tier = blocker.harvestTier ?? 0
        if (bestToolTier(counts, blocker.harvestTool) < tier) {
          ascendMissing.push({ kind: 'tool', tool: blocker.harvestTool, tier })
        }
      }
    }
    if (ascendMissing.length === 0) ascendMissing.push({ kind: 'ascend_plan' })
  }

  const descendMissing: Capability[] = []
  if (dy < -DESCEND_GAP_LIMIT) {
    if (plan === null) {
      descendMissing.push({ kind: 'descend_plan' })
    } else if (plan.kind === 'staircase' && typeof plan.harvestTool === 'string') {
      const tier = plan.harvestTier ?? 0
      if (bestToolTier(counts, plan.harvestTool) < tier) {
        descendMissing.push({ kind: 'tool', tool: plan.harvestTool, tier })
      }
    }
  }

  return {
    ascend: { available: ascendMissing.length === 0, missing: ascendMissing },
    descend: { available: descendMissing.length === 0, missing: descendMissing },
  }
}

/** Grounded candidates that would acquire a withheld target's missing capability. */
function capabilityAcquisitionCandidates(
  state: WorldState,
  options: CandidateOptions,
  withheld: readonly CandidateReachability[],
  existingIds: ReadonlySet<string>,
): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<string>(existingIds)
  // A candidate already withheld this cycle must never be re-emitted: the
  // acquisition pass would re-evaluate the same id and double-record its
  // refusal (issue: duplicated withheld work).
  for (const entry of withheld) seen.add(entry.candidate.id)
  for (const entry of withheld) {
    for (const capability of entry.result.missingCapabilities) {
      let source: Candidate[] = []
      if (capability.kind === 'headroom') {
        source = headroomCandidates(state, options)
      } else if (capability.kind === 'tool') {
        const item = toolItemForCapability(capability)
        if (item !== null) source = craftCandidates(state, options, item).candidates
      }
      for (const candidate of source) {
        if (seen.has(candidate.id)) continue
        seen.add(candidate.id)
        out.push({
          ...withAffordance(candidate, null),
          meta: {
            ...candidate.meta,
            capabilityAcquisition: true,
            missingCapability: capabilityKey(capability),
          },
        })
      }
    }
  }
  return out
}

function toolItemForCapability(capability: Capability): string | null {
  if (capability.kind !== 'tool' || capability.tool !== 'pickaxe') return null
  for (const name of PICKAXE_TIER_ORDER) {
    const rank = PICKAXE_RANKS[name]
    if (rank !== undefined && rank >= capability.tier) return name
  }
  return null
}

function escalateRefusal(state: WorldState, withheld: readonly CandidateReachability[]): Candidate {
  const missing = [
    ...new Set(withheld.flatMap((entry) => entry.result.missingCapabilities.map(capabilityKey))),
  ]
  return {
    id: 'ESCALATE',
    kind: 'ESCALATE',
    label: `hand control to System 2: no reachable candidate (missing: ${missing.join(',') || 'unknown'})`,
    targetName: null,
    target: null,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    affordance: { feasible: true, reason: 'reachable', missingCapabilities: [] },
    meta: { tick: state.tick, reason: 'reachability_refused', capabilities: missing.join('|') },
  }
}
