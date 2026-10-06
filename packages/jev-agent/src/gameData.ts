// gameData.ts - the single deterministic owner of Minecraft mechanics truth
// (#54). Before this module, `optionSpec.ts`, `skillCandidate.ts`,
// `candidates.ts`, `resourceClass.ts`, `prereqOption.ts` and `state.ts` each
// carried their own small Minecraft table, and they had already drifted:
// `collect diamond` required only a stone pickaxe (rank 2) although diamond ore
// needs iron, and `diamond_pickaxe` required 1 diamond although the recipe needs
// 3. This module is the one place those values come from.
//
// Data provenance (minecraft-data@3.116.0, the version mineflayer@4.39.0 loads
// for the live Leaf 1.21.11 server):
//   - harvest requirements: `blocks[].harvestTools` (exact tool item ids that
//     yield a drop) and `blocks[].drops` (primary drop item id), read from
//     minecraft-data/data/pc/1.21.11/{blocks,items}.json.
//   - crafting recipes: `recipes` (inShape / ingredients / result), same file.
//   - food items: `foods` / `foodsByName` (foods.json). Not used here yet.
//   - tool tier ORDER is NOT in minecraft-data: item entries carry no tier field
//     (items.json keys are id/name/displayName/stackSize plus per-tool extras
//     such as maxDurability). The five-tier order below is the irreducible game
//     rule, cited from the Minecraft wiki "Pickaxe" tier table. Copper/golden
//     pickaxes share the wooden+1 slot so the pre-existing runtime rank scale is
//     preserved exactly.
//   - furnace smelting input->output and fuel burn ticks are NOT in
//     minecraft-data@3.116.0: recipes.json contains crafting recipes only, items
//     carry no fuel field, and prismarine-recipe exports only Recipe/RecipeItem.
//     They are kept explicit below, cited from the Minecraft wiki "Furnace" /
//     "Fuel" tables, and a parity test pins them.
import { createRequire } from 'node:module'
import type { HarvestTool } from './state.ts'

/** The server is Leaf 1.21.11 (AGENTS.md section 4). */
export const MC_DATA_VERSION = '1.21.11'

/**
 * Canonical pickaxe tiers in ascending capability order (index 0 = weakest).
 * This is the one ordering used to answer "what is the weakest canonical
 * pickaxe that harvests this block". It is a game rule, not minecraft-data.
 */
export const PICKAXE_TIER_ORDER: readonly string[] = [
  'wooden_pickaxe',
  'stone_pickaxe',
  'iron_pickaxe',
  'diamond_pickaxe',
  'netherite_pickaxe',
]

/**
 * Runtime tier scale used by `WorldState.harvestTier`, `PICKAXE_RANKS`,
 * `executor.findTool` and `toolChoice`. Kept identical to the pre-#54 scale so
 * callers do not change: wooden=0, stone=2 (golden/copper occupy slot 1),
 * iron=3, diamond=4, netherite=5.
 */
export const PICKAXE_TIER0: Readonly<Record<string, number>> = {
  wooden_pickaxe: 0,
  golden_pickaxe: 1,
  copper_pickaxe: 1,
  stone_pickaxe: 2,
  iron_pickaxe: 3,
  diamond_pickaxe: 4,
  netherite_pickaxe: 5,
}

// ---------------------------------------------------------------------------
// registry shape (structurally compatible with mineflayer's `bot.registry`
// and with the minecraft-data object itself)
// ---------------------------------------------------------------------------

export interface GameDataBlock {
  name?: string
  /** registry hardness flag: false for bedrock/barrier/portals; obsidian is true */
  diggable?: boolean
  drops?: number[]
  harvestTools?: Record<string, boolean>
}

export interface GameDataRegistry {
  blocksByName?: Record<string, GameDataBlock | undefined>
  items?: Record<number, { name?: string } | undefined>
  itemsByName?: Record<string, { id?: number } | undefined>
  recipes?: Record<string, unknown>
  foodsByName?: Record<string, unknown>
}

let cachedRegistry: GameDataRegistry | null = null

/** Load and memoize the data-only minecraft-data registry for `version`. */
export function loadGameData(version: string = MC_DATA_VERSION): GameDataRegistry {
  if (cachedRegistry !== null) return cachedRegistry
  const require = createRequire(import.meta.url)
  const loader = require('minecraft-data') as (v: string) => unknown
  cachedRegistry = loader(version) as GameDataRegistry
  return cachedRegistry
}

/** Reset the memoized registry (tests only). */
export function resetGameDataCache(): void {
  cachedRegistry = null
}

function itemName(reg: GameDataRegistry, id: number): string | null {
  const name = reg.items?.[id]?.name
  return typeof name === 'string' ? name : null
}

// ---------------------------------------------------------------------------
// harvest requirements (minecraft-data `blocks[].harvestTools`)
// ---------------------------------------------------------------------------

export interface HarvestProfile {
  yield: string | null
  harvestTool: HarvestTool | null
  /** minimum runtime tier (PICKAXE_TIER0) when `harvestTool === 'pickaxe'` */
  harvestTier: number | null
}

/**
 * Resolve a block's primary drop, harvest tool family and minimum runtime
 * pickaxe tier directly from `harvestTools`. A block with no `harvestTools`
 * entry is hand-harvestable (dirt/logs still get a speed tool from
 * `toolChoice.ts`, which is policy, not a requirement).
 */
export function resolveHarvest(reg: GameDataRegistry, blockName: string): HarvestProfile {
  const info = reg.blocksByName?.[blockName]
  if (info === undefined) return { yield: null, harvestTool: null, harvestTier: null }
  const dropId = info.drops?.[0]
  const yieldName = typeof dropId === 'number' ? itemName(reg, dropId) : null
  let harvestTool: HarvestTool | null = null
  let harvestTier: number | null = null
  const tools = info.harvestTools
  if (tools !== null && typeof tools === 'object') {
    for (const toolId of Object.keys(tools)) {
      const tool = itemName(reg, Number(toolId)) ?? ''
      if (tool.endsWith('_pickaxe')) {
        harvestTool = 'pickaxe'
        const rank = PICKAXE_TIER0[tool]
        if (rank !== undefined && (harvestTier === null || rank < harvestTier)) harvestTier = rank
        continue
      }
      if (tool.endsWith('_axe')) harvestTool = harvestTool ?? 'axe'
      if (tool.endsWith('_shovel')) harvestTool = harvestTool ?? 'shovel'
    }
  }
  return { yield: yieldName ?? blockName, harvestTool, harvestTier }
}

/** True when this item name belongs to the canonical five-tier pickaxe set. */
export function isCanonicalPickaxe(toolName: string): boolean {
  return PICKAXE_TIER_ORDER.includes(toolName)
}

/**
 * The weakest canonical pickaxe that harvests `blockName`, derived from the
 * block's own `harvestTools` list. Returns null when no pickaxe is required (or
 * when the block is unknown to this data version).
 */
export function requiredPickaxeTool(reg: GameDataRegistry, blockName: string): string | null {
  const info = reg.blocksByName?.[blockName]
  if (info === undefined || info.harvestTools === undefined) return null
  let best: string | null = null
  let bestRank = Number.POSITIVE_INFINITY
  for (const toolId of Object.keys(info.harvestTools)) {
    const tool = itemName(reg, Number(toolId))
    if (tool === null || !isCanonicalPickaxe(tool)) continue
    const rank = PICKAXE_TIER_ORDER.indexOf(tool)
    if (rank < bestRank) {
      best = tool
      bestRank = rank
    }
  }
  return best
}

/** Runtime tier (PICKAXE_TIER0) required for a block, derived from data. */
export function requiredPickaxeRank0(reg: GameDataRegistry, blockName: string): number | null {
  const tool = requiredPickaxeTool(reg, blockName)
  return tool === null ? null : PICKAXE_TIER0[tool] ?? null
}

/** OptionSpec tier (1-based canonical: wooden=1 .. netherite=5). */
export function requiredPickaxeRank1(reg: GameDataRegistry, blockName: string): number | null {
  const tool = requiredPickaxeTool(reg, blockName)
  if (tool === null) return null
  const index = PICKAXE_TIER_ORDER.indexOf(tool)
  return index < 0 ? null : index + 1
}

/**
 * Every overworld/nether block whose primary drop is `itemName`, restricted to
 * `_ore` block names (the scan set used by `ORE_SOURCES`). Data-derived; used to
 * answer "what pickaxe tier does collecting this item need".
 */
export function oreBlocksForItem(reg: GameDataRegistry, itemNameWanted: string): string[] {
  const blocks = reg.blocksByName ?? {}
  const out: string[] = []
  for (const [blockName, info] of Object.entries(blocks)) {
    if (info === undefined || !blockName.endsWith('_ore')) continue
    const dropId = info.drops?.[0]
    if (typeof dropId !== 'number') continue
    if (itemName(reg, dropId) === itemNameWanted) out.push(blockName)
  }
  return out.sort()
}

/**
 * Minimum OptionSpec tier (1-based) required to collect `itemName`, derived
 * from the harvest requirements of every `_ore` block that drops it. Returns
 * null when the item is not an ore drop (the caller then keeps its own policy).
 */
export function requiredPickaxeRankForItem1(reg: GameDataRegistry, itemNameWanted: string): number | null {
  const ranks: number[] = []
  for (const blockName of oreBlocksForItem(reg, itemNameWanted)) {
    const rank = requiredPickaxeRank1(reg, blockName)
    if (rank !== null) ranks.push(rank)
  }
  if (ranks.length === 0) return null
  return Math.min(...ranks)
}

// ---------------------------------------------------------------------------
// crafting recipes (minecraft-data `recipes`)
// ---------------------------------------------------------------------------

interface RawCellLike {
  id?: number
}
interface RawRecipe {
  inShape?: Array<Array<number | RawCellLike | null | undefined>>
  ingredients?: Array<number | RawCellLike | null | undefined>
  result?: { id?: number; count?: number } | number
}

function cellId(cell: number | RawCellLike | null | undefined): number | null {
  if (typeof cell === 'number') return cell >= 0 ? cell : null
  if (typeof cell === 'object' && cell !== null && typeof cell.id === 'number') {
    return cell.id >= 0 ? cell.id : null
  }
  return null
}

export interface RecipeIngredient {
  item: string
  count: number
}

export interface RecipeView {
  resultItem: string
  resultCount: number
  requiresTable: boolean
  ingredients: RecipeIngredient[]
  signature: string
}

let cachedRecipeIndex: { version: string; byResult: Map<string, RecipeView[]> } | null = null

function buildRecipeIndex(reg: GameDataRegistry): Map<string, RecipeView[]> {
  const nameById = new Map<number, string>()
  const idByName = new Map<string, number>()
  for (const [name, item] of Object.entries(reg.itemsByName ?? {})) {
    if (item === undefined || typeof item.id !== 'number') continue
    nameById.set(item.id, name)
    idByName.set(name, item.id)
  }
  const byResult = new Map<string, RecipeView[]>()
  for (const [key, list] of Object.entries(reg.recipes ?? {})) {
    const resultId = Number(key)
    if (!Number.isFinite(resultId)) continue
    const resultName = nameById.get(resultId)
    if (resultName === undefined || !Array.isArray(list)) continue
    const views: RecipeView[] = []
    for (const rawEntry of list) {
      const raw = rawEntry as RawRecipe
      const result = raw.result
      const info =
        typeof result === 'number'
          ? result >= 0
            ? { id: result, count: 1 }
            : null
          : typeof result === 'object' && result !== null && typeof result.id === 'number'
            ? { id: result.id, count: typeof result.count === 'number' && result.count > 0 ? result.count : 1 }
            : null
      if (info === null) continue
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
            if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1)
          }
        }
      } else if (Array.isArray(raw.ingredients)) {
        requiresTable = raw.ingredients.length > 4
        for (const cell of raw.ingredients) {
          const id = cellId(cell)
          if (id === null) continue
          const name = nameById.get(id)
          if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1)
        }
      } else {
        continue
      }
      const ingredients = [...counts.entries()].map(([item, count]) => ({ item, count }))
      if (ingredients.length === 0) continue
      views.push({
        resultItem: resultName,
        resultCount: info.count,
        requiresTable,
        ingredients,
        signature: `${resultName}x${info.count}<=${ingredients.map((entry) => `${entry.item}x${entry.count}`).join('+')}`,
      })
    }
    if (views.length > 0) byResult.set(resultName, views)
  }
  return byResult
}

function recipeIndex(): Map<string, RecipeView[]> {
  if (cachedRecipeIndex !== null) return cachedRecipeIndex.byResult
  const reg = loadGameData()
  const byResult = buildRecipeIndex(reg)
  cachedRecipeIndex = { version: MC_DATA_VERSION, byResult }
  return byResult
}

/** Reset the memoized recipe index (tests only). */
export function resetRecipeCache(): void {
  cachedRecipeIndex = null
}

/** Every recipe variant that produces `itemName`. */
export function recipesFor(itemNameWanted: string): RecipeView[] {
  return recipeIndex().get(itemNameWanted) ?? []
}

/**
 * Deterministic recipe choice: fewest distinct ingredients, then fewest total
 * items, then signature order. Used to derive Option preconditions so all
 * variants of e.g. `furnace` (8 cobbled_deepslate / blackstone / cobblestone)
 * collapse to the same requirement.
 */
export function preferredRecipe(itemNameWanted: string): RecipeView | null {
  const variants = [...recipesFor(itemNameWanted)]
  if (variants.length === 0) return null
  variants.sort((a, b) => {
    if (a.ingredients.length !== b.ingredients.length) return a.ingredients.length - b.ingredients.length
    const totalA = a.ingredients.reduce((sum, entry) => sum + entry.count, 0)
    const totalB = b.ingredients.reduce((sum, entry) => sum + entry.count, 0)
    if (totalA !== totalB) return totalA - totalB
    return a.signature.localeCompare(b.signature)
  })
  return variants[0] ?? null
}

// ---------------------------------------------------------------------------
// smelting + fuel (NOT in minecraft-data@3.116.0 - explicit, wiki-cited)
// ---------------------------------------------------------------------------

/** Ticks a furnace takes per smelt (Minecraft wiki, "Furnace"). */
export const SMELT_TICKS = 200

/**
 * Burn time in ticks per fuel item (Minecraft wiki, "Fuel"). minecraft-data has
 * no fuel table, so this is the explicit owner; `game-data-test.mts` pins the
 * values used for decision-making.
 */
export const FUEL_BURN_TICKS: Readonly<Record<string, number>> = {
  coal: 1600,
  charcoal: 1600,
  blaze_rod: 2400,
  lava_bucket: 20000,
  stick: 100,
  oak_planks: 300,
  birch_planks: 300,
  spruce_planks: 300,
}

/** Smelting input -> output (Minecraft wiki, "Smelting"). Not in the data set. */
export const SMELT_INPUT: Readonly<Record<string, string>> = {
  charcoal: '*_log',
  iron_ingot: 'raw_iron',
  gold_ingot: 'raw_gold',
  copper_ingot: 'raw_copper',
  glass: 'sand',
}

/**
 * The inventory item a smelt goal consumes, or null when the item is not a
 * smelt output. `charcoal` yields the semantic class `log` (any log burns), so
 * callers can hold any log rather than one specific species.
 */
export function smeltInputFor(itemNameWanted: string): string | null {
  const input = SMELT_INPUT[itemNameWanted]
  if (input === undefined) return null
  return input === '*_log' ? 'log' : input
}

/** Burn ticks for a fuel item; any `*_log` / `*_planks` / `*_wood` burns 300. */
export function fuelBurnTicks(itemNameWanted: string): number | null {
  const direct = FUEL_BURN_TICKS[itemNameWanted]
  if (direct !== undefined) return direct
  if (itemNameWanted.endsWith('_log') || itemNameWanted.endsWith('_planks') || itemNameWanted.endsWith('_wood')) {
    return 300
  }
  return null
}

/** Smelts completed by one unit of fuel; null when the item is not a fuel. */
export function smeltsPerFuel(itemNameWanted: string): number | null {
  const burn = fuelBurnTicks(itemNameWanted)
  return burn === null ? null : burn / SMELT_TICKS
}

/**
 * Fuel units needed to smelt `count` items with `fuelItem`. Derived from burn
 * ticks: coal/charcoal 8 per unit (was 0.125 fuel/item), planks/log
 * 1.5 per unit, stick 0.5 per unit. Falls back to one fuel per item for an
 * unknown fuel name.
 */
export function fuelCountFor(count: number, fuelItem: string): number {
  const ratio = smeltsPerFuel(fuelItem)
  const perItem = ratio === null || ratio <= 0 ? 1 : 1 / ratio
  return Math.max(1, Math.ceil(Math.max(1, count) * perItem))
}

/**
 * True when the live inventory can supply one complete smelt transfer.
 * Input and fuel are separate furnace slots, so the same concrete item must
 * be counted twice instead of being reused from one inventory stack. This is a
 * mechanical precondition, not a policy preference.
 */
export function smeltInventorySufficient(
  counts: Readonly<Record<string, number>>,
  inputItem: string,
  inputCount: number,
  fuelItem: string,
  fuelCount: number,
): boolean {
  const inputNeed = Math.max(0, Math.floor(inputCount))
  const fuelNeed = Math.max(0, Math.floor(fuelCount))
  const inputHave = Math.max(0, Math.floor(counts[inputItem] ?? 0))
  if (inputItem === fuelItem) return inputHave >= inputNeed + fuelNeed
  return inputHave >= inputNeed && Math.max(0, Math.floor(counts[fuelItem] ?? 0)) >= fuelNeed
}

/** True when an item name is a furnace fuel (log/planks/wood or the table). */
export function isFuelItem(itemNameWanted: string): boolean {
  if (FUEL_BURN_TICKS[itemNameWanted] !== undefined) return true
  return (
    itemNameWanted.endsWith('_log') || itemNameWanted.endsWith('_planks') || itemNameWanted.endsWith('_wood')
  )
}

// ---------------------------------------------------------------------------
// edible truth (the data version's own `foods.json`) + the policy layer on it
//
// "Can this item be eaten at all" is GAME DATA, read exactly the way harvest
// truth is (`resolveHarvest(loadGameData(), name)`): minecraft-data builds
// `foodsByName` on this same registry object (loader.js `foodsByName:
// indexes.foodsByName` over `data/pc/<version>/foods.json`), so no food item
// name is re-listed in the decision path. `resolveHarvest` reads the block drop
// table; this reads the food table.
//
// What the data CANNOT answer stays policy, and is deliberately tiny:
// `foods.json` is a nutrition table (foodPoints/saturation only) with no
// `isMeat`/`canAlwaysEat`/harm field, and it lists the fish BUCKETS as edible.
// ---------------------------------------------------------------------------

/**
 * POLICY (not data): edibles a starving body must not treat as survival food.
 *
 *   rotten_flesh / spider_eye / poisonous_potato / pufferfish -> harmful effect
 *   potato            -> 60% Poison in vanilla; bake it instead (baked_potato)
 *   suspicious_stew   -> effect is not knowable from the data
 *   *_bucket          -> foods.json lists the fish buckets, but the bucket is
 *                        not what gets eaten
 *
 * Every name here is ALSO in the data's edible table; excluding one can only
 * make a route ungrounded, never invent one.
 */
export const NON_SURVIVAL_EDIBLES: ReadonlySet<string> = new Set([
  'rotten_flesh',
  'spider_eye',
  'poisonous_potato',
  'pufferfish',
  'potato',
  'suspicious_stew',
  'cod_bucket',
  'salmon_bucket',
  'pufferfish_bucket',
  'tropical_fish_bucket',
])

/**
 * DESPERATION EDIBLES: the members of `NON_SURVIVAL_EDIBLES` whose drawback is
 * drain, not damage. `rotten_flesh` is the only one - its vanilla Hunger effect
 * drains roughly a quarter of the +4 food it gives, so at the starvation floor
 * it is still net-positive, while every poison-class entry above can finish a
 * weak body outright. It stays excluded from ordinary food choice (`isFoodItem`
 * still says no, so a flesh stack can never outrank a steak it merely
 * outnumbers); the survival arms read it only as the food route a hostile-only
 * world actually offers.
 */
export const DESPERATION_EDIBLES: ReadonlySet<string> = new Set(['rotten_flesh'])

/**
 * DATA GAPS: vanilla-edible items this data version's `foods.json` does not
 * list. Corrected here by exception instead of re-listing the whole food set;
 * `kelp` is edible in vanilla (1 point) while only its smelted form
 * `dried_kelp` is in the table.
 */
export const VANILLA_EDIBLE_DATA_GAPS: ReadonlySet<string> = new Set(['kelp'])

/**
 * True when the running data version says `itemNameWanted` is edible AND the
 * policy layer does not exclude it as survival food. `foodsByName` defaults to
 * the pinned data version so a caller with no registry at hand (the planner
 * rung, `pickFood`) reads the same truth as one holding `bot.registry`.
 */
export function isFoodItem(
  reg: GameDataRegistry | null | undefined,
  itemNameWanted: string | null | undefined,
): boolean {
  if (typeof itemNameWanted !== 'string' || itemNameWanted.length === 0) return false
  if (NON_SURVIVAL_EDIBLES.has(itemNameWanted)) return false
  if (VANILLA_EDIBLE_DATA_GAPS.has(itemNameWanted)) return true
  const foods = reg?.foodsByName ?? pinnedFoodsByName()
  return foods !== null && foods[itemNameWanted] !== undefined
}

/** The pinned data version's edible table, or null when the data is unavailable. */
function pinnedFoodsByName(): Record<string, unknown> | null {
  try {
    return (loadGameData().foodsByName as Record<string, unknown> | undefined) ?? null
  } catch {
    // No usable data version is not evidence that an item is edible.
    return null
  }
}

/**
 * True when the running data version can turn `inputItem` into an edible item
 * in a furnace. Smelting input -> output (Minecraft wiki, "Smelting"); this is
 * the FOOD half of the furnace truth, kept separate from `SMELT_INPUT` so the
 * M2 fuel/ingot routes stay untouched.
 */
export const FOOD_SMELT_INPUT: Readonly<Record<string, string>> = {
  cooked_beef: 'beef',
  cooked_porkchop: 'porkchop',
  cooked_chicken: 'chicken',
  cooked_mutton: 'mutton',
  cooked_rabbit: 'rabbit',
  cooked_cod: 'cod',
  cooked_salmon: 'salmon',
  baked_potato: 'potato',
  dried_kelp: 'kelp',
}

/** The inventory item a food-smelt output consumes, or null when not one. */
export function foodSmeltInputFor(itemNameWanted: string): string | null {
  return FOOD_SMELT_INPUT[itemNameWanted] ?? null
}
