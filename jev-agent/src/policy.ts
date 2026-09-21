// policy.ts - the DETERMINISTIC GUARD.
//
// Jev proposes; this file disposes. Every check here is mechanically decidable
// from the JSON world state, so it is plain code and never a model call. Jev's
// `noul` is reserved for *semantic* judgements (should we retreat, is this
// route dangerous); anything with a yes/no answer computable from coordinates,
// inventory or ticks lives here.
//
// Two phases:
//   'decision' - validating the chosen candidate before the executor starts
//   'dig'      - re-validating at the moment of the dig, after pathing moved us
import type { Candidate, CandidateKind } from './candidates.ts'
import type { Vec3Json, WorldState } from './state.ts'
import { distance } from './state.ts'
import { fuelCountFor, smeltInventorySufficient } from './gameData.ts'

export type GuardPhase = 'decision' | 'dig'

export type GuardCode =
  | 'UNKNOWN_CANDIDATE'
  | 'EMPTY_HAND'
  | 'ALREADY_DONE'
  | 'TARGET_GONE'
  | 'STALE_COORDS'
  | 'OUT_OF_REACH'
  | 'NO_SUPPORT'
  | 'NO_PATH'
  | 'LAVA_RISK'
  | 'CONFLICT_IN_FLIGHT'

export interface InFlightAction {
  id: string
  kind: CandidateKind
}

export interface GuardContext {
  phase: GuardPhase
  /** ids the policy was allowed to choose from - kills the "picked a nonexistent thing" failure */
  candidateIds: ReadonlySet<string>
  inFlight: InFlightAction | null
  reach: number
  /** a candidate older than this many sensor ticks is stale */
  maxCandidateAgeTicks: number
  /**
   * Mechanical path probe: true when `movements.canDig=false` pathfinding can
   * reach `position`. Supplied by the controller; null in pure unit tests, in
   * which case the cheaper support/hazard checks still apply.
   */
  canComputePath?: ((position: Vec3Json) => boolean) | null
}

export type GuardResult =
  | { ok: true; candidate: Candidate }
  | { ok: false; candidateId: string; code: GuardCode; reason: string }

const LAVA_PROXIMITY = 1.5
const VOID_FLOOR = -60

function deny(candidateId: string, code: GuardCode, reason: string): GuardResult {
  return { ok: false, candidateId, code, reason }
}

/**
 * Guard the model's chosen candidate id.
 *
 * The first check is the important one: the decision must name an id that the
 * deterministic generator actually produced. A hallucinated `MINE:b9999` can
 * never reach the executor.
 */
export function guardDecision(
  decisionId: string,
  candidates: readonly Candidate[],
  state: WorldState,
  context: GuardContext,
): GuardResult {
  const chosen = candidates.find((candidate) => candidate.id === decisionId)
  if (chosen === undefined || !context.candidateIds.has(decisionId)) {
    const allowed = candidates.map((candidate) => candidate.id).join(', ')
    return deny(decisionId, 'UNKNOWN_CANDIDATE', `id is not an executable candidate this tick; allowed: [${allowed}]`)
  }
  return guardCandidate(chosen, state, context)
}

export function guardCandidate(
  candidate: Candidate,
  state: WorldState,
  context: GuardContext,
): GuardResult {
  if (!context.candidateIds.has(candidate.id)) {
    return deny(candidate.id, 'UNKNOWN_CANDIDATE', 'candidate id is not part of the current candidate set')
  }

  const age = state.tick - readMetaNumber(candidate, 'tick', state.tick)
  if (age > context.maxCandidateAgeTicks) {
    return deny(candidate.id, 'STALE_COORDS', `candidate is ${age} ticks old (limit ${context.maxCandidateAgeTicks})`)
  }

  if (state.goal.complete) {
    return deny(candidate.id, 'ALREADY_DONE', `goal "${state.goal.description}" is already complete`)
  }

  switch (candidate.kind) {
    case 'MINE':
      return guardMine(candidate, state, context)
    case 'MOVE':
    case 'RETREAT':
      return guardMove(candidate, state, context)
    case 'CRAFT':
      return guardCraft(candidate, state, context)
    case 'PLACE':
      return guardPlace(candidate, state, context)
    case 'IGNITE':
      return guardIgnite(candidate, state, context)
    case 'ENTER_PORTAL':
      return guardEnterPortal(candidate, state, context)
    case 'SMELT':
      return guardSmelt(candidate, state, context)
    case 'DESCEND':
      return guardDescend(candidate, state, context)
    case 'STEP':
      return guardStep(candidate, state, context)
    case 'RETRIEVE':
      return guardRetrieve(candidate, state, context)
    case 'ATTACK':
      return guardAttack(candidate, state)
    case 'EAT':
      return guardEat(candidate, state)
    case 'EQUIP':
      return guardEquip(candidate, state)
    case 'WAIT':
    case 'ESCALATE':
      return { ok: true, candidate }
  }
}

function findBlock(state: WorldState, position: Vec3Json) {
  return state.blocks.find((entry) => entry.kind !== 'hazard' && samePosition(entry.position, position))
}

function guardMine(candidate: Candidate, state: WorldState, context: GuardContext): GuardResult {
  const target = candidate.target
  if (target === null) {
    return deny(candidate.id, 'TARGET_GONE', 'MINE candidate carries no coordinates')
  }

  const inReachNow = distance(target, state.self.eyePosition) <= context.reach

  // A ceiling-clear MINE targets terrain (leaves/dirt) that is not in
  // `state.blocks`; validate it against the sensor's own `headroomCuts` exactly
  // like guardStep uses stepCuts, so the canopy-pocket escape stays grounded.
  const block = findBlock(state, target)
  if (block === undefined) {
    const cut = (state.headroomCuts ?? []).find((entry) => samePosition(entry.pos, target))
    if (cut === undefined) {
      return deny(
        candidate.id,
        'TARGET_GONE',
        `no ${candidate.targetName ?? 'log'} at (${target.x},${target.y},${target.z}) in the current state`,
      )
    }
    if (!cut.safe) {
      return deny(candidate.id, 'NO_SUPPORT', `the ceiling block is not safe to remove: ${cut.reason}`)
    }
    if (candidate.requiresTool && !hasTool(state, candidate.toolName)) {
      return deny(
        candidate.id,
        'EMPTY_HAND',
        `needs ${candidate.toolName ?? 'a tool'} but the inventory has none (items: ${describeInventory(state)})`,
      )
    }
    const hazard = nearestHazardTo(state, target)
    if (hazard !== null) {
      return deny(candidate.id, 'LAVA_RISK', `${hazard.name} is adjacent to the ceiling block`)
    }
    if (context.phase === 'dig' && !inReachNow) {
      return deny(
        candidate.id,
        'OUT_OF_REACH',
        `target is ${round2(distance(target, state.self.eyePosition))}m from the eyes (reach ${context.reach})`,
      )
    }
    return { ok: true, candidate }
  }

  // the block we are about to hit must still be the block the sensor saw
  if (candidate.targetName !== null && block.name !== candidate.targetName) {
    return deny(
      candidate.id,
      'TARGET_GONE',
      `no ${candidate.targetName ?? 'log'} at (${target.x},${target.y},${target.z}) in the current state`,
    )
  }
  if (!block.diggable) {
    return deny(candidate.id, 'TARGET_GONE', `${block.name} is not diggable`)
  }

  if (candidate.requiresTool && !hasTool(state, candidate.toolName)) {
    return deny(
      candidate.id,
      'EMPTY_HAND',
      `needs ${candidate.toolName ?? 'a tool'} but the inventory has none (items: ${describeInventory(state)})`,
    )
  }

  const hazard = nearestHazardTo(state, target)
  if (hazard !== null) {
    return deny(candidate.id, 'LAVA_RISK', `${hazard.name} is adjacent to the target block`)
  }

  if (context.phase === 'dig') {
    if (!inReachNow) {
      return deny(
        candidate.id,
        'OUT_OF_REACH',
        `target is ${round2(distance(target, state.self.eyePosition))}m from the eyes (reach ${context.reach})`,
      )
    }
    return { ok: true, candidate }
  }

  // decision phase: pathing may still close the distance, but only if a
  // walkable spot exists. canDig=false means we cannot tunnel to the block.
  if (!inReachNow && !block.hasAdjacentStandable) {
    return deny(
      candidate.id,
      'NO_SUPPORT',
      `no walkable position adjacent to (${target.x},${target.y},${target.z}); movements.canDig=false forbids tunnelling`,
    )
  }

  if (context.inFlight !== null && context.inFlight.kind === 'MINE' && context.inFlight.id !== candidate.id) {
    return deny(
      candidate.id,
      'CONFLICT_IN_FLIGHT',
      `already mining ${context.inFlight.id}; a new decision must not start a second concurrent dig`,
    )
  }

  return { ok: true, candidate }
}

function guardMove(candidate: Candidate, state: WorldState, context: GuardContext): GuardResult {
  const target = candidate.target
  if (target === null) {
    return deny(candidate.id, 'TARGET_GONE', `${candidate.kind} candidate carries no coordinates`)
  }

  const blockX = readMetaNumber(candidate, 'targetBlockX', Number.NaN)
  const blockY = readMetaNumber(candidate, 'targetBlockY', Number.NaN)
  const blockZ = readMetaNumber(candidate, 'targetBlockZ', Number.NaN)
  if (Number.isFinite(blockX) && Number.isFinite(blockY) && Number.isFinite(blockZ)) {
    return guardWalkToBlock(candidate, state, context, target, { x: blockX, y: blockY, z: blockZ })
  }

  // A vertical route (the executor's own pillar / staircase-up / reuse meta) targets a
  // cell ABOVE the body, which the flat terrain scan (dy -1..+1) can never list as
  // standable. Denying it here is what silently dropped every selected ASCEND: with
  // d1 (#360) the route is enumerated and Jev selects it, the guard rejected it as
  // NO_SUPPORT, the guard category is not mirrored, and the body stayed at y=67 for 48
  // minutes while `ACTION` showed only WAIT. The executor owns vertical feasibility
  // (column-unless-unsafe, placeable held, step cap), so the flat-support gate must not
  // apply to a route that carries that meta.
  const vertical = readMetaString(candidate, 'vertical')
  if (vertical === null) {
    const standable = state.terrain.standable.some((spot) => samePosition(spot, target))
    if (!standable) {
      return deny(
        candidate.id,
        'NO_SUPPORT',
        `(${target.x},${target.y},${target.z}) is not a known standable position (no support / unloaded chunk)`,
      )
    }
  }
  const hazard = nearestHazardTo(state, target)
  if (hazard !== null) {
    return deny(candidate.id, 'LAVA_RISK', `${hazard.name} is adjacent to the movement target`)
  }
  return guardPathComputable(candidate, context, target)
}

/**
 * The mechanical navigation gate: a MOVE is only executable when the pinned
 * `canDig=false` pathfinder can actually compute a path to the destination, and
 * the destination is neither below the world floor nor next to a hazard. This is
 * what turns "walk into the void" into a guard rejection instead of a stuck bot.
 */
function guardPathComputable(candidate: Candidate, context: GuardContext, target: Vec3Json): GuardResult {
  if (target.y < VOID_FLOOR) {
    return deny(candidate.id, 'NO_SUPPORT', `(${target.x},${target.y},${target.z}) is below the world floor (void)`)
  }
  const probe = context.canComputePath
  if (probe !== undefined && probe !== null && !probe(target)) {
    return deny(
      candidate.id,
      'NO_PATH',
      `no canDig=false path to (${target.x},${target.y},${target.z}) (GoalBlock probe)`,
    )
  }
  return { ok: true, candidate }
}

/**
 * #79: guard rejections that prove the chosen action cannot execute in this
 * state are charged to the option's unproductive streak, so a permanently
 * rejected option reaches the bounded attempt limit and is retired instead of
 * requesting an abandon every tick that shadow mode keeps suppressing as
 * "speculative". Deferrals (`CONFLICT_IN_FLIGHT`) and transient rejections
 * (`STALE_COORDS`, `UNKNOWN_CANDIDATE`) never count; `ALREADY_DONE` must not
 * retire an option the world already satisfied.
 */
export function guardRejectionChargesOption(code: GuardCode): boolean {
  switch (code) {
    case 'NO_PATH':
    case 'NO_SUPPORT':
    case 'LAVA_RISK':
      return true
    case 'OUT_OF_REACH':
    case 'TARGET_GONE':
    case 'EMPTY_HAND':
    case 'CONFLICT_IN_FLIGHT':
    case 'STALE_COORDS':
    case 'UNKNOWN_CANDIDATE':
    case 'ALREADY_DONE':
      return false
  }
}

/** A target more than this many blocks above the bot cannot be walked to. */
export const MOVE_VERTICAL_GAP_LIMIT = 4

/** The exact log line emitted when a body-change target is dropped as unreachable. */
export function formatMoveUnreachable(target: Vec3Json, dy: number): string {
  return `MOVE_UNREACHABLE target=${target.x},${target.y},${target.z} dy=${dy}`
}

/**
 * Issue #43: mechanical unreachability for a body-change candidate. The pinned
 * `canDig=false` pathfinder has no climb primitive, so a target more than
 * MOVE_VERTICAL_GAP_LIMIT above the bot only loops. `canComputePath` adds the
 * explicit no-path case when the caller has the pathfinder probe; pure tests
 * leave it null and still get the deterministic vertical check.
 */
export function unreachableMove(
  candidate: Candidate,
  state: WorldState,
  canComputePath?: ((position: Vec3Json) => boolean) | null,
): { target: Vec3Json; dy: number } | null {
  if (candidate.kind !== 'MOVE' && candidate.kind !== 'RETRIEVE') return null
  const target = candidate.target
  if (target === null) return null
  // A generated vertical-plan MOVE is intentionally not a horizontal
  // canDig=false path probe: its executor first runs the guarded staircase or
  // pillar leg, then re-plans the standable spot from the new Y. Treating it
  // as unreachable here would retire it before the executor can act.
  if (hasVerticalPlan(candidate)) return null
  const dy = Math.round(target.y - state.self.position.y)
  if (dy > MOVE_VERTICAL_GAP_LIMIT) return { target, dy }
  if (canComputePath !== undefined && canComputePath !== null && !canComputePath(target)) return { target, dy }
  return null
}

function hasVerticalPlan(candidate: Candidate): boolean {
  return candidate.meta.vertical === 'reuse' || candidate.meta.vertical === 'staircase' || candidate.meta.vertical === 'staircase-up' || candidate.meta.vertical === 'pillar'
}

/**
 * A MOVE that names the block it is walking toward. It is grounded in the
 * sensor's own `adjacentStandable` field, so a vanished block or a changed
 * walk-up spot is a mechanical rejection rather than a walk into nothing.
 */
function guardWalkToBlock(
  candidate: Candidate,
  state: WorldState,
  context: GuardContext,
  target: Vec3Json,
  block: Vec3Json,
): GuardResult {
  const blockName = typeof candidate.meta.targetBlockName === 'string' ? candidate.meta.targetBlockName : null
  const found = findBlock(state, block)
  if (found === undefined || (blockName !== null && found.name !== blockName)) {
    return deny(
      candidate.id,
      'TARGET_GONE',
      `no ${blockName ?? 'block'} at (${block.x},${block.y},${block.z}) in the current state`,
    )
  }
  const adjacencyMatches =
    found.hasAdjacentStandable && found.adjacentStandable !== null && samePosition(found.adjacentStandable, target)
  // A dig-access MOVE names the same block, but its stand was resolved by the
  // live #244 interaction-stand probe (`bot.blockAt` passable+support+face
  // reach), not by the sensor's 12-neighbour sample. The block existence and
  // path checks below still apply; only the stale adjacency fact is bypassed.
  if (!adjacencyMatches && candidate.meta.digAccess !== true) {
    return deny(
      candidate.id,
      'NO_SUPPORT',
      `the walk-up spot (${target.x},${target.y},${target.z}) next to (${block.x},${block.y},${block.z}) no longer exists`,
    )
  }
  const hazard = nearestHazardTo(state, target)
  if (hazard !== null) {
    return deny(candidate.id, 'LAVA_RISK', `${hazard.name} is adjacent to the movement target`)
  }
  if (target.y < VOID_FLOOR) {
    return deny(candidate.id, 'NO_SUPPORT', `(${target.x},${target.y},${target.z}) is below the world floor (void)`)
  }
  // The vertical leg is the path for this candidate.  The ordinary stock
  // canDig=false probe only knows horizontal locomotion and would reject a
  // safe pillar/staircase MOVE before Executor.runMove can execute it.
  if (hasVerticalPlan(candidate)) return { ok: true, candidate }
  return guardPathComputable(candidate, context, target)
}

function guardAttack(candidate: Candidate, state: WorldState): GuardResult {
  const entityId = candidate.targetEntityId
  if (entityId === null) {
    return deny(candidate.id, 'TARGET_GONE', 'ATTACK candidate carries no entity id')
  }
  const entity = state.entities.find((entry) => entry.id === entityId)
  if (entity === undefined) {
    return deny(candidate.id, 'TARGET_GONE', `entity ${entityId} is no longer in the world state`)
  }
  if (state.self.health <= 0) {
    return deny(candidate.id, 'ALREADY_DONE', 'bot is dead')
  }
  return { ok: true, candidate }
}

function guardEat(candidate: Candidate, state: WorldState): GuardResult {
  const itemName = candidate.itemName
  if (itemName === null) {
    return deny(candidate.id, 'EMPTY_HAND', 'EAT candidate carries no item name')
  }
  if ((state.inventory.counts[itemName] ?? 0) <= 0) {
    return deny(candidate.id, 'EMPTY_HAND', `${itemName} is not in the inventory`)
  }
  return { ok: true, candidate }
}

/**
 * EQUIP is mechanically valid only while the carried piece is still in the
 * inventory and the candidate names one of the four armor destinations. Which
 * slot wins is Jev's choice; this guard only refuses a stale/foreign candidate.
 */
function guardEquip(candidate: Candidate, state: WorldState): GuardResult {
  const itemName = candidate.itemName
  if (itemName === null) {
    return deny(candidate.id, 'EMPTY_HAND', 'EQUIP candidate carries no item name')
  }
  if ((state.inventory.counts[itemName] ?? 0) <= 0) {
    return deny(candidate.id, 'EMPTY_HAND', `${itemName} is not in the inventory`)
  }
  const slot = readMetaString(candidate, 'slot')
  if (slot !== 'head' && slot !== 'torso' && slot !== 'legs' && slot !== 'feet') {
    return deny(candidate.id, 'TARGET_GONE', `EQUIP candidate names no valid armor slot (${slot ?? 'none'})`)
  }
  return { ok: true, candidate }
}

function guardCraft(candidate: Candidate, state: WorldState, context: GuardContext): GuardResult {
  const craftItem = candidate.itemName
  if (craftItem === null) {
    return deny(candidate.id, 'EMPTY_HAND', 'CRAFT candidate carries no item')
  }
  if (candidate.meta.requiresTable !== true) return { ok: true, candidate }
  const target = candidate.target
  if (target === null) {
    return deny(candidate.id, 'NO_SUPPORT', 'craft needs a crafting_table but the candidate carries no station position')
  }
  const table = state.craftingTables.find((position) => samePosition(position, target))
  if (table === undefined) {
    return deny(
      candidate.id,
      'TARGET_GONE',
      `no crafting_table at (${target.x},${target.y},${target.z}) in the current state`,
    )
  }
  if (context.phase === 'dig' && distance(target, state.self.eyePosition) > context.reach) {
    return deny(
      candidate.id,
      'OUT_OF_REACH',
      `crafting_table is ${round2(distance(target, state.self.eyePosition))}m from the eyes (reach ${context.reach})`,
    )
  }
  return { ok: true, candidate }
}

/**
 * The dimension transfer carries no item: the only hard safety facts are that it
 * has a grounded approach cell and that no hazard sits at it. Its DONE truth is
 * the executor's dimension postcondition, never this guard.
 */
function guardEnterPortal(candidate: Candidate, state: WorldState, context: GuardContext): GuardResult {
  const target = candidate.target
  if (target === null) {
    return deny(candidate.id, 'TARGET_GONE', 'ENTER_PORTAL candidate carries no approach cell')
  }
  const hazard = nearestHazardTo(state, target)
  if (hazard !== null) {
    return deny(candidate.id, 'LAVA_RISK', `${hazard.name} is adjacent to the portal approach`)
  }
  return { ok: true, candidate }
}

function guardPlace(candidate: Candidate, state: WorldState, context: GuardContext): GuardResult {
  const itemName = candidate.itemName
  if (itemName === null) {
    return deny(candidate.id, 'EMPTY_HAND', 'PLACE candidate carries no item')
  }
  if ((state.inventory.counts[itemName] ?? 0) <= 0) {
    return deny(candidate.id, 'EMPTY_HAND', `${itemName} is not in the inventory`)
  }
  const target = candidate.target
  if (target === null) {
    return deny(candidate.id, 'TARGET_GONE', 'PLACE candidate carries no coordinates')
  }
  const multiCellPlacement = (candidate.placementCells?.length ?? 0) > 1
  const occupied = findBlock(state, target)
  if (occupied !== undefined && (!multiCellPlacement || occupied.name !== itemName)) {
    return deny(
      candidate.id,
      'TARGET_GONE',
      `(${target.x},${target.y},${target.z}) is already occupied by ${occupied.name}`,
    )
  }
  if (!multiCellPlacement && distance(target, state.self.eyePosition) > context.reach) {
    return deny(
      candidate.id,
      'OUT_OF_REACH',
      `placement spot is ${round2(distance(target, state.self.eyePosition))}m from the eyes (reach ${context.reach})`,
    )
  }
  const hazard = nearestHazardTo(state, target)
  if (hazard !== null) {
    return deny(candidate.id, 'LAVA_RISK', `${hazard.name} is adjacent to the placement spot`)
  }
  return { ok: true, candidate }
}

function guardIgnite(candidate: Candidate, state: WorldState, context: GuardContext): GuardResult {
  const itemName = candidate.itemName ?? 'flint_and_steel'
  if ((state.inventory.counts[itemName] ?? 0) <= 0) {
    return deny(candidate.id, 'EMPTY_HAND', `${itemName} is not in the inventory`)
  }
  const target = candidate.target
  if (target === null) {
    return deny(candidate.id, 'TARGET_GONE', 'IGNITE candidate carries no light position')
  }
  const hazard = nearestHazardTo(state, target)
  if (hazard !== null) {
    return deny(candidate.id, 'LAVA_RISK', `${hazard.name} is adjacent to the portal light position`)
  }
  if (context.phase === 'dig' && distance(target, state.self.eyePosition) > context.reach) {
    return deny(
      candidate.id,
      'OUT_OF_REACH',
      `light position is ${round2(distance(target, state.self.eyePosition))}m from the eyes (reach ${context.reach})`,
    )
  }
  return { ok: true, candidate }
}

function guardSmelt(candidate: Candidate, state: WorldState, context: GuardContext): GuardResult {
  const target = candidate.target
  if (target === null) {
    return deny(candidate.id, 'TARGET_GONE', 'SMELT candidate carries no furnace position')
  }
  const furnace = (state.furnaces ?? []).find((station) => samePosition(station, target))
  if (furnace === undefined) {
    return deny(candidate.id, 'TARGET_GONE', `no furnace at (${target.x},${target.y},${target.z}) in the current state`)
  }
  const inputItem = readMetaString(candidate, 'inputItem')
  const fuelItem = readMetaString(candidate, 'fuelItem')
  const outputItem = candidate.itemName
  if (inputItem === null || fuelItem === null || outputItem === null) {
    return deny(candidate.id, 'EMPTY_HAND', 'SMELT candidate is missing input/fuel/output')
  }
  if ((state.inventory.counts[inputItem] ?? 0) <= 0) {
    return deny(candidate.id, 'EMPTY_HAND', `${inputItem} is not in the inventory`)
  }
  if ((state.inventory.counts[fuelItem] ?? 0) <= 0) {
    return deny(candidate.id, 'EMPTY_HAND', `${fuelItem} is not in the inventory`)
  }
  const inputCount = Math.max(1, Math.floor(readMetaNumber(candidate, 'inputCount', 1)))
  const fuelCount = Math.max(1, Math.floor(readMetaNumber(candidate, 'fuelCount', fuelCountFor(inputCount, fuelItem))))
  if (!smeltInventorySufficient(state.inventory.counts, inputItem, inputCount, fuelItem, fuelCount)) {
    return deny(
      candidate.id,
      'EMPTY_HAND',
      `insufficient smelt inventory input=${inputItem}:${state.inventory.counts[inputItem] ?? 0}/${inputCount} fuel=${fuelItem}:${state.inventory.counts[fuelItem] ?? 0}/${fuelCount}`,
    )
  }
  const hazard = nearestHazardTo(state, target)
  if (hazard !== null) {
    return deny(candidate.id, 'LAVA_RISK', `${hazard.name} is adjacent to the furnace`)
  }
  if (distance(target, state.self.eyePosition) > context.reach) {
    return guardPathComputable(candidate, context, target)
  }
  return { ok: true, candidate }
}

function guardRetrieve(candidate: Candidate, state: WorldState, context: GuardContext): GuardResult {
  const target = candidate.target
  if (target === null) {
    return deny(candidate.id, 'TARGET_GONE', 'RETRIEVE candidate carries no coordinates')
  }
  if (target.y < VOID_FLOOR) {
    return deny(candidate.id, 'NO_SUPPORT', `(${target.x},${target.y},${target.z}) is below the world floor (void)`)
  }
  if (candidate.meta.surface === true) {
    const standable = state.terrain.standable.some((spot) => samePosition(spot, target))
    if (!standable) {
      return deny(
        candidate.id,
        'NO_SUPPORT',
        `(${target.x},${target.y},${target.z}) is not a known standable surface position`,
      )
    }
    return guardPathComputable(candidate, context, target)
  }
  const known = (state.signals.knownResources ?? []).some((resource) => samePosition(resource.position, target))
  if (!known) {
    return deny(candidate.id, 'TARGET_GONE', `no remembered resource at (${target.x},${target.y},${target.z})`)
  }
  const hazard = nearestHazardTo(state, target)
  if (hazard !== null) {
    return deny(candidate.id, 'LAVA_RISK', `${hazard.name} is adjacent to the remembered resource`)
  }
  const vertical = candidate.meta.vertical
  if (vertical === 'staircase') {
    const digX = readMetaNumber(candidate, 'stairDigX', Number.NaN)
    const digY = readMetaNumber(candidate, 'stairDigY', Number.NaN)
    const digZ = readMetaNumber(candidate, 'stairDigZ', Number.NaN)
    const step = (state.descent ?? []).find(
      (entry) =>
        (entry.floor.x === digX && entry.floor.y === digY && entry.floor.z === digZ) ||
        (entry.wall.x === digX && entry.wall.y === digY && entry.wall.z === digZ) ||
        (entry.head.x === digX && entry.head.y === digY && entry.head.z === digZ),
    )
    if (step === undefined) {
      return deny(
        candidate.id,
        'NO_SUPPORT',
        `no descent step digging (${digX},${digY},${digZ}) in the current state (canDig=false forbids tunnelling)`,
      )
    }
    if (!step.safe) {
      return deny(candidate.id, 'NO_SUPPORT', `the retrieval staircase step is not safe: ${step.reason}`)
    }
  }
  return { ok: true, candidate }
}

function guardStep(candidate: Candidate, state: WorldState, context: GuardContext): GuardResult {
  const target = candidate.target
  if (target === null) {
    return deny(candidate.id, 'TARGET_GONE', 'STEP candidate carries no cut coordinates')
  }
  const cut = (state.stepCuts ?? []).find((entry) => samePosition(entry.cut, target))
  if (cut === undefined) {
    return deny(candidate.id, 'TARGET_GONE', `the 2-block face at (${target.x},${target.y},${target.z}) is gone`)
  }
  if (!cut.safe) {
    return deny(candidate.id, 'NO_SUPPORT', `the stair-cut is not safe: ${cut.reason}`)
  }
  const hazard = nearestHazardTo(state, target)
  if (hazard !== null) {
    return deny(candidate.id, 'LAVA_RISK', `${hazard.name} is adjacent to the stair-cut`)
  }
  if (context.phase === 'dig' && distance(target, state.self.eyePosition) > context.reach) {
    return deny(
      candidate.id,
      'OUT_OF_REACH',
      `cut is ${round2(distance(target, state.self.eyePosition))}m from the eyes (reach ${context.reach})`,
    )
  }
  return { ok: true, candidate }
}

function guardDescend(candidate: Candidate, state: WorldState, context: GuardContext): GuardResult {
  const target = candidate.target
  if (target === null) {
    return deny(candidate.id, 'TARGET_GONE', 'DESCEND candidate carries no dig target')
  }
  // The descent step digs arbitrary terrain (dirt/grass), which is not in
  // `state.blocks` (logs/stone/ore/hazard only). Validate against the sensor's
  // own pre-computed `descent` options, exactly like `guardStep` uses stepCuts:
  // otherwise every DESCEND toward buried stone is generated and then rejected.
  // A level step's wall is also the down step's wall at the same direction.
  // Match the candidate's typed geometry first; coordinate-only matching can
  // select the down step and reject a valid level step with the wrong support.
  const mode = candidate.meta.mode === 'down' || candidate.meta.mode === 'level' ? candidate.meta.mode : null
  const dir = typeof candidate.meta.dir === 'string' ? candidate.meta.dir : null
  const step = (state.descent ?? []).find(
    (entry) =>
      (mode === null || entry.mode === mode) &&
      (dir === null || entry.dir === dir) &&
      (samePosition(entry.floor, target) || samePosition(entry.wall, target) || samePosition(entry.head, target)),
  )
  if (step === undefined) {
    return deny(candidate.id, 'TARGET_GONE', `no descent step digging (${target.x},${target.y},${target.z}) in the current state`)
  }
  if (!step.safe) {
    return deny(candidate.id, 'NO_SUPPORT', `the descent step is not safe: ${step.reason}`)
  }
  if (candidate.requiresTool && !hasTool(state, candidate.toolName)) {
    return deny(candidate.id, 'EMPTY_HAND', `needs ${candidate.toolName ?? 'a tool'} but the inventory has none`)
  }
  const hazard = nearestHazardTo(state, target)
  if (hazard !== null) {
    return deny(candidate.id, 'LAVA_RISK', `${hazard.name} is adjacent to the descent block`)
  }
  if (context.phase === 'dig' && distance(target, state.self.eyePosition) > context.reach) {
    return deny(
      candidate.id,
      'OUT_OF_REACH',
      `target is ${round2(distance(target, state.self.eyePosition))}m from the eyes (reach ${context.reach})`,
    )
  }
  return { ok: true, candidate }
}

function hasTool(state: WorldState, toolName: Candidate['toolName']): boolean {
  if (toolName === null) return true
  const suffix = `_${toolName}`
  return Object.keys(state.inventory.counts).some(
    (name) => name.endsWith(suffix) && (state.inventory.counts[name] ?? 0) > 0,
  )
}

function nearestHazardTo(state: WorldState, position: Vec3Json) {
  let nearest = null
  let nearestDistance = LAVA_PROXIMITY
  for (const block of state.blocks) {
    if (block.kind !== 'hazard') continue
    const d = distance(block.position, position)
    if (d <= nearestDistance) {
      nearestDistance = d
      nearest = block
    }
  }
  return nearest
}

function samePosition(a: Vec3Json, b: Vec3Json): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z
}

function readMetaString(candidate: Candidate, key: string): string | null {
  const value = candidate.meta[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readMetaNumber(candidate: Candidate, key: string, fallback: number): number {
  const value = candidate.meta[key]
  return typeof value === 'number' ? value : fallback
}

function describeInventory(state: WorldState): string {
  const names = Object.keys(state.inventory.counts)
  return names.length === 0 ? 'empty' : names.join(', ')
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** All candidate kinds that represent a real, stateful side effect. */
export const ACTING_KINDS: ReadonlySet<CandidateKind> = new Set<CandidateKind>([
  'MINE',
  'MOVE',
  'CRAFT',
  'PLACE',
  'IGNITE',
  'ENTER_PORTAL',
  'ATTACK',
  'EAT',
  'EQUIP',
  'RETREAT',
  'STEP',
  'RETRIEVE',
])
