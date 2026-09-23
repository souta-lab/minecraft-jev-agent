// test-bridge-scaffold.mts - the general BRIDGE/scaffold MOVE mechanic.
//
// OPERATOR PROPOSAL (2026-09-23, watching the live body at the edge of the Nether
// lava lake), evaluated and adopted with judgment as a general MOVE mechanic:
//
//   "橋をscaffolding的にやるっていう選択肢がない"                   - no bridge option existed
//   "人間が使うPVP clientくらいのズルなら許容される"                - forgiving timing/precision is OK
//   "ジャンプとか橋渡しとか塔をたてるのも結局MOVEに一般化できそう"   - generalise into MOVE
//
// The allowance covers TIMING/PRECISION only (place-then-step in quick
// succession). Nothing here uses packets, a client mod or a physics bypass: the
// executor places against a real adjacent face and then walks, so the server
// validates every step.
//
// MEASURED FACTS this fixture pins (all STATIC/offline; see the run evidence in the
// hand-off report for the live shape):
//
//   * `state.ts#buildPlacementSpots` scanned `dy in {0,1}` relative to the feet, so
//     a hole's FLOOR cell (`feet.y - 1`) was never a sensed placement spot and a
//     same-level bridge could not be grounded at all;
//   * `state.ts#buildDescent` named the gap (`refusal: 'no_support'`) with nothing
//     able to act on the name;
//   * `policy.guardMove` rejected any MOVE whose target was not in
//     `terrain.standable`, and the canDig=false path probe can never express
//     "place a block and step onto it".
//
// Fixtures (i)-(vi) from the brief:
//   (i)   1-3 block gap with a verified standable far side and blocks in hand ->
//         offered, crossed, far cell verified before the last step;
//   (ii)  no placeable block -> typed `no_block` refusal, no candidate;
//   (iii) the continuation is lava/unverified -> refuse, never strand the body;
//   (iv)  ordinary walkable terrain -> byte-identical offer/actions;
//   (v)   as a #436 section 7 prerequisite: exactly one remedy -> executes with
//         authority=MANDATORY_PREREQUISITE; bridge vs detour vs tower all grounded
//         -> SKILL_POLICY_BOUNDARY with the alternatives and no code choice;
//   (vi)  a mid-bridge interruption leaves the body standing safely with a typed end.
//
// Run: bun test ./test-bridge-scaffold.mts

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import type { Bot } from 'mineflayer'
import { entryCandidates, defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import { guardCandidate } from './src/policy.ts'
import type { GuardContext } from './src/policy.ts'
import type { PortalEntryPlan } from './src/netherPortalPlan.ts'
import { NETHER, PORTAL_ENTERED_PREDICATE } from './src/netherPortalPlan.ts'
import { cellKey, observeZeroProgressRoute, routeSignature } from './src/zeroProgressRoute.ts'
import { effectViolation, envelopeForCandidate } from './src/skillCommitment.ts'
import { Executor, EventLogger, defaultExecutorOptions } from './src/index.ts'
import type { JsonlWriter } from './src/jev-legacy.ts'
import { MIRRORED_MARKERS } from './src/controller.ts'
import {
  BRIDGE_AUTHORITY_META,
  BRIDGE_BLOCK_META,
  BRIDGE_DIR_META,
  BRIDGE_LINE_META,
  BRIDGE_MAY_PLACE_META,
  BRIDGE_META,
  BRIDGE_PROBE_DEPTH,
  BRIDGE_REFUSED_META,
  BRIDGE_SPAN_META,
  bridgeDirOffset,
  formatBridgeStart,
  isBridgeUnsafeBlockName,
  planBridgeRoute,
} from './src/bridgeRoute.ts'
import type { BridgeProbe, BridgeProbeCell, BridgeDir } from './src/bridgeRoute.ts'
import type { AgentSignals, DescentDir, DescentOption, DescentRefusalReason, InventoryState, SelfState, Vec3Json, WorldState } from './src/state.ts'
import { distance, probeBridgeDirection } from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const key = (p: Vec3Json): string => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
const round2 = (value: number): number => Math.round(value * 100) / 100

// ---------------------------------------------------------------------------
// A small, explicit terrain model. Every block name the fixtures use carries the
// ONE fact the sensor reads (`boundingBox`) plus diggability, so the hand-built
// `descent` / `bridgeProbes` / `placementSpots` below are the same facts the live
// sensor would produce for this rock.
// ---------------------------------------------------------------------------
const EMPTY_BOX = new Set(['air', 'cave_air', 'void_air', 'water', 'lava'])
const REPLACEABLE = new Set(['air', 'cave_air', 'void_air'])
const SOLID_NAMES = new Set(['stone', 'cobblestone', 'nether_bricks', 'netherrack', 'obsidian'])
const NO_CANOPY = new Set(['stone', 'cobblestone', 'nether_bricks', 'netherrack', 'obsidian'])

class Terrain {
  readonly cells = new Map<string, string>()
  set(cell: Vec3Json, name: string): this {
    this.cells.set(key(cell), name)
    return this
  }
  fill(fromX: number, toX: number, z: number, y: number, name: string): this {
    for (let x = fromX; x <= toX; x += 1) this.set({ x, y, z }, name)
    return this
  }
  name(cell: Vec3Json): string {
    return this.cells.get(key(cell)) ?? 'air'
  }
  boundingBox(cell: Vec3Json): 'empty' | 'block' {
    const name = this.name(cell)
    if (EMPTY_BOX.has(name)) return 'empty'
    return 'block'
  }
  open(cell: Vec3Json): boolean {
    return this.boundingBox(cell) === 'empty'
  }
  solid(cell: Vec3Json): boolean {
    return this.boundingBox(cell) === 'block'
  }
  standable(cell: Vec3Json): boolean {
    const support = this.name({ x: cell.x, y: cell.y - 1, z: cell.z })
    return (
      this.open(cell) &&
      this.open({ x: cell.x, y: cell.y + 1, z: cell.z }) &&
      SOLID_NAMES.has(support) &&
      NO_CANOPY.has(support)
    )
  }
  /** The `standable` set a 5x5x3 flat scan would sense from `feet`. */
  standableAround(feet: Vec3Json): Vec3Json[] {
    const out: Vec3Json[] = []
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dz = -2; dz <= 2; dz += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const cell = { x: feet.x + dx, y: feet.y + dy, z: feet.z + dz }
          if (this.standable(cell)) out.push(cell)
        }
      }
    }
    return out.sort((a, b) => distance(a, feet) - distance(b, feet))
  }
  /** The WIDENED placement-spot scan (`state.ts#buildPlacementSpots`, now `dy -1..1`). */
  placementSpotsAround(feet: Vec3Json, eye: Vec3Json, reach = 4.5): Vec3Json[] {
    const botBody = { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 }
    const spots: Vec3Json[] = []
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dz = -2; dz <= 2; dz += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const candidate = { x: feet.x + dx, y: feet.y + dy, z: feet.z + dz }
          const nearBody = distance({ x: candidate.x + 0.5, y: candidate.y, z: candidate.z + 0.5 }, botBody)
          if (nearBody < 1.0) continue
          if (!REPLACEABLE.has(this.name(candidate))) continue
          if (!this.open({ x: candidate.x, y: candidate.y + 1, z: candidate.z })) continue
          const support = this.name({ x: candidate.x, y: candidate.y - 1, z: candidate.z })
          if (!SOLID_NAMES.has(support) || !NO_CANOPY.has(support)) continue
          if (distance(candidate, eye) > reach + 0.5) continue
          spots.push(candidate)
        }
      }
    }
    return spots.sort((a, b) => distance(a, { x: feet.x, y: feet.y, z: feet.z }) - distance(b, { x: feet.x, y: feet.y, z: feet.z }))
  }
  hazard(cell: Vec3Json): boolean {
    return isBridgeUnsafeBlockName(this.name(cell))
  }
}

const DIRS: Array<{ dir: DescentDir; dx: number; dz: number }> = [
  { dir: 'E', dx: 1, dz: 0 },
  { dir: 'W', dx: -1, dz: 0 },
  { dir: 'N', dx: 0, dz: -1 },
  { dir: 'S', dx: 0, dz: 1 },
]

/** The sensor's own cardinal step geometry (`state.ts#buildDescent`) over `terrain`. */
function descentFromTerrain(terrain: Terrain, feet: Vec3Json): DescentOption[] {
  const out: DescentOption[] = []
  const clear = (cell: Vec3Json): boolean => terrain.open(cell)
  for (const { dir, dx, dz } of DIRS) {
    for (const mode of ['level', 'down'] as const) {
      const wall = { x: feet.x + dx, y: feet.y, z: feet.z + dz }
      const head = { x: feet.x + dx, y: feet.y + 1, z: feet.z + dz }
      const step = { x: feet.x + dx, y: mode === 'down' ? feet.y - 1 : feet.y, z: feet.z + dz }
      const floor = { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz }
      const support = { x: feet.x + dx, y: step.y - 1, z: feet.z + dz }
      const wallSolid = terrain.solid(wall)
      const headSolid = terrain.solid(head)
      const floorSolid = terrain.solid(floor)
      const supportSolid = terrain.solid(support)
      const hazardNearby = [wall, head, floor, step, support].some((cell) => terrain.hazard(cell))
      const floorOk = mode === 'level' || clear(floor)
      let refusal: DescentRefusalReason | undefined
      let reason = 'safe'
      if (!floorOk) {
        refusal = 'unbreakable'
        reason = `${terrain.name(floor)} floor is not breakable`
      } else if (!supportSolid) {
        refusal = 'no_support'
        reason = `no solid support at (${support.x},${support.y},${support.z})`
      } else if (mode === 'down' && clear(floor)) {
        refusal = 'open_floor'
        reason = 'floor already open (uncontrolled fall)'
      } else if (hazardNearby) {
        refusal = 'hazard'
        reason = 'lava/water in the step column'
      }
      const primary = mode === 'down' ? (floorSolid ? floor : wall) : wallSolid ? wall : head
      out.push({
        dir,
        mode,
        dx,
        dz,
        step,
        wall,
        head,
        floor,
        wallSolid,
        headSolid,
        floorSolid,
        supportSolid,
        hazardNearby,
        digs: [{ cell: primary, name: terrain.name(primary), harvestTool: 'pickaxe', harvestTier: 0, diggable: true }],
        safe: reason === 'safe',
        reason,
        ...(refusal === undefined ? {} : { refusal }),
        digName: terrain.name(primary),
        digHarvestTool: 'pickaxe',
        digHarvestTier: 0,
        diggable: true,
      })
    }
  }
  // The own column, exactly as `buildDescent` emits it (`D` digs the floor).
  const floor = { x: feet.x, y: feet.y - 1, z: feet.z }
  const support = { x: feet.x, y: feet.y - 2, z: feet.z }
  const supportSolid = terrain.solid(support)
  out.push({
    dir: 'D',
    mode: 'down',
    dx: 0,
    dz: 0,
    step: floor,
    wall: feet,
    head: { x: feet.x, y: feet.y + 1, z: feet.z },
    floor,
    wallSolid: terrain.solid(feet),
    headSolid: terrain.solid({ x: feet.x, y: feet.y + 1, z: feet.z }),
    floorSolid: terrain.solid(floor),
    supportSolid,
    hazardNearby: [floor, support].some((cell) => terrain.hazard(cell)),
    digs: [{ cell: floor, name: terrain.name(floor), harvestTool: 'pickaxe', harvestTier: 0, diggable: true }],
    safe: supportSolid,
    reason: supportSolid ? 'safe' : 'no solid support under the own column',
    ...(supportSolid ? {} : { refusal: 'no_support' as DescentRefusalReason }),
    digName: terrain.name(floor),
    digHarvestTool: 'pickaxe',
    digHarvestTier: 0,
    diggable: true,
  })
  return out
}

/** One probed column, classified exactly as `state.ts#probeBridgeDirection` does. */
function probeCell(terrain: Terrain, cell: Vec3Json): BridgeProbeCell {
  const floor = { x: cell.x, y: cell.y - 1, z: cell.z }
  const below = { x: cell.x, y: cell.y - 2, z: cell.z }
  const head = { x: cell.x, y: cell.y + 1, z: cell.z }
  return {
    cell,
    floor,
    open: terrain.open(cell),
    headOpen: terrain.open(head),
    placeable: REPLACEABLE.has(terrain.name(floor)),
    supported: terrain.solid(floor),
    standable: terrain.standable(cell),
    hazard: [cell, head, floor, below].some((probed) => terrain.hazard(probed)),
    cellName: terrain.name(cell),
    floorName: terrain.name(floor),
  }
}

function probesFromTerrain(terrain: Terrain, feet: Vec3Json, depth = BRIDGE_PROBE_DEPTH): BridgeProbe[] {
  return (['E', 'W', 'N', 'S'] as BridgeDir[]).map((dir) => {
    const { dx, dz } = bridgeDirOffset(dir)
    const cells: BridgeProbeCell[] = []
    for (let step = 1; step <= depth; step += 1) {
      cells.push(probeCell(terrain, { x: feet.x + dx * step, y: feet.y, z: feet.z + dz * step }))
    }
    const footing = terrain.name({ x: feet.x, y: feet.y - 1, z: feet.z })
    return {
      dir,
      dx,
      dz,
      cells,
      footing: SOLID_NAMES.has(footing) && NO_CANOPY.has(footing),
    }
  })
}

// ---------------------------------------------------------------------------
// candidate-layer state
// ---------------------------------------------------------------------------
const OVERWORLD = 'minecraft:overworld'

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_BRIDGE',
    position: { x: position.x + 0.5, y: position.y, z: position.z + 0.5 },
    eyePosition: { x: position.x + 0.5, y: position.y + 1.62, z: position.z + 0.5 },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: OVERWORLD,
    isDay: true,
    heldItem: null,
  }
}

function inventory(counts: Record<string, number>): InventoryState {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0) }
}

function signals(extra: Partial<AgentSignals> = {}): AgentSignals {
  return {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastPathStatus: 'idle',
    stalledMs: 0,
    lastPolicyConfidence: null,
    maxConcurrentActions: 0,
    escalationRecommended: false,
    failedCandidates: {},
    knownResources: [],
    ...extra,
  }
}

function entryPlanFor(enterCell: Vec3Json): PortalEntryPlan {
  return {
    ok: true,
    candidate: {
      id: `ENTER:${enterCell.x},${enterCell.y},${enterCell.z}`,
      portalCells: [
        { x: enterCell.x, y: enterCell.y, z: enterCell.z },
        { x: enterCell.x + 1, y: enterCell.y, z: enterCell.z },
      ],
      enterCell,
      dimension: NETHER,
      line: `PORTAL_ENTRY enter=${enterCell.x},${enterCell.y},${enterCell.z}`,
    },
  }
}

function queuedPlace(enterCell: Vec3Json): QueuedGoal {
  return {
    id: 'g-portal-entered',
    kind: 'place',
    description: 'portal_entered nether_portal',
    targetItem: 'nether_portal',
    requiredCount: 1,
    targetPredicate: PORTAL_ENTERED_PREDICATE,
    dimension: NETHER,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'mechanical',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

/** A `goto` goal whose own locomotion target is across the gap. */
function queuedGoto(target: Vec3Json): QueuedGoal {
  return {
    id: 'g-goto',
    kind: 'goto',
    description: `return to the code-grounded target`,
    targetItem: null,
    requiredCount: 1,
    targetPredicate: null,
    dimension: OVERWORLD,
    targetPosition: target,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'mechanical',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function queueWith(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

interface WorldSpec {
  feet: Vec3Json
  terrain: Terrain
  counts?: Record<string, number>
  routes?: AgentSignals['zeroProgressRoutes']
  /** omit the probes entirely (a legacy fixture): the state must stay byte-identical */
  legacyNoProbes?: boolean
  current?: QueuedGoal
  enterCell?: Vec3Json
  blocks?: WorldState['blocks']
}

function worldState(spec: WorldSpec): WorldState {
  const feet = spec.feet
  const body = self(feet)
  const current = spec.current ?? queuedPlace(spec.enterCell ?? feet)
  const spots = spec.terrain.placementSpotsAround(feet, body.eyePosition)
  return {
    schemaVersion: 1,
    tick: 9,
    timestampMs: 1_700_000_000_000,
    self: body,
    inventory: inventory(spec.counts ?? {}),
    entities: [],
    blocks: spec.blocks ?? [],
    terrain: { standable: spec.terrain.standableAround(feet) },
    craftingTables: [],
    furnaces: [],
    placementSpots: spots,
    portalFrameSites: [],
    ...(spec.legacyNoProbes === true ? {} : { bridgeProbes: probesFromTerrain(spec.terrain, feet) }),
    descent: descentFromTerrain(spec.terrain, feet),
    stepCuts: [],
    headroomCuts: [],
    goal: {
      id: 'g',
      description: current.description,
      targetItem: current.targetItem ?? '',
      requiredCount: 1,
      startCount: 0,
      haveCount: 0,
      progress: 0,
      complete: false,
      startedAtMs: 0,
    },
    goalQueue: queueWith(current),
    recentEvents: [],
    signals: signals(spec.routes === undefined ? {} : { zeroProgressRoutes: spec.routes }),
  }
}

function optionsFor(spec: WorldSpec): CandidateOptions {
  return {
    ...defaultCandidateOptions,
    portalEntry: entryPlanFor(spec.enterCell ?? spec.feet),
    reachability: { pathProbe: () => 'no_path' },
  }
}

/** The controller's own recording path for a settled path-stage failure. */
function spendEntryRoute(state: WorldState, options: CandidateOptions, enterCell: Vec3Json): AgentSignals['zeroProgressRoutes'] {
  const fresh = entryCandidates(state, options)
  const entry = fresh.candidates.find((candidate) => candidate.kind === 'ENTER_PORTAL') ?? fresh.candidates[0]
  if (entry === undefined) throw new Error('fixture: no ENTER candidate to spend')
  return observeZeroProgressRoute(undefined, {
    kind: 'ENTER_PORTAL',
    targetKey: cellKey(enterCell),
    standKey: cellKey(state.self.position),
    routeSig: routeSignature({ kind: entry.kind, id: entry.id, meta: entry.meta }),
    reason: 'path_no_path',
    nowMs: state.timestampMs,
  }).routes
}

const bridgeCandidates = (candidates: readonly Candidate[]): Candidate[] =>
  candidates.filter((candidate) => candidate.meta[BRIDGE_META] === true)

/**
 * A ledge east of the body with `gap` missing floor cells between it and a solid
 * far side.
 *
 *   `bed: false` (default) is a TRUE GAP over a void/lava basin: the hole's floor
 *   cell has nothing under it, so it is not standable, no sensed placement spot
 *   exists there, and only a bridge can ground (the Nether-fortress shape).
 *   `bed: true` is a 1-deep DIP whose floor cell has solid ground beneath: it IS
 *   standable, so the ordinary step-over pocket continuation grounds beside the
 *   bridge - the multi-remedy shape of fixture (v).
 */
function ledgeTerrain(
  gap: number,
  options: { bed?: boolean; ledgeTo?: number } = {},
): { terrain: Terrain; feet: Vec3Json; far: Vec3Json } {
  const feet: Vec3Json = { x: 0, y: 64, z: 0 }
  const terrain = new Terrain()
  terrain.set({ x: 0, y: 63, z: 0 }, 'stone')
  const farX = 1 + gap
  terrain.fill(farX, options.ledgeTo ?? farX + 4, 0, 63, 'nether_bricks')
  if (options.bed === true) terrain.fill(-2, options.ledgeTo ?? farX + 4, 0, 62, 'stone')
  return { terrain, feet, far: { x: farX, y: 64, z: 0 } }
}

// ===========================================================================
// (i) a 1-3 block gap with a verified standable far side and blocks in hand
// ===========================================================================
{
  // The measured fact #1: widening the placement-spot scan to `dy -1..1` is what
  // makes a hole's FLOOR cell senseable at all. A 1-deep dip has solid ground
  // beneath its floor cell, which is exactly the case the scan can now see.
  const { terrain, feet } = ledgeTerrain(1, { bed: true })
  const body = self(feet)
  const spots = terrain.placementSpotsAround(feet, body.eyePosition)
  check(
    '(i) a hole floor cell (feet.y - 1) is now a sensed placement spot',
    spots.some((spot) => key(spot) === '1,63,0'),
    `placementSpots=[${spots.map(key).join(' ')}]`,
  )
  check(
    '(i) the sensor still refuses the cell directly under the feet',
    !spots.some((spot) => key(spot) === '0,63,0'),
    `own column absent from placementSpots=${!spots.some((spot) => key(spot) === '0,63,0')}`,
  )

  for (const gap of [1, 2, 3]) {
    const world = ledgeTerrain(gap)
    const counts = { cobblestone: 381 }
    const state = worldState({ feet: world.feet, terrain: world.terrain, counts, enterCell: world.far })
    const decision = planBridgeRoute({
      selfFeet: world.feet,
      target: world.far,
      probes: state.bridgeProbes,
      placeable: { name: 'cobblestone', count: 381 },
    })
    const plan = decision.plan
    check(
      `(i) a ${gap}-block gap grounds a verified ${gap}-span bridge with the block it will consume`,
      plan !== null &&
        plan.span === gap &&
        plan.dir === 'E' &&
        key(plan.landing) === `1,64,0` &&
        key(plan.place) === `1,63,0` &&
        key(plan.far) === key(world.far) &&
        plan.block === 'cobblestone' &&
        plan.remaining === 381 - gap &&
        plan.line === formatBridgeStart({ cell: plan.landing, block: 'cobblestone', span: gap, remaining: 381 - gap }),
      plan === null
        ? `refused: ${decision.refusal.reason} :: ${decision.refusal.detail}`
        : `span=${plan.span} landing=${key(plan.landing)} place=${key(plan.place)} far=${key(plan.far)} remaining=${plan.remaining} line=${plan.line}`,
    )
  }

  // The offer, through the real candidate path: the entry route is SPENT, so the
  // leg families run, and the bridge is enumerated beside them.
  const world = ledgeTerrain(3)
  const counts = { cobblestone: 381 }
  const base = worldState({ feet: world.feet, terrain: world.terrain, counts, enterCell: world.far })
  const options = optionsFor({ feet: world.feet, terrain: world.terrain, enterCell: world.far })
  const spent = spendEntryRoute(base, options, world.far)
  const offered = worldState({ feet: world.feet, terrain: world.terrain, counts, enterCell: world.far, routes: spent })
  const offer = entryCandidates(offered, options)
  const bridge = bridgeCandidates(offer.candidates)[0]
  check(
    '(i) the bridge is offered as an ordinary MOVE candidate carrying its verified far side',
    bridge !== undefined &&
      bridge.kind === 'MOVE' &&
      bridge.target !== null &&
      key(bridge.target) === key(world.far) &&
      bridge.meta[BRIDGE_DIR_META] === 'E' &&
      bridge.meta[BRIDGE_SPAN_META] === 3 &&
      bridge.meta[BRIDGE_BLOCK_META] === 'cobblestone' &&
      bridge.meta[BRIDGE_MAY_PLACE_META] === true &&
      typeof bridge.meta[BRIDGE_LINE_META] === 'string' &&
      (bridge.meta[BRIDGE_LINE_META] as string).startsWith('BRIDGE_START cell=1,64,0 block=cobblestone span=3 remaining=378'),
    `offer=[${offer.candidates.map((candidate) => candidate.id).join(',')}] line=${String(bridge?.meta[BRIDGE_LINE_META])}`,
  )

  // #436 section 5: the effect is DECLARED, so the contract can audit that a MOVE
  // in this run may place blocks and which block it consumes.
  check(
    '(i) the MOVE declares mayPlaceBlocks and the consumed block (section 5 EffectEnvelope)',
    bridge !== undefined && bridge.meta.mayPlaceBlocks === true && bridge.meta.bridgeBlock === 'cobblestone' && bridge.itemName === null,
    `mayPlaceBlocks=${String(bridge?.meta.mayPlaceBlocks)} block=${String(bridge?.meta.bridgeBlock)} itemName=${String(bridge?.itemName)}`,
  )

  // The affordance gate must PRESENT it (no walkable path is needed: the bridge IS
  // the path) and the guard must accept it.
  const grounded = generateGroundedCandidates(offered, options)
  const presented = bridgeCandidates(grounded.candidates)
  const guardContext: GuardContext = {
    phase: 'decision',
    candidateIds: new Set(grounded.candidates.map((candidate) => candidate.id)),
    inFlight: null,
    reach: options.reach,
    maxCandidateAgeTicks: 40,
  }
  const verdict = presented[0] === undefined ? null : guardCandidate(presented[0], offered, guardContext)
  check(
    '(i) the gate presents the bridge and the guard accepts it without a canDig=false path',
    presented.length === 1 &&
      grounded.withheld.every((entry) => entry.candidate.meta[BRIDGE_META] !== true) &&
      verdict !== null &&
      verdict.ok === true,
    `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}] guard=${verdict === null ? 'none' : verdict.ok ? 'ok' : `${verdict.code}::${verdict.reason}`}`,
  )

  // The far cell is verified standable BEFORE the last step: walk the body across
  // with the SAME pure rule the executor uses, re-probing from every new cell, and
  // require the far side to be a verified stand on every intermediate plan (the
  // last placement is grounded on it, never on faith).
  let cursor = world.feet
  let placements = 0
  let farVerifiedBeforeLastStep = false
  const landingCells: string[] = []
  for (let step = 0; step < 8; step += 1) {
    const probe = probesFromTerrain(world.terrain, cursor)
    const decision = planBridgeRoute({
      selfFeet: cursor,
      target: world.far,
      probes: probe,
      placeable: { name: 'cobblestone', count: 381 - placements },
    })
    if (decision.plan === null) break
    if (key(cursor) === '0,64,0') farVerifiedBeforeLastStep = decision.plan.span === 3
    // The executor's own advance: the placement lands, the body occupies it.
    world.terrain.set(decision.plan.place, 'cobblestone')
    placements += 1
    cursor = decision.plan.landing
    landingCells.push(key(cursor))
  }
  check(
    '(i) the body crosses the gap one verified placement at a time, and the far cell is verified standable',
    placements === 3 &&
      landingCells.join(' ') === '1,64,0 2,64,0 3,64,0' &&
      farVerifiedBeforeLastStep &&
      // after 3 placements the body stands on the last bridged cell and the far
      // side is a verified stand exactly one ordinary walk away (the executor's
      // own final leg, proven live in fixture (vi)).
      world.terrain.standable(world.far) &&
      distance(cursor, world.far) === 1,
    `placements=${placements} landings=[${landingCells.join(' ')}] far=${key(world.far)} farStandable=${world.terrain.standable(world.far)} farVerifiedBeforeLastStep=${farVerifiedBeforeLastStep}`,
  )
}

// ===========================================================================
// (ii) no placeable block -> typed refusal, no candidate
// ===========================================================================
{
  const world = ledgeTerrain(1)
  const state = worldState({ feet: world.feet, terrain: world.terrain, counts: {}, enterCell: world.far })
  const decision = planBridgeRoute({
    selfFeet: world.feet,
    target: world.far,
    probes: state.bridgeProbes,
    placeable: null,
  })
  const refusal = decision.plan === null ? decision.refusal : null
  check(
    '(ii) with no placeable block held the planner refuses `no_block`',
    refusal !== null && refusal.reason === 'no_block',
    `plan=${decision.plan === null ? 'none' : 'present'} refusal=${refusal?.reason ?? 'none'} :: ${refusal?.detail ?? ''}`,
  )

  // The waypoint sits BEYOND the far side so the ordinary walk leg exists; the
  // typed refusal must ride the legs this offer did ground.
  const beyond: Vec3Json = { x: 5, y: 64, z: 0 }
  const crossing = ledgeTerrain(1, { ledgeTo: 6 })
  const base = worldState({ feet: crossing.feet, terrain: crossing.terrain, counts: {}, enterCell: beyond })
  const options = optionsFor({ feet: crossing.feet, terrain: crossing.terrain, enterCell: beyond })
  const spent = spendEntryRoute(base, options, beyond)
  const offered = worldState({ feet: crossing.feet, terrain: crossing.terrain, counts: {}, enterCell: beyond, routes: spent })
  const offer = entryCandidates(offered, options)
  const refusedLines = new Set(
    offer.candidates
      .map((candidate) => candidate.meta[BRIDGE_REFUSED_META])
      .filter((line): line is string => typeof line === 'string'),
  )
  check(
    '(ii) no bridge candidate is enumerated and the offer carries the typed BRIDGE_REFUSED line',
    bridgeCandidates(offer.candidates).length === 0 &&
      refusedLines.size === 1 &&
      [...refusedLines][0]?.startsWith('BRIDGE_REFUSED reason=no_block') === true,
    `offer=[${offer.candidates.map((candidate) => candidate.id).join(',')}] refusals=[${[...refusedLines].join(' | ')}]`,
  )
}

// ===========================================================================
// (iii) an unverified / lava continuation -> refuse (never strand the body)
// ===========================================================================
{
  // (a) the gap is wider than the bounded probe: no verified stand forward.
  const longGap = new Terrain()
  longGap.set({ x: 0, y: 63, z: 0 }, 'stone')
  longGap.fill(8, 10, 0, 63, 'nether_bricks')
  const longFeet: Vec3Json = { x: 0, y: 64, z: 0 }
  const longState = worldState({ feet: longFeet, terrain: longGap, counts: { cobblestone: 8 }, enterCell: { x: 9, y: 64, z: 0 } })
  const longDecision = planBridgeRoute({
    selfFeet: longFeet,
    target: { x: 9, y: 64, z: 0 },
    probes: longState.bridgeProbes,
    placeable: { name: 'cobblestone', count: 8 },
  })
  const longRefusal = longDecision.plan === null ? longDecision.refusal : null
  check(
    '(iii) a gap with no verified stand inside the bounded probe is refused `no_verified_landing`',
    longRefusal !== null && (longRefusal.reason === 'no_verified_landing' || longRefusal.reason === 'budget'),
    `refusal=${longRefusal?.reason ?? 'none'} :: ${longRefusal?.detail ?? ''}`,
  )

  // (b) the landing column would be lava: never place into it.
  const lava = new Terrain()
  lava.set({ x: 0, y: 63, z: 0 }, 'stone')
  lava.set({ x: 1, y: 63, z: 0 }, 'lava')
  lava.fill(2, 3, 0, 63, 'nether_bricks')
  const lavaState = worldState({ feet: longFeet, terrain: lava, counts: { cobblestone: 8 }, enterCell: { x: 2, y: 64, z: 0 } })
  const lavaDecision = planBridgeRoute({
    selfFeet: longFeet,
    target: { x: 2, y: 64, z: 0 },
    probes: lavaState.bridgeProbes,
    placeable: { name: 'cobblestone', count: 8 },
  })
  const lavaRefusal = lavaDecision.plan === null ? lavaDecision.refusal : null
  check(
    '(iii) a lava placement cell is refused `hazard` and never grounded',
    lavaRefusal !== null && lavaRefusal.reason === 'hazard' && lavaRefusal.block === 'lava',
    `refusal=${lavaRefusal?.reason ?? 'none'} block=${String(lavaRefusal?.block)} :: ${lavaRefusal?.detail ?? ''}`,
  )

  // (c) the far side itself is lava: the hazard inside the bounded span refuses.
  const farLava = new Terrain()
  farLava.set({ x: 0, y: 63, z: 0 }, 'stone')
  farLava.fill(2, 4, 0, 63, 'nether_bricks')
  farLava.set({ x: 1, y: 63, z: 0 }, 'lava')
  farLava.set({ x: 1, y: 64, z: 0 }, 'air')
  const farLavaState = worldState({ feet: longFeet, terrain: farLava, counts: { cobblestone: 8 }, enterCell: { x: 2, y: 64, z: 0 } })
  const farLavaDecision = planBridgeRoute({
    selfFeet: longFeet,
    target: { x: 2, y: 64, z: 0 },
    probes: farLavaState.bridgeProbes,
    placeable: { name: 'cobblestone', count: 8 },
  })
  const farLavaRefusal = farLavaDecision.plan === null ? farLavaDecision.refusal : null
  check(
    '(iii) a hazard anywhere in the bounded span refuses the bridge',
    farLavaRefusal !== null && farLavaRefusal.reason === 'hazard',
    `refusal=${farLavaRefusal?.reason ?? 'none'} :: ${farLavaRefusal?.detail ?? ''}`,
  )

  // (d) a protected cell (a live structure member) is never bridged into (U5).
  const protectedWorld = ledgeTerrain(1)
  const protectedState = worldState({ feet: protectedWorld.feet, terrain: protectedWorld.terrain, counts: { cobblestone: 8 }, enterCell: protectedWorld.far })
  const protectedDecision = planBridgeRoute({
    selfFeet: protectedWorld.feet,
    target: protectedWorld.far,
    probes: protectedState.bridgeProbes,
    placeable: { name: 'cobblestone', count: 8 },
    isProtected: (cell) => key(cell) === '1,63,0',
  })
  const protectedRefusal = protectedDecision.plan === null ? protectedDecision.refusal : null
  check(
    '(iii) a protected placement cell is refused `protected` (section 7 U5)',
    protectedRefusal !== null && protectedRefusal.reason === 'protected',
    `refusal=${protectedRefusal?.reason ?? 'none'} :: ${protectedRefusal?.detail ?? ''}`,
  )

  // (e) the bounded span budget: a verified 3-span with maxSpan=2 is refused.
  const bounded = ledgeTerrain(3)
  const boundedState = worldState({ feet: bounded.feet, terrain: bounded.terrain, counts: { cobblestone: 8 }, enterCell: bounded.far })
  const boundedDecision = planBridgeRoute({
    selfFeet: bounded.feet,
    target: bounded.far,
    probes: boundedState.bridgeProbes,
    placeable: { name: 'cobblestone', count: 8 },
    maxSpan: 2,
  })
  const boundedRefusal = boundedDecision.plan === null ? boundedDecision.refusal : null
  check(
    '(iii) a verified span wider than the bounded budget is refused `budget`',
    boundedRefusal !== null && boundedRefusal.reason === 'budget',
    `refusal=${boundedRefusal?.reason ?? 'none'} :: ${boundedRefusal?.detail ?? ''}`,
  )
}

// ===========================================================================
// (iv) ordinary walkable terrain -> byte-identical offer/actions
// ===========================================================================
{
  const flat = new Terrain()
  flat.fill(-3, 6, 0, 63, 'stone')
  flat.fill(-3, 6, 1, 63, 'stone')
  const feet: Vec3Json = { x: 0, y: 64, z: 0 }
  const far: Vec3Json = { x: 4, y: 64, z: 0 }
  const counts = { cobblestone: 381 }
  const base = worldState({ feet, terrain: flat, counts, enterCell: far })
  const options = optionsFor({ feet, terrain: flat, enterCell: far })
  const spent = spendEntryRoute(base, options, far)
  const withProbes = worldState({ feet, terrain: flat, counts, enterCell: far, routes: spent })
  const withoutProbes = worldState({ feet, terrain: flat, counts, enterCell: far, routes: spent, legacyNoProbes: true })

  const offerA = entryCandidates(withProbes, options)
  const offerB = entryCandidates(withoutProbes, options)
  const shape = (candidates: readonly Candidate[]): string =>
    JSON.stringify(candidates.map((candidate) => ({ id: candidate.id, kind: candidate.kind, meta: candidate.meta })))
  const bridgeMetaKeys = new Set(['bridge', 'bridgeDir', 'bridgeBlock', 'bridgeSpan', 'bridgeLine', 'mayPlaceBlocks', 'bridgeLanding', 'bridgePlace', 'bridgeFrom', 'bridgeTo', 'bridgeRemaining', 'bridgeAuthorityLine', 'bridgeRefusedLine'])
  const leaked = offerA.candidates.some((candidate) =>
    Object.keys(candidate.meta).some((metaKey) => bridgeMetaKeys.has(metaKey) || metaKey.startsWith('bridge')),
  )
  check(
    '(iv) ordinary walkable terrain offers no bridge, attaches no marker, and is byte-identical to the probe-less state',
    bridgeCandidates(offerA.candidates).length === 0 &&
      !leaked &&
      shape(offerA.candidates) === shape(offerB.candidates),
    `bridge=${bridgeCandidates(offerA.candidates).length} leakedMeta=${leaked} identical=${shape(offerA.candidates) === shape(offerB.candidates)} offer=[${offerA.candidates.map((candidate) => candidate.id).join(',')}]`,
  )

  // Same state, and the widened scan must not add a spot on ordinary solid ground:
  // the `dy = -1` half of the scan contributes nothing where the adjacent column's
  // floor cell is already solid.
  const spaces = flat.placementSpotsAround(feet, self(feet).eyePosition)
  const belowFeet = spaces.filter((spot) => spot.y === feet.y - 1)
  check(
    '(iv) the widened placement scan adds no dy=-1 spot on ordinary solid terrain',
    belowFeet.length === 0,
    `dyMinusOne=[${belowFeet.map(key).join(' ')}] allSpots=${spaces.length}`,
  )
}

// ===========================================================================
// (v) section 7: exactly one remedy -> MANDATORY_PREREQUISITE;
//     several remedies -> SKILL_POLICY_BOUNDARY with no code choice
// ===========================================================================
{
  // A 2-block gap whose far side sits OUTSIDE the flat 5x5x3 scan: no sensed stand
  // closes the distance to the waypoint, no dig is possible (the front cell is open
  // air), no step-over exists -> the bridge is the ONLY grounded remedy class.
  const gap2 = new Terrain()
  gap2.set({ x: 0, y: 63, z: 0 }, 'stone')
  gap2.fill(3, 6, 0, 63, 'nether_bricks')
  const feet: Vec3Json = { x: 0, y: 64, z: 0 }
  const far: Vec3Json = { x: 3, y: 64, z: 0 }
  const counts = { cobblestone: 381 }
  const base = worldState({ feet, terrain: gap2, counts, enterCell: far })
  const options = optionsFor({ feet, terrain: gap2, enterCell: far })
  const spent = spendEntryRoute(base, options, far)
  const unique = worldState({ feet, terrain: gap2, counts, enterCell: far, routes: spent })
  const uniqueOffer = entryCandidates(unique, options)
  const uniqueBridge = bridgeCandidates(uniqueOffer.candidates)[0]
  const reflex = typeof uniqueBridge?.meta.legReflex === 'string' ? uniqueBridge.meta.legReflex : ''
  const authority = typeof uniqueBridge?.meta[BRIDGE_AUTHORITY_META] === 'string' ? (uniqueBridge.meta[BRIDGE_AUTHORITY_META] as string) : ''
  check(
    '(v) the UNIQUE remedy executes as a section 7 prerequisite: MANDATORY_PREREQUISITE + REFLEX proof',
    uniqueBridge !== undefined &&
      reflex.startsWith('REFLEX ownerSkill=') &&
      reflex.includes('reason=unique_binding_prerequisite') &&
      reflex.includes('action=bridge') &&
      reflex.includes('gap@1,64,0:no_support') &&
      reflex.includes('far@3,64,0:standable') &&
      authority.startsWith('authority=MANDATORY_PREREQUISITE') &&
      authority.includes('budget=2') &&
      uniqueBridge.meta.legPolicyBoundary === undefined,
    `bridge=${uniqueBridge?.id ?? 'none'} reflex="${reflex}" authority="${authority}" boundary=${String(uniqueBridge?.meta.legPolicyBoundary ?? 'none')}`,
  )

  // A 1-block gap whose far side IS a sensed stand (2 cells away, inside the flat
  // scan): the walk leg and the bridge are both grounded, so code must stop at the
  // boundary and name both classes instead of choosing.
  const gap1 = ledgeTerrain(1, { bed: true, ledgeTo: 6 })
  const multiTarget: Vec3Json = { x: 5, y: 64, z: 0 }
  const multiBase = worldState({ feet: gap1.feet, terrain: gap1.terrain, counts, enterCell: multiTarget })
  const multiOptions = optionsFor({ feet: gap1.feet, terrain: gap1.terrain, enterCell: multiTarget })
  const multiSpent = spendEntryRoute(multiBase, multiOptions, multiTarget)
  const multi = worldState({ feet: gap1.feet, terrain: gap1.terrain, counts, enterCell: multiTarget, routes: multiSpent })
  const multiOffer = entryCandidates(multi, multiOptions)
  const multiBridge = bridgeCandidates(multiOffer.candidates)[0]
  const boundary = typeof multiBridge?.meta.legPolicyBoundary === 'string' ? (multiBridge.meta.legPolicyBoundary as string) : ''
  const multiAuthority = typeof multiBridge?.meta[BRIDGE_AUTHORITY_META] === 'string' ? (multiBridge.meta[BRIDGE_AUTHORITY_META] as string) : ''
  check(
    '(v) bridge + walk both grounded -> SKILL_POLICY_BOUNDARY names both classes and code does not choose',
    multiBridge !== undefined &&
      boundary.startsWith('SKILL_POLICY_BOUNDARY skill=') &&
      boundary.includes('reason=multiple_non_equivalent_recoveries') &&
      boundary.includes('movement:walk') &&
      boundary.includes('place:bridge') &&
      multiBridge.meta.legReflex === undefined &&
      multiAuthority.startsWith('authority=MECHANICAL_CONTINUATION'),
    `bridge=${multiBridge?.id ?? 'none'} boundary="${boundary}" authority="${multiAuthority}" reflex=${String(multiBridge?.meta.legReflex ?? 'none')}`,
  )

  // The tower alternative is named only when the ONE vertical planner proves an
  // ascent is available for this leg target.
  const highTarget: Vec3Json = { x: 3, y: 70, z: 0 }
  const highBase = worldState({ feet, terrain: gap2, counts, enterCell: highTarget })
  const highOptions = optionsFor({ feet, terrain: gap2, enterCell: highTarget })
  const highSpent = spendEntryRoute(highBase, highOptions, highTarget)
  const high = worldState({ feet, terrain: gap2, counts, enterCell: highTarget, routes: highSpent })
  const highOffer = entryCandidates(high, highOptions)
  const highBridge = bridgeCandidates(highOffer.candidates)[0]
  const highBoundary = typeof highBridge?.meta.legPolicyBoundary === 'string' ? (highBridge.meta.legPolicyBoundary as string) : ''
  check(
    '(v) a grounded tower is surfaced as an alternative (place:pillar) when an ascent really exists',
    highBridge !== undefined && highBoundary.includes('place:pillar') && highBoundary.includes('place:bridge'),
    `boundary="${highBoundary}" offer=[${highOffer.candidates.map((candidate) => candidate.id).join(',')}]`,
  )
}

// ===========================================================================
// (viii) a blocked locomotion target (any goal, not a portal leg): the bridge is a
//        general MOVE remedy, offered through the route-opening family
// ===========================================================================
{
  // A bottomless 1-cell gap between the body and the goal cell: the goal's own MOVE
  // is withheld `no_path`, so the route-opening family runs for the blocked target.
  const world = ledgeTerrain(1, { ledgeTo: 6 })
  const target: Vec3Json = { x: 5, y: 64, z: 0 }
  const counts = { cobblestone: 381 }
  const state = worldState({ feet: world.feet, terrain: world.terrain, counts, current: queuedGoto(target) })
  const options = optionsFor({ feet: world.feet, terrain: world.terrain, current: queuedGoto(target) })
  const grounded = generateGroundedCandidates(state, options)
  const bridge = bridgeCandidates(grounded.candidates)[0]
  const withheldGoto = grounded.withheld.find((entry) => entry.candidate.kind === 'MOVE')
  check(
    '(viii) a blocked GOTO across a void gap grounds the bridge as an ordinary MOVE remedy',
    bridge !== undefined &&
      bridge.target !== null &&
      key(bridge.target) === '2,64,0' &&
      bridge.meta[BRIDGE_META] === true &&
      bridge.meta[BRIDGE_MAY_PLACE_META] === true &&
      bridge.meta.approachLeg === 'route_withheld' &&
      typeof bridge.meta[BRIDGE_AUTHORITY_META] === 'string' &&
      (bridge.meta[BRIDGE_AUTHORITY_META] as string).startsWith('authority=MECHANICAL_CONTINUATION') &&
      bridge.meta.legContinuationSkill === undefined &&
      withheldGoto !== undefined,
    `offer=[${grounded.candidates.map((candidate) => candidate.id).join(',')}] withheld=[${grounded.withheld.map((entry) => entry.candidate.id).join(',')}] target=${bridge?.target === null || bridge?.target === undefined ? 'none' : key(bridge.target)}`,
  )
}

// ===========================================================================
// (vi) the executor: cross the gap, and a mid-bridge interruption leaves the body
//      standing safely with a typed end
// ===========================================================================
const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')

interface CapturedLog {
  source: string
  message: string
  detail: Record<string, unknown>
}

function makeCapturingLogger(logs: CapturedLog[]): EventLogger {
  const writer = {
    write: (record: { source?: string; message?: string; detail?: Record<string, unknown> }): void => {
      if (typeof record.message !== 'string') return
      logs.push({ source: record.source ?? 'unknown', message: record.message, detail: record.detail ?? {} })
    },
  } as unknown as JsonlWriter
  return new EventLogger(writer, false)
}

/** The Vec3 shape mineflayer hands the sensor/executor (`set`/`clone`/`offset`). */
class Vec {
  constructor(
    public x: number,
    public y: number,
    public z: number,
  ) {}
  set(x: number, y: number, z: number): this {
    this.x = x
    this.y = y
    this.z = z
    return this
  }
  clone(): Vec {
    return new Vec(this.x, this.y, this.z)
  }
  offset(x: number, y: number, z: number): Vec {
    return new Vec(this.x + x, this.y + y, this.z + z)
  }
  distanceTo(other: { x: number; y: number; z: number }): number {
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
  }
}

/** A live-shaped fake body over a MUTABLE `Terrain`, with a server-like placement. */
function makeBridgeBot(
  terrain: Terrain,
  feet: Vec3Json,
  counts: Record<string, number>,
  hooks: { onPlace?: () => Promise<void> | void } = {},
): { bot: Bot; position: Vec; terrain: Terrain; logs: CapturedLog[] } {
  const position = new Vec(feet.x + 0.5, feet.y, feet.z + 0.5)
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const emit = (event: string, payload?: unknown): void => {
    for (const handler of [...(listeners.get(event) ?? [])]) handler(payload)
  }
  const items = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  const bot: Record<string, unknown> = {
    registry,
    entity: {
      position,
      yaw: 0,
      pitch: 0,
      onGround: true,
      isCollidedHorizontally: false,
      width: 0.6,
      height: 1.8,
      offset: (x: number, y: number, z: number): Vec => position.offset(x, y, z),
      // `position.clone()` is what the SENSOR's probe uses as its read scratch
      // (`state.ts#probeBridgeDirection`); `clone().set(...)` builds a face vector
      // and must never move the body.
      clone: (): Vec => position.clone(),
      distanceTo: (other: { x: number; y: number; z: number }): number => position.distanceTo(other),
    },
    _client: { write: (): boolean => true },
    physicsEnabled: true,
    entities: {},
    heldItem: null as { name: string; count: number; slot: number } | null,
    inventory: {
      items: (): Array<{ name: string; count: number; slot: number }> => items,
      count: (name: string): number => items.find((item) => item.name === name)?.count ?? 0,
    },
    blockAt: (v: { x: number; y: number; z: number }): { name: string; boundingBox: string; position: Vec3Json } | null => {
      const cell = { x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) }
      const name = terrain.name(cell)
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: cell }
    },
    canDigBlock: (): boolean => true,
    equip: async (item: { name: string; count: number; slot: number }): Promise<void> => {
      bot.heldItem = item
    },
    placeBlock: async (reference: { position: Vec3Json }, face: { x: number; y: number; z: number }): Promise<void> => {
      // The server's own rule, modelled: the block lands in the cell the clicked
      // face points at.
      const target = {
        x: reference.position.x + face.x,
        y: reference.position.y + face.y,
        z: reference.position.z + face.z,
      }
      if (hooks.onPlace !== undefined) await hooks.onPlace()
      terrain.set(target, 'cobblestone')
    },
    on: (event: string, handler: (...args: unknown[]) => void): unknown => {
      const set = listeners.get(event) ?? []
      set.push(handler)
      listeners.set(event, set)
      return bot
    },
    removeListener: (event: string, handler: (...args: unknown[]) => void): unknown => {
      const set = listeners.get(event) ?? []
      listeners.set(event, set.filter((entry) => entry !== handler))
      return bot
    },
    setControlState: (): void => undefined,
    lookAt: async (): Promise<void> => undefined,
    stopDigging: (): void => undefined,
    pathfinder: {
      movements: null as unknown,
      setMovements: (movements: unknown): void => {
        ;(bot.pathfinder as { movements: unknown }).movements = movements
      },
      setGoal: (goal: unknown): void => {
        if (goal === null || goal === undefined) return
        const asCell = goal as { x?: number; y?: number; z?: number }
        if (typeof asCell.x !== 'number' || typeof asCell.y !== 'number' || typeof asCell.z !== 'number') return
        position.x = asCell.x + 0.5
        position.y = asCell.y
        position.z = asCell.z + 0.5
        emit('goal_reached')
      },
      stop: (): void => undefined,
      getPathTo: (): { status: string; path: unknown[] } => ({ status: 'success', path: [] }),
    },
  }
  const logs: CapturedLog[] = []
  return { bot: bot as unknown as Bot, position, terrain, logs }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return predicate()
}

function bridgeCandidateFor(plan: { dir: BridgeDir; landing: Vec3Json; far: Vec3Json; place: Vec3Json; span: number; block: string; remaining: number }, tick = 9): Candidate {
  return {
    id: `BRIDGE:${plan.dir}:p${plan.landing.x}_${plan.landing.y}_${plan.landing.z}`,
    kind: 'MOVE',
    label: `bridge ${plan.dir} to (${key(plan.far)})`,
    targetName: null,
    target: plan.far,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: {
      tick,
      x: plan.far.x,
      y: plan.far.y,
      z: plan.far.z,
      bridge: true,
      bridgeDir: plan.dir,
      bridgeBlock: plan.block,
      bridgeSpan: plan.span,
      bridgeTarget: key(plan.far),
      bridgeLanding: key(plan.landing),
      bridgePlace: key(plan.place),
      mayPlaceBlocks: true,
      bridgeLine: formatBridgeStart({ cell: plan.landing, block: plan.block, span: plan.span, remaining: plan.remaining }),
    },
  }
}

// (vi-a) the happy path: the real executor places and advances until it stands on
// the verified far side.
{
  const world = ledgeTerrain(3)
  const { bot, position } = makeBridgeBot(world.terrain, world.feet, { cobblestone: 381 })
  const logs: CapturedLog[] = []
  const executor = new Executor(bot, makeCapturingLogger(logs), {
    ...defaultExecutorOptions,
    actuation: 'pathfinder',
    pathTimeoutMs: 60,
    packetStepMs: 0,
  })
  const plan = {
    dir: 'E' as BridgeDir,
    landing: { x: 1, y: 64, z: 0 },
    place: { x: 1, y: 63, z: 0 },
    far: world.far,
    span: 3,
    block: 'cobblestone',
    remaining: 378,
  }
  executor.claim(bridgeCandidateFor(plan))
  const done = await waitFor(() => logs.some((line) => line.message.startsWith('BRIDGE_END')))
  executor.cancelCurrent('bridge fixture complete')
  const steps = logs.filter((line) => line.message.startsWith('BRIDGE_STEP'))
  const end = logs.find((line) => line.message.startsWith('BRIDGE_END'))?.message ?? 'none'
  const start = logs.find((line) => line.message.startsWith('BRIDGE_START'))?.message ?? 'none'
  const bodyCell = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
  check(
    '(vi) the executor bridges the 3-gap and ends standing on the verified far side',
    done &&
      start === 'BRIDGE_START cell=1,64,0 block=cobblestone span=3 remaining=378' &&
      steps.length === 3 &&
      steps[0]?.message === 'BRIDGE_STEP from=0,64,0 to=1,64,0 block=cobblestone' &&
      steps[2]?.message === 'BRIDGE_STEP from=2,64,0 to=3,64,0 block=cobblestone' &&
      end === 'BRIDGE_END placed=3 verified=true reason=reached' &&
      // the crossing ENDS on the far side: the last (placement-free) step is the
      // ordinary adjacent walk onto the already-verified stand.
      key(bodyCell) === '4,64,0' &&
      world.terrain.name({ x: 1, y: 63, z: 0 }) === 'cobblestone' &&
      world.terrain.name({ x: 2, y: 63, z: 0 }) === 'cobblestone' &&
      world.terrain.name({ x: 3, y: 63, z: 0 }) === 'cobblestone',
    `start="${start}" steps=${steps.length} [${steps.map((line) => line.message).join(' | ')}] end="${end}" body=${key(bodyCell)}`,
  )
}

// (vi-c) SELF-LANDING over a VOID: the offer grounds only as "this step CREATES its
// own floor and steps onto it" (no far bank within the probe depth). The executor's
// live re-probe must carry the SAME placement identity the offer used, or the rule
// answers its historical `no_verified_landing` and the crossing can never place a
// single block - which is exactly the unsupported span between a ledge and a
// floated gate.
{
  // A single floor cell under the body and nothing else: every direction is a
  // bottomless void, so no span can end on a verified far side within depth 4.
  // The probe is the REAL sensor (`probeBridgeDirection`), because the self-landing
  // branch is grounded on the pocket's own face-adjacency flood read, which only
  // the sensor fills (`state.ts:4130-4148`).
  const terrain = new Terrain()
  terrain.set({ x: 0, y: 63, z: 0 }, 'stone')
  const feet: Vec3Json = { x: 0, y: 64, z: 0 }
  const target: Vec3Json = { x: 2, y: 64, z: 0 }
  const placeable = { name: 'cobblestone', count: 8 }
  const { bot, position } = makeBridgeBot(terrain, feet, { cobblestone: 8 })
  const probes = (['E', 'W', 'N', 'S'] as BridgeDir[]).map((dir) =>
    probeBridgeDirection(bot, feet, dir, BRIDGE_PROBE_DEPTH),
  )
  const offered = planBridgeRoute({ selfFeet: feet, target, probes, placeable })
  check(
    '(vi-c) over a void the offer grounds a SELF-LANDING span of one cell, naming the block that becomes the floor',
    offered.plan !== null &&
      offered.plan.selfLanding === true &&
      offered.plan.span === 1 &&
      offered.plan.dir === 'E' &&
      offered.plan.line.includes('self_landing=true'),
    offered.plan === null
      ? `refusal=${offered.refusal.reason} detail=${offered.refusal.detail}`
      : `span=${offered.plan.span} dir=${offered.plan.dir} selfLanding=${String(offered.plan.selfLanding)} line="${offered.plan.line}"`,
  )
  if (offered.plan !== null) {
    const plan = offered.plan
    const logs: CapturedLog[] = []
    const executor = new Executor(bot, makeCapturingLogger(logs), {
      ...defaultExecutorOptions,
      actuation: 'pathfinder',
      pathTimeoutMs: 60,
      packetStepMs: 0,
    })
    executor.claim({
      ...bridgeCandidateFor(plan),
      meta: { ...bridgeCandidateFor(plan).meta, bridgeSelfLanding: true },
    })
    const done = await waitFor(() => logs.some((line) => line.message.startsWith('BRIDGE_END') || line.message.startsWith('BRIDGE_REFUSED')))
    executor.cancelCurrent('bridge self-landing fixture complete')
    const placed = logs.find((line) => line.message.includes('step=place'))?.message ?? 'none'
    const refused = logs.find((line) => line.message.startsWith('BRIDGE_REFUSED'))?.message ?? 'none'
    // The floor this step creates IS the crossing's safety fact, so the proof is
    // the world: the block landed in the void cell the plan named, and the live
    // re-probe did NOT answer its historical `no_verified_landing`.
    check(
      '(vi-c) the executor EXECUTES the self-landing scaffold: the void floor cell is filled, no no_verified_landing refusal',
      done &&
        refused === 'none' &&
        placed.includes('place=1,63,0 item=cobblestone') &&
        terrain.name({ x: 1, y: 63, z: 0 }) === 'cobblestone',
      `refused="${refused}" placed=[${placed}] placedFloor=${terrain.name({ x: 1, y: 63, z: 0 })}`,
    )
  }
}

// (vi-b) a mid-bridge interruption (the lease is revoked while the SECOND block is
// being placed) leaves the body standing on the first VERIFIED placement - its own
// block over a bottomless gap - with a typed end, never over air.
{
  const world = ledgeTerrain(3)
  let placeCalls = 0
  let holdArmed = false
  let releaseHold: () => void = () => undefined
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve
  })
  const { bot, position } = makeBridgeBot(world.terrain, world.feet, { cobblestone: 381 }, {
    onPlace: async (): Promise<void> => {
      placeCalls += 1
      // The FIRST placement is allowed to complete (so the body really stands on
      // its own block over the void); the SECOND is held open while the test
      // revokes the lease.
      if (placeCalls === 2) {
        holdArmed = true
        await hold
      }
    },
  })
  const logs: CapturedLog[] = []
  const executor = new Executor(bot, makeCapturingLogger(logs), {
    ...defaultExecutorOptions,
    actuation: 'pathfinder',
    pathTimeoutMs: 60,
    packetStepMs: 0,
  })
  const plan = {
    dir: 'E' as BridgeDir,
    landing: { x: 1, y: 64, z: 0 },
    place: { x: 1, y: 63, z: 0 },
    far: world.far,
    span: 3,
    block: 'cobblestone',
    remaining: 378,
  }
  executor.claim(bridgeCandidateFor(plan))
  const armed = await waitFor(() => holdArmed)
  executor.cancelCurrent('bridge interruption fixture')
  releaseHold()
  const ended = await waitFor(() => logs.some((line) => line.message.startsWith('BRIDGE_END')))
  const end = logs.find((line) => line.message.startsWith('BRIDGE_END'))?.message ?? 'none'
  const steps = logs.filter((line) => line.message.startsWith('BRIDGE_STEP')).length
  const bodyCell = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
  const supportCell = { x: bodyCell.x, y: bodyCell.y - 1, z: bodyCell.z }
  const support = world.terrain.name(supportCell)
  check(
    '(vi) a mid-bridge interruption ends typed and leaves the body standing on its own placed block (never over air)',
    armed &&
      ended &&
      steps === 1 &&
      /^BRIDGE_END placed=1 verified=false reason=(interrupted|aborted|advance_failed|no_progress)$/.test(end) &&
      key(bodyCell) === '1,64,0' &&
      support === 'cobblestone',
    `steps=${steps} end="${end}" body=${key(bodyCell)} support=${support}`,
  )
}

// ===========================================================================
// (ix) section 5 EffectEnvelope: the SELECTION declares the bridge's place/equip
//      authority, and a plain walk still declares neither (fail closed)
// ===========================================================================
{
  const world = ledgeTerrain(3)
  const counts = { cobblestone: 381 }
  const state = worldState({ feet: world.feet, terrain: world.terrain, counts, enterCell: world.far })
  const bridge = bridgeCandidateFor(
    {
      dir: 'E',
      landing: { x: 1, y: 64, z: 0 },
      place: { x: 1, y: 63, z: 0 },
      far: world.far,
      span: 3,
      block: 'cobblestone',
      remaining: 378,
    },
    state.tick,
  )
  // every declared meta key the envelope reads comes from the real offer path too
  const offered = (() => {
    const options = optionsFor({ feet: world.feet, terrain: world.terrain, enterCell: world.far })
    const spent = spendEntryRoute(state, options, world.far)
    const tick = worldState({ feet: world.feet, terrain: world.terrain, counts, enterCell: world.far, routes: spent })
    return bridgeCandidates(entryCandidates(tick, options).candidates)[0]
  })()
  const envelope = envelopeForCandidate(bridge, { equipItems: [] })
  const offeredEnvelope = offered === undefined ? null : envelopeForCandidate(offered, { equipItems: [] })
  const placed = { x: 1, y: 63, z: 0 }
  check(
    '(ix) the selected bridge declares mayPlaceGroundedRoute + the exact first cell and block to equip',
    envelope.mayPlaceGroundedRoute === true &&
      (envelope.mayPlaceBlocks ?? []).some((entry) => entry.itemName === 'cobblestone' && key(entry.position) === '1,63,0') &&
      (envelope.mayEquipItems ?? []).includes('cobblestone') &&
      (envelope.mayDigBlocks ?? []).length === 0 &&
      effectViolation(envelope, { type: 'place', position: placed, itemName: 'cobblestone' }) === null &&
      effectViolation(envelope, { type: 'equip', itemName: 'cobblestone', destination: 'hand' }) === null &&
      offeredEnvelope !== null &&
      offeredEnvelope.mayPlaceGroundedRoute === true &&
      (offeredEnvelope.mayEquipItems ?? []).includes('cobblestone'),
    `placeRoute=${String(envelope.mayPlaceGroundedRoute)} cells=${JSON.stringify(envelope.mayPlaceBlocks)} equip=${JSON.stringify(envelope.mayEquipItems)} offeredRoute=${String(offeredEnvelope?.mayPlaceGroundedRoute)}`,
  )
  const plain: Candidate = {
    ...bridge,
    id: 'MOVE:p2_64_0',
    meta: { tick: state.tick, x: 2, y: 64, z: 0 },
  }
  const plainEnvelope = envelopeForCandidate(plain, { equipItems: [] })
  check(
    '(ix) a plain walk still declares no place authority and fails closed on a placement',
    plainEnvelope.mayPlaceGroundedRoute !== true &&
      (plainEnvelope.mayPlaceBlocks ?? []).length === 0 &&
      (plainEnvelope.mayEquipItems ?? []).length === 0 &&
      effectViolation(plainEnvelope, { type: 'place', position: placed, itemName: 'cobblestone' }) ===
        'place_cell_not_declared:1,63,0' &&
      effectViolation(plainEnvelope, { type: 'equip', itemName: 'cobblestone', destination: 'hand' }) ===
        'equip_item_not_declared:cobblestone',
    `placeRoute=${String(plainEnvelope.mayPlaceGroundedRoute)} placeViolation=${effectViolation(plainEnvelope, { type: 'place', position: placed, itemName: 'cobblestone' })} equipViolation=${effectViolation(plainEnvelope, { type: 'equip', itemName: 'cobblestone', destination: 'hand' })}`,
  )
}

// ===========================================================================
// (vii) the controller wiring: every new marker is MIRRORED, and the mirrored set
//       is what reaches the host log (unmirrored markers never arrive).
// ===========================================================================
{
  const controllerSource = readFileSync(new URL('./src/controller-legacy.ts', import.meta.url), 'utf8')
  const candidatesSource = readFileSync(new URL('./src/candidates.ts', import.meta.url), 'utf8')
  const executorSource = readFileSync(new URL('./src/executor.ts', import.meta.url), 'utf8')
  check(
    '(vii) the markers are registered on the controller mirrored path',
    ['BRIDGE_START', 'BRIDGE_STEP', 'BRIDGE_END', 'BRIDGE_REFUSED'].every((marker) => MIRRORED_MARKERS.has(marker)),
    `mirrored=${['BRIDGE_START', 'BRIDGE_STEP', 'BRIDGE_END', 'BRIDGE_REFUSED'].map((marker) => `${marker}:${MIRRORED_MARKERS.has(marker)}`).join(' ')}`,
  )
  check(
    '(vii) the bridge is enumerated beside the walk leg / dig route, never as a fallback',
    /const bridge = groundBridgeLeg\(state, options, spec, walkable\)/.test(candidatesSource) &&
      // and grounded in the route-opening family too, so it is a general MOVE
      // remedy for ANY blocked locomotion target rather than a portal-leg trick
      /const bridge = groundBridgeLeg\(state, options, \{ target: goalTarget, targetName: null \}, false\)/.test(candidatesSource) &&
      /'place:bridge'/.test(candidatesSource) &&
      /remedyClasses.length > 1/.test(candidatesSource),
    `legFamily=${/groundBridgeLeg\(state, options, spec, walkable\)/.test(candidatesSource)} routeOpening=${/target: goalTarget, targetName: null \}, false\)/.test(candidatesSource)} boundary=${/remedyClasses/.test(candidatesSource)}`,
  )
  check(
    '(vii) the executor dispatches a bridge MOVE to the bounded bridge leg before the walk',
    /if \(isBridgeMove\(candidate\)\) return await this\.runBridge\(candidate, epoch, signal, startedAt\)/.test(executorSource),
    `dispatch=${/if \(isBridgeMove\(candidate\)\) return await this\.runBridge/.test(executorSource)}`,
  )
  check(
    '(vii) the offered refusal reaches the mirrored path',
    /this\.logBridgeRefusals\(grounded\.candidates, grounded\.withheld\.map\(\(entry\) => entry\.candidate\)\)/.test(controllerSource) &&
      /private logBridgeRefusals/.test(controllerSource) &&
      /private logBridgeAuthority/.test(controllerSource),
    `call=${/this\.logBridgeRefusals\(/.test(controllerSource)} method=${/private logBridgeRefusals/.test(controllerSource)}`,
  )
}


/**
 * The REAL sensor's four bounded probes for a body on this terrain: the scaffold's
 * own safety fact (the pocket's face-adjacency flood read) exists only in the
 * sensor's output (`state.ts#probeBridgeDirection`), so a fixture that grounds a
 * scaffold must feed it - a hand-built probe keeps the historical
 * `no_verified_landing` verdict, by design.
 */
function realProbes(terrain: Terrain, feet: Vec3Json): BridgeProbe[] {
  const { bot } = makeBridgeBot(terrain, feet, { cobblestone: 177 })
  return (['E', 'W', 'N', 'S'] as BridgeDir[]).map((dir) => probeBridgeDirection(bot, feet, dir, BRIDGE_PROBE_DEPTH))
}

/** The same state as `worldState`, with the sensor's own probes wired in. */
function scaffoldState(spec: WorldSpec, probes: BridgeProbe[] = realProbes(spec.terrain, spec.feet)): WorldState {
  const state = worldState({ ...spec, legacyNoProbes: true })
  ;(state as { bridgeProbes?: BridgeProbe[] }).bridgeProbes = probes
  return state
}

/** The options a live decision uses for a withheld locomotion target. */
function crossingOptions(spec: WorldSpec): CandidateOptions {
  return { ...optionsFor(spec), reachability: { pathProbe: () => 'no_path' } }
}

// ===========================================================================
// (x) THE GENERAL MOVE CASE: a plain MOVE whose target needs a span crossed.
//
// LIVE WITNESS (the operator's floated gate, run 38cbb22): the body stood on an
// island at `(20.7,67.0,2.7)` with `MOVE:p22_66_4` (and `MOVE:p23_65_7`) withheld
// `no_path missing=[open_path]`, the offer down to `MOVE | WAIT | ESCALATE`, and
// `CANDIDATE_STARVATION presented=1 productive=0`. Decoded from the save
// (`r.0.0.mca` chunk (1,0)): the body's landmass and the gate's landmass are
// separated by AIR at the body's own level, with a furnace head-blocking the one
// cardinal step. The crossing is the mechanism that answers exactly this, and it
// is grounded for ANY blocked locomotion target through the capability-acquisition
// family (`candidates.ts#routeOpeningCandidates` -> `groundBridgeLeg`).
//
// Two measured DEFECTS in that path, both fixed and both pinned here:
//   * rule 7 refused a whole DIRECTION when the probe's verified far bank did not
//     reduce distance, even though the bounded ONE-CELL scaffold toward the same
//     target did (`BRIDGE_REFUSED reason=budget ... does not close distance
//     (1.41m -> 3.16m)` in the live log). The scaffold is now tried first, under
//     the SAME pocket guards, and says so: `cause=far_bank_no_reduction`.
//   * the route gate `moveAdvancesTowardTarget` compared the candidate's CELL
//     against the body's FRACTIONAL position, so a grounded one-cell step was
//     dropped whenever the body did not stand at its cell's centre.
// ===========================================================================

/** The measured shape: two landmasses with a void at the body's OWN level. */
function twoLandmasses(gap: number): { terrain: Terrain; feet: Vec3Json; target: Vec3Json } {
  const feet: Vec3Json = { x: 0, y: 64, z: 0 }
  const terrain = new Terrain()
  terrain.fill(-3, 0, 0, 63, 'stone')
  terrain.fill(1 + gap, 12, 0, 63, 'stone')
  return { terrain, feet, target: { x: 1 + gap + 4, y: 64, z: 0 } }
}

{
  // (x-a) THE PARENT'S SHAPE: a 3-wide void at the body's own level, the target
  // 8 m across, cobblestone in hand. The crossing must be OFFERED as an ordinary
  // MOVE beside the withheld target - Jev chooses, code does not.
  const world = twoLandmasses(3)
  const spec: WorldSpec = {
    feet: world.feet,
    terrain: world.terrain,
    counts: { cobblestone: 177 },
    current: queuedGoto(world.target),
  }
  const state = worldState(spec)
  const grounded = generateGroundedCandidates(state, optionsFor(spec))
  const bridge = bridgeCandidates(grounded.candidates)[0]
  const withheldGoto = grounded.withheld.find((entry) => entry.candidate.target !== null && key(entry.candidate.target) === key(world.target))
  // DIAGNOSTIC (kept as evidence): what the plan rule and the gate each said.
  const diagPlan = planBridgeRoute({ selfFeet: world.feet, target: world.target, probes: probesFromTerrain(world.terrain, world.feet), placeable: { name: 'cobblestone', count: 177 } })
  const diag = `plan=${diagPlan.plan === null ? `REFUSED:${diagPlan.refusal.reason}` : `dir=${diagPlan.plan.dir},span=${diagPlan.plan.span},far=${key(diagPlan.plan.far)}`} missing=[${grounded.withheld.map((e) => `${e.candidate.id}:${e.result.missingCapabilities.map((c) => c.kind).join('|')}`).join(' ')}]`
  check(
    '(x-a) a plain MOVE across a 3-wide void offers the bounded crossing (3 placements, verified far bank) beside the withheld target',
    bridge !== undefined &&
      bridge.kind === 'MOVE' &&
      bridge.target !== null &&
      key(bridge.target) === '4,64,0' &&
      bridge.meta[BRIDGE_DIR_META] === 'E' &&
      bridge.meta[BRIDGE_SPAN_META] === 3 &&
      bridge.meta.bridgePlace === '1,63,0' &&
      bridge.meta[BRIDGE_MAY_PLACE_META] === true &&
      String(bridge.meta[BRIDGE_LINE_META]) === 'BRIDGE_START cell=1,64,0 block=cobblestone span=3 remaining=174' &&
      withheldGoto !== undefined,
    `offer=[${grounded.candidates.map((c) => c.id).join(',')}] withheld=[${grounded.withheld.map((e) => e.candidate.id).join(',')}] ${diag} bridge=${bridge?.id ?? 'none'} target=${bridge?.target === null || bridge?.target === undefined ? 'none' : key(bridge.target)} span=${String(bridge?.meta[BRIDGE_SPAN_META])} line="${String(bridge?.meta[BRIDGE_LINE_META] ?? 'none')}"`,
  )
}

{
  // (x-b) A VOID WIDER THAN THE PROBE DEPTH: no far bank exists inside 4 cells, so
  // the offer is the SELF-LANDING scaffold - the step that creates the floor of the
  // cell it occupies - and the next decision re-grounds from the new cell.
  const world = twoLandmasses(5)
  const spec: WorldSpec = {
    feet: world.feet,
    terrain: world.terrain,
    counts: { cobblestone: 177 },
    current: queuedGoto(world.target),
  }
  // The scaffold's safety fact is the pocket's own face-adjacency flood read, which
  // only the REAL sensor fills (`state.ts#probeBridgeDirection`), so this state is
  // wired with it rather than with the hand-built probe helper.
  const grounded = generateGroundedCandidates(scaffoldState(spec), crossingOptions(spec))
  const bridge = bridgeCandidates(grounded.candidates)[0]
  check(
    '(x-b) a void wider than the probe depth offers the SELF-LANDING scaffold (span 1, its own floor), never a bare refusal',
    bridge !== undefined &&
      bridge.meta[BRIDGE_SPAN_META] === 1 &&
      bridge.meta.bridgeSelfLanding === true &&
      bridge.meta.bridgePlace === '1,63,0' &&
      bridge.meta.bridgeLanding === '1,64,0' &&
      String(bridge.meta[BRIDGE_LINE_META]).includes('self_landing=true pocket='),
    `bridge=${bridge?.id ?? 'none'} span=${String(bridge?.meta[BRIDGE_SPAN_META])} self=${String(bridge?.meta.bridgeSelfLanding)} line="${String(bridge?.meta[BRIDGE_LINE_META] ?? 'none')}"`,
  )
}

{
  // (x-c) THE RULE-7 FALLBACK (the live `does not close distance` refusal): the
  // void is at the body's own level, but the probe's verified far bank lies BEYOND
  // the target, so the full span is useless while the one-cell step toward the
  // target is not. The bounded scaffold is grounded and NAMES its cause.
  const feet: Vec3Json = { x: 0, y: 64, z: 0 }
  const terrain = new Terrain()
  terrain.fill(-3, 0, 0, 63, 'stone')
  terrain.fill(4, 12, 0, 63, 'stone')
  const target: Vec3Json = { x: 2, y: 65, z: 1 } // one up + diagonal: the far bank (4,64,0) is no closer
  const spec: WorldSpec = { feet, terrain, counts: { cobblestone: 177 }, current: queuedGoto(target) }
  const probes = realProbes(terrain, feet)
  const grounded = generateGroundedCandidates(scaffoldState(spec, probes), crossingOptions(spec))
  const bridge = bridgeCandidates(grounded.candidates)[0]
  // The CONTROL: the direction AWAY from the target is still refused `budget`, so
  // the fallback never turns a useless direction into an offered step.
  const backwards = planBridgeRoute({ selfFeet: feet, target: { x: -6, y: 64, z: 0 }, probes, placeable: { name: 'cobblestone', count: 177 } })
  check(
    '(x-c) when the verified far bank does not reduce distance, the bounded one-cell scaffold is offered with cause=far_bank_no_reduction',
    bridge !== undefined &&
      bridge.meta[BRIDGE_SPAN_META] === 1 &&
      bridge.meta.bridgeSelfLanding === true &&
      bridge.meta.bridgePlace === '1,63,0' &&
      String(bridge.meta[BRIDGE_LINE_META]).includes('cause=far_bank_no_reduction') &&
      backwards.plan === null &&
      backwards.refusal.reason === 'budget',
    `bridge=${bridge?.id ?? 'none'} line="${String(bridge?.meta[BRIDGE_LINE_META] ?? 'none')}" backwards=${backwards.plan === null ? backwards.refusal.reason : 'GROUNDED'}`,
  )
}

{
  // (x-d) THE ADVANCE PREDICATE: the body stands PAST its cell's centre (the live
  // sub-cell shape) with the target one cell over. The grounded scaffold must
  // survive the route gate - the historical fractional comparison dropped it.
  const feet: Vec3Json = { x: 0, y: 64, z: 0 }
  const terrain = new Terrain()
  terrain.set({ x: 0, y: 63, z: 0 }, 'stone')
  const target: Vec3Json = { x: 2, y: 64, z: 2 }
  const spec: WorldSpec = { feet, terrain, counts: { cobblestone: 177 }, current: queuedGoto(target) }
  const probes = realProbes(terrain, feet)
  const state = scaffoldState(spec, probes)
  // the body at its cell's far edge, as the live HEARTBEAT showed (20.7 / 2.7 in cell 20 / 2)
  ;(state.self as { position: Vec3Json }).position = { x: 0.9, y: 64, z: 0.9 }
  ;(state.self as { eyePosition: Vec3Json }).eyePosition = { x: 0.9, y: 65.62, z: 0.9 }
  ;(state.terrain as { standable: Vec3Json[] }).standable = [feet]
  const grounded = generateGroundedCandidates(state, crossingOptions(spec))
  const bridge = bridgeCandidates(grounded.candidates)[0]
  const plan = planBridgeRoute({ selfFeet: feet, target, probes, placeable: { name: 'cobblestone', count: 177 } })
  const fractional = plan.plan === null ? 0 : distance({ x: 0.9, y: 64, z: 0.9 }, target)
  const fractionalNext = plan.plan === null ? 0 : distance(plan.plan.far, target)
  check(
    '(x-d) a scaffold whose far side is one CELL closer survives the route gate even when the fractional distance would not',
    bridge !== undefined &&
      plan.plan !== null &&
      bridge.meta.bridgeSelfLanding === true &&
      // the fractional comparison really would have refused it (the regression witness)
      !(fractionalNext + 0.1 < fractional),
    `bridge=${bridge?.id ?? 'none'} fractional=${fractional.toFixed(3)}->${fractionalNext.toFixed(3)} (refused=${!(fractionalNext + 0.1 < fractional)})`,
  )
}

{
  // (x-e) CONTROL: a WALKABLE target offers NO crossing and keeps its plain MOVE,
  // so ordinary walking is byte-identical.
  const terrain = new Terrain()
  terrain.fill(-3, 12, 0, 63, 'stone')
  const feet: Vec3Json = { x: 0, y: 64, z: 0 }
  const target: Vec3Json = { x: 8, y: 64, z: 0 }
  const spec: WorldSpec = { feet, terrain, counts: { cobblestone: 177 }, current: queuedGoto(target) }
  const state = worldState(spec)
  const options: CandidateOptions = {
    ...defaultCandidateOptions,
    portalEntry: entryPlanFor(feet),
    // a real walk exists: the pinned pathfinder can express it
    reachability: { pathProbe: () => 'reachable' },
  }
  const grounded = generateGroundedCandidates(state, options)
  check(
    '(x-e) walkable terrain grounds NO crossing and keeps the ordinary MOVE (byte-identical walking)',
    bridgeCandidates(grounded.candidates).length === 0 &&
      grounded.withheld.every((entry) => entry.candidate.meta[BRIDGE_META] !== true),
    `offer=[${grounded.candidates.map((c) => c.id).join(',')}] bridges=${bridgeCandidates(grounded.candidates).length}`,
  )
}

{
  // (x-f) CONTROL: the same void with EMPTY HANDS grounds no crossing (there is
  // nothing to place), and the refusal is the typed `no_block`.
  const world = twoLandmasses(3)
  const spec: WorldSpec = { feet: world.feet, terrain: world.terrain, counts: {}, current: queuedGoto(world.target) }
  const state = worldState(spec)
  const grounded = generateGroundedCandidates(state, optionsFor(spec))
  const decision = planBridgeRoute({
    selfFeet: world.feet,
    target: world.target,
    probes: probesFromTerrain(world.terrain, world.feet),
    placeable: null,
  })
  check(
    '(x-f) the same void with empty hands grounds no crossing and the refusal is the typed no_block',
    bridgeCandidates(grounded.candidates).length === 0 &&
      decision.plan === null &&
      decision.refusal.reason === 'no_block',
    `bridges=${bridgeCandidates(grounded.candidates).length} refusal=${decision.plan === null ? decision.refusal.reason : 'GROUNDED'}`,
  )
}


{
  // (x-g) EXECUTION of the general MOVE crossing: the offered plan really PLACES its
  // three floor cells and the body really ADVANCES onto each one (a `BRIDGE_STEP` is
  // printed only after `sameCell(landed, span.landing)`, so the line IS the advance
  // proof), ending on the verified far bank. This is the parent's "8 m across" shape
  // driven through the real Executor, not just offered.
  const world = twoLandmasses(3)
  const plan = planBridgeRoute({
    selfFeet: world.feet,
    target: world.target,
    probes: realProbes(world.terrain, world.feet),
    placeable: { name: 'cobblestone', count: 177 },
  })
  const logs: CapturedLog[] = []
  const { bot, position } = makeBridgeBot(world.terrain, world.feet, { cobblestone: 177 })
  const executor = new Executor(bot, makeCapturingLogger(logs), {
    ...defaultExecutorOptions,
    actuation: 'pathfinder',
    pathTimeoutMs: 60,
    packetStepMs: 0,
  })
  if (plan.plan !== null) executor.claim(bridgeCandidateFor(plan.plan))
  const done = await waitFor(() => logs.some((line) => line.message.startsWith('BRIDGE_END')))
  executor.cancelCurrent('general move crossing fixture complete')
  const steps = logs.filter((line) => line.message.startsWith('BRIDGE_STEP')).map((line) => line.message)
  const end = logs.find((line) => line.message.startsWith('BRIDGE_END'))?.message ?? 'none'
  const bodyCell = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
  check(
    '(x-g) the general MOVE crossing EXECUTES: three placements, three verified landings, the body on the far landmass',
    plan.plan !== null &&
      done &&
      steps.length === 3 &&
      steps[0] === 'BRIDGE_STEP from=0,64,0 to=1,64,0 block=cobblestone' &&
      steps[2] === 'BRIDGE_STEP from=2,64,0 to=3,64,0 block=cobblestone' &&
      end === 'BRIDGE_END placed=3 verified=true reason=reached' &&
      key(bodyCell) === '4,64,0' &&
      world.terrain.name({ x: 1, y: 63, z: 0 }) === 'cobblestone' &&
      world.terrain.name({ x: 2, y: 63, z: 0 }) === 'cobblestone' &&
      world.terrain.name({ x: 3, y: 63, z: 0 }) === 'cobblestone',
    `plan=${plan.plan === null ? 'none' : `span=${plan.plan.span}`} done=${done} steps=${steps.length} [${steps.join(' | ')}] end="${end}" body=${key(bodyCell)} floors=${world.terrain.name({ x: 1, y: 63, z: 0 })}/${world.terrain.name({ x: 2, y: 63, z: 0 })}/${world.terrain.name({ x: 3, y: 63, z: 0 })}`,
  )
}

process.stdout.write(`\n${failures === 0 ? 'ALL BRIDGE FIXTURES PASS' : `${failures} BRIDGE FIXTURE(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
