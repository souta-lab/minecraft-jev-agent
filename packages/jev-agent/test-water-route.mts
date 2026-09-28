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
import { buildWaterRouteTargets, waterRouteBreathOk } from './src/state.ts'
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
  const ok = waterRouteBreathOk(self, 8 * 900 + 1500)
  const candidates = waterRouteCandidates(
    { self, waterRouteTargets: [{ exit: { x: 3, y: 0, z: 0 }, exitKind: 'breath', waypoints: [{ x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }], waypointBlocks: ['water', 'water', 'water'], costMs: 8 * 900 + 1500 }] } as unknown as WorldState,
    defaultCandidateOptions,
  )
  return { pass: ok === false && candidates.length === 0, detail: `breathOk=${ok} candidates=${candidates.length}` }
})

addCase('affordable breath exit is still offered at low air', () => {
  const self = { ...SELF_BASE, feetInWater: true, eyesInWater: true, air: 10 }
  const route = { exit: { x: 1, y: 0, z: 0 }, exitKind: 'breath' as const, waypoints: [{ x: 1, y: 0, z: 0 }], waypointBlocks: ['water'], costMs: 900 + 1500 }
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
addCase('breath budget: air=11 refuses a 12-step corridor, allows a 3-step one', () => {
  const self = { ...SELF_BASE, feetInWater: false, eyesInWater: false, air: 11 }
  const longCost = 1500 + 12 * 900 // 12.3s > 8.25s supply
  const shortCost = 1500 + 3 * 900 // 4.2s < 8.25s supply
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

addCase('unknown breath with submerged eyes emits no horizontal route', () => {
  const self = { ...SELF_BASE, feetInWater: true, eyesInWater: true, air: null }
  const candidates = waterRouteCandidates(
    {
      self,
      waterRouteTargets: [{ exit: { x: 1, y: 0, z: 0 }, exitKind: 'breath', waypoints: [{ x: 1, y: 0, z: 0 }], waypointBlocks: ['water'], costMs: 900 }],
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
  costMs: 4 * 900 + 1500,
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
