// levelScan.ts - the BOUNDED LEVEL SCAN: when nothing at the body's own level can ground
// a route toward the target, and the terrain below is solid ground, the descent to a level
// that DOES have a grounded continuation is the route - expressed honestly, with the SAME
// per-cell flood rule applied at every level.
//
// THE MEASURED GAP (live, the operator's Nether arrival, run-muchajde-1qhat, chunk (0,-1);
// the wall-entry lane landed the adjacent case and explicitly deferred this one):
//
//   the body stands at (2.7,59,-2.5) on a small solid island around the portal (soul soil /
//   soul sand, y58-60, x=0-3). EAST of it at the body's own level is the portal plane at
//   x=3 (standing there TELEPORTS the body back to the overworld - the observed ENTER/WAIT
//   ping-pong), then open air, then the lava wall at y58-59 x=10..13. ABOVE: the higher the
//   level the MORE lava (261 cells at y59-62, 328 at y71-75), so "climb and bridge over" is
//   defeated by construction. BELOW: the subsurface is SOLID (y55-58 soul soil 440 / soul
//   sand 35 / lava 109), i.e. a descend-and-tunnel-east route physically exists.
//
//   The live ledger says exactly why the two existing arms cannot ground it:
//
//     DIG_ROUTE_REFUSED reason=no_grounded_route ... (ledger: E=no_wall Ev=protected ...)
//
//   * `digRoute.ts#planDigRoute` iterates ONLY the steps the sensor pre-computed at the
//     body's OWN level, and every one of them must STRICTLY reduce the 3-D distance to the
//     target. A pure descent does not: it keeps the horizontal distance and grows the
//     vertical gap, so the own-column step is (correctly) never a route, and the level
//     steps at y59 mine nothing (`no_wall` - the profile is already open) or aim at the
//     frame (`protected`). The arm refuses `no_grounded_route` rather than smuggling in an
//     unbounded descent.
//   * `wallEntry.ts#groundWallEntries` judges the same eight adjacent probes, so a body
//     whose only openable rock is BELOW it has nothing to offer.
//
// WHAT THIS MODULE OWNS (and nothing else does): the ONE rule for "which level below, and
// which lateral continuation at that level, together make a route that strictly reduces the
// distance to the target". It does NOT own the block truth (the sensor reads it:
// `state.ts#buildLevelScanProbes`), it does NOT own the pocket safety rule
// (`wallEntry.ts#wallPocketRefusal` is called here - the same function the adjacent wall
// entry uses), and it does NOT choose among grounded routes (the caller enumerates them and
// Jev chooses).
//
// THE COMPOSED ROUTE, AND WHY IT TERMINATES:
//
//   A route is `(descent chain of k <= N own-column steps) + (ONE lateral continuation at
//   level y-k)`. Two strict-reduction facts must BOTH hold, and together they are the
//   terminating bound:
//
//     (continuation) the lateral step strictly reduces the distance FROM THE LEVEL IT IS
//                    TAKEN AT: `d(landing, target) <= d(levelFeet, target) - minAdvance`.
//                    That is the ordinary `digRoute.ts` rule at that level, so once the
//                    body is there the ORDINARY dig route / wall entry grounds the very same
//                    step: the descent's continuation is a real step, never a promise.
//     (composed)     the route's terminus is strictly closer to the target than the body is
//                    NOW: `d(landing, target) <= d(feet, target) - minAdvance`. This is what
//                    makes "descend to a level which then reduces" a reduction, expressed
//                    honestly: the distance is measured to the ROUTE'S OWN END, never to an
//                    intermediate step.
//
//   The distance to a fixed target is bounded below by zero and every offered route removes
//   at least `minAdvance` from it, so no offered route fails to end closer. The descent is
//   offered ONE STEP AT A TIME (the own-column dig at the body's current level, exactly the
//   step `state.descent` already carries), and the caller runs the scan only while the
//   body's OWN level offers no grounded continuation - so when the body arrives at the level
//   whose continuation grounded, that level's own lateral step IS the route and no further
//   descent is offered. A body that cannot descend controllably (open floor, unloaded cell,
//   a fluid face-adjacent to the shaft) gets a typed refusal for that level and every level
//   below it, never a fall.
//
// THE BOUNDS (all declared, all mechanical):
//
//   LEVEL_SCAN_MAX_LEVELS = 3   the scan probes y-1..y-3 only. The measured rock band is 4
//                               blocks thick and the first dry lateral continuation sits
//                               2-3 levels down; a deeper window is a mining project, not a
//                               local remedy, and the body re-scans from every level it
//                               actually reaches (the descent is real progress toward the
//                               entry level, so nothing is lost by not looking further).
//   LEVEL_SCAN_PROBES_PER_LEVEL = 5   the own-column shaft + the four cardinal laterals.
//   LEVEL_SCAN_MAX_PROBES = 15  the hard per-tick probe bound; the sensor reads at most
//                               that many (15 probes x a 1x2 profile + its floor + the
//                               pocket's six-neighbourhood ~= 225 direct chunk lookups), and
//                               only while the sensor's own wall-entry gate already fired.
//   LEVEL_SCAN_MAX_ROUTE_LENGTH = 4   k own-column steps + one continuation. The offered
//                               CANDIDATE is always just the FIRST step (the own-column dig
//                               at the body's level) - the same single action the ordinary
//                               DESCEND executor runs - and the level/continuation it heads
//                               for is carried as evidence, re-derived from fresh state
//                               every tick.
//
// ENUMERATE, NEVER RANK: every level x direction that grounds is returned. The caller offers
// the one mechanical first step, names every grounded (level, direction) in the boundary
// line and in the candidate meta, and code picks neither a level nor a direction. When
// exactly ONE grounds, the caller may run it as the section 7 prerequisite.
//
// ONE RULE, TWO FACT PRODUCERS: the per-cell verdict is `wallEntry.ts#wallPocketRefusal`, so
// the body's adjacent probes and these deeper probes cannot disagree about what "this pocket
// may be opened" means.
//
// Pure: no bot, no clock, no model. Same facts in -> same routes (or refusal) out.
import type { DescentRefusalReason, Vec3Json } from './state.ts'
import type { WallCell, WallDir, WallEntryRefusalReason, WallPocketFacts, WallProbe } from './wallEntry.ts'
import { FACE_OFFSETS, WALL_DIRS, isTunnelFloodBlockName, wallPocketRefusal } from './wallEntry.ts'

/**
 * How many levels below the body the scan may look. See the module header: the window is a
 * local-remedy bound, and the body re-scans from every level it reaches.
 */
export const LEVEL_SCAN_MAX_LEVELS = 3

/** The number of probes one level costs: the own-column shaft + one per cardinal direction. */
export const LEVEL_SCAN_PROBES_PER_LEVEL = 1 + WALL_DIRS.length

/** The hard bound on probes one scan may read (`state.ts#buildLevelScanProbes` obeys it). */
export const LEVEL_SCAN_MAX_PROBES = LEVEL_SCAN_MAX_LEVELS * LEVEL_SCAN_PROBES_PER_LEVEL

/** The hard bound on a composed route's length: k own-column steps + one continuation. */
export const LEVEL_SCAN_MAX_ROUTE_LENGTH = LEVEL_SCAN_MAX_LEVELS + 1

/** How much closer to the target a continuation must land (`digRoute.ts`'s own margin). */
export const LEVEL_SCAN_MIN_ADVANCE = 0.25

/**
 * One level's own-column descent facts: the shaft the body digs straight down into this
 * level, its pre-existing floor, and whether a fluid is face-adjacent to the new shaft.
 * Judged by `wallEntry.ts#wallPocketRefusal` (the same rule the adjacent wall entry uses),
 * so a shaft that would pour lava in is refused here exactly as a wall would be.
 */
export interface LevelShaftFacts extends WallPocketFacts {
  /**
   * The SENSOR's own verdict for this step at the body's own level (`DescentOption.refusal`,
   * `null` when the sensor called it safe). Only the body's own level has one; every deeper
   * shaft is judged by the per-cell rule alone. A sensor verdict the per-cell rule cannot
   * supersede (`open_floor` / `no_support` / `unbreakable` / `protected`) breaks the chain,
   * so the offered descent and the guard can never disagree about what the first step is.
   */
  sensorRefusal?: DescentRefusalReason | null
}

/** One cardinal same-level continuation at a scanned level. */
export interface LevelLateralFacts extends WallPocketFacts {
  dir: WallDir
  dx: number
  dz: number
  /** the cell the body occupies after the continuation (mine target for a dig, stand cell for a walk) */
  cell: Vec3Json
  /** the 1x2 profile at `cell`; for a WALK both cells are already open and nothing is mined */
  pocket: [WallCell, WallCell]
  /**
   * A WALK continuation: the profile is already open passage, its floor is real ground and
   * neither cell transfers the body. `flood` is then meaningless (this opens nothing) and is
   * reported as false; the ordinary MOVE/landing guards own the walking itself.
   */
  walk: boolean
}

/** One scanned level: the descent into it plus the four continuations AT it. */
export interface LevelScanProbe {
  /** the level (feet y) these facts were read at */
  y: number
  /** how many levels below the body this level is (1..LEVEL_SCAN_MAX_LEVELS) */
  depth: number
  /** the own-column controlled descent into this level */
  shaft: LevelShaftFacts
  /** the four same-level continuations at this level, in the sensor's fixed order */
  laterals: LevelLateralFacts[]
}

/** Why one (level, direction) pair is not a continuation. */
export type LevelScanRefusalReason =
  | WallEntryRefusalReason
  | DescentRefusalReason
  | 'no_progress'
  | 'chain_broken'

/**
 * One pocket's typed refusal in the level scan's vocabulary: `wallEntry.ts`'s shared verdict
 * extended with the two causes only a descent can carry (`open_floor` from the sensor's own
 * own-column step, and the scan's own `no_progress` / `chain_broken` facts).
 */
export interface LevelPocketRefusal {
  reason: LevelScanRefusalReason
  target: Vec3Json
  cell: Vec3Json | null
  block: string | null
  detail: string
}

/** One (level, direction) verdict, kept whether it grounded or not (the ledger). */
export interface LevelScanVerdict {
  level: number
  depth: number
  /** null for the level's own-column shaft verdict */
  dir: WallDir | null
  cell: Vec3Json | null
  block: string | null
  ok: boolean
  /** 'safe' when this pair grounded a dig, 'walk' when the continuation is open passage */
  reason: LevelScanRefusalReason | 'safe' | 'walk'
  detail: string
}

/** One grounded composed route: descend to `level`, then take `dir` at that level. */
export interface LevelScanRoute {
  /** the level the continuation is taken at */
  level: number
  /** how many own-column steps the descent chain has (1..LEVEL_SCAN_MAX_LEVELS) */
  depth: number
  /** the chain length: `depth` descents + the one continuation (<= LEVEL_SCAN_MAX_ROUTE_LENGTH) */
  length: number
  dir: WallDir
  dx: number
  dz: number
  /** the feet cell the body occupies at the end of the composed route */
  cell: Vec3Json
  /** the primary block the continuation removes (null for a WALK: nothing is mined) */
  dig: Vec3Json | null
  block: string | null
  /** the pre-existing floor the continuation stands on */
  floor: Vec3Json
  floorBlock: string | null
  /** the continuation is an already-open passage the ordinary walk owns */
  walk: boolean
  /** the body's own feet cell the composed route starts from */
  from: Vec3Json
  /** the first step of the descent chain: the own-column dig at the body's own level */
  firstStep: Vec3Json
  /** the cells the first step removes (one cell: the own-column floor) */
  firstStepDigCells: Vec3Json[]
  /** the block the first step removes */
  firstStepBlock: string | null
  /** feet-cell distance to the target before the composed route */
  fromDistance: number
  /** feet-cell distance to the target at the composed route's terminus (strictly smaller) */
  toDistance: number
  /** the same strict reduction measured at the continuation's own level (the ordinary rule) */
  levelFromDistance: number
  levelToDistance: number
  /** the per-level/mode evidence of the continuation this route was grounded from */
  evidence: string
  /** every (level, direction) verdict this tick, grounded or not */
  verdicts: LevelScanVerdict[]
}

export interface LevelScanRefusal {
  reason: LevelScanRefusalReason
  target: Vec3Json
  /** the refused cell, when the geology names one */
  cell: Vec3Json | null
  block: string | null
  /** the sensor's own cause plus the per-level ledger (never a synthesized fact) */
  detail: string
}

export type LevelScanDecision =
  | { kind: 'route'; routes: LevelScanRoute[] }
  | { kind: 'refuse'; refusal: LevelScanRefusal }

export interface LevelScanInput {
  /** live body position (fractional is fine; the feet cell is floored) */
  selfPosition: Vec3Json
  /** the goal's own target cell */
  target: Vec3Json
  /** the sensor's per-level probes (`WorldState.levelScan`) */
  levels: readonly LevelScanProbe[] | null | undefined
  minAdvance?: number
  /** the #436 U5 protected-resource test (protected station / live structure) */
  isProtected?: (cell: Vec3Json, name: string | null) => boolean
}

/** The same floored-cell distance every other locomotion rule measures. */
function distance(a: Vec3Json, b: Vec3Json): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function cellText(cell: Vec3Json): string {
  return `${Math.floor(cell.x)},${Math.floor(cell.y)},${Math.floor(cell.z)}`
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

type PocketVerdictInput = WallPocketFacts & {
  walk?: boolean
  sensorRefusal?: DescentRefusalReason | null
}

/**
 * The per-cell verdict of one already-read pocket, in the level scan's vocabulary: the
 * shared `wallEntry.ts#wallPocketRefusal` plus the two facts only the level scan carries.
 *
 *   * a SHAFT's sensor verdict the per-cell rule cannot prove wrong (`open_floor` is the
 *     important one: an already-open floor is an uncontrolled fall, not a dig) refuses here,
 *     so the offered first step is exactly the step the guard re-reads from `state.descent`;
 *   * a pocket with nothing to mine is a WALK continuation at a lateral (`walk === true`),
 *     while the same shape on a shaft is the shared rule's `no_wall` refusal.
 */
function pocketVerdict(
  facts: PocketVerdictInput,
  isProtected: (cell: Vec3Json, name: string | null) => boolean,
  describe: string,
): LevelPocketRefusal | null {
  const sensorRefusal: LevelPocketRefusal | null =
    facts.sensorRefusal === undefined || facts.sensorRefusal === null
      ? null
      : {
          reason: facts.sensorRefusal,
          target: facts.landing,
          cell: facts.landing,
          block: facts.pocket[0].name,
          detail:
            `${describe} is refused by the sensor (${facts.sensorRefusal}): ` +
            `${facts.pocket[0].name ?? 'the block'} at (${cellText(facts.landing)})`,
        }
  // A sensor `open_floor` is the one verdict the per-cell rule has no vocabulary for (a
  // pocket with nothing to mine reads `no_wall` there, but an already-open floor under the
  // body's column is an uncontrolled FALL, not a walk). It is kept first, before anything else.
  if (sensorRefusal !== null && facts.sensorRefusal === 'open_floor') return sensorRefusal
  // Otherwise the per-cell rule runs FIRST: it names the cell that is unobserved / unsupported
  // / already pouring (the honest and actionable cause), while the sensor's own verdict names
  // only the landing cell. `hazard` is the one sensor verdict the per-cell rule may supersede
  // (the 3x3x3 proximity union versus the pocket's actual faces).
  if (facts.walk !== true) {
    const shared = wallPocketRefusal(facts, isProtected, describe)
    if (shared !== null) return { ...shared, reason: shared.reason as LevelScanRefusalReason }
  }
  if (sensorRefusal !== null && facts.sensorRefusal !== 'hazard') return sensorRefusal
  return null
}

interface LevelRefusalWithLocation extends LevelPocketRefusal {
  level: number
  depth: number
  dir: WallDir | null
}

/**
 * Ground EVERY composed route `(descent chain <= N own-column steps) + (one lateral
 * continuation)` that strictly reduces the distance to `target`, at every level the scan
 * probed. Nothing is ranked: the caller enumerates them and Jev chooses.
 *
 * The chain rule: a level is reachable only when its own-column shaft AND every shaft above
 * it are verified by the per-cell rule, so a level whose descent would flood, fall or hit
 * unloaded rock can neither be a route nor be a stepping stone to a deeper one. The refusal
 * always carries the per-level ledger, so "no route" stays auditable.
 */
export function groundLevelScan(input: LevelScanInput): LevelScanDecision {
  const feet: Vec3Json = {
    x: Math.floor(input.selfPosition.x),
    y: Math.floor(input.selfPosition.y),
    z: Math.floor(input.selfPosition.z),
  }
  const target = input.target
  const minAdvance = input.minAdvance ?? LEVEL_SCAN_MIN_ADVANCE
  const isProtected = input.isProtected ?? ((): boolean => false)
  const fromDistance = distance(feet, target)
  const verdicts: LevelScanVerdict[] = []
  const routes: LevelScanRoute[] = []
  const refusals: LevelRefusalWithLocation[] = []

  const record = (
    level: number,
    depth: number,
    dir: WallDir | null,
    cell: Vec3Json | null,
    block: string | null,
    reason: LevelScanVerdict['reason'],
    detail: string,
  ): void => {
    verdicts.push({ level, depth, dir, cell, block, ok: reason === 'safe' || reason === 'walk', reason, detail })
  }
  const refuse = (
    level: number,
    depth: number,
    dir: WallDir | null,
    refusal: LevelPocketRefusal,
  ): void => {
    record(level, depth, dir, refusal.cell, refusal.block, refusal.reason, refusal.detail)
    refusals.push({ ...refusal, level, depth, dir })
  }

  const levels = (input.levels ?? [])
    .filter((probe) => probe.depth >= 1 && probe.depth <= LEVEL_SCAN_MAX_LEVELS)
    .slice()
    .sort((a, b) => a.depth - b.depth)
    .slice(0, LEVEL_SCAN_MAX_LEVELS)

  // The chain is broken for every level at or below the first shaft that cannot be dug
  // controllably. That single fact is what makes the window a CHAIN bound rather than N
  // independent guesses.
  let chainBroken = false
  /** the first shaft refusal: the one that broke the chain (the headline cause). */
  let shaftRefusal: LevelPocketRefusal | null = null
  for (const probe of levels) {
    const describe = `the level-${probe.y} own-column descent`
    if (chainBroken) {
      record(probe.y, probe.depth, null, probe.shaft.landing, probe.shaft.pocket[0].name, 'chain_broken', 'the descent chain above this level is broken')
      for (const lateral of probe.laterals) {
        record(probe.y, probe.depth, lateral.dir, lateral.cell, lateral.pocket[0].name, 'chain_broken', 'the descent chain to this level is broken')
      }
      continue
    }
    const refusal = pocketVerdict(probe.shaft, isProtected, describe)
    if (refusal !== null) {
      chainBroken = true
      if (shaftRefusal === null) shaftRefusal = refusal
      refuse(probe.y, probe.depth, null, refusal)
      // The level's continuations are still reported (the ledger says what is down there),
      // but none of them can be a route: the body cannot get there.
      for (const lateral of probe.laterals) {
        record(probe.y, probe.depth, lateral.dir, lateral.cell, lateral.pocket[0].name, 'chain_broken', 'the descent chain to this level is broken')
      }
      continue
    }
    record(
      probe.y,
      probe.depth,
      null,
      probe.shaft.landing,
      probe.shaft.pocket[0].name,
      'safe',
      `${describe} is verified (floor ${probe.shaft.floor.name ?? 'unknown'}, flood=none)`,
    )

    const levelFeet: Vec3Json = { x: feet.x, y: probe.y, z: feet.z }
    const levelFromDistance = distance(levelFeet, target)
    for (const dir of WALL_DIRS) {
      const lateral = probe.laterals.find((entry) => entry.dir === dir)
      if (lateral === undefined) continue
      const describeLateral = `the level-${probe.y} ${dir} continuation`
      const verdict = pocketVerdict(lateral, isProtected, describeLateral)
      if (verdict !== null) {
        refuse(probe.y, probe.depth, dir, verdict)
        continue
      }
      const levelToDistance = distance(lateral.cell, target)
      const walk = lateral.walk === true
      const via = walk ? 'walk' : 'dig'
      // (continuation) the ordinary strict-reduction rule AT this level - the step the
      // ordinary dig route / wall entry grounds once the body is there.
      if (!(levelToDistance <= levelFromDistance - minAdvance)) {
        const detail =
          `the level-${probe.y} ${dir} ${via} lands at ${round2(levelToDistance)}m from the target, ` +
          `not strictly closer than ${round2(levelFromDistance)}m`
        record(probe.y, probe.depth, dir, lateral.cell, lateral.pocket[0].name, 'no_progress', detail)
        refusals.push({ reason: 'no_progress', target: lateral.cell, cell: lateral.cell, block: lateral.pocket[0].name, detail, level: probe.y, depth: probe.depth, dir })
        continue
      }
      // (composed) the route's OWN terminus must be strictly closer than the body is now.
      // This is the terminating bound: a descent is never offered as a step that only moves
      // the body, only as the first step of a route that ends measurably closer.
      if (!(levelToDistance <= fromDistance - minAdvance)) {
        const detail =
          `the composed route down to level ${probe.y} then ${dir} ${via} ends at ${round2(levelToDistance)}m from the target, ` +
          `not strictly closer than the body's ${round2(fromDistance)}m`
        record(probe.y, probe.depth, dir, lateral.cell, lateral.pocket[0].name, 'no_progress', detail)
        refusals.push({ reason: 'no_progress', target: lateral.cell, cell: lateral.cell, block: lateral.pocket[0].name, detail, level: probe.y, depth: probe.depth, dir })
        continue
      }
      const mined = lateral.pocket.filter((cell) => !cell.open)
      const dig = mined[mined.length - 1] ?? null
      const block = walk ? lateral.pocket[0].name : (dig?.name ?? lateral.pocket[0].name)
      const firstStepBlock = probe.shaft.pocket[0].name
      record(probe.y, probe.depth, dir, lateral.cell, block, walk ? 'walk' : 'safe', formatLateralEvidence(probe, lateral, walk))
      routes.push({
        level: probe.y,
        depth: probe.depth,
        length: probe.depth + 1,
        dir,
        dx: lateral.dx,
        dz: lateral.dz,
        cell: lateral.cell,
        dig: walk || dig === null ? null : dig.cell,
        block,
        floor: lateral.floor.cell,
        floorBlock: lateral.floor.name,
        walk,
        from: feet,
        firstStep: probe.shaft.pocket[0].cell,
        firstStepDigCells: [probe.shaft.pocket[0].cell],
        firstStepBlock,
        fromDistance,
        toDistance: levelToDistance,
        levelFromDistance,
        levelToDistance,
        evidence: formatLateralEvidence(probe, lateral, walk),
        verdicts,
      })
    }
  }

  const ledger = formatLevelLedger(verdicts)
  if (routes.length > 0) {
    // Every route carries the SAME ledger (this tick's per-level verdicts), so whichever one
    // Jev's plan takes, the log says what else was below the body and why it was not usable.
    for (const route of routes) route.verdicts = verdicts
    return { kind: 'route', routes }
  }
  // "A level was there and this is why it cannot be used" is more informative than "there was
  // nothing below", so a typed cause is promoted to the headline exactly like the wall entry
  // promotes its own. The CHAIN cause comes first: a lateral cause at a level the body cannot
  // even reach is not the blocker, the broken shaft above it is. `no_grounded_route` stays the
  // honest answer when nothing else names a cause (the ledger carries every verdict anyway).
  const wallLevel =
    shaftRefusal ??
    refusals.find((refusal) => refusal.reason === 'would_flood') ??
    refusals.find((refusal) => refusal.reason === 'portal_plane') ??
    refusals.find((refusal) => refusal.reason === 'no_support') ??
    refusals.find((refusal) => refusal.reason === 'protected') ??
    null
  if (wallLevel !== null && levels.length > 0) {
    return {
      kind: 'refuse',
      refusal: {
        reason: wallLevel.reason,
        target: wallLevel.target,
        cell: wallLevel.cell,
        block: wallLevel.block,
        detail: `${wallLevel.detail} (levels: ${ledger})`,
      },
    }
  }
  return {
    kind: 'refuse',
    refusal: {
      reason: 'no_grounded_route',
      target,
      cell: null,
      block: null,
      detail:
        `no level within ${LEVEL_SCAN_MAX_LEVELS} below (y${feet.y - 1}..y${feet.y - LEVEL_SCAN_MAX_LEVELS}) grounds a lateral ` +
        `continuation that makes the composed route strictly closer to the target ` +
        `(levels: ${ledger.length === 0 ? 'no_probe' : ledger})`,
    },
  }
}

/** `level=56;depth=3;dir=E;via=dig;cell=3,56,-2:soul_soil;head=...;floor=...:solid;shaft=...;mined=...;flood=none` */
function formatLateralEvidence(probe: LevelScanProbe, lateral: LevelLateralFacts, walk: boolean): string {
  const mined = lateral.pocket.filter((cell) => !cell.open)
  return (
    `level=${probe.y};depth=${probe.depth};dir=${lateral.dir};via=${walk ? 'walk' : 'dig'};` +
    `cell=${cellText(lateral.cell)}:${lateral.pocket[0].name ?? 'unknown'};` +
    `head=${cellText(lateral.pocket[1].cell)}:${lateral.pocket[1].name ?? 'unknown'};` +
    `floor=${cellText(lateral.floor.cell)}:${lateral.floor.name ?? 'unknown'}:solid;` +
    `shaft=${cellText(probe.shaft.pocket[0].cell)}:${probe.shaft.pocket[0].name ?? 'unknown'}` +
    `+floor:${cellText(probe.shaft.floor.cell)}:${probe.shaft.floor.name ?? 'unknown'};` +
    `mined=${mined.length === 0 ? 'none' : mined.map((cell) => `${cellText(cell.cell)}:${cell.name ?? 'unknown'}`).join('+')};` +
    `flood=none`
  )
}

/**
 * The per-level ledger: the own-column verdict (`Ev`) plus one token per (level, direction),
 * with the fluid cell and block named when the cause is a flood. `Ev` is the vertical step -
 * the same suffix the adjacent wall entry's ledger uses - so a refusal names every level the
 * scan looked at and why that level could not be used, floods included:
 *
 *   y58:Ev=safe|y58:E=protected|y57:Ev=would_flood@3,57,-2:lava|...
 */
export function formatLevelLedger(verdicts: readonly LevelScanVerdict[]): string {
  return verdicts
    .map((verdict) => {
      const token = `y${verdict.level}:${verdict.dir === null ? 'Ev' : verdict.dir}`
      // The geology causes name the cell and the block, so a refusal is actionable without
      // re-reading the world: an UNOBSERVED cell reads `unknown`, a fluid names itself, a
      // protected member names itself, and a flood names the fluid and the cell it sits in.
      if (
        verdict.cell !== null &&
        (verdict.reason === 'would_flood' ||
          verdict.reason === 'portal_plane' ||
          verdict.reason === 'unbreakable' ||
          verdict.reason === 'no_support' ||
          verdict.reason === 'hazard' ||
          verdict.reason === 'open_floor' ||
          verdict.reason === 'protected')
      ) {
        return `${token}=${verdict.reason}@${cellText(verdict.cell)}:${verdict.block ?? 'unknown'}`
      }
      return `${token}=${verdict.reason}`
    })
    .join('|')
}

/**
 * `LEVEL_SCAN reason=<reason> target=x,y,z level=<y> depth=<k> length=<n> from=x,y,z
 *  via=<dig|walk> cell=x,y,z block=<name> floor=x,y,z floor_block=<name>
 *  from_d=<n> to_d=<n> level_d=<n>-><n> [alternatives=<n>] levels=<per-level ledger>`
 *
 * The one line a reviewer greps to see the bounded level scan: WHICH level below the body the
 * route descends to, the exact cell and material of the continuation there, whether it is a
 * dig or an already-open walk, the pre-existing floor, the distance to the target before the
 * composed route and at its terminus, and - when more than one route grounded - that code
 * chose neither a level nor a direction. `levels=` carries every level's verdict (including
 * each level's flood verdict), so the line alone is auditable.
 */
export function formatLevelScan(input: {
  route: LevelScanRoute
  target: Vec3Json
  reason: string
  alternativeCount: number
}): string {
  const route = input.route
  return (
    `LEVEL_SCAN reason=${input.reason} target=${cellText(input.target)} level=${route.level} depth=${route.depth} ` +
    `length=${route.length} from=${cellText(route.from)} via=${route.walk ? 'walk' : 'dig'} ` +
    `cell=${cellText(route.cell)} block=${route.block ?? 'unknown'} ` +
    `floor=${cellText(route.floor)} floor_block=${route.floorBlock ?? 'unknown'} ` +
    `from_d=${round2(route.fromDistance)} to_d=${round2(route.toDistance)} ` +
    `level_d=${round2(route.levelFromDistance)}->${round2(route.levelToDistance)}` +
    (input.alternativeCount > 1 ? ` alternatives=${input.alternativeCount}` : '') +
    ` levels=${formatLevelLedger(route.verdicts)}`
  )
}

/**
 * `LEVEL_SCAN_STEP from=x,y,z level=<y> target_level=<L> remaining=<n> from_d=<n> to_d=<n>`
 *
 * Emitted when a settled level-scan descent measurably moved the body toward the scanned
 * level: the level actually reached, how many own-column steps still separate the body from
 * the continuation's level, and the distance to the target before/after. It is the measured
 * half of the composed claim, so "the scan descended toward a route" can be told apart from
 * "the scan refused".
 */
export function formatLevelScanStep(input: {
  from: Vec3Json
  to: Vec3Json
  targetLevel: number
  fromDistance: number
  toDistance: number
}): string {
  const remaining = Math.max(0, Math.floor(input.to.y) - input.targetLevel)
  return (
    `LEVEL_SCAN_STEP from=${cellText(input.from)} level=${Math.floor(input.to.y)} target_level=${input.targetLevel} ` +
    `remaining=${remaining} from_d=${round2(input.fromDistance)} to_d=${round2(input.toDistance)}`
  )
}

/**
 * Every face neighbour of a pocket that holds a fluid, as `(cell, block)` pairs, using the
 * SAME block rule and the SAME offsets `wallEntry.ts#floodEvidence` reads. Exported so a
 * fixture can show - from one world truth - that a fluid two cells away has NO face into the
 * pocket while a fluid in the neighbouring cell does.
 */
export function floodNeighbours(
  pocket: readonly Vec3Json[],
  at: (cell: Vec3Json) => { name: string | null; boundingBox: string | null } | null,
): Array<{ cell: Vec3Json; block: string }> {
  const seen = new Set<string>()
  const out: Array<{ cell: Vec3Json; block: string }> = []
  for (const cell of pocket) {
    for (const [dx, dy, dz] of FACE_OFFSETS) {
      const neighbour = { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz }
      const id = `${neighbour.x},${neighbour.y},${neighbour.z}`
      if (seen.has(id)) continue
      seen.add(id)
      const block = at(neighbour)
      if (block === null) continue
      if (!isTunnelFloodBlockName(block.name)) continue
      if (block.boundingBox !== 'empty') continue
      out.push({ cell: neighbour, block: block.name ?? 'fluid' })
    }
  }
  return out
}

/** Re-exported so a caller can name a probe's footprint without importing wallEntry too. */
export type { WallProbe }
