// test-fortress-approach.mts - the general "a route that lays the floor it walks
// on" capability: reaching a STRUCTURE across a span that has no floor, and the
// typed refusals where it must not be invented.
//
// MEASURED LIVE (main cd7b38b, the operator's Nether run, log
// /home/s0u7a/mc-ai-worktrees/m3-live/buddy-driver/buddy.log):
//
//   the body dug from the arrival island to the fortress and stopped:
//     LIVE:472244  DIG_ROUTE actionId=DIG_ROUTE:level:N:b24_57_-12 target=35,61,-23
//                  bearing=N cell=24,57,-12 block=soul_soil kind=tunnel fromD=16.76 toD=16.06
//     LIVE:472270  DIG_ROUTE_PROGRESS ... fromD=16.76 toD=16.06   <- closest of the session
//     LIVE:472276-472281  6x DIG_ROUTE_REFUSED reason=no_support
//     LIVE:475730-475740  MOVE:b35_60_-26 / PILLAR_UP target={36,59,-26}
//                  -> SKILL_ENVELOPE_VIOLATION violation=equip_item_not_declared:cobblestone
//                  -> MOVE_FAILMEM key=the_nether:36,59,-26 attempts=30 reason=no_progress
//
//   and the whole-run refusal census is dominated by exactly that wall:
//     no_support=633, no_tool=78, spent=27, arrived=27, open_floor=23, hazard=18,
//     protected=11, no_step=4, no_grounded_route=3, would_flood=2
//   with the `no_support` targets being the remembered fortress fabric cells
//   (62x {37,59,-21}, 57x {35,61,-23}, 55x {35,61,-22}, 52x {37,59,-22}, ...).
//   `BRIDGE_REFUSED reason=no_verified_landing` is emitted at every step of the
//   final approach (LIVE:474855, 474877, 474937, 475029, 475446, 475503).
//
// WORLD TRUTH (read out of the save, r.0.-1.mca, 2026-09-22 20:16 autosave; the
// columns below are the measured ones, not invented geometry):
//
//   the body's reachable ground east edge is x=28 at z=-20 (component 880,
//   x[0..28] y[56..62] z[-20..-1]); its floor is soul_soil/basalt at y56..58, so
//   feet y=59. From x=29..38 every column's topmost non-air block is y=31 and that
//   block is LAVA: the span is open air 28 blocks above the basin. The nearest
//   fortress fabric is the nether_bricks at (37,59,-20), whose top cell
//   (37,60,-20) is standable - i.e. the structure is 9 blocks east, +1 up, across
//   a span with no floor at all.
//
// The bridge family already owns "place a floor while advancing", but its rule
// required a PRE-VERIFIED standable far side inside the bounded probe
// (`bridgeRoute.ts#planBridgeSpan` rule 6), which a wide span never has - hence the
// live `no_verified_landing` storm at exactly the step that had to cross. The
// missing case is the SCAFFOLD: a step whose far side is the cell it just floored.
//
// These fixtures prove, offline:
//   (i)  the MEASURED approach shape (unsupported span over lava, a structure
//        ahead, cobblestone held): the real sensor probe + the real rule ground a
//        SELF-LANDING scaffold, every step strictly closes the distance, and the
//        body reaches the structure EDGE - asserted by actually walking the rule
//        across the span, not by reading one plan;
//   (ii) ordinary terrain is byte-identical: a verified far side is still a
//        verified span (same BRIDGE_START line), and already-walkable ground still
//        grounds no bridge at all;
//   (iii) where no grounded route exists the answer stays TYPED and auditable:
//        the scaffold refuses `hazard` / `would_flood` / `portal_plane` /
//        `unobserved` / `no_block` with the cell and block named, and the dig
//        family still reports `no_grounded_route` with its per-direction /
//        per-level ledger - never an invented route;
//   (iv) a hostile in melee contact while the body is on a dig/bridge commitment:
//        the work candidate is removed by the EXISTING contact restriction (this
//        lane adds no second combat rule), the offer is a survival set, and the
//        scaffold never substitutes for a grounded attack/keep-distance response.
//
//        NAMED RESIDUAL (NOT fixed here, and deliberately not): when the chosen
//        action was WORK, the tick can still end actionless while the in-flight dig
//        keeps running - controller.ts:3408 looks the chosen id up in the
//        RESTRICTED offer, threat.ts#survivalControlFallback answers
//        `not_a_survival_action` for a null reground kind BEFORE it looks at
//        contact, and controller.ts:3539 returns. That boundary is PINNED by
//        another lane's invariant (test-combat-closure.mts case A3: "a non-survival
//        choice is untouched by this rule", `otherFallback.reason ===
//        'not_a_survival_action'` with threatInContact true), landed by
//        task/skill-commitment-phase1. Reversing it from this lane would be a second
//        combat rule; the owning lane must make that call. What this lane guarantees
//        is the half below: the work set is removed, the offer stays a survival set,
//        and the gap is typed.
//
// NO fortress / Nether / M3 branch, coordinate or goal test exists in the
// mechanism: every case below only ever names the goal's own target cell, the
// sensor's own probe, and the block the body holds.
//
// Run: bun jev-agent/test-fortress-approach.mts
import { readFileSync } from 'node:fs'
import { Vec3 } from 'vec3'
import {
  BRIDGE_MAX_SPAN,
  BRIDGE_PROBE_DEPTH,
  bridgeDirOffset,
  formatBridgeRefused,
  formatBridgeStart,
  planBridgeRoute,
  planBridgeSpan,
} from './src/bridgeRoute.ts'
import type { BridgeDir, BridgeProbe } from './src/bridgeRoute.ts'
import { probeBridgeDirection } from './src/state.ts'
import type { DescentOption, Vec3Json, WorldState } from './src/state.ts'
import { groundWallEntries } from './src/wallEntry.ts'
import type { WallCell, WallProbe } from './src/wallEntry.ts'
import { groundLevelScan } from './src/levelScan.ts'
import type { LevelLateralFacts, LevelScanProbe } from './src/levelScan.ts'
import { applyThreatRestriction } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

// ---------------------------------------------------------------------------
// A modelled world with a real `blockAt`, so the REAL sensor reader
// (`state.ts#probeBridgeDirection`, including its face-adjacency flood read)
// classifies the same blocks the live body saw.
// ---------------------------------------------------------------------------

const SOLID = new Set(['soul_soil', 'soul_sand', 'basalt', 'blackstone', 'netherrack', 'nether_bricks', 'cobblestone', 'stone', 'dirt', 'gravel'])
const FLUID = new Set(['lava', 'water'])
const TRANSFER = new Set(['nether_portal', 'end_portal'])

interface FakeBlock {
  name: string
  boundingBox: string
  diggable: boolean
}

function blockOf(name: string | null): FakeBlock | null {
  if (name === null) return null
  if (FLUID.has(name)) return { name, boundingBox: 'empty', diggable: false }
  // A lit portal plane is passable (an empty bounding box) - that is exactly why the
  // sensor carries the transfer fact separately from `open`.
  if (TRANSFER.has(name)) return { name, boundingBox: 'empty', diggable: false }
  if (SOLID.has(name)) return { name, boundingBox: 'block', diggable: true }
  return { name, boundingBox: 'empty', diggable: false }
}

/** A block map: key `x,y,z` -> name; absent = air. `unloaded` cells read `null`. */
type BlockMap = Map<string, string>

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`

function fakeBot(map: BlockMap, unloaded: ReadonlySet<string>, feet: Vec3Json): never {
  return {
    entity: { position: new Vec3(feet.x + 0.5, feet.y, feet.z + 0.5) },
    blockAt: (at: { x: number; y: number; z: number }) => {
      const k = key(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z))
      if (unloaded.has(k)) return null
      return blockOf(map.get(k) ?? 'air')
    },
  } as never
}

function probesFor(map: BlockMap, feet: Vec3Json, unloaded: ReadonlySet<string> = new Set()): BridgeProbe[] {
  const bot = fakeBot(map, unloaded, feet)
  return (['E', 'W', 'N', 'S'] as BridgeDir[]).map((dir) => probeBridgeDirection(bot, feet, dir, BRIDGE_PROBE_DEPTH))
}

function planFor(
  map: BlockMap,
  feet: Vec3Json,
  target: Vec3Json,
  placeable: { name: string; count: number } | null,
  unloaded: ReadonlySet<string> = new Set(),
) {
  return planBridgeRoute({
    selfFeet: feet,
    target,
    probes: probesFor(map, feet, unloaded),
    placeable,
    maxSpan: BRIDGE_MAX_SPAN,
  })
}

const dist = (a: Vec3Json, b: Vec3Json): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const round2 = (v: number): number => Math.round(v * 100) / 100

// ---------------------------------------------------------------------------
// (i) THE MEASURED SHAPE: the body on the ground's east edge, the lava basin 28
// blocks below the span, the fortress fabric 9 east / 1 up.
// ---------------------------------------------------------------------------

const GROUND_X_MAX = 28
const SPAN_Z = -20
const GROUND_FEET_Y = 59
const GROUND_FLOOR_NAME = 'soul_soil'
const BASIN_TOP_Y = 31
const FABRIC: Vec3Json = { x: 37, y: 59, z: SPAN_Z }
const FABRIC_NAME = 'nether_bricks'

/**
 * The measured world: ground at x<=28 for z=-20..-1 (floor soul_soil at
 * feet-1), lava from y=0..31 everywhere in the span, open air above it, and the
 * single nether_bricks fabric cell at (37,59,-20).
 */
function measuredMap(): BlockMap {
  const map: BlockMap = new Map()
  for (let y = 0; y <= BASIN_TOP_Y; y += 1) {
    for (let x = GROUND_X_MAX - 8; x <= GROUND_X_MAX + 12; x += 1) {
      for (let z = SPAN_Z - 4; z <= SPAN_Z + 6; z += 1) map.set(key(x, y, z), y === BASIN_TOP_Y ? 'lava' : 'basalt')
    }
  }
  for (let x = 0; x <= GROUND_X_MAX; x += 1) {
    for (let z = SPAN_Z; z <= -1; z += 1) {
      map.set(key(x, GROUND_FEET_Y - 1, z), GROUND_FLOOR_NAME)
      map.set(key(x, GROUND_FEET_Y - 2, z), 'basalt')
      map.set(key(x, GROUND_FEET_Y, z), 'air')
      map.set(key(x, GROUND_FEET_Y + 1, z), 'air')
    }
  }
  // the fortress pier: the fabric cell the goal's own target names
  map.set(key(FABRIC.x, FABRIC.y, FABRIC.z), FABRIC_NAME)
  return map
}

const BODY: Vec3Json = { x: GROUND_X_MAX, y: GROUND_FEET_Y, z: SPAN_Z }
const HELD = { name: 'cobblestone', count: 378 }

check(
  '(i1) the measured span grounds a SELF-LANDING scaffold toward the fortress fabric',
  (() => {
    const decision = planFor(measuredMap(), BODY, FABRIC, HELD)
    const plan = decision.plan
    if (plan === null) return false
    return (
      plan.selfLanding === true &&
      plan.span === 1 &&
      plan.dir === 'E' &&
      plan.landing.x === GROUND_X_MAX + 1 &&
      plan.landing.y === GROUND_FEET_Y &&
      plan.place.x === GROUND_X_MAX + 1 &&
      plan.place.y === GROUND_FEET_Y - 1 &&
      plan.far.x === plan.landing.x &&
      plan.to < plan.from &&
      plan.line.includes('self_landing=true') &&
      plan.line.includes(`floor=${plan.place.x},${plan.place.y},${plan.place.z}:${HELD.name}:placed`) &&
      plan.line.includes('flood=none')
    )
  })(),
  (() => {
    const decision = planFor(measuredMap(), BODY, FABRIC, HELD)
    const plan = decision.plan
    if (plan === null) return `refused: ${formatBridgeRefused(decision.refusal)}`
    return (
      `dir=${plan.dir} span=${plan.span} self_landing=${String(plan.selfLanding)} ` +
      `landing=${plan.landing.x},${plan.landing.y},${plan.landing.z} place=${plan.place.x},${plan.place.y},${plan.place.z} ` +
      `far=${plan.far.x},${plan.far.y},${plan.far.z} from=${round2(plan.from)} to=${round2(plan.to)} ` +
      `alternatives=[${decision.alternatives.map((a) => `${a.dir}:${a.span}`).join(',')}]\n      line="${plan.line}"`
    )
  })(),
)

check(
  '(i2) walking the rule across the span reaches the structure EDGE, strictly closing the distance every step',
  (() => {
    // The real loop a tick performs: probe from the live feet cell, ground the
    // step, execute it (the executor places and steps onto the landing), repeat.
    let feet: Vec3Json = { ...BODY }
    const map = measuredMap()
    const trail: string[] = []
    let blocks = HELD.count
    for (let step = 0; step < 12; step += 1) {
      if (dist(feet, FABRIC) <= 1.5) break
      const decision = planFor(map, feet, FABRIC, { name: HELD.name, count: blocks })
      const plan = decision.plan
      if (plan === null || plan.selfLanding !== true) return false
      if (!(plan.to < plan.from)) return false
      // execute: the block lands in the placement cell, the body steps onto it
      map.set(key(plan.place.x, plan.place.y, plan.place.z), HELD.name)
      blocks -= plan.span
      trail.push(`${feet.x},${feet.y},${feet.z}->${plan.landing.x},${plan.landing.y},${plan.landing.z} d=${round2(plan.from)}->${round2(plan.to)}`)
      feet = { ...plan.landing }
    }
    return feet.x === FABRIC.x - 1 && feet.y === GROUND_FEET_Y && dist(feet, FABRIC) <= 1.5 && blocks === HELD.count - (FABRIC.x - 1 - GROUND_X_MAX)
  })(),
  (() => {
    let feet: Vec3Json = { ...BODY }
    const map = measuredMap()
    const trail: string[] = []
    let blocks = HELD.count
    for (let step = 0; step < 12; step += 1) {
      if (dist(feet, FABRIC) <= 1.5) break
      const decision = planFor(map, feet, FABRIC, { name: HELD.name, count: blocks })
      const plan = decision.plan
      if (plan === null || plan.selfLanding !== true) {
        trail.push(`step${step} refused=${plan === null ? formatBridgeRefused(decision.refusal) : 'not-self-landing'}`)
        break
      }
      map.set(key(plan.place.x, plan.place.y, plan.place.z), HELD.name)
      blocks -= plan.span
      trail.push(`${feet.x},${feet.y},${feet.z}->${plan.landing.x},${plan.landing.y},${plan.landing.z} d=${round2(plan.from)}->${round2(plan.to)}`)
      feet = { ...plan.landing }
    }
    return (
      `body=${feet.x},${feet.y},${feet.z} fabric=${FABRIC.x},${FABRIC.y},${FABRIC.z} d=${round2(dist(feet, FABRIC))} ` +
      `blocks=${blocks} steps=${trail.length}\n      ${trail.join('\n      ')}`
    )
  })(),
)

check(
  '(i3) the step after the edge is NOT a bridge: the fabric column is a DIG, so the scaffold stops at the structure',
  (() => {
    const atEdge: Vec3Json = { x: FABRIC.x - 1, y: GROUND_FEET_Y, z: SPAN_Z }
    const map = measuredMap()
    map.set(key(atEdge.x, GROUND_FEET_Y - 1, SPAN_Z), HELD.name)
    const bot = fakeBot(map, new Set(), atEdge)
    const east = probeBridgeDirection(bot, atEdge, 'E', BRIDGE_PROBE_DEPTH)
    const decision = planFor(map, atEdge, FABRIC, HELD)
    // the east column's landing is the solid fabric cell: not a gap
    return decision.plan === null && east.cells[0]?.open === false && east.cells[0]?.cellName === FABRIC_NAME
  })(),
  (() => {
    const atEdge: Vec3Json = { x: FABRIC.x - 1, y: GROUND_FEET_Y, z: SPAN_Z }
    const map = measuredMap()
    map.set(key(atEdge.x, GROUND_FEET_Y - 1, SPAN_Z), HELD.name)
    const east = probeBridgeDirection(fakeBot(map, new Set(), atEdge), atEdge, 'E', BRIDGE_PROBE_DEPTH)
    const decision = planFor(map, atEdge, FABRIC, HELD)
    return (
      `eastCell=${east.cells[0]?.cell.x},${east.cells[0]?.cell.y},${east.cells[0]?.cell.z} block=${String(east.cells[0]?.cellName)} ` +
      `open=${String(east.cells[0]?.open)} plan=${decision.plan === null ? 'none (not_a_gap / refused)' : decision.plan.dir}`
    )
  })(),
)

check(
  '(i4) the same shape with nothing held is a typed no_block, never an invented route',
  (() => {
    const decision = planFor(measuredMap(), BODY, FABRIC, null)
    return decision.plan === null && decision.refusal.reason === 'no_block'
  })(),
  (() => {
    const decision = planFor(measuredMap(), BODY, FABRIC, null)
    return decision.plan === null ? formatBridgeRefused(decision.refusal) : `plan=${decision.plan.dir}`
  })(),
)

// ---------------------------------------------------------------------------
// (ii) ORDINARY TERRAIN IS BYTE-IDENTICAL (a verified far side, and open ground)
// ---------------------------------------------------------------------------

/** A 1-wide hole with a verified far side (the historical BRIDGE_PROBE case). */
function gapMap(): BlockMap {
  const map: BlockMap = new Map()
  for (let y = 0; y <= 4; y += 1) {
    for (let x = -2; x <= 12; x += 1) for (let z = -2; z <= 2; z += 1) map.set(key(x, y, z), 'stone')
  }
  for (let x = 1; x <= 3; x += 1) {
    for (let y = 5; y <= 6; y += 1) for (let z = -2; z <= 2; z += 1) map.set(key(x, y, z), 'air')
  }
  for (let x = 1; x <= 3; x += 1) map.set(key(x, 4, 0), 'air')
  for (let x = 4; x <= 12; x += 1) for (let z = -2; z <= 2; z += 1) map.set(key(x, 4, z), 'stone')
  return map
}

check(
  '(ii1) a verified far side is still a verified span: `self_landing` is absent and BRIDGE_START is unchanged',
  (() => {
    const feet: Vec3Json = { x: 0, y: 5, z: 0 }
    const target: Vec3Json = { x: 8, y: 5, z: 0 }
    const decision = planFor(gapMap(), feet, target, HELD)
    const plan = decision.plan
    if (plan === null) return false
    return (
      plan.selfLanding === undefined &&
      plan.pocketEvidence === undefined &&
      plan.span >= 1 &&
      formatBridgeStart({ cell: plan.landing, block: plan.block, span: plan.span, remaining: plan.remaining }) ===
        'BRIDGE_START cell=1,5,0 block=cobblestone span=3 remaining=375'
    )
  })(),
  (() => {
    const decision = planFor(gapMap(), { x: 0, y: 5, z: 0 }, { x: 8, y: 5, z: 0 }, HELD)
    const plan = decision.plan
    if (plan === null) return `refused: ${formatBridgeRefused(decision.refusal)}`
    return `span=${plan.span} self_landing=${String(plan.selfLanding)} line="${plan.line}"`
  })(),
)

check(
  '(ii2) already-walkable ground grounds no scaffold at all (the walk owns the step)',
  (() => {
    const map = new Map<string, string>()
    for (let x = -4; x <= 12; x += 1) {
      for (let z = -4; z <= 4; z += 1) {
        map.set(key(x, 4, z), 'stone')
        map.set(key(x, 5, z), 'air')
        map.set(key(x, 6, z), 'air')
      }
    }
    const decision = planFor(map, { x: 0, y: 5, z: 0 }, { x: 8, y: 5, z: 0 }, HELD)
    return decision.plan === null
  })(),
  (() => {
    const map = new Map<string, string>()
    for (let x = -4; x <= 12; x += 1) {
      for (let z = -4; z <= 4; z += 1) {
        map.set(key(x, 4, z), 'stone')
        map.set(key(x, 5, z), 'air')
        map.set(key(x, 6, z), 'air')
      }
    }
    const decision = planFor(map, { x: 0, y: 5, z: 0 }, { x: 8, y: 5, z: 0 }, HELD)
    return `plan=${decision.plan === null ? 'none' : decision.plan.dir} refusal=${decision.refusal === null ? 'none' : formatBridgeRefused(decision.refusal)}`
  })(),
)

// ---------------------------------------------------------------------------
// (iii) NO GROUNDED ROUTE -> TYPED, WITH THE LEDGER; NEVER AN INVENTED ROUTE
// ---------------------------------------------------------------------------

/** The measured span, but the first placement cell's side neighbour is lava. */
function lavaPocketMap(): BlockMap {
  const map = measuredMap()
  map.set(key(GROUND_X_MAX + 1, GROUND_FEET_Y, SPAN_Z + 1), 'lava')
  return map
}

check(
  '(iii1) a fluid FACE-ADJACENT to the scaffold pocket is refused `would_flood` with the fluid cell named',
  (() => {
    const decision = planFor(lavaPocketMap(), BODY, FABRIC, HELD)
    return (
      decision.plan === null &&
      decision.refusal.reason === 'would_flood' &&
      formatBridgeRefused(decision.refusal).includes(`cell=${GROUND_X_MAX + 1},${GROUND_FEET_Y},${SPAN_Z + 1}`) &&
      formatBridgeRefused(decision.refusal).includes('block=lava')
    )
  })(),
  (() => {
    const decision = planFor(lavaPocketMap(), BODY, FABRIC, HELD)
    return decision.plan === null ? formatBridgeRefused(decision.refusal) : `plan=${decision.plan.dir}`
  })(),
)

check(
  '(iii2) a transfer plane in the scaffold pocket is refused `portal_plane` (a mechanical step never crosses a dimension)',
  (() => {
    const map = measuredMap()
    map.set(key(GROUND_X_MAX + 1, GROUND_FEET_Y + 1, SPAN_Z), 'nether_portal')
    const decision = planFor(map, BODY, FABRIC, HELD)
    return decision.plan === null && decision.refusal.reason === 'portal_plane'
  })(),
  (() => {
    const map = measuredMap()
    map.set(key(GROUND_X_MAX + 1, GROUND_FEET_Y + 1, SPAN_Z), 'nether_portal')
    const decision = planFor(map, BODY, FABRIC, HELD)
    return decision.plan === null ? formatBridgeRefused(decision.refusal) : `plan=${decision.plan.dir}`
  })(),
)

check(
  '(iii3) a probe with no sensed pocket read cannot ground a scaffold: the PRE-EXISTING verdict stands (here `budget`)',
  (() => {
    // A probe that carries NO face-adjacency flood read for the first column: the
    // shared rule cannot prove the pocket dry, and a step that creates the floor the
    // body stands on is never taken on an unproven pocket. The live sensor always
    // fills the fact (`state.ts#probeBridgeDirection`); a hand-built probe that omits
    // it falls through to the pre-existing verdict, so no existing caller's answer
    // changes (this is exactly the shape test-bridge-scaffold's own probes have).
    const feet: Vec3Json = { x: 0, y: 60, z: 0 }
    const target: Vec3Json = { x: 9, y: 60, z: 0 }
    const cells = [1, 2, 3, 4, 5, 6].map((step) => ({
      cell: { x: step, y: 60, z: 0 },
      floor: { x: step, y: 59, z: 0 },
      open: true,
      headOpen: true,
      placeable: true,
      supported: false,
      standable: false,
      hazard: false,
      cellName: 'air',
      floorName: 'air',
      headName: 'air',
    }))
    const decision = planBridgeSpan({
      probe: { dir: 'E', dx: 1, dz: 0, cells, footing: true },
      selfFeet: feet,
      target,
      placeBlockName: HELD.name,
    })
    // Exactly the pre-change verdict for this geometry: the span is wider than the
    // bounded budget, and without a sensed pocket read no scaffold is invented.
    return decision.kind === 'refuse' && decision.refusal.reason === 'budget'
  })(),
  (() => {
    const feet: Vec3Json = { x: 0, y: 60, z: 0 }
    const target: Vec3Json = { x: 9, y: 60, z: 0 }
    const cells = [1, 2, 3, 4, 5, 6].map((step) => ({
      cell: { x: step, y: 60, z: 0 },
      floor: { x: step, y: 59, z: 0 },
      open: true,
      headOpen: true,
      placeable: true,
      supported: false,
      standable: false,
      hazard: false,
      cellName: 'air',
      floorName: 'air',
      headName: 'air',
    }))
    const decision = planBridgeSpan({
      probe: { dir: 'E', dx: 1, dz: 0, cells, footing: true },
      selfFeet: feet,
      target,
      placeBlockName: HELD.name,
    })
    return decision.kind === 'refuse' ? formatBridgeRefused(decision.refusal) : `kind=${decision.kind}`
  })(),
)

check(
  '(iii3b) an UNLOADED landing column is the sensor\'s own `landing_column_blocked`: no gap, no scaffold into the unknown',
  (() => {
    const unloaded = new Set([key(GROUND_X_MAX + 1, GROUND_FEET_Y, SPAN_Z)])
    const bot = fakeBot(measuredMap(), unloaded, BODY)
    const east = probeBridgeDirection(bot, BODY, 'E', BRIDGE_PROBE_DEPTH)
    const decision = planBridgeSpan({
      probe: east,
      selfFeet: BODY,
      target: FABRIC,
      placeBlockName: HELD.name,
    })
    const whole = planFor(measuredMap(), BODY, FABRIC, HELD, unloaded)
    return decision.kind === 'not_a_gap' && decision.reason === 'landing_column_blocked' && whole.plan === null
  })(),
  (() => {
    const unloaded = new Set([key(GROUND_X_MAX + 1, GROUND_FEET_Y, SPAN_Z)])
    const east = probeBridgeDirection(fakeBot(measuredMap(), unloaded, BODY), BODY, 'E', BRIDGE_PROBE_DEPTH)
    const decision = planBridgeSpan({ probe: east, selfFeet: BODY, target: FABRIC, placeBlockName: HELD.name })
    const whole = planFor(measuredMap(), BODY, FABRIC, HELD, unloaded)
    return (
      `eastVerdict=${decision.kind === 'not_a_gap' ? decision.reason : decision.kind} ` +
      `open=${String(east.cells[0]?.open)} headOpen=${String(east.cells[0]?.headOpen)} cellName=${String(east.cells[0]?.cellName)} ` +
      `wholePlan=${whole.plan === null ? 'none' : whole.plan.dir}`
    )
  })(),
)

function wallCell(cell: Vec3Json, name: string | null, open: boolean): WallCell {
  return { cell, name, open, solid: !open, breakable: !open, observed: name !== null }
}

const wallStep = { dir: 'E', mode: 'level', dx: 1, dz: 0, step: { x: 0, y: 0, z: 0 }, wall: { x: 0, y: 0, z: 0 }, head: { x: 0, y: 0, z: 0 }, floor: { x: 0, y: 0, z: 0 }, wallSolid: false, headSolid: false, floorSolid: false, safe: false, reason: 'probe' } as unknown as DescentOption

check(
  '(iii4) the dig family still answers `no_grounded_route` WITH its per-direction ledger (no invented route)',
  (() => {
    const self: Vec3Json = { x: 0, y: 60, z: 0 }
    const target: Vec3Json = { x: 9, y: 60, z: 0 }
    const walls: WallProbe[] = (['E', 'W', 'N', 'S'] as const).map((dir) => {
      const { dx, dz } = bridgeDirOffset(dir)
      const landing = { x: self.x + dx, y: self.y, z: self.z + dz }
      return {
        dir,
        mode: 'level',
        dx,
        dz,
        landing,
        // every direction is already open passage: nothing to open, nothing to stand on
        pocket: [wallCell(landing, 'air', true), wallCell({ x: landing.x, y: landing.y + 1, z: landing.z }, 'air', true)],
        floor: wallCell({ x: landing.x, y: landing.y - 1, z: landing.z }, 'air', true),
        flood: false,
        floodCell: null,
        floodBlock: null,
        step: wallStep,
      }
    })
    const decision = groundWallEntries({ selfPosition: self, target, walls, minAdvance: 0.25 })
    if (decision.kind !== 'refuse') return false
    return (
      decision.refusal.reason === 'no_grounded_route' &&
      decision.refusal.detail.includes('ledger:') &&
      decision.refusal.detail.includes('E=no_wall') &&
      decision.refusal.detail.includes('W=no_wall') &&
      decision.refusal.detail.includes('N=no_wall') &&
      decision.refusal.detail.includes('S=no_wall')
    )
  })(),
  (() => {
    const self: Vec3Json = { x: 0, y: 60, z: 0 }
    const target: Vec3Json = { x: 9, y: 60, z: 0 }
    const walls: WallProbe[] = (['E', 'W', 'N', 'S'] as const).map((dir) => {
      const { dx, dz } = bridgeDirOffset(dir)
      const landing = { x: self.x + dx, y: self.y, z: self.z + dz }
      return {
        dir,
        mode: 'level',
        dx,
        dz,
        landing,
        pocket: [wallCell(landing, 'air', true), wallCell({ x: landing.x, y: landing.y + 1, z: landing.z }, 'air', true)],
        floor: wallCell({ x: landing.x, y: landing.y - 1, z: landing.z }, 'air', true),
        flood: false,
        floodCell: null,
        floodBlock: null,
        step: wallStep,
      }
    })
    const decision = groundWallEntries({ selfPosition: self, target, walls, minAdvance: 0.25 })
    return decision.kind === 'refuse' ? `reason=${decision.refusal.reason} detail=${decision.refusal.detail}` : `grounded=${decision.routes.length}`
  })(),
)

check(
  '(iii5) the level scan still refuses with its per-LEVEL ledger when the shaft under the body is unsupported',
  (() => {
    const self: Vec3Json = { x: 0, y: 60, z: 0 }
    const target: Vec3Json = { x: 9, y: 60, z: 0 }
    const lateral = (dir: 'E' | 'W' | 'N' | 'S'): LevelLateralFacts => {
      const { dx, dz } = bridgeDirOffset(dir)
      const cell = { x: self.x + dx, y: self.y - 1, z: self.z + dz }
      return {
        dir,
        dx,
        dz,
        cell,
        landing: cell,
        pocket: [wallCell(cell, 'air', true), wallCell({ x: cell.x, y: cell.y + 1, z: cell.z }, 'air', true)],
        floor: wallCell({ x: cell.x, y: cell.y - 1, z: cell.z }, 'air', true),
        flood: false,
        floodCell: null,
        floodBlock: null,
        walk: false,
      }
    }
    const levels: LevelScanProbe[] = [
      {
        y: self.y - 1,
        depth: 1,
        shaft: {
          landing: { x: self.x, y: self.y - 1, z: self.z },
          pocket: [wallCell({ x: self.x, y: self.y - 1, z: self.z }, 'soul_soil', false), wallCell({ x: self.x, y: self.y, z: self.z }, 'air', true)],
          floor: wallCell({ x: self.x, y: self.y - 2, z: self.z }, 'air', true),
          flood: false,
          floodCell: null,
          floodBlock: null,
          sensorRefusal: 'no_support',
        },
        laterals: [lateral('E'), lateral('W'), lateral('N'), lateral('S')],
      },
    ]
    const decision = groundLevelScan({ selfPosition: self, target, levels, minAdvance: 0.25 })
    if (decision.kind !== 'refuse') return false
    return decision.refusal.reason === 'no_support' && decision.refusal.detail.includes('levels:')
  })(),
  (() => {
    const self: Vec3Json = { x: 0, y: 60, z: 0 }
    const target: Vec3Json = { x: 9, y: 60, z: 0 }
    const lateral = (dir: 'E' | 'W' | 'N' | 'S'): LevelLateralFacts => {
      const { dx, dz } = bridgeDirOffset(dir)
      const cell = { x: self.x + dx, y: self.y - 1, z: self.z + dz }
      return {
        dir,
        dx,
        dz,
        cell,
        landing: cell,
        pocket: [wallCell(cell, 'air', true), wallCell({ x: cell.x, y: cell.y + 1, z: cell.z }, 'air', true)],
        floor: wallCell({ x: cell.x, y: cell.y - 1, z: cell.z }, 'air', true),
        flood: false,
        floodCell: null,
        floodBlock: null,
        walk: false,
      }
    }
    const levels: LevelScanProbe[] = [
      {
        y: self.y - 1,
        depth: 1,
        shaft: {
          landing: { x: self.x, y: self.y - 1, z: self.z },
          pocket: [wallCell({ x: self.x, y: self.y - 1, z: self.z }, 'soul_soil', false), wallCell({ x: self.x, y: self.y, z: self.z }, 'air', true)],
          floor: wallCell({ x: self.x, y: self.y - 2, z: self.z }, 'air', true),
          flood: false,
          floodCell: null,
          floodBlock: null,
          sensorRefusal: 'no_support',
        },
        laterals: [lateral('E'), lateral('W'), lateral('N'), lateral('S')],
      },
    ]
    const decision = groundLevelScan({ selfPosition: self, target, levels, minAdvance: 0.25 })
    return decision.kind === 'refuse' ? `reason=${decision.refusal.reason} detail=${decision.refusal.detail}` : `grounded=${decision.routes.length}`
  })(),
)

// ---------------------------------------------------------------------------
// (iv) A HOSTILE IN MELEE CONTACT WHILE THE BODY IS ON A WORK COMMITMENT
//
// This lane adds NO second combat rule. The contact/danger restriction
// (`candidates.ts#applyThreatRestriction`, `CONTACT_THREAT_KINDS`,
// `THREAT_SURVIVAL_KINDS`) owns "what may be offered while a hostile is on the
// body"; the mob-identity-churn rule is another lane's (task/mob-identity-churn).
// The assertions below only lock the INTERACTION this lane must not break: a
// scaffold/dig leg is WORK, so a contacting mob removes it exactly like every
// other work candidate, the offer stays a survival set, and the scaffold can
// never stand in for a grounded attack or keep-distance response.
// ---------------------------------------------------------------------------

function workCandidate(id: string, kind: Candidate['kind']): Candidate {
  return {
    id,
    kind,
    label: id,
    targetName: null,
    target: { x: 1, y: 60, z: 0 },
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: {},
  } as unknown as Candidate
}

const contactState = {
  entities: [
    {
      id: 52841,
      name: 'magma_cube',
      kind: 'magma_cube',
      username: null,
      position: { x: 1, y: 60, z: 0 },
      distance: 1.2,
      hostile: true,
      lineOfSight: true,
      heldItem: null,
      health: 16,
      attackedSelf: true,
    },
  ],
  signals: {},
  timestampMs: 1_700_000_000_000,
} as unknown as Pick<WorldState, 'entities' | 'signals' | 'timestampMs'>

check(
  '(iv1) a contacting mob removes the scaffold/dig WORK candidate from the offer (the existing rule, not a new one)',
  (() => {
    const offer = [
      workCandidate('BRIDGE:E:p29_59_-20', 'MOVE'),
      workCandidate('DIG_ROUTE:level:E:b30_59_-20', 'DESCEND'),
      workCandidate('ATTACK:e52841', 'ATTACK'),
      workCandidate('RETREAT:p26_59_-20', 'RETREAT'),
      workCandidate('WAIT', 'WAIT'),
    ]
    const restricted = applyThreatRestriction(contactState, offer)
    const ids = restricted.candidates.map((c) => c.id)
    return (
      restricted.inContact === true &&
      !ids.includes('BRIDGE:E:p29_59_-20') &&
      !ids.includes('DIG_ROUTE:level:E:b30_59_-20') &&
      !ids.includes('WAIT') &&
      ids.includes('ATTACK:e52841') &&
      ids.includes('RETREAT:p26_59_-20') &&
      restricted.gap === null
    )
  })(),
  (() => {
    const offer = [
      workCandidate('BRIDGE:E:p29_59_-20', 'MOVE'),
      workCandidate('DIG_ROUTE:level:E:b30_59_-20', 'DESCEND'),
      workCandidate('ATTACK:e52841', 'ATTACK'),
      workCandidate('RETREAT:p26_59_-20', 'RETREAT'),
      workCandidate('WAIT', 'WAIT'),
    ]
    const restricted = applyThreatRestriction(contactState, offer)
    return `contact=${String(restricted.inContact)} offer=[${restricted.candidates.map((c) => c.id).join(' ')}] removed=[${offer
      .filter((c) => !restricted.candidates.some((k) => k.id === c.id))
      .map((c) => c.id)
      .join(' ')}] gap=${restricted.gap === null ? 'none' : restricted.gap.reason}`
  })(),
)

check(
  '(iv2) with no grounded attack/keep-distance response the gap is TYPED, and it is a capability gap - not the work set',
  (() => {
    const restricted = applyThreatRestriction(contactState, [workCandidate('BRIDGE:E:p29_59_-20', 'MOVE'), workCandidate('WAIT', 'WAIT')])
    return (
      restricted.candidates.length === 1 &&
      restricted.candidates[0]?.kind === 'ESCALATE' &&
      restricted.gap?.reason === 'no_grounded_threat_response' &&
      !restricted.candidates.some((c) => c.id === 'BRIDGE:E:p29_59_-20')
    )
  })(),
  (() => {
    const restricted = applyThreatRestriction(contactState, [workCandidate('BRIDGE:E:p29_59_-20', 'MOVE'), workCandidate('WAIT', 'WAIT')])
    return `offer=[${restricted.candidates.map((c) => `${c.id}:${c.kind}`).join(' ')}] gap=${restricted.gap === null ? 'none' : restricted.gap.reason}`
  })(),
)

// ---------------------------------------------------------------------------
// the mechanism carries no fortress / Nether / M3 vocabulary of its own
// ---------------------------------------------------------------------------

check(
  '(v) the new rule names no world, structure or goal: only cells, blocks and the shared per-cell verdict',
  (() => {
    const source = [
      readFileSync(new URL('./src/bridgeRoute.ts', import.meta.url), 'utf8'),
    ].join('\n')
    // Anchor on the DEFINITION, not the first mention: the module header links the
    // function by name and its prose deliberately names the measured world.
    const scaffoldRegion = source.slice(
      source.indexOf('export function scaffoldPocketRefusal'),
      source.indexOf('function selfLandingPocketEvidence'),
    )
    return (
      !/fortress|nether|blaze|m3/i.test(scaffoldRegion) &&
      scaffoldRegion.includes('wallPocketOccupationRefusal') &&
      scaffoldRegion.includes('wallPocketFloodRefusal')
    )
  })(),
  'the self-landing rule composes wallEntry.ts#wallPocketOccupationRefusal + #wallPocketFloodRefusal and names no world or goal',
)

process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${failures === 0 ? 'ALL FORTRESS-APPROACH FIXTURES PASS' : `${failures} FORTRESS-APPROACH FIXTURE(S) FAILED`}\n`)
if (failures > 0) process.exit(1)
