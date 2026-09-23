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
import { dryAwarePlacementSpots, ENV_HAZARD_ESCAPE_META } from './candidates.ts'
import { isBridgeMove } from './bridgeRoute.ts'
import type { Vec3Json, WorldState } from './state.ts'
import { bodyIsOutOfAir, bodyStarving, bodySubmersion, distance, MAX_AIR, placementSpotKey } from './state.ts'
import { CRITICAL_DAMAGE_HEALTH } from './criticalDamage.ts'
import { ENV_LAVA_PROXIMITY, envHazardProximityDenied } from './envHazard.ts'
import { isVerifiedWallEntry } from './wallEntry.ts'
import { fuelCountFor, smeltInventorySufficient } from './gameData.ts'
import { containerObservationAt, observedItemCount } from './containerAccess.ts'
import type { StationApproachProbe } from './reachability.ts'

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
  /**
   * SAFE: the step the candidate would realize puts the body inside a DIMENSION TRANSFER
   * block (a lit portal plane), i.e. the mechanical action would change dimension. The
   * measured Nether arrival stands beside exactly such a plane; the explicit
   * `ENTER_PORTAL` candidate is the one route that may cross, so this code is the guard's
   * last boundary against a locomotion/dig realization that crosses instead.
   */
  | 'CROSSES_DIMENSION'
  /**
   * SAFE: the body is out of breath (or the placement would have to be made
   * from a submerged body position while a dry alternative exists). Code owns
   * this refusal - the measured drowning was an `ATTACK` lease that kept
   * `closing-to-melee-range` under water until the body died
   * (2026-09-21T16:59:34.792Z, (67.5,58.3,28.5)); the response to it (which way
   * to surface) stays Jev's choice.
   */
  | 'SUBMERGED'
  /**
   * SAFE: the body is at critical health with an empty hunger bar, so vanilla
   * starvation damage (1 HP every 4 s) is already landing. A placement does not
   * end starvation, so code refuses to keep the body in that work at the
   * survival floor - the measured `run-mubj6ucc-si3e` slide from 14 HP to 1 HP
   * happened while the plan kept offering ENTER/MOVE/WAIT and never a route to
   * food. WHAT ends the starvation (eat / hunt / retreat) stays Jev's choice.
   */
  | 'STARVING'
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
  /**
   * The STATION-APPROACH fact (the stand the body interacts from, plus the
   * `canDig=false` path verdict to that stand), supplied by the controller: the
   * SAME probe the candidate layer's `stationApproachReachable` consumes, so the
   * guard and the grounding cannot disagree about a station.
   *
   * A station's interaction destination is a STAND, never the station's own
   * cell: a container block occupies that cell, so `GoalBlock(<container cell>)`
   * can never succeed and refused every out-of-reach container forever. Measured
   * live (m3-live buddy.log): the operator's `purple_shulker_box@10,59,8` was
   * offered by Jev at 14.8 m from the body and rejected
   * `ACTION_REJECTED ... code=NO_PATH ... path to (10,59,8) (GoalBlock probe)`
   * five times in 11 s while the body never moved, although three passable,
   * supported stands with a clear path stand beside that container.
   *
   * Optional: a caller that passes no probe keeps the previous cell-probe
   * behaviour, so no existing verdict moves.
   */
  stationApproach?: StationApproachProbe | null
}

export type GuardResult =
  | { ok: true; candidate: Candidate }
  | { ok: false; candidateId: string; code: GuardCode; reason: string }

/** One number for the lava margin: `reachability.ts` HAZARD_PROXIMITY is the same. */
const LAVA_PROXIMITY = ENV_LAVA_PROXIMITY
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
    case 'CONTAINER':
      return guardContainer(candidate, state, context)
    case 'DESCEND':
      return guardDescend(candidate, state, context)
    case 'STEP':
      return guardStep(candidate, state, context)
    case 'RETRIEVE':
      return guardRetrieve(candidate, state, context)
    case 'PICKUP':
      return guardPickup(candidate, state, context)
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

  // A MOVE that carries its OWN route declares the cell the route CREATES, not a
  // cell the sensor already saw standable: a pillar apex is air until the executor
  // places the column, and a bridge's landing is a hole until the executor places
  // its floor. The flat terrain scan (dy -1..+1 over a 5x5 window) can list
  // neither. The leg IS the path for this candidate, exactly as `unreachableMove`
  // and `guardWalkToBlock` already treat it; the ordinary horizontal standable
  // lookup AND the canDig=false GoalBlock probe would both reject the only route
  // the goal has before `Executor.runMove` can run it (measured live: the
  // 48-minute `ASCEND:surface:p3_86_18` pillar was generated, selected by Jev and
  // dropped here with NO_SUPPORT 72+ times while the body never rose). The
  // executor owns the route's own feasibility (column-unless-unsafe, placeable
  // held, step cap / bounded bridge span with its verified far side).
  const ownRoute = carriesOwnRoute(candidate)
  if (!ownRoute) {
    // SAFE/CAN: a keep-distance destination may come from the threat escape
    // scan, which applies the same `isStandable` predicate over a wider window
    // (`state.terrain.escapeCells`). The ordinary 5x5x3 window can never contain
    // a destination outside melee reach, so validating only against it would
    // reject every real retreat the candidate layer can ground.
    const standable =
      state.terrain.standable.some((spot) => samePosition(spot, target)) ||
      (state.terrain.escapeCells ?? []).some((spot) => samePosition(spot, target))
    if (!standable) {
      return deny(
        candidate.id,
        'NO_SUPPORT',
        `(${target.x},${target.y},${target.z}) is not a known standable position (no support / unloaded chunk)`,
      )
    }
  }
  const hazard = nearestHazardTo(state, target)
  // SAFE: a code-grounded environmental escape ("step out of the fire") has
  // already proven its destination's own column hazard-free from real block
  // truth (`envHazard.selectEnvHazardEscapes`), and every neighbour of a burning
  // body sits inside the margin of that same fire. Fire does not flow and
  // damages only a body whose box intersects it, so the proximity deny is
  // narrowed for exactly that candidate; lava-class hazards still deny it, and
  // every ordinary candidate is untouched (`envHazardProximityDenied`).
  const escape = candidate.meta[ENV_HAZARD_ESCAPE_META] !== undefined
  if (hazard !== null && envHazardProximityDenied(escape, hazard.name)) {
    return deny(candidate.id, 'LAVA_RISK', `${hazard.name} is adjacent to the movement target`)
  }
  // The column/step/bridge route was already proven safe by its own planner; only
  // the hard void floor remains a deterministic fact this guard still owns.
  if (ownRoute) {
    if (target.y < VOID_FLOOR) {
      return deny(candidate.id, 'NO_SUPPORT', `(${target.x},${target.y},${target.z}) is below the world floor (void)`)
    }
    return { ok: true, candidate }
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
    // A dimension-crossing step is a hard invalidity of THIS realization (the world
    // mechanic would teleport the body): the option is not unproductive, the step is
    // illegal, so it is not charged to the option's streak.
    case 'CROSSES_DIMENSION':
      return false
    case 'OUT_OF_REACH':
    case 'TARGET_GONE':
    case 'EMPTY_HAND':
    case 'CONFLICT_IN_FLIGHT':
    case 'STALE_COORDS':
    case 'UNKNOWN_CANDIDATE':
    case 'ALREADY_DONE':
    // A submerged body is an environmental precondition ("surface first"), not
    // evidence that the option is unproductive: charging it here would abandon a
    // protected prerequisite because the bot happened to be under water.
    case 'SUBMERGED':
    // A starving body at critical health is an environmental precondition
    // ("eat first"), not evidence the option is unproductive: charging it here
    // would abandon a protected prerequisite because the hunger bar was empty.
    case 'STARVING':
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
 * `ACTION_REJECTED id=<candidate> code=<GuardCode> reason=<why>`.
 *
 * This guard is the last deterministic boundary between a Jev selection and the
 * executor. Before this marker the rejection existed only on the un-mirrored
 * `guard` log category, so a selected candidate that never executed was
 * indistinguishable from a silent drop (measured live: `JEV_HEADS
 * action=ASCEND:surface:p3_86_18` alternated with WAIT for 48 minutes with zero
 * `ACTION` lines, zero `PILLAR_*` markers and no typed cause). Every rejection
 * now names the candidate and the deterministic code on the mirrored event path,
 * so the loop can act on the cause.
 */
export const ACTION_REJECTED = 'ACTION_REJECTED'

export function formatActionRejected(candidateId: string, code: GuardCode, reason: string): string {
  return `${ACTION_REJECTED} id=${candidateId} code=${code} reason=${reason}`
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
  // A MOVE that carries its own route is intentionally not a horizontal
  // canDig=false path probe: a vertical plan runs the guarded staircase or pillar
  // leg and then re-plans the standable spot from the new Y, and a bridge places
  // its own floor and steps onto it. Treating either as unreachable here would
  // retire it before the executor can act.
  if (carriesOwnRoute(candidate)) return null
  const dy = Math.round(target.y - state.self.position.y)
  if (dy > MOVE_VERTICAL_GAP_LIMIT) return { target, dy }
  if (canComputePath !== undefined && canComputePath !== null && !canComputePath(target)) return { target, dy }
  return null
}

function hasVerticalPlan(candidate: Candidate): boolean {
  return candidate.meta.vertical === 'reuse' || candidate.meta.vertical === 'staircase' || candidate.meta.vertical === 'staircase-up' || candidate.meta.vertical === 'pillar'
}

/**
 * A MOVE that IS its own path. Two shapes qualify, for the same mechanical
 * reason - the pinned `canDig=false` pathfinder can express neither:
 *
 *   * a generated vertical plan (staircase / pillar / reuse), whose executor runs
 *     the climb leg and then re-plans the standable spot from the new Y;
 *   * a BRIDGE/scaffold leg (`bridgeRoute.ts`), whose executor places one block
 *     into the landing's floor cell and steps onto it. The bridge declares
 *     `mayPlaceBlocks` with the block it consumes, is grounded on the sensor's
 *     bounded forward probe, and stays an ordinary enumerated candidate: Jev
 *     chooses it, code never falls back to it.
 *
 * The exemption is deliberately narrow: it skips only the horizontal path probe
 * and the flat standable-set lookup. The hazard, void-floor and in-flight checks
 * below still apply to a bridge exactly as they do to every other MOVE.
 */
function carriesOwnRoute(candidate: Candidate): boolean {
  return hasVerticalPlan(candidate) || isBridgeMove(candidate)
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
  // The vertical/bridge leg is the path for this candidate. The ordinary stock
  // canDig=false probe only knows horizontal locomotion and would reject a safe
  // pillar/staircase MOVE - or a bridge MOVE, whose landing is a hole until its
  // own placement creates the floor - before Executor.runMove can execute it.
  if (carriesOwnRoute(candidate)) return { ok: true, candidate }
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
  // SAFE: an attack lease holds the body where it is (or follows the target)
  // while the breath runs out. The measured death was exactly this: a goal-drop
  // ATTACK on a salmon kept closing under water until the body drowned, so a
  // body already out of air may not start or continue one.
  if (bodyIsOutOfAir(state.self)) {
    const submersion = bodySubmersion(state.self)
    return deny(
      candidate.id,
      'SUBMERGED',
      `body is out of air (${submersion.air}/${MAX_AIR}); the attack lease cannot continue under water`,
    )
  }
  // SAFE: an empty hunger bar at critical health is already dealing starvation
  // damage. A food-animal ATTACK is the one attack that can end it and stays
  // allowed; every other attack keeps the body trading hits while the hunger
  // bar kills it.
  if (bodyStarving(state.self) && candidate.meta.foodAnimal !== true) {
    return deny(
      candidate.id,
      'STARVING',
      `body is starving (health ${state.self.health}/${CRITICAL_DAMAGE_HEALTH}, food ${state.self.food}); this attack cannot end the starvation`,
    )
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
 * inventory and the candidate names a real equip destination. Which destination
 * (and, when a fight is on the table, which carried weapon) wins is Jev's choice;
 * this guard only refuses a stale/foreign candidate. `hand` is the combat
 * weapon-in-hand destination (`gearPlan.ts` `weaponArmOffers`), verified by the
 * executor against the live main hand like every other equip.
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
  if (slot !== 'hand' && slot !== 'head' && slot !== 'torso' && slot !== 'legs' && slot !== 'feet') {
    return deny(candidate.id, 'TARGET_GONE', `EQUIP candidate names no valid equip slot (${slot ?? 'none'})`)
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
 * has a grounded entry cell (the standable interior cell the generic mover walks
 * to) and that no hazard sits at it. Its DONE truth is the executor's dimension
 * postcondition, never this guard.
 */
function guardEnterPortal(candidate: Candidate, state: WorldState, context: GuardContext): GuardResult {
  const target = candidate.target
  if (target === null) {
    return deny(candidate.id, 'TARGET_GONE', 'ENTER_PORTAL candidate carries no entry cell')
  }
  const hazard = nearestHazardTo(state, target)
  if (hazard !== null) {
    return deny(candidate.id, 'LAVA_RISK', `${hazard.name} is adjacent to the portal entry cell`)
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
  const submersion = submergedPlacementRefusal(candidate, state, target)
  if (submersion !== null) return submersion
  // SAFE: placing a station does not end starvation, so a body at critical
  // health with an empty hunger bar is not kept in that work.
  if (bodyStarving(state.self)) {
    return deny(
      candidate.id,
      'STARVING',
      `body is starving (health ${state.self.health}/${CRITICAL_DAMAGE_HEALTH}, food ${state.self.food}); eat before placing`,
    )
  }
  return { ok: true, candidate }
}

/**
 * SAFE: a station is not placed by a body that is out of breath, nor from a
 * body position that is submerged while a dry-access placement spot exists. The
 * candidate generator already withholds the submerged-access spots, so this is
 * the execution-side truth for a stale or foreign candidate - it must never be
 * the only layer, and it must never invent a different semantic choice.
 */
function submergedPlacementRefusal(
  candidate: Candidate,
  state: WorldState,
  target: Vec3Json,
): GuardResult | null {
  const submersion = bodySubmersion(state.self)
  if (submersion.state === 'out_of_air') {
    return deny(
      candidate.id,
      'SUBMERGED',
      `body is out of air (${submersion.air}/${MAX_AIR}); surface before placing`,
    )
  }
  const wet = state.submergedPlacementSpots ?? []
  if (wet.length === 0) return null
  const key = placementSpotKey(target)
  if (!wet.some((spot) => placementSpotKey(spot) === key)) return null
  const dry = dryAwarePlacementSpots(state)
  if (dry.length === 0 || dry.some((spot) => placementSpotKey(spot) === key)) return null
  return deny(
    candidate.id,
    'SUBMERGED',
    `placing at (${target.x},${target.y},${target.z}) means standing in water and a dry placement spot exists`,
  )
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

/**
 * CAN-feasibility for one container interaction. The guard checks only hard
 * world truth the selection depends on: the container block still stands in the
 * current state at the selected cell, and (for a withdraw) the item the
 * envelope will declare is the item the selected candidate itself observed. It
 * never chooses WHICH container to open or WHICH item is worth taking - that is
 * Jev's decision, and this function only refuses a selection the world has
 * already contradicted.
 */
function guardContainer(candidate: Candidate, state: WorldState, context: GuardContext): GuardResult {
  const target = candidate.target
  if (target === null) {
    return deny(candidate.id, 'TARGET_GONE', 'CONTAINER candidate carries no container cell')
  }
  const container = (state.containers ?? []).find((station) => samePosition(station, target))
  if (container === undefined) {
    return deny(candidate.id, 'TARGET_GONE', `no container at (${target.x},${target.y},${target.z}) in the current state`)
  }
  const ref = readMetaString(candidate, 'containerRef')
  if (ref === null) {
    return deny(candidate.id, 'TARGET_GONE', 'CONTAINER candidate carries no container reference')
  }
  const action = readMetaString(candidate, 'containerAction') ?? 'open'
  if (action !== 'open' && action !== 'withdraw') {
    return deny(candidate.id, 'TARGET_GONE', `CONTAINER candidate has an unknown action "${action}"`)
  }
  if (action === 'withdraw') {
    // The item must be one the selection's OWN observation saw. A withdraw for
    // an item nobody observed is a hallucinated transfer, never a lucky guess.
    const item = readMetaString(candidate, 'containerItem')
    if (item === null) {
      return deny(candidate.id, 'EMPTY_HAND', 'CONTAINER withdraw candidate carries no item')
    }
    const observed = containerObservationAt(state.containerContents, target)
    if (observed === null) {
      return deny(candidate.id, 'TARGET_GONE', `contents of ${ref} are UNKNOWN (never observed), so no transfer can be grounded`)
    }
    if (observedItemCount(observed, item) <= 0) {
      return deny(candidate.id, 'EMPTY_HAND', `${ref} was observed without ${item}`)
    }
  }
  if (distance(target, state.self.eyePosition) > context.reach) {
    return guardStationApproach(candidate, context, target, ref)
  }
  return { ok: true, candidate }
}

/**
 * CAN for an out-of-reach CONTAINER: the body must be able to reach an
 * INTERACTION STAND beside the container - never the container's own cell.
 *
 * `guardPathComputable(candidate, context, target)` probes `GoalBlock(target)`,
 * i.e. "stand inside the container cell", which no container block allows. The
 * live record is unambiguous (m3-live buddy.log 2026-09-22T14:17:10.218Z):
 * `CONTAINER:open:purple_shulker_box@10,59,8` -> `NO_PATH ... (GoalBlock probe)`
 * five times in 11 s while the body stood 14.8 m away and never moved, and the
 * world truth at that cell is a shulker box beside the Nether gate with three
 * clear stands. The candidate layer had ALREADY grounded the same container
 * through `stationApproachReachable`, so the guard was refusing an approach its
 * own grounding had proven: this function consumes that same fact instead of
 * re-deriving a stricter one.
 *
 * `no_path` (no reachable stand) stays a separate outcome from the executor's
 * `occluded` (a stand exists and the line of sight from it is blocked): this
 * guard answers reachability only, and a stand whose SIGHT is blocked is
 * resolved by the executor's own sight-aware stand choice, not here.
 */
function guardStationApproach(
  candidate: Candidate,
  context: GuardContext,
  target: Vec3Json,
  ref: string,
): GuardResult {
  const probe = context.stationApproach ?? null
  if (probe === null) return guardPathComputable(candidate, context, target)
  const fact = probe(target, 'container')
  if (fact.approach === null) {
    return deny(
      candidate.id,
      'NO_PATH',
      `no interaction stand for ${ref} at (${target.x},${target.y},${target.z}) within reach`,
    )
  }
  if (fact.path === 'no_path') {
    return deny(
      candidate.id,
      'NO_PATH',
      `no canDig=false path to the interaction stand (${fact.approach.x},${fact.approach.y},${fact.approach.z}) for ${ref} at (${target.x},${target.y},${target.z})`,
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

function guardPickup(candidate: Candidate, state: WorldState, context: GuardContext): GuardResult {
  const target = candidate.target
  if (target === null) {
    return deny(candidate.id, 'TARGET_GONE', 'PICKUP candidate carries no coordinates')
  }
  if (target.y < VOID_FLOOR) {
    return deny(candidate.id, 'NO_SUPPORT', `(${target.x},${target.y},${target.z}) is below the world floor (void)`)
  }
  const entityId = candidate.targetEntityId
  const item = candidate.itemName
  const sensed = entityId === null ? undefined : state.entities.find((entity) => entity.id === entityId)
  // The candidate names ONE dropped-item entity. If that entity is no longer
  // sensed, the item is gone (collected by this body, despawned after five
  // minutes, or destroyed) and the candidate is stale: fail closed rather than
  // walking to a cell that now holds anything or nothing. The identity check is
  // the same truth the offer was grounded on, so a DIFFERENT item that happens to
  // occupy the cell can never be picked up under this candidate's name.
  if (sensed === undefined) {
    return deny(candidate.id, 'TARGET_GONE', `the dropped item entity e${entityId ?? 'unknown'} is no longer sensed`)
  }
  if (item !== null && sensed.droppedItem !== item) {
    return deny(
      candidate.id,
      'TARGET_GONE',
      `e${entityId} carries ${sensed.droppedItem ?? 'unknown'}, not ${item}`,
    )
  }
  const hazard = state.blocks.find((block) => block.kind === 'hazard' && samePosition(block.position, target))
  if (hazard !== undefined) {
    return deny(candidate.id, 'LAVA_RISK', `the dropped ${item ?? 'item'} is inside ${hazard.name}`)
  }
  return guardPathComputable(candidate, context, target)
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
  // A STATION retrieve is validated against the station memory, not the resource memory.
  // Stations live in `craftingTables`/`furnaces` (sensed near-field, then remembered), so
  // requiring `knownResources` denied every station retrieve whose cell was not also an
  // ore/resource: live, `RETRIEVE:known:station:furnace:b10_65_-9` was denied with
  // `TARGET_GONE reason=no remembered resource at (10,65,-9)` while the same furnace was a
  // KNOWN station two blocks away, stalling `smelt:charcoal` without bound.
  const stationKnown =
    candidate.id.startsWith('RETRIEVE:known:station:') &&
    [...(state.craftingTables ?? []), ...(state.furnaces ?? [])].some((station) => {
      const entry = station as unknown as { position?: unknown }
      const position = (entry?.position ?? station) as { x?: unknown; y?: unknown; z?: unknown } | null
      if (position === null || typeof position !== 'object') return false
      if (typeof position.x !== 'number' || typeof position.y !== 'number' || typeof position.z !== 'number') return false
      return samePosition({ x: position.x, y: position.y, z: position.z }, target)
    })
  if (!known && !stationKnown) {
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
  // A step whose landing profile holds a lit portal plane is not a dig at all: it is a
  // dimension change. The sensor owns the fact (`DescentOption.transfersDimension`), the
  // planner already refuses to make it a route, and this is the last boundary: the
  // explicit ENTER_PORTAL candidate is the only route that may cross a dimension.
  if (step.transfersDimension === true) {
    return deny(
      candidate.id,
      'CROSSES_DIMENSION',
      `standing at (${step.step.x},${step.step.y},${step.step.z}) realizes a dimension transfer (lit portal plane in the landing profile)`,
    )
  }
  // WALL ENTRY (`wallEntry.ts`): the sensor's `safe` verdict is a 3x3x3 PROXIMITY
  // union, so a step whose pocket is provably dry is refused `hazard` exactly like a
  // step the lava would pour through. The candidate declares the entry, and the guard
  // re-verifies it against the SAME sensor tick's own wall probe (`state.wallProbes`)
  // with the SAME predicate the offer used - it never trusts candidate meta. Only a
  // `hazard` refusal is superseded (the one proximity verdict the per-cell rule can
  // prove wrong); every other refused step is denied exactly as before, and when no
  // verified probe matches, the deny is unchanged.
  const entryProbe =
    candidate.meta.digRouteEntry === true && step.refusal === 'hazard'
      ? (state.wallProbes ?? []).find(
          (probe) => probe.dir === dir && probe.mode === mode && samePosition(probe.landing, target),
        )
      : undefined
  const verifiedEntry = entryProbe !== undefined && isVerifiedWallEntry(entryProbe)
  // BOUNDED LEVEL SCAN (`levelScan.ts`): the same situation one level down. The offered step
  // is the body's own-column descent, whose `hazard` verdict is again the 3x3x3 PROXIMITY
  // union; the per-cell shaft probe of the SAME sensor tick proves whether the shaft the dig
  // opens can be flooded. The guard re-reads that probe with the SAME predicate the offer
  // used (`isVerifiedWallEntry` over the shared `wallEntry.ts#wallPocketRefusal`), and only a
  // `hazard` refusal is superseded - an `open_floor` (uncontrolled fall), `no_support`,
  // `unbreakable` or `protected` verdict is denied exactly as before. When no verified shaft
  // probe matches, the deny is unchanged.
  const shaftProbe =
    candidate.meta.levelScan === true && step.refusal === 'hazard'
      ? (state.levelScan ?? []).find(
          (probe) =>
            probe.depth >= 1 &&
            probe.shaft.pocket[0].cell.x === target.x &&
            probe.shaft.pocket[0].cell.y === target.y &&
            probe.shaft.pocket[0].cell.z === target.z,
        )
      : undefined
  const verifiedShaft = shaftProbe !== undefined && isVerifiedWallEntry(shaftProbe.shaft)
  if (!step.safe && !verifiedEntry && !verifiedShaft) {
    return deny(candidate.id, 'NO_SUPPORT', `the descent step is not safe: ${step.reason}`)
  }
  if (candidate.requiresTool && !hasTool(state, candidate.toolName)) {
    return deny(candidate.id, 'EMPTY_HAND', `needs ${candidate.toolName ?? 'a tool'} but the inventory has none`)
  }
  const hazard = nearestHazardTo(state, target)
  // A VERIFIED wall entry (or the verified own-column shaft of a LEVEL SCAN) is exempt from
  // the proximity hazard deny for the same reason it is exempt from the proximity `safe`
  // verdict: `nearestHazardTo` is a 1.5-block radius (`ENV_LAVA_PROXIMITY`) around the mined
  // cell, and a hazard that radius catches but that shares no FACE with the pocket cannot
  // reach the body (fluids spread face-adjacently, and a diagonal neighbour does not
  // intersect the body's 0.6-wide box). A hazard that IS face-adjacent to the pocket is
  // exactly what the verified probe already refused, so this cannot let a hazardous step
  // through: the per-cell rule is strictly stronger here than the radius.
  if (hazard !== null && !verifiedEntry && !verifiedShaft) {
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
  // Walking onto a dropped item entity is a real side effect: the server moves the
  // stack into the inventory when the body enters its pickup volume. It is the
  // same "act on the world at a position" class as RETRIEVE, so a consumer that
  // asks "did the selected candidate act?" must see it.
  'PICKUP',
])
