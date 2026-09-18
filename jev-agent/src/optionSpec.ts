// optionSpec.ts - Issue #21: first-class OptionSpec + a deterministic
// PlannedGoal -> OptionSpec compiler.
//
// WHY
// ---
// Before this module the long-horizon layer only spoke `PlannedGoal` (plain
// queue rows) and strategy labels. There was no single typed object that said
// *when an Option may start*, *what state means it is complete*, *which grounded
// skills it may use* and *what abandonment budget applies*. Without that,
// `abandon_option` beta (#11/#22) cannot distinguish "the option is bad" from
// "the option already succeeded" or "the option was invalid to start with".
//
// CONTRACT (kept deliberately plain-data / deterministic)
// -------------------------------------------------------
//   OptionSpec {
//     id, intent, kind, target { item, count, predicate },
//     preconditions: Predicate[],  // I(o)      - evaluated by CODE
//     success:       Predicate[],  // success(s,o) - evaluated by CODE
//     skills: string[],            // grounded skill ids this Option may use (#20)
//     abortThreshold: number       // beta threshold for this Option (default 0.5)
//   }
//
// INVARIANTS
// ----------
//  * No Bot, Block, Entity, Vec3 prototype, closure or model object ever enters a
//    spec: predicates are serialisable data evaluated against an
//    `OptionWorldSnapshot` of plain JSON.
//  * No model, no network: completion and initiation are pure code.
//  * Additive + opt-in: `BUDDY_OPTION_COMPILER` (default OFF) decides whether the
//    compiled goal chain replaces the planned goals. When off, `applyCompiledPlan`
//    returns the input goals unchanged, and the GoalQueue stays the execution
//    ledger exactly as before.
//
// DEPENDENCY EXPANSION (#12 generalization)
// -----------------------------------------
// An unmet precondition never stops the plan: `expandOptionDependencies` turns
// the unmet predicate into the prerequisite Option and recurses. So
// `smelt iron_ingot` with no `raw_iron` expands to `collect raw_iron` first -
// the same repair the deterministic ladder does with LADDER_PREREQ, but expressed
// on the Option layer.
import type { GoalKind, GoalQueueState, PlannedGoal, QueuedGoal } from './goalQueue.ts'
import { ORE_SOURCES } from './state.ts'
import type { Vec3Json } from './state.ts'
import { isResourceClass, matchesResourceClass, resourceMatches } from './resourceClass.ts'
import type { ResourceClass } from './resourceClass.ts'
import {
  PICKAXE_TIER_ORDER,
  loadGameData,
  recipesFor,
  requiredPickaxeRank1,
  requiredPickaxeRankForItem1,
} from './gameData.ts'
import type { RecipeView } from './gameData.ts'

export type OptionKind =
  | 'collect'
  | 'craft'
  | 'smelt'
  | 'place'
  | 'goto'
  | 'explore'
  | 'descend'
  | 'combat'
  | 'custom'

export const OPTION_KINDS: readonly OptionKind[] = [
  'collect',
  'craft',
  'smelt',
  'place',
  'goto',
  'explore',
  'descend',
  'combat',
  'custom',
]

/** What an Option is trying to reach. `predicate` is for non-item objectives. */
export interface OptionTarget {
  /** concrete item id or semantic resource class (see resourceClass.ts) */
  item?: string
  /** required count, >= 1 */
  count?: number
  /** named non-item objective (e.g. "end_portal_room") */
  predicate?: string
  /** spatial predicate goal (#41): complete when position.y <= targetY */
  targetY?: number
  /** dimension the targetY predicate must be evaluated in */
  dimension?: string
}

/**
 * A predicate is DATA, evaluated by code (never by a model). Every variant reads
 * a field of `OptionWorldSnapshot`: inventory counts, dimension, position/level,
 * health, WorldMemory stations/ores.
 */
export type Predicate =
  | { readonly kind: 'inventoryAtLeast'; readonly item: string; readonly count: number }
  | { readonly kind: 'inventoryClassAtLeast'; readonly cls: ResourceClass; readonly count: number }
  | { readonly kind: 'pickaxeRankAtLeast'; readonly rank: number }
  | { readonly kind: 'stationKnown'; readonly station: 'crafting_table' | 'furnace' }
  | { readonly kind: 'oreKnown'; readonly item: string }
  | { readonly kind: 'dimensionIs'; readonly dimension: string }
  | { readonly kind: 'levelAtMost'; readonly y: number }
  | { readonly kind: 'healthAtLeast'; readonly health: number }
  | { readonly kind: 'custom'; readonly id: string }

/**
 * Issue #59: tri-state predicate truth. A safety predicate must distinguish
 * "the world says this is false" from "the world did not say anything". Both
 * make an Option non-startable, but only the second is an unknown fact that
 * must be re-observed rather than reported as a proven below-threshold value.
 */
export type PredicateTruth = 'true' | 'false' | 'unknown'

export interface PredicateTruthResult {
  truth: PredicateTruth
  /** snapshot fields that were unreadable; non-empty only when truth is 'unknown' */
  unknownInputs: string[]
}

/** Receives one `PREDICATE_UNKNOWN ...` line. Injectable for tests / host logs. */
export type PredicateUnknownSink = (line: string) => void

/** Exact audit line for an unknown predicate (issue #59). */
export function formatPredicateUnknown(predicate: Predicate, unknownInputs: readonly string[]): string {
  const input = unknownInputs.length > 0 ? unknownInputs.map((name) => `${name}=null`).join(',') : 'null'
  return `PREDICATE_UNKNOWN name=${predicate.kind} input=${input} -> false`
}

let predicateUnknownSink: PredicateUnknownSink = (line) => {
  process.stderr.write(`[predicate] ${line}\n`)
}

/**
 * Route `PREDICATE_UNKNOWN` lines to a host logger. Pass null to restore the
 * default stderr sink, or a capturing sink in tests.
 */
export function setPredicateUnknownSink(sink: PredicateUnknownSink | null): void {
  predicateUnknownSink =
    sink ?? ((line) => {
      process.stderr.write(`[predicate] ${line}\n`)
    })
}

function emitPredicateUnknown(predicate: Predicate, unknownInputs: readonly string[]): void {
  predicateUnknownSink(formatPredicateUnknown(predicate, unknownInputs))
}

export interface OptionSpec {
  /** stable id, e.g. "collect:raw_iron", "smelt:iron_ingot" */
  id: string
  /** human-readable intent */
  intent: string
  kind: OptionKind
  target: OptionTarget
  /** I(o): the Option may start only when every precondition holds */
  preconditions: Predicate[]
  /** success(s,o): the Option is complete when every predicate holds */
  success: Predicate[]
  /** grounded skill ids this Option may use (see #20) */
  skills: string[]
  /** beta threshold for this Option (default 0.5) */
  abortThreshold: number
  /** Issue #55: prerequisite Option that a replan must not drop. */
  protected?: boolean
  /** Issue #55: core/rung Option that a replan must not drop. */
  core?: boolean
}

/** The beta threshold used when a spec does not override it. */
export const DEFAULT_ABORT_THRESHOLD = 0.5

/** Env switch. Default OFF so current behavior is untouched until #20/#22 land. */
export const OPTION_COMPILER_ENV = 'BUDDY_OPTION_COMPILER'

export function resolveOptionCompilerEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const raw = (env[OPTION_COMPILER_ENV] ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes'
}

/** A plain-JSON projection of the world the predicates read. No bot, no classes. */
export interface OptionWorldSnapshot {
  /** item name -> total count (semantic classes are resolved via resourceMatches) */
  inventory: Readonly<Record<string, number>>
  dimension: string | null
  position: Vec3Json | null
  health: number | null
  /** best held pickaxe rank, 0..5 (planner.bestPickaxeRank) */
  toolRank: number
  /** placed stations known to WorldMemory (or otherwise grounded) */
  knownStations: readonly ('crafting_table' | 'furnace')[]
  /** ore block names ever discovered (WorldMemory.discoveredOres) */
  knownOres: readonly string[]
}

export type CustomPredicateRegistry = Readonly<Record<string, (snapshot: OptionWorldSnapshot) => boolean>>

// ---------------------------------------------------------------------------
// predicate evaluation (pure, code-only)
// ---------------------------------------------------------------------------

/** Count inventory items matching an item id or a semantic resource class. */
export function inventoryCount(inventory: Readonly<Record<string, number>>, spec: string): number {
  let total = 0
  for (const [name, count] of Object.entries(inventory)) {
    if (resourceMatches(name, spec)) total += count
  }
  return total
}

/** Count inventory items belonging to a semantic class. */
export function inventoryClassCount(inventory: Readonly<Record<string, number>>, cls: ResourceClass): number {
  let total = 0
  for (const [name, count] of Object.entries(inventory)) {
    if (matchesResourceClass(name, cls)) total += count
  }
  return total
}

function normalizeDimension(dimension: string): string {
  return dimension.replace(/^minecraft:/, '').toLowerCase()
}

function oreKnown(snapshot: OptionWorldSnapshot, item: string): boolean {
  const sources = ORE_SOURCES[item]
  const candidates = sources === undefined ? [] : [...sources]
  const base = item.replace(/^raw_/, '').replace(/_ore$/, '')
  return snapshot.knownOres.some(
    (name) => candidates.includes(name) || name === item || name.includes(base),
  )
}

/**
 * Evaluate one predicate into tri-state truth. Pure: it never logs and never
 * throws. `unknown` means the snapshot field the predicate reads was null; it is
 * NEVER treated as satisfaction by the boolean `evaluatePredicate` wrapper.
 */
export function evaluatePredicateTruth(
  predicate: Predicate,
  snapshot: OptionWorldSnapshot,
  custom?: CustomPredicateRegistry,
): PredicateTruthResult {
  switch (predicate.kind) {
    case 'inventoryAtLeast':
      return { truth: inventoryCount(snapshot.inventory, predicate.item) >= predicate.count ? 'true' : 'false', unknownInputs: [] }
    case 'inventoryClassAtLeast':
      return { truth: inventoryClassCount(snapshot.inventory, predicate.cls) >= predicate.count ? 'true' : 'false', unknownInputs: [] }
    case 'pickaxeRankAtLeast':
      return { truth: snapshot.toolRank >= predicate.rank ? 'true' : 'false', unknownInputs: [] }
    case 'stationKnown':
      return { truth: snapshot.knownStations.includes(predicate.station) ? 'true' : 'false', unknownInputs: [] }
    case 'oreKnown':
      return { truth: oreKnown(snapshot, predicate.item) ? 'true' : 'false', unknownInputs: [] }
    case 'dimensionIs':
      if (snapshot.dimension === null) return { truth: 'unknown', unknownInputs: ['dimension'] }
      return {
        truth: normalizeDimension(snapshot.dimension) === normalizeDimension(predicate.dimension) ? 'true' : 'false',
        unknownInputs: [],
      }
    case 'levelAtMost':
      if (snapshot.position === null) return { truth: 'unknown', unknownInputs: ['position'] }
      return { truth: snapshot.position.y <= predicate.y ? 'true' : 'false', unknownInputs: [] }
    case 'healthAtLeast':
      if (snapshot.health === null) return { truth: 'unknown', unknownInputs: ['health'] }
      return { truth: snapshot.health >= predicate.health ? 'true' : 'false', unknownInputs: [] }
    case 'custom': {
      const evaluator = custom?.[predicate.id]
      return { truth: evaluator !== undefined && evaluator(snapshot) ? 'true' : 'false', unknownInputs: [] }
    }
  }
}

/**
 * Evaluate one predicate against a snapshot. Fail-closed: `true` is returned
 * only for proven truth, so an unknown input (null dimension/position/health or
 * an unregistered custom id) yields `false`. Unknowns are emitted as
 * `PREDICATE_UNKNOWN name=<kind> input=<field>=null -> false`.
 */
export function evaluatePredicate(
  predicate: Predicate,
  snapshot: OptionWorldSnapshot,
  custom?: CustomPredicateRegistry,
): boolean {
  const result = evaluatePredicateTruth(predicate, snapshot, custom)
  if (result.truth === 'unknown') emitPredicateUnknown(predicate, result.unknownInputs)
  return result.truth === 'true'
}

export interface PredicateSetTruthResult {
  /** 'false' if any predicate is proven false, else 'unknown' if any is unknown, else 'true' */
  truth: PredicateTruth
  /** predicates that did not hold; unknown predicates are included (unknown is not true) */
  unmet: Predicate[]
  /** subset of `unmet` whose snapshot input was unreadable */
  unknown: Predicate[]
}

/** Evaluate an AND of predicates while preserving the unknown/false distinction. */
export function evaluatePredicatesTruth(
  predicates: readonly Predicate[],
  snapshot: OptionWorldSnapshot,
  custom?: CustomPredicateRegistry,
): PredicateSetTruthResult {
  const unmet: Predicate[] = []
  const unknown: Predicate[] = []
  let hasFalse = false
  for (const predicate of predicates) {
    const result = evaluatePredicateTruth(predicate, snapshot, custom)
    if (result.truth === 'true') continue
    unmet.push(predicate)
    if (result.truth === 'unknown') {
      unknown.push(predicate)
      emitPredicateUnknown(predicate, result.unknownInputs)
    } else {
      hasFalse = true
    }
  }
  const truth: PredicateTruth = hasFalse ? 'false' : unknown.length > 0 ? 'unknown' : 'true'
  return { truth, unmet, unknown }
}

/** Tri-state version of `isOptionStartable`: only 'true' permits a start. */
export function optionStartabilityTruth(
  spec: OptionSpec,
  snapshot: OptionWorldSnapshot,
  custom?: CustomPredicateRegistry,
): PredicateTruth {
  return evaluatePredicatesTruth(spec.preconditions, snapshot, custom).truth
}

export interface PredicateSetResult {
  ok: boolean
  unmet: Predicate[]
}

/** Evaluate an AND of predicates. Returns the unmet subset for expansion/logging. */
export function evaluatePredicates(
  predicates: readonly Predicate[],
  snapshot: OptionWorldSnapshot,
  custom?: CustomPredicateRegistry,
): PredicateSetResult {
  const unmet = predicates.filter((predicate) => !evaluatePredicate(predicate, snapshot, custom))
  return { ok: unmet.length === 0, unmet }
}

/** True when every initiation predicate holds (the Option may start). */
export function isOptionStartable(spec: OptionSpec, snapshot: OptionWorldSnapshot, custom?: CustomPredicateRegistry): boolean {
  return evaluatePredicates(spec.preconditions, snapshot, custom).ok
}

/** True when every success predicate holds (the Option is complete). */
export function isOptionComplete(spec: OptionSpec, snapshot: OptionWorldSnapshot, custom?: CustomPredicateRegistry): boolean {
  return evaluatePredicates(spec.success, snapshot, custom).ok
}

/** Human-readable predicate, for logs. */
export function describePredicate(predicate: Predicate): string {
  switch (predicate.kind) {
    case 'inventoryAtLeast':
      return `${predicate.item} >= ${predicate.count}`
    case 'inventoryClassAtLeast':
      return `class ${predicate.cls} >= ${predicate.count}`
    case 'pickaxeRankAtLeast':
      return `pickaxe rank >= ${predicate.rank}`
    case 'stationKnown':
      return `station ${predicate.station} known`
    case 'oreKnown':
      return `ore for ${predicate.item} known`
    case 'dimensionIs':
      return `dimension == ${predicate.dimension}`
    case 'levelAtMost':
      return `y <= ${predicate.y}`
    case 'healthAtLeast':
      return `health >= ${predicate.health}`
    case 'custom':
      return `custom:${predicate.id}`
  }
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

function isPositiveInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

export function validatePredicate(predicate: unknown): string | null {
  if (typeof predicate !== 'object' || predicate === null) return 'predicate must be an object'
  const p = predicate as Record<string, unknown>
  switch (p.kind) {
    case 'inventoryAtLeast':
      return typeof p.item === 'string' && p.item.length > 0 && isPositiveInt(p.count)
        ? null
        : 'inventoryAtLeast needs a non-empty item and count >= 1'
    case 'inventoryClassAtLeast':
      return typeof p.cls === 'string' && isResourceClass(p.cls) && isPositiveInt(p.count)
        ? null
        : 'inventoryClassAtLeast needs a valid resource class and count >= 1'
    case 'pickaxeRankAtLeast':
      return typeof p.rank === 'number' && Number.isInteger(p.rank) && p.rank >= 1
        ? null
        : 'pickaxeRankAtLeast needs an integer rank >= 1'
    case 'stationKnown':
      return p.station === 'crafting_table' || p.station === 'furnace' ? null : 'stationKnown needs crafting_table|furnace'
    case 'oreKnown':
      return typeof p.item === 'string' && p.item.length > 0 ? null : 'oreKnown needs a non-empty item'
    case 'dimensionIs':
      return typeof p.dimension === 'string' && p.dimension.length > 0 ? null : 'dimensionIs needs a non-empty dimension'
    case 'levelAtMost':
      return typeof p.y === 'number' && Number.isFinite(p.y) ? null : 'levelAtMost needs a finite y'
    case 'healthAtLeast':
      return typeof p.health === 'number' && Number.isFinite(p.health) ? null : 'healthAtLeast needs a finite health'
    case 'custom':
      return typeof p.id === 'string' && p.id.length > 0 ? null : 'custom needs a non-empty id'
    default:
      return `unknown predicate kind ${String(p.kind)}`
  }
}

/** Structural validation. Returns one message per problem; empty means valid. */
export function validateOptionSpec(spec: OptionSpec): string[] {
  const errors: string[] = []
  const record = spec as unknown as Record<string, unknown>
  const id = record.id
  if (typeof id !== 'string' || id.trim().length === 0) errors.push('id must be a non-empty string')
  else if (/\s/.test(id) || !id.includes(':')) errors.push('id must be "<kind>:<target>" without whitespace')
  const kind = record.kind
  if (typeof kind !== 'string' || !OPTION_KINDS.includes(kind as OptionKind)) {
    errors.push(`kind must be one of ${OPTION_KINDS.join('|')}`)
  }
  const intent = record.intent
  if (typeof intent !== 'string' || intent.trim().length === 0) errors.push('intent must be a non-empty string')
  const preconditions = record.preconditions
  const success = record.success
  if (!Array.isArray(preconditions)) errors.push('preconditions must be an array')
  if (!Array.isArray(success)) errors.push('success must be an array')
  if (!Array.isArray(record.skills)) errors.push('skills must be an array')
  const target = record.target
  if (typeof target !== 'object' || target === null) errors.push('target must be an object')
  else {
    const count = (target as Record<string, unknown>).count
    if (count !== undefined && !isPositiveInt(count)) errors.push('target.count must be an integer >= 1')
    if (kind === 'descend') {
      const targetY = (target as Record<string, unknown>).targetY
      if (typeof targetY !== 'number' || !Number.isFinite(targetY)) {
        errors.push('descend target.targetY must be a finite number')
      }
    }
  }
  const threshold = record.abortThreshold
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    errors.push('abortThreshold must be a number in [0,1]')
  }
  const all = [...(Array.isArray(preconditions) ? preconditions : []), ...(Array.isArray(success) ? success : [])]
  for (const predicate of all) {
    const reason = validatePredicate(predicate)
    if (reason !== null) errors.push(reason)
  }
  return errors
}

export function isValidOptionSpec(spec: OptionSpec): boolean {
  return validateOptionSpec(spec).length === 0
}

// ---------------------------------------------------------------------------
// PlannedGoal -> OptionSpec compiler
// ---------------------------------------------------------------------------

function slug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned.length > 0 ? cleaned : 'unknown'
}

/** Stable Option id for a planned goal, e.g. `collect:raw_iron`. */
export function stableOptionId(goal: PlannedGoal): string {
  const item = goal.targetItem
  const tail = typeof item === 'string' && item.length > 0 ? item : slug(goal.description)
  return `${goal.kind}:${tail}`
}

export function optionKindForGoal(kind: GoalKind): OptionKind {
  switch (kind) {
    case 'collect':
      return 'collect'
    case 'craft':
      return 'craft'
    case 'place':
      return 'place'
    case 'smelt':
      return 'smelt'
    case 'explore':
      return 'explore'
    case 'descend':
      return 'descend'
    case 'recover':
      return 'combat'
    case 'unknown':
      return 'custom'
  }
}

export function goalKindForOption(kind: OptionKind): GoalKind {
  switch (kind) {
    case 'collect':
      return 'collect'
    case 'craft':
      return 'craft'
    case 'smelt':
      return 'smelt'
    case 'place':
      return 'place'
    case 'explore':
      return 'explore'
    case 'descend':
      return 'descend'
    case 'combat':
      return 'recover'
    case 'goto':
      return 'explore'
    case 'custom':
      return 'unknown'
  }
}

const SKILLS_BY_KIND: Readonly<Record<OptionKind, readonly string[]>> = {
  collect: ['BRANCH_MINE', 'RETURN_TO_KNOWN_ORE'],
  craft: ['CRAFT_AT_STATION'],
  smelt: ['SMELT_AT_FURNACE'],
  place: ['PLACE_STATION'],
  goto: ['PATHFIND_TO'],
  explore: ['EXPLORE_FRONTIER'],
  descend: ['STAIRCASE', 'REUSE_TUNNEL', 'BRANCH_MINE'],
  combat: ['ENGAGE_TARGET'],
  custom: [],
}

const PICKAXE_BY_RANK: Readonly<Record<number, string>> = Object.fromEntries(
  PICKAXE_TIER_ORDER.map((tool, index) => [index + 1, tool]),
)

function goalCount(goal: PlannedGoal): number {
  return Math.max(1, Math.floor(goal.requiredCount ?? 1))
}

/**
 * Minimum pickaxe tier (1-based) required to collect `item`, derived from
 * minecraft-data: first try the item as a block name (stone/cobblestone), then
 * as an ore drop (raw_iron/diamond/gold/...). The old hand table returned 2 for
 * every ore, which wrongly allowed a stone pickaxe for diamond ore.
 */
function pickaxeRankForCollectItem(item: string): number | null {
  const reg = loadGameData()
  const asBlock = requiredPickaxeRank1(reg, item)
  return asBlock ?? requiredPickaxeRankForItem1(reg, item)
}

/**
 * Craft preconditions derived from the item's minecraft-data recipe variants.
 * An ingredient is only required when EVERY variant needs it (a necessary
 * condition), so a bamboo-or-stick variant never forces one specific substitute
 * and a false-positive initiation predicate is impossible. Stone-class stacks
 * collapse to a class predicate (`8 x stone` for furnace). This is what fixed
 * `diamond_pickaxe` requiring 1 diamond instead of 3 (#54).
 */
function craftPreconditions(item: string): Predicate[] {
  const variants = recipesFor(item)
  if (variants.length === 0) return []
  const required = new Map<string, IngredientPredicate>()
  let seeded = false
  for (const variant of variants) {
    const needs = variantRequirements(variant)
    if (!seeded) {
      for (const [key, predicate] of needs) required.set(key, predicate)
      seeded = true
      continue
    }
    for (const [key, predicate] of [...required]) {
      const other = needs.get(key)
      if (other === undefined) required.delete(key)
      else required.set(key, { ...predicate, count: Math.min(predicate.count, other.count) })
    }
  }
  return [...required.values()]
}

type IngredientPredicate = Extract<Predicate, { kind: 'inventoryAtLeast' | 'inventoryClassAtLeast' }>

/**
 * Craft intermediates that are deliberately NOT initiation predicates. Sticks
 * are trivially produced from any plank/log and are resolved by the craft skill
 * and the executor's recipe lookup; making them an Option precondition made the
 * compiled chain disagree with the deterministic ladder (#54 scope note).
 */
const CRAFT_INTERMEDIATE_ITEMS = new Set(['stick'])

function variantRequirements(recipe: RecipeView): Map<string, IngredientPredicate> {
  const needed = new Map<string, IngredientPredicate>()
  const stoneCount = recipe.ingredients
    .filter((ingredient) => matchesResourceClass(ingredient.item, 'stone'))
    .reduce((total, ingredient) => total + ingredient.count, 0)
  if (stoneCount > 0) needed.set('class:stone', { kind: 'inventoryClassAtLeast', cls: 'stone', count: stoneCount })
  for (const ingredient of recipe.ingredients) {
    if (matchesResourceClass(ingredient.item, 'stone')) continue
    if (CRAFT_INTERMEDIATE_ITEMS.has(ingredient.item)) continue
    needed.set(`item:${ingredient.item}`, { kind: 'inventoryAtLeast', item: ingredient.item, count: ingredient.count })
  }
  return needed
}

/**
 * Initiation predicates derived from deterministic ladder policy (#12) plus
 * minecraft-data mechanics (#54): harvest tiers from `blocks[].harvestTools`,
 * ingredient counts from `recipes`. Strategic rules minecraft-data cannot
 * express (e.g. "stone_pickaxe needs some pickaxe") stay explicit.
 */
function preconditionsForGoal(goal: PlannedGoal): Predicate[] {
  const item = goal.targetItem ?? null
  if (item === null) return []
  const count = goalCount(goal)
  switch (goal.kind) {
    case 'collect': {
      const rank = pickaxeRankForCollectItem(item)
      return rank === null ? [] : [{ kind: 'pickaxeRankAtLeast', rank }]
    }
    case 'craft': {
      const preconditions = craftPreconditions(item)
      if (item === 'stone_pickaxe') preconditions.push({ kind: 'pickaxeRankAtLeast', rank: 1 })
      return preconditions
    }
    case 'smelt':
      if (item === 'iron_ingot') {
        return [
          { kind: 'stationKnown', station: 'furnace' },
          { kind: 'inventoryAtLeast', item: 'raw_iron', count },
        ]
      }
      if (item === 'charcoal') return [{ kind: 'stationKnown', station: 'furnace' }]
      return [{ kind: 'stationKnown', station: 'furnace' }]
    case 'place':
      if (item === 'furnace') return [{ kind: 'inventoryAtLeast', item: 'furnace', count: 1 }]
      if (item === 'crafting_table') return [{ kind: 'inventoryAtLeast', item: 'crafting_table', count: 1 }]
      return []
    default:
      return []
  }
}

/** Completion predicates: item counts, or the verified station for `place`. */
function successForGoal(goal: PlannedGoal): Predicate[] {
  const item = goal.targetItem ?? null
  const count = goalCount(goal)
  switch (goal.kind) {
    case 'collect':
    case 'craft':
    case 'smelt':
      return item === null
        ? [{ kind: 'custom', id: `done:${goal.kind}` }]
        : [{ kind: 'inventoryAtLeast', item, count }]
    case 'place':
      if (item === 'furnace') return [{ kind: 'stationKnown', station: 'furnace' }]
      if (item === 'crafting_table') return [{ kind: 'stationKnown', station: 'crafting_table' }]
      return [{ kind: 'custom', id: `station:${item ?? 'unknown'}` }]
    case 'descend':
      return typeof goal.targetY === 'number' && Number.isFinite(goal.targetY)
        ? [{ kind: 'levelAtMost', y: goal.targetY }]
        : [{ kind: 'custom', id: `descend:${item ?? 'unknown'}` }]
    case 'explore':
      // #57: an explore goal qualified by a dimension is the typed `dimensionIs`
      // predicate, never a prose completion. This keeps the deterministic target
      // semantics when a `dimensionIs` dependency is compiled back from its
      // PlannedGoal (dependency expansion -> GoalQueue -> compile).
      return typeof goal.dimension === 'string' && goal.dimension.length > 0
        ? [{ kind: 'dimensionIs', dimension: goal.dimension }]
        : [{ kind: 'custom', id: `done:explore:${item ?? 'unknown'}` }]
    default:
      return [{ kind: 'custom', id: `done:${goal.kind}:${item ?? 'unknown'}` }]
  }
}

/** Compile one planned goal into an OptionSpec. Pure and total. */
export function compilePlannedGoal(goal: PlannedGoal): OptionSpec {
  const kind = optionKindForGoal(goal.kind)
  const target: OptionTarget = { count: goalCount(goal) }
  if (typeof goal.targetItem === 'string' && goal.targetItem.length > 0) target.item = goal.targetItem
  if (typeof goal.targetY === 'number' && Number.isFinite(goal.targetY)) target.targetY = goal.targetY
  if (typeof goal.dimension === 'string' && goal.dimension.length > 0) target.dimension = goal.dimension
  return {
    id: stableOptionId(goal),
    intent: goal.description,
    kind,
    target,
    preconditions: preconditionsForGoal(goal),
    success: successForGoal(goal),
    skills: [...SKILLS_BY_KIND[kind]],
    abortThreshold: DEFAULT_ABORT_THRESHOLD,
    ...(goal.protected === true ? { protected: true } : {}),
    ...(goal.core === true ? { core: true } : {}),
  }
}

export function compilePlannedGoals(goals: readonly PlannedGoal[]): OptionSpec[] {
  return goals.map(compilePlannedGoal)
}

export function queuedToPlanned(goal: QueuedGoal): PlannedGoal {
  const planned: PlannedGoal = {
    kind: goal.kind,
    description: goal.description,
    targetItem: goal.targetItem,
    requiredCount: goal.requiredCount,
    ...(goal.protected === true ? { protected: true } : {}),
    ...(goal.core === true ? { core: true } : {}),
  }
  if (typeof goal.targetY === 'number' && Number.isFinite(goal.targetY)) planned.targetY = goal.targetY
  if (typeof goal.dimension === 'string' && goal.dimension.length > 0) planned.dimension = goal.dimension
  return planned
}

/** Compile the current goal plus every pending goal, in queue order. */
export function compileGoalQueue(state: GoalQueueState): OptionSpec[] {
  const goals: PlannedGoal[] = []
  if (state.current !== null) goals.push(queuedToPlanned(state.current))
  for (const goal of state.goals) {
    if (goal.status === 'pending') goals.push(queuedToPlanned(goal))
  }
  return compilePlannedGoals(goals)
}

// ---------------------------------------------------------------------------
// readiness-first ordering (#46)
// ---------------------------------------------------------------------------

/**
 * Stable plan-order label for a goal. The iron smelt keeps its historic
 * `smelt_iron_ingot` id so `PLAN_ORDER` evidence stays comparable to pre-#46
 * runs; every other goal uses `<kind>_<target|description-slug>`.
 */
export function goalReadinessLabel(goal: PlannedGoal): string {
  if (goal.kind === 'smelt' && goal.targetItem === 'iron_ingot') return 'smelt_iron_ingot'
  const tail =
    typeof goal.targetItem === 'string' && goal.targetItem.length > 0 ? goal.targetItem : slug(goal.description)
  return `${goal.kind}_${tail}`
}

/** The readiness partition of a plan plus the reorderings that changed order. */
export interface ReadinessOrderResult {
  /** ready goals (stable) followed by goals with an unmet precondition (stable) */
  goals: PlannedGoal[]
  /** goals whose preconditions ALL hold in the snapshot */
  ready: PlannedGoal[]
  /** goals with at least one unmet precondition */
  blocked: PlannedGoal[]
  /** ready goals that were moved ahead of a blocked goal (for PLAN_ORDER) */
  moves: Array<{ preferred: string; over: string }>
}

/**
 * Issue #46 requirement 1: stable readiness partition. Ready goals move ahead of
 * goals with an unmet precondition. Safe because the preconditions encode the
 * dependency chain, so a producer is never blocked while its consumer is ready.
 */
export function orderGoalsByReadiness(
  goals: readonly PlannedGoal[],
  snapshot: OptionWorldSnapshot,
  custom?: CustomPredicateRegistry,
): ReadinessOrderResult {
  const ready: PlannedGoal[] = []
  const blocked: PlannedGoal[] = []
  const isReady: boolean[] = []
  for (const goal of goals) {
    const startable = isOptionStartable(compilePlannedGoal(goal), snapshot, custom)
    isReady.push(startable)
    if (startable) ready.push(goal)
    else blocked.push(goal)
  }
  const moves: Array<{ preferred: string; over: string }> = []
  for (let j = 0; j < goals.length; j += 1) {
    if (isReady[j] === true) continue
    const overGoal = goals[j]
    if (overGoal === undefined) continue
    for (let i = j + 1; i < goals.length; i += 1) {
      const candidate = goals[i]
      if (candidate === undefined || isReady[i] !== true) continue
      moves.push({ preferred: goalReadinessLabel(candidate), over: overGoal.description })
    }
  }
  return { goals: [...ready, ...blocked], ready, blocked, moves }
}

/** OptionSpec -> PlannedGoal, so compiled Options seed the existing GoalQueue. */
export function optionSpecToPlannedGoal(spec: OptionSpec): PlannedGoal {
  const goal: PlannedGoal = {
    kind: goalKindForOption(spec.kind),
    description: spec.intent,
    requiredCount: spec.target.count ?? 1,
  }
  if (typeof spec.target.item === 'string' && spec.target.item.length > 0) goal.targetItem = spec.target.item
  if (typeof spec.target.targetY === 'number' && Number.isFinite(spec.target.targetY)) goal.targetY = spec.target.targetY
  if (typeof spec.target.dimension === 'string' && spec.target.dimension.length > 0) goal.dimension = spec.target.dimension
  if (spec.protected === true) goal.protected = true
  if (spec.core === true) goal.core = true
  return goal
}

export function optionSpecsToPlannedGoals(specs: readonly OptionSpec[]): PlannedGoal[] {
  return specs.map(optionSpecToPlannedGoal)
}

// ---------------------------------------------------------------------------
// dependency expansion (#12 generalization)
// ---------------------------------------------------------------------------

/**
 * Hard cap so a malformed dependency graph can never recurse forever; cycles
 * are detected separately. #54 minecraft-data harvest tiers make a valid
 * `collect:obsidian` chain deeper than the old hand table's 8.
 */
export const MAX_DEPENDENCY_DEPTH = 16

const SMELT_ITEMS = new Set(['charcoal', 'iron_ingot', 'gold_ingot', 'copper_ingot', 'glass'])
const CRAFT_ITEMS = new Set([
  'crafting_table',
  'furnace',
  'wooden_pickaxe',
  'stone_pickaxe',
  'iron_pickaxe',
  'diamond_pickaxe',
  'stick',
  'torch',
  'chest',
  'iron_chestplate',
  'iron_leggings',
  'iron_helmet',
  'iron_boots',
  'iron_sword',
])

const CLASS_DEPENDENCY_ITEM: Readonly<Record<ResourceClass, string | null>> = {
  log: 'log',
  planks: 'planks',
  stone: 'cobblestone',
  fuel: 'log',
  food: 'food',
  pickaxe: 'wooden_pickaxe',
}

/** Which goal produces an item: smelt > craft > collect (the safe default). */
export function dependencyGoalForItem(item: string, count: number): PlannedGoal {
  const n = Math.max(1, count)
  if (SMELT_ITEMS.has(item)) return { kind: 'smelt', description: `smelt ${n} x ${item}`, targetItem: item, requiredCount: n }
  if (CRAFT_ITEMS.has(item)) return { kind: 'craft', description: `craft ${n} x ${item}`, targetItem: item, requiredCount: n }
  return { kind: 'collect', description: `collect ${n} x ${item}`, targetItem: item, requiredCount: n }
}

/** The prerequisite goal that would satisfy one unmet predicate, or null. */
export function dependencyGoalForPredicate(
  predicate: Predicate,
  owner: OptionSpec,
  snapshot: OptionWorldSnapshot,
): PlannedGoal | null {
  switch (predicate.kind) {
    case 'inventoryAtLeast': {
      const missing = Math.max(1, predicate.count - inventoryCount(snapshot.inventory, predicate.item))
      return dependencyGoalForItem(predicate.item, missing)
    }
    case 'inventoryClassAtLeast': {
      const item = CLASS_DEPENDENCY_ITEM[predicate.cls]
      if (item === null) return null
      const missing = Math.max(1, predicate.count - inventoryClassCount(snapshot.inventory, predicate.cls))
      return dependencyGoalForItem(item, missing)
    }
    case 'pickaxeRankAtLeast': {
      const item = PICKAXE_BY_RANK[predicate.rank]
      if (item === undefined) return null
      return { kind: 'craft', description: `craft 1 x ${item}`, targetItem: item, requiredCount: 1 }
    }
    case 'stationKnown':
      return { kind: 'place', description: `place 1 x ${predicate.station}`, targetItem: predicate.station, requiredCount: 1 }
    case 'oreKnown':
      return dependencyGoalForItem(predicate.item, owner.target.count ?? 1)
    case 'levelAtMost':
      return {
        kind: 'descend',
        description: `descend to y <= ${predicate.y}`,
        targetItem: null,
        requiredCount: 1,
        targetY: predicate.y,
      }
    case 'dimensionIs':
      return {
        kind: 'explore',
        description: `travel to ${predicate.dimension}`,
        targetItem: null,
        requiredCount: 1,
        dimension: predicate.dimension,
      }
    case 'healthAtLeast':
      return null
    case 'custom':
      return null
  }
}

/**
 * A structured record for one Option that was withheld from the execution queue
 * because it (or an ancestor) has an unmet initiation predicate with no
 * deterministic producer (#50). `blockedBy === option` for a self-block; for a
 * pruned descendant `blockedBy` is the blocked ancestor's id.
 */
export interface BlockedOptionEntry {
  /** the Option that was NOT enqueued */
  option: string
  /** the Option whose block pruned it; equal to `option` for a self-block */
  blockedBy: string
  /** human-readable predicate / reason */
  reason: string
}

/** Log marker emitted for every blocked Option that is withheld (#50). */
export const BLOCKED_OPTION_NOT_ENQUEUED = 'BLOCKED_OPTION_NOT_ENQUEUED'

/** One-line rendering of a blocked-Option record (host log and tests share it). */
export function formatBlockedOptionLog(entry: BlockedOptionEntry): string {
  return `${BLOCKED_OPTION_NOT_ENQUEUED} option=${entry.option} blockedBy=${entry.blockedBy} reason=${entry.reason}`
}

/** Emit one `BLOCKED_OPTION_NOT_ENQUEUED option/blockedBy/reason` record per entry. */
export function emitBlockedOptionLogs(
  entries: readonly BlockedOptionEntry[],
  log: (event: string, detail?: Record<string, unknown>) => void,
): void {
  for (const entry of entries) {
    log(BLOCKED_OPTION_NOT_ENQUEUED, { option: entry.option, blockedBy: entry.blockedBy, reason: entry.reason })
  }
}

export interface ExpansionResult {
  /**
   * dependencies first (deepest first), then the option itself. A blocked Option
   * and its whole dependency subtree are PRUNED from this list (#50).
   */
  specs: OptionSpec[]
  expanded: boolean
  /** ids of the dependency Options that were added in front */
  added: string[]
  /** unmet predicates that have no deterministic dependency (surfaced, not fatal) */
  blocked: string[]
  /** structured records for every Option withheld from the queue (#50) */
  blockedOptions: BlockedOptionEntry[]
}

/**
 * Expand an Option into its prerequisite chain. An unmet precondition becomes a
 * prerequisite Option, recursively, unless the predicate has no deterministic
 * producer. In that case the Option is BLOCKED: it is not startable, so neither
 * it nor any of its descendants may enter the execution queue (#50). Blocked
 * entries are surfaced in `blocked` (log text) and `blockedOptions` (structured).
 */
export function expandOptionDependencies(
  spec: OptionSpec,
  snapshot: OptionWorldSnapshot,
  options?: { maxDepth?: number; custom?: CustomPredicateRegistry },
): ExpansionResult {
  const maxDepth = options?.maxDepth ?? MAX_DEPENDENCY_DEPTH
  const custom = options?.custom
  const ordered: OptionSpec[] = []
  const seen = new Set<string>()
  const visiting = new Set<string>()
  const added: string[] = []
  const blocked: string[] = []
  const blockedOptions: BlockedOptionEntry[] = []

  const recordBlock = (option: string, blockedBy: string, reason: string): void => {
    if (blockedOptions.some((entry) => entry.option === option && entry.blockedBy === blockedBy && entry.reason === reason)) return
    blockedOptions.push({ option, blockedBy, reason })
  }

  const walk = (current: OptionSpec, depth: number, blockedByAncestor: string | null): void => {
    if (seen.has(current.id)) return
    if (blockedByAncestor !== null) {
      // #50: a blocked ancestor poisons its whole dependency subtree. Surface the
      // descendant as a pruned dependency-expansion request; never enqueue it.
      seen.add(current.id)
      recordBlock(current.id, blockedByAncestor, `ancestor ${blockedByAncestor} blocked`)
      return
    }
    if (depth > maxDepth) {
      blocked.push(`${current.id}: max dependency depth ${maxDepth} exceeded`)
      recordBlock(current.id, current.id, `max dependency depth ${maxDepth} exceeded`)
      return
    }
    if (visiting.has(current.id)) {
      blocked.push(`${current.id}: dependency cycle`)
      recordBlock(current.id, current.id, 'dependency cycle')
      return
    }
    visiting.add(current.id)
    const { unmet } = evaluatePredicates(current.preconditions, snapshot, custom)
    const dependencies: OptionSpec[] = []
    const blockedReasons: string[] = []
    for (const predicate of unmet) {
      const dependency = dependencyGoalForPredicate(predicate, current, snapshot)
      if (dependency === null) {
        blockedReasons.push(describePredicate(predicate))
        continue
      }
      const dependencySpec = compilePlannedGoal(dependency)
      if (dependencySpec.id === current.id) continue
      dependencies.push(dependencySpec)
    }
    if (blockedReasons.length > 0) {
      // #50: I(o) is false and cannot be produced deterministically. The Option is
      // not startable, so neither it nor its dependencies may be handed to the
      // execution queue. Record the block and prune the subtree.
      visiting.delete(current.id)
      seen.add(current.id)
      for (const reason of blockedReasons) {
        blocked.push(`${current.id}: ${reason}`)
        recordBlock(current.id, current.id, reason)
      }
      for (const dependencySpec of dependencies) {
        walk(dependencySpec, depth + 1, current.id)
      }
      return
    }
    for (const dependencySpec of dependencies) {
      walk(dependencySpec, depth + 1, null)
    }
    visiting.delete(current.id)
    if (!seen.has(current.id)) {
      seen.add(current.id)
      if (current.id !== spec.id) added.push(current.id)
      ordered.push(current)
    }
  }

  walk(spec, 0, null)
  return { specs: ordered, expanded: added.length > 0 || blocked.length > 0, added, blocked, blockedOptions }
}

// ---------------------------------------------------------------------------
// flag-gated compile entry points
// ---------------------------------------------------------------------------

export interface OptionCompileResult {
  /** whether the compiled goal chain may replace the planned goals */
  enabled: boolean
  /** every compiled Option (dependencies first), always available for shadow logging */
  specs: OptionSpec[]
  /** goals to hand to the GoalQueue: compiled when enabled, else the input */
  goals: PlannedGoal[]
  /** ids of dependency Options added in front of the planned goals */
  added: string[]
  /** unmet predicates with no deterministic dependency */
  blocked: string[]
  /** structured #50 records for every Option withheld from the execution queue */
  blockedOptions: BlockedOptionEntry[]
  /** planned goals rejected because no valid OptionSpec could be built */
  rejected: Array<{ description: string; reason: string }>
}

/**
 * Compile a planned goal list into Options with dependency expansion.
 *
 * When `enabled` is false (the default) the returned `goals` are the input goals
 * unchanged - the current behavior stays intact - while `specs` still carries the
 * compiled Options for opt-in shadow logging.
 */
export function applyCompiledPlan(
  planned: readonly PlannedGoal[],
  snapshot: OptionWorldSnapshot,
  options?: { enabled?: boolean; custom?: CustomPredicateRegistry; maxDepth?: number },
): OptionCompileResult {
  const enabled = options?.enabled ?? resolveOptionCompilerEnabled()
  const specs: OptionSpec[] = []
  const seen = new Set<string>()
  const added: string[] = []
  const blocked: string[] = []
  const blockedOptions: BlockedOptionEntry[] = []
  const rejected: Array<{ description: string; reason: string }> = []

  for (const goal of planned) {
    const spec = compilePlannedGoal(goal)
    const errors = validateOptionSpec(spec)
    if (errors.length > 0) {
      rejected.push({ description: goal.description, reason: errors.join('; ') })
      continue
    }
    const expansion = expandOptionDependencies(spec, snapshot, { custom: options?.custom, maxDepth: options?.maxDepth })
    for (const expanded of expansion.specs) {
      if (seen.has(expanded.id)) continue
      seen.add(expanded.id)
      specs.push(expanded)
    }
    for (const id of expansion.added) if (!added.includes(id)) added.push(id)
    for (const message of expansion.blocked) if (!blocked.includes(message)) blocked.push(message)
    for (const entry of expansion.blockedOptions) {
      if (blockedOptions.some((existing) => existing.option === entry.option && existing.blockedBy === entry.blockedBy && existing.reason === entry.reason)) continue
      blockedOptions.push(entry)
    }
  }

  return {
    enabled,
    specs,
    goals: enabled ? optionSpecsToPlannedGoals(specs) : [...planned],
    added,
    blocked,
    blockedOptions,
    rejected,
  }
}

// ---------------------------------------------------------------------------
// snapshot adapters (no bot / no class instances)
// ---------------------------------------------------------------------------

export interface OptionSnapshotInput {
  inventory: Readonly<Record<string, number>>
  dimension?: string | null
  position?: Vec3Json | null
  health?: number | null
  toolRank?: number
  knownStations?: readonly ('crafting_table' | 'furnace')[]
  knownOres?: readonly string[]
}

export function makeOptionSnapshot(input: OptionSnapshotInput): OptionWorldSnapshot {
  return {
    inventory: input.inventory,
    dimension: input.dimension ?? null,
    position: input.position ?? null,
    health: input.health ?? null,
    toolRank: input.toolRank ?? 0,
    knownStations: input.knownStations ?? [],
    knownOres: input.knownOres ?? [],
  }
}

/** Build a snapshot from the resident WorldMemory projection. Pure. */
export function snapshotFromResident(input: {
  inventory: Readonly<Record<string, number>>
  dimension: string | null
  position: Vec3Json | null
  health: number | null
  toolRank: number
  craftingTables: readonly Vec3Json[]
  furnaces: readonly Vec3Json[]
  discoveredOres: readonly string[]
}): OptionWorldSnapshot {
  const knownStations: Array<'crafting_table' | 'furnace'> = []
  if (input.craftingTables.length > 0) knownStations.push('crafting_table')
  if (input.furnaces.length > 0) knownStations.push('furnace')
  return makeOptionSnapshot({
    inventory: input.inventory,
    dimension: input.dimension,
    position: input.position,
    health: input.health,
    toolRank: input.toolRank,
    knownStations,
    knownOres: input.discoveredOres,
  })
}
