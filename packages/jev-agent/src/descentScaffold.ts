// descentScaffold.ts - the DOWNWARD self-landing scaffold.
//
// THE MIRROR OF THE CROSSING. `bridgeRoute.ts#planBridgeSpan` answers a HORIZONTAL
// gap the body cannot cross: it lays the floor of the cell it is about to occupy
// and steps onto it (`selfLanding`, BRIDGE_START ... self_landing=true). A descent
// whose landing cell has AIR below is the same shape rotated 90 degrees, and it was
// the one gap the descent vocabulary could not answer at all.
//
// Measured live (main 974e954, the operator's floated-portal trial; body 23.5,79.0,1.5
// hp 16, portal interior at 26,67,9 i.e. dy=-12):
//
//   CANDIDATE_ACQUISITION candidate=MOVE:b26_74_-14 kind=MOVE reachable=false
//     reason=needs_descend missing=["descend_plan:no_support@25,78,-2:air"]
//   counts in this run: needs_descend 1912 | column_descent 4006
//
// The typed fact was already right (`candidates.ts#deriveReachabilityAbilities`,
// `reachability.ts#DescendPlanRefusalReason`): no down step is safe because the
// landing cell's support is air. What was missing is the ANSWER. The descent
// vocabulary had exactly two remedies - cut a staircase step (`planVerticalApproach`)
// and dig the body's own column (`columnDescentCandidates`) - and both are DIGS, so
// a landing with nothing to dig under it could only be refused. The body stood on a
// floated gate with the whole column below it unsupported and a block in hand, and
// 1912 identical `needs_descend` acquisitions found no route.
//
// WHAT THIS MODULE IS NOT. It is not a second bridge rule and it does not add a
// second pocket rule. Every occupation, flood, protection and dimension-transfer
// question is answered by the SAME functions the wall entry / level scan / bridge
// self-landing already share (`wallEntry.ts#wallPocketOccupationRefusal` and
// `#wallPocketFloodRefusal`, composed by `bridgeRoute.ts#scaffoldPocketRefusal`).
// This module adds the STEP GEOMETRY of "place the floor under the cell below my
// feet, then stand in it" and nothing else.
//
// BOUNDED BY CONSTRUCTION, exactly like the horizontal scaffold:
//   * ONE held block per leg (the leg places exactly one cell, and the caller's
//     budget is 1 by construction);
//   * STRICT REDUCTION: the landing is one block below the body's feet and must
//     still not be below the goal's target level, so the vertical gap shrinks by
//     exactly one and the descent can never step past its target;
//   * the landing column must be hazard-free, the placement cell replaceable air,
//     the placement cell's own support solid (or the placed block would fall), and
//     the 1x2 pocket must pass the shared occupation + flood rules;
//   * a protected cell is never placed into, and a dimension-transfer plane is
//     never stood in;
//   * the portal plane is never MINED: this route never digs at all.
//
// Pure: no bot, no clock, no model. The sensor supplies the live cell facts
// (`WorldState.descentScaffold`), so the grounding is unit-testable without a
// server and the executor re-derives it from the same function before it places.
import type { BridgeRefusalReason } from './bridgeRoute.ts'
import { BRIDGE_MIN_ADVANCE, scaffoldPocketRefusal } from './bridgeRoute.ts'
import type { Vec3Json } from './state.ts'
import type { WallEntryRefusal, WallEntryRefusalReason } from './wallEntry.ts'

// ---------------------------------------------------------------------------
// The live cell facts (one downward column: the landing and its floor)
// ---------------------------------------------------------------------------

/**
 * The live truth of the ONE cell a downward self-landing step would occupy, and of
 * the cell below it that the step would CREATE.
 *
 * Deliberately a single cell, not four cardinal probes: a descent is straight down.
 * The body stays in its own column and drops one level, so there is no direction to
 * enumerate and no tie to break - the geometry IS the plan.
 */
export interface DescentScaffoldProbe {
  /** the body's own (floored) feet cell */
  selfFeet: Vec3Json
  /** the cell the body would occupy after the step: `selfFeet.y - 1` */
  landing: Vec3Json
  /** the cell THIS step places into: `landing.y - 1` */
  place: Vec3Json
  /** the landing cell's feet block is passable */
  landingOpen: boolean
  /** the landing cell's head block (`landing.y + 1`) is passable */
  landingHeadOpen: boolean
  /** the placement cell is replaceable air: the ONLY thing a block may be placed into */
  placeable: boolean
  /** the block under the placement cell is solid, so the placed block would rest on it */
  placeSupported: boolean
  /** the block the placed floor would REST ON (`place.y - 1`), and its live name */
  supportName: string | null
  /** live name of the landing cell (null when unloaded) */
  landingName: string | null
  /** live name of the landing's head cell (null when unloaded) */
  landingHeadName: string | null
  /** live name of the placement cell (null when unloaded) */
  placeName: string | null
  /**
   * Live name of the cell the LANDING would rest on (`landing.y - 1`). This is the
   * cell the measured refusal named indirectly; carrying it makes the typed refusal
   * able to say WHAT is there instead of a floor (`air` in the measured shape).
   */
  belowName: string | null
  /** lava/fire/water anywhere in the column this step touches */
  hazard: boolean
  /** the concrete hazard block, when one was read */
  hazardBlock: string | null
  /** a fluid is FACE-ADJACENT to a pocket cell and would pour into the cell the body occupies */
  flood: boolean
  floodCell: Vec3Json | null
  floodBlock: string | null
  /** the body's own footing is solid: the face this placement is made against */
  footing: boolean
}

/**
 * The sensor-declared downward scaffold facts. `probe` is null when the sensor
 * grounded no downward step at all (nothing to answer), and `blockName` is the
 * held placeable block (`state.selectPlaceableBlock`), null when none is held - the
 * typed `no_block` refusal is derived from that inventory fact alone.
 */
export interface DescentScaffoldFacts {
  probe: DescentScaffoldProbe | null
  blockName: string | null
  /** the item count left after this leg's one placement */
  blockCount: number
  /** the goal's target level, when the goal carries one (a bounded descent aims at it) */
  targetY: number | null
  /** the leg target cell, when one exists (used for the strict-reduction evidence) */
  target: Vec3Json | null
  /** the #436 U5 protected-resource test (a protected station / live-structure member) */
  isProtected?: (cell: Vec3Json, name: string | null) => boolean
}

// ---------------------------------------------------------------------------
// The typed refusal
// ---------------------------------------------------------------------------

/**
 * Why a downward self-landing step could not be grounded.
 *
 * The shared per-cell vocabulary is reused VERBATIM where it applies (`hazard`,
 * `protected`, `unbreakable`, `would_flood`, `portal_plane` - all five come
 * straight from `wallEntry.ts#WallEntryRefusalReason` and are mapped into the
 * bridge's identical names), and only the three facts that are specific to
 * "I am about to CREATE the floor I land on" are added:
 *
 *   `no_block`   the body holds nothing it could place;
 *   `no_landing` the landing column is not open air, or its head cell is not
 *                passable: there is no pocket to stand in;
 *   `not_air`    the placement cell is not replaceable air (the world is already
 *                there, so there is nothing to create);
 *   `no_ground`  the placement cell's own support is not solid, so the block this
 *                step would place has nothing to rest on.
 */
export type DescentScaffoldRefusalReason =
  | 'no_block'
  | 'no_landing'
  | 'not_air'
  | 'no_ground'
  | WallEntryRefusalReason

export interface DescentScaffoldRefusal {
  reason: DescentScaffoldRefusalReason
  /** the cell the refusal is about (the landing, or the cell that would be placed into) */
  cell: Vec3Json
  /** the block that caused the refusal, when one was read */
  block: string | null
  /**
   * The live block in the cell the landing would rest on (`landing.y - 1`): WHAT is
   * there instead of a floor. In the measured shape this is `air` - the whole
   * reason no dig remedy existed. `unknown` when the cell was not loaded.
   */
  below: string | null
  /** the plant's own human-readable cause (never a synthesized one) */
  detail: string
  /** the failed descent step's landing Y and the level this route aimed at */
  fromY: number
  toY: number
}

/**
 * One grounded downward self-landing step: everything the offer, the executor's
 * placement, and the mirrored evidence need.
 */
export interface DescentScaffoldPlan {
  /** the body's own feet cell the step starts from */
  from: Vec3Json
  /** the cell the body occupies after the step (`from.y - 1`) */
  landing: Vec3Json
  /** the cell this step places a block into (`landing.y - 1`) */
  place: Vec3Json
  /** the item this step consumes */
  block: string
  /** the item count left in the inventory after this leg */
  remaining: number
  /** the face direction of the placement, in mineflayer's own reference/face convention */
  reference: Vec3Json
  /** the placement cell is legal and the block was really consumed (mirrored as `placed=`) */
  places: true
  /** the world's Y level this leg lands the body on */
  landingY: number
  /** the goal level this leg aims at, when the goal carries one */
  targetY: number | null
  /** the descent gap before the step (feet Y - target Y), when a target exists */
  fromGap: number | null
  /** the descent gap after the step (landing Y - target Y), when a target exists */
  toGap: number | null
  /** the shared per-cell pocket evidence, in the same shape the horizontal scaffold emits */
  pocketEvidence: string
}

export type DescentScaffoldDecision =
  | { kind: 'step'; plan: DescentScaffoldPlan }
  /** the world is not the shape this route answers (nothing below to create) */
  | { kind: 'not_a_gap'; reason: string }
  | { kind: 'refuse'; refusal: DescentScaffoldRefusal }

// ---------------------------------------------------------------------------
// The one grounding rule
// ---------------------------------------------------------------------------

function key(cell: Vec3Json): string {
  return `${cell.x},${cell.y},${cell.z}`
}

function cellText(cell: Vec3Json): string {
  return `(${key(cell)})`
}

/** The mineflayer reference/face pair for a placement into `selfFeet.y - 2`: the footing's own bottom face. */
export function descentPlaceReference(selfFeet: Vec3Json): { reference: Vec3Json; face: Vec3Json } {
  return {
    reference: { x: selfFeet.x, y: selfFeet.y - 1, z: selfFeet.z },
    face: { x: 0, y: -1, z: 0 },
  }
}

/**
 * Map the shared per-cell verdict's reason into this route's own vocabulary. Every
 * cause `scaffoldPocketRefusal` can return is named IDENTICALLY in both
 * vocabularies (`protected` / `unbreakable` / `hazard` / `portal_plane` /
 * `would_flood`), so the log never translates a shared verdict - exactly the
 * mapping `bridgeRoute.ts#bridgeRefusalReasonFor` performs for the horizontal step.
 */
function scaffoldReasonFor(reason: WallEntryRefusalReason): DescentScaffoldRefusalReason {
  return reason
}

/**
 * The shared per-cell verdict of the pocket this step CREATES THE FLOOR OF.
 *
 * The descent step does not mine its pocket - the 1x2 column below the body is air
 * - it puts a block into the cell under the landing and drops onto it. So the two
 * DIG-only questions ("is there anything to mine", "is the pre-existing floor real
 * ground") do not apply, while every OCCUPATION question does - and they are
 * answered by the ONE rule (`wallEntry.ts#wallPocketOccupationRefusal` /
 * `#wallPocketFloodRefusal`), composed here through the same
 * `bridgeRoute.ts#scaffoldPocketRefusal` the horizontal self-landing uses.
 */
export function descentScaffoldPocketRefusal(
  probe: DescentScaffoldProbe,
  blockName: string,
  isProtected: (cell: Vec3Json, name: string | null) => boolean,
): WallEntryRefusal | null {
  return scaffoldPocketRefusal(
    {
      landing: probe.landing,
      pocket: [
        {
          cell: probe.landing,
          name: probe.landingName,
          open: probe.landingOpen,
          solid: !probe.landingOpen,
          breakable: !probe.landingOpen,
          observed: probe.landingName !== null,
        },
        {
          cell: { x: probe.landing.x, y: probe.landing.y + 1, z: probe.landing.z },
          name: probe.landingHeadName,
          open: probe.landingHeadOpen,
          solid: !probe.landingHeadOpen,
          breakable: !probe.landingHeadOpen,
          observed: probe.landingHeadName !== null,
        },
      ],
      // The floor of the pocket is the block THIS leg places. It is read from the
      // placement, not from the world, because the world's cell is air - that is
      // the whole mechanic.
      floor: {
        cell: probe.place,
        name: blockName,
        open: false,
        solid: true,
        breakable: true,
        observed: true,
      },
      flood: probe.flood,
      floodCell: probe.floodCell,
      floodBlock: probe.floodBlock,
    },
    isProtected,
    'the downward self-landing scaffold',
  )
}

/**
 * The step's evidence, in the same per-cell vocabulary the wall entry and the
 * horizontal self-landing use (`bridgeRoute.ts#selfLandingPocketEvidence`): the
 * column the body will occupy, the block it places as that column's floor, and the
 * flood verdict. One line, so "the body scaffolded down into a dry pocket" is
 * auditable without the world.
 */
export function descentScaffoldPocketEvidence(probe: DescentScaffoldProbe, blockName: string): string {
  const head = `${probe.landing.x},${probe.landing.y + 1},${probe.landing.z}`
  const flood =
    probe.flood === true
      ? `flood=${probe.floodBlock ?? 'fluid'}@${probe.floodCell === null ? 'unknown' : key(probe.floodCell)}`
      : 'flood=none'
  return (
    `profile=${key(probe.landing)}:${probe.landingName ?? 'unknown'}+${head}:${probe.landingHeadName ?? 'unknown'}:open;` +
    `floor=${key(probe.place)}:${blockName}:placed;${flood}`
  )
}

/**
 * THE ONE downward-self-landing grounding rule.
 *
 * A step is grounded when ALL of these hold, from live block truth only:
 *
 *   1. the body declares a placeable block it actually holds (the `no_block`
 *      refusal comes from the inventory fact before any world read, exactly like
 *      `planBridgeRoute`);
 *   2. the body's own footing is solid: the face this placement is made against
 *      is the block the body is standing on, its bottom face (`placeBlock(footing,
 *      face=(0,-1,0))`), the mirror of the horizontal scaffold's
 *      "place against the block under my feet, side face in the direction of travel";
 *   3. the landing column is OPEN (feet + head passable) - there is a pocket to
 *      occupy - and the placement cell is REPLACEABLE AIR, so this step really
 *      creates the floor rather than replacing the world;
 *   4. the column is hazard-free and the placement cell is not a hazard;
 *   5. the placement cell's own support is SOLID, so the block this step places has
 *      something to rest on and the body does not fall through the floor it made;
 *   6. the 1x2 pocket passes the SHARED occupation + flood rule (protected,
 *      unobserved, fluid, dimension-transfer, would_flood);
 *   7. STRICT VERTICAL REDUCTION: a target level below the body exists and the
 *      landing does not step past it (`landing.y >= targetY`). A downward scaffold
 *      is one block by construction, so this is what makes the whole descent
 *      monotone: every grounded leg closes exactly one of the gap and the loop
 *      stops the moment the target level is reached.
 *
 * Nothing here is Nether-specific, portal-specific or coordinate-specific: the rule
 * is a function of the body's own column and the goal's target level, so it answers
 * ANY structure at ANY height with ANY target below. It never digs.
 */
export function planDescentScaffoldStep(facts: DescentScaffoldFacts): DescentScaffoldDecision {
  const isProtected = facts.isProtected ?? ((): boolean => false)
  const probe = facts.probe
  if (probe === null) return { kind: 'not_a_gap', reason: 'no_downward_probe' }

  const fromY = probe.selfFeet.y
  const toY = facts.targetY ?? probe.landing.y
  // The `below` field of every refusal is the ONE fact the measured live refusal
  // could not name: WHAT is in the cell the landing would rest on. It is read once
  // from the probe (`landing.y - 1`), so a refusal always names the state below the
  // landing instead of a token that can only be retried.
  const below = probe.belowName
  const refuse = (
    reason: DescentScaffoldRefusalReason,
    cell: Vec3Json,
    block: string | null,
    detail: string,
  ): DescentScaffoldDecision => ({
    kind: 'refuse',
    refusal: { reason, cell, block, below, detail, fromY, toY },
  })

  // (1) The inventory fact, BEFORE any world read.
  const blockName = facts.blockName
  if (blockName === null || facts.blockCount < 1) {
    return refuse('no_block', probe.place, null, 'no placeable block is held, so no landing can be created')
  }

  // (2) The placement reference: the block the body is standing on.
  if (!probe.footing) {
    return refuse(
      'no_ground',
      probe.selfFeet,
      null,
      `no solid load-bearing footing under ${cellText(probe.selfFeet)}: a downward scaffold has no face to place against`,
    )
  }

  // (3) PROTECTION, before the shape. A protected station / live-structure member
  // that occupies the pocket is the reason this step may not exist at all, and the
  // shared rule names it. Checking it here (rather than only after the shape checks)
  // keeps the verdict a property of the CELL, exactly like the bridge rule's rule 5
  // - a protected cell is refused as `protected` whatever its bounding box is.
  const protectedVerdict = descentScaffoldPocketRefusal(probe, blockName, isProtected)
  if (protectedVerdict !== null && protectedVerdict.reason === 'protected') {
    return refuse(
      'protected',
      protectedVerdict.cell ?? probe.landing,
      protectedVerdict.block,
      protectedVerdict.detail,
    )
  }

  // (4) There must be a pocket to occupy, and something to create.
  if (!probe.landingOpen || !probe.landingHeadOpen) {
    return refuse(
      'no_landing',
      probe.landing,
      probe.landingName,
      `the landing column ${cellText(probe.landing)} is not open air (feet=${probe.landingName ?? 'unloaded'}, head=${probe.landingHeadName ?? 'unloaded'})`,
    )
  }
  // (4b) HAZARDS, before the shape: a lava cell is a DANGER first and a
  // non-replaceable shape second, and the bridge rule answers `hazard` before it
  // answers "not air". The body never places into a hazard, whatever else is true.
  if (probe.hazard) {
    return refuse(
      'hazard',
      probe.place,
      probe.hazardBlock ?? probe.placeName,
      `${probe.hazardBlock ?? 'a hazard'} is inside the column this step occupies or places into`,
    )
  }
  if (!probe.placeable) {
    return refuse(
      'not_air',
      probe.place,
      probe.placeName,
      `the placement cell ${cellText(probe.place)} is not replaceable air (${probe.placeName ?? 'unloaded'})`,
    )
  }

  // (5) The block this step places must have something to rest on.
  if (!probe.placeSupported) {
    return refuse(
      'no_ground',
      probe.place,
      probe.placeName,
      `the placement cell ${cellText(probe.place)} has nothing to rest on (${probe.supportName ?? 'unloaded'}), so the placed ${blockName} would fall`,
    )
  }

  // (6) The REST of the SHARED per-cell pocket verdict (observation, fluid,
  // dimension transfer, flood). The protected half was answered in (3), so the rule
  // is still composed of the ONE shared function and never a second copy of it.
  if (protectedVerdict !== null) {
    return refuse(
      scaffoldReasonFor(protectedVerdict.reason),
      protectedVerdict.cell ?? probe.landing,
      protectedVerdict.block,
      protectedVerdict.detail,
    )
  }

  // (7) STRICT VERTICAL REDUCTION. The landing is one block below the body by
  // construction; a target level below the body is what bounds the whole route.
  if (facts.targetY !== null && probe.landing.y < facts.targetY) {
    return refuse(
      'no_landing',
      probe.landing,
      probe.landingName,
      `the landing ${cellText(probe.landing)} is below the target level y=${facts.targetY}, so this step would overshoot`,
    )
  }
  if (probe.landing.y >= fromY) {
    return refuse(
      'no_landing',
      probe.landing,
      probe.landingName,
      `the landing ${cellText(probe.landing)} does not strictly reduce the body's own level y=${fromY}`,
    )
  }

  const reference = descentPlaceReference(probe.selfFeet)
  // The strict-reduction evidence the caller mirrors: the gap to the goal's own
  // level before and after this leg. `null` when the goal carries no level.
  const fromGap = facts.targetY === null ? null : fromY - facts.targetY
  const toGap = facts.targetY === null ? null : probe.landing.y - facts.targetY
  return {
    kind: 'step',
    plan: {
      from: probe.selfFeet,
      landing: probe.landing,
      place: probe.place,
      block: blockName,
      remaining: Math.max(0, facts.blockCount - 1),
      reference: reference.reference,
      places: true,
      landingY: probe.landing.y,
      targetY: facts.targetY,
      fromGap,
      toGap,
      pocketEvidence: descentScaffoldPocketEvidence(probe, blockName),
    },
  }
}

// ---------------------------------------------------------------------------
// The marker vocabulary
// ---------------------------------------------------------------------------

/**
 * The descent markers, on the EXISTING bridge vocabulary rather than a parallel
 * one: a downward self-landing leg is a bridge leg, rotated. `kind=self_landing_down`
 * is what makes the rotation readable, and every field name (`from`/`to`/`cell`/
 * `placed`/`verified`/`reason`/`block`) is the field the horizontal marker already
 * carries, so one reader parses both.
 */
export const DESCEND_SCAFFOLD_START = 'DESCEND_SCAFFOLD_START'
export const DESCEND_SCAFFOLD_STEP = 'DESCEND_SCAFFOLD_STEP'
export const DESCEND_SCAFFOLD_END = 'DESCEND_SCAFFOLD_END'
export const DESCEND_SCAFFOLD_REFUSED = 'DESCEND_SCAFFOLD_REFUSED'

// ---------------------------------------------------------------------------
// The candidate contract (the meta keys the executor and the envelope read)
// ---------------------------------------------------------------------------

/** The item this DESCEND leg places, and therefore consumes. Read by `routePlaceDeclaration`. */
export const DESCEND_SCAFFOLD_BLOCK_META = 'descentScaffoldBlock'
/** The single cell this DESCEND leg places into: the envelope's `mayPlaceBlocks` identity. */
export const DESCEND_SCAFFOLD_PLACE_META = 'descentScaffoldPlace'
/** The cell the body stands in after the step: the leg's own postcondition. */
export const DESCEND_SCAFFOLD_LANDING_META = 'descentScaffoldLanding'
/** The shared per-cell pocket evidence, mirrored on the start line. */
export const DESCEND_SCAFFOLD_POCKET_META = 'descentScaffoldPocket'
/** The typed `DESCEND_SCAFFOLD_REFUSED` line when the world did not ground the step. */
export const DESCEND_SCAFFOLD_REFUSED_META = 'descentScaffoldRefusedLine'
/** The declared placement reference (the footprint the body places against). */
export const DESCEND_SCAFFOLD_REFERENCE_META = 'descentScaffoldReference'
/** The cell the body starts the leg from. */
export const DESCEND_SCAFFOLD_FROM_META = 'descentScaffoldFrom'
/** The strict vertical-reduction evidence: `gap=<before>-><after>`. */
export const DESCEND_SCAFFOLD_GAP_META = 'descentScaffoldGap'

/** The exact `DESCEND_SCAFFOLD_START` line: the leg's declared placement, before it runs. */
export function formatDescentScaffoldStart(input: {
  from: Vec3Json
  landing: Vec3Json
  place: Vec3Json
  block: string
  remaining: number
  pocketEvidence: string
}): string {
  return (
    `${DESCEND_SCAFFOLD_START} kind=self_landing_down from=${key(input.from)} to=${key(input.landing)} ` +
    `cell=${key(input.place)} block=${input.block} self_landing=true pocket=${input.pocketEvidence}`
  )
}

/** The exact `DESCEND_SCAFFOLD_STEP` line: the block is in the world and the body really moved down onto it. */
export function formatDescentScaffoldStep(input: {
  from: Vec3Json
  to: Vec3Json
  cell: Vec3Json
  placed: boolean
  block: string
}): string {
  return (
    `${DESCEND_SCAFFOLD_STEP} from=${key(input.from)} to=${key(input.to)} cell=${key(input.cell)} ` +
    `placed=${input.placed ? 'true' : 'false'} block=${input.block}`
  )
}

/**
 * The exact `DESCEND_SCAFFOLD_END` line: the leg's outcome, with the block it
 * consumed and the level it really changed. `verified` is the same predicate the
 * horizontal leg uses (the body occupies the landing AND the remaining gap
 * strictly shrank), so a placement without a proven advance is never progress.
 */
export function formatDescentScaffoldEnd(input: {
  fromY: number
  toY: number
  placed: number
  verified: boolean
  reason: string
  block: string
}): string {
  return (
    `${DESCEND_SCAFFOLD_END} from_y=${input.fromY} to_y=${input.toY} placed=${input.placed} ` +
    `verified=${input.verified ? 'true' : 'false'} reason=${input.reason} block=${input.block}`
  )
}

/** The exact `DESCEND_SCAFFOLD_REFUSED` line: the typed refusal, naming the cell and the state below it. */
export function formatDescentScaffoldRefused(refusal: DescentScaffoldRefusal): string {
  return (
    `${DESCEND_SCAFFOLD_REFUSED} reason=${refusal.reason} from_y=${refusal.fromY} to_y=${refusal.toY} ` +
    `cell=${key(refusal.cell)} below=${refusal.below ?? 'unknown'} block=${refusal.block ?? 'none'}`
  )
}

/** The bridge-vocabulary reason this route's refusal maps onto, for the shared refusal log. */
export function descentScaffoldBridgeReason(reason: DescentScaffoldRefusalReason): BridgeRefusalReason {
  switch (reason) {
    case 'no_block':
      return 'no_block'
    case 'hazard':
      return 'hazard'
    case 'protected':
      return 'protected'
    case 'would_flood':
      return 'would_flood'
    case 'portal_plane':
      return 'portal_plane'
    case 'unbreakable':
      return 'unbreakable'
    default:
      return 'no_verified_landing'
  }
}

/**
 * The descent-vocabulary reason this route's refusal maps onto, for the
 * reachability capability key.
 *
 * The reachability vocabulary (`reachability.ts#DescendPlanRefusalReason`) already
 * names the five shared per-cell facts; this route adds four facts of its own
 * ("I am about to CREATE the floor I land on"), and they fold onto the two honest
 * buckets rather than widening a vocabulary every fingerprint depends on:
 *
 *   `no_ground`  -> `no_support`  (the same fact: nothing under the landing);
 *   `no_landing` / `not_air` / `no_block` -> `no_safe_step` (the pool carried no
 *                 executable down step, which is exactly what that token means).
 *
 * The route's OWN typed marker (`DESCEND_SCAFFOLD_REFUSED`) always carries the
 * unwidened reason, so nothing is lost.
 */
export function descendScaffoldReachabilityReason(reason: DescentScaffoldRefusalReason): string {
  switch (reason) {
    case 'no_ground':
      return 'no_support'
    case 'no_landing':
    case 'not_air':
    case 'no_block':
      return 'no_safe_step'
    default:
      return reason
  }
}

/**
 * The one-line gap summary a caller mirrors beside the leg's outcome: how much of
 * the descent the leg really closed. `none` when the goal carries no target level.
 */
export function formatDescentScaffoldGap(fromGap: number | null, toGap: number | null): string {
  if (fromGap === null || toGap === null) return 'gap=none'
  return `gap=${fromGap}->${toGap}`
}

/** True when a step is a strict vertical reduction of the gap to the target level. */
export function strictlyReducesDescentGap(plan: DescentScaffoldPlan): boolean {
  if (plan.fromGap === null || plan.toGap === null) return plan.landingY < plan.from.y
  return plan.toGap <= plan.fromGap - 1
}

/** Re-exported so a caller can name the shared constant without importing two modules. */
export { BRIDGE_MIN_ADVANCE }
