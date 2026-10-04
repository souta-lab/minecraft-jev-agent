// test-water-route.mts - p19.8: a bounded, sensor-witnessed local water route
// is a grounded locomotion candidate when no ordinary dry route exists.
//
// THE MEASURED LIVE SHAPE (portal-p19.7 tail, run-mul5t8tp-93bb):
//
//   body dry/onGround at (14.3,59,-11.5), hp 5.28, trapped in a dug pocket;
//   6 water blocks in the loaded sample; PILLAR_UP refused (liquid in column);
//   every RETRIEVE/MOVE leg to remembered logs path_stuck; envelope = [WAIT,
//   ESCALATE] while CANDIDATE_STARVATION -> System2 plans re-grounded to the
//   same sealed cell for ~30min. The stock pathfinder cannot route through
//   water and the submersion arm only covers the body's own column while
//   low-air - a water-crossed corridor was simply unrepresentable.
//
// The mechanic: a bounded local BFS over sensor-observed water-occupiable cells
// (feet fluid + head passable, hazard-free; lava excluded by PROBE_FLUIDS
// membership) from the body's own cell to an observed exit - a breathable
// surface cell (water feet + air head) or a usable standable shore cell. Routes
// carry their own block witness; a changed or unloaded waypoint cell fails
// closed. Breath is an explicit budget: out-of-air routes must fit the
// remaining supply, and unknown breath with submerged eyes emits nothing
// horizontal. Candidates remain ordinary Jev choices (kind MOVE).
//
//   bun ./test-water-route.mts
import {
  defaultCandidateOptions,
  generateCandidates,
  isDeathZoneEscapeRoute,
  waterRouteCandidates,
} from './src/candidates.ts'
import { buildWaterRouteTargets, waterRouteBreathOk, WATER_ROUTE_WAYPOINT_MS } from './src/state.ts'
import { isGroundedWaterRoute } from './src/policy.ts'
import { isSurvivalEscapeChoice } from './src/threat.ts'
import type { Candidate } from './src/candidates.ts'
import type { Vec3Json, WorldState } from './src/state.ts'
import type { Bot } from 'mineflayer'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}
const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const DIM = 'overworld'

const SELF_BASE = {
  username: 'AI_TEST',
  position: { x: 0.4, y: 0.4, z: 0.4 },
  eyePosition: { x: 0.4, y: 2.02, z: 0.4 },
  yaw: 0,
  pitch: 0,
  onGround: false,
  health: 20,
  food: 20,
  gameMode: 'survival',
  dimension: DIM,
  isDay: true,
  heldItem: null,
}

type BlockSpec = { name: string; boundingBox: string }
const solid = (name: string): BlockSpec => ({ name, boundingBox: 'block' })
const empty = (name: string): BlockSpec => ({ name, boundingBox: 'empty' })

/** A stub world: map of "x,y,z" -> block. Missing cells are unloaded (null). */
function gridBot(blocks: Record<string, BlockSpec>, selfPos: Vec3Json): Bot {
  const entity = {
    position: {
      ...selfPos,
      set(x: number, y: number, z: number) {
        this.x = x
        this.y = y
        this.z = z
        return this
      },
      clone() {
        return { x: this.x, y: this.y, z: this.z, set: this.set }
      },
    },
  }
  return {
    entity,
    blockAt: (p: { x: number; y: number; z: number }) =>
      blocks[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`] ?? null,
  } as unknown as Bot
}

const k = (x: number, y: number, z: number): string => `${x},${y},${z}`

// Body at cell (0,0,0) - a dry pocket whose only way out crosses water.
// Corridor: (1,0,0) water/water, (2,0,0) water/water, (3,0,0) water/AIR
//           -> breath exit at (3,0,0).
//           (4,0,0) air/air over solid (4,-1,0) -> shore exit at (4,0,0).
function corridorGrid(): Record<string, BlockSpec> {
  const g: Record<string, BlockSpec> = {
    [k(0, -1, 0)]: solid('stone'),
    [k(0, 0, 0)]: empty('air'),
    [k(0, 1, 0)]: empty('air'),
    [k(1, 0, 0)]: empty('water'),
    [k(1, 1, 0)]: empty('water'),
    [k(2, 0, 0)]: empty('water'),
    [k(2, 1, 0)]: empty('water'),
    [k(3, 0, 0)]: empty('water'),
    [k(3, 1, 0)]: empty('air'),
    [k(4, -1, 0)]: solid('stone'),
    [k(4, 0, 0)]: empty('air'),
    [k(4, 1, 0)]: empty('air'),
  }
  return g
}


addCase('corridor BFS: waterlogged body gets a breathable-surface exit route', () => {
  const self = { ...SELF_BASE, feetInWater: true, eyesInWater: true, air: 15 }
  const targets = buildWaterRouteTargets(gridBot(corridorGrid(), self.position), self)
  const breath = targets.find((t) => t.exitKind === 'breath')
  const pass =
    breath !== undefined &&
    breath.exit.x === 3 &&
    breath.exit.y === 0 &&
    breath.exit.z === 0 &&
    breath.waypoints.length === 3 &&
    breath.waypointBlocks.every((name) => name === 'water')
  return { pass, detail: `targets=${JSON.stringify(targets.map((t) => [t.exitKind, t.exit, t.waypoints.length]))}` }
})

addCase('corridor BFS: waterlogged body gets a standable shore exit route', () => {
  const self = { ...SELF_BASE, feetInWater: true, eyesInWater: true, air: 15 }
  const targets = buildWaterRouteTargets(gridBot(corridorGrid(), self.position), self)
  const shore = targets.find((t) => t.exitKind === 'shore')
  const pass = shore !== undefined && shore.exit.x === 4 && shore.exit.y === 0 && shore.exit.z === 0
  return { pass, detail: `targets=${JSON.stringify(targets.map((t) => [t.exitKind, t.exit]))}` }
})

addCase('dry trapped body with an observed water corridor still grounds routes (proactive)', () => {
  const self = { ...SELF_BASE, feetInWater: false, eyesInWater: false, air: 20 }
  const targets = buildWaterRouteTargets(gridBot(corridorGrid(), self.position), self)
  const pass = targets.length > 0 && targets.some((t) => t.exitKind === 'breath')
  return { pass, detail: `targets=${targets.length}` }
})

addCase('no water anywhere -> no water-route scan output (dry-land regression)', () => {
  const g: Record<string, BlockSpec> = {
    [k(0, -1, 0)]: solid('grass_block'),
    [k(0, 0, 0)]: empty('air'),
    [k(0, 1, 0)]: empty('air'),
    [k(1, -1, 0)]: solid('grass_block'),
    [k(1, 0, 0)]: empty('air'),
    [k(1, 1, 0)]: empty('air'),
  }
  const self = { ...SELF_BASE, feetInWater: false, eyesInWater: false, air: 20 }
  const targets = buildWaterRouteTargets(gridBot(g, self.position), self)
  return { pass: targets.length === 0, detail: `targets=${targets.length}` }
})

addCase('lava cells are never water-occupiable', () => {
  const g = corridorGrid()
  g[k(2, 0, 0)] = empty('lava')
  const self = { ...SELF_BASE, feetInWater: true, eyesInWater: true, air: 15 }
  const targets = buildWaterRouteTargets(gridBot(g, self.position), self)
  const pass = targets.every((t) => !t.waypoints.some((w) => w.x === 2 && w.y === 0 && w.z === 0))
  return { pass, detail: `targets=${JSON.stringify(targets.map((t) => [t.exitKind, t.exit]))}` }
})

addCase('insufficient breath refuses the horizontal route (out_of_air, cost > supply)', () => {
  const self = { ...SELF_BASE, feetInWater: true, eyesInWater: true, air: 2 }
  const cost = 1500 + 8 * WATER_ROUTE_WAYPOINT_MS
  const ok = waterRouteBreathOk(self, cost)
  const candidates = waterRouteCandidates(
    { self, waterRouteTargets: [{ exit: { x: 3, y: 0, z: 0 }, exitKind: 'breath', waypoints: [{ x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }], waypointBlocks: ['water', 'water', 'water'], waypointHeads: ['water', 'water', 'air'], exitSupport: null, costMs: cost }] } as unknown as WorldState,
    defaultCandidateOptions,
  )
  return { pass: ok === false && candidates.length === 0, detail: `breathOk=${ok} candidates=${candidates.length}` }
})

addCase('affordable breath exit is still offered at low air', () => {
  const self = { ...SELF_BASE, feetInWater: true, eyesInWater: true, air: 10 }
  const route = { exit: { x: 1, y: 0, z: 0 }, exitKind: 'breath' as const, waypoints: [{ x: 1, y: 0, z: 0 }], waypointBlocks: ['water'], waypointHeads: ['water'], exitSupport: null, costMs: 1500 + WATER_ROUTE_WAYPOINT_MS }
  const candidates = waterRouteCandidates(
    { self, waterRouteTargets: [route] } as unknown as WorldState,
    defaultCandidateOptions,
  )
  const c = candidates[0]
  const pass =
    candidates.length === 1 &&
    c?.id === 'SWIM:exit:p1_0_0' &&
    c?.kind === 'MOVE' &&
    c?.meta.swimRoute === true &&
    c?.meta.waterRouteExitKind === 'breath'
  return { pass, detail: `candidates=${candidates.map((x) => x.id).join(' ')}` }
})

// The breath budget is dimensional: one oxygenLevel bubble is ~750ms
// (20 bubbles = 300 server ticks = 15s), so air=11 affords ~8.25s. A route's
// declared costMs must fit under the measured supply for EVERY water entry,
// wet or dry - a dry body that will swim is not exempt.
addCase('breath budget: air=11 (~8.25s) refuses a 3-step corridor, allows a 2-step one', () => {
  // Every waypoint is budgeted at its full actuator bound (2500ms), so air=11
  // covers exactly 1500+2*2500=6.5s and no more - admission never assumes
  // less underwater time than the actuator is allowed to spend.
  const self = { ...SELF_BASE, feetInWater: false, eyesInWater: false, air: 11 }
  const longCost = 1500 + 3 * WATER_ROUTE_WAYPOINT_MS // 9s > 8.25s supply
  const shortCost = 1500 + 2 * WATER_ROUTE_WAYPOINT_MS // 6.5s < 8.25s supply
  return {
    pass: waterRouteBreathOk(self, longCost) === false && waterRouteBreathOk(self, shortCost) === true,
    detail: `long=${waterRouteBreathOk(self, longCost)} short=${waterRouteBreathOk(self, shortCost)}`,
  }
})

addCase('breath budget: no route may exceed the full MAX_AIR supply', () => {
  const self = { ...SELF_BASE, feetInWater: false, eyesInWater: false, air: 20 }
  const overBudget = 20 * 750 + 1
  return { pass: waterRouteBreathOk(self, overBudget) === false, detail: `overBudget=${waterRouteBreathOk(self, overBudget)}` }
})

addCase('breath budget: unknown air on a dry body is capped at the vanilla supply', () => {
  const self = { ...SELF_BASE, feetInWater: false, eyesInWater: false, air: null }
  const fits = waterRouteBreathOk(self, 9000)
  const exceeds = waterRouteBreathOk(self, 20 * 750 + 1)
  return { pass: fits === true && exceeds === false, detail: `fits=${fits} exceeds=${exceeds}` }
})

// A body that already breathes (head out of fluid) gains nothing from a
// `breath` exit: measured p19.8 live, the dry pocket body dipped ~0.5m onto
// the surface cell's edge, verified `done`, and the repeated-outcome ledger
// retired the whole `SWIM:exit:*` shape at 6/6 without the body leaving the
// pocket. Only `shore` exits - standable ground the body does not occupy -
// are real exits for it. Eyes under fluid keeps breath exits: each one is an
// air pocket on the route.
addCase('breath exits are suppressed for a body that already breathes', () => {
  const breathRoute = { exit: { x: 1, y: 0, z: 0 }, exitKind: 'breath' as const, waypoints: [{ x: 1, y: 0, z: 0 }], waypointBlocks: ['water'], waypointHeads: ['water'], exitSupport: null, costMs: 1500 + WATER_ROUTE_WAYPOINT_MS }
  const shoreRoute = { exit: { x: 4, y: 0, z: 0 }, exitKind: 'shore' as const, waypoints: [{ x: 1, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }], waypointBlocks: ['water', 'air'], waypointHeads: ['water', 'air'], exitSupport: 'stone', costMs: 1500 + 2 * WATER_ROUTE_WAYPOINT_MS }
  const drySelf = { ...SELF_BASE, feetInWater: false, eyesInWater: false, air: 20 }
  const dryOut = waterRouteCandidates(
    { self: drySelf, waterRouteTargets: [breathRoute, shoreRoute] } as unknown as WorldState,
    defaultCandidateOptions,
  )
  const submergedSelf = { ...SELF_BASE, feetInWater: true, eyesInWater: true, air: 14 }
  const wetOut = waterRouteCandidates(
    { self: submergedSelf, waterRouteTargets: [breathRoute, shoreRoute] } as unknown as WorldState,
    defaultCandidateOptions,
  )
  const pass =
    dryOut.length === 1 &&
    dryOut[0]?.meta.waterRouteExitKind === 'shore' &&
    wetOut.length === 2
  return {
    pass,
    detail: `dry=[${dryOut.map((c) => c.id).join(' ')}] wet=[${wetOut.map((c) => c.id).join(' ')}]`,
  }
})

addCase('unknown breath with submerged eyes emits no horizontal route', () => {
  const self = { ...SELF_BASE, feetInWater: true, eyesInWater: true, air: null }
  const candidates = waterRouteCandidates(
    {
      self,
      waterRouteTargets: [{ exit: { x: 1, y: 0, z: 0 }, exitKind: 'breath', waypoints: [{ x: 1, y: 0, z: 0 }], waypointBlocks: ['water'], waypointHeads: ['water'], exitSupport: null, costMs: 1500 + WATER_ROUTE_WAYPOINT_MS }],
    } as unknown as WorldState,
    defaultCandidateOptions,
  )
  return { pass: candidates.length === 0, detail: `candidates=${candidates.length}` }
})

function trappedState(waterRouteTargets: WorldState['waterRouteTargets'], failedCandidates: Record<string, number>, stalledMs: number): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: { ...SELF_BASE, feetInWater: false, eyesInWater: false, air: 20 },
    inventory: { slots: [], counts: {}, totalItems: 0 },
    entities: [],
    blocks: [],
    terrain: {
      standable: [],
      escapeCells: [
        { x: -3, y: 0, z: 17 },
        { x: -4, y: 0, z: 17 },
      ],
    },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: [],
    stepCuts: [],
    headroomCuts: [],
    waterRouteTargets,
    goal: {
      id: 'explore:explore:1',
      description: 'explore',
      targetItem: null,
      requiredCount: 1,
      startCount: 0,
      haveCount: 0,
      progress: 0,
      complete: false,
      startedAtMs: 0,
    },
    goalQueue: { depth: 0, current: null, empty: true, hasImpossible: false, done: 0, goals: [] },
    recentEvents: [],
    signals: {
      consecutiveFailures: 0,
      lastFailureCode: null,
      lastPathStatus: 'idle',
      stalledMs,
      lastPolicyConfidence: null,
      maxConcurrentActions: 0,
      escalationRecommended: false,
      failedCandidates,
      knownResources: [],
      exploredCells: [],
    },
  } as unknown as WorldState
}

const ROUTE = {
  exit: { x: 4, y: 0, z: 0 },
  exitKind: 'shore' as const,
  waypoints: [
    { x: 1, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 3, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
  ],
  waypointBlocks: ['water', 'water', 'water', 'air'],
  waypointHeads: ['water', 'water', 'air', 'air'],
  exitSupport: 'stone',
  costMs: 1500 + 4 * WATER_ROUTE_WAYPOINT_MS,
}

// A trapped body NOT in a death zone (the live p19.7 tail shape): no blacklist
// means no dangerzone exits are generated, so the only routes are last-resort
// arms - exactly where the water corridor must appear.
const openOptions = { ...defaultCandidateOptions, reach: 8 }

// A death-zone variant: the body cell (origin) is blacklisted but the ring
// exits (-3/-4,0,17; |cell| ~17.3 > 14) are not, so MOVE:dangerzone exits
// actually generate and can exercise the locomotion gate.
const zoneOptions = {
  ...defaultCandidateOptions,
  reach: 8,
  blacklistedMoveTargets: (_dim: string, pos: Vec3Json) => Math.hypot(pos.x, pos.y, pos.z) <= 14,
}

addCase('offer seam: trapped+stalled body with a witnessed water route is offered SWIM:exit', () => {
  const state = trappedState([ROUTE], {}, 60_000)
  const offered = generateCandidates(state, openOptions)
  const ids = offered.map((c) => c.id)
  return { pass: ids.includes('SWIM:exit:p4_0_0'), detail: `offered=[${ids.join(' ')}]` }
})

addCase('offer seam: an uncharged ordinary locomotion route gates the water arm off', () => {
  const state = trappedState([ROUTE], {}, 60_000)
  const offered = generateCandidates(state, zoneOptions)
  const locomotion = offered.filter((c) => c.id.startsWith('MOVE:dangerzone:'))
  const swim = offered.filter((c) => c.id.startsWith('SWIM:exit:'))
  return {
    pass: locomotion.length > 0 && swim.length === 0,
    detail: `locomotion=[${locomotion.map((c) => c.id).join(' ')}] swim=[${swim.map((c) => c.id).join(' ')}]`,
  }
})

addCase('offer seam: refused dry exits + stall -> water route is the locomotion offer', () => {
  const failed = {
    'MOVE:dangerzone:p-3_0_17': 6,
    'MOVE:dangerzone:p-4_0_17': 6,
  }
  const state = trappedState([ROUTE], failed, 60_000)
  const offered = generateCandidates(state, zoneOptions)
  const ids = offered.map((c) => c.id)
  return { pass: ids.includes('SWIM:exit:p4_0_0'), detail: `offered=[${ids.join(' ')}]` }
})

addCase('offer seam: no measured stall -> the water arm stays gated off', () => {
  const state = trappedState([ROUTE], {}, 5_000)
  const offered = generateCandidates(state, openOptions)
  const swim = offered.filter((c) => c.id.startsWith('SWIM:exit:'))
  return { pass: swim.length === 0, detail: `swim=[${swim.map((c) => c.id).join(' ')}]` }
})

// portal-p21.2 regression: the controller's fresh revalidation offer must pass
// `suppressedCandidateIds` (the ids generated last tick but pruned before
// presentation) into generation. Without it, a phantom dry route that every
// tick is suppressed downstream still counted as usable locomotion here, the
// swim arm never fired in the fresh set, and a committed SWIM:exit vanished
// between the Jev answer and execution on every tick (`CAPABILITY_LOST` loop).
addCase('offer seam: suppressed dry locomotion does not gate the water arm off', () => {
  const state = trappedState([ROUTE], {}, 60_000)
  const base = generateCandidates(state, zoneOptions)
  const dryIds = base.filter((c) => c.id.startsWith('MOVE:dangerzone:')).map((c) => c.id)
  const suppressed = {
    ...zoneOptions,
    suppressedCandidateIds: new Set(dryIds),
  }
  const offered = generateCandidates(state, suppressed)
  const swim = offered.filter((c) => c.id.startsWith('SWIM:exit:'))
  return {
    pass: dryIds.length > 0 && swim.length === 1 && swim[0]?.id === 'SWIM:exit:p4_0_0',
    detail: `suppressed=[${dryIds.join(' ')}] swim=[${swim.map((c) => c.id).join(' ')}]`,
  }
})

// A grounded candidate comes from the production serializer - meta scalars
// only. Any hand-injected array shape must fail closed in the parser, and the
// real candidate must parse back to the exact witness.
const routeState = (targets: WorldState['waterRouteTargets'], air = 20) =>
  ({ self: { ...SELF_BASE, air }, waterRouteTargets: targets }) as unknown as WorldState

addCase('grounding: a changed corridor fails the witness check', () => {
  const candidate = waterRouteCandidates(routeState([ROUTE]), defaultCandidateOptions)[0]
  // Corridor changed: waypoint 2 no longer matches the witnessed block list.
  const changedTargets = [
    { ...ROUTE, waypoints: [{ x: 1, y: 0, z: 0 }, { x: 9, y: 0, z: 9 }, { x: 3, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }] },
  ]
  const grounded = isGroundedWaterRoute(candidate as Candidate, routeState(changedTargets))
  const groundedFresh = isGroundedWaterRoute(candidate as Candidate, routeState([ROUTE]))
  return { pass: grounded === false && groundedFresh === true, detail: `changed=${grounded} fresh=${groundedFresh}` }
})

addCase('grounding: unloaded (missing) route set fails closed', () => {
  const candidate = waterRouteCandidates(routeState([ROUTE]), defaultCandidateOptions)[0]
  const state = { self: { ...SELF_BASE, air: 20 } } as unknown as WorldState
  return { pass: isGroundedWaterRoute(candidate as Candidate, state) === false, detail: 'no waterRouteTargets -> false' }
})

addCase('grounding: breath re-checked against the fresh witness cost', () => {
  const candidate = waterRouteCandidates(routeState([ROUTE]), defaultCandidateOptions)[0]
  // 5100ms route vs air=5 (~3.75s): the candidate was emitted under full air,
  // but the guard re-budgets against the CURRENT self.
  const lowAir = routeState([ROUTE], 5)
  return {
    pass: isGroundedWaterRoute(candidate as Candidate, lowAir) === false,
    detail: 'air=5 cannot cover the route -> false',
  }
})

addCase('a water-route MOVE counts as a survival escape route under threat', () => {
  const swim = { id: 'SWIM:exit:p4_0_0', kind: 'MOVE', meta: { swimRoute: true } } as unknown as Candidate
  const ordinary = { id: 'MOVE:p1_0_0', kind: 'MOVE', meta: {} } as unknown as Candidate
  const pass =
    isDeathZoneEscapeRoute(swim) === true &&
    isDeathZoneEscapeRoute(ordinary) === false &&
    isSurvivalEscapeChoice({ id: 'SWIM:exit:p4_0_0', kind: 'MOVE', meta: { swimRoute: true } }) === true &&
    isSurvivalEscapeChoice({ id: 'MOVE:p1_0_0', kind: 'MOVE', meta: {} }) === false
  return { pass, detail: `swim=${isDeathZoneEscapeRoute(swim)} ordinary=${isDeathZoneEscapeRoute(ordinary)}` }
})

// p19.8 review hardening: the witness covers the whole body volume the route
// feasibility check used (feet + head per waypoint, shore support), and the
// per-waypoint time bound is shared between admission and actuation.

addCase('grounding: a changed waypoint HEAD fails the witness check', () => {
  const candidate = waterRouteCandidates(routeState([ROUTE]), defaultCandidateOptions)[0]
  const tampered = {
    ...(candidate as Candidate),
    meta: { ...(candidate as Candidate).meta, waterRouteHeads: 'water,water,water,stone' },
  } as unknown as Candidate
  return {
    pass: isGroundedWaterRoute(tampered, routeState([ROUTE])) === false,
    detail: 'head name mismatch -> false',
  }
})

addCase('grounding: a changed shore SUPPORT fails the witness check', () => {
  const candidate = waterRouteCandidates(routeState([ROUTE]), defaultCandidateOptions)[0]
  const tampered = {
    ...(candidate as Candidate),
    meta: { ...(candidate as Candidate).meta, waterRouteExitSupport: 'magma_block' },
  } as unknown as Candidate
  return {
    pass: isGroundedWaterRoute(tampered, routeState([ROUTE])) === false,
    detail: 'support name mismatch -> false',
  }
})

addCase('grounding: a missing witness head list fails closed in the parser', () => {
  const candidate = waterRouteCandidates(routeState([ROUTE]), defaultCandidateOptions)[0]
  const meta = { ...(candidate as Candidate).meta }
  delete (meta as Record<string, unknown>).waterRouteHeads
  const tampered = { ...(candidate as Candidate), meta } as unknown as Candidate
  return {
    pass: isGroundedWaterRoute(tampered, routeState([ROUTE])) === false,
    detail: 'no waterRouteHeads -> unparseable -> false',
  }
})

addCase('corridor BFS: an unloaded head cell blocks the water node (fail closed)', () => {
  const g = corridorGrid()
  delete g[k(2, 1, 0)] // head cell of waypoint (2,0,0) unobserved
  const self = { ...SELF_BASE, feetInWater: true, eyesInWater: true, air: 15 }
  const targets = buildWaterRouteTargets(gridBot(g, self.position), self)
  // The corridor is severed at x=2 and no exit is reachable from node (1,0,0)
  // alone - the honest outcome is no route at all.
  return { pass: targets.length === 0, detail: `targets=${JSON.stringify(targets.map((t) => [t.exitKind, t.exit]))}` }
})

addCase('corridor BFS: a hazardous (magma) shore support is refused', () => {
  const g = corridorGrid()
  g[k(4, -1, 0)] = solid('magma_block') // stand support becomes lava-class
  const self = { ...SELF_BASE, feetInWater: true, eyesInWater: true, air: 15 }
  const targets = buildWaterRouteTargets(gridBot(g, self.position), self)
  const pass = targets.every((t) => !(t.exitKind === 'shore' && t.exit.x === 4))
  return { pass, detail: `targets=${JSON.stringify(targets.map((t) => [t.exitKind, t.exit]))}` }
})

// Long corridor: 6 water cells, the last with an air head -> traverse exit
// (no shore exists in the box). Declared cost counts only waypoints whose
// head stays under fluid: 1500 + 5*2500 = 14s - exactly inside the ~15s
// vanilla supply, so full air admits it and air=18 (~13.5s) refuses.
function longCorridorGrid(): Record<string, BlockSpec> {
  const g: Record<string, BlockSpec> = {
    [k(0, -1, 0)]: solid('stone'),
    [k(0, 0, 0)]: empty('air'),
    [k(0, 1, 0)]: empty('air'),
  }
  for (let x = 1; x <= 6; x += 1) {
    g[k(x, 0, 0)] = empty('water')
    g[k(x, 1, 0)] = empty(x === 6 ? 'air' : 'water')
  }
  return g
}

addCase('breath budget: a head-dry exit cell costs no breath; 5 submerged waypoints fit the vanilla supply', () => {
  const self = { ...SELF_BASE, feetInWater: true, eyesInWater: true, air: 20 }
  const targets = buildWaterRouteTargets(gridBot(longCorridorGrid(), self.position), self)
  // The corridor's only surface node is both the far edge and the lone
  // breathable cell - the composition keeps it offered (breath, since it is
  // the only surface node), and the cost check is what this case owns.
  const route = targets.find((t) => t.exitKind !== 'shore')
  const expected = 1500 + 5 * WATER_ROUTE_WAYPOINT_MS
  const pass =
    route !== undefined &&
    route.waypoints.length === 6 &&
    route.costMs === expected &&
    expected <= 20 * 750 &&
    waterRouteBreathOk(self, route.costMs) === true &&
    waterRouteBreathOk({ ...self, air: 18 }, route.costMs) === false
  return {
    pass,
    detail: `route=${route ? `wp=${route.waypoints.length} costMs=${route.costMs}` : 'none'} supply=${20 * 750}`,
  }
})

addCase('route cost budgets only head-submerged waypoints at the shared per-waypoint bound', () => {
  const self = { ...SELF_BASE, feetInWater: true, eyesInWater: true, air: 15 }
  const targets = buildWaterRouteTargets(gridBot(corridorGrid(), self.position), self)
  const breath = targets.find((t) => t.exitKind === 'breath')
  const submerged = breath?.waypointHeads.filter((name) => name !== 'air').length ?? -1
  const pass = breath !== undefined && breath.costMs === 1500 + submerged * WATER_ROUTE_WAYPOINT_MS
  return { pass, detail: `costMs=${breath?.costMs} submerged=${submerged} bound=${WATER_ROUTE_WAYPOINT_MS}` }
})

// Sealed flooded pocket: body cell is water, every horizontal neighbor and the
// cap above are stone, and the ONLY way out is straight down a water column
// into a cave - the descent the live pocket at (15,62,-1) demanded. Water fills
// (0,-1..-4,0); (0,-5,0) is air over stone at (0,-6,0), so the shore exit is a
// same-column drop-out below the last water node.
function shaftDownGrid(): Record<string, BlockSpec> {
  const g: Record<string, BlockSpec> = {
    [k(0, -6, 0)]: solid('stone'),
    [k(0, -5, 0)]: empty('air'),
    [k(0, -4, 0)]: empty('water'),
    [k(0, -3, 0)]: empty('water'),
    [k(0, -2, 0)]: empty('water'),
    [k(0, -1, 0)]: empty('water'),
    [k(0, 0, 0)]: empty('water'),
    [k(0, 1, 0)]: empty('water'),
    [k(0, 2, 0)]: solid('stone'),
    [k(1, -5, 0)]: empty('air'),
    [k(1, -4, 0)]: empty('air'),
    [k(1, -6, 0)]: solid('stone'),
  }
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    for (const y of [-1, 0, 1, 2]) g[k(dx, y, dz)] = solid('stone')
  }
  // Restore the lateral cave mouth beside the drop-out cell.
  g[k(1, -5, 0)] = empty('air')
  g[k(1, -4, 0)] = empty('air')
  g[k(1, -6, 0)] = solid('stone')
  return g
}

addCase('shaft descent: vertical water column reaches a cave-floor shore exit below the body', () => {
  const self = { ...SELF_BASE, feetInWater: true, eyesInWater: true, air: 20 }
  const targets = buildWaterRouteTargets(gridBot(shaftDownGrid(), self.position), self)
  const shore = targets.find((t) => t.exitKind === 'shore' && t.exit.y === -5)
  const pass =
    shore !== undefined &&
    shore.waypoints.length === 5 &&
    shore.waypoints[0]?.y === -1 &&
    shore.waypoints[3]?.y === -4 &&
    shore.waypointBlocks.slice(0, 4).every((name) => name === 'water')
  return { pass, detail: `targets=${JSON.stringify(targets.map((t) => [t.exitKind, t.exit, t.waypoints.length]))}` }
})

addCase('shaft descent: route stays inside the breath-affordable depth envelope', () => {
  const self = { ...SELF_BASE, feetInWater: true, eyesInWater: true, air: 20 }
  const targets = buildWaterRouteTargets(gridBot(shaftDownGrid(), self.position), self)
  const shore = targets.find((t) => t.exitKind === 'shore' && t.exit.y === -5)
  const pass = shore !== undefined && waterRouteBreathOk(self, shore.costMs) === true
  return { pass, detail: `costMs=${shore?.costMs} supply=${20 * 750}` }
})

addCase('shaft descent: a drop deeper than any breath supply is not explored', () => {
  const g = shaftDownGrid()
  // Fill the drop-out cells: the column keeps going to -7 with the first
  // dry stand at -8, so the only exit lies below the deepest offerable route.
  g[k(0, -5, 0)] = empty('water')
  g[k(0, -6, 0)] = empty('water')
  g[k(0, -7, 0)] = empty('water')
  g[k(0, -8, 0)] = empty('air')
  g[k(0, -9, 0)] = solid('stone')
  g[k(1, -5, 0)] = empty('water')
  g[k(1, -4, 0)] = empty('water')
  g[k(1, -6, 0)] = empty('water')
  const self = { ...SELF_BASE, feetInWater: true, eyesInWater: true, air: 20 }
  const targets = buildWaterRouteTargets(gridBot(g, self.position), self)
  const pass = targets.length === 0
  return { pass, detail: `targets=${JSON.stringify(targets.map((t) => [t.exitKind, t.exit]))}` }
})

addCase('shaft ascent: vertical water column reaches a breath exit directly overhead', () => {
  // Body submerged in a sealed shaft whose only opening is the water surface
  // straight above: (0,1..3,0) water, (0,4,0) air -> breath exit at (0,3,0).
  const g: Record<string, BlockSpec> = {
    [k(0, -1, 0)]: solid('stone'),
    [k(0, 0, 0)]: empty('water'),
    [k(0, 1, 0)]: empty('water'),
    [k(0, 2, 0)]: empty('water'),
    [k(0, 3, 0)]: empty('water'),
    [k(0, 4, 0)]: empty('air'),
  }
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    for (const y of [-1, 0, 1, 2, 3]) g[k(dx, y, dz)] = solid('stone')
  }
  const self = { ...SELF_BASE, feetInWater: true, eyesInWater: true, air: 20 }
  const targets = buildWaterRouteTargets(gridBot(g, self.position), self)
  const breath = targets.find((t) => t.exitKind === 'breath')
  const pass =
    breath !== undefined &&
    breath.exit.y === 3 &&
    breath.waypoints.length === 3 &&
    breath.waypoints.every((wp) => wp.x === 0 && wp.z === 0)
  return { pass, detail: `targets=${JSON.stringify(targets.map((t) => [t.exitKind, t.exit, t.waypoints.length]))}` }
})

// ---------------------------------------------------------------------------
// portal-p23 (run-mutlktrv-3xw, 2026-10-04T11:04:06Z): ~17min trapped in a
// water pocket whose shore sat beyond the bounded scan, then DEATH cause=
// water at health 7. Two stacked defects decided the hypothesis:
//
//   * every surface cell inside the box was a `breath` exit - which resolves
//     breathing only - so no progress affordance existed at all;
//   * ordinary walk candidates were offered on paper every tick and counted
//     as "usable dry locomotion", gating the water-route arm off entirely -
//     though the pinned pathfinder cannot express a water leg at all.
// ---------------------------------------------------------------------------

// Open lake: water fills the whole scan box, every head cell is air, and no
// standable shore exists inside the radius - the pocket shape that drowned
// the live body. Exit composition must emit `traverse` exits at the witnessed
// far edge while still keeping a `breath` offer for safety.
function openLakeGrid(): Record<string, BlockSpec> {
  const g: Record<string, BlockSpec> = {}
  for (let x = -6; x <= 6; x += 1) {
    for (let z = -6; z <= 6; z += 1) {
      g[k(x, 0, z)] = empty('water')
      g[k(x, 1, z)] = empty('air')
      g[k(x, -1, z)] = empty('water')
    }
  }
  return g
}

addCase('traverse exits: a shoreless open-water box offers the witnessed far edge, not only breath', () => {
  const self = { ...SELF_BASE, feetInWater: true, eyesInWater: true, air: 20 }
  const targets = buildWaterRouteTargets(gridBot(openLakeGrid(), self.position), self)
  const traverses = targets.filter((t) => t.exitKind === 'traverse')
  const breaths = targets.filter((t) => t.exitKind === 'breath')
  const pass =
    traverses.length >= 1 &&
    breaths.length >= 1 &&
    traverses.every((t) => Math.hypot(t.exit.x, t.exit.z) >= 5) &&
    traverses.every((t) => t.exitSupport === null && t.waypoints.length > 0) &&
    // Head-dry waypoint chains carry no breath budget: a surface traverse at
    // low air is still affordable, while the same count under water is not.
    traverses.every((t) => t.costMs === 1500)
  return { pass, detail: `targets=${JSON.stringify(targets.map((t) => [t.exitKind, t.exit, t.waypoints.length, t.costMs]))}` }
})

addCase('traverse exits: a real shore suppresses the frontier fallback', () => {
  const self = { ...SELF_BASE, feetInWater: true, eyesInWater: true, air: 15 }
  const targets = buildWaterRouteTargets(gridBot(corridorGrid(), self.position), self)
  const pass =
    targets.some((t) => t.exitKind === 'shore') &&
    targets.every((t) => t.exitKind !== 'traverse')
  return { pass, detail: `targets=${JSON.stringify(targets.map((t) => [t.exitKind, t.exit]))}` }
})

addCase('traverse exits: a wet body\'s paper walk candidates no longer gate the water arm off', () => {
  // The measured suppression: dangerzone MOVEs existed on paper, so the arm
  // never fired even though a witnessed corridor was grounded.
  const state = trappedState([ROUTE], {}, 60_000)
  state.self = { ...state.self, feetInWater: true, eyesInWater: true, air: 20 } as WorldState['self']
  const offered = generateCandidates(state, zoneOptions)
  const swim = offered.filter((c) => c.id.startsWith('SWIM:exit:'))
  const locomotion = offered.filter((c) => c.id.startsWith('MOVE:dangerzone:'))
  return {
    pass: locomotion.length > 0 && swim.length === 1 && swim[0]?.id === 'SWIM:exit:p4_0_0',
    detail: `locomotion=[${locomotion.map((c) => c.id).join(' ')}] swim=[${swim.map((c) => c.id).join(' ')}]`,
  }
})

addCase('traverse exits: a DRY body keeps the old gate - walk candidates still prove usable locomotion', () => {
  // The wet-body rule must not leak onto dry land: dangerzone MOVEs there are
  // real locomotion and still gate the last-resort arms.
  const state = trappedState([ROUTE], {}, 60_000)
  const offered = generateCandidates(state, zoneOptions)
  const swim = offered.filter((c) => c.id.startsWith('SWIM:exit:'))
  return { pass: swim.length === 0, detail: `swim=[${swim.map((c) => c.id).join(' ')}]` }
})

// ---------------------------------------------------------------------------

let failed = 0
for (const entry of cases) {
  const result = entry.run()
  if (result.pass) {
    console.log(`PASS ${entry.name}`)
  } else {
    failed += 1
    console.log(`FAIL ${entry.name} :: ${result.detail}`)
  }
}
console.log(`${cases.length - failed}/${cases.length} passed`)
process.exit(failed === 0 ? 0 : 1)
