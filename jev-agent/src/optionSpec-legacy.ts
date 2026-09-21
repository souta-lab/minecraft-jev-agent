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
import type { GoalKind, GoalQueueState, GoalStrategy, PlannedGoal, QueuedGoal } from './goalQueue.ts'
import { ORE_SOURCES } from './state.ts'
import type { Vec3Json } from './state.ts'
import { findInventoryFuel, isResourceClass, matchesResourceClass, resourceMatches } from './resourceClass.ts'
import type { ResourceClass } from './resourceClass.ts'
import {
  PICKAXE_TIER_ORDER,
  fuelCountFor,
  loadGameData,
  recipesFor,
  requiredPickaxeRank1,
  requiredPickaxeRankForItem1,
  smeltInputFor,
} from './gameData.ts'
import type { RecipeIngredient, RecipeView } from './gameData.ts'

export type OptionKind =
  | 'collect'
  | 'craft'
  | 'smelt'
  | 'place'
  | 'goto'
  | 'explore'
  | 'surface'
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
  'surface',
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
  /** spatial predicate goal (#41/#136): complete when the code-owned level predicate holds */
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
  | { readonly kind: 'levelAtLeast'; readonly y: number }
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
  strategy?: GoalStrategy
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
  /**
   * Canonical System2 semantic owner. Prerequisite specs retain their own
   * executable id/kind, while this identity names the parent WHAT selected by
   * System2 and is carried through the Option compiler.
   */
  semanticOptionInstanceId?: string
  semanticOptionTemplateId?: string
  semanticOptionIntent?: string
}

/** Runtime facts attached to the exact queue instance of a compiled Option. */
export interface OptionRuntimeState {
  startedAt: number
  verifiedProgress: number
  failures: number
  lastProgressAt: number
}

/**
 * The code-owned Option contract visible at the Jev decision boundary.
 * `instanceId` is the GoalQueue row id; `templateId` is the stable Option id.
 */
export interface CurrentOptionContext {
  instanceId: string
  templateId: string
  /** Semantic owner used by beta/System2; instanceId/templateId remain the
   * executable queue row identity for mechanical diagnostics. */
  semanticInstanceId?: string
  semanticTemplateId?: string
  semanticIntent?: string
  kind: OptionKind
  target: OptionTarget
  preconditions: Predicate[]
  success: Predicate[]
  allowedSkills: string[]
  abortThreshold: number
  runtime: OptionRuntimeState
}

/**
 * Skills that are always inside an Option's execution envelope.
 *
 * SAFETY and CONTROL are cross-cutting execution capabilities. PREREQUISITE
 * is the typed bridge for a mechanically proven acquisition that makes the
 * current semantic Option startable or executable. They are not semantic
 * ranking rules and do not select a candidate.
 */
export const OPTION_ENVELOPE_SKILLS = ['SAFETY', 'CONTROL', 'PREREQUISITE'] as const

export function optionSkillEnvelope(skills: readonly string[]): string[] {
  return [...new Set([...OPTION_ENVELOPE_SKILLS, ...skills])]
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
    case 'levelAtLeast':
      if (snapshot.position === null) return { truth: 'unknown', unknownInputs: ['position'] }
      return { truth: snapshot.position.y >= predicate.y ? 'true' : 'false', unknownInputs: [] }
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
    case 'levelAtLeast':
      return `y >= ${predicate.y}`
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
    case 'levelAtLeast':
      return typeof p.y === 'number' && Number.isFinite(p.y) ? null : 'levelAtLeast needs a finite y'
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
  return `${goal.kind}:${tail}${goal.strategy === undefined ? '' : `:strategy=${goal.strategy}`}`
}

/**
 * Issue #52: precise identity of one Option *instance kind* inside a plan.
 *
 * `stableOptionId` (and therefore `OptionSpec.id`) is the OptionTemplateId: the
 * semantic capability, e.g. `collect:log`. That is the right key for capability
 * lookup, priors, metrics and cache namespaces, but it is the WRONG key for
 * global dedupe: a valid plan may repeat the same capability as genuinely
 * distinct steps (`collect log x3` early, `collect log x2` later as fuel), and a
 * `Set` keyed on the template silently deleted the later occurrence.
 *
 * This appends only the *discriminating target fields* (count, dimension,
 * targetY, named predicate). It is a pure function of plain spec data, so:
 *   - distinct instances (different count/dimension/Y/predicate) stay distinct;
 *   - fully identical instances produce the same id and still collapse;
 *   - recompiling the same plan yields byte-identical ids (deterministic).
 * It deliberately does NOT encode plan position or random data: occurrence
 * identity belongs to the runtime/graph layer, not the semantic id.
 */
export function stableOptionInstanceId(spec: OptionSpec): string {
  const parts: string[] = []
  const count = Math.max(1, Math.floor(spec.target.count ?? 1))
  if (count !== 1) parts.push(`c${count}`)
  const dimension = spec.target.dimension
  if (typeof dimension === 'string' && dimension.length > 0) parts.push(`d${slug(dimension)}`)
  const targetY = spec.target.targetY
  if (typeof targetY === 'number' && Number.isFinite(targetY)) parts.push(`y${targetY}`)
  const predicate = spec.target.predicate
  if (typeof predicate === 'string' && predicate.length > 0) parts.push(`p${slug(predicate)}`)
  return parts.length === 0 ? spec.id : `${spec.id}#${parts.join('~')}`
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
    case 'surface':
      return 'surface'
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
    case 'surface':
      return 'surface'
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
  surface: ['RETURN_TO_SURFACE'],
  descend: ['STAIRCASE', 'REUSE_TUNNEL', 'BRANCH_MINE'],
  combat: ['ENGAGE_TARGET'],
  custom: [],
}

const SKILLS_BY_STRATEGY: Readonly<Record<GoalStrategy, readonly string[]>> = {
  descend_to_y16: ['DESCEND_TO_LEVEL', 'STAIRCASE'],
  explore_cave: ['EXPLORE_CAVE_FRONTIER'],
  branch_mine: ['BRANCH_MINE'],
  return_to_known_ore: ['RETURN_TO_KNOWN_ORE'],
  return_to_surface: ['RETURN_TO_SURFACE'],
  smelt_and_craft: ['SMELT_AND_CRAFT'],
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

type IngredientPredicate = Extract<Predicate, { kind: 'inventoryAtLeast' | 'inventoryClassAtLeast' }>

/**
 * One class-folded ingredient requirement of a recipe variant. `cls` is non-null
 * only for the stone class: any stone item (`cobblestone`, `blackstone`, ...)
 * satisfies it, so `furnace` collapses to `8 x stone` instead of demanding one
 * specific rock. `item` stays the concrete recipe anchor for logging.
 */
export interface CraftIngredientNeed {
  item: string
  count: number
  cls: ResourceClass | null
}

/**
 * Fold a recipe's raw ingredient list into class-aware requirements, summing
 * duplicates. Data-driven: the list comes from the recipe, never a hand table.
 * `stick` is NOT skipped: a pickaxe genuinely needs 2 sticks, and the
 * prerequisite chain must be able to order their producer (#craft-ingredient-prereq).
 */
export function craftIngredientNeeds(ingredients: readonly RecipeIngredient[]): CraftIngredientNeed[] {
  const needs = new Map<string, CraftIngredientNeed>()
  const stoneCount = ingredients
    .filter((ingredient) => matchesResourceClass(ingredient.item, 'stone'))
    .reduce((total, ingredient) => total + ingredient.count, 0)
  if (stoneCount > 0) needs.set('class:stone', { item: 'cobblestone', count: stoneCount, cls: 'stone' })
  for (const ingredient of ingredients) {
    if (matchesResourceClass(ingredient.item, 'stone')) continue
    const key = `item:${ingredient.item}`
    const existing = needs.get(key)
    if (existing === undefined) needs.set(key, { item: ingredient.item, count: ingredient.count, cls: null })
    else existing.count += ingredient.count
  }
  return [...needs.values()]
}

function variantRequirements(recipe: RecipeView): Map<string, IngredientPredicate> {
  const needed = new Map<string, IngredientPredicate>()
  for (const need of craftIngredientNeeds(recipe.ingredients)) {
    const key = need.cls === null ? `item:${need.item}` : `class:${need.cls}`
    needed.set(
      key,
      need.cls === null
        ? { kind: 'inventoryAtLeast', item: need.item, count: need.count }
        : { kind: 'inventoryClassAtLeast', cls: need.cls, count: need.count },
    )
  }
  return needed
}

function needCount(need: CraftIngredientNeed, inventory: Readonly<Record<string, number>>): number {
  return need.cls === null ? (inventory[need.item] ?? 0) : inventoryClassCount(inventory, need.cls)
}

/**
 * True when every ingredient can be produced from the live inventory, following
 * recipes recursively (log -> planks -> sticks -> pickaxe). A craft whose chain
 * is fully producible is STARTABLE: the candidate layer plans the intermediate
 * craft steps itself, so the Option layer must not order a prerequisite for it.
 * Deliberately mirrors `crafting.ts#planNextCraftStep`'s recursion so the two
 * layers agree on what "craftable now" means.
 */
function craftVariantProducible(recipe: RecipeView, inventory: Readonly<Record<string, number>>): boolean {
  const needProducible = (need: CraftIngredientNeed, depth: number, stack: ReadonlySet<string>): boolean => {
    if (needCount(need, inventory) >= need.count) return true
    if (depth >= MAX_DEPENDENCY_DEPTH) return false
    if (need.cls !== null) return false
    if (stack.has(need.item)) return false
    const variants = recipesFor(need.item)
    if (variants.length === 0) return false
    const next = new Set(stack)
    next.add(need.item)
    return variants.some((variant) =>
      craftIngredientNeeds(variant.ingredients).every((ingredient) => needProducible(ingredient, depth + 1, next)),
    )
  }
  return craftIngredientNeeds(recipe.ingredients).every((need) => needProducible(need, 0, new Set<string>()))
}

/**
 * Deterministic variant choice for a craft goal (#craft-ingredient-prereq).
 * `recipesFor` returns every substitute recipe (12 plank types for a wooden
 * pickaxe), so no single intersection predicate can name the missing material.
 * Ordered by: satisfied requirements, partial credit, missing units, yield,
 * fewest ingredients, signature. Live shape: 2 birch planks + 2 sticks selects
 * the birch variant and reports the single missing `birch_planks`.
 */
export function selectCraftIngredients<T extends { ingredients: readonly RecipeIngredient[]; signature: string; resultCount: number }>(
  variants: readonly T[],
  inventory: Readonly<Record<string, number>>,
): { variant: T; needs: CraftIngredientNeed[]; missing: CraftIngredientNeed[] } | null {
  interface Scored {
    variant: T
    needs: CraftIngredientNeed[]
    missing: CraftIngredientNeed[]
    satisfied: number
    units: number
    missingUnits: number
  }
  const scored: Scored[] = []
  for (const variant of variants) {
    const needs = craftIngredientNeeds(variant.ingredients)
    let satisfied = 0
    let units = 0
    let missingUnits = 0
    const missing: CraftIngredientNeed[] = []
    for (const need of needs) {
      const have = needCount(need, inventory)
      if (have >= need.count) satisfied += 1
      else missing.push(need)
      units += Math.min(have, need.count)
      missingUnits += Math.max(0, need.count - have)
    }
    scored.push({ variant, needs, missing, satisfied, units, missingUnits })
  }
  scored.sort((a, b) => {
    if (a.satisfied !== b.satisfied) return b.satisfied - a.satisfied
    if (a.units !== b.units) return b.units - a.units
    if (a.missingUnits !== b.missingUnits) return a.missingUnits - b.missingUnits
    if (a.variant.resultCount !== b.variant.resultCount) return b.variant.resultCount - a.variant.resultCount
    if (a.needs.length !== b.needs.length) return a.needs.length - b.needs.length
    return a.variant.signature.localeCompare(b.variant.signature)
  })
  const best = scored[0]
  return best === undefined ? null : { variant: best.variant, needs: best.needs, missing: best.missing }
}

function needPredicate(need: CraftIngredientNeed): Predicate {
  return need.cls === null
    ? { kind: 'inventoryAtLeast', item: need.item, count: need.count }
    : { kind: 'inventoryClassAtLeast', cls: need.cls, count: need.count }
}

/**
 * Craft initiation predicates derived from the item's minecraft-data recipe
 * variants (#54 + #craft-ingredient-prereq).
 *
 * With a snapshot: a craft whose ingredient chain is recursively producible from
 * the live inventory is startable ([]) - the candidate layer owns the multi-step
 * plan. Otherwise the deterministic best variant's requirements become
 * preconditions, so `completeStartablePrerequisites` orders a producer for the
 * MISSING material (`wooden_pickaxe` with 2 planks -> collect log) instead of
 * the goal starving to WAIT with an empty precondition set.
 *
 * Without a snapshot (persistence / legacy compile): the necessary-condition
 * intersection over all variants, exactly as before.
 */
function craftPreconditions(item: string, inventory?: Readonly<Record<string, number>>): Predicate[] {
  const variants = recipesFor(item)
  if (variants.length === 0) return []
  if (inventory !== undefined) {
    if (variants.some((variant) => craftVariantProducible(variant, inventory))) return []
    const selection = selectCraftIngredients(variants, inventory)
    if (selection !== null) return selection.needs.map(needPredicate)
  }
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

/**
 * Smelting initiation predicates, derived from game data instead of a hand
 * table (#smelt-input-prereq). A smelt consumes BOTH its input and a fuel unit:
 *
 *   charcoal   <- `smeltInputFor('charcoal')` is the class `log` (any `*_log`)
 *   iron_ingot <- `smeltInputFor('iron_ingot')` is `raw_iron`
 *   glass      <- `smeltInputFor('glass')` is `sand`
 *
 * The input becomes a semantic-class predicate when gameData resolves it to a
 * class, so any log satisfies a charcoal smelt; otherwise it is a concrete-item
 * predicate with the smelt count. Fuel is symmetric but capacity-aware: the
 * predicate demands the fuel units `fuelCountFor(count, heldFuel)` requires for
 * the whole batch (one charcoal covers 8 smelts, one log only 1.5), so a
 * three-item iron smelt with a single log is not startable. These are the
 * predicates `completeStartablePrerequisites` turns into the producer goal
 * (`collect 1 x <log>`) ordered in front of the smelt.
 */
function smeltPreconditions(
  item: string,
  count: number,
  inventory?: Readonly<Record<string, number>>,
): Predicate[] {
  const preconditions: Predicate[] = [{ kind: 'stationKnown', station: 'furnace' }]
  const input = smeltInputFor(item)
  if (input !== null) {
    preconditions.push(
      isResourceClass(input)
        ? { kind: 'inventoryClassAtLeast', cls: input, count }
        : { kind: 'inventoryAtLeast', item: input, count },
    )
  }
  // The fuel predicate demands enough fuel UNITS for the whole smelt count, not
  // merely one item: one charcoal/coal smelts 8, but one log only 1.5, so
  // `smelt 3 x iron_ingot` with one log is not startable until a second log (or a
  // denser fuel) is held. `fuelCountFor` derives the units from the held fuel's
  // burn ticks. Without an inventory snapshot the predicate falls back to the
  // historical one-unit demand.
  const heldFuel = inventory === undefined ? null : findInventoryFuel(inventory)
  const fuelUnits = heldFuel === null ? 1 : fuelCountFor(count, heldFuel.item)
  preconditions.push({ kind: 'inventoryClassAtLeast', cls: 'fuel', count: fuelUnits })
  return preconditions
}

/**
 * Initiation predicates derived from deterministic ladder policy (#12) plus
 * minecraft-data mechanics (#54): harvest tiers from `blocks[].harvestTools`,
 * ingredient counts from `recipes`. Strategic rules minecraft-data cannot
 * express (e.g. "stone_pickaxe needs some pickaxe") stay explicit.
 */
function preconditionsForGoal(goal: PlannedGoal, snapshot?: OptionWorldSnapshot): Predicate[] {
  const item = goal.targetItem ?? null
  if (item === null) return []
  const count = goalCount(goal)
  switch (goal.kind) {
    case 'collect': {
      const rank = pickaxeRankForCollectItem(item)
      return rank === null ? [] : [{ kind: 'pickaxeRankAtLeast', rank }]
    }
    case 'craft': {
      const preconditions = craftPreconditions(item, snapshot?.inventory)
      // A stone pickaxe is craftable from 3 stone + 2 sticks. The "some pickaxe"
      // strategic rule is only needed to MINE that stone, and it is already
      // implied by the `collect cobblestone` dependency (that collect goal's own
      // harvest tier is rank 1). Requiring it unconditionally made
      // `craft 1 x stone_pickaxe` unstartable on a bot that already held
      // cobblestone, so the blocked ore goal stayed the queue head and spun
      // (prereq-order blocker: `collect raw_iron` behind a craftable pickaxe).
      return preconditions
    }
    case 'smelt':
      return smeltPreconditions(item, count, snapshot?.inventory)
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
      // A dimension transfer (`enter:nether_portal`) is complete when the bot's
      // own dimension is the target - a typed `dimensionIs` predicate, never the
      // non-item `station:nether_portal` custom token.
      if (goal.targetPredicate === 'portal_entered' && typeof goal.dimension === 'string' && goal.dimension.length > 0) {
        return [{ kind: 'dimensionIs', dimension: goal.dimension }]
      }
      if (item === 'furnace') return [{ kind: 'stationKnown', station: 'furnace' }]
      if (item === 'crafting_table') return [{ kind: 'stationKnown', station: 'crafting_table' }]
      return [{ kind: 'custom', id: `station:${item ?? 'unknown'}` }]
    case 'descend':
      return typeof goal.targetY === 'number' && Number.isFinite(goal.targetY)
        ? [{ kind: 'levelAtMost', y: goal.targetY }]
        : [{ kind: 'custom', id: `descend:${item ?? 'unknown'}` }]
    case 'surface': {
      // #136: this recovery goal is not complete at Y alone. The planner's
      // explicit log target is a second deterministic success predicate, so a
      // remembered underground coordinate cannot be reported as "surface".
      const vertical =
        typeof goal.targetY === 'number' && Number.isFinite(goal.targetY)
          ? ({ kind: 'levelAtLeast', y: goal.targetY } as const)
          : ({ kind: 'custom', id: `surface_y:${item ?? 'unknown'}` } as const)
      const resource = item === null ? [] : ([{ kind: 'inventoryAtLeast', item, count }] as const)
      return [vertical, ...resource]
    }
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

/**
 * Compile one planned goal into an OptionSpec. Pure and total. When `snapshot`
 * is given, craft ingredient preconditions are derived against the live
 * inventory (#craft-ingredient-prereq); without it the compile stays
 * snapshot-free (persistence, identity, legacy rows).
 */
export function compilePlannedGoal(goal: PlannedGoal, snapshot?: OptionWorldSnapshot): OptionSpec {
  const kind = optionKindForGoal(goal.kind)
  const target: OptionTarget = { count: goalCount(goal) }
  if (typeof goal.targetItem === 'string' && goal.targetItem.length > 0) target.item = goal.targetItem
  if (typeof goal.targetY === 'number' && Number.isFinite(goal.targetY)) target.targetY = goal.targetY
  if (typeof goal.dimension === 'string' && goal.dimension.length > 0) target.dimension = goal.dimension
  if (typeof goal.targetPredicate === 'string' && goal.targetPredicate.length > 0) target.predicate = goal.targetPredicate
  const compiled: OptionSpec = {
    id: stableOptionId(goal),
    intent: goal.description,
    kind,
    ...(goal.strategy === undefined ? {} : { strategy: goal.strategy }),
    target,
    preconditions: preconditionsForGoal(goal, snapshot),
    success: successForGoal(goal),
    skills: goal.strategy === undefined ? [...SKILLS_BY_KIND[kind]] : [...SKILLS_BY_STRATEGY[goal.strategy]],
    abortThreshold: DEFAULT_ABORT_THRESHOLD,
    ...(goal.protected === true ? { protected: true } : {}),
    ...(goal.core === true ? { core: true } : {}),
  }
  // A System2 semantic Option may be executed by a lower-level queue kind
  // (for example `goto:raw_iron` is mechanically compiled to retrieval). Keep
  // its canonical id/intent/skill envelope while refreshing code-owned
  // preconditions and success predicates against the current snapshot. This
  // prevents the executor-facing kind from destroying the selected WHAT.
  const semanticOptionInstanceId =
    goal.semanticOptionInstanceId ?? goal.optionSpec?.semanticOptionInstanceId ?? goal.optionInstanceId ?? stableOptionInstanceId(compiled)
  const semanticOptionTemplateId =
    goal.semanticOptionTemplateId ?? goal.optionSpec?.semanticOptionTemplateId ?? goal.optionTemplateId ?? compiled.id
  const semanticOptionIntent =
    goal.semanticOptionIntent ?? goal.optionSpec?.semanticOptionIntent ?? goal.description
  if (goal.optionSpec !== undefined) {
    return {
      ...goal.optionSpec,
      target: { ...goal.optionSpec.target, ...compiled.target },
      preconditions: compiled.preconditions,
      success: compiled.success,
      skills: [...goal.optionSpec.skills],
      semanticOptionInstanceId,
      semanticOptionTemplateId,
      semanticOptionIntent,
    }
  }
  return { ...compiled, semanticOptionInstanceId, semanticOptionTemplateId, semanticOptionIntent }
}

export function compilePlannedGoals(goals: readonly PlannedGoal[], snapshot?: OptionWorldSnapshot): OptionSpec[] {
  return goals.map((goal) => compilePlannedGoal(goal, snapshot))
}

export function queuedToPlanned(goal: QueuedGoal): PlannedGoal {
  const planned: PlannedGoal = {
    kind: goal.kind,
    description: goal.description,
    targetItem: goal.targetItem,
    requiredCount: goal.requiredCount,
    ...(goal.strategy === undefined ? {} : { strategy: goal.strategy }),
    ...(goal.protected === true ? { protected: true } : {}),
    ...(goal.core === true ? { core: true } : {}),
    ...(goal.targetPredicate === undefined ? {} : { targetPredicate: goal.targetPredicate }),
    ...(goal.optionInstanceId === undefined ? {} : { optionInstanceId: goal.optionInstanceId }),
    ...(goal.optionTemplateId === undefined ? {} : { optionTemplateId: goal.optionTemplateId }),
    ...(goal.optionSpec === undefined ? {} : { optionSpec: goal.optionSpec }),
    ...(goal.semanticOptionInstanceId === undefined ? {} : { semanticOptionInstanceId: goal.semanticOptionInstanceId }),
    ...(goal.semanticOptionTemplateId === undefined ? {} : { semanticOptionTemplateId: goal.semanticOptionTemplateId }),
    ...(goal.semanticOptionIntent === undefined ? {} : { semanticOptionIntent: goal.semanticOptionIntent }),
    ...(goal.placementCells === undefined ? {} : { placementCells: [...goal.placementCells] }),
  }
  if (typeof goal.targetY === 'number' && Number.isFinite(goal.targetY)) planned.targetY = goal.targetY
  if (typeof goal.dimension === 'string' && goal.dimension.length > 0) planned.dimension = goal.dimension
  return planned
}

/** Return the exact persisted spec, or deterministically compile a legacy row. */
export function optionSpecForQueuedGoal(goal: QueuedGoal): OptionSpec {
  return goal.optionSpec ?? compilePlannedGoal(queuedToPlanned(goal))
}

/** Reconstruct the CurrentOptionContext for the exact runtime queue instance. */
export function currentOptionContextForQueuedGoal(
  goal: QueuedGoal | null | undefined,
  runtime: Partial<OptionRuntimeState> = {},
): CurrentOptionContext | null {
  if (goal === null || goal === undefined || typeof goal.optionInstanceId !== 'string' || goal.optionInstanceId.length === 0) return null
  const spec = optionSpecForQueuedGoal(goal)
  const semanticInstanceId =
    goal.semanticOptionInstanceId ?? spec.semanticOptionInstanceId ?? goal.optionInstanceId
  const semanticTemplateId =
    goal.semanticOptionTemplateId ?? spec.semanticOptionTemplateId ?? goal.optionTemplateId ?? spec.id
  return {
    instanceId: goal.id,
    templateId: semanticTemplateId ?? goal.optionTemplateId ?? spec.id,
    ...(semanticInstanceId === undefined ? {} : { semanticInstanceId }),
    ...(semanticTemplateId === undefined ? {} : { semanticTemplateId }),
    ...(goal.semanticOptionIntent === undefined && spec.semanticOptionIntent === undefined
      ? {}
      : { semanticIntent: goal.semanticOptionIntent ?? spec.semanticOptionIntent }),
    kind: spec.kind,
    target: { ...spec.target },
    preconditions: [...spec.preconditions],
    success: [...spec.success],
    allowedSkills: optionSkillEnvelope(spec.skills),
    abortThreshold: spec.abortThreshold,
    runtime: {
      startedAt: runtime.startedAt ?? goal.createdAt,
      verifiedProgress: runtime.verifiedProgress ?? goal.haveCount,
      failures: runtime.failures ?? 0,
      lastProgressAt: runtime.lastProgressAt ?? goal.updatedAt,
    },
  }
}

/** Compile the current goal plus every pending goal, in queue order. */
export function compileGoalQueue(state: GoalQueueState): OptionSpec[] {
  const specs: OptionSpec[] = []
  if (state.current !== null) specs.push(optionSpecForQueuedGoal(state.current))
  for (const goal of state.goals) {
    if (goal.status === 'pending') specs.push(optionSpecForQueuedGoal(goal))
  }
  return specs
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
  /** prerequisite goals inserted in front of a blocked consumer (see #prereq-order) */
  inserted: InsertedPrerequisite[]
  /** ready goals that were moved ahead of a blocked goal (for PLAN_ORDER) */
  moves: Array<{ preferred: string; over: string }>
  /** prerequisite chains that hit the depth bound instead of resolving */
  unresolved: string[]
}

/** One prerequisite goal inserted immediately before the blocked goal it unblocks. */
export interface InsertedPrerequisite {
  prerequisite: PlannedGoal
  consumer: PlannedGoal
}

export interface PrerequisiteCompletion {
  /** input goals in order, each preceded by the startable prerequisites unblocking it */
  goals: PlannedGoal[]
  inserted: InsertedPrerequisite[]
  /** prerequisite chains that hit the depth bound instead of resolving */
  unresolved: string[]
}

/**
 * Deterministic dependency ordering (#prereq-order): for every goal with an unmet
 * precondition, insert the first STARTABLE prerequisite in its producer chain
 * immediately before it. The chain is walked recursively: when the direct
 * producer is itself blocked (`craft planks` without a log), its own producer is
 * resolved first, bounded by MAX_DEPENDENCY_DEPTH. #craft-ingredient-prereq: this
 * is what turns a craft goal's missing ingredient into an ordered collect step
 * (`craft:wooden_pickaxe` with 2 planks -> `collect 1 x log`) instead of an
 * unstartable craft. Pure and order-preserving; identity is the #52 instance id,
 * so a prerequisite already queued ahead of its consumer is never duplicated.
 */
export function completeStartablePrerequisites(
  goals: readonly PlannedGoal[],
  snapshot: OptionWorldSnapshot,
  custom?: CustomPredicateRegistry,
): PrerequisiteCompletion {
  const out: PlannedGoal[] = []
  const inserted: InsertedPrerequisite[] = []
  const unresolved: string[] = []
  const present = new Set<string>()
  const visiting = new Set<string>()
  // A producer already planned (even behind its consumer) is never duplicated:
  // the readiness partition moves the startable instance ahead instead.
  for (const goal of goals) present.add(stableOptionInstanceId(compilePlannedGoal(goal, snapshot)))

  const producerForPredicate = (
    predicate: Predicate,
    spec: OptionSpec,
    depth: number,
  ): PlannedGoal | null => {
    const dependency = dependencyGoalForPredicate(predicate, spec, snapshot)
    if (dependency === null) return null
    const dependencySpec = compilePlannedGoal(dependency, snapshot)
    if (dependencySpec.id === spec.id) return null
    if (isOptionStartable(dependencySpec, snapshot, custom)) return dependency
    if (depth >= MAX_DEPENDENCY_DEPTH) {
      unresolved.push(`${dependencySpec.id}: max dependency depth ${MAX_DEPENDENCY_DEPTH} exceeded`)
      return null
    }
    const instanceId = stableOptionInstanceId(dependencySpec)
    if (visiting.has(instanceId)) return null
    visiting.add(instanceId)
    try {
      return producerForGoal(dependency, dependencySpec, depth + 1)
    } finally {
      visiting.delete(instanceId)
    }
  }

  const producerForGoal = (goal: PlannedGoal, spec: OptionSpec, depth: number): PlannedGoal | null => {
    const { unmet } = evaluatePredicates(spec.preconditions, snapshot, custom)
    for (const predicate of unmet) {
      const producer = producerForPredicate(predicate, spec, depth)
      if (producer !== null) return producer
    }
    return null
  }

  for (const goal of goals) {
    const spec = compilePlannedGoal(goal, snapshot)
    if (!isOptionStartable(spec, snapshot, custom)) {
      const producer = producerForGoal(goal, spec, 0)
      if (producer !== null) {
        const producerSpec = compilePlannedGoal(producer, snapshot)
        const instanceId = stableOptionInstanceId(producerSpec)
        if (!present.has(instanceId)) {
          const prerequisite: PlannedGoal = producer.ready === true ? producer : { ...producer, ready: true }
          out.push(prerequisite)
          inserted.push({ prerequisite, consumer: goal })
          present.add(instanceId)
        }
      }
    }
    out.push(goal)
    present.add(stableOptionInstanceId(spec))
  }
  return { goals: out, inserted, unresolved }
}

/**
 * Issue #46 requirement 1: stable readiness partition. Ready goals move ahead of
 * goals with an unmet precondition. Safe because the preconditions encode the
 * dependency chain, so a producer is never blocked while its consumer is ready.
 * Ready goals are returned carrying `ready: true` so the GoalQueue merge keeps
 * the proven ordering when it re-inserts protected goals.
 *
 * A plan containing `core` goals is an already ordered milestone sequence owned
 * by the System2/compiler boundary. Readiness is still evaluated and attached
 * to each goal, but a ready unrelated milestone must not cross a blocked core
 * milestone. Without this guard, a ready future portal prerequisite (for
 * example flint) can leapfrog the M2 stone/iron chain and starve the frontier.
 * Non-core plans retain the original #46 partition semantics.
 *
 * #prereq-order: before partitioning, any missing DIRECT prerequisite that is
 * startable now is inserted in front of its blocked consumer, so a goal whose
 * precondition is unmet never stays the executing head while its satisfiable
 * prerequisite is absent from the plan.
 */
export function orderGoalsByReadiness(
  goals: readonly PlannedGoal[],
  snapshot: OptionWorldSnapshot,
  custom?: CustomPredicateRegistry,
): ReadinessOrderResult {
  const completed = completeStartablePrerequisites(goals, snapshot, custom)
  const ready: PlannedGoal[] = []
  const blocked: PlannedGoal[] = []
  const isReady: boolean[] = []
  const preserveCoreOrder = completed.goals.some((goal) => goal.core === true)
  for (const goal of completed.goals) {
    const startable = isOptionStartable(compilePlannedGoal(goal, snapshot), snapshot, custom)
    isReady.push(startable)
    if (startable) ready.push(goal.ready === true ? goal : { ...goal, ready: true })
    else blocked.push(goal)
  }
  const moves: Array<{ preferred: string; over: string }> = []
  if (!preserveCoreOrder) {
    for (let j = 0; j < completed.goals.length; j += 1) {
      if (isReady[j] === true) continue
      const overGoal = completed.goals[j]
      if (overGoal === undefined) continue
      for (let i = j + 1; i < completed.goals.length; i += 1) {
        const candidate = completed.goals[i]
        if (candidate === undefined || isReady[i] !== true) continue
        moves.push({ preferred: goalReadinessLabel(candidate), over: overGoal.description })
      }
    }
  }
  const orderedGoals = preserveCoreOrder
    ? completed.goals.map((goal, index) => (isReady[index] === true && goal.ready !== true ? { ...goal, ready: true } : goal))
    : [...ready, ...blocked]
  return { goals: orderedGoals, ready, blocked, inserted: completed.inserted, moves, unresolved: completed.unresolved }
}

/** OptionSpec -> PlannedGoal, so compiled Options seed the existing GoalQueue. */
export function optionSpecToPlannedGoal(spec: OptionSpec): PlannedGoal {
  const goal: PlannedGoal = {
    kind: goalKindForOption(spec.kind),
    ...(spec.strategy === undefined ? {} : { strategy: spec.strategy }),
    description: spec.intent,
    requiredCount: spec.target.count ?? 1,
  }
  if (typeof spec.target.item === 'string' && spec.target.item.length > 0) goal.targetItem = spec.target.item
  if (typeof spec.target.targetY === 'number' && Number.isFinite(spec.target.targetY)) goal.targetY = spec.target.targetY
  if (typeof spec.target.dimension === 'string' && spec.target.dimension.length > 0) goal.dimension = spec.target.dimension
  if (typeof spec.target.predicate === 'string' && spec.target.predicate.length > 0) goal.targetPredicate = spec.target.predicate
  if (spec.protected === true) goal.protected = true
  if (spec.core === true) goal.core = true
  goal.optionInstanceId = stableOptionInstanceId(spec)
  goal.optionTemplateId = spec.id
  if (typeof spec.semanticOptionInstanceId === 'string' && spec.semanticOptionInstanceId.length > 0) {
    goal.semanticOptionInstanceId = spec.semanticOptionInstanceId
  }
  if (typeof spec.semanticOptionTemplateId === 'string' && spec.semanticOptionTemplateId.length > 0) {
    goal.semanticOptionTemplateId = spec.semanticOptionTemplateId
  }
  if (typeof spec.semanticOptionIntent === 'string' && spec.semanticOptionIntent.length > 0) {
    goal.semanticOptionIntent = spec.semanticOptionIntent
  }
  goal.optionSpec = {
    ...spec,
    target: { ...spec.target },
    preconditions: [...spec.preconditions],
    success: [...spec.success],
    skills: [...spec.skills],
  }
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

const CLASS_DEPENDENCY_ITEM: Readonly<Record<ResourceClass, string | null>> = {
  log: 'log',
  planks: 'planks',
  stone: 'cobblestone',
  fuel: 'log',
  food: 'food',
  pickaxe: 'wooden_pickaxe',
}

/** Concrete collect anchor for a semantic class (`stone` -> `cobblestone`). */
export function collectItemForClass(cls: ResourceClass): string | null {
  return CLASS_DEPENDENCY_ITEM[cls]
}

/**
 * A decomposition recipe turns a denser block back into the item
 * (`raw_iron_block` -> `raw_iron`). It does not make the item craftable, so
 * `raw_iron`/`diamond`/`coal` stay collect goals instead of demanding a block
 * the bot can only hold after collecting 9 of the item.
 */
function isDecompositionRecipe(variant: RecipeView, item: string): boolean {
  return variant.ingredients.some((ingredient) =>
    recipesFor(ingredient.item).some((upstream) =>
      upstream.ingredients.some((source) => source.item === item),
    ),
  )
}

function hasCraftingProducer(item: string): boolean {
  return recipesFor(item).some((variant) => !isDecompositionRecipe(variant, item))
}

/**
 * Which goal produces an item: smelt > craft > collect (the safe default).
 * The craft decision is RECIPE-DRIVEN (#craft-ingredient-prereq): any item with
 * a real crafting recipe is a craft goal, so planks and every other ingredient
 * gets its producer without a hand-maintained list. Raw world resources keep the
 * collect default, and a `*_log` normalizes to the `log` class so one collect
 * goal is satisfied by any obtainable log.
 */
export function dependencyGoalForItem(item: string, count: number): PlannedGoal {
  const n = Math.max(1, count)
  if (SMELT_ITEMS.has(item)) return { kind: 'smelt', description: `smelt ${n} x ${item}`, targetItem: item, requiredCount: n }
  if (hasCraftingProducer(item)) return { kind: 'craft', description: `craft ${n} x ${item}`, targetItem: item, requiredCount: n }
  if (matchesResourceClass(item, 'log')) return { kind: 'collect', description: `collect ${n} x log`, targetItem: 'log', requiredCount: n }
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
    case 'levelAtLeast':
      return null
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
  const semanticOwner = {
    semanticOptionInstanceId: spec.semanticOptionInstanceId ?? stableOptionInstanceId(spec),
    semanticOptionTemplateId: spec.semanticOptionTemplateId ?? spec.id,
    semanticOptionIntent: spec.semanticOptionIntent ?? spec.intent,
  }
  const withSemanticOwner = (candidate: OptionSpec): OptionSpec => ({ ...candidate, ...semanticOwner })

  const recordBlock = (option: string, blockedBy: string, reason: string): void => {
    if (blockedOptions.some((entry) => entry.option === option && entry.blockedBy === blockedBy && entry.reason === reason)) return
    blockedOptions.push({ option, blockedBy, reason })
  }

  const walk = (current: OptionSpec, depth: number, blockedByAncestor: string | null): void => {
    const instanceId = stableOptionInstanceId(current)
    if (seen.has(instanceId)) return
    if (blockedByAncestor !== null) {
      // #50: a blocked ancestor poisons its whole dependency subtree. Surface the
      // descendant as a pruned dependency-expansion request; never enqueue it.
      seen.add(instanceId)
      recordBlock(current.id, blockedByAncestor, `ancestor ${blockedByAncestor} blocked`)
      return
    }
    if (depth > maxDepth) {
      blocked.push(`${current.id}: max dependency depth ${maxDepth} exceeded`)
      recordBlock(current.id, current.id, `max dependency depth ${maxDepth} exceeded`)
      return
    }
    if (visiting.has(instanceId)) {
      blocked.push(`${current.id}: dependency cycle`)
      recordBlock(current.id, current.id, 'dependency cycle')
      return
    }
    visiting.add(instanceId)
    const { unmet } = evaluatePredicates(current.preconditions, snapshot, custom)
    const dependencies: OptionSpec[] = []
    const blockedReasons: string[] = []
    for (const predicate of unmet) {
      const dependency = dependencyGoalForPredicate(predicate, current, snapshot)
      if (dependency === null) {
        blockedReasons.push(describePredicate(predicate))
        continue
      }
      const dependencySpec = withSemanticOwner(compilePlannedGoal(dependency, snapshot))
      if (dependencySpec.id === current.id) continue
      dependencies.push(dependencySpec)
    }
    if (blockedReasons.length > 0) {
      // #50: I(o) is false and cannot be produced deterministically. The Option is
      // not startable, so neither it nor its dependencies may be handed to the
      // execution queue. Record the block and prune the subtree.
      visiting.delete(instanceId)
      seen.add(instanceId)
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
    visiting.delete(instanceId)
    if (!seen.has(instanceId)) {
      seen.add(instanceId)
      if (current.id !== spec.id) added.push(current.id)
      ordered.push(current)
    }
  }

  walk(withSemanticOwner(spec), 0, null)
  return { specs: ordered, expanded: added.length > 0 || blocked.length > 0, added, blocked, blockedOptions }
}

// ---------------------------------------------------------------------------
// flag-gated compile entry points
// ---------------------------------------------------------------------------

/** Issue #52: a global dedupe collapse, surfaced instead of silently dropping. */
export interface OptionDedupeRecord {
  /** precise instance identity that collapsed */
  id: string
  /** how many compiled instances shared that identity (always >= 2) */
  instances: number
}

/** The exact host-log line shape, also used by tests. */
export function formatOptionDedupeLine(record: OptionDedupeRecord): string {
  return `OPTION_DEDUPED id=${record.id} instances=${record.instances}`
}

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
  /** identical instances that were collapsed (observability for #52) */
  deduped: OptionDedupeRecord[]
}

/**
 * Compile a planned goal list into Options with dependency expansion.
 *
 * When `enabled` is false (the default) the returned `goals` are the input goals
 * unchanged - the current behavior stays intact - while `specs` still carries the
 * compiled Options for opt-in shadow logging.
 *
 * Dedupe keys on the precise instance identity (#52), not the template id, so a
 * repeated capability with a different count/dimension/Y survives. Identical
 * instances still collapse, and every collapse is reported (`deduped` + the
 * `onDedupe` callback) so it is never a silent drop.
 */
export function applyCompiledPlan(
  planned: readonly PlannedGoal[],
  snapshot: OptionWorldSnapshot,
  options?: {
    enabled?: boolean
    custom?: CustomPredicateRegistry
    maxDepth?: number
    onDedupe?: (record: OptionDedupeRecord) => void
  },
): OptionCompileResult {
  const enabled = options?.enabled ?? resolveOptionCompilerEnabled()
  const specs: OptionSpec[] = []
  const order: string[] = []
  const counts = new Map<string, number>()
  const added: string[] = []
  const blocked: string[] = []
  const blockedOptions: BlockedOptionEntry[] = []
  const rejected: Array<{ description: string; reason: string }> = []
  const deduped: OptionDedupeRecord[] = []

  for (const goal of planned) {
    const spec = compilePlannedGoal(goal, snapshot)
    const errors = validateOptionSpec(spec)
    if (errors.length > 0) {
      rejected.push({ description: goal.description, reason: errors.join('; ') })
      continue
    }
    const expansion = expandOptionDependencies(spec, snapshot, { custom: options?.custom, maxDepth: options?.maxDepth })
    for (const expanded of expansion.specs) {
      const instanceId = stableOptionInstanceId(expanded)
      const previous = counts.get(instanceId)
      if (previous !== undefined) {
        counts.set(instanceId, previous + 1)
        continue
      }
      counts.set(instanceId, 1)
      order.push(instanceId)
      specs.push(expanded)
    }
    for (const id of expansion.added) if (!added.includes(id)) added.push(id)
    for (const message of expansion.blocked) if (!blocked.includes(message)) blocked.push(message)
    for (const entry of expansion.blockedOptions) {
      if (blockedOptions.some((existing) => existing.option === entry.option && existing.blockedBy === entry.blockedBy && existing.reason === entry.reason)) continue
      blockedOptions.push(entry)
    }
  }

  for (const instanceId of order) {
    const instances = counts.get(instanceId) ?? 1
    if (instances < 2) continue
    const record: OptionDedupeRecord = { id: instanceId, instances }
    deduped.push(record)
    options?.onDedupe?.(record)
  }

  return {
    enabled,
    specs,
    goals: enabled ? optionSpecsToPlannedGoals(specs) : [...planned],
    added,
    blocked,
    blockedOptions,
    rejected,
    deduped,
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
