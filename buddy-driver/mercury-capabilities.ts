// mercury-capabilities.ts - the grounded item sets Mercury may plan with.
//
// Kept dependency-free so the system2 summary builder and the tests can import it
// without pulling in the AI SDK. An item must be listed here before Mercury is
// allowed to return it; the kind (collect/craft/smelt) is inferred locally.
//
// A pair is only added once the deterministic executor can actually ground it.

export const MERCURY_MODEL_DEFAULT = 'inception/mercury-2.5'

export interface MercuryAllowedGoals {
  collect: string[]
  craft: string[]
  smelt: string[]
}

export const MERCURY_ALLOWED_GOALS: MercuryAllowedGoals = {
  collect: [
    'log',
    'oak_log',
    'birch_log',
    'spruce_log',
    'jungle_log',
    'acacia_log',
    'dark_oak_log',
    'mangrove_log',
    'cherry_log',
    'pale_oak_log',
    'stone',
    'cobblestone',
    'coal',
    'raw_iron',
    'raw_copper',
    'raw_gold',
    'diamond',
  ],
  craft: [
    'crafting_table',
    'wooden_pickaxe',
    'stone_pickaxe',
    'iron_pickaxe',
    'diamond_pickaxe',
    'furnace',
    'iron_chestplate',
    'iron_leggings',
    'iron_helmet',
    'iron_boots',
    'iron_sword',
  ],
  smelt: ['charcoal', 'iron_ingot', 'gold_ingot', 'copper_ingot'],
}
