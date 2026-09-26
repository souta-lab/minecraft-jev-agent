// wallEntry.ts - the general "every WALK step from this stand is refused, so change
// the terrain the way a player does: mine the solid block beside you".
//
// THE MEASURED GAP (live, the operator's flooded Nether arrival, main a0bc3d6,
// run-muchajde-1qhat):
//
//   body pinned at (2.7,59,-2.5) on its little island, alternating ENTER/WAIT:
//     ENV_HAZARD kind=adjacent_lava / ENV_HAZARD_CLEAR         (the body senses it)
//     MOVE_LEG_STOPPED x4                                      (every walk step refused)
//     BRIDGE_REFUSED reason=no_verified_landing cell=3,59,-3   (no verified far side)
//     DIG_ROUTE_REFUSED x765 reason=hazard
//         target={0.87,64.66,1.65} bearing=SW cell={2,60,-2} block=air
//         detail=lava/water in the step column
//
//   The local geometry (read out of the save, not inferred): EAST is the portal
//   plane itself (stepping into it teleports the body back to the overworld - that
//   is the ping-pong), NORTH is air off the island edge, the frame obsidian is a LIVE
//   structure that must never be mined, and the island is only one block thick: the
//   thick solid rock (soul soil / netherrack, y55-57) is directly BELOW.
//
//   Every refusal is individually correct and the body still cannot move, because the
//   step vocabulary has no way to say "mine the adjacent solid block open and stand in
//   the hole you made".
//
// WHY NO OFFER EXISTS TODAY (file:line, main a0bc3d6):
//
//   * `digRoute.ts#planDigRoute` (digRoute.ts:317) iterates ONLY `input.descent` -
//     the four cardinal steps at {down, level} plus the own column that
//     `state.ts#buildDescent` pre-computes. A step shape the sensor did not compute
//     cannot be a route, whatever the world looks like.
//   * `state.ts#buildDescent#makeOption` (state.ts:2593-2693) decides `safe` for the
//     WHOLE step from a 3x3x3 PROXIMITY union (`state.ts:2613` +
//     `state.ts#hazardsAround`, state.ts:2706-2724): any lava/water block within two
//     cells of one of the step's five cells makes the step `hazard`. That is a
//     conservative *proximity* rule, not a per-cell flooding rule, so the sensor has
//     no vocabulary for "the pocket I would open is dry even though the neighbourhood
//     is not" - and `digRoute.ts:334-336` maps `!step.safe` straight to a refusal.
//   * nothing grounds the *mine-into-the-wall* shape at all: `candidates.ts:8159` and
//     `candidates.ts:10186` ground only that one dig route, and the bridge is grounded
//     from same-level probes only (`state.ts#buildBridgeProbes`, state.ts:3468-3477).
//
// WHAT THIS MODULE OWNS (and nothing else does): the ONE rule for "may the body open
// a tunnel into this adjacent cell, and will it stand on real ground inside a pocket
// no fluid can reach".
//
//   * THE TUNNEL'S FLOOR IS PRE-EXISTING ROCK. The body mines the 1x2 profile it will
//     occupy and stands on the block BELOW that profile, which the dig never touches.
//     That is why this step is safe exactly where a walk step over lava is not: there
//     is no fall column to fall into - the fall column ends in the rock one block
//     below the landing (a `down` entry lowers the body one block onto that rock; a
//     `level` entry stands on it directly).
//   * THE FLOOD RULE IS MECHANICS, NOT A BENCHMARK TABLE. Mining a solid block
//     replaces it with air, and a fluid can only enter that new air cell by the game's
//     own flow rule: it spreads into the four horizontally adjacent cells (and falls
//     straight down) when its level allows. So the dig can pour lava/water into the
//     pocket if and only if a FLUID block is FACE-ADJACENT to a pocket cell.
//     `TUNNEL_FLOOD_BLOCKS` is therefore exactly the fluids, and the check is exactly
//     the 6-neighbourhood of each pocket cell:
//       - a fluid two cells away is NOT a flood: it would have to occupy the solid
//         cell between, and this dig does not open that cell (this is the case the
//         proximity rule wrongly refused, and it is the whole capability);
//       - `magma_block`, `cactus`, `fire` and the campfires are contact hazards, not
//         fluids - they cannot fill the pocket, so refusing a dig beside them would be
//         a false negative of exactly the kind that pinned the body;
//       - a fluid directly above the head cell is face-adjacent and IS caught;
//       - a fluid INSIDE the profile means the body would stand in it: `hazard`.
//   * UNKNOWN IS NOT SAFE HERE. A dig CREATES the space the body will occupy, so the
//     profile, the floor and the pocket's faces must be positively observed; an
//     unloaded cell can only make an entry refuse.
//
// AUTHORITY: code owns CAN/TRUE/SAFE (which adjacent cells exist, which are solid and
// breakable, whether the pocket can be flooded, whether the step strictly closes the
// distance, whether the target is a protected asset). Jev still owns WHICH grounded
// candidate to take - when several directions/modes ground, every one of them is
// offered and the boundary is stated (`candidates.ts#wallEntryCandidates`); code never
// picks one. System2 still owns WHAT the goal is. There is no Nether/lava/M3 branch
// and no hard-coded coordinate.
//
// BOUNDED BY CONSTRUCTION: the entry advances the body exactly ONE cell, and only when
// that cell STRICTLY reduces the distance to the goal's own target (the same rule and
// the same margin `digRoute.ts` uses, so a staircase entry that heads toward a target
// that is also above is still legal and a body that cannot get closer stops). The
// ordinary zero-progress route identity spends a repeat, and the ordinary DESCEND
// executor digs the same 1x2 profile every other bounded dig step digs.
//
// REUSE, NOT REBUILD: each probe carries the sensor's OWN `DescentOption` for that
// direction and mode (`state.ts#buildDescent`) - the same 1x2 profile, the same primary
// cell, the same dig plan, the same candidate builder (`descendCandidateFromStep`) and
// the same executor (`runDescend`) as every other dig step.
//
// Pure: no bot, no clock, no model. Same facts in -> same routes (or refusal) out.
//
// ONE RULE, TWO FACT PRODUCERS: the per-cell verdict is `wallPocketRefusal` below. It is
// exported and is the SAME function the bounded LEVEL SCAN reads (`levelScan.ts`), so the
// body's own adjacent probes and the deeper same-column probes cannot disagree about what
// "this pocket may be opened" means.
import { DIMENSION_TRANSFER_BLOCKS } from './netherPortalPlan.ts'
import type { DescentMode, DescentOption, Vec3Json } from './state.ts'

/**
 * The blocks that can POUR into a space the body just opened: fluids only.
 *
 * `state.ts PROBE_FLUIDS` owns the water family and `envHazard.ts ENV_LAVA_BLOCKS`
 * the lava family; the names are repeated here as literals for the same reason
 * `bridgeRoute.ts#BRIDGE_UNSAFE_BLOCKS` repeats them - a value import from `state.ts`
 * would close a module cycle, because the sensor reads this rule while it builds
 * `WorldState`. `magma_block`, `cactus`, `fire` and the campfires are deliberately
 * absent: they are contact hazards, not fluids, and they cannot fill the pocket.
 */
export const TUNNEL_FLOOD_BLOCKS: ReadonlySet<string> = new Set([
  'lava',
  'flowing_lava',
  'water',
  'flowing_water',
  'bubble_column',
])

/** The one flood predicate: a block name that can flow into a new air cell. */
export function isTunnelFloodBlockName(name: string | null | undefined): boolean {
  return typeof name === 'string' && TUNNEL_FLOOD_BLOCKS.has(name)
}

/** The six face neighbours of a cell: the only cells a fluid can flow from. */
export const FACE_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
]

/** The four cardinal directions, in the sensor's fixed enumeration order. */
export type WallDir = 'E' | 'W' | 'N' | 'S'

export const WALL_DIRS: readonly WallDir[] = ['E', 'W', 'N', 'S']

/** The block slice the wall rules need (a Mineflayer block, or a fixture cell). */
export interface WallBlockLike {
  name: string | null
  /** `empty` for air and for every fluid; `block` for a full solid face */
  boundingBox: string | null
  /** mineflayer's hardness-derived "can this ever be broken" flag */
  diggable: boolean
}

/** One already-sensed cell of an entry probe. */
export interface WallCell {
  cell: Vec3Json
  name: string | null
  /** passable: air, or a fluid the body could occupy */
  open: boolean
  /** a full solid block */
  solid: boolean
  /** `solid` and breakable at all (hardness), regardless of the held tool */
  breakable: boolean
  /** the cell was actually read (an unloaded cell is never a fact) */
  observed: boolean
}

/**
 * One direction+mode probe: the 1x2 profile the body would occupy after the entry,
 * the pre-existing floor it would stand on, and the flood fact of the pocket.
 *
 * `pocket[0]` is the feet cell and `pocket[1]` the head cell of the ENTRY profile -
 * for a `level` entry those are the sensor's `wall`/`head`, for a `down` entry the
 * sensor's `floor`/`wall`. `floor` is always `landing.y - 1` and is never mined.
 */
export interface WallProbe {
  dir: WallDir
  mode: DescentMode
  dx: number
  dz: number
  /** the feet cell the body stands in after the entry */
  landing: Vec3Json
  /** the 1x2 profile at the landing: each cell is open already, or mined by this dig */
  pocket: [WallCell, WallCell]
  /** the pre-existing block the body will stand on (`landing.y - 1`), never mined */
  floor: WallCell
  /** a fluid is FACE-ADJACENT to a pocket cell: the dig would pour it into the tunnel */
  flood: boolean
  /** the fluid cell that would pour in, when `flood` */
  floodCell: Vec3Json | null
  /** the fluid block that would pour in, when `flood` */
  floodBlock: string | null
  /**
   * The sensor's own step this entry executes. The entry IS that step mechanically;
   * it is grounded here because the sensor's proximity `hazard`/`no_support` verdict
   * refuses the step while the per-cell rule proves the pocket is safe.
   */
  step: DescentOption
}

/** The typed cause of a wall entry that could not be grounded. */
export type WallEntryRefusalReason =
  /** a fluid is inside the profile: the body would stand in it */
  | 'hazard'
  /** mining a wall would pour a neighbouring fluid into the new tunnel */
  | 'would_flood'
  /** the tunnel would have no floor: the block under the landing is not real ground */
  | 'no_support'
  /** a profile cell cannot be opened: unobserved, or not breakable at all */
  | 'unbreakable'
  /** the profile is a protected station block or a live structure's member */
  | 'protected'
  /**
   * the profile is a DIMENSION TRANSFER block (a lit portal plane): the body would not
   * stand in the pocket it opened, it would be teleported. A mechanical locomotion
   * realization never crosses a dimension (`candidates.ts#crosses_dimension` owns the
   * same refusal for a leg); the explicit `ENTER_PORTAL` candidate is the only route
   * that may cross. `DIMENSION_TRANSFER_BLOCKS` is the ONE definition
   * (`netherPortalPlan.ts`), so this rule cannot drift from the sensor's transfer cells.
   */
  | 'portal_plane'
  /** the profile is breakable but the held tools cannot finish the dig */
  | 'no_tool'
  /** nothing to open here: the profile is already open passage (the walk owns it) */
  | 'no_wall'
  /** this exact entry already proved zero observable change from this stand cell */
  | 'spent'
  /** the entry does not strictly reduce the distance to the goal's target */
  | 'no_step'
  /** no adjacent wall can be opened at all (open lava/void on every side) */
  | 'no_grounded_route'

export interface WallEntryRefusal {
  reason: WallEntryRefusalReason
  target: Vec3Json
  /** the refused cell, when the geology names one */
  cell: Vec3Json | null
  block: string | null
  /** the sensor's own cause plus the per-direction ledger (never a synthesized fact) */
  detail: string
}

/** One probe's typed verdict, kept whether it grounded or not. */
export interface WallEntryVerdict {
  dir: WallDir
  mode: DescentMode
  cell: Vec3Json
  ok: boolean
  reason: WallEntryRefusalReason | 'safe'
  block: string | null
  detail: string
}

/** One grounded entry: everything the candidate and its evidence need. */
export interface WallEntryRoute {
  dir: WallDir
  mode: DescentMode
  dx: number
  dz: number
  /** the feet cell the body occupies after the entry (a cell the dig opened) */
  cell: Vec3Json
  /** the primary block this entry removes */
  dig: Vec3Json
  block: string | null
  /** feet-cell distance to the target before the entry */
  fromDistance: number
  /** feet-cell distance to the target after the entry (strictly smaller) */
  toDistance: number
  /** the cells this dig removes, passage first (the executor digs exactly these) */
  digCells: Vec3Json[]
  /** the sensor's own step this entry executes (one mechanic, one identity) */
  probe: WallProbe
  /** the wall/floor/flood evidence, as one auditable string */
  evidence: string
  /** every probe's verdict this tick, grounded or not */
  verdicts: WallEntryVerdict[]
}

export type WallEntryDecision =
  | { kind: 'entry'; routes: WallEntryRoute[] }
  | { kind: 'refuse'; refusal: WallEntryRefusal }

export interface WallEntryInput {
  /** live body position (fractional is fine; the feet cell is floored) */
  selfPosition: Vec3Json
  /** the goal's own target cell */
  target: Vec3Json
  /** the sensor's wall probes (`WorldState.wallProbes`) */
  walls: readonly WallProbe[] | null | undefined
  /** the same strict-reduction margin the dig route uses */
  minAdvance: number
  /** the #436 U5 protected-resource test (protected station / live structure) */
  isProtected?: (cell: Vec3Json, name: string | null) => boolean
  /** the ordinary zero-progress route identity, per probe */
  isSpent?: (probe: WallProbe) => boolean
  /** the caller's tool/legality gate for the step's whole profile */
  stepRefusal?: (probe: WallProbe) => { reason: WallEntryRefusalReason; block: string | null; detail: string } | null
}

function cellText(cell: Vec3Json): string {
  return `${Math.floor(cell.x)},${Math.floor(cell.y)},${Math.floor(cell.z)}`
}

function key(cell: Vec3Json): string {
  return `${Math.floor(cell.x)},${Math.floor(cell.y)},${Math.floor(cell.z)}`
}

function distance(a: Vec3Json, b: Vec3Json): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * The flood evidence for one pocket: which fluid, in which face-adjacent cell, would
 * pour in. `null` when the pocket is dry. This is the mechanics rule the whole module
 * exists for, expressed once.
 */
export function floodEvidence(
  pocket: readonly Vec3Json[],
  at: (cell: Vec3Json) => WallBlockLike | null,
): { cell: Vec3Json; block: string } | null {
  const seen = new Set<string>()
  for (const cell of pocket) {
    for (const [dx, dy, dz] of FACE_OFFSETS) {
      const neighbour = { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz }
      const id = key(neighbour)
      if (seen.has(id)) continue
      seen.add(id)
      const block = at(neighbour)
      // An unloaded neighbour (`null`) is never a hazard - the world-truth rule the
      // rest of the sensor uses. It is not needed for safety here: the profile and
      // the floor must be positively observed, and a fluid that is not loaded cannot
      // reach a cell the body is standing in.
      if (block === null) continue
      if (!isTunnelFloodBlockName(block.name)) continue
      if (block.boundingBox !== 'empty') continue
      return { cell: neighbour, block: block.name ?? 'fluid' }
    }
  }
  return null
}

/** `mining (a,b,c) would pour <fluid> from (d,e,f) into the new tunnel` */
export function formatFloodCause(probe: WallProbe): string {
  const mined = probe.pocket
    .filter((cell) => !cell.open)
    .map((cell) => cellText(cell.cell))
    .join('+')
  return (
    `mining (${mined.length === 0 ? cellText(probe.landing) : mined}) would pour ${probe.floodBlock ?? 'a fluid'} ` +
    `from (${probe.floodCell === null ? 'unknown' : cellText(probe.floodCell)}) into the new tunnel`
  )
}

/** The block names a mechanical locomotion realization must never step into. */
export function isDimensionTransferBlockName(name: string | null | undefined): boolean {
  return typeof name === 'string' && DIMENSION_TRANSFER_BLOCKS.has(name)
}

/**
 * The facts the ONE per-cell verdict reads. `WallProbe` satisfies this structurally, so
 * the body's adjacent wall probes and the level scan's deeper probes are judged by the
 * same function with no adapter and no second implementation.
 */
export interface WallPocketFacts {
  /** the feet cell the body stands in after the dig (`pocket[0].cell`) */
  landing: Vec3Json
  /** the 1x2 profile the dig opens: the feet cell, then the head cell above it */
  pocket: readonly [WallCell, WallCell]
  /** the pre-existing block under the pocket's feet cell (`landing.y - 1`), never mined */
  floor: WallCell
  /** a fluid is FACE-ADJACENT to a pocket cell: the dig would pour it into the tunnel */
  flood: boolean
  floodCell: Vec3Json | null
  floodBlock: string | null
}

/**
 * The checks that answer "may the body OCCUPY this pocket at all", independent of
 * how the pocket comes to exist: is it protected, was it actually sensed, is the
 * body standing in a fluid, can it be opened, is it a dimension-transfer plane.
 *
 * Extracted so the ONE per-cell rule has two consumers that cannot drift: the DIG
 * (`wallPocketRefusal` below: mine the pocket open) and the SELF-LANDING SCAFFOLD
 * (`bridgeRoute.ts#scaffoldPocketRefusal`: the pocket is already open and this step
 * CREATES ITS FLOOR). Both read the same facts; only the two dig-only questions
 * ("is there anything to mine", "is the pre-existing floor real ground") are the
 * dig's own.
 */
export function wallPocketOccupationRefusal(
  facts: WallPocketFacts,
  isProtected: (cell: Vec3Json, name: string | null) => boolean,
  describe: string = 'the',
): WallEntryRefusal | null {
  const probe = facts as WallProbe
  if (isProtected(probe.pocket[0].cell, probe.pocket[0].name) || isProtected(probe.pocket[1].cell, probe.pocket[1].name)) {
    return {
      reason: 'protected',
      target: probe.pocket[0].cell,
      cell: probe.pocket[0].cell,
      block: probe.pocket[0].name ?? probe.pocket[1].name ?? null,
      detail: `${describe} profile at (${cellText(probe.pocket[0].cell)}) is a protected resource`,
    }
  }
  for (const cell of probe.pocket) {
    if (!cell.observed) {
      return {
        reason: 'unbreakable',
        target: cell.cell,
        cell: cell.cell,
        block: cell.name,
        detail: `(${cellText(cell.cell)}) is not observed (unloaded cell): a tunnel is never opened into the unknown`,
      }
    }
    if (cell.open && isTunnelFloodBlockName(cell.name)) {
      return {
        reason: 'hazard',
        target: cell.cell,
        cell: cell.cell,
        block: cell.name,
        detail: `(${cellText(cell.cell)}) is ${cell.name ?? 'a fluid'}: the body would stand in it`,
      }
    }
    if (!cell.open && !cell.breakable) {
      return {
        reason: 'unbreakable',
        target: cell.cell,
        cell: cell.cell,
        block: cell.name,
        detail: `(${cellText(cell.cell)}) is ${cell.name ?? 'unloaded'}, not a breakable solid block`,
      }
    }
  }
  // A transfer cell is checked AFTER "unobserved" (unknown is never satisfied) and after
  // the fluid rule (standing in lava is the more immediate fact), but BEFORE "nothing to
  // mine": a pocket whose open cell is a lit portal plane is not "already open passage the
  // walk owns" - standing there transfers the body, so no mechanical dig route may end
  // there. A pocket cell that would have to be MINED never is: a portal block is not
  // breakable and the `breakable` check above already refused it.
  for (const cell of probe.pocket) {
    if (cell.open && isDimensionTransferBlockName(cell.name)) {
      return {
        reason: 'portal_plane',
        target: cell.cell,
        cell: cell.cell,
        block: cell.name,
        detail: `(${cellText(cell.cell)}) is ${cell.name ?? 'a transfer block'}: standing there transfers the body to another dimension`,
      }
    }
  }
  return null
}

/**
 * The flood verdict on its own: a fluid FACE-ADJACENT to a pocket cell would pour
 * into the space the body occupies. Exported for the consumer that OCCUPIES a
 * pocket without mining it (the self-landing scaffold), where a fluid pouring into
 * the pocket is the whole hazard even though nothing is dug.
 */
export function wallPocketFloodRefusal(facts: WallPocketFacts, describe: string = 'the'): WallEntryRefusal | null {
  const probe = facts as WallProbe
  if (!probe.flood) return null
  return {
    reason: 'would_flood',
    target: probe.floor.cell,
    cell: probe.floodCell ?? probe.pocket[0].cell,
    block: probe.floodBlock,
    detail: formatFloodCause(probe),
  }
}

/**
 * The ONE per-cell verdict: everything is read from already-sensed facts; the order is the
 * order of the questions a player answers: may I break into here at all, will it stand me
 * on real ground, will it stay dry, can I finish the dig.
 *
 * Exported and shared (see the module header): the wall entry and the level scan differ
 * only in WHICH pockets they propose, never in how a pocket is judged.
 */
export function wallPocketRefusal(
  facts: WallPocketFacts,
  isProtected: (cell: Vec3Json, name: string | null) => boolean,
  describe: string = 'the',
): WallEntryRefusal | null {
  const probe = facts as WallProbe
  const mined = probe.pocket.filter((cell) => !cell.open)
  const occupation = wallPocketOccupationRefusal(facts, isProtected, describe)
  if (occupation !== null) return occupation
  if (mined.length === 0) {
    return {
      reason: 'no_wall',
      target: probe.pocket[0].cell,
      cell: probe.pocket[0].cell,
      block: null,
      detail: `${describe} profile at (${cellText(probe.pocket[0].cell)}) is already open passage`,
    }
  }
  if (!probe.floor.observed || !probe.floor.solid || isTunnelFloodBlockName(probe.floor.name)) {
    return {
      reason: 'no_support',
      target: probe.floor.cell,
      cell: probe.floor.cell,
      block: probe.floor.name,
      detail:
        `no solid non-fluid floor under (${cellText(probe.pocket[0].cell)}): ` +
        `(${cellText(probe.floor.cell)}) is ${probe.floor.observed ? (probe.floor.name ?? 'open') : 'unloaded'}`,
    }
  }
  return wallPocketFloodRefusal(facts, describe)
}


/**
 * The one per-probe verdict of a cardinal wall probe: `wallPocketRefusal` (with the
 * direction/mode named in the detail, so the ledger stays readable per direction).
 */
function probeRefusal(
  probe: WallProbe,
  isProtected: (cell: Vec3Json, name: string | null) => boolean,
): WallEntryRefusal | null {
  return wallPocketRefusal(probe, isProtected, `the ${probe.dir}/${probe.mode}`)
}

/**
 * Is this pocket a STRUCTURALLY verified tunnel entry, from its own sensed facts?
 *
 * This is the exact predicate the offer uses (`groundWallEntries` refuses a probe
 * unless this holds, plus protection / tool / spend / distance), exported so the
 * policy guard can re-verify the SAME facts on the SAME sensor tick instead of
 * trusting candidate meta. It is defined as "the shared per-cell rule finds nothing to
 * refuse" so the offer and the guard cannot drift apart.
 *
 * It takes the FACTS, not a `WallProbe`, so the level scan's own-column shaft facts
 * (`levelScan.ts#LevelShaftFacts`) are verified by the very same call.
 */
export function isVerifiedWallEntry(facts: WallPocketFacts, describe: string = 'the'): boolean {
  return wallPocketRefusal(facts, () => false, describe) === null
}

/**
 * Ground every adjacent wall the body can open safely, toward `target`.
 *
 * The function returns EVERY grounded entry (one per direction+mode), never a chosen
 * one: the caller enumerates them as ordinary candidates and states the boundary when
 * there is more than one. When none grounds, one typed refusal names the most
 * informative cause and carries the per-probe ledger, so "no route" is an auditable
 * fact instead of a silent absence.
 */
export function groundWallEntries(input: WallEntryInput): WallEntryDecision {
  const feet: Vec3Json = {
    x: Math.floor(input.selfPosition.x),
    y: Math.floor(input.selfPosition.y),
    z: Math.floor(input.selfPosition.z),
  }
  const isProtected = input.isProtected ?? ((): boolean => false)
  const fromDistance = distance(feet, input.target)
  const verdicts: WallEntryVerdict[] = []
  const routes: WallEntryRoute[] = []
  const refusals: WallEntryRefusal[] = []
  const record = (probe: WallProbe, refusal: WallEntryRefusal): void => {
    verdicts.push({
      dir: probe.dir,
      mode: probe.mode,
      cell: probe.landing,
      ok: false,
      reason: refusal.reason,
      block: refusal.block,
      detail: refusal.detail,
    })
    refusals.push(refusal)
  }

  for (const probe of input.walls ?? []) {
    const geological = probeRefusal(probe, isProtected)
    if (geological !== null) {
      record(probe, geological)
      continue
    }
    const spent = input.isSpent?.(probe) === true
    if (spent) {
      record(probe, {
        reason: 'spent',
        target: probe.landing,
        cell: probe.landing,
        block: probe.pocket[0].name ?? null,
        detail: 'this entry already proved zero observable change from this stand cell',
      })
      continue
    }
    const tool = input.stepRefusal?.(probe)
    if (tool !== null && tool !== undefined) {
      record(probe, {
        reason: tool.reason,
        target: probe.landing,
        cell: probe.landing,
        block: tool.block,
        detail: tool.detail,
      })
      continue
    }
    const toDistance = distance(probe.landing, input.target)
    if (!(toDistance <= fromDistance - input.minAdvance)) {
      record(probe, {
        reason: 'no_step',
        target: probe.landing,
        cell: probe.landing,
        block: probe.pocket[0].name ?? null,
        detail:
          `the ${probe.dir}/${probe.mode} entry lands at ${round2(toDistance)}m from the target, ` +
          `not strictly closer than ${round2(fromDistance)}m`,
      })
      continue
    }
    const minedCells = probe.pocket.filter((cell) => !cell.open)
    const dig = minedCells[minedCells.length - 1] ?? probe.pocket[0]
    const evidence =
      `wall=${minedCells.map((cell) => `${cellText(cell.cell)}:${cell.name ?? 'unknown'}`).join('+')}` +
      `;floor=${cellText(probe.floor.cell)}:${probe.floor.name ?? 'unknown'}:solid` +
      `;faces=${probe.pocket.map((cell) => cellText(cell.cell)).join('+')}:flood=none`
    verdicts.push({
      dir: probe.dir,
      mode: probe.mode,
      cell: probe.landing,
      ok: true,
      reason: 'safe',
      block: dig.name,
      detail: evidence,
    })
    routes.push({
      dir: probe.dir,
      mode: probe.mode,
      dx: probe.dx,
      dz: probe.dz,
      cell: probe.landing,
      dig: dig.cell,
      block: dig.name,
      fromDistance,
      toDistance,
      digCells: minedCells.map((cell) => cell.cell),
      probe,
      evidence,
      verdicts,
    })
  }

  if (routes.length > 0) {
    // Every route carries the SAME ledger (this tick's per-probe verdicts), so
    // whichever one Jev takes, the log says what else was available and why not.
    for (const route of routes) route.verdicts = verdicts
    return { kind: 'entry', routes }
  }

  const ledger = verdicts.map((verdict) => `${verdict.dir}${verdict.mode === 'down' ? 'v' : ''}=${verdict.reason}`).join(' ')
  // "A wall was there and here is why I must not open it" is more informative than
  // "there was no wall": only the four wall-level causes are promoted to the headline.
  const wallLevel =
    refusals.find((refusal) => refusal.reason === 'would_flood') ??
    refusals.find((refusal) => refusal.reason === 'no_support') ??
    refusals.find((refusal) => refusal.reason === 'protected') ??
    refusals.find((refusal) => refusal.reason === 'no_tool') ??
    null
  if (wallLevel !== null) {
    return { kind: 'refuse', refusal: { ...wallLevel, detail: `${wallLevel.detail} (ledger: ${ledger})` } }
  }
  return {
    kind: 'refuse',
    refusal: {
      reason: 'no_grounded_route',
      target: input.target,
      cell: null,
      block: null,
      detail:
        `no adjacent solid breakable wall can be opened at (${cellText(feet)}) ` +
        `(ledger: ${ledger.length === 0 ? 'no_probe' : ledger})`,
    },
  }
}

/**
 * `DIG_ROUTE_ENTRY reason=<reason> target=x,y,z dir=<E|W|N|S> mode=<level|down>
 *  from=x,y,z cell=x,y,z floor=x,y,z block=<name> level=<y> from_d=<n> to_d=<n>
 *  [alternatives=E:level,S:down]`
 *
 * The one line a reviewer greps to see the tunnel entry: the cell the body came from,
 * the heading, the tunnel's own level, the exact cell it will stand in, the
 * pre-existing floor it will stand on, and the distance to the target before/after.
 * `alternatives` is appended only when more than one entry grounded - the fact that
 * code did NOT choose between them.
 */
export function formatWallEntry(input: {
  route: WallEntryRoute
  target: Vec3Json
  reason: string
  alternativeCount: number
}): string {
  const route = input.route
  return (
    `DIG_ROUTE_ENTRY reason=${input.reason} target=${cellText(input.target)} dir=${route.dir} mode=${route.mode} ` +
    `from=${cellText({ x: route.probe.step.wall.x, y: Math.floor(input.route.probe.step.wall.y) - (route.mode === 'down' ? 1 : 0), z: route.probe.step.wall.z })} ` +
    `cell=${cellText(route.cell)} floor=${cellText(route.probe.floor.cell)} level=${route.cell.y} ` +
    `block=${route.block ?? 'unknown'} floor_block=${route.probe.floor.name ?? 'unknown'} ` +
    `from_d=${round2(route.fromDistance)} to_d=${round2(route.toDistance)}` +
    (input.alternativeCount > 1 ? ` alternatives=${input.alternativeCount}` : '')
  )
}
