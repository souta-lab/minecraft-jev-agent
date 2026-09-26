// prereqOption.ts - issue #58: satisfy a precondition the cheapest/feasible way.
//
// Measured 2026-09-18 08:54 JST: the bot held a furnace:1 but the controller kept
// re-issuing `RETRIEVE:known:station:furnace:b29_61_35` (walk to the remembered
// furnace) and never placed the one in its inventory, so FURNACE_READY never
// fired and the smelt never ran.
//
// A precondition is deterministic code (AGENTS.md section 8), and the way to
// satisfy it must be chosen by cost, not hard-coded:
//
//   place_held        - the item is in the inventory (normally cheapest)
//   use_known_station - a remembered coordinate exists (walk cost + vertical gap)
//   craft_and_place   - the recipe materials are held (craft step + place)
//
// Cost orders the ELIGIBLE paths; eligibility itself is world truth (TRUE/CAN).
// OPERATOR RULE (station-use-before-craft, measured live 2026-09-21): a usable,
// non-blacklisted station of the needed kind already exists -> crafting a
// duplicate is INELIGIBLE, not merely expensive (see `craftAndPlaceOption`).
//
// The chosen path is logged as `PREREQ_OPTION chosen=<a> over=[<b>,<c>] reason=`
// and a withheld duplicate craft as `PREREQ_STATION_ALREADY_KNOWN station=...`.
// When it makes no progress for N ticks (default 40) the caller switches to the
// next-best feasible path with `PREREQ_SWITCH from=<a> to=<b> reason=no_progress`
// and must NOT abandon the parent goal (the guards in placementGuard.ts keep the
// prerequisite protected).
//
// Pure and bot-free so the scoring and the stall/switch policy are unit-testable.
import type { Vec3Json } from './state.ts'
import { distance } from './state.ts'
import { loadGameData, preferredRecipe } from './gameData.ts'
import { matchesResourceClass } from './resourceClass.ts'

export type PrereqPath = 'place_held' | 'use_known_station' | 'craft_and_place'

/** Default progress-assertion window (ticks) before a chosen path is switched. */
export const PREREQ_STALL_TICKS_DEFAULT = 40

/** `BUDDY_PREREQ_STALL_TICKS` overrides the window; invalid values fall back. */
export function resolvePrereqStallTicks(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = Number(env.BUDDY_PREREQ_STALL_TICKS ?? PREREQ_STALL_TICKS_DEFAULT)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : PREREQ_STALL_TICKS_DEFAULT
}

/**
 * Cost model. Deliberately small integers so the ordering is easy to read in a
 * log line and stable in tests. `place_held` carries a base cost so an item
 * already in hand beats a short walk; a remembered world station carries the
 * access cost of stale knowledge, so an inventory-sourced path still wins at
 * equal-or-slightly-worse geometry (#78) WITHOUT letting the hand-authored
 * `prereqRank` decide the choice (#11 v2).
 */
export const PREREQ_COSTS = {
  /** cost of the single PLACE interaction */
  placeStep: 1,
  /** cost of the one CRAFT interaction at a 3x3 table */
  craftStep: 3,
  /** per-stone cost of gathering missing furnace material */
  missingStone: 2,
  /** flat extra cost when the target is on another level (plus |dy|) */
  verticalPenalty: 8,
  /**
   * Fixed access cost of a remembered world station: the coordinate is stale
   * knowledge, so the journey must be made AND the station verified on arrival
   * (the measured #78 loop burned a full retrieve on an unverified station).
   * Keeps `place_held` cheaper unless the station is genuinely closer than the
   * inventory-sourced geometry. It no longer decides against `craft_and_place`:
   * when a usable station exists that path is ineligible outright
   * (see `craftAndPlaceOption`), so the walk is the route rather than the loser.
   */
  worldStationAccess: 4,
} as const

/**
 * #11 v2: the cheapest FEASIBLE path is chosen (ties broken by source-class
 * rank). The pure rank order is logged alongside as `rankBaseline` evidence;
 * it is never a selectable ordering.
 */
export type PrereqRankPolicy = 'cost'

/**
 * Cobblestone-equivalent units the 3x3 furnace recipe needs, derived from
 * minecraft-data (`furnace` recipe: 8 stone-class blocks in a ring). The old
 * hard-coded 8 is only a fallback for a missing recipe entry (#54).
 */
export function furnaceStoneCost(): number {
  const recipe = preferredRecipe('furnace')
  if (recipe === null) return 8
  const stone = recipe.ingredients
    .filter((ingredient) => matchesResourceClass(ingredient.item, 'stone'))
    .reduce((total, ingredient) => total + ingredient.count, 0)
  return stone > 0 ? stone : 8
}

export const FURNACE_STONE_COST = furnaceStoneCost()

export interface PrereqGoalLike {
  kind?: string
  targetItem?: string | null
}

export interface KnownStationLike {
  name: string
  position: Vec3Json
}

/**
 * Canonical identity of a remembered station, used as the key of the explicit
 * reachability blacklist (M2 blocker). `name` distinguishes a remembered
 * `crafting_table` from a remembered `furnace` at the same cell.
 */
export function knownStationKey(station: KnownStationLike): string {
  return `${station.name}@${Math.round(station.position.x)},${Math.round(station.position.y)},${Math.round(station.position.z)}`
}

export interface PrereqInput {
  /** the parent goal whose precondition is being satisfied */
  goal: PrereqGoalLike | null
  /** how many of the prerequisite station item are held */
  heldCount: number
  /** how many are already placed within sensor range */
  placedCount: number
  /** countClass(counts, 'stone') - cobblestone-ish furnace material */
  stoneCount: number
  /** a crafting table is available for the 3x3 furnace recipe */
  tableAvailable: boolean
  /**
   * a `crafting_table` is not usable but can be MADE from the held inventory
   * (its own 2x2 inventory-grid recipe), so the 3x3 furnace recipe is still
   * reachable through `craft table -> place table -> craft furnace` instead of
   * being refused `no_crafting_table`. Optional so pure fixtures that only model
   * an in-place table keep their historical behaviour; the live adapter
   * (`candidates.ts#furnacePrereqInputFromState`) resolves it from the same
   * recipe planner the craft path uses.
   */
  tableCraftable?: boolean
  /** nearest grounded placement cell, null when the sensor found none */
  placementSpot: Vec3Json | null
  /** nearest remembered station coordinate, null when none is known */
  knownStation: KnownStationLike | null
  /**
   * M2 blocker: `knownStationKey`s whose grounded retrieve the controller has
   * blacklisted (move-failure memory / proven unreachable). A blacklisted known
   * station is never a feasible `use_known_station`; the ladder must fall
   * through to a feasible alternative instead of having every candidate
   * filtered away and collapsing to WAIT. Passed explicitly so the planner
   * stays pure.
   */
  unreachableStations?: ReadonlySet<string>
  self: Vec3Json
}

export interface PrereqOption {
  path: PrereqPath
  feasible: boolean
  /** finite when feasible, +Infinity otherwise */
  cost: number
  reason: string
}

/**
 * Typed reason of an INELIGIBLE `craft_and_place`: a usable station of the
 * needed kind already exists, so that station is not crafted again (OPERATOR RULE
 * station-use-before-craft; see `craftAndPlaceOption`).
 */
export const STATION_ALREADY_KNOWN_REASON = 'station_already_known'

/**
 * `PREREQ_STATION_ALREADY_KNOWN`: the typed fact behind a withheld
 * `craft_and_place`, mirrored next to `PREREQ_OPTION`. It names the station that
 * makes the craft ineligible, where that station is, and which path runs instead,
 * so a withheld duplicate craft is a typed decision in the run log rather than a
 * silent absence (the smelt-side mirror of candidates.ts#CRAFT_STATION_ALREADY_KNOWN).
 */
export const PREREQ_STATION_ALREADY_KNOWN = 'PREREQ_STATION_ALREADY_KNOWN'

export function formatPrereqStationKnown(
  station: KnownStationLike,
  held: number,
  next: PrereqPath | null,
): string {
  const x = Math.round(station.position.x)
  const y = Math.round(station.position.y)
  const z = Math.round(station.position.z)
  return `${PREREQ_STATION_ALREADY_KNOWN} station=${station.name} at=${x},${y},${z} held=${held} next=${next ?? 'none'}`
}

export interface PrereqDecision {
  subject: 'furnace'
  /** cheapest feasible path, or null when nothing is feasible */
  chosen: PrereqPath | null
  /** feasible options cheapest-first, then the infeasible ones (also logged) */
  options: PrereqOption[]
  /** the ready-to-log `PREREQ_OPTION ...` line */
  line: string
  /** the ordering policy that produced `chosen` (#11 v2) */
  policy: PrereqRankPolicy
  /** what the #78 rank order would have chosen - logged, never followed (#11 v2) */
  rankBaseline: PrereqPath | null
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * The only subject wired today. A `smelt` goal with no placed furnace needs a
 * usable furnace; `placedCount > 0` means the precondition already holds.
 */
export function prereqSubjectForGoal(goal: PrereqGoalLike | null): 'furnace' | null {
  if (goal === null) return null
  return goal.kind === 'smelt' ? 'furnace' : null
}

/**
 * `FURNACE_PREREQ_ALREADY_SATISFIED resource=furnace source=<source>`.
 *
 * A prerequisite that is ALREADY satisfied is not a path CHOICE, so it must not
 * be logged as `PREREQ_OPTION` (which names the chosen acquisition path). Before
 * this distinct typed observation, an already-satisfied furnace produced no
 * prerequisite marker at all, so the M2 gate's ordered
 * `PREREQ_OPTION -> FURNACE_READY -> SMELT_DONE` chain could never start even
 * when the prerequisite was satisfied.
 */
export function formatFurnacePrereqSatisfied(source: 'sensed' | 'placed' | 'held'): string {
  return `FURNACE_PREREQ_ALREADY_SATISFIED resource=furnace source=${source}`
}

export interface FurnacePrereqObservationInput {
  /** `prereqSubjectForGoal` result: non-null only when a furnace prerequisite applies */
  subject: 'furnace' | null
  /** sensed furnace stations present in the current world state */
  sensedStationCount: number
}

/**
 * The already-satisfied observation for one prerequisite evaluation, or null
 * when the subject does not apply or the prerequisite is not yet satisfied. The
 * controller logs the returned line at most once per goal.
 */
export function furnacePrereqSatisfiedObservation(input: FurnacePrereqObservationInput): string | null {
  if (input.subject === null) return null
  if (input.sensedStationCount <= 0) return null
  return formatFurnacePrereqSatisfied('sensed')
}

export interface FurnacePrereqObservationDecisionInput extends FurnacePrereqObservationInput {
  /** the current goal revision key (the observation is per goal) */
  goalKey: string
  /** the goal|line key already logged, or null */
  previousKey: string | null
}

export interface FurnacePrereqObservationDecision {
  /** the line to log now, or null when it was already logged (or not satisfied) */
  line: string | null
  /**
   * the new dedupe key; non-null exactly when the prerequisite is satisfied, so
   * the caller can early-return instead of running the acquisition planner (and
   * never emits a false `PREREQ_OPTION`).
   */
  key: string | null
}

/**
 * The emit-once decision for an already-satisfied furnace prerequisite. Returns
 * `key !== null` for a satisfied prerequisite with `line` set only the first
 * time for that goal; `key === null` when the prerequisite is not satisfied, so
 * the acquisition planner runs and `PREREQ_OPTION` can still be emitted.
 */
export function decideFurnacePrereqObservation(
  input: FurnacePrereqObservationDecisionInput,
): FurnacePrereqObservationDecision {
  const line = furnacePrereqSatisfiedObservation(input)
  if (line === null) return { line: null, key: null }
  const key = `${input.goalKey}|${line}`
  if (input.previousKey === key) return { line: null, key }
  return { line, key }
}

export function formatPrereqOption(
  chosen: PrereqPath | 'none',
  over: readonly PrereqPath[],
  reason: string,
): string {
  return `PREREQ_OPTION chosen=${chosen} over=[${over.join(',')}] reason=${reason}`
}

export function formatPrereqSwitch(from: PrereqPath, to: PrereqPath): string {
  return `PREREQ_SWITCH from=${from} to=${to} reason=no_progress`
}

/**
 * The ready-to-log `PREREQ_OPTION ...` line for a SPECIFIC chosen path.
 *
 * After a `PREREQ_SWITCH` the controller overrides the cost-optimal path with
 * the next-best one (`prereqForcedPath`). Logging `decision.line` then would
 * name the path the controller did NOT take, so the marker would disagree with
 * the actual decision (#63: a marker name is not evidence of semantics). This
 * renders the line for the path that is actually followed; when `chosen` is the
 * cost-optimal path it is exactly `decision.line`.
 */
export function formatPrereqOptionFor(decision: PrereqDecision, chosen: PrereqPath | null): string {
  if (chosen !== null && chosen === decision.chosen) return decision.line
  const over = decision.options.filter((option) => option.path !== chosen).map((option) => option.path)
  if (chosen === null) return formatPrereqOption('none', [], 'no_feasible_path')
  const option = decision.options.find((entry) => entry.path === chosen && entry.feasible)
  if (option === undefined) return formatPrereqOption(chosen, over, `${chosen} forced`)
  return formatPrereqOption(chosen, over, `${chosen} cost=${round1(option.cost)}`)
}

/**
 * The `craft_and_place` option this decision made INELIGIBLE because the world
 * model already holds a usable station of the needed kind, or null when the craft
 * path is eligible (or lost for another reason). The controller renders
 * `formatPrereqStationKnown` from it, so the mirrored marker and the option list
 * can never disagree.
 */
export function prereqWithheldCraft(decision: PrereqDecision): PrereqOption | null {
  const craft = decision.options.find((option) => option.path === 'craft_and_place')
  return craft !== undefined && !craft.feasible && craft.reason === STATION_ALREADY_KNOWN_REASON
    ? craft
    : null
}

/**
 * Issue #78: an item already in the inventory (or craftable from the held
 * materials) must outrank walking to a remembered world station, regardless of
 * raw walk cost. The measured loop chose `use_known_station` while the required
 * item was in hand and oscillated vertically with no progress. Lower rank =
 * higher priority; cost only breaks ties inside the same rank.
 */
export type PrereqSource = 'inventory' | 'world'

export function prereqSource(path: PrereqPath): PrereqSource {
  return path === 'use_known_station' ? 'world' : 'inventory'
}

export function prereqRank(path: PrereqPath): number {
  switch (path) {
    case 'place_held':
      return 0
    case 'craft_and_place':
      return 1
    case 'use_known_station':
      return 2
  }
}

/**
 * The exact instrumentation required by issue #78:
 * `PREREQ_OPTION resource=<r> option=<path> reason=<why> qty=<n>`.
 */
export function formatPrereqOptionDetail(
  resource: string,
  option: PrereqPath,
  reason: string,
  qty: number,
): string {
  return `PREREQ_OPTION resource=${resource} option=${option} reason=${reason} qty=${qty}`
}

/** Why the inventory-first selector picked this path, for the detail line. */
export function prereqOptionReason(path: PrereqPath): string {
  switch (path) {
    case 'place_held':
      return 'held_in_inventory'
    case 'craft_and_place':
      return 'craftable_from_inventory'
    case 'use_known_station':
      return 'world_station'
  }
}

/**
 * Pick the path the controller will actually follow from the policy-ordered
 * feasible options. An abandoned path is demoted, but abandonment is a
 * PREFERENCE, not an elimination: when every feasible path has been abandoned
 * the cheapest feasible one is still returned, because "run the best grounded
 * route again" is strictly better than collapsing to WAIT/starvation with a
 * feasible route on the table (#11 v2). Null means nothing is feasible at all.
 */
export function selectPrereqPath(
  decision: PrereqDecision,
  abandoned: ReadonlySet<PrereqPath> = new Set<PrereqPath>(),
): PrereqPath | null {
  const feasible = decision.options.filter((option) => option.feasible)
  if (feasible.length === 0) return null
  const preferred = feasible.find((option) => !abandoned.has(option.path)) ?? feasible[0]
  return preferred?.path ?? null
}

/**
 * A stalled path may be forced to the next-best one. An explicit `forced` path
 * that is still feasible IS the caller's decision (the stall/unverified advance)
 * and wins; the #78 source-class guard is gone because rank no longer decides
 * (#11 v2). `base` is the policy-ordered selection and is the fallback when the
 * forced path is missing/infeasible. Never null while a feasible option exists.
 */
export function preferPrereqPath(
  base: PrereqPath | null,
  forced: PrereqPath | null,
  decision: PrereqDecision,
): PrereqPath | null {
  const best = selectPrereqPath(decision)
  if (forced !== null && decision.options.some((option) => option.feasible && option.path === forced)) {
    return forced
  }
  return base ?? best
}

/** Issue #78: repeated unverified zero-progress retrieves are abandoned. */
export const RETRIEVE_UNVERIFIED_LIMIT = 3

export interface RetrieveUnverifiedState {
  /** the abandoned candidate id the count is keyed on */
  key: string
  /** consecutive `verified=false progressDelta=0` outcomes */
  unverified: number
}

/**
 * Bounded abandonment for a known-station retrieve that keeps finishing with
 * `verified=false` and no progress. A positive progress delta re-arms the
 * counter. The executor can report `verified=true` for a sub-metre nudge that
 * gains nothing (see the RETRIEVE branch in controller.ts), so a verified
 * no-progress outcome is a no-op rather than a reset; only real progress
 * re-arms. When the count exceeds `limit` the option is abandoned with the
 * required one-line reason so a different option can run.
 */
export function evaluateRetrieveAbandon(input: {
  actionId: string
  verified: boolean
  progressDelta: number
  previous: RetrieveUnverifiedState | null
  limit?: number
}): { state: RetrieveUnverifiedState; abandon: boolean; line: string | null } {
  const limit = input.limit ?? RETRIEVE_UNVERIFIED_LIMIT
  if (input.progressDelta > 0) {
    return { state: { key: input.actionId, unverified: 0 }, abandon: false, line: null }
  }
  const prior =
    input.previous !== null && input.previous.key === input.actionId ? input.previous.unverified : 0
  if (input.verified) {
    return { state: { key: input.actionId, unverified: prior }, abandon: false, line: null }
  }
  const unverified = prior + 1
  const abandon = unverified > limit
  return {
    state: { key: input.actionId, unverified },
    abandon,
    line: abandon ? `ABANDON_REASON=retrieve_unverified progress=0 option=${input.actionId}` : null,
  }
}

function placeHeldOption(input: PrereqInput): PrereqOption {
  const has = input.heldCount > 0
  if (!has) return { path: 'place_held', feasible: false, cost: Number.POSITIVE_INFINITY, reason: 'no_furnace_held' }
  const spot = input.placementSpot
  if (spot === null) {
    return { path: 'place_held', feasible: false, cost: Number.POSITIVE_INFINITY, reason: 'no_placement_spot' }
  }
  const walk = distance(input.self, spot)
  const cost = PREREQ_COSTS.placeStep + walk
  return { path: 'place_held', feasible: true, cost, reason: `held spot=${round1(walk)}m` }
}

function knownStationOption(input: PrereqInput): PrereqOption {
  const known = input.knownStation
  if (known === null) {
    return { path: 'use_known_station', feasible: false, cost: Number.POSITIVE_INFINITY, reason: 'no_known_station' }
  }
  if (input.unreachableStations?.has(knownStationKey(known)) === true) {
    return {
      path: 'use_known_station',
      feasible: false,
      cost: Number.POSITIVE_INFINITY,
      reason: 'known_station_unreachable',
    }
  }
  const walk = distance(input.self, known.position)
  const dy = Math.abs(known.position.y - input.self.y)
  const vertical = dy > 1 ? PREREQ_COSTS.verticalPenalty + dy : 0
  const cost = walk + vertical + PREREQ_COSTS.worldStationAccess
  const suffix = vertical > 0 ? ` walk=${round1(walk)}m vertical=${round1(vertical)}` : ` walk=${round1(walk)}m`
  return {
    path: 'use_known_station',
    feasible: true,
    cost,
    reason: `known${suffix} access=${PREREQ_COSTS.worldStationAccess}`,
  }
}

function craftAndPlaceOption(input: PrereqInput): PrereqOption {
  if (input.heldCount > 0) {
    return { path: 'craft_and_place', feasible: false, cost: Number.POSITIVE_INFINITY, reason: 'furnace_already_held' }
  }
  // OPERATOR RULE (station-use-before-craft; measured live 2026-09-21): "it
  // crafts a crafting table / furnace even though one is nearby". A usable
  // station of the needed kind EXISTS (a known cell the reachability blacklist
  // has not retired), so crafting another one is not a valid route - the plan
  // must use or walk to that station.
  //
  // This is eligibility (CAN/TRUE), not preference, which is why it cannot live
  // in the cost model: `craftStep + placeStep` is 4 while every walk carries
  // `worldStationAccess` (4) plus its distance, so craft was structurally
  // cheaper than ANY existing station and the cost ordering could never express
  // "it already exists" (#58/#78 cost model, measured residual). The same
  // predicate `knownStationOption` uses proves `use_known_station` feasible
  // here, so the decision always keeps a feasible path (#11 v2: never collapse
  // to WAIT) and Jev/System2 still owns WHICH of the remaining paths runs.
  //
  // A BLACKLISTED cell is NOT usable: a station proven unreachable/retired is
  // exactly the case where the craft path becomes legitimate again, which is the
  // escape hatch that keeps a genuinely unreachable station from starving the
  // goal (pinned by buddy-driver/test-furnace-place and test-prereq-option).
  if (knownStationOption(input).feasible) {
    return {
      path: 'craft_and_place',
      feasible: false,
      cost: Number.POSITIVE_INFINITY,
      reason: STATION_ALREADY_KNOWN_REASON,
    }
  }
  if (!input.tableAvailable && input.tableCraftable !== true) {
    return { path: 'craft_and_place', feasible: false, cost: Number.POSITIVE_INFINITY, reason: 'no_crafting_table' }
  }
  const missing = Math.max(0, FURNACE_STONE_COST - input.stoneCount)
  if (missing > 0) {
    return {
      path: 'craft_and_place',
      feasible: false,
      cost: Number.POSITIVE_INFINITY,
      reason: `need_${missing}_more_stone`,
    }
  }
  // A table that must itself be made and placed is one extra craft+place leg; the
  // cost model keeps `use_known_station`/`place_held` preferred when they exist.
  const tableLeg = input.tableAvailable ? 0 : PREREQ_COSTS.craftStep + PREREQ_COSTS.placeStep
  const cost = PREREQ_COSTS.craftStep + PREREQ_COSTS.placeStep + tableLeg
  const table = input.tableAvailable ? 'table=usable' : 'table=craft'
  return { path: 'craft_and_place', feasible: true, cost, reason: `craft+place stone=${input.stoneCount} ${table}` }
}

/**
 * Generate ALL feasible paths for the furnace precondition and score them by
 * cost. Feasible options are returned cheapest-first; the chosen one is the
 * head. Infeasible options are kept (with the reason they lost) after the
 * feasible ones so the log shows what was considered and why it was rejected.
 *
 * #11 v2: options are ordered by cost with ties broken by rank; `rankBaseline`
 * names what the pure rank order would have chosen, as logged evidence.
 */
export function planPrereqOptions(input: PrereqInput): PrereqDecision {
  const policy: PrereqRankPolicy = 'cost'
  const options: PrereqOption[] = [placeHeldOption(input), knownStationOption(input), craftAndPlaceOption(input)]
  const byCost = (a: PrereqOption, b: PrereqOption): number =>
    a.cost - b.cost || prereqRank(a.path) - prereqRank(b.path)
  const byRank = (a: PrereqOption, b: PrereqOption): number =>
    prereqRank(a.path) - prereqRank(b.path) || a.cost - b.cost
  const feasible = options
    .filter((option) => option.feasible)
    .sort(byCost)
  const infeasible = options.filter((option) => !option.feasible)
  const ordered = [...feasible, ...infeasible]
  const chosen = feasible[0] ?? null
  const rankBaseline = [...feasible].sort(byRank)[0]?.path ?? null
  const over = ordered.filter((option) => option.path !== chosen?.path).map((option) => option.path)
  if (chosen === null) {
    const rejected = infeasible.map((option) => option.path).join(',')
    return {
      subject: 'furnace',
      chosen: null,
      options: ordered,
      line: formatPrereqOption('none', [], `no_feasible_path rejected=[${rejected}]`),
      policy,
      rankBaseline,
    }
  }
  const reason = `${chosen.path} cost=${round1(chosen.cost)}`
  return {
    subject: 'furnace',
    chosen: chosen.path,
    options: ordered,
    line: formatPrereqOption(chosen.path, over, reason),
    policy,
    rankBaseline,
  }
}

/**
 * Issue #11 v2: the shadow baseline of the rank policy. `cost_choice` is the
 * path actually followed, `rank_choice` what #78 ranking would have picked;
 * `agree=false` is the transition evidence that the two policies diverge.
 */
export function formatPrereqRankShadow(decision: PrereqDecision, chosen: PrereqPath | null): string {
  const chosenName = chosen ?? 'none'
  const rankName = decision.rankBaseline ?? 'none'
  return `PREREQ_RANK_SHADOW policy=${decision.policy} cost_choice=${chosenName} rank_choice=${rankName} agree=${chosenName === rankName}`
}

/** The next-cheapest feasible path after `current`, or null when none is left. */
export function nextPrereqPath(decision: PrereqDecision, current: PrereqPath): PrereqPath | null {
  for (const option of decision.options) {
    if (!option.feasible || option.path === current) continue
    return option.path
  }
  return null
}

export interface PrereqProgress {
  path: PrereqPath
  /** stable string; a change counts as progress and re-arms the assertion */
  signature: string
  ticks: number
}

/**
 * Pure stall assertion for the chosen prerequisite path. The signature is a
 * coarse progress proxy per path (see `prereqProgressSignature`); when it stays
 * identical for `stallTicks` consecutive ticks the caller switches paths. The
 * counter re-arms on progress and on a path change.
 */
export function evaluatePrereqStall(input: {
  previous: PrereqProgress | null
  path: PrereqPath
  signature: string
  stallTicks: number
}): { progress: PrereqProgress; stalled: boolean } {
  const { previous, path, signature, stallTicks } = input
  if (previous === null || previous.path !== path) {
    return { progress: { path, signature, ticks: 0 }, stalled: false }
  }
  if (previous.signature !== signature) {
    return { progress: { path, signature, ticks: 0 }, stalled: false }
  }
  const ticks = previous.ticks + 1
  if (ticks >= stallTicks) return { progress: { path, signature, ticks: 0 }, stalled: true }
  return { progress: { path, signature, ticks }, stalled: false }
}

/**
 * A coarse, path-specific progress signal. A change means the body changed
 * something relevant (moved closer, crafted, gathered stone), so the stall
 * counter resets. Deliberately does not include the fluctuating placement spot
 * for `place_held`: retrying placements at shifting spots must still count as a
 * stall so the controller switches path instead of looping.
 */
export function prereqProgressSignature(path: PrereqPath, input: PrereqInput): string {
  switch (path) {
    case 'place_held':
      return `fur=${input.heldCount} placed=${input.placedCount}`
    case 'use_known_station':
      return input.knownStation === null
        ? 'no_known_station'
        : `dist=${Math.round(distance(input.self, input.knownStation.position))}`
    case 'craft_and_place':
      return `stone=${input.stoneCount} fur=${input.heldCount} placed=${input.placedCount} table=${input.tableAvailable ? 1 : 0}`
  }
}
