// mercury-capabilities.ts - the grounded capability matrix Mercury may plan with.
//
// Kept dependency-free so the system2 summary builder and the tests can import it
// without pulling in the AI SDK.
//
// Issue #19: the plan is no longer item-centric. A capability is an explicit
// (kind, target) pair, not an item whose verb is inferred locally, because
// `furnace` legitimately needs BOTH `craft furnace` and `place furnace`. Every
// kind listed here must map onto executable machinery before it is exposed.
//
//   collect       -> MINE / RETRIEVE      (item)
//   craft         -> CRAFT_AT_STATION     (item)
//   smelt         -> SMELT_AT_FURNACE     (item)
//   place         -> PLACE                (station item)
//   goto/goto_resource -> known-resource RETRIEVE (drop item)
//   descend_to    -> DESCEND predicate    (y level)
//   explore       -> DESCEND/collect body-change plan (mode)
//   build_portal_frame -> multi-cell PLACE (code-owned frame geometry)
//   light_portal  -> IGNITE selected skill (place nether_portal + portal_lit)
//   verify_portal -> IGNITE selected skill (same, re-verifies the postcondition)
//
// The M2 Nether gate is exposed as MODEL-VISIBLE WHAT, never as model-supplied
// geometry. Mercury picks `build_portal_frame` / `light_portal` / `verify_portal`
// and Code grounds the site (`choosePortalSite`), the cell set
// (`portalFrameLayout`) and the verification (`validatePortalFrame`). The frame
// is never leaked as a `place nether_portal` item (#263 pins that refusal).
//
// A pair is only added once the deterministic executor can actually ground it.

// #11 LLM-side default, kept as a literal because this module is
// deliberately dependency-free. Must match DEFAULT_LLM_MODEL in
// jev-agent/src/jev-legacy.ts.
export const SYSTEM2_MODEL_DEFAULT = 'meta/muse-spark-1.3-contributor'
/** @deprecated compatibility alias; System2 is no longer Mercury-specific. */
export const MERCURY_MODEL_DEFAULT = SYSTEM2_MODEL_DEFAULT

/** Explicit, code-owned capability kinds. Mercury never invents one. */
export const MERCURY_TYPED_GOAL_KINDS = [
  'collect',
  'craft',
  'place',
  'smelt',
  'goto',
  'goto_resource',
  'recover_death_site',
  'descend_to',
  'explore',
  'build_portal_frame',
  // `light`/`verify` are model-visible synonyms of light_portal/verify_portal,
  // not a second path: both compile to the same IGNITE selected skill.
  'light',
  'light_portal',
  'verify',
  'verify_portal',
] as const

export type MercuryTypedGoalKind = (typeof MERCURY_TYPED_GOAL_KINDS)[number]

export const MERCURY_EXPLORE_MODES = ['cave', 'surface'] as const

export interface MercuryAllowedGoals {
  collect: string[]
  craft: string[]
  smelt: string[]
  /** Items the executor can place as a station (the PLACE candidate path). */
  place: string[]
  /** Resources the known-resource retrieval can locate (drop-item names). */
  goto_resources: string[]
  /** Explore modes that compile onto an existing body-change plan. */
  explore_modes: string[]
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
    // Portal prerequisites are executable through the existing generic
    // collect path.  The executor/candidate layer still owns the hard
    // mechanical gates (gravel yield for flint and a diamond pickaxe for
    // obsidian); exposing the pair here only lets Mercury request the
    // capability instead of being forced to invent a deterministic route.
    'flint',
    'obsidian',
  ],
  craft: [
    'crafting_table',
    'wooden_pickaxe',
    'stone_pickaxe',
    'iron_pickaxe',
    'diamond_pickaxe',
    'furnace',
    'flint_and_steel',
    'iron_chestplate',
    'iron_leggings',
    'iron_helmet',
    'iron_boots',
    'iron_sword',
  ],
  smelt: ['charcoal', 'iron_ingot', 'gold_ingot', 'copper_ingot'],
  // Only stations the current PLACE path can actually place (issue #19).
  place: ['crafting_table', 'furnace'],
  // Drop-item names; ore block names (iron_ore, deepslate_iron_ore, ...) are
  // normalized to their drop by the adapter before grounding.
  goto_resources: ['raw_iron', 'raw_copper', 'raw_gold', 'diamond', 'coal', 'log', 'charcoal'],
  explore_modes: [...MERCURY_EXPLORE_MODES],
}
