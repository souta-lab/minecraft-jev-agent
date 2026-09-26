// resourceClass.ts - semantic resource classes (P1-4).
//
// The planner must not be assumed to know world-specific item ids. It asks for a
// class ("log", "stone", ...) and the resolver maps it to the concrete items that
// exist in the world / inventory.
import { isFoodItem, isFuelItem, loadGameData, recipesFor } from './gameData.ts'

export type ResourceClass = 'log' | 'planks' | 'stone' | 'fuel' | 'food' | 'pickaxe'

export const RESOURCE_CLASSES: readonly ResourceClass[] = ['log', 'planks', 'stone', 'fuel', 'food', 'pickaxe']

const LOG_SUFFIX = '_log'
const PLANK_SUFFIX = '_planks'

const STONE_ITEMS = new Set([
  'cobblestone',
  'cobbled_deepslate',
  'stone',
  'deepslate',
  'andesite',
  'diorite',
  'granite',
  'tuff',
  'blackstone',
  'basalt',
])

// The `food` class is GAME DATA, not a list: it asks the running data version's
// own edible table (`gameData.isFoodItem` -> `foodsByName` from foods.json), the
// same way harvest/recipe truth is read. Re-listing food names here meant a
// starving body holding a genuinely edible `golden_carrot` or `rabbit_stew`
// reported `EAT_REFUSED reason=no_food` and `missing=["no_edible_held"]`.
//
// The only surviving list is the POLICY exception table in `gameData.ts`
// (`NON_SURVIVAL_EDIBLES` / `VANILLA_EDIBLE_DATA_GAPS`): the data cannot say
// "this one poisons the eater", and it wrongly calls the fish buckets edible.

const PICKAXE_SUFFIX = '_pickaxe'

const PREFERRED_SINGLE_FUELS = ['charcoal', 'coal', 'blaze_rod'] as const

export interface InventoryFuel {
  item: string
  count: number
}

/** Deterministic fuel candidates, ordered like the historical single choice. */
export function inventoryFuels(counts: Readonly<Record<string, number>>): InventoryFuel[] {
  const out: InventoryFuel[] = []
  for (const item of PREFERRED_SINGLE_FUELS) {
    const count = counts[item] ?? 0
    if (count > 0) out.push({ item, count })
  }
  const woodIds = Object.keys(counts)
    .filter((name) => {
      const count = counts[name] ?? 0
      return count > 0 && (name.endsWith(LOG_SUFFIX) || name.endsWith(PLANK_SUFFIX) || name.endsWith('_wood'))
    })
    .sort()
  for (const item of woodIds) {
    if (!out.some((fuel) => fuel.item === item)) out.push({ item, count: counts[item] ?? 0 })
  }
  return out
}

/**
 * Issue #43: the first valid furnace fuel held in the live inventory, or null.
 * Valid fuel = any log, planks/wood, coal, charcoal or blaze rod (stick is
 * excluded: it is furnace fuel but not a log substitute). Deterministic order.
 */
export function findInventoryFuel(counts: Readonly<Record<string, number>>): InventoryFuel | null {
  return inventoryFuels(counts)[0] ?? null
}

export function isResourceClass(value: string): value is ResourceClass {
  return (RESOURCE_CLASSES as readonly string[]).includes(value)
}

/** True when a concrete item id belongs to the given semantic class. */
export function matchesResourceClass(itemName: string | null | undefined, cls: ResourceClass): boolean {
  if (typeof itemName !== 'string' || itemName.length === 0) return false
  switch (cls) {
    case 'log':
      return itemName.endsWith(LOG_SUFFIX)
    case 'planks':
      return itemName.endsWith(PLANK_SUFFIX) || itemName.endsWith('_planks')
    case 'stone':
      return STONE_ITEMS.has(itemName)
    case 'food':
      // The pinned data version's `foodsByName`, minus the explicit policy
      // exceptions (`gameData.isFoodItem`). No registry is threaded here: the
      // pinned version IS the version this repo runs, and `null` means "read
      // the pinned table", not "no table".
      return isFoodItem(null, itemName)
    case 'fuel':
      return isFuelItem(itemName)
    case 'pickaxe':
      return itemName.endsWith(PICKAXE_SUFFIX)
  }
}

/** True when a concrete item satisfies a goal spec that may be a class or an item id. */
export function resourceMatches(itemName: string | null | undefined, spec: string): boolean {
  if (typeof itemName !== 'string') return false
  return isResourceClass(spec) ? matchesResourceClass(itemName, spec) : itemName === spec
}

/** The concrete items available in the world that satisfy a class, nearest-name order. */
export function resolveResourceClass(cls: ResourceClass, availableItems: readonly string[]): string[] {
  const out: string[] = []
  for (const item of availableItems) {
    if (matchesResourceClass(item, cls) && !out.includes(item)) out.push(item)
  }
  return out
}

/** The first concrete item of a class that is available, or the class name itself. */
export function resolveToAvailable(spec: string, availableItems: readonly string[]): string {
  if (!isResourceClass(spec)) return spec
  return resolveResourceClass(spec, availableItems)[0] ?? spec
}

let cachedPlanksPerLog: number | null | undefined

/**
 * Planks yielded by one unit of their raw wood source, straight from the
 * log-sourced plank recipes in minecraft-data (one log -> four planks in 1.21).
 * Data-derived: no species is named and no ratio is hard-coded. The LOWEST yield
 * across those recipes is kept so a converted count can never under-collect, and
 * null means the data carries no log-sourced plank recipe at all.
 */
export function planksPerLog(): number | null {
  if (cachedPlanksPerLog !== undefined) return cachedPlanksPerLog
  const reg = loadGameData()
  let lowest: number | null = null
  for (const name of Object.keys(reg.itemsByName ?? {})) {
    if (!matchesResourceClass(name, 'planks')) continue
    for (const variant of recipesFor(name)) {
      if (variant.ingredients.length !== 1 || variant.resultCount <= 0) continue
      const source = variant.ingredients[0]
      if (source === undefined || source.count <= 0 || !matchesResourceClass(source.item, 'log')) continue
      const perLog = variant.resultCount / source.count
      if (lowest === null || perLog < lowest) lowest = perLog
    }
  }
  cachedPlanksPerLog = lowest
  return lowest
}

/** Reset the memoized plank yield (tests only). */
export function resetPlanksPerLogCache(): void {
  cachedPlanksPerLog = undefined
}

/**
 * Log-class units needed to obtain `count` planks of ANY species. The plank class
 * has no collectable item of its own - its raw world source is the `log` class -
 * so a class requirement must be converted through the recipe's own yield before
 * it can become a collect goal. Null when the recipe data has no plank yield.
 */
export function logsForPlanks(count: number): number | null {
  const perLog = planksPerLog()
  if (perLog === null || perLog <= 0) return null
  return Math.max(1, Math.ceil(Math.max(0, count) / perLog))
}

/**
 * Units of a class's RAW SOURCE needed to obtain `count` units of the class.
 * Identity for every class that is directly collectable (`log`, `stone`, `fuel`);
 * `planks` converts through the recipe yield, so "any 4 planks" asks for one log
 * instead of four logs.
 */
export function sourceUnitsForClass(cls: ResourceClass, count: number): number {
  if (cls === 'planks') return logsForPlanks(count) ?? count
  return count
}
