// resourceClass.ts - semantic resource classes (P1-4).
//
// The planner must not be assumed to know world-specific item ids. It asks for a
// class ("log", "stone", ...) and the resolver maps it to the concrete items that
// exist in the world / inventory.
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

const FOOD_ITEMS = new Set([
  'bread',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_chicken',
  'cooked_mutton',
  'cooked_cod',
  'cooked_salmon',
  'apple',
  'baked_potato',
  'golden_apple',
  'carrot',
  'melon_slice',
  'sweet_berries',
])

const FUEL_ITEMS = new Set(['coal', 'charcoal', 'oak_planks', 'birch_planks', 'spruce_planks', 'stick', 'lava_bucket'])

const PICKAXE_SUFFIX = '_pickaxe'

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
      return FOOD_ITEMS.has(itemName)
    case 'fuel':
      return FUEL_ITEMS.has(itemName) || itemName.endsWith(LOG_SUFFIX) || itemName.endsWith(PLANK_SUFFIX)
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
