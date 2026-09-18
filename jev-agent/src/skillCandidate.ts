// skillCandidate.ts - Issue #20: the grounded SkillCandidate contract and its
// deterministic generator.
//
// WHY
// ---
// Advisor/Mercury choose strategies such as `branch_mine`, `explore_cave` or
// `return_to_known_ore`, but the lower layer only ever saw a generic item goal
// (`collect 3 x raw_iron`). Three semantically different model decisions therefore
// collapsed into the same candidate pool (#29): the strategy label was cosmetic.
//
// This module inserts the missing compiler layer:
//
//   strategy / Option intent
//           |
//           v
//   grounded SkillCandidate  (this file, deterministic, code-checked)
//           |
//           v
//   existing primitive candidates (MINE / MOVE / DESCEND / RETRIEVE / ...)
//
// A SkillCandidate is the *executable* repertoire entry, not a free-text hint:
//
//   branch_mine              origin=<cell>:heading=E:length=6
//   staircase                from_y=57:to_y=49:dir=E
//   return_to_known_resource raw_iron:mem=iron_ore@25_49_36
//   explore_surface          oak_log:from=<cell>
//   explore_cave             frontier=<cell>
//   collect_block            raw_iron:count=3
//   craft / smelt / place_station / descend_to
//
// INVARIANTS
// ----------
//  * Pure and model-free: same input -> same skill list (ordering included). No
//    bot, no Block/Entity, no network. `preconditions` are `Predicate` DATA
//    evaluated by `evaluatePredicates` against a plain snapshot (see optionSpec).
//  * Unmet preconditions never stop generation: `expandSkillDependencies` turns
//    each unmet predicate into the prerequisite SkillCandidate and recurses, so a
//    `return_to_known_resource` with no remembered ore expands to
//    `explore_cave` instead of becoming a dead end.
//  * Jev still owns the action: a skill compiles to an existing grounded
//    candidate kind; this module never issues a bot call and adds no LLM call.
import { ORE_SOURCES } from './state.ts'
import type { Vec3Json } from './state.ts'
import { matchesResourceClass } from './resourceClass.ts'
import type { ResourceClass } from './resourceClass.ts'
import { evaluatePredicates } from './optionSpec.ts'
import type { CustomPredicateRegistry, OptionWorldSnapshot, Predicate } from './optionSpec.ts'
import { loadGameData, requiredPickaxeRank1, requiredPickaxeRankForItem1, smeltInputFor } from './gameData.ts'

/** The executable repertoire. Each kind maps to an existing grounded candidate. */
export type SkillKind =
  | 'branch_mine'
  | 'staircase'
  | 'return_to_known_resource'
  | 'explore_surface'
  | 'explore_cave'
  | 'collect_block'
  | 'craft'
  | 'smelt'
  | 'place_station'
  | 'descend_to'

export const SKILL_KINDS: readonly SkillKind[] = [
  'branch_mine',
  'staircase',
  'return_to_known_resource',
  'explore_surface',
  'explore_cave',
  'collect_block',
  'craft',
  'smelt',
  'place_station',
  'descend_to',
]

/** Where a candidate came from. Kept in the log so strategy grounding is auditable. */
export type SkillSource = 'strategy' | 'goal' | 'world-memory' | 'inventory' | 'dependency'

/** Plain-data, fully grounded target. Never a Vec3/Block prototype. */
export interface SkillTarget {
  /** concrete item id or semantic resource class */
  item?: string
  count?: number
  /** remembered block name at the target cell (e.g. "iron_ore") */
  resourceName?: string
  /** grounded world cell */
  position?: Vec3Json
  /** stable WorldMemory id, `name@x_y_z` */
  memoryId?: string
  /** predicate descend target */
  targetY?: number
  dimension?: string
  /** branch-mine origin cell */
  origin?: Vec3Json
  heading?: 'N' | 'E' | 'S' | 'W'
  length?: number
  /** deterministic frontier id for an explore skill */
  frontierId?: string
}

export interface SkillCandidate {
  /** stable id: `<kind>:<grounded parameters>` */
  id: string
  kind: SkillKind
  target?: SkillTarget
  /** I(skill): code-checked, plain-data facts. Unmet ones expand to dependencies. */
  preconditions: Predicate[]
  /** bounded parameters, no closures / class instances */
  params: Record<string, string | number | boolean>
  source: SkillSource
}

/** Durable remembered resource projection (mirrors resident KnownResourceJson). */
export interface KnownResourceLike {
  name: string
  kind: 'ore' | 'log' | 'station'
  x: number
  y: number
  z: number
  dimension?: string
  worldEpoch?: number
}

export interface SkillWorldMemory {
  knownResources?: readonly KnownResourceLike[]
  craftingTables?: readonly Vec3Json[]
  furnaces?: readonly Vec3Json[]
  discoveredOres?: readonly string[]
}

/** The current Option/goal the skill must serve (subset of PlannedGoal). */
export interface SkillGoal {
  kind: string
  targetItem?: string | null
  requiredCount?: number | null
  targetY?: number | null
  dimension?: string | null
}

/** Everything generation reads. Pure data; no bot. */
export interface SkillGenerationInput {
  /** advisor / mercury strategy id, or null for goal-only generation */
  strategy?: string | null
  goal?: SkillGoal | null
  inventory: Readonly<Record<string, number>>
  world?: SkillWorldMemory
  position?: Vec3Json | null
  dimension?: string | null
  health?: number | null
  toolRank?: number
  lastTunnel?: Vec3Json | null
  digDir?: string | null
}

export interface SkillExpansion {
  /** dependencies first (deepest first), then the skill itself */
  skills: SkillCandidate[]
  expanded: boolean
  added: string[]
  /** unmet predicates with no deterministic producer (surfaced, never fatal) */
  blocked: string[]
}

export interface SkillPlan {
  skills: SkillCandidate[]
  added: string[]
  blocked: string[]
}

/** Default bounded branch length (issue #20: prevent per-tick heading changes). */
export const BRANCH_MINE_LENGTH = 6

/** Hard cap so a malformed dependency graph cannot recurse forever. */
export const MAX_SKILL_DEPENDENCY_DEPTH = 6

/** Prefix of the custom predicate that checks a remembered resource exists. */
export const KNOWN_RESOURCE_PREDICATE = 'knownResourceFor:'

const PICKAXE_BY_RANK: Readonly<Record<number, string>> = {
  1: 'wooden_pickaxe',
  2: 'stone_pickaxe',
  3: 'iron_pickaxe',
  4: 'diamond_pickaxe',
  5: 'netherite_pickaxe',
}

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
])

const CLASS_DEPENDENCY_ITEM: Readonly<Record<ResourceClass, string>> = {
  log: 'oak_log',
  planks: 'oak_planks',
  stone: 'cobblestone',
  fuel: 'coal',
  food: 'bread',
  pickaxe: 'wooden_pickaxe',
}

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------

function cell(position: Vec3Json | null | undefined): Vec3Json | null {
  if (position === null || position === undefined) return null
  return { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
}

function cellId(position: Vec3Json): string {
  return `${position.x}_${position.y}_${position.z}`
}

function memoryId(resource: KnownResourceLike): string {
  return `${resource.name}@${resource.x}_${resource.y}_${resource.z}`
}

function resourcePosition(resource: KnownResourceLike): Vec3Json {
  return { x: resource.x, y: resource.y, z: resource.z }
}

function distance(a: Vec3Json, b: Vec3Json): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function isOreItem(item: string): boolean {
  return ORE_SOURCES[item] !== undefined
}

function oreBlockNames(item: string): readonly string[] {
  return ORE_SOURCES[item] ?? []
}

function goalCount(goal: SkillGoal | null | undefined): number {
  return Math.max(1, Math.floor(goal?.requiredCount ?? 1))
}

/** The item a goal points at, or null. */
export function goalItem(input: SkillGenerationInput): string | null {
  const item = input.goal?.targetItem
  return typeof item === 'string' && item.length > 0 ? item : null
}

/**
 * The nearest remembered resource that matches `item` (ore block names, logs, or
 * an exact name). Deterministic: ties break on the lexicographically smallest id.
 */
export function knownResourceForItem(input: SkillGenerationInput, item: string): KnownResourceLike | null {
  const known = input.world?.knownResources ?? []
  const log = item.endsWith('_log') || matchesResourceClass(item, 'log')
  const names = oreBlockNames(item)
  const self = cell(input.position)
  let best: KnownResourceLike | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  let bestId = ''
  for (const resource of known) {
    if (resource.kind !== 'ore' && resource.kind !== 'log') continue
    const matches = isOreItem(item)
      ? names.includes(resource.name)
      : item === 'log' || log
        ? resource.name.endsWith('_log')
        : resource.name === item
    if (!matches) continue
    const id = memoryId(resource)
    const d = self === null ? 0 : distance(resourcePosition(resource), self)
    if (d < bestDistance || (d === bestDistance && (best === null || id < bestId))) {
      best = resource
      bestDistance = d
      bestId = id
    }
  }
  return best
}

/** A heading toward the nearest remembered resource, else the current dig heading. */
function headingFor(input: SkillGenerationInput): 'N' | 'E' | 'S' | 'W' {
  const explicitly = input.digDir
  const known = input.world?.knownResources ?? []
  const self = cell(input.position)
  if (self !== null && known.length > 0) {
    let nearest: KnownResourceLike | null = null
    let nearestDistance = Number.POSITIVE_INFINITY
    for (const resource of known) {
      const d = distance(resourcePosition(resource), self)
      if (d < nearestDistance) {
        nearest = resource
        nearestDistance = d
      }
    }
    if (nearest !== null) {
      const dx = nearest.x - self.x
      const dz = nearest.z - self.z
      if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? 'E' : 'W'
      return dz >= 0 ? 'S' : 'N'
    }
  }
  if (explicitly === 'N' || explicitly === 'E' || explicitly === 'S' || explicitly === 'W') return explicitly
  return 'N'
}

// ---------------------------------------------------------------------------
// snapshot + precondition evaluation
// ---------------------------------------------------------------------------

export function makeSkillSnapshot(input: SkillGenerationInput): OptionWorldSnapshot {
  const stations: Array<'crafting_table' | 'furnace'> = []
  if ((input.world?.craftingTables?.length ?? 0) > 0) stations.push('crafting_table')
  if ((input.world?.furnaces?.length ?? 0) > 0) stations.push('furnace')
  return {
    inventory: input.inventory,
    dimension: input.dimension ?? null,
    position: input.position ?? null,
    health: input.health ?? null,
    toolRank: input.toolRank ?? 0,
    knownStations: stations,
    knownOres: input.world?.discoveredOres ?? [],
  }
}

/** Custom predicates used by skills: `knownResourceFor:<item>`. */
export function skillCustomRegistry(input: SkillGenerationInput): CustomPredicateRegistry {
  const known = input.world?.knownResources ?? []
  const items = new Set<string>()
  const goal = goalItem(input)
  if (goal !== null) items.add(goal)
  for (const resource of known) {
    const base = resource.name.replace(/^raw_/, '').replace(/_ore$/, '')
    items.add(base)
  }
  const registry: Record<string, (snapshot: OptionWorldSnapshot) => boolean> = {}
  for (const item of items) {
    registry[`${KNOWN_RESOURCE_PREDICATE}${item}`] = () => knownResourceForItem(input, item) !== null
  }
  return registry
}

export interface SkillPreconditionResult {
  ok: boolean
  unmet: Predicate[]
}

/** Evaluate a skill's preconditions against the grounded snapshot. Pure. */
export function evaluateSkillPreconditions(skill: SkillCandidate, input: SkillGenerationInput): SkillPreconditionResult {
  return evaluatePredicates(skill.preconditions, makeSkillSnapshot(input), skillCustomRegistry(input))
}

/** True when every precondition holds, i.e. the skill is executable right now. */
export function isSkillExecutable(skill: SkillCandidate, input: SkillGenerationInput): boolean {
  return evaluateSkillPreconditions(skill, input).ok
}

// ---------------------------------------------------------------------------
// skill factories
// ---------------------------------------------------------------------------

function skill(id: string, kind: SkillKind, source: SkillSource, params: Record<string, string | number | boolean>, preconditions: Predicate[], target?: SkillTarget): SkillCandidate {
  return target === undefined
    ? { id, kind, preconditions, params, source }
    : { id, kind, target, preconditions, params, source }
}

function toolRankAtLeast(item: string): Predicate[] {
  const reg = loadGameData()
  const rank = requiredPickaxeRank1(reg, item) ?? requiredPickaxeRankForItem1(reg, item)
  return rank === null ? [] : [{ kind: 'pickaxeRankAtLeast', rank }]
}

export function collectBlockSkill(item: string, count: number, source: SkillSource = 'goal'): SkillCandidate {
  const n = Math.max(1, count)
  const target: SkillTarget = { item, count: n }
  return skill(`collect_block:${item}:count=${n}`, 'collect_block', source, { item, count: n }, toolRankAtLeast(item), target)
}

export function craftSkill(item: string, count = 1, source: SkillSource = 'goal'): SkillCandidate {
  const n = Math.max(1, count)
  const preconditions: Predicate[] = item === 'crafting_table' ? [] : [{ kind: 'stationKnown', station: 'crafting_table' }]
  return skill(`craft:${item}:count=${n}`, 'craft', source, { item, count: n }, preconditions, { item, count: n })
}

export function smeltSkill(item: string, count = 1, source: SkillSource = 'goal'): SkillCandidate {
  const n = Math.max(1, count)
  const inputItem = smeltInputFor(item)
  const preconditions: Predicate[] = [{ kind: 'stationKnown', station: 'furnace' }]
  if (inputItem !== null) preconditions.push({ kind: 'inventoryAtLeast', item: inputItem, count: n })
  return skill(`smelt:${item}:count=${n}`, 'smelt', source, { item, count: n }, preconditions, { item, count: n })
}

export function placeStationSkill(station: 'crafting_table' | 'furnace', source: SkillSource = 'goal'): SkillCandidate {
  const preconditions: Predicate[] = [{ kind: 'inventoryAtLeast', item: station, count: 1 }]
  return skill(`place_station:${station}`, 'place_station', source, { station, count: 1 }, preconditions, { item: station, count: 1 })
}

export function descendToSkill(y: number, input: SkillGenerationInput, source: SkillSource = 'goal'): SkillCandidate {
  const fromY = input.position === null || input.position === undefined ? null : Math.floor(input.position.y)
  const id = `descend_to:Y=${y}${fromY === null ? '' : `:from=${fromY}`}`
  const target: SkillTarget = { targetY: y }
  const dimension = input.goal?.dimension
  if (typeof dimension === 'string' && dimension.length > 0) target.dimension = dimension
  const item = goalItem(input)
  const preconditions: Predicate[] = item === null ? [] : toolRankAtLeast(item)
  return skill(id, 'descend_to', source, { targetY: y, fromY: fromY ?? 0 }, preconditions, target)
}

export function staircaseSkill(y: number, input: SkillGenerationInput, source: SkillSource = 'goal'): SkillCandidate {
  const fromY = input.position === null || input.position === undefined ? 0 : Math.floor(input.position.y)
  const dir = headingFor(input)
  return skill(
    `staircase:from=${fromY}:to=${y}:dir=${dir}`,
    'staircase',
    source,
    { fromY, toY: y, dir },
    [{ kind: 'pickaxeRankAtLeast', rank: 1 }],
    { targetY: y, heading: dir },
  )
}

export function branchMineSkill(input: SkillGenerationInput, source: SkillSource = 'strategy'): SkillCandidate {
  const origin = cell(input.position)
  const heading = headingFor(input)
  const target: SkillTarget = { heading, length: BRANCH_MINE_LENGTH }
  if (origin !== null) {
    target.origin = origin
    target.position = origin
  }
  const id = `branch_mine:origin=${origin === null ? 'unknown' : cellId(origin)}:heading=${heading}:length=${BRANCH_MINE_LENGTH}`
  return skill(id, 'branch_mine', source, { heading, length: BRANCH_MINE_LENGTH, origin: origin === null ? 'unknown' : cellId(origin) }, [{ kind: 'pickaxeRankAtLeast', rank: 2 }], target)
}

export function exploreCaveSkill(input: SkillGenerationInput, source: SkillSource = 'strategy'): SkillCandidate {
  const known = input.world?.knownResources ?? []
  const anchor = known.length > 0 ? resourcePosition(known[0] as KnownResourceLike) : cell(input.position)
  const frontierId = anchor === null ? 'unknown' : cellId(anchor)
  const target: SkillTarget = { frontierId }
  if (anchor !== null) target.position = anchor
  return skill(`explore_cave:frontier=${frontierId}`, 'explore_cave', source, { frontier: frontierId }, [{ kind: 'pickaxeRankAtLeast', rank: 1 }], target)
}

export function exploreSurfaceSkill(item: string, input: SkillGenerationInput, source: SkillSource = 'goal'): SkillCandidate {
  const from = cell(input.position)
  const target: SkillTarget = { item }
  if (from !== null) target.position = from
  return skill(`explore_surface:${item}:from=${from === null ? 'unknown' : cellId(from)}`, 'explore_surface', source, { item, from: from === null ? 'unknown' : cellId(from) }, [], target)
}

export function returnToKnownResourceSkill(item: string, input: SkillGenerationInput, source: SkillSource = 'strategy'): SkillCandidate {
  const known = knownResourceForItem(input, item)
  const memId = known === null ? 'unknown' : memoryId(known)
  const target: SkillTarget = { item }
  if (known !== null) {
    target.resourceName = known.name
    target.memoryId = memId
    target.position = resourcePosition(known)
    if (known.dimension !== undefined) target.dimension = known.dimension
  }
  const preconditions: Predicate[] = [
    ...toolRankAtLeast(item),
    { kind: 'custom', id: `${KNOWN_RESOURCE_PREDICATE}${item}` },
  ]
  return skill(`return_to_known_resource:${item}:mem=${memId}`, 'return_to_known_resource', source, { item, memoryId: memId }, preconditions, target)
}

// ---------------------------------------------------------------------------
// goal -> skills
// ---------------------------------------------------------------------------

/** Skills implied by the CURRENT goal alone (no strategy). */
export function skillsForGoal(input: SkillGenerationInput): SkillCandidate[] {
  const goal = input.goal ?? null
  const item = goalItem(input)
  if (goal === null || item === null) return []
  const count = goalCount(goal)
  switch (goal.kind) {
    case 'collect':
      if (matchesResourceClass(item, 'log')) {
        const known = knownResourceForItem(input, item)
        return known === null ? [exploreSurfaceSkill(item, input)] : [returnToKnownResourceSkill(item, input, 'world-memory'), collectBlockSkill(item, count)]
      }
      return [collectBlockSkill(item, count)]
    case 'craft':
      return [craftSkill(item, count)]
    case 'smelt':
      return [smeltSkill(item, count)]
    case 'place':
      return [placeStationSkill(item === 'furnace' ? 'furnace' : 'crafting_table')]
    case 'descend': {
      const y = typeof goal.targetY === 'number' && Number.isFinite(goal.targetY) ? goal.targetY : 16
      return [descendToSkill(y, input), staircaseSkill(y, input)]
    }
    case 'explore':
      return [exploreCaveSkill(input, 'goal')]
    default:
      return []
  }
}

/**
 * Strategy -> the grounded skill the strategy actually means. This is the point
 * of issue #20: the names now compile to different, parameterised skills.
 */
export function skillCandidatesForStrategy(strategy: string, input: SkillGenerationInput): SkillCandidate[] {
  const item = goalItem(input)
  switch (strategy) {
    case 'branch_mine':
      return [branchMineSkill(input)]
    case 'explore_cave':
      return [exploreCaveSkill(input)]
    case 'return_to_known_ore':
    case 'return_to_known_resource':
      return [returnToKnownResourceSkill(item ?? 'raw_iron', input)]
    case 'descend_to_y16':
    case 'descend_to': {
      const y = typeof input.goal?.targetY === 'number' && Number.isFinite(input.goal.targetY) ? input.goal.targetY : 16
      return [descendToSkill(y, input), staircaseSkill(y, input)]
    }
    case 'smelt_and_craft':
      return skillsForGoal({ ...input, strategy: null })
    default:
      return skillsForGoal({ ...input, strategy: null })
  }
}

// ---------------------------------------------------------------------------
// dependency expansion (#12 generalization, on the skill layer)
// ---------------------------------------------------------------------------

/** The skill that would satisfy one unmet precondition, or null. */
export function dependencySkillForPredicate(predicate: Predicate, source: SkillSource = 'dependency'): SkillCandidate | null {
  switch (predicate.kind) {
    case 'inventoryAtLeast':
      return dependencySkillForItem(predicate.item, predicate.count, source)
    case 'inventoryClassAtLeast': {
      const item = CLASS_DEPENDENCY_ITEM[predicate.cls]
      return dependencySkillForItem(item, predicate.count, source)
    }
    case 'pickaxeRankAtLeast': {
      const item = PICKAXE_BY_RANK[predicate.rank]
      return item === undefined ? null : craftSkill(item, 1, source)
    }
    case 'stationKnown':
      return placeStationSkill(predicate.station, source)
    case 'oreKnown':
      return collectBlockSkill(predicate.item, 1, source)
    case 'levelAtMost':
      return { id: `descend_to:Y=${predicate.y}`, kind: 'descend_to', target: { targetY: predicate.y }, preconditions: [], params: { targetY: predicate.y }, source }
    case 'levelAtLeast':
      // Vertical recovery is a success predicate of the return-recovery
      // Option, not an independently startable skill. The body remains
      // grounded by the recovery goal's log retrieval candidate.
      return null
    case 'custom':
      if (predicate.id.startsWith(KNOWN_RESOURCE_PREDICATE)) {
        const item = predicate.id.slice(KNOWN_RESOURCE_PREDICATE.length)
        return { id: `explore_cave:frontier=unknown:for=${item}`, kind: 'explore_cave', target: { frontierId: 'unknown' }, preconditions: [], params: { frontier: 'unknown', item }, source }
      }
      return null
    case 'dimensionIs':
    case 'healthAtLeast':
      return null
  }
}

/** Which skill produces an item: smelt > craft > collect (safe default). */
export function dependencySkillForItem(item: string, count: number, source: SkillSource = 'dependency'): SkillCandidate {
  const n = Math.max(1, count)
  if (SMELT_ITEMS.has(item)) return smeltSkill(item, n, source)
  if (CRAFT_ITEMS.has(item)) return craftSkill(item, n, source)
  return collectBlockSkill(item, n, source)
}

/**
 * Expand a skill into its prerequisite chain. An unmet precondition becomes a
 * prerequisite SkillCandidate and is walked recursively; a predicate with no
 * deterministic producer is reported in `blocked` instead of aborting.
 */
export function expandSkillDependencies(
  skillCandidate: SkillCandidate,
  input: SkillGenerationInput,
  options?: { maxDepth?: number },
): SkillExpansion {
  const maxDepth = options?.maxDepth ?? MAX_SKILL_DEPENDENCY_DEPTH
  const ordered: SkillCandidate[] = []
  const seen = new Set<string>()
  const visiting = new Set<string>()
  const added: string[] = []
  const blocked: string[] = []

  const walk = (current: SkillCandidate, depth: number): void => {
    if (seen.has(current.id)) return
    if (depth > maxDepth) {
      blocked.push(`${current.id}: max dependency depth ${maxDepth} exceeded`)
      return
    }
    if (visiting.has(current.id)) {
      blocked.push(`${current.id}: dependency cycle`)
      return
    }
    visiting.add(current.id)
    const { unmet } = evaluateSkillPreconditions(current, input)
    for (const predicate of unmet) {
      const dependency = dependencySkillForPredicate(predicate, 'dependency')
      if (dependency === null) {
        blocked.push(`${current.id}: ${describePredicateSafe(predicate)}`)
        continue
      }
      if (dependency.id === current.id) continue
      walk(dependency, depth + 1)
    }
    visiting.delete(current.id)
    if (!seen.has(current.id)) {
      seen.add(current.id)
      if (current.id !== skillCandidate.id) added.push(current.id)
      ordered.push(current)
    }
  }

  walk(skillCandidate, 0)
  return { skills: ordered, expanded: added.length > 0 || blocked.length > 0, added, blocked }
}

function describePredicateSafe(predicate: Predicate): string {
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
// generation entry points
// ---------------------------------------------------------------------------

/**
 * THE generation entry point (#20 requirement 2): from the CURRENT
 * strategy/goal + world memory + inventory, deterministically produce grounded
 * skills with dependency expansion. Dependencies come first, then the primary.
 */
export function generateSkillPlan(input: SkillGenerationInput): SkillPlan {
  const primaries = input.strategy === null || input.strategy === undefined || input.strategy.length === 0
    ? skillsForGoal(input)
    : skillCandidatesForStrategy(input.strategy, input)
  const seen = new Set<string>()
  const skills: SkillCandidate[] = []
  const added: string[] = []
  const blocked: string[] = []
  for (const primary of primaries) {
    const expansion = expandSkillDependencies(primary, input)
    for (const candidate of expansion.skills) {
      if (seen.has(candidate.id)) continue
      seen.add(candidate.id)
      skills.push(candidate)
    }
    for (const id of expansion.added) if (!added.includes(id)) added.push(id)
    for (const message of expansion.blocked) if (!blocked.includes(message)) blocked.push(message)
  }
  return { skills, added, blocked }
}

/** Convenience wrapper: the skill list only. */
export function generateSkillCandidates(input: SkillGenerationInput): SkillCandidate[] {
  return generateSkillPlan(input).skills
}

/** Stable signature of a skill list, used for STRATEGY_BODY_DELTA (#29/#20). */
export function skillSignature(skills: readonly SkillCandidate[]): string {
  return skills.map((skillCandidate) => skillCandidate.id).join('|')
}

/** Exact log line for one selected skill: `SKILL_SELECTED id=... kind=... strategy=...`. */
export function formatSkillSelected(skillCandidate: SkillCandidate, strategy: string): string {
  return `SKILL_SELECTED id=${skillCandidate.id} kind=${skillCandidate.kind} strategy=${strategy}`
}

/** Exact delta log line: `STRATEGY_BODY_DELTA strategy=<s> skills=[...]`. */
export function formatStrategyBodyDelta(strategy: string, skills: readonly SkillCandidate[]): string {
  return `STRATEGY_BODY_DELTA strategy=${strategy} skills=[${skills.map((skillCandidate) => skillCandidate.id).join(',')}]`
}

export function isSkillKind(value: string): value is SkillKind {
  return (SKILL_KINDS as readonly string[]).includes(value)
}
