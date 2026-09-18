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
import type { RecipeIndex } from './crafting.ts'
import { describeCraftOp, planNextCraftStep } from './crafting.ts'
import type { BlockState, DescentOption, KnownResource, Vec3Json, WorldState } from './state.ts'
import { ORE_SOURCES, PICKAXE_RANKS, STONE_YIELDS, distance } from './state.ts'
import { findInventoryFuel, matchesResourceClass, resourceMatches } from './resourceClass.ts'
import type { InventoryFuel } from './resourceClass.ts'
import { failureCount } from './failureMemory.ts'
import { selectDigTool } from './toolChoice.ts'
import { planVerticalApproach } from './verticalPlan.ts'
import { FURNACE_STONE_COST, planPrereqOptions, prereqSubjectForGoal } from './prereqOption.ts'
import type { PrereqInput, PrereqPath } from './prereqOption.ts'
import { pickBestDescendStep } from './descendPlan.ts'
import type { DescendScoreInput } from './descendPlan.ts'
import { DIG_PATH_CAP } from './worldMemory.ts'

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
}

const DEFAULT_MOVE_MIN_DISTANCE = 0
const DEFAULT_MOVE_MAX_DISTANCE = 48
const DEFAULT_TUNNEL_MAX_DISTANCE = 24
const DEFAULT_MAX_MOVE_CANDIDATES = 6
const MOVE_FAILURE_LIMIT = 4
const DESCEND_FAILURE_LIMIT = 3
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

const SMELT_INPUTS: Readonly<Record<string, string>> = {
  charcoal: 'oak_log',
  iron_ingot: 'raw_iron',
  gold_ingot: 'raw_gold',
  copper_ingot: 'raw_copper',
}

const SMELT_FUELS = ['charcoal', 'coal', 'oak_planks', 'oak_log'] as const

const HAZARD_DANGER_RADIUS = 3

function blockId(prefix: 'b' | 'p', position: Vec3Json): string {
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
 */
export function generateCandidates(
  state: WorldState,
  options: CandidateOptions = defaultCandidateOptions,
): Candidate[] {
  const candidates: Candidate[] = []
  const current = state.goalQueue?.current ?? null
  const focusItem = current?.targetItem ?? state.goal.targetItem ?? null
  const goalKind = current?.kind ?? 'collect'
  const descendTargetY = current?.kind === 'descend' ? (current.targetY ?? null) : null

  switch (goalKind) {
    case 'craft':
      candidates.push(...craftCandidates(state, options, focusItem))
      break
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
    const explore = pickExplore(state, state.terrain.standable, focusItem)
    if (explore !== null && failureCount(state.signals.failedCandidates, `MOVE:${blockId('p', explore)}`) < MOVE_FAILURE_LIMIT) {
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

  return candidates
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
      if (failureCount(state.signals.failedCandidates, `MOVE:${blockId('b', block.position)}`) >= MOVE_FAILURE_LIMIT) continue
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
    (step) => failureCount(state.signals.failedCandidates, descendId(step)) < DESCEND_FAILURE_LIMIT,
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

/**
 * CRAFT/PLACE candidates driven by the pure recipe planner: exactly one grounded
 * step toward the current craft subgoal, or nothing when no step is executable
 * in this world state.
 */
function craftCandidates(state: WorldState, options: CandidateOptions, focusItem: string | null): Candidate[] {
  const recipes = options.recipes ?? null
  if (recipes === null || focusItem === null) return []
  const tableAvailable = state.craftingTables.length > 0
  const plan = planNextCraftStep(recipes, focusItem, state.inventory.counts, tableAvailable)
  if (plan.op === null) return []
  const op = plan.op

  if (op.type === 'craft') {
    const nearestTable = state.craftingTables[0] ?? null
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
          (candidate) => (state.signals.failedCandidates[`PLACE:crafting_table:${blockId('p', candidate)}`] ?? 0) < 2,
        ) ?? state.placementSpots[0]
      if (spot === undefined) return []
      return [placeStationCandidate(state, options, 'crafting_table', spot, `craft ${focusItem}`)]
    }
    if (op.requiresTable && table === null) return []
    const where = table === null ? 'inventory 2x2' : `at crafting_table (${table.x},${table.y},${table.z})`
    return [
      {
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
    ]
  }

  const failed = state.signals.failedCandidates
  const spot =
    state.placementSpots.find((candidate) => (failed[`PLACE:${op.item}:${blockId('p', candidate)}`] ?? 0) < 2) ??
    state.placementSpots[0] ??
    null
  if (spot === null) return []
  return [placeStationCandidate(state, options, op.item, spot, `craft ${focusItem}`)]
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
  const furnace = state.furnaces?.[0] ?? null
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
  const fuelPerItem = fuelItem === 'charcoal' || fuelItem === 'coal' ? 0.125 : 0.7
  const fuelCount = Math.max(1, Math.ceil(count * fuelPerItem))

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
  const mapped = SMELT_INPUTS[focusItem]
  if (mapped === undefined) return null
  return (state.inventory.counts[mapped] ?? 0) > 0 ? mapped : null
}

function smeltFuelFor(state: WorldState): string | null {
  for (const fuel of SMELT_FUELS) {
    if ((state.inventory.counts[fuel] ?? 0) > 0) return fuel
  }
  const held = Object.keys(state.inventory.counts).find(
    (name) =>
      (state.inventory.counts[name] ?? 0) > 0 &&
      (name.endsWith('_log') || name.endsWith('_planks') || name.endsWith('_wood')),
  )
  return held ?? null
}

/**
 * Issue #58: build the pure cost/feasibility input for the furnace precondition
 * from the live world state. Shared by the candidate generator and the
 * controller so both score the exact same paths.
 */
export function furnacePrereqInputFromState(state: WorldState, _options: CandidateOptions): PrereqInput {
  const counts = state.inventory.counts
  let stoneCount = 0
  for (const [name, count] of Object.entries(counts)) {
    if (count > 0 && matchesResourceClass(name, 'stone')) stoneCount += count
  }
  return {
    goal: state.goalQueue?.current ?? null,
    heldCount: counts.furnace ?? 0,
    placedCount: state.furnaces?.length ?? 0,
    stoneCount,
    tableAvailable: state.craftingTables.length > 0,
    placementSpot: state.placementSpots.length > 0 ? leastFailedPlacementSpot(state, 'furnace') : null,
    knownStation: nearestKnownStation(state, 'furnace'),
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

/** CRAFT:furnace candidate: the first step of the craft-then-place path. */
function craftFurnaceCandidate(state: WorldState, options: CandidateOptions): Candidate[] {
  const table = state.craftingTables[0] ?? null
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
      inReach: table === null || distance(table, state.self.eyePosition) <= options.reach,
      hasStandableAdjacent: true,
      meta: { tick: state.tick, craftItem: 'furnace', craftCount: 1, requiresTable: true, furnaceSource: 'craft' },
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

function nearestKnownStation(state: WorldState, station: string): KnownResource | null {
  let best: KnownResource | null = null
  for (const resource of state.signals.knownResources ?? []) {
    if (resource.kind !== 'station' || !resource.name.includes(station)) continue
    if (best === null || distance(resource.position, state.self.position) < distance(best.position, state.self.position)) {
      best = resource
    }
  }
  return best
}

function knownStationRetrievalCandidate(state: WorldState, options: CandidateOptions, known: { name: string; position: Vec3Json }): Candidate {
  const vertical = planVerticalApproach({
    selfFeetY: state.self.position.y,
    selfPosition: state.self.position,
    target: known.position,
    tunnel: state.signals.lastTunnel,
    descent: state.descent,
  })
  const verticalMeta: Record<string, string | number | boolean> = {
    vertical: vertical?.kind ?? 'none',
    verticalFromY: vertical?.fromY ?? Math.floor(state.self.position.y),
    verticalToY: vertical?.toY ?? known.position.y,
  }
  return {
    id: `RETRIEVE:known:station:${known.name}:${blockId('b', known.position)}`,
    kind: 'RETRIEVE',
    label: `return to the remembered ${known.name} at (${known.position.x},${known.position.y},${known.position.z}) to smelt, ${distance(known.position, state.self.position)}m away`,
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
      resource: 'furnace',
      resourceKind: 'station',
      knownName: known.name,
      furnaceSource: 'known',
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
    if (failureCount(state.signals.failedCandidates, id) >= MOVE_FAILURE_LIMIT) return []
    // Issue #45: a remembered resource below the current level needs a vertical
    // leg (reuse a tunnel, else dig a staircase step) or retrieval stalls at the
    // horizontal bearing and falls back to WAIT.
    const vertical = planVerticalApproach({
      selfFeetY: state.self.position.y,
      selfPosition: state.self.position,
      target: known.position,
      tunnel: state.signals.lastTunnel,
      descent: state.descent,
    })
    const verticalMeta: Record<string, string | number | boolean> = {
      vertical: vertical?.kind ?? 'none',
      verticalFromY: vertical?.fromY ?? Math.floor(state.self.position.y),
      verticalToY: vertical?.toY ?? known.position.y,
    }
    if (vertical?.kind === 'reuse') {
      verticalMeta.tunnelX = vertical.tunnel.x
      verticalMeta.tunnelY = vertical.tunnel.y
      verticalMeta.tunnelZ = vertical.tunnel.z
    }
    if (vertical?.kind === 'staircase') {
      verticalMeta.stairDir = vertical.dir
      verticalMeta.stairFromY = vertical.fromY
      verticalMeta.stairToY = vertical.toY
      verticalMeta.stairDigX = vertical.dig.x
      verticalMeta.stairDigY = vertical.dig.y
      verticalMeta.stairDigZ = vertical.dig.z
      verticalMeta.stairStepX = vertical.step.x
      verticalMeta.stairStepY = vertical.step.y
      verticalMeta.stairStepZ = vertical.step.z
      verticalMeta.stairBlockName = vertical.digName ?? 'unknown'
    }
    const verticalLabel =
      vertical?.kind === 'reuse'
        ? ` (reuse the tunnel at ${vertical.tunnel.x},${vertical.tunnel.y},${vertical.tunnel.z})`
        : vertical?.kind === 'staircase'
          ? ` (dig a staircase down from y=${vertical.fromY} toward y=${vertical.toY})`
          : ''
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
  const spot = surfaceSpot(state, want.item)
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

function surfaceSpot(state: WorldState, item: string): Vec3Json | null {
  let best: Vec3Json | null = null
  for (const spot of state.terrain.standable) {
    if (spot.y <= state.self.position.y + 2) continue
    const id = `RETRIEVE:surface:${item}:${blockId('p', spot)}`
    if (failureCount(state.signals.failedCandidates, id) >= MOVE_FAILURE_LIMIT) continue
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
function pickExplore(state: WorldState, standable: Vec3Json[], focusItem: string | null): Vec3Json | null {
  const options = standable.filter(
    (spot) =>
      distance(spot, state.self.position) > 1.5 &&
      failureCount(state.signals.failedCandidates, `MOVE:${blockId('p', spot)}`) < MOVE_FAILURE_LIMIT,
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
