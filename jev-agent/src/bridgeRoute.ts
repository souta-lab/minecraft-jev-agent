// bridgeRoute.ts - the general BRIDGE/scaffold MOVE mechanic.
//
// OPERATOR PROPOSAL (2026-09-23, watching the live body at the edge of the Nether
// lava lake), evaluated and adopted here as a general MOVE mechanic:
//
//   "橋をscaffolding的にやるっていう選択肢がない"  - no bridge/scaffold option exists
//   "人間が使うPVP clientくらいのズルなら許容される" - forgiving timing/precision is OK
//   "ジャンプとか橋渡しとか塔をたてるのも結局MOVEに一般化できそう"
//
// The allowance is about TIMING/PRECISION (place-then-step in quick succession,
// exactly what a human PvP client or an ordinary fast clicker does). It is NOT
// permission for packet hacks, client mods or bypassing the server's physics: every
// placement below goes through `bot.placeBlock` against a real adjacent face, and
// every advance goes through the ordinary walk, so the server validates all of it.
//
// WHY a bridge was not groundable at all before (measured, file:line):
//
//   * `state.ts#buildPlacementSpots` (state.ts:2864-2866) scanned `dy in {0,1}`
//     relative to the feet, so the FLOOR cell of a hole beside the body
//     (`feet.y - 1`) was never a sensed placement spot;
//   * `state.ts#buildDescent` (state.ts:2596-2605) refuses a same-level step with
//     `refusal: 'no_support'` the moment the front cell's floor is not solid -
//     i.e. the sensor NAMED the gap, but nothing could act on that name;
//   * every walk arm (`candidates.ts#travelApproachLegs`) can only ground a stand
//     cell the sensor already believes is standable, so "the route needs to cross
//     a hole" had no candidate of any kind.
//
// WHAT THIS MODULE OWNS (and nothing else does):
//
//   * the ONE rule for "may this cell be bridged onto, and is the far side
//     verified": {@link planBridgeSpan};
//   * the typed refusals: `no_block | no_verified_landing | hazard | protected |
//     budget`;
//   * the typed markers `BRIDGE_START` / `BRIDGE_STEP` / `BRIDGE_END` /
//     `BRIDGE_REFUSED`, carried in candidate meta and mirrored by the controller.
//
// It is deliberately NOT a "stuck" recovery: it is grounded on the sensor's own
// typed no-support step plus a bounded forward probe, it is enumerated as an
// ordinary MOVE-family candidate beside the walk leg / dig route, and when more
// than one semantic remedy class is available the caller stops at
// `SKILL_POLICY_BOUNDARY` (#436 section 22 forbids `if stuck -> bridge` trees).
//
// Pure: no bot, no clock, no model. The live executor feeds the SAME rule a probe
// built by the SAME sensor function (`state.ts#probeBridgeDirection`), so the
// offered span and the executed span cannot drift apart.

import type { Vec3Json } from './state.ts'
import { ENV_FIRE_BLOCKS, ENV_LAVA_BLOCKS } from './envHazard.ts'

/**
 * The candidate-meta key that marks a MOVE as a bridge/scaffold leg. The value is
 * a boolean; every other bridge fact lives in its own key below so the contract
 * can audit the effect (this leg WILL place blocks) without parsing prose.
 */
export const BRIDGE_META = 'bridge'
/** The cardinal direction the bridge advances in (`E`/`W`/`N`/`S`). */
export const BRIDGE_DIR_META = 'bridgeDir'
/** The item one bridge step consumes (the first held `PILLAR_PLACE_PRIORITY` block). */
export const BRIDGE_BLOCK_META = 'bridgeBlock'
/** How many placements this leg's verified span needs (the bounded budget). */
export const BRIDGE_SPAN_META = 'bridgeSpan'
/** The verified standable far side this leg must reach (equals `candidate.target`). */
export const BRIDGE_TARGET_META = 'bridgeTarget'
/**
 * #436 section 5: a Skill declares an `EffectEnvelope`. A MOVE that may place
 * blocks must DECLARE it, so this key is the machine-readable half of the
 * declaration and `BRIDGE_BLOCK_META` names the block it will consume.
 */
export const BRIDGE_MAY_PLACE_META = 'mayPlaceBlocks'
/** The `BRIDGE_START` line the offer carries and the controller mirrors. */
export const BRIDGE_LINE_META = 'bridgeLine'
/** The section 17 `SKILL_STEP ... authority=` line for the bridge step. */
export const BRIDGE_AUTHORITY_META = 'bridgeAuthorityLine'
/** The typed `BRIDGE_REFUSED` line when a bridge was needed but not groundable. */
export const BRIDGE_REFUSED_META = 'bridgeRefusedLine'

/** Block names a bridge may neither place into nor step into. */
export const BRIDGE_UNSAFE_BLOCKS: ReadonlySet<string> = new Set([
  // the canonical lava/fire sets (`envHazard.ts` owns the safety vocabulary)
  ...ENV_LAVA_BLOCKS,
  ...ENV_FIRE_BLOCKS,
  // flowing variants and the water/breath fluids (`state.ts PROBE_FLUIDS`)
  'flowing_lava',
  'water',
  'flowing_water',
  'bubble_column',
  // contact-damage flora the sensor already treats as hazards
  'cactus',
  'sweet_berry_bush',
])

/** True when a block name is something a bridge must not touch. */
export function isBridgeUnsafeBlockName(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.length > 0 && BRIDGE_UNSAFE_BLOCKS.has(name)
}

/** The bounded forward probe depth (`state.ts#probeBridgeDirection`). */
export const BRIDGE_PROBE_DEPTH = 4
/** The most blocks ONE bridge action may place (the bounded budget). */
export const BRIDGE_STEP_CAP = 6
/** The widest span a single bridge offer may declare as verified. */
export const BRIDGE_MAX_SPAN = 3
/** A bridge step must close at least this much distance to the leg target. */
export const BRIDGE_MIN_ADVANCE = 0.5

export type BridgeDir = 'E' | 'W' | 'N' | 'S'

/** The four cardinal probe directions, in the sensor's fixed enumeration order. */
export const BRIDGE_DIRS: readonly BridgeDir[] = ['E', 'W', 'N', 'S']

export function bridgeDirOffset(dir: BridgeDir): { dx: number; dz: number } {
  switch (dir) {
    case 'E':
      return { dx: 1, dz: 0 }
    case 'W':
      return { dx: -1, dz: 0 }
    case 'N':
      return { dx: 0, dz: -1 }
    case 'S':
      return { dx: 0, dz: 1 }
  }
}

export function isBridgeDir(value: unknown): value is BridgeDir {
  return value === 'E' || value === 'W' || value === 'N' || value === 'S'
}

/** One probed column ahead of the body: the live truth a bridge grounding needs. */
export interface BridgeProbeCell {
  /** the probed cell at the body's own feet level (the candidate landing) */
  cell: Vec3Json
  /** the cell below it: `cell.y - 1`, the bridge's placement target */
  floor: Vec3Json
  /** the feet cell is passable (empty bounding box) - `false` when unloaded */
  open: boolean
  /** the head cell (`cell.y + 1`) is passable */
  headOpen: boolean
  /** the floor cell is replaceable air: the ONLY thing the server lets a block be placed into */
  placeable: boolean
  /** the floor cell already holds solid, load-bearing support (no placement needed here) */
  supported: boolean
  /** a 1.8-tall body could stand here right now (the sensor's own destination rule) */
  standable: boolean
  /** lava/fire/water anywhere in this column or directly under the floor cell */
  hazard: boolean
  /** live name of the feet cell (`null` when unloaded) */
  cellName: string | null
  /** live name of the floor cell (`null` when unloaded) */
  floorName: string | null
}

/** One cardinal direction's bounded forward probe. */
export interface BridgeProbe {
  dir: BridgeDir
  dx: number
  dz: number
  /** nearest-first cells ahead; length <= `BRIDGE_PROBE_DEPTH` */
  cells: BridgeProbeCell[]
  /**
   * the body's own footing is a solid, load-bearing block: the face a placement
   * can legally be made against (`placeBlock(footing, face=<dir>)`), which is
   * exactly the human scaffold-bridge gesture.
   */
  footing: boolean
}

/** Structural probe shape, so the pure rule and the fixture can both feed it. */
export type BridgeProbeLike = Pick<BridgeProbe, 'dir' | 'dx' | 'dz' | 'cells' | 'footing'>

export type BridgeRefusalReason = 'no_block' | 'no_verified_landing' | 'hazard' | 'protected' | 'budget'

export interface BridgeRefusal {
  reason: BridgeRefusalReason
  /** the cell the refusal is about (the landing, the place cell, or the body's own cell) */
  cell: Vec3Json
  /** the leg target the bridge was aimed at, when there was one */
  target: Vec3Json | null
  /** the block that caused a `hazard`/`protected` refusal, when known */
  block: string | null
  /** the sensor's own human-readable cause (never a synthesized one) */
  detail: string
}

/** One verified bridge span: everything a step (and its evidence) needs. */
export interface BridgeSpan {
  dir: BridgeDir
  dx: number
  dz: number
  /** the first cell the body lands on (one placement from here) */
  landing: Vec3Json
  /** the first cell a block goes into (`landing.y - 1`) */
  place: Vec3Json
  /** the verified standable far side that bounds the span */
  far: Vec3Json
  /** how many placements the span needs (>= 1, <= maxSpan) */
  span: number
  /** distance from the body's feet cell to the leg target when the span was planned */
  from: number
  /** distance from the verified far side to the leg target */
  to: number
}

export type BridgeSpanDecision =
  | { kind: 'span'; span: BridgeSpan }
  /** the front cell is not a bridgeable gap: a wall to dig, an existing floor, or open ground */
  | { kind: 'not_a_gap'; reason: string }
  | { kind: 'refuse'; refusal: BridgeRefusal }

export interface BridgeSpanInput {
  probe: BridgeProbeLike
  /** the body's own (floored) feet cell */
  selfFeet: Vec3Json
  /** the leg target the bridge must make progress toward; `null` keeps the span unranked */
  target: Vec3Json | null
  /** the #436 U5 protected-resource test (a protected station / live-structure member) */
  isProtected?: (cell: Vec3Json, name: string | null) => boolean
  maxSpan?: number
}

function key(cell: Vec3Json): string {
  return `${cell.x},${cell.y},${cell.z}`
}

function horizontal(a: Vec3Json, b: Vec3Json): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

/**
 * The ONE bridge grounding rule.
 *
 * A cell is bridged when ALL of these hold, from live block truth only:
 *
 *   1. the body's own footing is solid (there is a face to place against);
 *   2. the landing column is OPEN (feet + head passable) and has NO floor: an
 *      existing floor is the ordinary walk/step machinery's business, and a solid
 *      front cell is a dig, never a bridge;
 *   3. the placement cell (the landing's floor cell) is REPLACEABLE AIR and not
 *      lava/fire/water: the body never places into a hazard;
 *   4. the column is hazard-free;
 *   5. the placement cell is not a protected resource (U5);
 *   6. walking forward from the landing, the FIRST cell that is already a verified
 *      stand (the sensor's own destination rule) bounds the span, and every cell
 *      between is itself bridgeable. No verified stand inside the bounded probe
 *      means NO bridge: ending mid-lake is worse than stopping;
 *   7. the span is within `maxSpan` and strictly closes distance to the leg target.
 *
 * Nothing here is Nether-specific and nothing here is a fallback ladder: the
 * caller enumerates the returned span as an ordinary candidate (or as a section 7
 * prerequisite when it is the UNIQUE remedy) and Jev still chooses.
 */
export function planBridgeSpan(input: BridgeSpanInput): BridgeSpanDecision {
  const cells = input.probe.cells
  const maxSpan = input.maxSpan ?? BRIDGE_MAX_SPAN
  const isProtected = input.isProtected ?? ((): boolean => false)
  if (cells.length === 0) return { kind: 'not_a_gap', reason: 'no_probe' }
  const first = cells[0]
  if (first === undefined) return { kind: 'not_a_gap', reason: 'no_probe' }

  // (2) An existing stand or an existing floor is never a bridge.
  if (first.standable) return { kind: 'not_a_gap', reason: 'landing_already_standable' }
  if (first.supported) return { kind: 'not_a_gap', reason: 'floor_already_present' }
  // (2b) A blocked landing column is a wall (dig) or a solid obstacle, not a hole.
  if (!first.open || !first.headOpen) return { kind: 'not_a_gap', reason: 'landing_column_blocked' }

  // (1) The placement reference: the block the body is standing on.
  if (!input.probe.footing) {
    return {
      kind: 'refuse',
      refusal: {
        reason: 'no_verified_landing',
        cell: input.selfFeet,
        target: input.target,
        block: null,
        detail: `no solid load-bearing footing under (${key(input.selfFeet)}): a bridge has no face to place against`,
      },
    }
  }

  // (3)(4) The placement cell must be air and the column hazard-free.
  if (first.hazard || isBridgeUnsafeBlockName(first.floorName)) {
    return {
      kind: 'refuse',
      refusal: {
        reason: 'hazard',
        cell: first.floor,
        target: input.target,
        block: first.floorName,
        detail: `${first.floorName ?? 'a hazard'} occupies the placement cell (${key(first.floor)})`,
      },
    }
  }
  if (!first.placeable) {
    return {
      kind: 'refuse',
      refusal: {
        reason: 'hazard',
        cell: first.floor,
        target: input.target,
        block: first.floorName,
        detail: `placement cell (${key(first.floor)}) is not replaceable air (${first.floorName ?? 'unloaded'})`,
      },
    }
  }
  // (5) U5: never place into a protected cell or a live structure's member cell.
  if (isProtected(first.floor, first.floorName) || isProtected(first.cell, first.cellName)) {
    return {
      kind: 'refuse',
      refusal: {
        reason: 'protected',
        cell: first.floor,
        target: input.target,
        block: first.floorName,
        detail: `(${key(first.floor)}) or its landing is a protected resource`,
      },
    }
  }

  // (6) The bounded continuation: the first verified stand forward bounds the span.
  let span = 1
  let far: Vec3Json | null = null
  for (let index = 1; index < cells.length; index += 1) {
    const cell = cells[index]
    if (cell === undefined) break
    if (cell.hazard) {
      return {
        kind: 'refuse',
        refusal: {
          reason: 'hazard',
          cell: cell.cell,
          target: input.target,
          block: cell.cellName,
          detail: `hazard at (${key(cell.cell)}) inside the bounded span`,
        },
      }
    }
    if (cell.standable) {
      far = cell.cell
      break
    }
    // An intermediate must itself be bridgeable, or the span cannot be verified.
    if (!cell.open || !cell.headOpen || cell.supported || !cell.placeable) break
    if (cell.floorName !== null && isBridgeUnsafeBlockName(cell.floorName)) break
    if (isProtected(cell.floor, cell.floorName)) {
      return {
        kind: 'refuse',
        refusal: {
          reason: 'protected',
          cell: cell.floor,
          target: input.target,
          block: cell.floorName,
          detail: `(${key(cell.floor)}) is a protected resource inside the bounded span`,
        },
      }
    }
    span += 1
    if (span > maxSpan) {
      return {
        kind: 'refuse',
        refusal: {
          reason: 'budget',
          cell: cell.cell,
          target: input.target,
          block: null,
          detail: `verified span exceeds the bounded budget (maxSpan=${maxSpan})`,
        },
      }
    }
  }
  if (far === null) {
    return {
      kind: 'refuse',
      refusal: {
        reason: 'no_verified_landing',
        cell: (cells[Math.min(span, cells.length - 1)] ?? first).cell,
        target: input.target,
        block: null,
        detail: `no verified standable continuation within ${cells.length} probed cells`,
      },
    }
  }

  // (7) Bounded and progress-making.
  const landing = first.cell
  const from = input.target === null ? 0 : horizontal(input.selfFeet, input.target)
  const to = input.target === null ? 0 : horizontal(far, input.target)
  if (input.target !== null && !(to <= from - BRIDGE_MIN_ADVANCE)) {
    return {
      kind: 'refuse',
      refusal: {
        reason: 'budget',
        cell: landing,
        target: input.target,
        block: null,
        detail: `the verified far side (${key(far)}) does not close distance (${from.toFixed(2)}m -> ${to.toFixed(2)}m)`,
      },
    }
  }
  return {
    kind: 'span',
    span: {
      dir: input.probe.dir,
      dx: input.probe.dx,
      dz: input.probe.dz,
      landing,
      place: first.floor,
      far,
      span,
      from,
      to,
    },
  }
}

export interface BridgePlan extends BridgeSpan {
  /** the item the span consumes */
  block: string
  /** the item count left in the inventory after the span's placements */
  remaining: number
  /** the `BRIDGE_START` line the offer carries */
  line: string
}

export interface BridgeRouteInput {
  selfFeet: Vec3Json
  target: Vec3Json | null
  /** the sensor's bounded forward probes (`WorldState.bridgeProbes`) */
  probes: readonly BridgeProbeLike[] | undefined | null
  /** the held placeable block (`state.selectPlaceableBlock`), or null when none is held */
  placeable: { name: string; count: number } | null
  isProtected?: (cell: Vec3Json, name: string | null) => boolean
  maxSpan?: number
}

export type BridgeRouteDecision =
  | { plan: BridgePlan; refusal: null; alternatives: BridgeSpan[] }
  | { plan: null; refusal: BridgeRefusal; alternatives: BridgeSpan[] }

/**
 * The ONE bridge offer over the sensor's four cardinal probes.
 *
 * Several directions can be individually legal. Which LANDING CELL to step to is
 * a mechanical fact, exactly like the walk leg's own "nearest cell that closes
 * the distance" choice (`candidates.ts#travelApproachLegs`), so the shortest
 * verified span that closes the most distance wins, with the sensor's fixed
 * E/W/N/S enumeration as the deterministic tie-break. What is NEVER decided here
 * is whether bridging beats digging, stepping or walking around: the caller
 * enumerates every semantic remedy class and stops at `SKILL_POLICY_BOUNDARY`
 * when more than one is grounded.
 */
export function planBridgeRoute(input: BridgeRouteInput): BridgeRouteDecision {
  if (input.placeable === null || input.placeable.count < 1) {
    return {
      plan: null,
      alternatives: [],
      refusal: {
        reason: 'no_block',
        cell: input.selfFeet,
        target: input.target,
        block: null,
        detail: 'no placeable block is held, so no cell can be bridged',
      },
    }
  }
  const spans: BridgeSpan[] = []
  const refusals: Array<{ dir: BridgeDir; refusal: BridgeRefusal }> = []
  for (const probe of input.probes ?? []) {
    const decision = planBridgeSpan({
      probe,
      selfFeet: input.selfFeet,
      target: input.target,
      ...(input.isProtected === undefined ? {} : { isProtected: input.isProtected }),
      ...(input.maxSpan === undefined ? {} : { maxSpan: input.maxSpan }),
    })
    if (decision.kind === 'span') spans.push(decision.span)
    else if (decision.kind === 'refuse') refusals.push({ dir: probe.dir, refusal: decision.refusal })
  }
  if (spans.length === 0) {
    // Report the most informative refusal: the bearing direction toward the leg
    // target first (that is the gap the route actually needed to cross), then any
    // hazard, then any protected resource, then the sensor's own enumeration order.
    const bearing = input.target === null ? null : bridgeBearingDir(input.selfFeet, input.target)
    const preferred =
      refusals.find((entry) => entry.dir === bearing)?.refusal ??
      refusals.find((entry) => entry.refusal.reason === 'hazard')?.refusal ??
      refusals.find((entry) => entry.refusal.reason === 'protected')?.refusal ??
      refusals[0]?.refusal
    return {
      plan: null,
      alternatives: [],
      refusal:
        preferred ?? {
          reason: 'no_verified_landing',
          cell: input.selfFeet,
          target: input.target,
          block: null,
          detail: 'no cardinal direction has a bridgeable gap with a verified continuation',
        },
    }
  }
  // Stable: (shortest verified span, then most distance closed, then probe order).
  const ranked = [...spans].sort((a, b) => (a.span === b.span ? a.to - b.to : a.span - b.span))
  const best = ranked[0]
  if (best === undefined) {
    return {
      plan: null,
      alternatives: [],
      refusal: {
        reason: 'no_verified_landing',
        cell: input.selfFeet,
        target: input.target,
        block: null,
        detail: 'no cardinal direction has a bridgeable gap with a verified continuation',
      },
    }
  }
  const line = formatBridgeStart({
    cell: best.landing,
    block: input.placeable.name,
    span: best.span,
    remaining: Math.max(0, input.placeable.count - best.span),
  })
  return {
    plan: {
      ...best,
      block: input.placeable.name,
      remaining: Math.max(0, input.placeable.count - best.span),
      line,
    },
    refusal: null,
    alternatives: ranked.slice(1),
  }
}

/** The cardinal direction from `from` to `to` (the axis with the larger delta). */
export function bridgeBearingDir(from: Vec3Json, to: Vec3Json): BridgeDir {
  const dx = to.x - from.x
  const dz = to.z - from.z
  if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? 'E' : 'W'
  return dz >= 0 ? 'S' : 'N'
}

/**
 * `BRIDGE_START cell=<x,y,z> block=<item> span=<n> remaining=<n>`
 *
 * Emitted when a bridge leg begins to execute. `cell` is the FIRST landing the
 * span reaches, `block` the item it consumes, `span` the verified number of
 * placements, and `remaining` the item count left in the inventory after them
 * (so a reviewer reads the supply bound, not just the intent).
 */
export function formatBridgeStart(input: {
  cell: Vec3Json
  block: string
  span: number
  remaining: number
}): string {
  return `BRIDGE_START cell=${cellText(input.cell)} block=${input.block} span=${input.span} remaining=${input.remaining}`
}

/** `BRIDGE_STEP from=<x,y,z> to=<x,y,z> block=<item>` - one VERIFIED placement + advance. */
export function formatBridgeStep(input: { from: Vec3Json; to: Vec3Json; block: string }): string {
  return `BRIDGE_STEP from=${cellText(input.from)} to=${cellText(input.to)} block=${input.block}`
}

/**
 * `BRIDGE_END placed=<n> verified=<true|false> reason=<typed>`
 *
 * The end state of the leg. `verified` is only true when the body then stood on a
 * cell whose support was verified; `reason` is always present so a partial leg is
 * never read as an arrival.
 */
export function formatBridgeEnd(input: { placed: number; verified: boolean; reason: string }): string {
  return `BRIDGE_END placed=${input.placed} verified=${input.verified} reason=${input.reason}`
}

/**
 * `BRIDGE_REFUSED reason=<typed> cell=<x,y,z> block=<name> detail=<cause>`
 *
 * The typed refusal. `reason` is one of
 * `no_block | no_verified_landing | hazard | protected | budget`; `detail` carries
 * the sensor's own cause so a reviewer can tell the five apart without guessing.
 */
export function formatBridgeRefused(refusal: BridgeRefusal): string {
  return (
    `BRIDGE_REFUSED reason=${refusal.reason} cell=${cellText(refusal.cell)} ` +
    `block=${refusal.block ?? 'unknown'} detail=${refusal.detail}`
  )
}

/** Structural predicate: does this candidate carry a bridge leg? */
export function isBridgeMove(candidate: { meta: Record<string, string | number | boolean> }): boolean {
  return candidate.meta[BRIDGE_META] === true
}

function cellText(cell: Vec3Json): string {
  return `${Math.floor(cell.x)},${Math.floor(cell.y)},${Math.floor(cell.z)}`
}

/** The span as the executor's per-step identity (used by fixtures and logs). */
export function bridgeSpanKey(span: Pick<BridgeSpan, 'dir' | 'landing' | 'far'>): string {
  return `${span.dir}:${key(span.landing)}->${key(span.far)}`
}
