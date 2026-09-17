// crafting.ts - PURE crafting reasoning over minecraft-data recipes.
//
// This module has no bot and no network: it is given a `RecipeIndex` (built once
// from the live `bot.registry`) plus the current inventory, and it answers the
// one question the deterministic candidate generator needs:
//
//   "given the current subgoal item and what the bot holds right now, what is the
//    SINGLE next craft/place operation that moves toward it?"
//
// It never guesses: every recipe variant it can choose must be reachable from the
// live inventory by recursively craftable intermediates (1 oak_log -> 4
// oak_planks -> ... ), so a CRAFT candidate is only ever emitted when the bot can
// actually perform it. The executor re-resolves the concrete recipe via
// `bot.recipesFor` at execution time, so this planner and Mineflayer agree on the
// same data.
import type { Vec3Json } from './state.ts'

export interface RecipeIngredient {
  item: string
  count: number
}

export interface RecipeVariant {
  resultItem: string
  resultCount: number
  /** true when the 3x3 recipe needs a placed crafting_table station */
  requiresTable: boolean
  ingredients: RecipeIngredient[]
  /** stable id for logging/tests */
  signature: string
}

export interface RecipeIndex {
  version: string
  /** item name -> numeric id, or null when the item is unknown to this version */
  itemId(name: string): number | null
  /** numeric id -> item name, or null */
  itemName(id: number): string | null
  hasItem(name: string): boolean
  /** every recipe variant that produces `itemName` */
  recipesFor(itemName: string): RecipeVariant[]
}

/** One executable step toward a craft goal. `place` is a station setup step. */
export type CraftOp =
  | { type: 'craft'; item: string; count: number; requiresTable: boolean }
  | { type: 'place'; item: string }

export interface CraftPlanResult {
  op: CraftOp | null
  reason: string
}

type RawCell = number | { id?: number; metadata?: number } | null | undefined

interface RawRecipe {
  inShape?: RawCell[][]
  ingredients?: RawCell[]
  result?: { id?: number; count?: number } | number
}

interface RegistryLike {
  version?: { minecraftVersion?: string }
  itemsByName?: Record<string, { id: number }>
  recipes?: Record<string, unknown>
}

function cellId(cell: RawCell): number | null {
  if (typeof cell === 'number') return cell >= 0 ? cell : null
  if (typeof cell === 'object' && cell !== null && typeof cell.id === 'number') {
    return cell.id >= 0 ? cell.id : null
  }
  return null
}

function resultInfo(raw: RawRecipe): { id: number; count: number } | null {
  const result = raw.result
  if (typeof result === 'number') return result >= 0 ? { id: result, count: 1 } : null
  if (typeof result === 'object' && result !== null && typeof result.id === 'number') {
    return { id: result.id, count: typeof result.count === 'number' && result.count > 0 ? result.count : 1 }
  }
  return null
}

function toVariant(raw: RawRecipe, resultName: string, nameById: ReadonlyMap<number, string>): RecipeVariant | null {
  const info = resultInfo(raw)
  if (info === null) return null
  const counts = new Map<string, number>()
  let requiresTable = false

  if (Array.isArray(raw.inShape)) {
    requiresTable = raw.inShape.length > 2 || raw.inShape.some((row) => Array.isArray(row) && row.length > 2)
    for (const row of raw.inShape) {
      if (!Array.isArray(row)) continue
      for (const cell of row) {
        const id = cellId(cell)
        if (id === null) continue
        const name = nameById.get(id)
        if (name === undefined) continue
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
    }
  } else if (Array.isArray(raw.ingredients)) {
    requiresTable = raw.ingredients.length > 4
    for (const cell of raw.ingredients) {
      const id = cellId(cell)
      if (id === null) continue
      const name = nameById.get(id)
      if (name === undefined) continue
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  } else {
    return null
  }

  const ingredients = [...counts.entries()].map(([item, count]) => ({ item, count }))
  if (ingredients.length === 0) return null
  const signature = `${resultName}x${info.count}<=${ingredients.map((entry) => `${entry.item}x${entry.count}`).join('+')}`
  return { resultItem: resultName, resultCount: info.count, requiresTable, ingredients, signature }
}

/**
 * Build the immutable recipe lookup from a prismarine-registry / minecraft-data
 * instance. Defensive: unknown shapes yield empty recipe lists, never a throw.
 */
export function createRecipeIndex(registry: unknown): RecipeIndex {
  const reg = (registry ?? {}) as RegistryLike
  const nameById = new Map<number, string>()
  const idByName = new Map<string, number>()
  for (const [name, item] of Object.entries(reg.itemsByName ?? {})) {
    if (typeof item?.id !== 'number') continue
    nameById.set(item.id, name)
    idByName.set(name, item.id)
  }

  const variantsById = new Map<number, RecipeVariant[]>()
  for (const [key, list] of Object.entries(reg.recipes ?? {})) {
    const resultId = Number(key)
    if (!Number.isFinite(resultId)) continue
    const resultName = nameById.get(resultId)
    if (resultName === undefined || !Array.isArray(list)) continue
    const variants: RecipeVariant[] = []
    for (const raw of list) {
      const variant = toVariant(raw as RawRecipe, resultName, nameById)
      if (variant !== null) variants.push(variant)
    }
    if (variants.length > 0) variantsById.set(resultId, variants)
  }

  return {
    version: reg.version?.minecraftVersion ?? 'unknown',
    itemId: (name) => idByName.get(name) ?? null,
    itemName: (id) => nameById.get(id) ?? null,
    hasItem: (name) => idByName.has(name),
    recipesFor: (name) => {
      const id = idByName.get(name)
      if (id === undefined) return []
      return variantsById.get(id) ?? []
    },
  }
}

const MAX_DEPTH = 8

export function describeCraftOp(op: CraftOp): string {
  return op.type === 'craft'
    ? `craft ${op.count}x ${op.item}${op.requiresTable ? ' at a crafting_table' : ' (inventory 2x2)'}`
    : `place ${op.item}`
}

/**
 * The single next step toward `goalItem`.
 *
 * `tableAvailable` means a placed crafting_table is in sensor range. When a
 * recipe needs a table and none is placed, the planner returns a `place` op
 * first (reusing the held crafting_table, or crafting one first) - never a craft
 * that would be mechanically rejected by Mineflayer.
 */
export function planNextCraftStep(
  index: RecipeIndex,
  goalItem: string,
  inventory: Readonly<Record<string, number>>,
  tableAvailable: boolean,
): CraftPlanResult {
  const have = (item: string, want: number): boolean => (inventory[item] ?? 0) >= want

  const canProduce = (item: string, want: number, stack: ReadonlySet<string>, depth: number): boolean => {
    if (have(item, want)) return true
    if (depth > MAX_DEPTH || stack.has(item)) return false
    const variants = index.recipesFor(item)
    if (variants.length === 0) return false
    const nextStack = new Set(stack)
    nextStack.add(item)
    return variants.some((variant) =>
      variant.ingredients.every((ingredient) => canProduce(ingredient.item, ingredient.count, nextStack, depth + 1)),
    )
  }

  const produce = (item: string, want: number, stack: ReadonlySet<string>, depth: number): CraftOp | string | null => {
    if (have(item, want)) return null
    if (depth > MAX_DEPTH || stack.has(item)) return `dependency cycle at ${item}`
    const variants = index.recipesFor(item)
    if (variants.length === 0) return `no recipe for ${item}`
    const nextStack = new Set(stack)
    nextStack.add(item)
    const chosen = variants.find((variant) =>
      variant.ingredients.every((ingredient) => canProduce(ingredient.item, ingredient.count, nextStack, 0)),
    )
    if (chosen === undefined) return `no satisfiable recipe for ${item}`

    for (const ingredient of chosen.ingredients) {
      if (have(ingredient.item, ingredient.count)) continue
      const sub = produce(ingredient.item, ingredient.count, nextStack, depth + 1)
      if (typeof sub === 'string') return sub
      if (sub !== null) return sub
    }

    if (chosen.requiresTable && !tableAvailable) {
      if (have('crafting_table', 1)) return { type: 'place', item: 'crafting_table' }
      const tableOp = produce('crafting_table', 1, nextStack, depth + 1)
      if (typeof tableOp === 'string') return tableOp
      if (tableOp !== null) return tableOp
      return { type: 'place', item: 'crafting_table' }
    }

    return { type: 'craft', item, count: chosen.resultCount, requiresTable: chosen.requiresTable }
  }

  const op = produce(goalItem, 1, new Set<string>(), 0)
  if (typeof op === 'string') return { op: null, reason: op }
  if (op === null) return { op: null, reason: `${goalItem} is already satisfied` }
  return { op, reason: describeCraftOp(op) }
}

/** Deterministic helper for the goal/progress layer. */
export function isCraftOp(op: CraftOp, itemName: string): boolean {
  return op.type === 'craft' && op.item === itemName
}

export function opTargetItem(op: CraftOp): string {
  return op.item
}

export type { Vec3Json }
