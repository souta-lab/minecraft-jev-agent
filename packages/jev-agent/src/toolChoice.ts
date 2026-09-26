// toolChoice.ts - the single, pure rule that maps the *actual block being dug*
// to the tool family the executor should equip (#7).
//
// Root cause it replaces: `resourceTier()` reverse-looked-up the dig cell in
// `WorldState.blocks`, which only contains resource/hazard scan kinds
// (`log|stone|ore|hazard`). Terrain such as `dirt`/`grass_block` is absent, so
// the lookup returned 0 and the caller always chose a pickaxe. "Not in the
// resource scan" must never mean "pickaxe tier 0"; tool choice is a function of
// the concrete block, not of whether it happens to be a resource target.
//
// Rules (issue #7):
//   dirt / grass / sand / gravel     -> shovel if available, otherwise bare hand
//   stone-family / ores              -> the required pickaxe tier (reject if absent)
//   logs / wood                      -> axe if available, otherwise bare hand
//   untracked / unknown block        -> bare hand, NEVER an invented pickaxe
import type { HarvestTool } from './state.ts'

export interface DigBlockInfo {
  /** concrete block name from the live world (`''` means unknown) */
  name: string
  /** true only when the caller's block registry contains this exact name */
  knownBlock?: boolean
  /** registry harvest family; null = hand-harvestable */
  harvestTool: HarvestTool | null
  /** minimum pickaxe rank when `harvestTool === 'pickaxe'` */
  harvestTier: number | null
  diggable: boolean
}

export interface ToolChoice {
  /** true when the dig may proceed (a usable tool exists, or bare hand works) */
  ok: boolean
  /** tool family to equip; null = bare hand */
  tool: HarvestTool | null
  tier: number | null
  /** deterministic rule name, surfaced as `TOOL_CHOICE ... reason=<rule>` */
  reason: string
}

/** Blocks the registry reports as hand-harvestable but that a shovel speeds up. */
const SOFT_BLOCKS = new Set([
  'dirt',
  'coarse_dirt',
  'rooted_dirt',
  'grass_block',
  'podzol',
  'mycelium',
  'farmland',
  'dirt_path',
  'mud',
  'clay',
  'sand',
  'red_sand',
  'suspicious_sand',
  'gravel',
  'suspicious_gravel',
  'soul_sand',
  'soul_soil',
  'snow',
  'snow_block',
])

/**
 * Stone-family blocks. If the registry ever fails to report a pickaxe for one
 * of these, we must still not dig it bare-handed (a hand dig yields nothing),
 * but we also never *invent* a pickaxe requirement for an unknown name.
 */
const STONE_FAMILY = new Set([
  'stone',
  'cobblestone',
  'deepslate',
  'cobbled_deepslate',
  'andesite',
  'diorite',
  'granite',
  'tuff',
  'calcite',
  'dripstone_block',
  'basalt',
  'blackstone',
  'netherrack',
  'end_stone',
  'obsidian',
  'terracotta',
  'sandstone',
  'red_sandstone',
  'bricks',
  'smooth_stone',
])

const ORE_NAME = /(_ore|_debris)$/
const WOOD_NAME = /(_log|_wood|_planks|_stem|_hyphae|_fence|_fence_gate|_slab|_stairs|_door|_trapdoor)$|^bamboo_block$|^bamboo_mosaic$/

export type HasTool = (tool: HarvestTool, tier: number | null) => boolean

/**
 * Pure and deterministic. `has(tool, tier)` answers whether the inventory holds
 * a usable tool; the caller owns inventory inspection so this module stays a
 * pure function and is trivially unit-testable.
 */
export function selectDigTool(block: DigBlockInfo, has: HasTool): ToolChoice {
  if (!block.diggable) return { ok: false, tool: null, tier: null, reason: 'not_diggable' }

  if (block.harvestTool === 'pickaxe') {
    const tier = block.harvestTier ?? 0
    return has('pickaxe', tier)
      ? { ok: true, tool: 'pickaxe', tier, reason: `pickaxe_tier_${tier}` }
      : { ok: false, tool: null, tier: null, reason: `needs_pickaxe_tier_${tier}` }
  }
  if (block.harvestTool === 'shovel') {
    return has('shovel', 0)
      ? { ok: true, tool: 'shovel', tier: 0, reason: 'shovel_available' }
      : { ok: true, tool: null, tier: null, reason: 'soft_block_hand' }
  }
  if (block.harvestTool === 'axe') {
    return has('axe', 0)
      ? { ok: true, tool: 'axe', tier: 0, reason: 'axe_available' }
      : { ok: true, tool: null, tier: null, reason: 'wood_hand' }
  }

  // The registry returned no required tool. Classify from the concrete name.
  if (block.name === '') {
    return { ok: false, tool: null, tier: null, reason: 'unknown_block' }
  }
  if (SOFT_BLOCKS.has(block.name)) {
    return has('shovel', 0)
      ? { ok: true, tool: 'shovel', tier: 0, reason: 'soft_block_shovel' }
      : { ok: true, tool: null, tier: null, reason: 'soft_block_hand' }
  }
  if (WOOD_NAME.test(block.name)) {
    return has('axe', 0)
      ? { ok: true, tool: 'axe', tier: 0, reason: 'wood_axe' }
      : { ok: true, tool: null, tier: null, reason: 'wood_hand' }
  }
  if (STONE_FAMILY.has(block.name) || ORE_NAME.test(block.name)) {
    return has('pickaxe', 0)
      ? { ok: true, tool: 'pickaxe', tier: 0, reason: 'stone_family_pickaxe' }
      : { ok: false, tool: null, tier: null, reason: 'needs_pickaxe_tier_0' }
  }

  // Genuinely unknown/untracked block: bare hand. Never invent a pickaxe.
  return { ok: true, tool: null, tier: null, reason: 'untracked_hand' }
}

/**
 * Resolve the best available tool for removing a block when its drops are not
 * required. Harvest requirements decide whether a block yields an item; they do
 * not decide whether Minecraft permits a slower hand/tool break. `diggable` is
 * the mechanical truth supplied by the live block/sensor, while the block name
 * must still be known so unloaded/unknown cells fail closed.
 *
 * If a harvest tool is available, `selectDigTool` remains the preferred speed
 * choice. If the only reason it refused is the missing harvest tier/family,
 * clearance may proceed bare-handed. This preserves strict resource harvesting
 * while allowing route/headroom/step cuts to trade time for drops they do not
 * need.
 */
export function selectClearanceTool(block: DigBlockInfo, has: HasTool): ToolChoice {
  if (!block.diggable) return { ok: false, tool: null, tier: null, reason: 'not_diggable' }
  const name = block.name.trim()
  const knownByFamily =
    name !== '' &&
    (SOFT_BLOCKS.has(name) ||
      STONE_FAMILY.has(name) ||
      ORE_NAME.test(name) ||
      WOOD_NAME.test(name))
  if (
    name === '' ||
    ['unknown', 'air', 'cave_air', 'void_air'].includes(name) ||
    block.knownBlock === false ||
    (block.knownBlock !== true && !knownByFamily)
  ) {
    return { ok: false, tool: null, tier: null, reason: 'unknown_block' }
  }

  const preferred = selectDigTool(block, has)
  if (preferred.ok) return preferred
  if (preferred.reason === 'not_diggable' || preferred.reason === 'unknown_block') return preferred
  return { ok: true, tool: null, tier: null, reason: `clear_by_hand_without_${preferred.reason}` }
}

/** Human/log label for a chosen tool (`hand` when nothing is equipped). */
export function toolLabel(tool: HarvestTool | null): string {
  return tool ?? 'hand'
}

/** How demanding a single cell's harvest requirement is, for the profile fold. */
function requirementRank(cell: DigBlockInfo): number {
  if (cell.harvestTool === 'pickaxe') return 300 + (cell.harvestTier ?? 0)
  if (cell.harvestTool === 'axe') return 200
  if (cell.harvestTool === 'shovel') return 100
  return 0
}

/**
 * Fold a multi-cell dig profile into the single requirement that gates the
 * action. A staircase step down is a 1x2 landing cell, so it can only be dug
 * when EVERY cell of the profile can be: an unbreakable cell refuses the whole
 * profile, and otherwise the strongest requirement wins (a pickaxe also breaks
 * the dirt cell of the same step, never the other way round). Pure.
 */
export function strongestDigRequirement(cells: readonly DigBlockInfo[]): DigBlockInfo {
  let best: DigBlockInfo | null = null
  for (const cell of cells) {
    if (!cell.diggable) return cell
    if (best === null || requirementRank(cell) > requirementRank(best)) best = cell
  }
  return best ?? { name: '', harvestTool: null, harvestTier: null, diggable: false }
}
