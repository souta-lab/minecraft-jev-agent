// test-game-data.mts - Issue #54 parity test.
//
// Freezes the OLD hand-written tables (as LEGACY_*) and compares each decision
// they produced against the minecraft-data-derived decision from gameData.ts.
// Every difference is asserted explicitly with the reason the old value was
// wrong, so a future minecraft-data change fails loudly here instead of silently
// drifting the agent's mechanics. Pure: no bot, no network.
import {
  FUEL_BURN_TICKS,
  MC_DATA_VERSION,
  PICKAXE_TIER0,
  SMELT_INPUT,
  SMELT_TICKS,
  fuelCountFor,
  loadGameData,
  oreBlocksForItem,
  preferredRecipe,
  requiredPickaxeRank0,
  requiredPickaxeRank1,
  requiredPickaxeRankForItem1,
  resolveHarvest,
  smeltsPerFuel,
} from './src/gameData.ts'
import { ORE_SOURCES } from './src/state.ts'
import { selectClearanceTool, selectDigTool } from './src/toolChoice.ts'
import { FURNACE_STONE_COST } from './src/prereqOption.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const reg = loadGameData()

// --- frozen legacy tables (the code as it was before #54) --------------------
const LEGACY_OPTION_ORE_RANK = 2
const LEGACY_OPTION_COBBLE_RANK = 1
const LEGACY_DIAMOND_PICKAXE_DIAMONDS = 1
const LEGACY_FURNACE_STONE_COST = 8
const LEGACY_CHARCOAL_FUEL_PER_ITEM = 0.125
const LEGACY_OTHER_FUEL_PER_ITEM = 0.7
const legacyFuelCount = (count: number, fuel: string): number =>
  Math.max(1, Math.ceil(count * (fuel === 'coal' || fuel === 'charcoal' ? LEGACY_CHARCOAL_FUEL_PER_ITEM : LEGACY_OTHER_FUEL_PER_ITEM)))

// --- harvest matrix parity --------------------------------------------------
addCase('stone -> wooden pickaxe (rank 1), old and new agree', () => {
  const newRank = requiredPickaxeRank1(reg, 'stone')
  const profile = resolveHarvest(reg, 'stone')
  const pass =
    newRank === LEGACY_OPTION_COBBLE_RANK &&
    profile.harvestTool === 'pickaxe' &&
    profile.harvestTier === PICKAXE_TIER0['wooden_pickaxe'] &&
    profile.yield === 'cobblestone'
  return { pass, detail: `newRank=${String(newRank)} legacy=${LEGACY_OPTION_COBBLE_RANK} tool=${profile.harvestTool} tier0=${String(profile.harvestTier)} yield=${profile.yield}` }
})

addCase('dirt -> shovel with a shovel, hand without (old and new agree)', () => {
  const profile = resolveHarvest(reg, 'dirt')
  const withShovel = selectDigTool({ name: 'dirt', harvestTool: profile.harvestTool, harvestTier: profile.harvestTier, diggable: true }, (tool) => tool === 'shovel')
  const noShovel = selectDigTool({ name: 'dirt', harvestTool: profile.harvestTool, harvestTier: profile.harvestTier, diggable: true }, () => false)
  const pass = withShovel.tool === 'shovel' && withShovel.ok && noShovel.tool === null && noShovel.ok
  return { pass, detail: `shovel=${withShovel.tool}/${withShovel.reason} hand=${String(noShovel.tool)}/${noShovel.reason}` }
})

addCase('oak_log -> axe with an axe, hand without (old and new agree)', () => {
  const profile = resolveHarvest(reg, 'oak_log')
  const withAxe = selectDigTool({ name: 'oak_log', harvestTool: profile.harvestTool, harvestTier: profile.harvestTier, diggable: true }, (tool) => tool === 'axe')
  const noAxe = selectDigTool({ name: 'oak_log', harvestTool: profile.harvestTool, harvestTier: profile.harvestTier, diggable: true }, () => false)
  const pass = withAxe.tool === 'axe' && withAxe.ok && noAxe.tool === null && noAxe.ok
  return { pass, detail: `axe=${withAxe.tool}/${withAxe.reason} hand=${String(noAxe.tool)}/${noAxe.reason}` }
})

addCase('stone harvest still needs a pickaxe, while route clearance may break it by hand', () => {
  const profile = resolveHarvest(reg, 'stone')
  const block = { name: 'stone', harvestTool: profile.harvestTool, harvestTier: profile.harvestTier, diggable: true }
  const harvest = selectDigTool(block, () => false)
  const clearance = selectClearanceTool(block, () => false)
  return {
    pass:
      !harvest.ok &&
      harvest.reason === 'needs_pickaxe_tier_0' &&
      clearance.ok &&
      clearance.tool === null &&
      clearance.reason === 'clear_by_hand_without_needs_pickaxe_tier_0',
    detail: `harvest=${harvest.ok}/${harvest.reason} clearance=${clearance.ok}/${clearance.reason}`,
  }
})

addCase('obsidian clearance is possible without a diamond pickaxe, but its drops remain gated', () => {
  const profile = resolveHarvest(reg, 'obsidian')
  const block = { name: 'obsidian', harvestTool: profile.harvestTool, harvestTier: profile.harvestTier, diggable: true }
  const harvest = selectDigTool(block, () => false)
  const clearance = selectClearanceTool(block, () => false)
  const unbreakable = selectClearanceTool({ ...block, diggable: false }, () => true)
  const unknown = selectClearanceTool({ ...block, name: 'unknown' }, () => true)
  const untracked = selectClearanceTool(
    { ...block, name: 'modded_unlisted_block', harvestTool: null, harvestTier: null },
    () => true,
  )
  return {
    pass:
      !harvest.ok &&
      harvest.reason === 'needs_pickaxe_tier_4' &&
      clearance.ok &&
      clearance.tool === null &&
      !unbreakable.ok &&
      unbreakable.reason === 'not_diggable' &&
      !unknown.ok &&
      unknown.reason === 'unknown_block' &&
      !untracked.ok &&
      untracked.reason === 'unknown_block',
    detail: `harvest=${harvest.reason} clearance=${clearance.reason} unbreakable=${unbreakable.reason} unknown=${unknown.reason} untracked=${untracked.reason}`,
  }
})

addCase('iron ore -> stone pickaxe tier (rank 2); old and new agree', () => {
  const newRank = requiredPickaxeRankForItem1(reg, 'raw_iron')
  const pass = newRank === LEGACY_OPTION_ORE_RANK && requiredPickaxeRank1(reg, 'iron_ore') === LEGACY_OPTION_ORE_RANK
  return { pass, detail: `raw_iron=${String(newRank)} iron_ore=${String(requiredPickaxeRank1(reg, 'iron_ore'))} legacy=${LEGACY_OPTION_ORE_RANK}` }
})

addCase('DIFFERENCE diamond ore -> iron tier (rank 3), old table said 2', () => {
  const newRank = requiredPickaxeRankForItem1(reg, 'diamond')
  const oldAllowedStone = LEGACY_OPTION_ORE_RANK >= 2
  const pass = newRank === 3 && oldAllowedStone
  return {
    pass,
    detail: `new=${String(newRank)} old=${LEGACY_OPTION_ORE_RANK} oldAllowedStonePickaxeForDiamond=${oldAllowedStone} justified=issue#54 diamond requires iron`,
  }
})

addCase('DIFFERENCE gold ore -> iron tier (rank 3), old table said 2', () => {
  const newRank = requiredPickaxeRankForItem1(reg, 'raw_gold')
  const pass = newRank === 3
  return { pass, detail: `new=${String(newRank)} old=${LEGACY_OPTION_ORE_RANK} justified=gold_ore harvestTools=[iron,diamond,netherite]` }
})

addCase('DIFFERENCE coal ore -> wooden tier (rank 1), old table said 2', () => {
  const newRank = requiredPickaxeRankForItem1(reg, 'coal')
  const pass = newRank === 1
  return { pass, detail: `new=${String(newRank)} old=${LEGACY_OPTION_ORE_RANK} justified=coal_ore harvestTools include wooden_pickaxe` }
})

addCase('DIFFERENCE obsidian -> diamond tier (rank 4), old table had no entry', () => {
  const newRank = requiredPickaxeRank1(reg, 'obsidian')
  const pass = newRank === 4
  return { pass, detail: `new=${String(newRank)} old=null justified=obsidian harvestTools=[diamond,netherite]` }
})

addCase('furnace -> 8 stone-class blocks (old and new agree)', () => {
  const recipe = preferredRecipe('furnace')
  const stone = recipe === null ? 0 : recipe.ingredients.reduce((total, ingredient) => total + ingredient.count, 0)
  const pass = stone === LEGACY_FURNACE_STONE_COST && FURNACE_STONE_COST === LEGACY_FURNACE_STONE_COST
  return { pass, detail: `recipeStone=${stone} const=${FURNACE_STONE_COST} legacy=${LEGACY_FURNACE_STONE_COST} recipe=${recipe?.signature ?? 'none'}` }
})

addCase('DIFFERENCE diamond_pickaxe -> 3 diamonds, old table said 1', () => {
  const recipe = preferredRecipe('diamond_pickaxe')
  const diamonds = recipe?.ingredients.find((ingredient) => ingredient.item === 'diamond')?.count ?? 0
  const oldWasOne = LEGACY_DIAMOND_PICKAXE_DIAMONDS === 1
  const differs = diamonds !== LEGACY_DIAMOND_PICKAXE_DIAMONDS
  const pass = diamonds === 3 && oldWasOne && differs
  return { pass, detail: `new=${diamonds} old=${LEGACY_DIAMOND_PICKAXE_DIAMONDS} recipe=${recipe?.signature ?? 'none'} justified=issue#54 recipe needs diamond x3` }
})

addCase('charcoal burn time -> 8 smelts, old 0.125 fuel/item (old and new agree)', () => {
  const perUnit = smeltsPerFuel('charcoal')
  const newCount = fuelCountFor(8, 'charcoal')
  const oldCount = legacyFuelCount(8, 'charcoal')
  const pass = FUEL_BURN_TICKS['charcoal'] === 1600 && perUnit === 8 && newCount === oldCount && newCount === 1
  return { pass, detail: `burn=${String(FUEL_BURN_TICKS['charcoal'])}t smeltsPerUnit=${String(perUnit)} new=${newCount} old=${oldCount}` }
})

addCase('DIFFERENCE planks fuel -> 1.5 smelts/unit, old 0.7 fuel/item over-counted', () => {
  const perUnit = smeltsPerFuel('oak_planks')
  const newCount = fuelCountFor(3, 'oak_planks')
  const oldCount = legacyFuelCount(3, 'oak_planks')
  const differs = newCount !== oldCount
  const pass = perUnit === 300 / SMELT_TICKS && newCount === 2 && oldCount === 3 && differs
  return { pass, detail: `smeltsPerUnit=${String(perUnit)} new=${newCount} old=${oldCount} justified=planks burn 300t -> 1.5 smelts, old 0.7 rounded up to 3` }
})

addCase('every ORE_SOURCES entry matches a minecraft-data ore drop', () => {
  const problems: string[] = []
  for (const [item, blocks] of Object.entries(ORE_SOURCES)) {
    const derived = new Set(oreBlocksForItem(reg, item))
    if (derived.size === 0) problems.push(`${item}: no data-derived ore block`)
    for (const block of blocks) if (!derived.has(block)) problems.push(`${item}: ${block} not in data`)
  }
  return { pass: problems.length === 0, detail: problems.length === 0 ? `items=${Object.keys(ORE_SOURCES).length} all validated` : problems.join('; ') }
})

addCase('harvestTools pin: diamond_ore needs exactly iron/diamond/netherite', () => {
  const info = reg.blocksByName?.['diamond_ore']
  const names = Object.keys(info?.harvestTools ?? {}).map((id) => reg.items?.[Number(id)]?.name ?? id).sort()
  const expected = ['diamond_pickaxe', 'iron_pickaxe', 'netherite_pickaxe']
  const pass = names.join(',') === expected.join(',') && requiredPickaxeRank0(reg, 'diamond_ore') === PICKAXE_TIER0['iron_pickaxe']
  return { pass, detail: `tools=[${names.join(',')}] rank0=${String(requiredPickaxeRank0(reg, 'diamond_ore'))}` }
})

addCase('smelt input table points at real minecraft-data items', () => {
  const missing = Object.values(SMELT_INPUT).filter((input) => input !== '*_log' && reg.itemsByName?.[input] === undefined)
  const pass = missing.length === 0 && reg.itemsByName?.['raw_iron'] !== undefined
  return { pass, detail: missing.length === 0 ? `entries=${Object.keys(SMELT_INPUT).length} all items exist` : `missing=[${missing.join(',')}]` }
})

addCase('data version pin: minecraft-data is 1.21.11', () => {
  const version = (reg as { version?: { minecraftVersion?: string } }).version?.minecraftVersion
  return { pass: version === MC_DATA_VERSION && MC_DATA_VERSION === '1.21.11', detail: `version=${String(version)} pinned=${MC_DATA_VERSION}` }
})

let failures = 0
process.stdout.write('Minecraft-data harvest/recipe/fuel parity (#54)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} game-data cases passed\n`)
if (failures > 0) process.exit(1)
