// envHazard.ts - SAFE: the body's OWN environmental hazard state, and the exits.
//
// Measured live (`m3-live`, `run-mucaq28q-1ftq1`, main 99f0020,
// `buddy-driver/logs/jev/run.jsonl`, mirror `buddy.log`):
//
//   06:42:46 HEARTBEAT pos=24.7,60.2,-2.8 health=3.58 rung=blaze_rods action=RETRIEVE
//   06:42:11 CRITICAL_DAMAGE health=4.578 food=19 source=environment damage=1/3
//   06:42:12 CRITICAL_DAMAGE health=4.578 food=17 source=environment damage=1/3
//   06:42:14 CRITICAL_DAMAGE health=3.578 food=17 source=environment damage=2/3
//   06:43:06 DEATH pos=34.9,30.7,-19.4 dimension=the_nether cause=lava
//   06:43:06 DEATH_CAUSE dimension=the_nether killer=null killerId=null threat=null
//   06:33:11 DEATH_CAUSE dimension=the_nether killer=magma_cube ...
//   marker scan of the whole run: FIRE 0 | LAVA 0 | HAZARD_FIRE 0 | IN_FIRE 0 | BURN 0
//
// The body burned in the Nether and every tick of it arrived as
// `source=environment`/`source=null`: fire, lava and burning have no attacking
// entity, so the entity-keyed `THREAT_*` machinery in `threat.ts` could never
// name them. The only hazard truth the sensor carried was
// `state.ts HAZARDS` -> `BlockState { kind: 'hazard' }` (a scan of hazard blocks
// near the body) plus `DescentOption.hazardNearby` /
// `pillarColumnUnsafeFromBlocks`, which answer "is this DIG/STEP cell safe",
// never "is the body standing in fire right now". `buildSelf` never read the
// block at the feet/head and never read Mineflayer's own on-fire flag, so the
// body could not know it was in a hazard, could not prefer a safe cell, and
// could not attribute the unattributed damage.
//
// This module is the deterministic, pure owner of that missing fact and of the
// grounded exits from it:
//
//   * the sensor (`state.ts`) samples the body's own column + the 24 adjacent
//     cells from real block truth, plus Mineflayer's own on-fire flag and the
//     existing `bodySubmersion` water/breath facts - nothing is guessed, and an
//     unloaded cell (`null`) is never a hazard;
//   * `selectEnvHazardEscapes` qualifies the destinations that actually leave
//     the hazard (standable, own column hazard-free, no lava-class block within
//     the shared proximity margin) and prefers water when the body is burning;
//   * the candidate layer offers them as ordinary grounded MOVE candidates
//     (`candidates.ts envHazardEscapeCandidates`) and, while the hazard is
//     active, keeps only routes that can leave it - Jev still chooses WHICH;
//   * `EnvHazardTracker` owns the bounded telemetry (`ENV_HAZARD`,
//     `ENV_HAZARD_NO_EXIT`, `ENV_HAZARD_CLEAR`) and the environmental
//     attribution of unattributed damage (`source=null` -> `source=fire` when
//     the body is in fire, so a `DEATH_CAUSE killer=null` becomes
//     `killer=fire` with evidence).
//
// Nothing here is Nether- or fire-specific: the same state carries a drowning
// body in water (`kind=drowning`, from the existing `bodySubmersion` fact). The
// ESCAPE for drowning deliberately stays with the existing submersion machinery
// (`restrictCandidatesDuringSubmersion`, `SUBMERGED`, `LOW_AIR_PREEMPT`,
// `ASCEND:surface`): a second owner of that question would be a duplicate
// semantic layer, so `escapeRequired` excludes it.
//
// Pure and injectable: no clock, no bot, no import cycle. `state.ts` imports
// this module, so this module imports only TYPES from `state.ts`.

import type { Vec3Json } from './state.ts'

/**
 * The environmental hazard kinds the body's own state can name.
 *
 *   fire         - the body's own 1x2 column (or the block it stands on) holds a
 *                  fire-class block;
 *   lava         - ... holds a lava-class block;
 *   burning      - Mineflayer's own on-fire flag is set (burning continues after
 *                  the body leaves the fire block);
 *   drowning     - breath at/below the low-air threshold while in water; the
 *                  fact itself is owned by `bodySubmersion` and only re-expressed
 *                  here so one marker names every environmental hazard;
 *   adjacent_lava- a lava-class block is adjacent to the body's own column.
 */
export type EnvHazardKind = 'fire' | 'lava' | 'burning' | 'drowning' | 'adjacent_lava'

/** Blocks that hold/deliver fire damage when the body's box intersects them. */
export const ENV_FIRE_BLOCKS: ReadonlySet<string> = new Set(['fire', 'soul_fire', 'campfire', 'soul_campfire'])

/**
 * Blocks that are lava: `lava` is a fluid that flows into neighbouring cells,
 * `magma_block` damages on contact. Both are treated as "do not step here" with
 * a whole-cell margin, unlike fire (see {@link envHazardProximityDenied}).
 */
export const ENV_LAVA_BLOCKS: ReadonlySet<string> = new Set(['lava', 'magma_block'])

/**
 * The proximity margin at which a lava-class block makes a destination unsafe.
 *
 * ONE number for one question ("is this destination touching lava"): the
 * reachability gate (`reachability.ts HAZARD_PROXIMITY`) and the policy guard
 * (`policy.ts LAVA_PROXIMITY`) both take it from here, so the escape grounding,
 * the affordance gate and the guard cannot disagree about the same cell.
 */
export const ENV_LAVA_PROXIMITY = 1.5

/** The hazard kind a block name carries for the body's own column, or null. */
export function envHazardKindOfBlock(name: string | null | undefined): 'fire' | 'lava' | null {
  if (typeof name !== 'string' || name.length === 0) return null
  if (ENV_LAVA_BLOCKS.has(name)) return 'lava'
  if (ENV_FIRE_BLOCKS.has(name)) return 'fire'
  return null
}

/** True for `lava` / `magma_block` - the hazards with a proximity margin. */
export function isLavaClassBlock(name: string | null | undefined): boolean {
  return typeof name === 'string' && ENV_LAVA_BLOCKS.has(name)
}

/**
 * SAFE: does the hazard-proximity deny apply to this destination?
 *
 * The blanket rule ("no hazard block within the margin") exists to stop the body
 * walking INTO a hazard. A code-grounded environmental escape
 * (`selectEnvHazardEscapes`) has already proven, from real block truth, that the
 * destination's own 1x2 column holds no hazard block and that no lava-class
 * block is within the margin. Fire does not flow and damages only a body whose
 * box intersects it, so a PROVEN hazard-free destination beside the fire the
 * body is standing in is safe - and the blanket rule would otherwise refuse
 * every exit from a 3x3 pocket, because every neighbour of the burning cell is
 * inside one block of that fire.
 *
 * `escape === false` (every ordinary candidate) returns `true` unchanged: this
 * narrows the rule for one proven case, it does not weaken it.
 */
export function envHazardProximityDenied(escape: boolean, hazardName: string): boolean {
  if (!escape) return true
  return isLavaClassBlock(hazardName)
}

/**
 * One sampled adjacent cell, classified by the sensor from real block truth.
 * `standable` is the same destination rule the terrain scan uses
 * (`state.ts isUsableStandFromBlocks`); an unknown/unloaded cell is never
 * standable and never a hazard.
 */
export interface EnvHazardCell {
  position: Vec3Json
  /** the 1x2 destination rule: feet+head passable over usable ground */
  standable: boolean
  /** the cell's own column (or the block it stands on) holds a hazard block */
  hazard: 'fire' | 'lava' | null
  /** the block name that produced `hazard` (null when none) */
  hazardBlock: string | null
  /** the cell's own feet block is water */
  water: boolean
}

/**
 * The body's own environmental hazard state - a sensor fact, never an
 * inference. Every field is either a live block name at a known cell or a
 * Mineflayer flag; `onFire === null` means the client did not expose the flag
 * (UNKNOWN), which is not the same as "not burning".
 */
export interface EnvHazardState {
  /** any hazard kind is present */
  active: boolean
  /** the body's own column (or the block under the feet) holds a fire block */
  inFire: boolean
  /** ... holds a lava-class block */
  inLava: boolean
  /** Mineflayer's own on-fire flag; null = not exposed by this client */
  onFire: boolean | null
  /** breath at/below the low-air threshold (the `bodySubmersion` fact) */
  drowning: boolean
  /** the body's eyes cell holds water: the "water at the head" boundary */
  headInWater: boolean
  /**
   * The cell above the body's head is passable (verified air immediately
   * above). Together with `headInWater` this is the drowning geometry the
   * surface route is grounded from: rising ONE cell reaches air.
   */
  airAbove: boolean
  /** a lava-class block is adjacent to the body's own column */
  adjacentLava: boolean
  /** the body is in water AND burning: the water is already ending the burning */
  inWaterWhileBurning: boolean
  /** the ordered kinds present right now (empty when inactive) */
  kinds: EnvHazardKind[]
  /** the cell the hazard occupies (the body's own cell when it is in one) */
  cell: Vec3Json | null
  /** live block name at `cell` */
  block: string | null
  /**
   * The body must LEAVE its cell to stop IMMEDIATE damage: standing in fire or
   * lava, or burning. Three facts are deliberately NOT included:
   *
   *   - `adjacent_lava`: lava touching the body's column is a neighbourhood fact,
   *     not an immediate-damage state (§8: a reflex may only answer an
   *     immediately unsafe physical state). The existing `LAVA_RISK` guard
   *     already refuses stepping into it, and `pickRetreats` may offer a
   *     keep-distance route as an ordinary candidate.
   *   - `drowning`: the existing submersion machinery owns that escape
   *     (`ASCEND:surface`, `SUBMERGED`, `LOW_AIR_PREEMPT`).
   *   - burning while the body is IN water: the water is already ending the
   *     burning, so there is nothing to stabilise and pushing the body out of
   *     the water would be wrong.
   */
  escapeRequired: boolean
}

/** The raw sensor reads one hazard state is built from. */
export interface EnvHazardFacts {
  /** the body's own feet cell (the cell every offset is relative to) */
  self: Vec3Json
  /** block at the body's own feet cell */
  feetBlock: string | null
  /** block at the body's head cell (feet + 1) */
  headBlock: string | null
  /** block the body stands on (feet - 1) */
  supportBlock: string | null
  /** Mineflayer's own on-fire flag (entity metadata shared_flags bit 0x01) */
  onFire: boolean | null
  /** breath at/below `LOW_AIR_LEVEL` (`bodyIsOutOfAir`) */
  outOfAir: boolean
  /** the body's feet or eyes cell holds water (`bodyIsSubmerged`) */
  inWater: boolean
  /** the body's eyes cell holds water */
  headInWater: boolean
  /** the cell above the body's head (feet + 2) is passable */
  airAbove: boolean
  /** the sampled adjacent cells from real block truth */
  cells: readonly EnvHazardCell[]
}

const KIND_ORDER: readonly EnvHazardKind[] = ['lava', 'fire', 'burning', 'drowning', 'adjacent_lava']

/** Local distance; same convention as `state.ts distance` (cell-corner vectors). */
function distance(a: Vec3Json, b: Vec3Json): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function cellKey(cell: Vec3Json): string {
  return `${cell.x},${cell.y},${cell.z}`
}

/** The hazard of one column: feet, then head, then the block it stands on. */
function columnHazard(
  feetBlock: string | null,
  headBlock: string | null,
  supportBlock: string | null,
): { kind: 'fire' | 'lava'; block: string; offset: number } | null {
  for (const [block, offset] of [
    [feetBlock, 0],
    [headBlock, 1],
    [supportBlock, -1],
  ] as const) {
    const kind = envHazardKindOfBlock(block)
    if (kind !== null && block !== null) return { kind, block, offset }
  }
  return null
}

/**
 * Build the typed state from the sensor reads. Pure: the caller supplies the
 * block names, the Mineflayer flag and the already-sampled cells.
 */
export function buildEnvHazardState(facts: EnvHazardFacts): EnvHazardState {
  const own = columnHazard(facts.feetBlock, facts.headBlock, facts.supportBlock)
  const inFire = own?.kind === 'fire'
  const inLava = own?.kind === 'lava'
  const onFire = typeof facts.onFire === 'boolean' ? facts.onFire : null
  // A low breath reading is still a safety fact after surfacing, but by itself
  // it does not prove the body is currently drowning or needs a surface route.
  // Keep the recent air reading in the scheduler/projection; only name this
  // environmental hazard while authoritative submersion evidence is present.
  const drowning = facts.outOfAir === true && facts.inWater === true
  const headInWater = facts.headInWater === true
  const airAbove = facts.airAbove === true
  const inWaterWhileBurning = onFire === true && facts.inWater === true
  // The nearest adjacent lava-class cell. This is an independent FACT ("lava is
  // touching the body's column"), carried even while the body's own cell is on
  // fire: the two answer different questions and a marker that hid the lava
  // because of the fire would under-report the world.
  const lavaCell =
    inLava
      ? null
      : (facts.cells
          .filter((cell) => cell.hazard === 'lava')
          .slice()
          .sort((a, b) => {
            const byDistance = distance(a.position, facts.self) - distance(b.position, facts.self)
            if (byDistance !== 0) return byDistance
            const aKey = cellKey(a.position)
            const bKey = cellKey(b.position)
            return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
          })[0] ?? null)
  const adjacentLava = !inLava && lavaCell !== null

  const kinds: EnvHazardKind[] = []
  for (const kind of KIND_ORDER) {
    if (kind === 'lava' && inLava) kinds.push(kind)
    else if (kind === 'fire' && inFire) kinds.push(kind)
    else if (kind === 'burning' && onFire === true) kinds.push(kind)
    else if (kind === 'drowning' && drowning) kinds.push(kind)
    else if (kind === 'adjacent_lava' && adjacentLava) kinds.push(kind)
  }

  // Where the hazard is. The body's own cell wins (that is the damage source);
  // an adjacent lava cell is named when the body is not in one; a burning or
  // drowning body names its own feet cell, because that is where it is.
  let cell: Vec3Json | null = null
  let block: string | null = null
  if (own !== null) {
    cell = { x: facts.self.x, y: facts.self.y + own.offset, z: facts.self.z }
    block = own.block
  } else if (lavaCell !== null) {
    cell = lavaCell.position
    block = lavaCell.hazardBlock
  } else if (drowning || onFire === true) {
    cell = { x: facts.self.x, y: facts.self.y, z: facts.self.z }
    block = drowning ? 'water' : null
  }
  const active = kinds.length > 0
  // IMMEDIATE damage only, and only while it is not already being handled: see
  // the `escapeRequired` contract above.
  const immediate =
    kinds.includes('fire') || kinds.includes('lava') || kinds.includes('burning')
  const escapeRequired = immediate && !inWaterWhileBurning
  return {
    active,
    inFire,
    inLava,
    onFire,
    drowning,
    headInWater,
    airAbove,
    adjacentLava,
    inWaterWhileBurning,
    kinds,
    cell,
    block,
    escapeRequired,
  }
}

/**
 * The environmental cause an unattributed damage event is attributed to.
 *
 * Only kinds that can actually deal that damage count: `adjacent_lava` alone
 * deals nothing (standing next to lava is not damage), so it never attributes.
 * Returns null when the body is in no damaging hazard - the honest
 * `source=environment` case stays.
 */
export function envHazardDamageSource(kinds: readonly EnvHazardKind[]): EnvHazardKind | null {
  if (kinds.includes('lava')) return 'lava'
  if (kinds.includes('fire') || kinds.includes('burning')) return 'fire'
  if (kinds.includes('drowning')) return 'drowning'
  return null
}

/** A grounded exit from the hazard: an ordinary MOVE reachable in one step. */
export interface EnvHazardEscape {
  spot: Vec3Json
  /** the destination's own feet block is water: step in to put the fire out */
  water: boolean
  /** distance from the body's feet cell, m */
  distance: number
}

export interface EnvHazardEscapeInput {
  /** the body's own feet cell */
  self: Vec3Json
  /** the code-owned hazard state; inactive / drowning-only yields no escapes */
  hazard: EnvHazardState
  /** the sampled adjacent cells (real block truth) */
  cells: readonly EnvHazardCell[]
  /**
   * Live hazard blocks from the sensor (`WorldState.blocks`, `kind === 'hazard'`).
   * Only used to refuse a destination touching lava-class blocks; the
   * destination's OWN column is proven hazard-free from `cells`.
   */
  hazardBlocks?: readonly { name: string; position: Vec3Json }[]
  max?: number
}

/**
 * Bounded number of exits offered, so one hazard cannot crowd the offer. Same
 * bound as `MAX_RETREAT_CANDIDATES`: a few directions are enough for Jev to
 * choose WHICH one, and the list stays readable.
 */
export const MAX_ENV_HAZARD_ESCAPES = 3

/**
 * Ground the destinations that actually LEAVE the hazard.
 *
 * A destination qualifies only when it is:
 *   1. proven standable from real block truth (the terrain destination rule);
 *   2. NOT itself a hazard cell ("do not walk into a hazard to escape another");
 *   3. free of lava-class blocks within `ENV_LAVA_PROXIMITY` (lava flows, and a
 *      one-cell margin is the shared guard rule - fire does not flow, so fire
 *      adjacency alone does not disqualify).
 *
 * Water destinations sort first while the hazard is fire-class: the water is
 * the thing that ends burning. Ordering is NOT selection - Jev still chooses
 * WHICH candidate is taken, and every returned exit is offered.
 */
export function selectEnvHazardEscapes(input: EnvHazardEscapeInput): EnvHazardEscape[] {
  const { hazard } = input
  if (hazard.active !== true || hazard.escapeRequired !== true) return []
  const max = Math.max(0, input.max ?? MAX_ENV_HAZARD_ESCAPES)
  if (max === 0) return []
  const preferWater = hazard.kinds.includes('fire') || hazard.kinds.includes('burning')
  // Standing IN fire/lava is ended by any grounded safe step. A body that is only
  // BURNING has exactly one remedy a step can deliver - water - so a dry
  // neighbour is not an exit there (walking around while on fire stabilises
  // nothing and is not a §8 reflex).
  const contact = hazard.inFire || hazard.inLava
  const hazardBlocks = input.hazardBlocks ?? []
  const out: EnvHazardEscape[] = []
  for (const cell of input.cells) {
    if (cell.standable !== true) continue
    if (cell.hazard !== null) continue
    if (!contact && cell.water !== true) continue
    const touchesLava = hazardBlocks.some(
      (block) => isLavaClassBlock(block.name) && distance(block.position, cell.position) <= ENV_LAVA_PROXIMITY,
    )
    if (touchesLava) continue
    out.push({ spot: cell.position, water: cell.water === true, distance: distance(cell.position, input.self) })
  }
  out.sort((a, b) => {
    if (preferWater && a.water !== b.water) return a.water ? -1 : 1
    if (a.distance !== b.distance) return a.distance - b.distance
    const aKey = cellKey(a.spot)
    const bKey = cellKey(b.spot)
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
  })
  return out.slice(0, max)
}

// ---------------------------------------------------------------------------
// telemetry
// ---------------------------------------------------------------------------

export const ENV_HAZARD = 'ENV_HAZARD'
export const ENV_HAZARD_CLEAR = 'ENV_HAZARD_CLEAR'
export const ENV_HAZARD_NO_EXIT = 'ENV_HAZARD_NO_EXIT'

/** The typed reasons the gap marker can carry: the world grounds no exit. */
export const ENV_HAZARD_NO_EXIT_REASON = 'no_safe_adjacent_cell'
/** ...and the burning-only case: the body is on fire with no reachable water. */
export const ENV_HAZARD_NO_WATER_REASON = 'no_reachable_water'

/**
 * WHY the hazard grounds no exit. A body in fire/lava is refused every sampled
 * neighbour because they are hazards; a body that is only BURNING has no water
 * within reach, and the honest answer there is "the fire has to tick out", never
 * "every neighbour is a hazard".
 */
export function envHazardNoExitReason(evidence: EnvHazardEvidence): string {
  const contact = evidence.kinds.includes('fire') || evidence.kinds.includes('lava')
  return contact ? ENV_HAZARD_NO_EXIT_REASON : ENV_HAZARD_NO_WATER_REASON
}

/** One decision-time observation of the hazard state. */
export interface EnvHazardObservation {
  /** wall-clock ms of this decision tick */
  atMs: number
  /** the code-owned sensor fact, or null when the body is in no hazard */
  hazard: EnvHazardState | null
  /** a fresh damage observation landed this decision (a real health step) */
  damageObserved?: boolean
}

/** The exact code-owned evidence the marker and the damage attribution read. */
export interface EnvHazardEvidence {
  active: boolean
  kinds: EnvHazardKind[]
  cell: Vec3Json | null
  block: string | null
  onFire: boolean | null
  inWaterWhileBurning: boolean
  /** the body's eyes cell holds water at the last observation */
  headInWater: boolean
  /** verified air immediately above the head at the last observation */
  airAbove: boolean
  escapeRequired: boolean
  /** consecutive damage observations recorded while THIS hazard has been active */
  damage: number
  /** ms the current hazard has been continuously present (0 when inactive) */
  activeMs: number
}

/** The hazard that just ended, consumed once for `ENV_HAZARD_CLEAR`. */
export interface ClearedEnvHazard {
  kinds: EnvHazardKind[]
  cell: Vec3Json | null
  block: string | null
  damage: number
  activeMs: number
}

const INACTIVE_EVIDENCE: EnvHazardEvidence = {
  active: false,
  kinds: [],
  cell: null,
  block: null,
  onFire: null,
  inWaterWhileBurning: false,
  headInWater: false,
  airAbove: false,
  escapeRequired: false,
  damage: 0,
  activeMs: 0,
}

function copyCell(cell: Vec3Json | null): Vec3Json | null {
  return cell === null ? null : { x: cell.x, y: cell.y, z: cell.z }
}

/**
 * Bounded environmental-hazard telemetry for one decision stream. Pure and
 * injectable: the caller supplies observations and reads `evidence()`; there is
 * no clock and no bot.
 *
 * Semantics:
 *   - `active` mirrors the sensor fact exactly; an unloaded/unknown cell is not
 *     a hazard, so a missing read can never arm this tracker;
 *   - `damage` counts consecutive damage observations while the hazard is
 *     present, so the marker reports evidence rather than a guess;
 *   - a hazard whose KIND or CELL changes starts a new window (`damage` back to
 *     0, `activeMs` back to 0): a different fire is a different hazard;
 *   - leaving the hazard consumes the evidence once into `takeCleared()`, which
 *     is what `ENV_HAZARD_CLEAR` reports - a cleared hazard is never silent.
 */
export class EnvHazardTracker {
  private active = false
  private identity = ''
  private kinds: EnvHazardKind[] = []
  private cell: Vec3Json | null = null
  private block: string | null = null
  private onFire: boolean | null = null
  private inWaterWhileBurning = false
  private headInWater = false
  private airAbove = false
  private escapeRequired = false
  private damage = 0
  private sinceMs: number | null = null
  private last: EnvHazardEvidence = INACTIVE_EVIDENCE
  private cleared: ClearedEnvHazard | null = null

  note(observation: EnvHazardObservation): EnvHazardEvidence {
    const atMs = Number.isFinite(observation.atMs) ? observation.atMs : 0
    const hazard = observation.hazard
    if (hazard === null || hazard.active !== true) {
      if (this.active) {
        this.cleared = {
          kinds: [...this.kinds],
          cell: copyCell(this.cell),
          block: this.block,
          damage: this.damage,
          activeMs: this.sinceMs === null ? 0 : Math.max(0, atMs - this.sinceMs),
        }
      }
      this.active = false
      this.identity = ''
      this.kinds = []
      this.cell = null
      this.block = null
      this.onFire = hazard?.onFire ?? null
      this.inWaterWhileBurning = hazard?.inWaterWhileBurning === true
      this.headInWater = hazard?.headInWater === true
      this.airAbove = hazard?.airAbove === true
      this.escapeRequired = false
      this.damage = 0
      this.sinceMs = null
      this.last = INACTIVE_EVIDENCE
      return this.last
    }
    const identity = `${hazard.kinds.join('+')}|${hazard.cell === null ? 'none' : cellKey(hazard.cell)}|${hazard.block ?? 'unknown'}`
    if (!this.active || identity !== this.identity) {
      this.active = true
      this.identity = identity
      this.sinceMs = atMs
      this.damage = 0
    }
    this.kinds = [...hazard.kinds]
    this.cell = copyCell(hazard.cell)
    this.block = hazard.block
    this.onFire = hazard.onFire
    this.inWaterWhileBurning = hazard.inWaterWhileBurning
    this.headInWater = hazard.headInWater
    this.airAbove = hazard.airAbove
    this.escapeRequired = hazard.escapeRequired
    if (observation.damageObserved === true) this.damage += 1
    this.last = {
      active: true,
      kinds: [...this.kinds],
      cell: copyCell(this.cell),
      block: this.block,
      onFire: this.onFire,
      inWaterWhileBurning: this.inWaterWhileBurning,
      headInWater: this.headInWater,
      airAbove: this.airAbove,
      escapeRequired: this.escapeRequired,
      damage: this.damage,
      activeMs: this.sinceMs === null ? 0 : Math.max(0, atMs - this.sinceMs),
    }
    return this.last
  }

  /** Current evidence without recording anything. Never mutates. */
  evidence(): EnvHazardEvidence {
    return this.last
  }

  /** The hazard that just ended, consumed once. Null when nothing ended. */
  takeCleared(): ClearedEnvHazard | null {
    const cleared = this.cleared
    this.cleared = null
    return cleared
  }

  reset(): void {
    this.active = false
    this.identity = ''
    this.kinds = []
    this.cell = null
    this.block = null
    this.onFire = null
    this.inWaterWhileBurning = false
    this.headInWater = false
    this.airAbove = false
    this.escapeRequired = false
    this.damage = 0
    this.sinceMs = null
    this.last = INACTIVE_EVIDENCE
    this.cleared = null
  }
}

function formatCell(cell: Vec3Json | null): string {
  return cell === null ? 'none' : `${cell.x},${cell.y},${cell.z}`
}

function hazardHint(evidence: EnvHazardEvidence, exits: number, waterExit: boolean): string {
  if (!evidence.escapeRequired) {
    if (evidence.kinds.includes('drowning')) {
      return evidence.airAbove
        ? 'verified air immediately above; the submersion machinery owns the surface route (SUBMERGED / ASCEND:surface)'
        : 'no verified air immediately above; the submersion machinery owns the surface route (SUBMERGED / ASCEND:surface)'
    }
    return 'the submersion machinery owns the surface route (SUBMERGED / ASCEND:surface)'
  }
  if (exits === 0) {
    const contact = evidence.kinds.includes('fire') || evidence.kinds.includes('lava')
    return contact
      ? 'no grounded exit this tick; refusing to move into the hazard'
      : 'no reachable water to put the fire out; the burning has to tick out'
  }
  if (waterExit) {
    return 'step into the water to put the fire out; every route that leaves the hazard stays offered'
  }
  return 'every route that leaves the hazard stays offered; Jev chooses which'
}

/** `ENV_HAZARD kind=fire cell=24,60,-2 damage=2 exits=1 ...` - the honest state. */
export function formatEnvHazard(
  goalKey: string,
  evidence: EnvHazardEvidence,
  escapes: readonly EnvHazardEscape[] = [],
): string {
  const exits = escapes.length
  const waterExit = escapes.some((escape) => escape.water)
  return (
    `${ENV_HAZARD} goal=${goalKey} kind=${evidence.kinds.join('+')} cell=${formatCell(evidence.cell)} ` +
    `block=${evidence.block ?? 'unknown'} damage=${evidence.damage} activeMs=${evidence.activeMs} ` +
    `onFire=${evidence.onFire === null ? 'unknown' : evidence.onFire} headWet=${evidence.headInWater} ` +
    `airAbove=${evidence.airAbove} water=${evidence.inWaterWhileBurning} ` +
    `exits=${exits}${waterExit ? ' waterExit=true' : ''} -> ${hazardHint(evidence, exits, waterExit)}`
  )
}

/**
 * The evidence string a `REFLEX` line carries: the exact block/flag that proved
 * the hazard, so a reviewer reading the line can check it against the world
 * without re-deriving the decision.
 */
export function formatEnvHazardReflexEvidence(evidence: EnvHazardEvidence): string {
  const parts = [
    `kind=${evidence.kinds.join('+')}`,
    `block=${evidence.block ?? 'unknown'}@${formatCell(evidence.cell)}`,
    `onFire=${evidence.onFire === null ? 'unknown' : evidence.onFire}`,
    `headWet=${evidence.headInWater}`,
    `airAbove=${evidence.airAbove}`,
    `damage=${evidence.damage}`,
  ]
  return parts.join(' ')
}

/**
 * The typed CAN gap: the body is in a hazard and the world grounds no exit.
 * Bounded and explicit - it never invents a route through the hazard, and it
 * never lets the body dither silently.
 */
export function formatEnvHazardNoExit(
  goalKey: string,
  evidence: EnvHazardEvidence,
  sampledCells: number,
): string {
  const reason = envHazardNoExitReason(evidence)
  return (
    `${ENV_HAZARD_NO_EXIT} goal=${goalKey} kind=${evidence.kinds.join('+')} cell=${formatCell(evidence.cell)} ` +
    `block=${evidence.block ?? 'unknown'} reason=${reason} sampled=${sampledCells} ` +
    `damage=${evidence.damage} -> ` +
    (reason === ENV_HAZARD_NO_WATER_REASON
      ? 'no sampled adjacent cell is water; the burning is left to tick out'
      : 'every sampled adjacent cell is a hazard or lava-adjacent; moving into it is refused')
  )
}

/** `ENV_HAZARD_CLEAR lastKind=... after=3 damage observations` - never silent. */
export function formatEnvHazardClear(cleared: ClearedEnvHazard): string {
  return (
    `${ENV_HAZARD_CLEAR} lastKind=${cleared.kinds.join('+')} lastCell=${formatCell(cleared.cell)} ` +
    `lastBlock=${cleared.block ?? 'unknown'} damage=${cleared.damage} activeMs=${cleared.activeMs} ` +
    `-> the body is out of the environmental hazard`
  )
}
