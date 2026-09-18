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
// The chosen path is logged as `PREREQ_OPTION chosen=<a> over=[<b>,<c>] reason=`.
// When it makes no progress for N ticks (default 40) the caller switches to the
// next-best feasible path with `PREREQ_SWITCH from=<a> to=<b> reason=no_progress`
// and must NOT abandon the parent goal (the guards in placementGuard.ts keep the
// prerequisite protected).
//
// Pure and bot-free so the scoring and the stall/switch policy are unit-testable.
import type { Vec3Json } from './state.ts'
import { distance } from './state.ts'

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
 * already in hand beats everything; rank (`prereqRank`) decides between source
 * classes, cost only breaks ties inside a class (#78).
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
} as const

/** Furnace recipe: 8 cobblestone in a 3x3 ring (matches planner.ts stone class). */
export const FURNACE_STONE_COST = 8

export interface PrereqGoalLike {
  kind?: string
  targetItem?: string | null
}

export interface KnownStationLike {
  name: string
  position: Vec3Json
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
  /** nearest grounded placement cell, null when the sensor found none */
  placementSpot: Vec3Json | null
  /** nearest remembered station coordinate, null when none is known */
  knownStation: KnownStationLike | null
  self: Vec3Json
}

export interface PrereqOption {
  path: PrereqPath
  feasible: boolean
  /** finite when feasible, +Infinity otherwise */
  cost: number
  reason: string
}

export interface PrereqDecision {
  subject: 'furnace'
  /** cheapest feasible path, or null when nothing is feasible */
  chosen: PrereqPath | null
  /** feasible options cheapest-first, then the infeasible ones (also logged) */
  options: PrereqOption[]
  /** the ready-to-log `PREREQ_OPTION ...` line */
  line: string
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

export function isInventorySourced(path: PrereqPath): boolean {
  return prereqSource(path) === 'inventory'
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
 * Pick the path the controller will actually follow. Inventory-sourced paths
 * (`place_held`, then `craft_and_place`) always win over world retrieval; a path
 * already abandoned for this planning cycle is never re-selected. Returns null
 * when every feasible path is abandoned.
 */
export function selectPrereqPath(
  decision: PrereqDecision,
  abandoned: ReadonlySet<PrereqPath> = new Set<PrereqPath>(),
): PrereqPath | null {
  const feasible = decision.options.filter((option) => option.feasible && !abandoned.has(option.path))
  if (feasible.length === 0) return null
  const held = feasible.find((option) => option.path === 'place_held')
  if (held !== undefined) return 'place_held'
  const craft = feasible.find((option) => option.path === 'craft_and_place')
  if (craft !== undefined) return 'craft_and_place'
  return feasible[0]?.path ?? null
}

/**
 * A stalled path may be forced to the next-best one, but a forced world path
 * must never outrank an available inventory-sourced path (#78). `forced` wins
 * only when its rank is at least as good as the inventory-first baseline.
 */
export function preferPrereqPath(
  base: PrereqPath | null,
  forced: PrereqPath | null,
  decision: PrereqDecision,
): PrereqPath | null {
  if (forced === null) return base
  if (!decision.options.some((option) => option.feasible && option.path === forced)) return base
  if (base === null) return forced
  return prereqRank(forced) <= prereqRank(base) ? forced : base
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
  const walk = distance(input.self, known.position)
  const dy = Math.abs(known.position.y - input.self.y)
  const vertical = dy > 1 ? PREREQ_COSTS.verticalPenalty + dy : 0
  const cost = walk + vertical
  const suffix = vertical > 0 ? ` walk=${round1(walk)}m vertical=${round1(vertical)}` : ` walk=${round1(walk)}m`
  return { path: 'use_known_station', feasible: true, cost, reason: `known${suffix}` }
}

function craftAndPlaceOption(input: PrereqInput): PrereqOption {
  if (input.heldCount > 0) {
    return { path: 'craft_and_place', feasible: false, cost: Number.POSITIVE_INFINITY, reason: 'furnace_already_held' }
  }
  if (!input.tableAvailable) {
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
  const cost = PREREQ_COSTS.craftStep + PREREQ_COSTS.placeStep
  return { path: 'craft_and_place', feasible: true, cost, reason: `craft+place stone=${input.stoneCount}` }
}

/**
 * Generate ALL feasible paths for the furnace precondition and score them by
 * cost. Feasible options are returned cheapest-first; the chosen one is the
 * head. Infeasible options are kept (with the reason they lost) after the
 * feasible ones so the log shows what was considered and why it was rejected.
 */
export function planPrereqOptions(input: PrereqInput): PrereqDecision {
  const options: PrereqOption[] = [placeHeldOption(input), knownStationOption(input), craftAndPlaceOption(input)]
  const feasible = options
    .filter((option) => option.feasible)
    .sort((a, b) => prereqRank(a.path) - prereqRank(b.path) || a.cost - b.cost)
  const infeasible = options.filter((option) => !option.feasible)
  const ordered = [...feasible, ...infeasible]
  const chosen = feasible[0] ?? null
  const over = ordered.filter((option) => option.path !== chosen?.path).map((option) => option.path)
  if (chosen === null) {
    const rejected = infeasible.map((option) => option.path).join(',')
    return {
      subject: 'furnace',
      chosen: null,
      options: ordered,
      line: formatPrereqOption('none', [], `no_feasible_path rejected=[${rejected}]`),
    }
  }
  const reason = `${chosen.path} cost=${round1(chosen.cost)}`
  return {
    subject: 'furnace',
    chosen: chosen.path,
    options: ordered,
    line: formatPrereqOption(chosen.path, over, reason),
  }
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
      return `stone=${input.stoneCount} fur=${input.heldCount} placed=${input.placedCount}`
  }
}
