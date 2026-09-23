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
//   * the SELF-LANDING SCAFFOLD case of that rule: when no already-standable far
//     side exists inside the bounded probe, the first column's own landing can
//     still be the far side, because this step CREATES ITS FLOOR and steps onto it
//     (one held block per leg, the next leg re-grounded from the new stand cell).
//     Its pocket is judged by the SAME per-cell verdict the wall entry and the level
//     scan read (`wallEntry.ts#wallPocketOccupationRefusal` +
//     `#wallPocketFloodRefusal`, composed in {@link scaffoldPocketRefusal}), so a
//     fluid that could pour into the cell the body is about to occupy refuses in the
//     shared vocabulary - there is no second flood rule here;
//   * the typed refusals: `no_block | no_verified_landing | hazard | protected |
//     budget | would_flood | portal_plane | unbreakable`;
//   * the typed markers `BRIDGE_START` / `BRIDGE_STEP` / `BRIDGE_END` /
//     `BRIDGE_REFUSED`, carried in candidate meta and mirrored by the controller.
//     `BRIDGE_START` carries `self_landing=true pocket=<per-cell evidence>` for the
//     scaffold case only, so a verified span's line is byte-identical to before.
//
// MEASURED (live, main cd7b38b, the operator's Nether run): the body dug from the
// arrival island toward the fortress and stopped at `DIG_ROUTE:level:N:b24_57_-12
// target=35,61,-23 fromD=16.76 toD=16.06` (LIVE:472244 / 472270) with `no_support`
// 633x - the dominant refusal of the whole run - and `BRIDGE_REFUSED
// reason=no_verified_landing` at every step of that final approach (LIVE:474855,
// 474877, 474937, 475029, 475446, 475503). The world truth behind it: the body's
// reachable ground ends at x=28, z=-20 and the nearest fortress fabric standable
// cell is (37,60,-20); every column between has its topmost non-air block at y=31
// and that block is lava, so the span is open air with NO floor at any level. The
// far side of that span cannot be pre-verified because it is not reachable on foot
// at all - only a body that lays its own floor can cross it.
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
import type { WallEntryRefusal, WallEntryRefusalReason, WallPocketFacts } from './wallEntry.ts'
import { wallPocketFloodRefusal, wallPocketOccupationRefusal } from './wallEntry.ts'

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
 * The FIRST verified placement cell (`"x,y,z"`): the one cell the offer grounded,
 * and the exact cell the effect envelope may name. The rest of the span's cells
 * are derived live by the same rule under `mayPlaceGroundedRoute`.
 */
export const BRIDGE_PLACE_META = 'bridgePlace'
/** The first landing cell (`"x,y,z"`) the first placement creates. */
export const BRIDGE_LANDING_META = 'bridgeLanding'
/**
 * #436 section 5: a Skill declares an `EffectEnvelope`. A MOVE that may place
 * blocks must DECLARE it, so this key is the machine-readable half of the
 * declaration and `BRIDGE_BLOCK_META` names the block it will consume.
 */
export const BRIDGE_MAY_PLACE_META = 'mayPlaceBlocks'
/** The `BRIDGE_START` line the offer carries and the controller mirrors. */
export const BRIDGE_LINE_META = 'bridgeLine'
/**
 * TRUE when this leg is a SELF-LANDING SCAFFOLD: the far side of the span is the
 * landing itself, because this step lays the floor of the cell it occupies. The
 * machine-readable half of the `self_landing=true` field on the `BRIDGE_START`
 * line, so a contract can audit "this leg creates the ground it stands on"
 * without parsing prose.
 */
export const BRIDGE_SELF_LANDING_META = 'bridgeSelfLanding'
/** The per-cell pocket verdict evidence of a self-landing scaffold step. */
export const BRIDGE_POCKET_EVIDENCE_META = 'bridgePocketEvidence'
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
  /**
   * Live name of the HEAD cell (`null` when unloaded, absent on hand-built
   * probes). The SELF-LANDING scaffold judges the 1x2 pocket with the shared
   * per-cell rule (`wallEntry.ts#wallPocketRefusal`), and that rule cannot decide
   * "standing in a fluid" or "the cell is a portal plane" without the head cell's
   * name. Absent means "not sensed", which the rule treats as a refusal.
   */
  headName?: string | null
  /**
   * A fluid is FACE-ADJACENT to a cell of this column's 1x2 pocket, so a body
   * standing in the pocket this step creates would be poured on
   * (`wallEntry.ts#floodEvidence`, read by the sensor). Absent means "not
   * sensed"; the SELF-LANDING rule refuses rather than assuming dry.
   */
  flood?: boolean
  /** the fluid cell that would pour in, when `flood` */
  floodCell?: Vec3Json | null
  /** the fluid block that would pour in, when `flood` */
  floodBlock?: string | null
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

export type BridgeRefusalReason =
  | 'no_block'
  | 'no_verified_landing'
  | 'hazard'
  | 'protected'
  | 'budget'
  /**
   * SELF-LANDING only: mining/placing into this column would pour a neighbouring
   * fluid into the pocket the body would stand in. The verdict comes from the
   * shared per-cell rule (`wallEntry.ts#wallPocketRefusal`), so a scanner and a
   * wall entry cannot disagree about what "this pocket may be occupied" means.
   */
  | 'would_flood'
  /** SELF-LANDING only: the pocket is a DIMENSION TRANSFER plane (standing there teleports the body) */
  | 'portal_plane'
  /** SELF-LANDING only: a pocket cell is unobserved or cannot be opened (unknown is never stood in) */
  | 'unbreakable'
  /**
   * The target is not in this bridge's own PLANE.
   *
   * A bridge advances at the body's level (its probe cells are all at the body's
   * feet Y and its self-landing place cell is `feet.y - 1`), so it can neither
   * climb to a target above nor descend to one below. Without this gate a body
   * standing far above its target will build a highway at its own altitude
   * towards it - measured live on 2026-09-23: the body climbed to y79 with the
   * floated gate interior at y67 and laid an elevated cobblestone network across
   * the area, which the operator photographed ("どこに橋を立てているの？？？？").
   * The vertical planner owns that difference; the bridge must decline it.
   */
  | 'level'

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
  /**
   * TRUE when the far side is the LANDING ITSELF: the body does not jump a gap
   * with a verified far bank, it lays the floor of the very cell it is about to
   * occupy and steps onto it, one cell per leg. `span` is then 1 by construction
   * and the bounded continuation is the next offer from the new stand cell (see
   * `planBridgeSpan`'s self-landing rule).
   */
  selfLanding?: boolean
  /** the per-cell pocket verdict the self-landing step was grounded on (evidence) */
  pocketEvidence?: string
  /**
   * Present only when a scaffold was grounded although the probe DID find a far
   * bank: the reason the bounded one-cell step was chosen over the span. Absent for
   * the historical "no far bank inside the probe" scaffold, so every pre-existing
   * `BRIDGE_START ... self_landing=true pocket=...` line stays byte-identical.
   */
  scaffoldCause?: BridgeScaffoldCause
}

/** Why a self-landing scaffold was grounded instead of a verified span. */
export type BridgeScaffoldCause = 'far_bank_no_reduction'

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
  /**
   * The item this leg would PLACE (`state.selectPlaceableBlock`), or absent/empty
   * when the caller has no placement identity to declare.
   *
   * It enables exactly ONE case: when no already-standable far side exists inside
   * the bounded probe, the first column's own landing can still be the far side,
   * because this step CREATES ITS FLOOR with this block and steps onto it. Without
   * the name the rule cannot state which block the new floor is, so it answers its
   * historical `no_verified_landing` instead - a hand-built probe keeps its old
   * verdict.
   */
  placeBlockName?: string | null
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
  //
  // WHEN THE CALLER DECLARED A PLACEMENT IDENTITY the search can only NARROW, never
  // refuse: the first column's own verdict (rules 1-5 above, already answered with
  // their own typed causes) is the authority for THIS step, and the self-landing
  // case below is the answer whenever no already-standable far side exists inside
  // the budget. A hazard, an over-budget span or a protected cell FURTHER ALONG is
  // not a property of the cell the body is about to occupy - and it stops the step
  // exactly where it matters (as the next leg's own first cell) rather than
  // blocking a legal one-cell advance. Without a placement identity every
  // historical refusal below is unchanged, so a hand-built probe keeps its verdict.
  const declaredPlacement =
    typeof input.placeBlockName === 'string' && input.placeBlockName.length > 0 ? input.placeBlockName : null
  // The scaffold is available for THIS step only when the caller declared what it
  // would place AND the probe carries the pocket's own face-adjacency read. Only then
  // may the continuation search NARROW instead of refusing: the first column's own
  // verdict is then the authority. Otherwise every historical refusal below stands
  // verbatim, so an existing caller's verdict never changes.
  const scaffoldAvailable = declaredPlacement !== null && first.flood !== undefined
  let span = 1
  let far: Vec3Json | null = null
  for (let index = 1; index < cells.length; index += 1) {
    const cell = cells[index]
    if (cell === undefined) break
    if (cell.hazard) {
      if (scaffoldAvailable) break
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
      if (scaffoldAvailable) break
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
      if (scaffoldAvailable) break
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
  const placeBlockName = typeof input.placeBlockName === 'string' && input.placeBlockName.length > 0
    ? input.placeBlockName
    : null
  /** The scaffold's own pocket evidence, when one was grounded. */
  let scaffoldEvidence: string | null = null
  /**
   * THE SELF-LANDING SCAFFOLD for this direction, as a REUSABLE step: the one-cell
   * advance that creates its own floor. Returns
   *   * `null`                     - the caller declared no placement identity, or the
   *                                  probe carries no pocket read (`first.flood`
   *                                  undefined, i.e. a hand-built probe): the
   *                                  historical `no_verified_landing` verdict stands,
   *                                  fail closed;
   *   * `{ refusal }`              - the pocket rule refused the step (hazard /
   *                                  would_flood / portal_plane / protected /
   *                                  unbreakable), in the shared vocabulary;
   *   * `{ far, pocketEvidence }`  - the step is legal and its far side is its own
   *                                  landing.
   *
   * It is a closure because TWO situations need the identical step: no far bank
   * inside the bounded probe (the historical case below), and a far bank that does
   * NOT strictly reduce the distance to the leg target (rule 7, further down) - the
   * bounded one-cell advance is then still the honest offer, under the SAME guards.
   *
   * The scaffold needs the pocket's OWN sensed facts: the sensor fills the
   * face-adjacency flood read for the first column on every probe it builds
   * (`state.ts#probeBridgeDirection`).
   */
  const selfLandingScaffold = ():
    | { far: Vec3Json; pocketEvidence: string }
    | { refusal: BridgeRefusal }
    | null => {
    if (placeBlockName === null || first.flood === undefined) return null
    const pocket = scaffoldPocketRefusal(
      {
        landing: first.cell,
        pocket: [
          { cell: first.cell, name: first.cellName, open: first.open, solid: !first.open, breakable: !first.open, observed: first.cellName !== null && first.cellName !== undefined },
          {
            cell: { x: first.cell.x, y: first.cell.y + 1, z: first.cell.z },
            name: first.headName ?? null,
            open: first.headOpen,
            solid: !first.headOpen,
            breakable: !first.headOpen,
            observed: first.headName !== null && first.headName !== undefined,
          },
        ],
        // The floor of the pocket is the block THIS leg places. It is read from
        // the placement, not from the world, because the world's cell is air -
        // that is the whole mechanic.
        floor: { cell: first.floor, name: placeBlockName, open: false, solid: true, breakable: true, observed: true },
        flood: first.flood === true,
        floodCell: first.floodCell ?? null,
        floodBlock: first.floodBlock ?? null,
      },
      isProtected,
      `the ${input.probe.dir} self-landing scaffold`,
    )
    if (pocket !== null) {
      return {
        refusal: {
          reason: bridgeRefusalReasonFor(pocket.reason),
          cell: pocket.cell ?? first.cell,
          target: input.target,
          block: pocket.block,
          detail: pocket.detail,
        },
      }
    }
    return { far: first.cell, pocketEvidence: selfLandingPocketEvidence(first, placeBlockName) }
  }
  if (far === null) {
    // (6b) THE SELF-LANDING SCAFFOLD. No already-standable far side exists inside
    // the bounded probe, so the historical answer was `no_verified_landing` and the
    // route stopped at the edge of the span. That refusal is correct for a JUMP and
    // wrong for a SCAFFOLD: a body that lays the floor of the cell it is about to
    // occupy does not need a far bank to be pre-verified, because it never leaves
    // the cell it just floored. The span is then 1 by construction, and the
    // bounded continuation is the NEXT offer, re-grounded from the new stand cell -
    // exactly how a player bridges one block at a time.
    //
    // WHAT BOUNDS IT (nothing here is an unbounded project):
    //   * one held block per leg, and the leg is spent through the ordinary
    //     zero-progress route identity, so a step that changes nothing is withheld;
    //   * the SAME strict-reduction test as every verified span (rule 7): the
    //     landing must close real distance to the leg target, so a scaffold can
    //     never wander sideways or away;
    //   * the SAME per-cell pocket rule the wall entry and the level scan use
    //     (`wallEntry.ts#wallPocketRefusal`, via `scaffoldPocketRefusal`), with the
    //     block this leg places as the pocket's floor: a column a fluid could pour
    //     into, an unobserved column, a protected cell and a dimension-transfer
    //     plane are all refused in the shared vocabulary, never in a second one.
    const scaffold = selfLandingScaffold()
    if (scaffold !== null) {
      if ('refusal' in scaffold) return { kind: 'refuse', refusal: scaffold.refusal }
      far = scaffold.far
      scaffoldEvidence = scaffold.pocketEvidence
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
  let to = input.target === null ? 0 : horizontal(far, input.target)
  /**
   * WHY a scaffold was grounded even though the probe DID find a far bank: the
   * verified span to that bank does not strictly reduce the distance to the leg
   * target, so the direction is not useful as a SPAN - while the bounded one-cell
   * advance still is. Absent for the historical "no far bank inside the probe"
   * case, so those `BRIDGE_START` lines stay byte-identical.
   */
  let scaffoldCause: BridgeScaffoldCause | undefined
  if (input.target !== null && !(to <= from - BRIDGE_MIN_ADVANCE)) {
    // The far bank is no closer to the target than the body already is. Before
    // refusing the direction, try the SAME bounded scaffold rule 6b uses: the
    // first landing must close distance on its OWN, under the identical pocket
    // guards, and it is one cell by construction. Measured live (the operator's
    // floated gate, body on an island): `BRIDGE_REFUSED reason=budget ... the
    // verified far side (26,67,6) does not close distance (1.41m -> 3.16m)` was
    // exactly this shape, and the one-cell step toward the target DID close
    // distance - so the direction was refused although the honest bounded step
    // existed. A scaffold refusal here does NOT replace the historical refusal:
    // the direction was already refused, and this path only ever ADDS a grounded
    // step, never rewrites a verdict.
    if (key(far) !== key(landing) && horizontal(landing, input.target) <= from - BRIDGE_MIN_ADVANCE) {
      const scaffold = selfLandingScaffold()
      if (scaffold !== null && !('refusal' in scaffold)) {
        far = scaffold.far
        to = horizontal(far, input.target)
        scaffoldEvidence = scaffold.pocketEvidence
        scaffoldCause = 'far_bank_no_reduction'
      }
    }
    if (!(to <= from - BRIDGE_MIN_ADVANCE)) {
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
  }
  const selfLanding = far !== null && key(far) === key(landing)
  const placedBlock = typeof input.placeBlockName === 'string' && input.placeBlockName.length > 0 ? input.placeBlockName : null
  return {
    kind: 'span',
    span: {
      dir: input.probe.dir,
      dx: input.probe.dx,
      dz: input.probe.dz,
      landing,
      place: first.floor,
      far,
      span: selfLanding ? 1 : span,
      from,
      to,
      ...(selfLanding ? { selfLanding: true } : {}),
      ...(selfLanding
        ? { pocketEvidence: scaffoldEvidence ?? (placedBlock === null ? 'none' : selfLandingPocketEvidence(first, placedBlock)) }
        : {}),
      ...(scaffoldCause === undefined ? {} : { scaffoldCause }),
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

/**
 * The shared per-cell verdict of a pocket the body will CREATE THE FLOOR OF.
 *
 * A self-landing scaffold does not mine its pocket - the 1x2 column is already
 * open air - it puts a block into the cell below and stands on it. So the
 * DIG-only questions ("is there anything to mine", "is the pre-existing floor
 * real ground") do not apply, while every OCCUPATION question does, and they are
 * answered by the SAME functions the wall entry and the level scan use
 * (`wallEntry.ts#wallPocketOccupationRefusal` and `#wallPocketFloodRefusal`):
 *
 *   protected      - a protected station / a live structure's member;
 *   unbreakable    - the column was not observed (unknown is never safe);
 *   hazard         - an open pocket cell IS a fluid: the body would stand in it;
 *   portal_plane   - standing there transfers the body to another dimension;
 *   would_flood    - a fluid is FACE-ADJACENT to a pocket cell and would pour into
 *                    the cell this step is about to make the body occupy.
 *
 * The order is the occupation order first (protection, observation, fluid,
 * transfer) and the flood rule last, which is the same relative order the dig
 * path uses. This is a composition of the one rule, never a second copy of it: no
 * block name, distance or direction is decided here.
 */
export function scaffoldPocketRefusal(
  facts: WallPocketFacts,
  isProtected: (cell: Vec3Json, name: string | null) => boolean,
  describe: string = 'the',
): WallEntryRefusal | null {
  return wallPocketOccupationRefusal(facts, isProtected, describe) ?? wallPocketFloodRefusal(facts, describe)
}

/**
 * Map the shared per-cell verdict's reason into the bridge vocabulary. Every cause
 * `scaffoldPocketRefusal` can return is named IDENTICALLY in both vocabularies
 * (`protected` / `unbreakable` / `hazard` / `portal_plane` / `would_flood`), so the
 * log never translates a shared verdict. Anything else can only be a dig-only cause
 * the scaffold never reaches, and falls back to the bridge's own `hazard`: a
 * refusal is never dropped, only named.
 */
function bridgeRefusalReasonFor(reason: WallEntryRefusalReason): BridgeRefusalReason {
  switch (reason) {
    case 'would_flood':
    case 'portal_plane':
    case 'unbreakable':
    case 'hazard':
    case 'protected':
      return reason
    default:
      return 'hazard'
  }
}

/**
 * The self-landing step's evidence, in the same per-cell vocabulary the wall
 * entry's own `evidence` string uses: the column the body will occupy, the block
 * it places as that column's floor, and the flood verdict. One line, so
 * "the body scaffolded into a dry pocket" is auditable without the world.
 */
function selfLandingPocketEvidence(cell: BridgeProbeCell, placeBlockName: string): string {
  const head = `${cell.cell.x},${cell.cell.y + 1},${cell.cell.z}`
  const flood =
    cell.flood === true
      ? `flood=${cell.floodBlock ?? 'fluid'}@${cell.floodCell === null || cell.floodCell === undefined ? 'unknown' : key(cell.floodCell)}`
      : 'flood=none'
  return (
    `profile=${key(cell.cell)}:${cell.cellName ?? 'unknown'}+${head}:${cell.headName ?? 'unknown'}:open;` +
    `floor=${key(cell.floor)}:${placeBlockName}:placed;${flood}`
  )
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
      // The placement identity: it is what lets the rule answer "this step CREATES
      // ITS FLOOR" instead of "no verified landing" for a span with no far bank.
      placeBlockName: input.placeable.name,
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
    ...(best.selfLanding === true ? { selfLanding: true } : {}),
    ...(best.selfLanding === true && best.pocketEvidence !== undefined ? { pocketEvidence: best.pocketEvidence } : {}),
    ...(best.scaffoldCause === undefined ? {} : { scaffoldCause: best.scaffoldCause }),
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

/**
 * The candidate-meta CONTRACT of a grounded bridge leg: every fact `runBridge`
 * reads before it places, written in ONE place.
 *
 * WHY THIS IS SHARED (measured drift risk, 2026-09-23): the bridge was first
 * offered only as a MOVE remedy (`candidates.ts#bridgeLegCandidate`), and its
 * meta was written inline there. The portal ENTRY's crossing leg is the same
 * grounded span reached through a different Skill (`ENTER_PORTAL`, one of the
 * arms Jev may select), and an offer that wrote a SUBSET of these keys would be
 * executable on paper and inert in practice - exactly the defect the
 * `placeBlockName` re-probe fix (main b5325b3) closed for the self-landing
 * scaffold: `runBridge` refuses with `target_gone` when `bridgeDir`/`bridgeBlock`
 * are missing, cannot bound itself without `bridgeSpan`, cannot declare its
 * `EffectEnvelope` without `mayPlaceBlocks` + `bridgePlace`, and cannot show the
 * `BRIDGE_START` line the offer grounded without `bridgeLine`.
 *
 * Pure: no bot, no world, no clock. `bridgeFrom`/`bridgeTo`/`bridgeRemaining` are
 * the offer-time distance claims, in `round2Number` precision, and the
 * self-landing scaffold's own two keys are present only for that case - so a
 * verified span's contract is byte-identical to before.
 */
export function bridgeContractMeta(plan: BridgePlan): Record<string, string | number | boolean> {
  const selfLanding = plan.selfLanding === true
  return {
    [BRIDGE_META]: true,
    [BRIDGE_DIR_META]: plan.dir,
    [BRIDGE_BLOCK_META]: plan.block,
    [BRIDGE_SPAN_META]: plan.span,
    [BRIDGE_TARGET_META]: cellText(plan.far),
    // #436 section 5 EffectEnvelope: this leg WILL place blocks and consume
    // `bridgeBlock`. Declared, never implicit.
    [BRIDGE_MAY_PLACE_META]: true,
    [BRIDGE_LINE_META]: plan.line,
    [BRIDGE_LANDING_META]: cellText(plan.landing),
    [BRIDGE_PLACE_META]: cellText(plan.place),
    bridgeFrom: round2Number(plan.from),
    bridgeTo: round2Number(plan.to),
    bridgeRemaining: plan.remaining,
    // The SELF-LANDING SCAFFOLD says so in machine-readable form: this leg's far
    // side is the cell it floors, so `span` is 1 by construction and the bounded
    // continuation is the next offer from the new stand cell. `pocket` carries the
    // shared per-cell verdict the step was grounded on (the SAME
    // `wallEntry.ts#wallPocketRefusal` family the wall entry and level scan read).
    ...(selfLanding
      ? {
          [BRIDGE_SELF_LANDING_META]: true,
          [BRIDGE_POCKET_EVIDENCE_META]: plan.pocketEvidence ?? 'none',
        }
      : {}),
  }
}

function round2Number(value: number): number {
  return Math.round(value * 100) / 100
}

/** The cardinal direction from `from` to `to` (the axis with the larger delta). */
export function bridgeBearingDir(from: Vec3Json, to: Vec3Json): BridgeDir {
  const dx = to.x - from.x
  const dz = to.z - from.z
  if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? 'E' : 'W'
  return dz >= 0 ? 'S' : 'N'
}

/**
 * `BRIDGE_START cell=<x,y,z> block=<item> span=<n> remaining=<n>
 *  [self_landing=true pocket=<evidence>]`
 *
 * Emitted when a bridge leg begins to execute. `cell` is the FIRST landing the
 * span reaches, `block` the item it consumes, `span` the verified number of
 * placements, and `remaining` the item count left in the inventory after them
 * (so a reviewer reads the supply bound, not just the intent).
 *
 * `self_landing=true` is appended only for the SCAFFOLD case, where the far side
 * is the landing itself (this step lays the floor of the cell it occupies) and
 * `pocket` carries the per-cell verdict evidence the shared rule was read on. A
 * verified-span line is byte-identical to before, so the two are never confused.
 */
export function formatBridgeStart(input: {
  cell: Vec3Json
  block: string
  span: number
  remaining: number
  selfLanding?: boolean
  pocketEvidence?: string
  scaffoldCause?: BridgeScaffoldCause
}): string {
  const scaffold =
    input.selfLanding === true
      ? ` self_landing=true${input.scaffoldCause === undefined ? '' : ` cause=${input.scaffoldCause}`} pocket=${input.pocketEvidence ?? 'none'}`
      : ''
  return `BRIDGE_START cell=${cellText(input.cell)} block=${input.block} span=${input.span} remaining=${input.remaining}${scaffold}`
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
