// path-probes.ts — mechanical CAN/SAFE probes extracted from
// controller.ts. These answer one question each from live block and
// pathfinder truth: can a route be computed, is a stance column hazardous,
// is an entity visible from a stand, does a route cross a dimension-transfer
// cell, where is the interaction stand for a station or dig target, and which
// unreachable-station verdicts were already logged. They own no authority:
// they never choose a candidate and only mutate the tick-cached gate options
// and the station-approach dedup set on the host. The seam is unchanged — no
// function here is patched through controller.ts internals, so the class keeps
// plain one-line delegates and in-module calls are direct calls.

import type { Bot } from 'mineflayer'
import pathfinderModule from 'mineflayer-pathfinder'
import { ENV_LAVA_PROXIMITY, envHazardKindOfBlock, isLavaClassBlock } from './envHazard.ts'
import { contactGapY, MELEE_ATTACK_REACH, meleeHorizontalBudget, selectAttackStand } from './combatClosure.ts'
import type { AttackStandFact } from './combatClosure.ts'
import { formatStationUnreachable } from './reachability.ts'
import type {
  DigApproachFact,
  DigApproachProbe,
  DimensionTransferRoute,
  StationApproachFact,
  StationApproachProbe,
  StationApproachRefusal,
  StationKindName,
} from './reachability.ts'
import type { ReachabilityGateOptions } from './candidates.ts'
import { interactionStandCandidates } from './executor.ts'
import type { EventLogger } from './jev.ts'
import type { StateFingerprintMemory } from './moveFailMemory.ts'
import { isDimensionTransferBlock } from './netherPortalPlan.ts'
import { createPositionFactCache } from './positionFactCache.ts'
import { entityVisibleFromEye, isStandable } from './state.ts'
import type { Vec3Json } from './state.ts'

/** A guard path probe is synchronous; this caps how long it may think. */
const PATH_PROBE_TIMEOUT_MS = 750
const { goals } = pathfinderModule

export interface PathProbesHost {
  readonly bot: Bot
  options: {
    readonly reach: number
  }
  readonly logger: EventLogger
  readonly tickCounter: number
  readonly reachabilityProofs: StateFingerprintMemory
  readonly stationApproachLogged: Set<string>
  gateOptions: ReachabilityGateOptions | null
  gateOptionsTick: number
  attackStandProbe(): (query: { entityId: number; position: Vec3Json }) => AttackStandFact | null
  botPassableAt(x: number, y: number, z: number): boolean
  botSeesEntityFrom(x: number, y: number, z: number, entityPosition: Vec3Json, height: number): boolean
  botSolidSupportAt(x: number, y: number, z: number): boolean
  botStandColumnHazardAt(x: number, y: number, z: number): boolean
  botStandsInDimensionTransfer(feet: Vec3Json): boolean
  canComputeMeleePath(position: Vec3Json): boolean
  canComputePathNear(position: Vec3Json): boolean
  computePathFacts(position: Vec3Json): { probe: 'reachable' | 'no_path'; transfer: DimensionTransferRoute }
  digApproachProbe(): DigApproachProbe
  forgetStationUnreachable(kind: StationKindName, station: Vec3Json): void
  noteStationUnreachable(kind: StationKindName, station: Vec3Json, reason: StationApproachRefusal): void
  routeCrossesDimensionTransfer(path: readonly { x: number; y: number; z: number }[]): DimensionTransferRoute
  stationApproachProbe(): StationApproachProbe
}

export function canComputePath(host: PathProbesHost, position: Vec3Json): boolean {
  if (host.bot.pathfinder === undefined) return false
  try {
    const goal = new goals.GoalBlock(position.x, position.y, position.z)
    const plan = host.bot.pathfinder.getPathTo(host.bot.pathfinder.movements, goal, PATH_PROBE_TIMEOUT_MS)
    // `timeout` is not a usable route fact. The exact M2 wedge was a
    // GoalBlock timeout followed by a control-walk with no jump headroom;
    // treating a partial search as reachable re-admitted the same MOVE.
    return plan.status === 'success'
  } catch {
    return false
  }
}

/**
 * CAN fact for a plain ATTACK lease. The executor follows until the body's own
 * upper half is inside `MELEE_ATTACK_RANGE` of the target; probing GoalBlock is
 * stricter than the real action and can falsely reject a perfectly hittable
 * target, so use the same near radius.
 *
 * The goal is a 3-D BALL, so the radius must be the ball whose restriction to the
 * body's own level is the horizontal melee budget for THIS vertical gap
 * (`meleeHorizontalBudget`). Probing the bare reach against a target hovering
 * above the body is unsatisfiable by construction - radius 2.9 around a target 4
 * blocks up contains no cell the body can stand in - so the probe reported
 * `no_path` for a fight the body could actually win. For a level target the goal
 * is the same cell and the same radius as before, unchanged.
 *
 * Timeout is UNKNOWN/non-executable for this short lease, exactly like the
 * ordinary reachability probe: only a complete path is a current CAN proof.
 */
export function canComputeMeleePath(host: PathProbesHost, position: Vec3Json): boolean {
  if (host.bot.pathfinder === undefined) return false
  try {
    const feet = host.bot.entity.position
    const gapY = contactGapY(feet.y, position.y)
    const radius = Math.max(1, Math.hypot(meleeHorizontalBudget(gapY), Math.abs(gapY)) - 0.2)
    const goal = new goals.GoalNear(position.x, position.y, position.z, radius)
    const plan = host.bot.pathfinder.getPathTo(host.bot.pathfinder.movements, goal, PATH_PROBE_TIMEOUT_MS)
    return plan.status === 'success'
  } catch {
    return false
  }
}

/** Gate facts, shared by both candidate generations in one tick. */
export function reachabilityGateOptions(host: PathProbesHost): ReachabilityGateOptions {
  if (host.gateOptions !== null && host.gateOptionsTick === host.tickCounter) return host.gateOptions
  // One plan per destination, two facts out of it: whether the body can walk
  // there at all, and whether the route it would walk stands it in a
  // dimension-transfer cell. Computing the plan twice would double the
  // pathfinder cost of the whole gate.
  const attackPathCache = new Map<string, 'reachable' | 'no_path'>()
  const pathFacts = createPositionFactCache((position) => host.computePathFacts(position))
  host.gateOptions = {
    memory: host.reachabilityProofs,
    pathProbe: (position) => pathFacts(position).probe,
    dimensionTransferProbe: (position) => pathFacts(position).transfer,
    attackPathProbe: (position) => {
      const key = `${position.x},${position.y},${position.z}`
      const cached = attackPathCache.get(key)
      if (cached !== undefined) return cached
      const result = host.canComputeMeleePath(position) ? 'reachable' : 'no_path'
      attackPathCache.set(key, result)
      return result
    },
    stationApproach: host.stationApproachProbe(),
    digApproach: host.digApproachProbe(),
    attackStandProbe: host.attackStandProbe(),
  }
  host.gateOptionsTick = host.tickCounter
  return host.gateOptions
}

/**
 * THE STANCE PROBE: the live world questions `combatClosure.selectAttackStand`
 * asks, answered from real block truth - the sensor's own standability rule,
 * the `envHazard` classes, and the SAME `bot.world.raycast` the threat-cover
 * logic casts (`state.ts threatSightLineBlocked`). No parallel geometry: the
 * only thing added here is the eye origin the cover logic already uses, moved
 * to a stance the body is not standing in yet.
 *
 * This is the fact the melee path probe cannot answer. `GoalNear(entity, 2.9)`
 * proves a route to WITHIN 2.9 m of the entity's feet; it says nothing about
 * whether a cell there is a legal stance or whether the entity is visible from
 * it. Measured live: a magma cube embedded in the wall beside the body (every
 * stance occluded, every swing `verify_failed`) and an enderman at 6.11 m whose
 * `GoalFollow` never closed while the distance froze for ~47 s with zero swings.
 *
 * Cached per entity per tick (the gate options themselves are tick-cached), and
 * `null` when the live entity's own height cannot be read: no verdict, so the
 * gate keeps its previous behaviour rather than refusing on a missing fact.
 */
export function attackStandProbe(host: PathProbesHost): (query: { entityId: number; position: Vec3Json }) => AttackStandFact | null {
  const cache = new Map<number, AttackStandFact | null>()
  return (query) => {
    const cached = cache.get(query.entityId)
    if (cached !== undefined) return cached
    const entity = host.bot.entities[query.entityId]
    const height = entity === undefined ? Number.NaN : (entity as { height?: number }).height ?? Number.NaN
    if (!Number.isFinite(height) || height <= 0) {
      // The aim point is `position + height / 2` (the SAME point `runAttack`
      // looks at). Without it there is no visibility question to answer, so the
      // fact is UNKNOWN - never an invented stance.
      cache.set(query.entityId, null)
      return null
    }
    const fact = selectAttackStand({
      entity: { position: query.position, height },
      feet: { x: host.bot.entity.position.x, y: host.bot.entity.position.y, z: host.bot.entity.position.z },
      reach: MELEE_ATTACK_REACH,
      world: {
        standable: (x, y, z) => isStandable(host.bot, { x, y, z }),
        hazard: (x, y, z) => host.botStandColumnHazardAt(x, y, z),
        visible: (x, y, z) => host.botSeesEntityFrom(x, y, z, query.position, height),
      },
    })
    cache.set(query.entityId, fact)
    return fact
  }
}

/**
 * Is the 1x2 stance column at this cell a hazard? The same classification the
 * `envHazard` layer owns (`envHazardKindOfBlock`) for the stance's own feet,
 * head and support cells, plus the `envHazard` lava proximity margin for a
 * lava-class neighbour - the same two rules `reachabilityWorldFor` applies to
 * a locomotion destination (`HAZARD_PROXIMITY` IS `ENV_LAVA_PROXIMITY`).
 */
export function botStandColumnHazardAt(host: PathProbesHost, x: number, y: number, z: number): boolean {
  const scratch = host.bot.entity.position.clone()
  const nameAt = (cx: number, cy: number, cz: number): string | null => {
    const block = host.bot.blockAt(scratch.set(cx, cy, cz))
    return block === null || block === undefined ? null : (block.name ?? null)
  }
  // The stance's OWN body column: fire/lava the body would be inside.
  if (envHazardKindOfBlock(nameAt(x, y, z)) !== null) return true
  if (envHazardKindOfBlock(nameAt(x, y + 1, z)) !== null) return true
  if (envHazardKindOfBlock(nameAt(x, y - 1, z)) !== null) return true
  // A lava-class neighbour inside the shared margin: standing there means
  // standing in it (`envHazardProximityDenied(false, name)` semantics). A cell
  // whose offset has any component >= 2 is at least 2 away, so it can never be
  // inside a 1.5 margin: `floor` is the exact bound, not a truncation.
  const span = Math.floor(ENV_LAVA_PROXIMITY)
  for (let dx = -span; dx <= span; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dz = -span; dz <= span; dz += 1) {
        const cx = x + dx
        const cy = y + dy
        const cz = z + dz
        if (!isLavaClassBlock(nameAt(cx, cy, cz))) continue
        if (Math.hypot(cx - x, cy - y, cz - z) <= ENV_LAVA_PROXIMITY) return true
      }
    }
  }
  return false
}

/**
 * Can a body standing on this stance see the entity? Delegated to the sensor's
 * own `entityVisibleFromEye` so the stance verdict and `EntityState.lineOfSight`
 * answer with ONE implementation of one ray, to ONE point (the entity's aim
 * point, `position + height / 2`). Two copies of this geometry is how the
 * sensor could report `los=false` while the stance search found the mob plainly
 * visible.
 *
 * Absence of a raycast (a structural double, a fixture) answers `true`: "not
 * occluded" is the fail-open direction here, so a missing world never refutes a
 * visible mob - which is exactly the previous behaviour of this method.
 */
export function botSeesEntityFrom(host: PathProbesHost, x: number, y: number, z: number, entityPosition: Vec3Json, height: number): boolean {
  if (host.bot.world === undefined || typeof host.bot.world.raycast !== 'function') return true
  const eyeHeight = (host.bot.entity as unknown as { eyeHeight?: number }).eyeHeight ?? 1.62
  return (
    entityVisibleFromEye(
      host.bot,
      { x: x + 0.5, y: y + eyeHeight, z: z + 0.5 },
      { position: entityPosition, height },
    ) !== false
  )
}

/**
 * SAFE/CAN: the route facts for one destination, from ONE plan.
 *
 * `probe` keeps the exact semantics `canComputePath` had (a `timeout` is not a
 * usable route fact, an exception is `no_path`), so no existing verdict moves.
 * `transfer` is the route-side half of the dimension-transfer invariant: does
 * the path the body would actually walk stand it in a lit portal block?
 * `unknown` when no plan exists (nothing is refused on an unavailable probe).
 */
export function computePathFacts(host: PathProbesHost, position: Vec3Json): { probe: 'reachable' | 'no_path'; transfer: DimensionTransferRoute } {
  if (host.bot.pathfinder === undefined) return { probe: 'no_path', transfer: 'unknown' }
  try {
    const goal = new goals.GoalBlock(position.x, position.y, position.z)
    const plan = host.bot.pathfinder.getPathTo(host.bot.pathfinder.movements, goal, PATH_PROBE_TIMEOUT_MS)
    if (plan.status !== 'success') return { probe: 'no_path', transfer: 'unknown' }
    return { probe: 'reachable', transfer: host.routeCrossesDimensionTransfer(plan.path) }
  } catch {
    return { probe: 'no_path', transfer: 'unknown' }
  }
}

/**
 * Does this planned route stand the body in a dimension-transfer cell? Every
 * path node is a cell the executor will occupy (feet), so the body's feet or
 * head being portal material at any node is exactly the transfer condition the
 * executor's own walk-in mechanic waits for.
 */
export function routeCrossesDimensionTransfer(host: PathProbesHost, path: readonly { x: number; y: number; z: number }[]): DimensionTransferRoute {
  for (const node of path) {
    if (host.botStandsInDimensionTransfer({ x: node.x, y: node.y, z: node.z })) return 'crosses'
  }
  return 'clear'
}

/** Live block truth: would standing with the feet at this cell transfer the body? */
export function botStandsInDimensionTransfer(host: PathProbesHost, feet: Vec3Json): boolean {
  const scratch = host.bot.entity.position.clone()
  const feetBlock = host.bot.blockAt(scratch.set(feet.x, feet.y, feet.z))
  if (isDimensionTransferBlock(feetBlock?.name)) return true
  const headBlock = host.bot.blockAt(scratch.set(feet.x, feet.y + 1, feet.z))
  return isDimensionTransferBlock(headBlock?.name)
}

/**
 * The #244 interaction stand, generalised from stations to blocked dig targets.
 * A blocked target's sensor adjacency fact only samples 12 neighbours; a stand
 * one stance away can still make the block diggable. The stand is resolved with
 * the SAME live passable+support+face-reach machinery the station path uses.
 * The expensive `canDig=false` path probe is budgeted per tick; beyond it the
 * verdict is left unknown and the guard's own path probe still gates the MOVE.
 */
export function digApproachProbe(host: PathProbesHost): DigApproachProbe {
  const cache = new Map<string, DigApproachFact>()
  let pathProbes = 0
  const pathProbeBudget = 4
  return (block) => {
    const cacheKey = `${block.x},${block.y},${block.z}`
    const cached = cache.get(cacheKey)
    if (cached !== undefined) return cached
    const feet = host.bot.entity.position
    const stands = interactionStandCandidates(
      block,
      { x: feet.x, y: feet.y, z: feet.z },
      {
        passable: (x, y, z) => host.botPassableAt(x, y, z),
        solidSupport: (x, y, z) => host.botSolidSupportAt(x, y, z),
      },
      host.options.reach,
    )
    const stand = stands[0] ?? null
    let fact: DigApproachFact
    if (stand === null) {
      fact = { approach: null, path: null }
    } else if (pathProbes < pathProbeBudget) {
      pathProbes += 1
      fact = { approach: stand, path: host.canComputePathNear(stand) ? 'reachable' : 'no_path' }
    } else {
      fact = { approach: stand, path: null }
    }
    cache.set(cacheKey, fact)
    return fact
  }
}

export function stationApproachProbe(host: PathProbesHost): StationApproachProbe {
  const cache = new Map<string, StationApproachFact>()
  return (station, kind) => {
    const cacheKey = `${kind}:${station.x},${station.y},${station.z}`
    const cached = cache.get(cacheKey)
    if (cached !== undefined) return cached
    const feet = host.bot.entity.position
    const stands = interactionStandCandidates(
      station,
      { x: feet.x, y: feet.y, z: feet.z },
      {
        passable: (x, y, z) => host.botPassableAt(x, y, z),
        solidSupport: (x, y, z) => host.botSolidSupportAt(x, y, z),
      },
      host.options.reach,
    )
    const stand = stands[0] ?? null
    let fact: StationApproachFact
    if (stand === null) {
      host.noteStationUnreachable(kind, station, 'no_interaction_stand')
      fact = { approach: null, path: null }
    } else {
      const path = host.canComputePathNear(stand) ? 'reachable' : 'no_path'
      if (path === 'no_path') host.noteStationUnreachable(kind, station, 'no_path_to_stand')
      else host.forgetStationUnreachable(kind, station)
      fact = { approach: stand, path }
    }
    cache.set(cacheKey, fact)
    return fact
  }
}

export function botPassableAt(host: PathProbesHost, x: number, y: number, z: number): boolean {
  const block = host.bot.blockAt(host.bot.entity.position.clone().set(x, y, z))
  return block === null || block.boundingBox === 'empty'
}

export function botSolidSupportAt(host: PathProbesHost, x: number, y: number, z: number): boolean {
  const block = host.bot.blockAt(host.bot.entity.position.clone().set(x, y, z))
  return block !== null && block.boundingBox === 'block'
}

export function canComputePathNear(host: PathProbesHost, position: Vec3Json): boolean {
  if (host.bot.pathfinder === undefined) return false
  try {
    const goal = new goals.GoalNear(position.x, position.y, position.z, 1)
    const plan = host.bot.pathfinder.getPathTo(host.bot.pathfinder.movements, goal, PATH_PROBE_TIMEOUT_MS)
    return plan.status !== 'noPath'
  } catch {
    return false
  }
}

export function noteStationUnreachable(host: PathProbesHost, kind: StationKindName, station: Vec3Json, reason: StationApproachRefusal): void {
  const key = formatStationUnreachable(kind, station, reason)
  if (host.stationApproachLogged.has(key)) return
  host.stationApproachLogged.add(key)
  host.logger.warn('agent', key, { kind, station, reason }, host.tickCounter)
}

export function forgetStationUnreachable(host: PathProbesHost, kind: StationKindName, station: Vec3Json): void {
  for (const reason of ['no_interaction_stand', 'no_path_to_stand'] as const) {
    host.stationApproachLogged.delete(formatStationUnreachable(kind, station, reason))
  }
}
