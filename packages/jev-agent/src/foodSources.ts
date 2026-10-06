// foodSources.ts - the ONE grounded food-source truth for a hungry body.
//
// Jev owns WHICH action; this module answers only CAN/TRUE, from the live data
// version and the live world state:
//
//   * is an ITEM edible (the shared `food` resource class in resourceClass.ts);
//   * which BLOCK can yield such an item (the registry's own block drop table,
//     plus the vanilla drops the block table does not express);
//   * which non-edible ITEM is the ingredient of a recipe that produces one
//     (the `acquire` tier: brown_mushroom -> mushroom_stew).
//
// The three tiers are the complete route space the task needs:
//
//   EAT      held edible item                  (candidates.ts, existing)
//   forage   sensed block -> edible drop       (this module, `forage`)
//   acquire  sensed block -> recipe ingredient (this module, `acquire`)
//   cook     held ingredients -> edible recipe (candidates.ts + crafting.ts)
//   animal   sensed passive animal -> drop     (candidates.ts FOOD_ANIMALS)
//
// Measured live (run-muc0l5fp-158ak, the run-mubobiq6-12onv lineage): the body
// sat at food=0 for the whole run holding a red_mushroom, with an oak/birch
// forest around it, and the ONLY food affordance the code could offer was an
// ATTACK on a salmon it could not reach: there was no forage tier (the food
// focus scanned no blocks) and no acquire/cook tier (the recipe planner was
// never asked for an edible result). Every fact here is derived from the
// running data version, so a block or recipe this server does not have can
// never be invented as a route.
//
// No ranking, no goal choice, no "if starving then X" policy: the caller
// enumerates routes and Jev/System2 choose.
import { createRecipeIndex } from './crafting.ts'
import type { RecipeIndex } from './crafting.ts'
import { isFoodItem, resolveHarvest } from './gameData.ts'

/** The minimal registry slice the food-source truth reads. */
export interface FoodSourceRegistry {
  blocksByName?: Record<string, unknown>
  itemsByName?: Record<string, unknown>
  items?: Record<number, { name?: string } | undefined>
  recipes?: Record<string, unknown>
  foodsByName?: Record<string, unknown>
}

/** One grounded way a sensed BLOCK leads to food. */
export interface FoodSourceSpec {
  /** the item the block yields: an edible item (`forage`) or an ingredient (`acquire`) */
  item: string
  /**
   * `forage` - the drop is edible as-is.
   * `acquire` - the drop is not edible but it is an ingredient of a recipe that
   * produces an edible item, so the block is a grounded ACQUISITION step.
   */
  route: 'forage' | 'acquire'
}

/**
 * True when an item is edible, read from the running data version's own edible
 * table (`foodsByName`, foods.json) through the single `gameData.isFoodItem`
 * predicate, minus the explicit policy exceptions there. The candidate layer's
 * `pickFood`/`isFoodItem`, the planner's `food` rung and this module all read
 * that one truth, so a route can never end in an item the eat mechanic would
 * refuse and a genuinely edible item can never be reported as "no food".
 *
 * `registry` is optional and only overrides the table when the live registry
 * carries one (a different data version than the pinned `MC_DATA_VERSION`).
 */
export function isEdibleFoodItem(itemName: string | null | undefined, registry?: FoodSourceRegistry | null): boolean {
  return isFoodItem((registry ?? null) as never, itemName)
}

/**
 * Vanilla block -> food drops the minecraft-data block table does not carry.
 *
 * `resolveHarvest` reads `blocksByName[name].drops[0]`; for these blocks that
 * table is empty (berry bushes / cave vines) or names a non-food drop, so the
 * generic rule cannot see the food route at all. The facts are vanilla
 * mechanics, not server guesses, and every entry is dropped unless the running
 * data version actually has the block:
 *
 *   sweet_berry_bush        -> sweet_berries   (harvest the bush)
 *   cave_vines[_plant]      -> glow_berries    (harvest the vines)
 *   oak_leaves              -> apple           (0.5% random drop on break/decay)
 *   dark_oak_leaves         -> apple           (0.5% random drop on break/decay)
 *
 * This is the same "the block is the grounded affordance, the drop stays with
 * the existing pickup machinery" precedent as `DIRECT_BLOCK_SOURCES`'
 * `flint -> gravel`: a probabilistic drop is a real route, and Jev still owns
 * whether to take it.
 */
export const VANILLA_FOOD_BLOCK_DROPS: Readonly<Record<string, string>> = {
  sweet_berry_bush: 'sweet_berries',
  cave_vines: 'glow_berries',
  cave_vines_plant: 'glow_berries',
  oak_leaves: 'apple',
  dark_oak_leaves: 'apple',
}

const specCache = new WeakMap<object, ReadonlyMap<string, FoodSourceSpec>>()

function registryValue(registry: FoodSourceRegistry, name: string): unknown {
  const blocks = registry.blocksByName
  if (blocks === undefined || blocks === null) return undefined
  return (blocks as Record<string, unknown>)[name]
}

/**
 * The non-edible items that are an ingredient of at least one recipe producing
 * an edible item (bread <- wheat, mushroom_stew <- brown_mushroom|red_mushroom|
 * bowl, ...). Bounded to depth one on purpose: this is the ACQUISITION tier, so
 * it answers "which missing item can this sensed block supply", not "solve the
 * whole recipe graph".
 */
export function foodIngredientItems(registry: FoodSourceRegistry, index: RecipeIndex): ReadonlySet<string> {
  const out = new Set<string>()
  for (const name of Object.keys(registry.itemsByName ?? {})) {
    if (!isEdibleFoodItem(name, registry)) continue
    for (const variant of index.recipesFor(name)) {
      for (const ingredient of variant.ingredients) {
        if (!isEdibleFoodItem(ingredient.item, registry)) out.add(ingredient.item)
      }
    }
  }
  return out
}

function computeFoodSourceSpecs(registry: FoodSourceRegistry): ReadonlyMap<string, FoodSourceSpec> {
  const out = new Map<string, FoodSourceSpec>()
  const blocks = registry.blocksByName ?? {}
  let ingredients: ReadonlySet<string> = new Set<string>()
  try {
    ingredients = foodIngredientItems(registry, createRecipeIndex(registry))
  } catch {
    // A registry without a usable recipe table still yields the forage tier:
    // unknown recipe data is not evidence that a berry bush is inedible.
    ingredients = new Set<string>()
  }
  for (const blockName of Object.keys(blocks)) {
    const harvest = resolveHarvest(registry as never, blockName)
    const yieldName = harvest.yield
    if (typeof yieldName !== 'string' || yieldName.length === 0) continue
    if (isEdibleFoodItem(yieldName, registry)) out.set(blockName, { item: yieldName, route: 'forage' })
    else if (ingredients.has(yieldName)) out.set(blockName, { item: yieldName, route: 'acquire' })
  }
  // Curated vanilla truth wins over the block table, and is validated against
  // the running data version before it is ever offered.
  for (const [blockName, item] of Object.entries(VANILLA_FOOD_BLOCK_DROPS)) {
    if (registryValue(registry, blockName) === undefined) continue
    if (!isEdibleFoodItem(item, registry)) continue
    out.set(blockName, { item, route: 'forage' })
  }
  return out
}

/**
 * Every block name the running data version can turn into food, mapped to the
 * item it yields and the route kind. Cached per registry object, so a per-tick
 * sensor call does not rebuild the recipe closure.
 */
export function foodSourceSpecs(registry: FoodSourceRegistry | null | undefined): ReadonlyMap<string, FoodSourceSpec> {
  if (registry === null || registry === undefined) return new Map()
  const key = registry as object
  const cached = specCache.get(key)
  if (cached !== undefined) return cached
  const computed = computeFoodSourceSpecs(registry)
  specCache.set(key, computed)
  return computed
}

/** The block names to name-scan for a food route; sorted for determinism. */
export function foodSourceBlockNames(registry: FoodSourceRegistry | null | undefined): readonly string[] {
  return [...foodSourceSpecs(registry).keys()].sort()
}

/**
 * Typed evidence that a hungry body has no grounded route to food.
 *
 * Bounded and descriptive only: it names the missing affordance, never a
 * preferred action, and it is the fact the planner/option layer and the run log
 * need in order to see "this body is starving and the world grounds no route"
 * instead of a silent wait.
 */
export interface FoodSourceGap {
  /** current route kinds that ARE on offer (empty when the world grounds nothing) */
  offered: string[]
  /** an edible item is held (EAT is grounded - ordinary or desperation tier) */
  heldEdible: boolean
  /** a passive food animal is sensed inside the hunt range */
  sensedAnimal: boolean
  /** a hostile whose declared mob drop is edible is sensed inside the hunt range */
  sensedFoodMob: boolean
  /** a sensed block yields an edible item */
  sensedEdibleBlock: boolean
  /** a sensed block yields an ingredient of an edible recipe */
  sensedIngredientBlock: boolean
  /** held ingredients form a satisfiable recipe step to an edible item */
  cookableRecipe: boolean
  /** a non-edible item is held that a furnace turns into an edible one */
  smeltableIngredient: boolean
  /** a furnace the body can reach is sensed for the held smelt-cook ingredient (the station half) */
  sensedFurnace: boolean
  /** the body is at/below the eat gate but not yet at the starvation floor */
  hungry: boolean
  /** the body is at the code-owned starvation floor (food 0, critical health) */
  starving: boolean
  reason: 'no_source_sensed' | 'source_withheld'
  /**
   * The DECISIVE missing link on the food path, typed. One value, named in the
   * order the route chain runs (hold -> sensed source -> route to it -> station):
   * `no_route_to_sensed_source` says the world DOES show food and the offer
   * still grounded nothing, which is a different defect from
   * `no_edible_block_sensed` and must not be reported as the same thing.
   */
  missingLink: FoodSourceMissingLink
  /** what the world still affords as a next step: a grounded explore route, else escalate */
  next: 'explore' | 'escalate'
}

/**
 * The first link of the food chain that is missing for this body, typed.
 * Deliberately coarse: the per-affordance detail stays in the `missing` list, so
 * this field answers only "which link is decisive" (a source is sensed and still
 * no route -> the ROUTE link; ingredients and no station -> the STATION link).
 */
export type FoodSourceMissingLink =
  | 'no_edible_held'
  | 'no_route_to_sensed_source'
  | 'no_reachable_furnace'
  | 'no_cookable_recipe'
  | 'no_edible_source_sensed'

export const FOOD_SOURCE_NONE = 'FOOD_SOURCE_NONE'

export function formatFoodSourceGap(gap: FoodSourceGap): string {
  const missing: string[] = []
  if (!gap.heldEdible) missing.push('no_edible_held')
  if (!gap.sensedAnimal) missing.push('no_food_animal_sensed')
  if (!gap.sensedFoodMob) missing.push('no_food_mob_sensed')
  if (!gap.sensedEdibleBlock) missing.push('no_edible_block_sensed')
  if (!gap.sensedIngredientBlock) missing.push('no_ingredient_block_sensed')
  if (!gap.cookableRecipe) missing.push('no_cookable_recipe')
  const offered = gap.offered.length > 0 ? ` offered=${JSON.stringify(gap.offered)}` : ''
  const starving = gap.starving ? ' starving=true' : ''
  return `${FOOD_SOURCE_NONE} item=food reason=${gap.reason}${starving} missing=${JSON.stringify(missing)} link=${gap.missingLink} next=${gap.next}`
}
