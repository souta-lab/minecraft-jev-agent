// planner.ts - the HIGH-LEVEL PLANNER (System 2) for the resident AI_Buddy.
//
// Contract: this module returns BOUNDED PLANNING DATA ONLY (a list of high-level
// goals plus a plan operation). It NEVER issues actions. System One (the Jev
// controller + executor) stays the sole action authority; the controller turns
// whatever goal the queue exposes into one guarded macro-action per tick.
//
// Two sources, one interface (`System2Brain`):
//
//   * llm       - one batched `experimental_evaluate()` call on the proven Jev
//                 path (choice | score | boolean questions). The model chooses
//                 exactly one deterministically grounded horizon plan. It cannot
//                 invent a goal: the candidate plan ids ARE the only options.
//
//   * fallback  - the deterministic capability ladder (no network, never stalls).
//
// Safety / rate-limit behaviour:
//   - plans are cached by a world-state hash and identical states are deduped;
//   - LLM calls are spaced by a minimum interval (the gateway allows few calls);
//   - any failure (missing key, timeout, HTTP 429, malformed answer) falls back
//     to the deterministic ladder immediately and is logged.
//
// The planner is woken by the controller's exception paths via `summonLlm`
// (`queue_empty` / `action_impossible` / `no_progress` / `need_llm`), so it only
// runs on replan boundaries and never on the hot path.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Bot } from 'mineflayer'
import { experimental_evaluate as evaluate } from 'ai'
import type { Experimental_EvaluationQuestion } from 'ai'
import type { PlanOp, PlannedGoal } from '../jev-agent/src/goalQueue.ts'
import type { System2Brain, System2Outcome, System2Plan, System2PlanRequest } from '../jev-agent/src/system2.ts'
import { DEFAULT_JEV_MODEL, resolveJevApiKey } from '../jev-agent/src/jev.ts'
import type { KeyResolution } from '../jev-agent/src/jev.ts'
import { FatalModelError, describeFailure, failLoud, withModelRetries } from '../jev-agent/src/modelFailure.ts'
import { findInventoryFuel, matchesResourceClass, resourceMatches } from '../jev-agent/src/resourceClass.ts'
import type { ResourceClass } from '../jev-agent/src/resourceClass.ts'
import { hasBodyDelta, parseCapabilityGap } from '../jev-agent/src/replanThrottle.ts'
import { oreDescentTargetY } from '../jev-agent/src/predicateGoal.ts'
import type { KnownOrePosition } from '../jev-agent/src/predicateGoal.ts'
import { NETHER, netherPortalEntryGoal, netherPortalRungGoals, normalizePortalDimension } from '../jev-agent/src/netherPortalPlan.ts'
import { countSensedPortalFrameBlocks } from '../jev-agent/src/state.ts'
import type { Vec3Json } from '../jev-agent/src/state.ts'
import {
  PICKAXE_TIER_ORDER,
  loadGameData,
  requiredPickaxeRank1,
  requiredPickaxeRankForItem1,
} from '../jev-agent/src/gameData.ts'
import { formatSkillSelected, formatStrategyBodyDelta, generateSkillPlan, skillSignature } from '../jev-agent/src/skillCandidate.ts'
import type { SkillCandidate, SkillGenerationInput, SkillGoal } from '../jev-agent/src/skillCandidate.ts'
import {
  compilePlannedGoal,
  completeStartablePrerequisites,
  goalReadinessLabel,
  isOptionStartable,
  makeOptionSnapshot,
  orderGoalsByReadiness,
  stableOptionInstanceId,
} from '../jev-agent/src/optionSpec.ts'
import type { OptionWorldSnapshot } from '../jev-agent/src/optionSpec.ts'
import type { ResidentWorldMemory } from './resident-types.ts'
import { Advisor } from './advisor.ts'
import type { AdvisorDecision, AdvisorReason, AdvisorState, AdvisorStrategy } from './advisor.ts'
import type { MercurySystem2, MercuryTriggerReason } from './mercury-system2.ts'

export type Counts = Record<string, number>

// ---------------------------------------------------------------------------
// mode switch (env)
// ---------------------------------------------------------------------------

export type PlannerMode = 'llm' | 'deterministic'

/** Explicit opt-in only: `BUDDY_PLANNER=llm|jev|on`; all other values fail closed. */
export function resolvePlannerMode(): PlannerMode {
  const raw = (process.env.BUDDY_PLANNER ?? 'deterministic').trim().toLowerCase()
  if (raw === 'llm' || raw === 'jev' || raw === 'on') return 'llm'
  return 'deterministic'
}

// ---------------------------------------------------------------------------
// inventory helpers
// ---------------------------------------------------------------------------

export function inventoryCounts(bot: Bot): Counts {
  const counts: Counts = {}
  for (const item of bot.inventory.items()) counts[item.name] = (counts[item.name] ?? 0) + item.count
  return counts
}

export function countClass(counts: Counts, cls: ResourceClass): number {
  let total = 0
  for (const [name, n] of Object.entries(counts)) {
    if (matchesResourceClass(name, cls)) total += n
  }
  return total
}

export function has(counts: Counts, name: string): boolean {
  return (counts[name] ?? 0) > 0
}

/** 0 none, 1 wooden, 2 stone, 3 iron, 4 diamond+ (order from gameData.ts #54). */
export function bestPickaxeRank(counts: Counts): number {
  let rank = 0
  for (let i = 0; i < PICKAXE_TIER_ORDER.length; i += 1) {
    const name = PICKAXE_TIER_ORDER[i]
    if (name !== undefined && has(counts, name)) rank = Math.max(rank, i + 1)
  }
  return rank
}

/** Count inventory items matching a concrete item id OR a semantic class. */
export function countResource(counts: Counts, spec: string): number {
  let total = 0
  for (const [name, n] of Object.entries(counts)) if (resourceMatches(name, spec)) total += n
  return total
}

/**
 * Inventory-first planning (#43): a production goal already satisfied by the
 * LIVE inventory must never be emitted. A fuel step also accepts a substitute
 * (`log` goal satisfied by held planks / coal / charcoal). Deterministic.
 */
export function goalAlreadyMet(goal: PlannedGoal, counts: Counts): boolean {
  const need = Math.max(1, Math.floor(goal.requiredCount ?? 1))
  if (goal.kind !== 'collect' && goal.kind !== 'craft' && goal.kind !== 'smelt') return false
  return goalHave(goal, counts) >= need
}

/** Live inventory count that satisfies a goal, counting fuel substitutes. */
export function goalHave(goal: PlannedGoal, counts: Counts): number {
  const item = goal.targetItem
  if (typeof item !== 'string' || item.length === 0) return 0
  if (item === 'log' || item === 'planks' || item === 'fuel') return countClass(counts, 'fuel') - (counts['stick'] ?? 0)
  return countResource(counts, item)
}

/** Drop goals already satisfied by the live inventory, logging each skip (#43). */
export function filterAlreadyMet(
  goals: readonly PlannedGoal[],
  counts: Counts,
  rungId: string,
  log?: (event: string, detail?: Record<string, unknown>) => void,
): PlannedGoal[] {
  return goals.filter((goal) => {
    if (!goalAlreadyMet(goal, counts)) return true
    log?.('PRECONDITION_ALREADY_MET', {
      item: goal.targetItem ?? goal.description,
      have: goalHave(goal, counts),
      goal: goal.description,
      rungId,
      action: 'skip',
    })
    return false
  })
}

function woodUnits(counts: Counts): number {
  return countClass(counts, 'log') + Math.floor(countClass(counts, 'planks') / 4)
}

// M2 smelt priority: when the smelt inputs are held, no descend/collect goal
// may preempt the smelt (measured 2026-09-18: raw_iron:8 + coal:7 sat behind
// `descend:diamond`, so iron_ingot was never produced).

export function smeltPriorityGoal(counts: Counts): PlannedGoal | null {
  const missing = 3 - (counts['iron_ingot'] ?? 0)
  if (missing <= 0) return null
  if ((counts['raw_iron'] ?? 0) < missing) return null
  if (findInventoryFuel(counts) === null) return null
  // `requiredCount` is the TOTAL target, never the shortfall. Every consumer of
  // a smelt goal treats it as the total: `goalAlreadyMet` compares the held
  // count against it, `smeltPreconditions`/`successForGoal` compile it into
  // `inventoryAtLeast iron_ingot count`, and `smeltCandidates` derives the batch
  // as `requiredCount - haveOutput`. Encoding the shortfall here made a bot with
  // 2 ingots read as "already met" and the third ingot was never smelted.
  return {
    kind: 'smelt',
    description: 'smelt 3 x iron_ingot',
    targetItem: 'iron_ingot',
    requiredCount: 3,
  }
}

export function enforceSmeltPriority(
  goals: readonly PlannedGoal[],
  counts: Counts,
  log?: (event: string, detail?: Record<string, unknown>) => void,
): PlannedGoal[] {
  const priority = smeltPriorityGoal(counts)
  if (priority === null) return [...goals]
  const first = goals[0]
  if (first !== undefined && first.kind === 'smelt' && first.targetItem === priority.targetItem) {
    return [...goals]
  }
  const index = goals.findIndex((goal) => goal.kind === 'smelt' && goal.targetItem === priority.targetItem)
  if (index > 0 && goals.slice(0, index).some((goal) => goal.kind === 'place')) {
    return [...goals]
  }
  const over = first?.description ?? 'empty-plan'
  const rest = goals.filter((_, i) => i !== index)
  log?.('PLAN_ORDER', { preferred: 'smelt_iron_ingot', over })
  return [priority, ...rest]
}

/**
 * Issue #46: the plain-JSON world a readiness predicate reads. A station counts
 * as known when it is placed OR held (a held furnace can be placed and used), so
 * a ready smelt is not misclassified as blocked just because the furnace is still
 * in the inventory.
 */
export function plannerReadinessSnapshot(counts: Counts, world: ResidentWorldMemory): OptionWorldSnapshot {
  const knownStations: Array<'crafting_table' | 'furnace'> = []
  if (has(counts, 'crafting_table') || world.craftingTables.length > 0) knownStations.push('crafting_table')
  if (has(counts, 'furnace') || world.furnaces.length > 0) knownStations.push('furnace')
  return makeOptionSnapshot({
    inventory: counts,
    dimension: null,
    position: null,
    health: null,
    toolRank: bestPickaxeRank(counts),
    knownStations,
    knownOres: world.discoveredOres,
  })
}

/**
 * Issue #46: the goal-queue compile/repair entry point. First inject the ready
 * smelt priority (requirement 2) when its FULL preconditions hold, then
 * stable-partition the goals by readiness (requirement 1). Every reordering that
 * changed the order is logged as PLAN_ORDER with reason=preconditions_satisfied.
 */
export function orderPlanGoalsByReadiness(
  goals: readonly PlannedGoal[],
  counts: Counts,
  world: ResidentWorldMemory,
  log?: (event: string, detail?: Record<string, unknown>) => void,
): PlannedGoal[] {
  const snapshot = plannerReadinessSnapshot(counts, world)
  const priority = smeltPriorityGoal(counts)
  let base = [...goals]
  if (priority !== null && isOptionStartable(compilePlannedGoal(priority), snapshot)) {
    const first = base[0]
    const alreadyLeading = first !== undefined && first.kind === 'smelt' && first.targetItem === priority.targetItem
    if (!alreadyLeading) {
      const index = base.findIndex((goal) => goal.kind === 'smelt' && goal.targetItem === priority.targetItem)
      base = [priority, ...base.filter((_, i) => i !== index)]
      log?.('PLAN_ORDER', {
        preferred: 'smelt_iron_ingot',
        over: first?.description ?? 'empty-plan',
        reason: 'preconditions_satisfied',
      })
    }
  }
  const ordered = orderGoalsByReadiness(base, snapshot)
  for (const inserted of ordered.inserted) {
    log?.('PLAN_ORDER', {
      preferred: goalReadinessLabel(inserted.prerequisite),
      over: inserted.consumer.description,
      reason: 'prerequisite_required',
      need: inserted.prerequisite.targetItem ?? inserted.prerequisite.kind,
    })
  }
  for (const move of ordered.moves) {
    log?.('PLAN_ORDER', { preferred: move.preferred, over: move.over, reason: 'preconditions_satisfied' })
  }
  return ordered.goals
}

// ---------------------------------------------------------------------------
// rung templates: the deterministic road from spawn to the Ender Dragon
// ---------------------------------------------------------------------------

export interface Rung {
  id: string
  /**
   * `future` rungs are part of the documented road to M4 but the current
   * executor cannot attempt them yet. They are shown to the planner as horizon
   * context but are never selected by the deterministic fallback ladder.
   */
  future?: boolean
  /**
   * `optional` rungs are real, executable affordances that are NOT mandatory
   * prerequisites on the documented road to the M2 diamond-to-Nether gate. They
   * remain selectable Options (Mercury/Jev choose), but they are excluded from
   * the mandatory frontier AND from every prerequisite chain, so a later rung
   * (diamond / nether_portal) never inherits them transitively. This is an
   * affordance boundary, not a deterministic reordering.
   */
  optional?: boolean
  /**
   * A self-contained OPTIONAL affordance is not a milestone and inherits no
   * milestone prerequisites when it is offered as an Option. `iron_gear` is an
   * optional rung that still sits inside the iron-age chain, so its Option
   * legitimately carries its mandatory predecessors; a survival affordance like
   * `food` must not imply "finish the whole remaining ladder first".
   */
  selfContained?: boolean
  satisfied: (c: Counts, w: ResidentWorldMemory) => boolean
  goals: (c: Counts, w: ResidentWorldMemory) => PlannedGoal[]
}

function climb(ingotsNeeded: number, counts: Counts, crafts: Array<[string, number]>): PlannedGoal[] {
  const out: PlannedGoal[] = []
  const have = (counts['raw_iron'] ?? 0) + (counts['iron_ingot'] ?? 0)
  const missing = Math.max(0, ingotsNeeded - have)
  if (missing > 0) {
    out.push({ kind: 'collect', description: `collect ${missing} x raw_iron`, targetItem: 'raw_iron', requiredCount: missing })
    out.push({ kind: 'smelt', description: `smelt ${missing} x iron_ingot`, targetItem: 'iron_ingot', requiredCount: missing })
  }
  for (const [item, n] of crafts) {
    if ((counts[item] ?? 0) < n) out.push({ kind: 'craft', description: `craft ${n} x ${item}`, targetItem: item, requiredCount: n })
  }
  if (out.length === 0) {
    out.push({ kind: 'craft', description: 'craft 1 x iron_chestplate', targetItem: 'iron_chestplate', requiredCount: 1 })
  }
  return out
}

const FOOD_RUNG_COUNT = 3
/**
 * Collect anchor for the food rung. `food` is the shared resource class (like
 * the existing `log` anchor for the wood rung), so the goal is satisfied by ANY
 * edible item -- beef, porkchop, chicken, fish, berries. The candidate layer
 * grounds the route for whatever passive food animal the sensor sees; Jev owns
 * which animal/action.
 */
const FOOD_RUNG_ANCHOR = 'food'

/**
 * Total edible items held, using the shared `food` resource class. Raw
 * passive-animal drops count: they are edible without a furnace, which is the
 * whole point of a survival food route.
 */
function heldFoodCount(c: Counts): number {
  let total = 0
  for (const [name, count] of Object.entries(c)) {
    if (matchesResourceClass(name, 'food')) total += count
  }
  return total
}

/**
 * Being in the Nether is live proof that the overworld -> Nether portal
 * transition is already behind the resident. This is planner capability closure,
 * not durable portal truth: `portalVerified` remains an overworld-only live fact
 * and M2 acceptance still requires its own exact-run evidence.
 *
 * The comparison MUST normalize. Mineflayer strips the `minecraft:` prefix from
 * `bot.game.dimension` (`lib/plugins/game.js`), so the live value here is
 * `the_nether`, while the durable world key and the portal postcondition use the
 * namespaced form. A raw `=== 'minecraft:the_nether'` therefore never matched
 * live and the ladder flapped between `nether_portal` and `enter_nether` after a
 * successful transfer (the #352 symptom), which blocked the M3 rungs.
 */
function inNether(world: ResidentWorldMemory): boolean {
  const dimension = world.dimension
  return (
    typeof dimension === 'string' &&
    dimension.length > 0 &&
    normalizePortalDimension(dimension) === normalizePortalDimension(NETHER)
  )
}

/** The ordered capability ladder. Each rung states its own completion in inventory/world terms. */
export const RUNGS: readonly Rung[] = [
  {
    id: 'wood',
    // A pickaxe already implies the wood stage is done; the charcoal rung asks
    // for its own 2 logs, so do not re-collect 3 logs just to satisfy this rung.
    satisfied: (c) => woodUnits(c) >= 3 || bestPickaxeRank(c) >= 1,
    goals: () => [{ kind: 'collect', description: 'collect 3 x log', targetItem: 'log', requiredCount: 3 }],
  },
  {
    id: 'crafting_table',
    satisfied: (c, w) => has(c, 'crafting_table') || w.craftingTables.length > 0,
    goals: () => [{ kind: 'craft', description: 'craft 1 x crafting_table', targetItem: 'crafting_table', requiredCount: 1 }],
  },
  {
    id: 'wooden_pickaxe',
    satisfied: (c) => bestPickaxeRank(c) >= 1,
    goals: () => [{ kind: 'craft', description: 'craft 1 x wooden_pickaxe', targetItem: 'wooden_pickaxe', requiredCount: 1 }],
  },
  {
    id: 'cobblestone',
    // Cobblestone is legitimately spent on the furnace and stone_pickaxe; a
    // stone pickaxe proves enough cobblestone was mined even when the count is
    // low. Keep the goal concrete: the sensor and candidate generator use the
    // cobblestone drop, while `stone` is only the semantic resource class.
    satisfied: (c) => countClass(c, 'stone') >= 12 || bestPickaxeRank(c) >= 2,
    goals: () => [{ kind: 'collect', description: 'collect 12 x cobblestone', targetItem: 'cobblestone', requiredCount: 12 }],
  },
  {
    id: 'furnace',
    satisfied: (c, w) => has(c, 'furnace') || w.furnaces.length > 0,
    goals: () => [
      { kind: 'craft', description: 'craft 1 x furnace', targetItem: 'furnace', requiredCount: 1 },
      { kind: 'place', description: 'place 1 x furnace', targetItem: 'furnace', requiredCount: 1 },
    ],
  },
  {
    id: 'stone_pickaxe',
    satisfied: (c) => bestPickaxeRank(c) >= 2,
    goals: () => [{ kind: 'craft', description: 'craft 1 x stone_pickaxe', targetItem: 'stone_pickaxe', requiredCount: 1 }],
  },
  {
    id: 'charcoal',
    // M2 acceptance requires `charcoal >= 1` specifically. Coal is a valid
    // smelting FUEL (findInventoryFuel) but it is not charcoal, so holding coal
    // must not mark this rung satisfied or the ladder would skip charcoal
    // production and M2's charcoal gate could never pass (measured 2026-09-18:
    // raw_iron:8 + coal:7 without charcoal).
    satisfied: (c) => has(c, 'charcoal'),
    goals: () => [
      { kind: 'collect', description: 'collect 2 x log (fuel)', targetItem: 'log', requiredCount: 2 },
      { kind: 'smelt', description: 'smelt 1 x charcoal', targetItem: 'charcoal', requiredCount: 1 },
    ],
  },
  {
    id: 'raw_iron',
    satisfied: (c) => (c['raw_iron'] ?? 0) + (c['iron_ingot'] ?? 0) >= 3,
    // `requiredCount` is the TOTAL target (3), matching the description and
    // `goalHave`/`successForGoal`. The old `3 - held` shortfall made
    // `goalAlreadyMet` read 2 held against required 1 and skip the goal while the
    // rung was still UNSATISFIED: the third ore was never collected.
    goals: () => [
      {
        kind: 'collect',
        description: 'collect 3 x raw_iron',
        targetItem: 'raw_iron',
        requiredCount: 3,
      },
    ],
  },
  {
    id: 'iron_ingot',
    // The rung's ingots have exactly two consumers: the iron pickaxe and the
    // flint_and_steel. When BOTH purposes are already fulfilled — an
    // iron-or-better pickaxe is held AND the flint_and_steel it was smelted for
    // is held — re-smelting 3 ingots is a dominated mid-step detour of the same
    // class as `iron_gear` below. Measured live (`run-mub35qdr-1e1dh`): the bot
    // held `flint_and_steel=1` and `diamond_pickaxe=1` while `iron_ingot=0`, so
    // this rung stayed "unsatisfied" and its `smelt 1 x iron_ingot`
    // prerequisite re-entered the durable queue and blocked `collect:obsidian`
    // behind a furnace it could not reach.
    //
    // Honest requirement: if either consumer is still unfulfilled (no
    // iron-or-better pickaxe, or no flint_and_steel), more iron IS genuinely
    // needed and the rung stays unsatisfied.
    satisfied: (c) => (c['iron_ingot'] ?? 0) >= 3 || (bestPickaxeRank(c) >= 3 && has(c, 'flint_and_steel')),
    // Same total-vs-shortfall bug as the raw_iron rung: with 2 ingots held this
    // compiled a required count of 1, so the third smelt was skipped entirely.
    goals: () => [{ kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3 }],
  },
  {
    id: 'iron_pickaxe',
    satisfied: (c) => bestPickaxeRank(c) >= 3,
    goals: () => [{ kind: 'craft', description: 'craft 1 x iron_pickaxe', targetItem: 'iron_pickaxe', requiredCount: 1 }],
  },
  {
    id: 'iron_gear',
    // M2 is diamond-to-Nether-gate: full iron armour + sword is a real affordance
    // but NOT a mandatory prerequisite of the diamond / portal route.
    optional: true,
    // The rung's intent is "wear a full protective set and carry a sword". A
    // strictly better tier already satisfies that intent: with diamond armour and
    // a diamond sword held, re-offering the iron set spends System2's choice on a
    // dominated detour (observed live: the model chose `iron_gear` over
    // `front_ender_pearls` while already wearing full diamond gear).
    satisfied: (c) =>
      (has(c, 'iron_chestplate') || has(c, 'diamond_chestplate')) &&
      (has(c, 'iron_leggings') || has(c, 'diamond_leggings')) &&
      (has(c, 'iron_helmet') || has(c, 'diamond_helmet')) &&
      (has(c, 'iron_boots') || has(c, 'diamond_boots')) &&
      (has(c, 'iron_sword') || has(c, 'diamond_sword')),
    goals: (c) =>
      climb(26, c, [
        ['iron_chestplate', 1],
        ['iron_leggings', 1],
        ['iron_helmet', 1],
        ['iron_boots', 1],
        ['iron_sword', 1],
      ]),
  },
  {
    id: 'diamond',
    satisfied: (c) => has(c, 'diamond'),
    goals: () => [{ kind: 'collect', description: 'collect 1 x diamond', targetItem: 'diamond', requiredCount: 1 }],
  },
  {
    id: 'diamond_pickaxe',
    satisfied: (c) => has(c, 'diamond_pickaxe'),
    goals: () => [{ kind: 'craft', description: 'craft 1 x diamond_pickaxe', targetItem: 'diamond_pickaxe', requiredCount: 1 }],
  },
  // --- M3 (owner definition): 12 ender_eye (Eye of Ender). ---
  // Crafting 12 eyes needs 12 ender_pearl + 12 blaze_powder. The Nether supplies
  // BOTH (fortress blazes, warped-forest endermen), so the M3 road enters the
  // Nether first:
  //   nether_portal (M2 gate; obsidian route landed in #322)
  //   -> blaze_rods (Nether fortress)
  //   -> ender_pearls (warped-forest endermen, or overworld endermen)
  //   -> ender_eyes (terminal: ender_eye>=12)
  // Live evidence for this order: with the pearl rung first the resident stalled —
  // the only sensed enderman was >50 blocks away and 38 blocks below, outside
  // sensor/combat range, so `collect 12 x ender_pearl` had no grounded target and
  // the agent only wandered. The obsidian perception fix (#322) makes the portal
  // rung actionable, and the Nether is the dense source for both remaining items.
  // --- M2 portal transition ---
  {
    id: 'nether_portal',
    // M2 transition: done only once the lit nether_portal block actually exists.
    // The previous flint_and_steel predicate declared the rung satisfied before a
    // frame was ever built, so the ladder skipped build/light/verify entirely.
    // Once the body is IN the Nether the overworld gate has demonstrably been
    // built, lit and used, so this rung must not keep the frontier here. Live
    // (M3 hand-off): `detectLivePortalVerification` only reads overworld truth, so
    // standing in the Nether made `portalVerified` false, this earlier rung became
    // unsatisfied and the ladder flapped between `front_nether_portal` and
    // `front_enter_nether` forever instead of advancing to `blaze_rods`/`ender_pearls`.
    // Returning to the overworld with no verified portal re-activates it.
    // `inNether` normalizes because mineflayer reports the bare `the_nether`.
    satisfied: (c, w) =>
      has(c, 'nether_portal') || w.portalVerified === true || inNether(w),
    // #80: typed deterministic portal plan (obsidian tool gate -> frame -> light -> verify).
    goals: (c) => netherPortalRungGoals(c, bestPickaxeRank(c)),
  },
  // --- M2 -> M3 transition: step through the lit portal into the Nether. ---
  // Satisfied by the code-owned dimension truth (`dimensionIs`), never by an
  // inventory count: the executor's `runEnterPortal` walks into the lit interior
  // and the postcondition is the normalized `bot.game.dimension == the_nether`.
  // Without this rung the ladder jumped straight to Nether-only goals
  // (`blaze_rods`) while the bot was still in the overworld.
  {
    id: 'enter_nether',
    satisfied: (_c, w) => inNether(w),
    goals: () => [netherPortalEntryGoal()],
  },
  // --- M3 continued: Nether blaze rods -> pearls -> Eyes of Ender. ---
  {
    id: 'blaze_rods',
    satisfied: (c) => (c['blaze_rod'] ?? 0) >= 7,
    goals: () => [{ kind: 'collect', description: 'collect 7 x blaze_rod', targetItem: 'blaze_rod', requiredCount: 7 }],
  },
  {
    id: 'ender_pearls',
    satisfied: (c) => (c['ender_pearl'] ?? 0) >= 12,
    goals: () => [{ kind: 'collect', description: 'collect 12 x ender_pearl', targetItem: 'ender_pearl', requiredCount: 12 }],
  },
  {
    id: 'ender_eyes',
    satisfied: (c) => (c['ender_eye'] ?? 0) >= 12,
    goals: () => [{ kind: 'craft', description: 'craft 12 x ender_eye', targetItem: 'ender_eye', requiredCount: 12 }],
  },
  {
    id: 'stronghold',
    future: true,
    satisfied: () => false,
    goals: () => [{ kind: 'explore', description: 'locate the stronghold and its end portal room', targetItem: null, requiredCount: 1 }],
  },
  {
    id: 'the_end',
    future: true,
    satisfied: () => false,
    goals: () => [{ kind: 'place', description: 'activate the end portal with eyes of ender', targetItem: 'end_portal', requiredCount: 1 }],
  },
  {
    id: 'dragon',
    future: true,
    satisfied: () => false,
    goals: () => [{ kind: 'recover', description: 'defeat the ender dragon', targetItem: 'ender_dragon', requiredCount: 1 }],
  },
  // --- Survival affordance (NOT an M2/M3 milestone). ---
  // A body at food=0 loses health and cannot regenerate, and the eat mechanic
  // works only while an edible item is held. This rung is the planner's grounded
  // route to food: it is OPTIONAL, so it never gates diamond/portal/Nether, and
  // self-contained, so choosing it does not inherit the mandatory ladder. The
  // candidate layer offers the hunt ATTACK for whatever passive food animal the
  // sensor sees; Jev owns which animal/action. Appended last so every existing
  // rung keeps its index.
  {
    id: 'food',
    optional: true,
    selfContained: true,
    satisfied: (c) => heldFoodCount(c) >= FOOD_RUNG_COUNT,
    goals: (c) =>
      heldFoodCount(c) >= FOOD_RUNG_COUNT
        ? []
        : [
            {
              kind: 'collect',
              description: `collect ${FOOD_RUNG_COUNT} x food (hunt passive animals)`,
              targetItem: FOOD_RUNG_ANCHOR,
              requiredCount: FOOD_RUNG_COUNT,
            },
          ],
  },
]

export interface Ladder {
  goals: PlannedGoal[]
  rungIndex: number
  rungId: string
  futureRungIds: string[]
  /**
   * True when a rung's precondition was missing and the plan was replaced with
   * the prerequisite chain derived from the live inventory (#12). The controller
   * must keep ticking: a missing precondition is a replan, never a stop.
   */
  prereqReplaced: boolean
  /** Non-null only when the missing precondition is provably unsatisfiable. */
  unsatisfiable: string | null
}

/** Executable rungs only: the deterministic road the current executor can run. */
export function executableRungs(): readonly Rung[] {
  return RUNGS.filter((rung) => rung.future !== true)
}

/**
 * The M2 mandatory road: executable rungs that are not optional side quests.
 * Optional rungs stay selectable as Options but never gate a later rung.
 */
export function isMandatoryRung(rung: Rung): boolean {
  return rung.future !== true && rung.optional !== true
}

export interface PreconditionResult {
  ok: boolean
  need: string
}

/** A rung's prerequisite, checked before its goal is ever emitted. A goal whose
 * tool/material prerequisite is missing must never enter the queue: that is what
 * wedged the resident on `collect raw_iron` with an empty inventory. */
export function rungPrecondition(rung: Rung, c: Counts, w: ResidentWorldMemory): PreconditionResult {
  const ranks = loadGameData()
  switch (rung.id) {
    case 'cobblestone':
      return { ok: bestPickaxeRank(c) >= (requiredPickaxeRank1(ranks, 'cobblestone') ?? 1), need: 'wooden_pickaxe' }
    case 'furnace':
      return { ok: countClass(c, 'stone') >= 8 || has(c, 'furnace') || w.furnaces.length > 0, need: '8 x stone' }
    case 'stone_pickaxe':
      return { ok: countClass(c, 'stone') >= 3 && bestPickaxeRank(c) >= 1, need: '3 x stone + wooden_pickaxe' }
    case 'charcoal':
      return { ok: has(c, 'furnace') || w.furnaces.length > 0, need: 'placed furnace' }
    case 'raw_iron':
      return { ok: bestPickaxeRank(c) >= (requiredPickaxeRankForItem1(ranks, 'raw_iron') ?? 2), need: 'stone_pickaxe' }
    case 'iron_ingot':
      return {
        ok: (has(c, 'furnace') || w.furnaces.length > 0) && (c['raw_iron'] ?? 0) + (c['iron_ingot'] ?? 0) >= 1,
        need: 'furnace + raw_iron',
      }
    case 'iron_pickaxe':
      return { ok: (c['iron_ingot'] ?? 0) >= 3, need: '3 x iron_ingot' }
    case 'iron_gear':
      return { ok: (c['iron_ingot'] ?? 0) >= 3, need: 'iron_ingot' }
    case 'diamond':
      return { ok: bestPickaxeRank(c) >= (requiredPickaxeRankForItem1(ranks, 'diamond') ?? 3), need: 'iron_pickaxe' }
    case 'diamond_pickaxe':
      return { ok: has(c, 'diamond'), need: 'diamond' }
    default:
      return { ok: true, need: '' }
  }
}

const ORE_RUNG_ITEM: Record<string, string> = { raw_iron: 'raw_iron', diamond: 'diamond' }

const ORE_DIMENSION = 'minecraft:overworld'

const ORE_HOME: Record<string, { item: string; ore: string; dimension: string }> = {
  raw_iron: { item: 'raw_iron', ore: 'iron_ore', dimension: 'minecraft:overworld' },
  diamond: { item: 'diamond', ore: 'diamond_ore', dimension: 'minecraft:overworld' },
}

/**
 * A predicate goal (#41): success is `position.y <= targetY` in `dimension`,
 * evaluated by code. Descending is a spatial predicate, not an item collection,
 * so the ore descent no longer charges the bot a cobblestone quota it stalls on.
 */
export function descendGoal(targetY: number, item: string | null, dimension: string | null = ORE_DIMENSION): PlannedGoal {
  return {
    kind: 'descend',
    description: `descend_to:Y=${targetY}`,
    targetItem: item,
    requiredCount: 1,
    targetY,
    dimension,
  }
}

/** Known ore coordinates, derived from durable WorldMemory (#14). */
export function knownOrePositions(world: ResidentWorldMemory): KnownOrePosition[] {
  return (world.knownResources ?? [])
    .filter((resource) => resource.kind === 'ore')
    .map((resource) => ({
      name: resource.name,
      y: resource.y,
      ...(resource.dimension === undefined ? {} : { dimension: resource.dimension }),
    }))
}

/**
 * The ore-descent predicate goal: a couple of blocks below the deepest known
 * coordinate of the target ore when WorldMemory has one (#14), else the canonical
 * ore band. `requiredCount` is 1 because success is the predicate, not a count.
 */
export function oreDescentGoal(item: string, world: ResidentWorldMemory): PlannedGoal {
  const targetY = oreDescentTargetY(item, knownOrePositions(world), ORE_DIMENSION)
  return descendGoal(targetY, item)
}

function needsOreDescent(rungId: string, counts: Counts): boolean {
  const ore = ORE_RUNG_ITEM[rungId]
  if (ore === undefined) return false
  if ((counts[ore] ?? 0) > 0) return false
  return bestPickaxeRank(counts) >= 1
}

/** Furnace acquisition chain: sense/known needs none, held needs a place, else craft from 8 cobblestone. */
export function furnacePrereqGoals(
  counts: Counts,
  placedFurnacesNear: number | undefined,
  knownFurnaces: number | undefined = 0,
): PlannedGoal[] {
  if ((placedFurnacesNear ?? 0) > 0) return []
  const place: PlannedGoal = { kind: 'place', description: 'place 1 x furnace', targetItem: 'furnace', requiredCount: 1, protected: true }
  if (has(counts, 'furnace')) return [place]
  if ((knownFurnaces ?? 0) > 0) return []
  const craft: PlannedGoal = { kind: 'craft', description: 'craft 1 x furnace', targetItem: 'furnace', requiredCount: 1, protected: true }
  const stoneHave = countClass(counts, 'stone')
  if (stoneHave >= 8) return [craft, place]
  const need = Math.max(1, 8 - stoneHave)
  const collect: PlannedGoal = {
    kind: 'collect',
    description: `collect ${need} x cobblestone (furnace material)`,
    targetItem: 'cobblestone',
    requiredCount: need,
    protected: true,
  }
  return [collect, craft, place]
}

function withFurnacePrereq(
  goals: PlannedGoal[],
  counts: Counts,
  placedFurnacesNear: number | undefined,
  knownFurnaces: number | undefined = 0,
): PlannedGoal[] {
  if (!goals.some((goal) => goal.kind === 'smelt')) return goals
  if (goals.some((goal) => goal.targetItem === 'furnace')) return goals
  const prereq = furnacePrereqGoals(counts, placedFurnacesNear, knownFurnaces)
  return prereq.length === 0 ? goals : [...prereq, ...goals]
}

/** A rung's goals, with the predicate descent prerequisite prepended for
 * ore rungs whose ore is not held yet (#12, #41). */
export function rungGoalsWithPrereq(
  rung: Rung,
  c: Counts,
  w: ResidentWorldMemory,
  existingFrameBlocks?: number,
): PlannedGoal[] {
  const raw =
    rung.id === 'nether_portal' && existingFrameBlocks !== undefined
      ? netherPortalRungGoals(c, bestPickaxeRank(c), undefined, existingFrameBlocks)
      : rung.goals(c, w)
  const base = raw.map((goal) => (goal.core === true ? goal : { ...goal, core: true }))
  if (!needsOreDescent(rung.id, c)) return base
  const oreItem = ORE_RUNG_ITEM[rung.id]
  if (oreItem === undefined) return base
  return [oreDescentGoal(oreItem, w), ...base]
}

function withOreDescent(goals: PlannedGoal[], counts: Counts, world: ResidentWorldMemory): PlannedGoal[] {
  const oreItem =
    goals
      .map((goal) => goal.targetItem)
      .find((item): item is string => typeof item === 'string' && Object.values(ORE_RUNG_ITEM).includes(item)) ?? null
  if (oreItem === null) return goals
  if (!needsOreDescent(oreItem, counts)) return goals
  if (goals.some((goal) => goal.kind === 'descend')) return goals
  return [oreDescentGoal(oreItem, world), ...goals]
}

/**
 * A precondition is provably unsatisfiable only when the required ore is absent
 * from the inventory, the world memory and the current dimension. Anything else
 * is a replan, never a stop (#12).
 */
export function prerequisiteUnsatisfiable(
  rung: Rung,
  c: Counts,
  w: ResidentWorldMemory,
  dimension: string | null,
): string | null {
  const home = ORE_HOME[rung.id]
  if (home === undefined) return null
  if (dimension === null || dimension.includes('overworld')) return null
  const held = (c[home.item] ?? 0) > 0
  const known = w.discoveredOres.some((name) => name.includes(home.ore.replace('_ore', '')))
  if (held || known) return null
  return `${home.ore} is absent from inventory, world memory and dimension ${dimension}`
}

/** Unsatisfied executable rungs reachable right now. A rung whose precondition is
 * missing is still included: its goals follow the prerequisite goals in order, so
 * the emitted plan is the full chain rather than stopping at the missing rung. */
export function reachableUnsatisfiedRungs(c: Counts, w: ResidentWorldMemory): Rung[] {
  const out: Rung[] = []
  for (const rung of RUNGS) {
    if (rung.future === true || rung.satisfied(c, w)) continue
    out.push(rung)
  }
  return out
}

// inventory-aware ladder resume (#reset-inventory): `satisfied()` is not
// monotone (cobblestone/raw_iron do not satisfy the wood rung), so a reset must
// derive its starting rung from the LIVE inventory instead of assuming wood.
const USABLE_INVENTORY_SPECS: readonly string[] = [
  'log', 'planks', 'stone', 'fuel', 'pickaxe',
  'stick', 'raw_iron', 'iron_ingot', 'iron_ore', 'diamond', 'diamond_ore',
  'crafting_table', 'furnace',
]

/** True when an inventory item can advance the ladder (dirt/gravel cannot). */
export function isUsableInventoryItem(name: string): boolean {
  return USABLE_INVENTORY_SPECS.some((spec) => resourceMatches(name, spec))
}

/**
 * True only when the LIVE inventory holds no ladder-usable item. Requirement 2:
 * `invEmpty` must be computed from the live inventory, never assumed from an
 * `Object.keys(counts).length === 0` shortcut that also counts dirt/gravel.
 */
export function inventoryUsableEmpty(counts: Counts): boolean {
  for (const [name, n] of Object.entries(counts)) {
    if (n > 0 && isUsableInventoryItem(name)) return false
  }
  return true
}

/**
 * A rung is behind the resident when the capability it represents is implied by
 * higher-tier materials already in the live inventory. `satisfied()` alone is not
 * monotone: holding cobblestone does not satisfy the wood rung even though it
 * proves the wood tier (and its pickaxe) was already climbed.
 */
export function rungBehindInventory(rung: Rung, counts: Counts, world: ResidentWorldMemory): boolean {
  if (rung.satisfied(counts, world)) return true
  /**
   * A diamond pickaxe is a durable capability frontier, not merely one more
   * inventory item.  The current M2 contract starts at the diamond-to-Nether
   * transition; the furnace/charcoal/iron ladder is retained as a lower
   * prerequisite path and historical evidence.  Once the live inventory proves
   * the diamond-pickaxe frontier, a reset must not resurrect those historical
   * rungs just because their consumable markers are absent.
   *
   * This is capability closure, not semantic ranking: it only answers whether
   * an earlier executable rung is already behind the observed frontier.  It
   * never chooses among two current semantic Options.
   */
  const hasDiamondPickaxe = bestPickaxeRank(counts) >= 4 || has(counts, 'diamond_pickaxe')
  if (
    hasDiamondPickaxe &&
    new Set([
      'wood',
      'crafting_table',
      'wooden_pickaxe',
      'cobblestone',
      'furnace',
      'stone_pickaxe',
      'charcoal',
      'raw_iron',
      'iron_ingot',
      'iron_pickaxe',
    ]).has(rung.id)
  ) {
    return true
  }
  switch (rung.id) {
    case 'wood':
      return bestPickaxeRank(counts) >= 1 || countClass(counts, 'stone') >= 1
    case 'wooden_pickaxe':
      return countClass(counts, 'stone') >= 1 || bestPickaxeRank(counts) >= 2
    case 'stone_pickaxe':
      return (counts['raw_iron'] ?? 0) + (counts['iron_ingot'] ?? 0) >= 1 || bestPickaxeRank(counts) >= 3
    case 'cobblestone':
      return countClass(counts, 'stone') >= 8
    default:
      return false
  }
}

export interface ResumeRung {
  rungIndex: number
  rungId: string
  /** true only when the live inventory holds no usable item. */
  invEmpty: boolean
  /** the rung whose missing precondition forced a fallback, else null. */
  fallbackFrom: string | null
  fallbackNeed: string | null
}

/**
 * Inventory-aware resume rung for a ladder reset (death, disconnect, restart or a
 * stale ledger). Requirements: start at wood only when the live inventory is
 * genuinely empty of usable items; otherwise resume at the first rung that still
 * has work and whose preconditions hold, falling back one step (and logging) when
 * a precondition is missing so no ungrounded rung is ever resumed.
 */
export function deriveResumeRung(
  counts: Counts,
  world: ResidentWorldMemory,
  log?: (event: string, detail?: Record<string, unknown>) => void,
): ResumeRung {
  const first = executableRungs()[0]
  const woodId = first?.id ?? 'wood'
  if (inventoryUsableEmpty(counts)) {
    return { rungIndex: 0, rungId: woodId, invEmpty: true, fallbackFrom: null, fallbackNeed: null }
  }
  let candidate = -1
  for (let i = 0; i < RUNGS.length; i += 1) {
    const rung = RUNGS[i]
    if (rung === undefined || !isMandatoryRung(rung)) continue
    if (rungBehindInventory(rung, counts, world)) continue
    candidate = i
    break
  }
  if (candidate < 0) {
    return { rungIndex: RUNGS.length, rungId: 'complete', invEmpty: false, fallbackFrom: null, fallbackNeed: null }
  }
  const candidateRung = RUNGS[candidate]
  if (candidateRung === undefined) {
    return { rungIndex: 0, rungId: woodId, invEmpty: false, fallbackFrom: null, fallbackNeed: null }
  }
  const precondition = rungPrecondition(candidateRung, counts, world)
  if (precondition.ok) {
    return { rungIndex: candidate, rungId: candidateRung.id, invEmpty: false, fallbackFrom: null, fallbackNeed: null }
  }
  for (let j = candidate - 1; j >= 0; j -= 1) {
    const earlier = RUNGS[j]
    if (earlier === undefined || !isMandatoryRung(earlier)) continue
    if (earlier.satisfied(counts, world)) continue
    if (!rungPrecondition(earlier, counts, world).ok) continue
    log?.('LADDER_RESUME_FALLBACK', {
      from: candidateRung.id,
      need: precondition.need,
      to: earlier.id,
      rungIndex: j,
    })
    return { rungIndex: j, rungId: earlier.id, invEmpty: false, fallbackFrom: candidateRung.id, fallbackNeed: precondition.need }
  }
  log?.('LADDER_RESUME_FALLBACK', { from: candidateRung.id, need: precondition.need, to: woodId, rungIndex: 0 })
  return { rungIndex: 0, rungId: woodId, invEmpty: false, fallbackFrom: candidateRung.id, fallbackNeed: precondition.need }
}

/** The executable ladder as a goal list, gated by per-rung preconditions. */
export function buildLadder(
  counts: Counts,
  world: ResidentWorldMemory,
  log?: (event: string, detail?: Record<string, unknown>) => void,
  opts?: {
    dimension?: string | null
    placedFurnacesNear?: number
    knownFurnaces?: number
    resumeRungIndex?: number
    /** live required-edge blocks already present in the portal footprint */
    portalFrameBlocks?: number
    /** false = a floor query (#73): never invent the synthetic upkeep goal. */
    allowUpkeep?: boolean
  },
): Ladder {
  const goals: PlannedGoal[] = []
  const emittedIds = new Set<string>()
  const instanceId = (goal: PlannedGoal): string => stableOptionInstanceId(compilePlannedGoal(goal))
  let rungIndex = RUNGS.length
  let rungId = 'complete'
  let prereqReplaced = false
  let unsatisfiable: string | null = null
  for (let i = 0; i < RUNGS.length; i += 1) {
    const rung = RUNGS[i]
    if (rung === undefined || !isMandatoryRung(rung)) continue
    // Inventory-aware resume (#reset-inventory): rungs the live inventory already
    // put behind the resident are not re-planned, so a reset resumes at the right
    // rung instead of climbing from wood again.
    if (opts?.resumeRungIndex !== undefined && i < opts.resumeRungIndex) continue
    if (rung.satisfied(counts, world)) {
      if (log !== undefined) {
        for (const goal of rungGoalsWithPrereq(rung, counts, world, opts?.portalFrameBlocks)) {
          const item = goal.targetItem
          if (typeof item !== 'string') continue
          const have = countResource(counts, item)
          if (have <= 0) continue
          log('PRECONDITION_ALREADY_MET', {
            item,
            have,
            goal: goal.description,
            rungId: rung.id,
            action: 'skip',
          })
          break
        }
      }
      continue
    }
    const emitted = withFurnacePrereq(
      rungGoalsWithPrereq(rung, counts, world, opts?.portalFrameBlocks),
      counts,
      opts?.placedFurnacesNear,
      opts?.knownFurnaces,
    )
    const rungGoals = filterAlreadyMet(emitted, counts, rung.id, log)
    if (rungGoals.length === 0) continue
    if (rungIndex === RUNGS.length) {
      rungIndex = i
      rungId = rung.id
    }
    const description = rungGoalsWithPrereq(rung, counts, world, opts?.portalFrameBlocks)[0]?.description ?? rung.id
    const precondition = rungPrecondition(rung, counts, world)
    if (!precondition.ok) {
      const reason = prerequisiteUnsatisfiable(rung, counts, world, opts?.dimension ?? null)
      if (reason !== null) {
        unsatisfiable = reason
        log?.('PRECONDITION_UNSATISFIABLE', { goal: description, need: precondition.need, rungId: rung.id, reason })
        break
      }
      prereqReplaced = true
      log?.('PRECONDITION_MISSING', { goal: description, need: precondition.need, rungId: rung.id })
      // #prereq-order: DETECTING the missing prerequisite is not enough - it must
      // be ORDERED before the blocked rung goal. Insert the startable direct
      // prerequisite (code-owned preconditions) and drop any goal already emitted
      // by an earlier rung, so the queue head is the executable prerequisite.
      const completed = completeStartablePrerequisites(rungGoals, plannerReadinessSnapshot(counts, world))
      const ordered = completed.goals.filter((goal) => !emittedIds.has(instanceId(goal)))
      for (const goal of ordered) emittedIds.add(instanceId(goal))
      log?.('LADDER_PREREQ', {
        goal: description,
        need: precondition.need,
        rungId: rung.id,
        replace: ordered.map((goal) => goal.description),
      })
      for (const goal of ordered) goals.push(goal)
      continue
    }
    for (const goal of rungGoals) {
      emittedIds.add(instanceId(goal))
      goals.push(goal)
    }
  }
  if (goals.length === 0 && opts?.allowUpkeep !== false) {
    // Everything reachable is satisfied: keep the resident meaningfully busy.
    goals.push({ kind: 'collect', description: 'collect 16 x raw_iron (resident upkeep)', targetItem: 'raw_iron', requiredCount: 16 })
  }
  return {
    goals,
    rungIndex,
    rungId,
    futureRungIds: RUNGS.filter((rung) => rung.future === true).map((rung) => rung.id),
    prereqReplaced,
    unsatisfiable,
  }
}

/** Index/id of the first unsatisfied EXECUTABLE rung (the real progress frontier). */
export function computeFrontier(counts: Counts, world: ResidentWorldMemory): { rungIndex: number; rungId: string } {
  for (let i = 0; i < RUNGS.length; i += 1) {
    const rung = RUNGS[i]
    if (rung === undefined || !isMandatoryRung(rung)) continue
    // Frontier and resume must use the same capability-closure predicate. A
    // higher-tier capability (or a live world predicate such as a lit portal)
    // proves earlier rungs are behind the resident; checking only the rung's
    // local inventory predicate resurrects historical work after completion.
    if (!rungBehindInventory(rung, counts, world)) return { rungIndex: i, rungId: rung.id }
  }
  return { rungIndex: RUNGS.length, rungId: 'complete' }
}

export function debugFrontier(counts: Counts, world: ResidentWorldMemory): { rungIndex: number; rungId: string } {
  return computeFrontier(counts, world)
}

export function rungIndexById(id: string): number {
  return RUNGS.findIndex((rung) => rung.id === id)
}

export interface RungSourceOfTruth {
  plannerRungId: string
  plannerRungIndex: number
  ledgerRungId: string
  ledgerRungIndex: number
  adoptedRungId: string
  adoptedRungIndex: number
  mismatch: boolean
  source: 'ledger' | 'planner'
}

/**
 * Issue #73: the ladder ledger (`deriveResumeRung`) and the planner's naive
 * `computeFrontier` can disagree because `rung.satisfied` is not monotone: the
 * planner re-plans `wooden_pickaxe` while the ledger already put wood behind the
 * resident from higher-tier inventory. Adopt one deterministic rung here and log
 * `RUNG_MISMATCH` / `RUNG_ADOPT`, preferring the ledger whenever it names a real
 * rung (the inventory-backed source of truth the live HEARTBEAT reports).
 */
export function resolveRungSourceOfTruth(
  counts: Counts,
  world: ResidentWorldMemory,
  log?: (event: string, detail?: Record<string, unknown>) => void,
): RungSourceOfTruth {
  const planner = computeFrontier(counts, world)
  const ledger = deriveResumeRung(counts, world, log)
  const mismatch = planner.rungId !== ledger.rungId
  const adoptLedger = mismatch && ledger.rungId !== 'complete'
  const source: 'ledger' | 'planner' = adoptLedger ? 'ledger' : 'planner'
  const adoptedRungId = adoptLedger ? ledger.rungId : planner.rungId
  const adoptedRungIndex = adoptLedger ? ledger.rungIndex : planner.rungIndex
  if (mismatch) {
    log?.('RUNG_MISMATCH', { planner: planner.rungId, ledger: ledger.rungId, adopt: adoptedRungId })
    log?.('RUNG_ADOPT', { rung: adoptedRungId, source })
  }
  return {
    plannerRungId: planner.rungId,
    plannerRungIndex: planner.rungIndex,
    ledgerRungId: ledger.rungId,
    ledgerRungIndex: ledger.rungIndex,
    adoptedRungId,
    adoptedRungIndex,
    mismatch,
    source,
  }
}

export interface LadderFloor {
  rungId: string
  rungIndex: number
  goals: PlannedGoal[]
  supplied: boolean
}

/**
 * Issue #73: the deterministic ladder floor. From the adopted ledger rung it
 * returns the remaining executable steps with their prerequisite chain, without
 * any LLM call. When the rung is not `complete` but no step can be emitted it
 * logs `QUEUE_EMPTY_UNSUPPLIED`, so an empty queue supply is never silent.
 */
export function ladderFloorGoals(
  counts: Counts,
  world: ResidentWorldMemory,
  opts?: {
    resumeRungIndex?: number
    dimension?: string | null
    placedFurnacesNear?: number
    knownFurnaces?: number
    portalFrameBlocks?: number
    log?: (event: string, detail?: Record<string, unknown>) => void
  },
): LadderFloor {
  const resume =
    opts?.resumeRungIndex === undefined
      ? deriveResumeRung(counts, world, opts?.log)
      : {
          rungIndex: opts.resumeRungIndex,
          rungId: RUNGS[opts.resumeRungIndex]?.id ?? 'complete',
          invEmpty: false,
          fallbackFrom: null,
          fallbackNeed: null,
        }
  const ladder = buildLadder(counts, world, opts?.log, {
    dimension: opts?.dimension,
    placedFurnacesNear: opts?.placedFurnacesNear,
    knownFurnaces: opts?.knownFurnaces,
    portalFrameBlocks: opts?.portalFrameBlocks,
    resumeRungIndex: resume.rungIndex,
    allowUpkeep: false,
  })
  const supplied = ladder.goals.length > 0
  if (!supplied && resume.rungId !== 'complete') opts?.log?.('QUEUE_EMPTY_UNSUPPLIED', { rung: resume.rungId })
  return { rungId: resume.rungId, rungIndex: resume.rungIndex, goals: ladder.goals, supplied }
}

// ---------------------------------------------------------------------------
// candidate horizon plans (the bounded options the LLM chooses between)
// ---------------------------------------------------------------------------

export interface PlanOption {
  id: string
  title: string
  goals: PlannedGoal[]
  /** #20: grounded skills this option compiles to (dependencies first). */
  skills?: SkillCandidate[]
  /** #20: strategy id that produced this option, when one did. */
  strategy?: string
  strategyOption?: GroundedStrategyOption
}

export interface GroundedStrategyOption {
  readonly strategy: AdvisorStrategy
  readonly objective: {
    readonly targetItem: string | null
    readonly requiredCount: number | null
  }
  readonly goals: readonly PlannedGoal[]
  readonly skills: readonly SkillCandidate[]
}

function isAdvisorStrategy(value: string): value is AdvisorStrategy {
  return value === 'descend_to_y16' || value === 'explore_cave' || value === 'branch_mine' || value === 'return_to_known_ore' || value === 'smelt_and_craft'
}

/** Stable signature of a compiled goal list, for STRATEGY_BODY_DELTA (#29). */
export function goalSignature(goals: readonly PlannedGoal[]): string {
  return goals
    .map((goal) => `${goal.kind}:${goal.targetItem ?? goal.description}:${goal.requiredCount ?? 1}:${goal.strategy ?? 'untyped'}`)
    .join('|')
}

/** Adapter options for skill generation from the resident world/bot projection. */
export interface SkillAdapterOptions {
  position?: Vec3Json | null
  dimension?: string | null
  health?: number | null
  toolRank?: number
  goal?: SkillGoal | null
  lastTunnel?: Vec3Json | null
  digDir?: string | null
}

/** Convert one PlannedGoal into the skill-generation goal subset. */
export function plannedGoalToSkillGoal(goal: PlannedGoal | undefined): SkillGoal | null {
  if (goal === undefined) return null
  const skillGoal: SkillGoal = { kind: goal.kind }
  if (typeof goal.targetItem === 'string') skillGoal.targetItem = goal.targetItem
  if (typeof goal.requiredCount === 'number') skillGoal.requiredCount = goal.requiredCount
  if (typeof goal.targetY === 'number') skillGoal.targetY = goal.targetY
  if (typeof goal.dimension === 'string') skillGoal.dimension = goal.dimension
  return skillGoal
}

/** Build the pure generation input from counts + durable world memory + bot state. */
export function buildSkillGenerationInput(
  strategy: string | null,
  counts: Counts,
  world: ResidentWorldMemory,
  opts?: SkillAdapterOptions,
): SkillGenerationInput {
  return {
    strategy,
    goal: opts?.goal ?? null,
    inventory: counts,
    world: {
      knownResources: world.knownResources,
      craftingTables: world.craftingTables,
      furnaces: world.furnaces,
      discoveredOres: world.discoveredOres,
    },
    position: opts?.position ?? null,
    dimension: opts?.dimension ?? null,
    health: opts?.health ?? null,
    toolRank: opts?.toolRank ?? bestPickaxeRank(counts),
    lastTunnel: opts?.lastTunnel ?? null,
    digDir: opts?.digDir ?? null,
  }
}

/**
 * Issue #20: compile a strategy into its grounded skills. Deterministic and
 * model-free; unmet preconditions expand into the prerequisite skill chain.
 */
export function skillsForStrategy(
  strategy: string,
  counts: Counts,
  world: ResidentWorldMemory,
  opts?: SkillAdapterOptions,
): SkillCandidate[] {
  if (!isAdvisorStrategy(strategy)) return generateSkillPlan(buildSkillGenerationInput(strategy, counts, world, opts)).skills
  return [...compileStrategyOption(strategy, counts, world, opts === undefined ? undefined : { skill: opts }).skills]
}

function dedupeOptions(options: PlanOption[]): PlanOption[] {
  const seen = new Set<string>()
  const out: PlanOption[] = []
  for (const option of options) {
    if (option.goals.length === 0) continue
    const signature = goalSignature(option.goals)
    if (seen.has(signature)) continue
    seen.add(signature)
    out.push(option)
    if (out.length >= 4) break
  }
  return out
}

/** Deterministic, grounded options. Option 0 is always the ladder front (fallback). */
export function buildPlanOptions(
  counts: Counts,
  world: ResidentWorldMemory,
  opts?: {
    placedFurnacesNear?: number
    knownFurnaces?: number
    resumeRungIndex?: number
    portalFrameBlocks?: number
    /**
     * Live hunger bar. Supplied by the caller because `satisfied(counts, world)`
     * cannot see it. The survival `food` option is offered only when hunger is at
     * or below `eatBelowFood`, so it can never crowd the M2/M3 road when fed.
     */
    foodLevel?: number | null
    /** The eat gate the candidate layer uses (candidates.ts default 18). */
    eatBelowFood?: number
    log?: (event: string, detail?: Record<string, unknown>) => void
  },
): PlanOption[] {
  const planGoals = (rung: Rung): PlannedGoal[] =>
    filterAlreadyMet(
      withFurnacePrereq(
        rungGoalsWithPrereq(rung, counts, world, opts?.portalFrameBlocks),
        counts,
        opts?.placedFurnacesNear,
        opts?.knownFurnaces,
      ),
      counts,
      rung.id,
      opts?.log,
    )
  const allUnsat = reachableUnsatisfiedRungs(counts, world)
  const unsat = allUnsat.filter(
    (rung) => opts?.resumeRungIndex === undefined || rungIndexById(rung.id) >= opts.resumeRungIndex,
  )
  // Optional rungs stay selectable regardless of the resume cursor: a resume
  // cursor points at mandatory progress, and an optional side quest the live
  // inventory never completed must remain an Option (Mercury/Jev choice) without
  // being a prerequisite of anything.
  const optionalUnsat = allUnsat.filter((rung) => rung.optional === true)
  if (unsat.length === 0 && optionalUnsat.length === 0) {
    return [
      {
        id: 'upkeep',
        title: 'resident upkeep',
        goals: [{ kind: 'collect', description: 'collect 16 x raw_iron (resident upkeep)', targetItem: 'raw_iron', requiredCount: 16 }],
      },
    ]
  }
  // The mandatory road: optional rungs never appear in a prerequisite chain.
  const mandatory = unsat.filter((rung) => rung.optional !== true)
  const options: PlanOption[] = []
  const first = mandatory[0]
  if (first !== undefined) {
    options.push({ id: `front_${first.id}`, title: `next milestone: ${first.id}`, goals: planGoals(first) })
  }
  // Survival affordance: offered only while the body is hungry, and before the
  // long-horizon options, because the option list is bounded to four. It is
  // optional (never gates diamond/portal/Nether) and self-contained (inherits no
  // milestone goals), so it cannot dominate the M2/M3 road when the body is fed.
  const eatBelowFood = opts?.eatBelowFood ?? 18
  const foodLevel = opts?.foodLevel ?? null
  const foodRung = optionalUnsat.find((rung) => rung.id === 'food')
  if (foodRung !== undefined && foodLevel !== null && foodLevel <= eatBelowFood) {
    const foodGoals = planGoals(foodRung)
    if (foodGoals.length > 0) options.push({ id: 'food', title: 'optional: get food (survival)', goals: foodGoals })
  }
  const two = mandatory.slice(0, 2).flatMap((rung) => planGoals(rung))
  if (two.length > 0) options.push({ id: 'two_rungs', title: `next two milestones (${mandatory.slice(0, 2).map((r) => r.id).join(' + ')})`, goals: two })
  const ironIndex = mandatory.findIndex((rung) => rung.id === 'iron_pickaxe')
  if (ironIndex >= 0) {
    const iron = mandatory.slice(0, ironIndex + 1).flatMap((rung) => planGoals(rung))
    if (iron.length > 0) options.push({ id: 'finish_iron_age', title: 'finish the iron age (raw_iron -> iron_ingot -> iron_pickaxe)', goals: iron })
  }
  for (const rung of optionalUnsat) {
    // `food` is handled above: it is hunger-gated and deliberately short.
    if (rung.id === 'food') continue
    const optionalIndex = rungIndexById(rung.id)
    // Mandatory predecessors follow the resume cursor (no re-planning rungs the
    // live inventory already put behind the resident); the optional rung itself
    // is appended so it stays selectable even when the cursor has moved past it.
    // A self-contained affordance (survival `food`) inherits no predecessors.
    const predecessors =
      rung.selfContained === true
        ? []
        : unsat.filter((candidate) => candidate.optional !== true && rungIndexById(candidate.id) <= optionalIndex)
    const gear = [...predecessors, rung].flatMap((candidate) => planGoals(candidate))
    if (gear.length > 0) options.push({ id: rung.id, title: `optional: ${rung.id}`, goals: gear })
  }
  const diamondIndex = mandatory.findIndex((rung) => rung.id === 'diamond_pickaxe')
  if (diamondIndex >= 0) {
    const diamond = mandatory.slice(0, diamondIndex + 1).flatMap((rung) => planGoals(rung))
    if (diamond.length > 0) options.push({ id: 'diamond_road', title: 'push to diamond + diamond_pickaxe', goals: diamond })
  }
  const whole = mandatory.flatMap((rung) => planGoals(rung))
  if (whole.length > 0) options.push({ id: 'full_ladder', title: 'the whole remaining ladder', goals: whole })
  const deduped = dedupeOptions(options)
  if (deduped.length === 0) {
    const front = first ?? unsat[0]
    if (front !== undefined) deduped.push({ id: `front_${front.id}`, title: `next milestone: ${front.id}`, goals: planGoals(front) })
  }
  return deduped
}

const UPKEEP_GOAL: PlannedGoal = {
  kind: 'collect',
  description: 'collect 16 x raw_iron (resident upkeep)',
  targetItem: 'raw_iron',
  requiredCount: 16,
}

const FRONT_FALLBACK: PlanOption = { id: 'front_fallback', title: 'deterministic ladder front', goals: [UPKEEP_GOAL] }

function rejectionPlan(note: string): System2Plan {
  return { goals: [], note: `REPLAN_REJECTED no_body_delta (${note})`, op: 'continue' as PlanOp }
}

export interface PlanTailDecision {
  goal: string
  action: 'kept' | 'skipped'
  reason: string
}

export interface NormalizedPlanTail {
  goals: PlannedGoal[]
  decisions: PlanTailDecision[]
}

/**
 * #30: a Mercury `patch` may redundantly repeat the active goal as its first
 * item. `GoalQueue.applyPlan(..., 'patch')` keeps the active goal, so the
 * repeated head must be stripped and the REST of the tail applied - never the
 * whole repair turned into `continue []`. Every drop is reported (PLAN_TAIL).
 * `replace` is never downgraded and never dedupes its head.
 */
export function normalizePlanTail(
  goals: readonly PlannedGoal[],
  current: { kind: string; targetItem?: string | null; requiredCount?: number } | null,
  op: PlanOp,
): NormalizedPlanTail {
  const decisions: PlanTailDecision[] = []
  const kept: PlannedGoal[] = []
  const seen = new Set<string>()
  for (let index = 0; index < goals.length; index += 1) {
    const goal = goals[index]
    if (goal === undefined) continue
    const label = goal.description
    const count = Math.max(1, Math.floor(goal.requiredCount ?? 1))
    const duplicateActive =
      op === 'patch' &&
      index === 0 &&
      current !== null &&
      goal.kind === current.kind &&
      (goal.targetItem ?? null) === (current.targetItem ?? null) &&
      count === Math.max(1, Math.floor(current.requiredCount ?? 1))
    if (duplicateActive) {
      decisions.push({ goal: label, action: 'skipped', reason: 'duplicate_active' })
      continue
    }
    const signature = `${goal.kind}|${goal.targetItem ?? ''}|${count}`
    if (seen.has(signature)) {
      decisions.push({ goal: label, action: 'skipped', reason: 'duplicate_in_plan' })
      continue
    }
    seen.add(signature)
    kept.push(goal)
    decisions.push({ goal: label, action: 'kept', reason: 'applied' })
  }
  return { goals: kept, decisions }
}

/**
 * A replan that MUST change the body (#43 follow-up): its first goal is the
 * nearest unsatisfied ore rung's descent+ore chain, or a stone-collection
 * descent, so the compiled candidates change position / resource source
 * (branch mine, ore descent, known-resource retrieval) instead of re-issuing
 * the blocked front goal. Deterministic; no LLM.
 */
export function buildBodyChangeOption(
  counts: Counts,
  world: ResidentWorldMemory,
  opts?: {
    placedFurnacesNear?: number
    knownFurnaces?: number
    resumeRungIndex?: number
    portalFrameBlocks?: number
    log?: (event: string, detail?: Record<string, unknown>) => void
  },
): PlanOption {
  const unsat = reachableUnsatisfiedRungs(counts, world).filter(
    (rung) =>
      rung.optional !== true &&
      (opts?.resumeRungIndex === undefined || rungIndexById(rung.id) >= opts.resumeRungIndex),
  )
  const planGoals = (rung: Rung): PlannedGoal[] =>
    filterAlreadyMet(
      withFurnacePrereq(
        rungGoalsWithPrereq(rung, counts, world, opts?.portalFrameBlocks),
        counts,
        opts?.placedFurnacesNear,
        opts?.knownFurnaces,
      ),
      counts,
      rung.id,
      opts?.log,
    )
  const goals: PlannedGoal[] = []
  const pushUnique = (goal: PlannedGoal): void => {
    if (goals.some((existing) => existing.kind === goal.kind && existing.targetItem === goal.targetItem)) return
    goals.push(goal)
  }
  const oreRung = unsat.find((rung) => ORE_RUNG_ITEM[rung.id] !== undefined)
  if (oreRung !== undefined) for (const goal of planGoals(oreRung)) pushUnique(goal)
  const front = unsat[0]
  if (front !== undefined && front.id !== oreRung?.id) for (const goal of planGoals(front)) pushUnique(goal)
  if (goals.length === 0) pushUnique(oreDescentGoal('raw_iron', world))
  return { id: `body_change_${front?.id ?? 'upkeep'}`, title: `body-changing replan toward ${oreRung?.id ?? front?.id ?? 'ore'}`, goals }
}

/** Localized policy for the deterministic upper-access recovery horizon. */
export interface UpperAccessRecoveryPolicy {
  /** minimum rise above the live y before the recovery horizon is offered */
  minRiseBlocks: number
  /** bounded rise used when no remembered upper-region feature exists above the bot */
  boundedRiseBlocks: number
  /** blocks above the highest remembered upper-region feature to target */
  marginBlocks: number
}

export const DEFAULT_UPPER_ACCESS_RECOVERY_POLICY: UpperAccessRecoveryPolicy = {
  minRiseBlocks: 8,
  boundedRiseBlocks: 64,
  marginBlocks: 1,
}

/** Highest remembered y used only as an upper-region navigation hint, never as surface proof. */
export function highestRememberedUpperRegionY(world: ResidentWorldMemory): number | null {
  let best: number | null = null
  for (const resource of world.knownResources) {
    if (best === null || resource.y > best) best = resource.y
  }
  for (const station of [...world.craftingTables, ...world.furnaces]) {
    if (best === null || station.y > best) best = station.y
  }
  return best
}

/** Deterministic upper-region navigation hint: remembered y + margin, else a bounded rise. */
export function deriveUpperAccessTargetY(
  world: ResidentWorldMemory,
  botY: number,
  policy: UpperAccessRecoveryPolicy = DEFAULT_UPPER_ACCESS_RECOVERY_POLICY,
): number {
  const remembered = highestRememberedUpperRegionY(world)
  if (remembered !== null && remembered > botY + policy.minRiseBlocks) return Math.floor(remembered) + policy.marginBlocks
  return Math.floor(botY) + policy.boundedRiseBlocks
}

/**
 * A queue goal for vertical recovery. The target Y is only a navigation hint;
 * completion also requires the explicit log resource predicate in the
 * controller/Option compiler. It is deliberately not a surface assertion.
 */
export function upperAccessRecoveryGoal(
  world: ResidentWorldMemory,
  botY: number,
  policy: UpperAccessRecoveryPolicy = DEFAULT_UPPER_ACCESS_RECOVERY_POLICY,
): PlannedGoal {
  const targetY = deriveUpperAccessTargetY(world, botY, policy)
  return {
    kind: 'surface',
    strategy: 'return_to_surface',
    description: `recover vertical access to y>=${targetY} and collect 1 x log`,
    targetItem: 'log',
    requiredCount: 1,
    targetY,
  }
}

export function buildUpperAccessRecoveryOption(
  world: ResidentWorldMemory,
  botY: number,
  policy: UpperAccessRecoveryPolicy = DEFAULT_UPPER_ACCESS_RECOVERY_POLICY,
): PlanOption {
  return {
    id: 'recover_vertical_access',
    title: `recover vertical access and collect a log (y>=${deriveUpperAccessTargetY(world, botY, policy)})`,
    goals: [upperAccessRecoveryGoal(world, botY, policy)],
    strategy: 'return_to_surface',
  }
}

/** True when upper-access recovery is a meaningful alternative at this altitude. */
export function upperAccessRecoveryApplies(
  world: ResidentWorldMemory,
  botY: number,
  policy: UpperAccessRecoveryPolicy = DEFAULT_UPPER_ACCESS_RECOVERY_POLICY,
): boolean {
  return deriveUpperAccessTargetY(world, botY, policy) > botY + policy.minRiseBlocks
}

/**
 * Map a strategy id chosen by the upper LLM onto a bounded, grounded goal list.
 * This is the ONLY thing the LLM influences: System One still decides every
 * action, and every goal maps to an existing candidate kind.
 */
export function goalsForStrategy(
  strategy: AdvisorStrategy,
  counts: Counts,
  world: ResidentWorldMemory,
  opts?: { placedFurnacesNear?: number; knownFurnaces?: number; portalFrameBlocks?: number },
): PlannedGoal[] {
  return compileStrategyGoals(strategy, counts, world, opts)
}

function compileStrategyGoals(
  strategy: AdvisorStrategy,
  counts: Counts,
  world: ResidentWorldMemory,
  opts?: { placedFurnacesNear?: number; knownFurnaces?: number; portalFrameBlocks?: number },
): PlannedGoal[] {
  const rank = bestPickaxeRank(counts)
  const ladderFront = buildLadder(counts, world, undefined, opts).goals
  const stone = (n: number): PlannedGoal => ({ kind: 'collect', description: `collect ${n} x cobblestone`, targetItem: 'cobblestone', requiredCount: n })
  const iron = (n: number): PlannedGoal => ({ kind: 'collect', description: `collect ${n} x raw_iron`, targetItem: 'raw_iron', requiredCount: n })
  const chosen = (goals: PlannedGoal[]): PlannedGoal[] =>
    withFurnacePrereq(withOreDescent(goals, counts, world), counts, opts?.placedFurnacesNear, opts?.knownFurnaces).map((goal) => ({
      ...goal,
      strategy,
    }))
  const ladder = (goals: PlannedGoal[]): PlannedGoal[] => goals.map((goal) => ({ ...goal, strategy }))
  switch (strategy) {
    case 'descend_to_y16':
      return rank < 1 ? ladder(ladderFront) : chosen([descendGoal(16, 'raw_iron'), iron(3)])
    case 'explore_cave':
      return rank < 1 ? ladder(ladderFront) : rank < 2 ? chosen([stone(16)]) : chosen([stone(12), iron(3)])
    case 'branch_mine':
      return rank < 1 ? ladder(ladderFront) : rank < 2 ? chosen([stone(32)]) : chosen([stone(24), iron(3)])
    case 'return_to_known_ore':
      return rank < 2 ? (rank < 1 ? ladder(ladderFront) : chosen([stone(16)])) : chosen([iron(3)])
    case 'smelt_and_craft':
      return chosen(ladderFront)
  }
}

function strategyObjective(goals: readonly PlannedGoal[]): GroundedStrategyOption['objective'] {
  const target = [...goals].reverse().find((goal) => typeof goal.targetItem === 'string')
  return {
    targetItem: target?.targetItem ?? null,
    requiredCount: target?.requiredCount ?? null,
  }
}

export function compileStrategyOption(
  strategy: AdvisorStrategy,
  counts: Counts,
  world: ResidentWorldMemory,
  opts?: {
    placedFurnacesNear?: number
    knownFurnaces?: number
    skill?: SkillAdapterOptions
  },
): GroundedStrategyOption {
  const goals = compileStrategyGoals(strategy, counts, world, opts)
  const skillInput = buildSkillGenerationInput(strategy, counts, world, {
    ...(opts?.skill ?? {}),
    goal: opts?.skill?.goal ?? plannedGoalToSkillGoal(goals[0]),
  })
  return {
    strategy,
    objective: strategyObjective(goals),
    goals,
    skills: generateSkillPlan(skillInput).skills,
  }
}

// ---------------------------------------------------------------------------
// compact state + question set for the bounded Jev call
// ---------------------------------------------------------------------------

const HORIZON_INSTRUCTIONS =
  'You are the high-level planner for a Minecraft bot (player AI_Buddy) that must progress ' +
  'from spawn all the way to defeating the Ender Dragon, with no human instructions. Choose ' +
  'exactly ONE plan id from the horizon list: the best next horizon of high-level goals. ' +
  'Every plan id is already grounded in what the bot actually has and in recipes that exist. ' +
  'Answer with the id verbatim; never invent an id. Prefer the shortest plan that removes the ' +
  "bot's current blocker, and only choose a long plan when the prerequisites are already held."

const PLAN_FIT_INSTRUCTIONS =
  'How well does the chosen horizon plan fit the current world state and inventory? Use the ' +
  'ordered levels from poor to excellent.'

const STRATEGY_INSTRUCTIONS =
  'Does the bot need to change strategy (a different plan than the one it has been pursuing) ' +
  'because the current approach is failing or blocked?'

const PLAN_FIT_LEVELS = ['poor fit', 'weak fit', 'reasonable fit', 'good fit', 'excellent fit'] as const

type EvaluateArgs = Parameters<typeof evaluate>[0]
type EvaluationState = EvaluateArgs['state']
type EvaluationQuestion = Experimental_EvaluationQuestion

const COST_PER_TOKEN_USD = 0.04 / 1_000_000 // gateway input rate documented for typesafe-ai/jev

interface LlmChoice {
  optionId: string
  latencyMs: number
  costUsd: number
  planFit: number | null
  strategyChange: boolean | null
  /** #32: raw P(strategy_change=true); kept alongside the derived boolean */
  strategyChangeProbability: number | null
  unknownChoice: string | null
}

function member(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined
  return (source as Record<string, unknown>)[key]
}

function readChoice(answer: unknown): string | null {
  const value = member(answer, 'choice')
  return typeof value === 'string' ? value : null
}

function readScore(answer: unknown): number | null {
  const value = member(answer, 'score')
  return typeof value === 'number' ? value : null
}

/**
 * #32: the raw strategy_change P(true), never collapsed. The derived boolean is
 * computed at the named threshold and both are logged, so calibration data (and
 * a 0.08 vs 0.49 distinction) survives API parse -> internal result -> JSONL.
 */
export function readBooleanProbability(answer: unknown): number | null {
  const value = member(answer, 'probability')
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export const STRATEGY_CHANGE_THRESHOLD_DEFAULT = 0.5

/** `BUDDY_STRATEGY_CHANGE_THRESHOLD` overrides the named strategy_change threshold. */
export function resolveStrategyChangeThreshold(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = Number(env.BUDDY_STRATEGY_CHANGE_THRESHOLD ?? STRATEGY_CHANGE_THRESHOLD_DEFAULT)
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : STRATEGY_CHANGE_THRESHOLD_DEFAULT
}

function isRateLimitError(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== 'object' || error === null) return false
  const record = error as Record<string, unknown>
  if (record.statusCode === 429) return true
  const name = record.name
  if (typeof name === 'string' && name.includes('RateLimit')) return true
  if (isRateLimitError(record.lastError, depth + 1)) return true
  if (isRateLimitError(record.cause, depth + 1)) return true
  const errors = record.errors
  return Array.isArray(errors) && errors.some((entry) => isRateLimitError(entry, depth + 1))
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  try {
    return JSON.stringify(error)
  } catch {
    return '<unserialisable>'
  }
}

// ---------------------------------------------------------------------------
// the planner brain
// ---------------------------------------------------------------------------

/** #33: planner cache schema/contract version. Bump when PlanOption semantics change. */
export const PLANNER_CACHE_SCHEMA_VERSION = 2
const PLANNER_CACHE_FILE_VERSION = 2

/** World identity that namespaces the durable planner cache (#33). */
export interface PlannerWorldKey {
  serverId: string
  dimension: string
  worldEpoch: number
}

export function plannerWorldKeyString(key: PlannerWorldKey): string {
  return `${key.serverId}|${key.dimension}|${key.worldEpoch}`
}

/**
 * #33: hash of the capability/rung-set contract. If RUNGS changes (an option id
 * keeps its name but its goals change), the hash changes and old cache entries
 * are invalidated instead of being reinterpreted under the new semantics.
 */
export function plannerCapabilityHash(): string {
  const contract = RUNGS.map((rung) => `${rung.id}${rung.future === true ? ':future' : ''}${rung.optional === true ? ':optional' : ''}`).join(',')
  return createHash('sha1').update(contract).digest('hex').slice(0, 16)
}

export interface PlannerCacheIdentity {
  worldKey: string
  worldEpoch: number
  schemaVersion: number
  capabilityHash: string
}

export interface PlannerCacheEntry {
  optionId: string
  worldKey: string
  schemaVersion: number
  capabilityHash: string
  costUsd: number
  ts: number
}

interface PlannerCacheFile {
  version: typeof PLANNER_CACHE_FILE_VERSION
  /** #33 semantic namespace identity; any mismatch invalidates the whole file. */
  worldKey: string
  worldEpoch: number
  schemaVersion: number
  capabilityHash: string
  lastCallAt: number
  entries: Record<string, PlannerCacheEntry>
}

const MAX_CACHE_ENTRIES = 80

function emptyCache(identity: PlannerCacheIdentity): PlannerCacheFile {
  return {
    version: PLANNER_CACHE_FILE_VERSION,
    worldKey: identity.worldKey,
    worldEpoch: identity.worldEpoch,
    schemaVersion: identity.schemaVersion,
    capabilityHash: identity.capabilityHash,
    lastCallAt: 0,
    entries: {},
  }
}

/**
 * #33: the durable planner cache key. It mixes the world identity
 * (serverId|dimension|worldEpoch), the planner schema version and the
 * capability/rung-set hash with the live state, so a world reset, a dimension
 * change or a changed option contract can never serve a stale plan.
 */
export function plannerStateHash(
  counts: Counts,
  world: ResidentWorldMemory,
  objective: { targetItem: string; haveCount: number },
  identity: PlannerCacheIdentity,
  portalFrameBlocks: number = 0,
): string {
  const stable: Record<string, number> = {}
  for (const [name, n] of Object.entries(counts)) if (n > 0) stable[name] = n
  const payload = {
    world: identity.worldKey,
    worldEpoch: identity.worldEpoch,
    schemaVersion: identity.schemaVersion,
    capabilityHash: identity.capabilityHash,
    inventory: stable,
    frontier: computeFrontier(counts, world).rungId,
    stations: { tables: world.craftingTables.length, furnaces: world.furnaces.length },
    portalFrameBlocks,
    ores: [...world.discoveredOres].sort(),
    objective: objective.targetItem,
    objectiveHave: objective.haveCount,
  }
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
}

export interface PlannerOptions {
  bot: Bot
  world: ResidentWorldMemory
  log: (event: string, detail?: Record<string, unknown>) => void
  /** where the durable plan cache is mirrored (JSON, tmp -> rename). */
  cachePath: string
  /** #33: world identity (serverId|dimension|worldEpoch) namespacing the cache. */
  worldKey?: PlannerWorldKey
  /** override the env switch (tests / explicit wiring). */
  mode?: PlannerMode
  /** minimum spacing between real LLM calls. */
  minIntervalMs?: number
  /** per-call timeout. */
  timeoutMs?: number
  model?: string
  /** hard cap on LLM calls in this generation's lifetime. */
  maxCalls?: number
  /** P1.5 advisor; when present it supplies the next strategy on a stall. */
  advisor?: Advisor
  /**
   * Mercury 2.5 System2Brain for EXCEPTION-DRIVEN plan repair. When present it
   * takes precedence over the Jev advisor on a stall and falls back immediately
   * to the deterministic ladder on any failure. Explicitly enabled only.
   */
  mercury?: MercurySystem2
  /** true when this generation was created fresh because the bot died. */
  postDeathRecovery?: boolean
  /** bound on planner model attempts (default `BUDDY_PLANNER_MAX_ATTEMPTS` or 3) */
  maxAttempts?: number
  /** resident process terminator; absent in tests (the fatal error is thrown) */
  terminate?: () => never
  /** Refresh live server predicates before grounding a System2 request. */
  refreshLiveFacts?: () => void
  /** key resolver seam for tests; defaults to `resolveJevApiKey` */
  resolveKey?: () => KeyResolution | null
}

type PlannerReason = 'start' | 'queue_empty' | 'impossible' | 'stuck'

function mapReason(request: System2PlanRequest, firstCall: boolean): PlannerReason {
  if (firstCall && request.goalQueueState.depth === 0 && request.goalQueueState.done === 0) return 'start'
  if (request.reason === 'action_impossible') return 'impossible'
  if (request.reason === 'no_progress' || request.reason === 'need_llm' || request.reason === 'unknown_situation') return 'stuck'
  return 'queue_empty'
}

function trailingWaitStreak(outcomes: readonly System2Outcome[]): number {
  let streak = 0
  for (let i = outcomes.length - 1; i >= 0; i -= 1) {
    const outcome = outcomes[i]
    if (outcome === undefined || outcome.actionId !== 'WAIT') break
    streak += 1
  }
  return streak
}

function advisorReasonFor(reason: PlannerReason, waitStreak: number): AdvisorReason | null {
  if (waitStreak >= 3) return 'wait_limit'
  if (reason === 'impossible') return 'no_candidate'
  if (reason === 'stuck') return 'no_progress'
  return null
}

/**
 * A drained queue is the moment the next WHAT is decided. On the live planner path
 * (`advisorReasonFor` -> `mercuryTriggerFor`) that moment mapped to `null`, so the
 * next goal was chosen only from the ladder's fixed option menu and goals the menu
 * cannot express ("find obsidian where lava meets water", "stock food before the
 * Nether", "build the return portal") were never proposed; the frontier flapped
 * between menu entries while Mercury's `explore_cave` repair was the only proposal
 * pointing anywhere useful (live #359).
 *
 * Mapping it to `no_candidate` opens that space. `EMPTY_QUEUE_CONSULT_COOLDOWN_MS`
 * keeps the rate bounded so an unchanged situation cannot spend the hourly semantic
 * budget linearly (the 0dd100b lesson); the gate is a cooldown, not a veto - a real
 * situation change after it may consult again.
 */
const EMPTY_QUEUE_CONSULT_COOLDOWN_MS = 10 * 60_000

/**
 * The resident high-level planner. It is constructed per generation and handed to
 * `JevController.setSystem2()`. The controller calls `plan()` only on replan
 * boundaries (queue empty / goal impossible / stall), never on the hot path.
 */
export class PlannerBrain implements System2Brain {
  readonly model: string
  private readonly bot: Bot
  /** Live world-truth refresh (dimension / portal verdict) injected by the host. */
  private readonly refreshLiveFacts?: () => void
  /** dedupe for the PLAN_REASON diagnosis (#359) */
  private lastLoggedPlanReason: string | null = null
  /** last drained-queue semantic consultation (bounded by EMPTY_QUEUE_CONSULT_COOLDOWN_MS) */
  private lastEmptyQueueConsultMs = 0
  private readonly world: ResidentWorldMemory
  private readonly log: (event: string, detail?: Record<string, unknown>) => void
  private readonly cachePath: string
  private readonly worldKey: PlannerWorldKey
  private readonly cacheIdentity: PlannerCacheIdentity
  readonly mode: PlannerMode
  private readonly minIntervalMs: number
  private readonly timeoutMs: number
  private readonly maxCalls: number
  private cache: PlannerCacheFile
  private calls = 0
  private firstCall = true
  private lastMilestoneId: string | null = null
  private readonly advisor: Advisor | undefined
  private readonly mercury: MercurySystem2 | undefined
  private readonly postDeathRecovery: boolean
  private readonly maxAttempts: number
  private readonly terminate: (() => never) | undefined
  private readonly resolveKey: () => KeyResolution | null
  private postDeathHandled = false
  private lastAdvisorStrategy: AdvisorStrategy | null = null
  private lastAdvisorSignature: string | null = null
  private lastBodySignature: string | null = null
  private lastBodyGoals: PlannedGoal[] = []
  private currentCounts: Counts = {}
  private currentPortalFrameBlocks = 0
  private adoptedRungId = 'wood'

  constructor(options: PlannerOptions) {
    this.bot = options.bot
    this.refreshLiveFacts = options.refreshLiveFacts
    this.world = options.world
    this.log = options.log
    this.cachePath = options.cachePath
    this.worldKey = options.worldKey ?? {
      serverId: 'local',
      dimension: this.bot.game?.dimension ?? 'unknown',
      worldEpoch: 0,
    }
    this.cacheIdentity = {
      worldKey: plannerWorldKeyString(this.worldKey),
      worldEpoch: this.worldKey.worldEpoch,
      schemaVersion: PLANNER_CACHE_SCHEMA_VERSION,
      capabilityHash: plannerCapabilityHash(),
    }
    this.mode = options.mode ?? resolvePlannerMode()
    this.minIntervalMs = options.minIntervalMs ?? Number(process.env.BUDDY_PLANNER_MIN_INTERVAL_MS ?? 45000)
    this.timeoutMs = options.timeoutMs ?? Number(process.env.BUDDY_PLANNER_TIMEOUT_MS ?? 9000)
    this.maxCalls = options.maxCalls ?? Number(process.env.BUDDY_PLANNER_MAX_CALLS ?? 200)
    this.model = options.model ?? process.env.BUDDY_PLANNER_MODEL ?? process.env.AI_GATEWAY_MODEL ?? DEFAULT_JEV_MODEL
    this.advisor = options.advisor
    this.mercury = options.mercury
    this.postDeathRecovery = options.postDeathRecovery === true
    this.maxAttempts = options.maxAttempts ?? Number(process.env.BUDDY_PLANNER_MAX_ATTEMPTS ?? 3)
    this.terminate = options.terminate
    this.resolveKey = options.resolveKey ?? resolveJevApiKey
    this.cache = this.loadCache()
  }

  async plan(request: System2PlanRequest): Promise<System2Plan> {
    const started = Date.now()
    // Refresh the live world facts BEFORE the rung evaluation and the plan build.
    // This planner declares `refreshLiveFacts` but never called it (the newer
    // PlannerBrain does), so `this.world.dimension` / `this.world.portalVerified`
    // stayed at their pre-transfer values. Live (M3 hand-off): the body stood in
    // the Nether, the world key was minecraft:the_nether and the plan already
    // carried the blaze/pearl goals, yet the `nether_portal` rung was still
    // evaluated as unsatisfied, the frontier stayed on rung 13 and every re-plan
    // re-issued the light/entry row, so the bot re-ignited an already-lit portal
    // thousands of times instead of starting the M3 goals.
    this.refreshLiveFacts?.()
    const counts = inventoryCounts(this.bot)
    this.currentCounts = counts
    this.currentPortalFrameBlocks = this.bot.entity === undefined ? 0 : countSensedPortalFrameBlocks(this.bot)
    this.log('PORTAL_FRAME_PROGRESS', { blocks: this.currentPortalFrameBlocks })
    const rung = resolveRungSourceOfTruth(counts, this.world, this.log)
    this.adoptedRungId = rung.adoptedRungId
    const options = buildPlanOptions(counts, this.world, {
      placedFurnacesNear: this.placedFurnacesNear(),
      knownFurnaces: this.world.furnaces.length,
      resumeRungIndex: rung.adoptedRungIndex,
      portalFrameBlocks: this.currentPortalFrameBlocks,
      log: this.log,
    })
    const reason = mapReason(request, this.firstCall)
    this.firstCall = false
    this.emitMilestones(counts)
    const fallbackOption = options[0] ?? FRONT_FALLBACK
    const capabilityGap = parseCapabilityGap(request.recentEvents)
    const entity = this.bot.entity
    const botY = entity === undefined ? null : entity.position.y
    const surfaceOption = botY === null ? null : buildUpperAccessRecoveryOption(this.world, botY)
    const forcedSurface = capabilityGap !== null && surfaceOption !== null ? surfaceOption : null
    const surfaceApplies = botY !== null && upperAccessRecoveryApplies(this.world, botY)
    const horizonOptions =
      surfaceOption !== null && (capabilityGap !== null || surfaceApplies) ? [...options, surfaceOption] : options

    if (forcedSurface !== null) {
      this.logUpperAccessRecoveryPolicy(forcedSurface, options)
      this.logPlan('fallback', forcedSurface, reason, started, 0, 'capability gap -> return_to_surface')
      return this.finishPlan(forcedSurface, request, 'capability gap -> return_to_surface', true, true)
    }

    const waitStreak = trailingWaitStreak(request.recentOutcomes)
    const stalled = waitStreak >= 3
    {
      const reasonValue = String(reason)
      if (this.lastLoggedPlanReason !== reasonValue) {
        this.lastLoggedPlanReason = reasonValue
        this.log('PLAN_REASON', { reason: reasonValue })
      }
    }
    const emptyQueueConsultDue =
      reason !== 'queue_empty' || Date.now() - this.lastEmptyQueueConsultMs >= EMPTY_QUEUE_CONSULT_COOLDOWN_MS
    const adviseReason =
      reason === 'queue_empty' && emptyQueueConsultDue && waitStreak < 3
        ? 'no_candidate'
        : advisorReasonFor(reason, waitStreak)
    if (reason === 'queue_empty' && adviseReason === 'no_candidate') this.lastEmptyQueueConsultMs = Date.now()
    const mercuryTrigger = this.mercuryTriggerFor(adviseReason)
    const stalledOption = stalled
      ? buildBodyChangeOption(counts, this.world, {
          placedFurnacesNear: this.placedFurnacesNear(),
          knownFurnaces: this.world.furnaces.length,
          resumeRungIndex: rung.adoptedRungIndex,
          portalFrameBlocks: this.currentPortalFrameBlocks,
          log: this.log,
        })
      : null
    const deterministicOption = stalledOption ?? fallbackOption
    if (this.mercury !== undefined && mercuryTrigger !== null) {
      const repair = await this.mercury.tryRepair(request, mercuryTrigger)
      if (repair !== null) {
        if (mercuryTrigger === 'no_candidate' || mercuryTrigger === 'action_impossible') {
          this.log('NO_PRODUCTIVE_CANDIDATE', { strategy: repair.strategy, reason: mercuryTrigger })
        }
        if (mercuryTrigger === 'wait_limit') this.log('WAIT_LIMIT', { n: waitStreak, strategy: repair.strategy })
        if (mercuryTrigger === 'post_death') this.log('POST_DEATH_REPLAN', { strategy: repair.strategy })
        this.log('STRATEGY_SET', {
          strategy: repair.strategy,
          source: 'mercury',
          goals: repair.goals.map((goal) => goal.description),
        })
        const option: PlanOption = { id: `mercury_${repair.op}`, title: `mercury ${repair.op}`, goals: repair.goals, strategy: repair.strategy }
        this.withSkills(option)
        this.logSkills(repair.strategy, option.skills ?? [])
        return this.finishPlanOp(option, request, repair.op, `mercury ${repair.op}: ${repair.strategy}`)
      }
      return this.fatalModel('planner-mercury', 'mercury returned no repair')
    }

    if (reason === 'queue_empty') {
      const floor = ladderFloorGoals(counts, this.world, {
        resumeRungIndex: rung.adoptedRungIndex,
        dimension: this.bot.game?.dimension ?? null,
        placedFurnacesNear: this.placedFurnacesNear(),
        knownFurnaces: this.world.furnaces.length,
        portalFrameBlocks: this.currentPortalFrameBlocks,
        log: this.log,
      })
      const floorOption: PlanOption = {
        id: `ladder_${floor.rungId}`,
        title: `deterministic ladder floor (${floor.rungId})`,
        goals: floor.goals,
      }
      this.logPlan('ladder', floorOption, reason, started, 0, `queue_empty -> ladder floor rung=${floor.rungId} supplied=${floor.supplied}`)
      if (floor.goals.length === 0) {
        return { goals: [], note: `ladder floor empty (${floor.rungId})`, op: 'continue' as PlanOp }
      }
      return this.finishPlan(floorOption, request, `ladder floor (${floor.rungId})`, true)
    }

    if (this.advisor !== undefined && adviseReason !== null) {
      const decision = await this.advisor.decide(this.advisorState(counts, request, waitStreak), adviseReason)
      if (adviseReason === 'no_candidate') this.log('NO_PRODUCTIVE_CANDIDATE', { strategy: decision.strategy, reason: adviseReason })
      if (waitStreak >= 3) this.log('WAIT_LIMIT', { n: waitStreak, strategy: decision.strategy })
      const goals =
        decision.goals ??
        goalsForStrategy(decision.strategy, counts, this.world, {
          placedFurnacesNear: this.placedFurnacesNear(),
          knownFurnaces: this.world.furnaces.length,
          portalFrameBlocks: this.currentPortalFrameBlocks,
        })
      const option: PlanOption = { id: `advisor_${decision.strategy}`, title: `advisor strategy: ${decision.strategy}`, goals, strategy: decision.strategy }
      this.withSkills(option)
      this.logStrategySet(decision, goals)
      this.logSkills(decision.strategy, option.skills ?? [])
      return this.finishPlan(option, request, `advisor ${decision.source} -> ${decision.strategy}`, stalled)
    }

    if (this.mode === 'deterministic') {
      const ordered = this.applyReadinessOrder(deterministicOption)
      this.logPlan('fallback', ordered, reason, started, 0, 'planner disabled (deterministic mode)')
      const option: PlanOption = { ...ordered, strategy: 'deterministic' }
      this.withSkills(option)
      this.logSkills('deterministic', option.skills ?? [])
      this.emitBodyDelta('deterministic', option)
      return { goals: option.goals, note: 'deterministic ladder (planner disabled)', op: 'replace' }
    }

    const stateHash = this.hashState(counts, request)
    const bypassCache = reason === 'stuck' || reason === 'impossible'
    const cached = bypassCache ? undefined : this.cache.entries[stateHash]
    this.log('PLANNER_CACHE', {
      source: 'planner',
      key: stateHash,
      world: this.worldShort(),
      epoch: this.worldKey.worldEpoch,
      hit: cached !== undefined,
      bypass: bypassCache,
    })
    if (cached !== undefined) {
      const option = horizonOptions.find((entry) => entry.id === cached.optionId) ?? deterministicOption
      this.logPlan('llm', option, reason, started, 0, `cached plan (${option.id})`, true)
      return this.finishPlan(option, request, `cached plan ${option.id}`, stalled)
    }

    const now = Date.now()
    if (this.calls > 0 && now - this.cache.lastCallAt < this.minIntervalMs) {
      // Owner directive: live mode never answers a throttled model call with the deterministic ladder.
      return this.fatalModel('planner-throttle', `model call throttled ${now - this.cache.lastCallAt}ms < ${this.minIntervalMs}ms`)
    }
    if (this.calls >= this.maxCalls) {
      return this.fatalModel('planner-budget', `llm call budget exhausted (${this.maxCalls})`)
    }

    try {
      const chosen = await withModelRetries(
        'planner-llm',
        this.maxAttempts,
        () => this.askLlm(horizonOptions, request),
        {
          onRetry: ({ attempt, nextAttempt, error }) => {
            this.log('PLANNER_RETRY', { attempt, nextAttempt, error: describeError(error) })
          },
        },
      )
      this.calls += 1
      this.cache.lastCallAt = Date.now()
      this.cache.entries[stateHash] = {
        optionId: chosen.optionId,
        worldKey: this.cacheIdentity.worldKey,
        schemaVersion: this.cacheIdentity.schemaVersion,
        capabilityHash: this.cacheIdentity.capabilityHash,
        costUsd: chosen.costUsd,
        ts: Date.now(),
      }
      this.trimCache()
      this.saveCache()
      const option = stalled ? deterministicOption : (horizonOptions.find((entry) => entry.id === chosen.optionId) ?? fallbackOption)
      const note = chosen.unknownChoice !== null ? `unknown choice ${chosen.unknownChoice} -> ${option.id}` : `llm chose ${option.id}`
      this.logPlan('llm', option, reason, started, chosen.costUsd, note, false, chosen.latencyMs, chosen)
      return this.finishPlan(option, request, note, stalled)
    } catch (error) {
      const fatal = error instanceof FatalModelError ? error : new FatalModelError('planner-llm', this.maxAttempts, describeFailure(error))
      return this.failFatal(fatal)
    }
  }

  private failFatal(error: FatalModelError): never {
    return failLoud(error, this.log, this.terminate)
  }

  private fatalModel(context: string, reason: string): never {
    return this.failFatal(new FatalModelError(context, this.maxAttempts, reason))
  }

  // -- internals ------------------------------------------------------------

  private finishPlan(option: PlanOption, request: System2PlanRequest, note: string, force = false, keepHead = false): System2Plan {
    if (!keepHead) option = this.applyReadinessOrder(option)
    this.withSkills(option)
    this.emitBodyDelta(option.strategy ?? option.id, option)
    const queue = request.goalQueueState
    const first = option.goals[0]
    const current = queue.current
    const alreadyActive =
      queue.depth > 0 &&
      current !== null &&
      first !== undefined &&
      current.kind === first.kind &&
      (current.targetItem ?? null) === (first.targetItem ?? null)
    if (alreadyActive && !force) {
      return { goals: [], note: `keep current plan (${note})`, op: 'continue' as PlanOp }
    }
    const adjusted = this.applyBodyDeltaRequirement(option, request, note)
    if (adjusted === null) return rejectionPlan(note)
    return { goals: adjusted.goals, note, op: 'replace' }
  }

  private finishPlanOp(option: PlanOption, request: System2PlanRequest, op: PlanOp, note: string): System2Plan {
    if (op === 'abort') return { goals: [], note, op: 'abort' as PlanOp }
    option = this.applyReadinessOrder(option)
    this.withSkills(option)
    this.emitBodyDelta(option.strategy ?? option.id, option)
    const normalized = normalizePlanTail(option.goals, request.goalQueueState.current, op)
    if (normalized.goals.length === 0) {
      for (const decision of normalized.decisions) {
        this.log('PLAN_TAIL', { op, goal: decision.goal, action: decision.action, reason: decision.reason })
      }
      if (op === 'continue' || op === 'patch') {
        return { goals: [], note: `keep current plan (${note})`, op: 'continue' as PlanOp }
      }
      this.log('PLAN_REJECTED', { source: 'mercury', reason: 'empty_plan', op, note })
      return rejectionPlan(note)
    }
    const normalizedOption: PlanOption = { id: option.id, title: option.title, goals: normalized.goals }
    const adjusted = this.applyBodyDeltaRequirement(normalizedOption, request, note)
    if (adjusted === null) {
      for (const decision of normalized.decisions) {
        const reason = decision.action === 'kept' ? 'no_body_delta' : decision.reason
        this.log('PLAN_TAIL', { op, goal: decision.goal, action: 'skipped', reason })
      }
      this.log('PLAN_REJECTED', { source: 'mercury', reason: 'no_body_delta', op, note, requested: option.id })
      return rejectionPlan(note)
    }
    const substituted = adjusted.id !== option.id
    for (const decision of normalized.decisions) {
      const action = substituted ? 'skipped' : decision.action
      const reason = substituted && decision.action === 'kept' ? 'body_change_substitute' : decision.reason
      this.log('PLAN_TAIL', { op, goal: decision.goal, action, reason })
    }
    return { goals: adjusted.goals, note, op }
  }

  /**
   * Issue #44 requirement 3: a replacement must change the body. When the
   * chosen option is stationary relative to the blocked goal, substitute the
   * deterministic body-change option (descent/ore/retrieval). If even that
   * cannot change the body, reject the replan and keep the current plan.
   */
  private applyBodyDeltaRequirement(option: PlanOption, request: System2PlanRequest, note: string): PlanOption | null {
    const current = request.goalQueueState.current
    if (hasBodyDelta(option.goals, current)) return option
    const head = option.goals[0]
    if (head !== undefined && this.headReadyAndDifferent(head, current)) {
      this.log('PLAN_READY_APPLY', {
        preferred: goalReadinessLabel(head),
        over: current === null ? null : current.description,
        reason: 'preconditions_satisfied',
      })
      return option
    }
    const substitute = this.bodyChangeOption()
    if (hasBodyDelta(substitute.goals, current)) {
      this.log('REPLAN_BODY_CHANGE', {
        requested: option.id,
        replacement: substitute.id,
        reason: request.reason,
      })
      return substitute
    }
    this.log('REPLAN_REJECTED', {
      reason: 'no_body_delta',
      requested: option.id,
      current: current === null ? null : `${current.kind}:${current.targetItem ?? current.description}`,
      note,
    })
    return null
  }

  /**
   * Issue #46: a ready head that differs from the blocked current goal is
   * actionable now, so #44's body-delta gate must not reject it.
   */
  private headReadyAndDifferent(
    head: PlannedGoal,
    current: { kind: string; targetItem: string | null; description: string } | null,
  ): boolean {
    if (current === null) return false
    if (head.kind === current.kind && (head.targetItem ?? null) === current.targetItem) return false
    return isOptionStartable(compilePlannedGoal(head), plannerReadinessSnapshot(this.currentCounts, this.world))
  }

  private bodyChangeOption(): PlanOption {
    return buildBodyChangeOption(this.currentCounts, this.world, {
      placedFurnacesNear: this.placedFurnacesNear(),
      knownFurnaces: this.world.furnaces.length,
      log: this.log,
    })
  }

  private applyReadinessOrder(option: PlanOption): PlanOption {
    const goals = orderPlanGoalsByReadiness(option.goals, this.currentCounts, this.world, this.log)
    // Reference-identical only when nothing moved and no goal was marked ready;
    // otherwise the marks must be carried so the queue merge can honour them.
    const unchanged =
      goals.length === option.goals.length && goals.every((goal, index) => goal === option.goals[index])
    if (unchanged) return option
    return { ...option, goals }
  }

  /**
   * #29/#20: prove that a plan/strategy change actually reaches the body by
   * logging the compiled goals added/removed and the grounded skills relative to
   * the previous plan. A strategy label that compiles to the same goals AND the
   * same skills logs no delta.
   */
  private emitBodyDelta(strategy: string, option: PlanOption): void {
    const skills = option.skills ?? []
    const signature = `${goalSignature(option.goals)}#${skillSignature(skills)}`
    if (signature === this.lastBodySignature) return
    const same = (a: PlannedGoal, b: PlannedGoal): boolean =>
      a.kind === b.kind && (a.targetItem ?? null) === (b.targetItem ?? null) && (a.requiredCount ?? 1) === (b.requiredCount ?? 1)
    const added = option.goals.filter((goal) => !this.lastBodyGoals.some((previous) => same(goal, previous))).map((goal) => goal.description)
    const removed = this.lastBodyGoals.filter((previous) => !option.goals.some((goal) => same(goal, previous))).map((goal) => goal.description)
    this.lastBodySignature = signature
    this.lastBodyGoals = option.goals.map((goal) => ({ ...goal }))
    if (added.length === 0 && removed.length === 0 && skills.length === 0) return
    this.log('STRATEGY_BODY_DELTA', {
      strategy,
      added,
      removed,
      skills: skills.map((skillCandidate) => skillCandidate.id),
      skillKinds: skills.map((skillCandidate) => skillCandidate.kind),
      line: formatStrategyBodyDelta(strategy, skills),
    })
  }

  /**
   * #20: attach the grounded skill list to an option (idempotent). Strategy
   * options compile through the strategy; all others compile from their first goal.
   */
  private withSkills(option: PlanOption): PlanOption {
    if (option.skills !== undefined) return option
    const strategy =
      typeof option.strategy === 'string' && option.strategy.length > 0 && option.strategy !== 'deterministic'
        ? option.strategy
        : null
    if (strategy !== null && isAdvisorStrategy(strategy)) {
      const compiled = compileStrategyOption(strategy, this.currentCounts, this.world, {
        skill: { ...this.botSkillOptions(), goal: plannedGoalToSkillGoal(option.goals[0]) },
        placedFurnacesNear: this.placedFurnacesNear(),
        knownFurnaces: this.world.furnaces.length,
      })
      option.strategyOption = compiled
      option.skills = [...compiled.skills]
      return option
    }
    const input = buildSkillGenerationInput(strategy, this.currentCounts, this.world, {
      ...this.botSkillOptions(),
      goal: plannedGoalToSkillGoal(option.goals[0]),
    })
    option.skills = generateSkillPlan(input).skills
    return option
  }

  /** #20: log every grounded skill the selected strategy/option compiles to. */
  private logSkills(strategy: string, skills: readonly SkillCandidate[]): void {
    for (const skillCandidate of skills) {
      this.log('SKILL_SELECTED', {
        id: skillCandidate.id,
        kind: skillCandidate.kind,
        strategy,
        source: skillCandidate.source,
        line: formatSkillSelected(skillCandidate, strategy),
      })
    }
  }

  private botSkillOptions(): SkillAdapterOptions {
    const entity = this.bot.entity
    return {
      position:
        entity === undefined
          ? null
          : { x: Math.floor(entity.position.x), y: Math.floor(entity.position.y), z: Math.floor(entity.position.z) },
      dimension: this.bot.game?.dimension ?? null,
      health: this.bot.health ?? null,
      toolRank: bestPickaxeRank(this.currentCounts),
    }
  }

  private mercuryTriggerFor(adviseReason: AdvisorReason | null): MercuryTriggerReason | null {
    if (this.postDeathRecovery && !this.postDeathHandled) {
      this.postDeathHandled = true
      return 'post_death'
    }
    if (adviseReason === 'wait_limit') return 'wait_limit'
    if (adviseReason === 'no_candidate') return 'no_candidate'
    if (adviseReason === 'no_progress') return 'no_progress'
    if (adviseReason === 'action_impossible') return 'action_impossible'
    return null
  }

  private logPlan(
    source: 'llm' | 'fallback' | 'ladder',
    option: PlanOption,
    reason: PlannerReason,
    started: number,
    costUsd: number,
    note: string,
    cached = false,
    llmMs = 0,
    detail?: LlmChoice,
  ): void {
    this.log('PLAN', {
      source,
      goals: option.goals.map((goal) => goal.description),
      cost: Number(costUsd.toFixed(6)),
      ms: Date.now() - started,
      reason,
      rung: this.adoptedRungId,
      plan: option.id,
      cached,
      ...(llmMs > 0 ? { llmMs } : {}),
      ...(detail !== undefined && detail.planFit !== null ? { fit: detail.planFit } : {}),
      ...(detail !== undefined && detail.strategyChange !== null ? { strategyChange: detail.strategyChange } : {}),
      ...(detail !== undefined && detail.strategyChangeProbability !== null
        ? {
            strategyChangeProbability: detail.strategyChangeProbability,
            strategyChangeAtHalf: detail.strategyChangeProbability >= 0.5,
          }
        : {}),
      note,
    })
  }

  private logUpperAccessRecoveryPolicy(option: PlanOption, alternatives: readonly PlanOption[]): void {
    const targetY = option.goals[0]?.targetY ?? null
    const entity = this.bot.entity
    const botY = entity === undefined ? null : entity.position.y
    this.log('UPPER_ACCESS_RECOVERY_POLICY', {
      chosen: option.id,
      targetY,
      score: targetY !== null && botY !== null ? Math.round(targetY - botY) : null,
      alternatives: alternatives.map((entry) => entry.id),
      reason: 'capability_gap',
    })
  }

  private logStrategySet(decision: AdvisorDecision, goals: readonly PlannedGoal[]): void {
    const signature = goalSignature(goals)
    const strategyChanged = this.lastAdvisorStrategy !== null && this.lastAdvisorStrategy !== decision.strategy
    const goalsChanged = this.lastAdvisorSignature !== null && this.lastAdvisorSignature !== signature
    if (strategyChanged && !goalsChanged) {
      this.log('STRATEGY_NOOP', {
        strategy: decision.strategy,
        previous: this.lastAdvisorStrategy,
        note: 'strategy changed but compiled goals are identical (#29)',
      })
    }
    this.lastAdvisorStrategy = decision.strategy
    this.lastAdvisorSignature = signature
    this.log('STRATEGY_SET', {
      strategy: decision.strategy,
      source: decision.source,
      cached: decision.cached,
      strategyChanged,
      goalsChanged: strategyChanged ? goalsChanged : false,
      goals: goals.map((goal) => goal.description),
    })
  }

  private emitMilestones(counts: Counts): void {
    const frontier = computeFrontier(counts, this.world)
    if (frontier.rungId === this.lastMilestoneId) return
    if (this.lastMilestoneId !== null) this.log('MILESTONE', { name: this.lastMilestoneId, done: true })
    this.log('MILESTONE', { name: frontier.rungId, done: false })
    this.lastMilestoneId = frontier.rungId
  }

  private placedFurnacesNear(): number {
    const ids: number[] = []
    for (const name of ['furnace', 'blast_furnace', 'smoker']) {
      const block = this.bot.registry.blocksByName[name]
      if (block !== undefined) ids.push(block.id)
    }
    if (ids.length === 0) return 0
    try {
      return this.bot.findBlocks({ matching: ids, maxDistance: 48, count: 8 }).length
    } catch {
      return 0
    }
  }

  private hashState(counts: Counts, request: System2PlanRequest): string {
    return plannerStateHash(counts, this.world, request.objective, this.cacheIdentity, this.currentPortalFrameBlocks)
  }

  private worldShort(): string {
    return `${this.worldKey.serverId}|${this.worldKey.dimension}`
  }

  private advisorState(counts: Counts, request: System2PlanRequest, waitStreak: number): AdvisorState {
    const entity = this.bot.entity
    const frontier = computeFrontier(counts, this.world)
    const relevant: Record<string, number> = {}
    for (const [name, n] of Object.entries(counts)) if (n > 0) relevant[name] = n
    const failedCandidates: Record<string, number> = {}
    for (const outcome of request.recentOutcomes) {
      if (outcome.failure !== null) failedCandidates[outcome.actionId] = (failedCandidates[outcome.actionId] ?? 0) + 1
    }
    return {
      rung: frontier.rungId,
      rungIndex: frontier.rungIndex,
      position:
        entity === undefined
          ? null
          : { x: Math.round(entity.position.x), y: Math.round(entity.position.y), z: Math.round(entity.position.z) },
      dimension: this.bot.game?.dimension ?? null,
      inventory: relevant,
      toolRank: bestPickaxeRank(counts),
      stations: { craftingTables: this.world.craftingTables.length, furnaces: this.world.furnaces.length },
      discoveredOres: this.world.discoveredOres,
      queueCurrent: request.goalQueueState.current?.description ?? null,
      queueDepth: request.goalQueueState.depth,
      queueDone: request.goalQueueState.done,
      waitStreak,
      failedCandidates,
      recentFailures: request.recentOutcomes
        .slice(-6)
        .map((outcome) => `${outcome.actionId}:${outcome.status}${outcome.failure === null ? '' : `:${outcome.failure}`}`),
    }
  }

  private compactState(request: System2PlanRequest): EvaluationState {
    const counts = inventoryCounts(this.bot)
    const entity = this.bot.entity
    const frontier = computeFrontier(counts, this.world)
    const relevant: Record<string, number> = {}
    for (const [name, n] of Object.entries(counts)) {
      if (n > 0) relevant[name] = n
    }
    const compact = {
      bot: 'AI_Buddy',
      milestone: { rung: frontier.rungId, rungIndex: frontier.rungIndex },
      position:
        entity === undefined
          ? null
          : { x: Math.round(entity.position.x), y: Math.round(entity.position.y), z: Math.round(entity.position.z) },
      health: this.bot.health,
      food: this.bot.food,
      toolRank: bestPickaxeRank(counts),
      inventory: relevant,
      stations: { craftingTables: this.world.craftingTables.length, furnaces: this.world.furnaces.length },
      discoveredOres: this.world.discoveredOres,
      queue: {
        depth: request.goalQueueState.depth,
        done: request.goalQueueState.done,
        current: request.goalQueueState.current?.description ?? null,
        hasImpossible: request.goalQueueState.hasImpossible,
      },
      objective: request.objective,
      wakeReason: request.reason,
      wakeDetail: request.detail.slice(0, 200),
      recentEvents: request.recentEvents.slice(-5),
      recentOutcomes: request.recentOutcomes.slice(-5).map((outcome) => ({
        action: outcome.actionId,
        status: outcome.status,
        failure: outcome.failure,
        verified: outcome.verified,
      })),
      horizon: executableRungs()
        .filter((rung) => !rung.satisfied(counts, this.world))
        .map((rung) => rung.id),
    }
    return JSON.parse(JSON.stringify(compact)) as EvaluationState
  }

  private async askLlm(options: PlanOption[], request: System2PlanRequest): Promise<LlmChoice> {
    const key = this.resolveKey()
    if (key === null) throw new Error('no gateway key resolved')
    // The gateway provider reads this at request time; the value is never logged.
    process.env.AI_GATEWAY_API_KEY = key.key

    const criteria: Record<string, string> = {}
    for (const option of options) {
      criteria[option.id] = `${option.title} :: ${option.goals.map((goal) => goal.description).join(' -> ')}`
    }
    const questions = {
      horizon: { type: 'choice', instructions: HORIZON_INSTRUCTIONS, criteria },
      plan_fit: { type: 'score', instructions: PLAN_FIT_INSTRUCTIONS, criteria: [...PLAN_FIT_LEVELS] },
      strategy_change: {
        type: 'boolean',
        instructions: STRATEGY_INSTRUCTIONS,
        criteria: { true: 'change the plan now', false: 'the current plan is still right' },
      },
    } satisfies Record<string, EvaluationQuestion>

    const state = this.compactState(request)
    const started = Date.now()
    const response = await evaluate({
      model: this.model,
      state,
      questions,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(this.timeoutMs),
    })
    const latencyMs = Date.now() - started

    const answers = response.answers as Record<string, unknown>
    const chosenId = readChoice(answers.horizon)
    const planFit = readScore(answers.plan_fit)
    const strategyChangeProbability = readBooleanProbability(answers.strategy_change)
    const strategyChange = strategyChangeProbability === null ? null : strategyChangeProbability >= resolveStrategyChangeThreshold()
    const match = chosenId === null ? undefined : options.find((option) => option.id === chosenId)
    const inputTokens = response.usage.inputTokens ?? 0
    const outputTokens = response.usage.outputTokens ?? 0
    const costUsd = (inputTokens + outputTokens) * COST_PER_TOKEN_USD
    return {
      optionId: (match ?? options[0] ?? FRONT_FALLBACK).id,
      latencyMs,
      costUsd,
      planFit,
      strategyChange,
      strategyChangeProbability,
      unknownChoice: chosenId !== null && match === undefined ? chosenId : null,
    }
  }

  private loadCache(): PlannerCacheFile {
    const identity = this.cacheIdentity
    try {
      if (!existsSync(this.cachePath)) return emptyCache(identity)
      const parsed = JSON.parse(readFileSync(this.cachePath, 'utf8')) as Partial<PlannerCacheFile>
      if (parsed.version !== PLANNER_CACHE_FILE_VERSION) {
        this.log('PLANNER_CACHE_INVALIDATED', {
          source: 'planner',
          reason: 'schema',
          cachedVersion: parsed.version ?? null,
          version: PLANNER_CACHE_FILE_VERSION,
        })
        return emptyCache(identity)
      }
      if (parsed.schemaVersion !== identity.schemaVersion || parsed.capabilityHash !== identity.capabilityHash) {
        this.log('PLANNER_CACHE_INVALIDATED', {
          source: 'planner',
          reason: 'schema',
          cachedSchema: parsed.schemaVersion ?? null,
          schemaVersion: identity.schemaVersion,
          cachedCapability: parsed.capabilityHash ?? null,
          capabilityHash: identity.capabilityHash,
        })
        return emptyCache(identity)
      }
      if (parsed.worldKey !== identity.worldKey || parsed.worldEpoch !== identity.worldEpoch) {
        this.log('PLANNER_CACHE_INVALIDATED', {
          source: 'planner',
          reason: 'world',
          cachedWorld: parsed.worldKey ?? null,
          world: identity.worldKey,
          cachedEpoch: parsed.worldEpoch ?? null,
          epoch: identity.worldEpoch,
        })
        return emptyCache(identity)
      }
      if (typeof parsed.lastCallAt !== 'number' || typeof parsed.entries !== 'object' || parsed.entries === null) {
        return emptyCache(identity)
      }
      return {
        version: PLANNER_CACHE_FILE_VERSION,
        worldKey: identity.worldKey,
        worldEpoch: identity.worldEpoch,
        schemaVersion: identity.schemaVersion,
        capabilityHash: identity.capabilityHash,
        lastCallAt: parsed.lastCallAt,
        entries: parsed.entries,
      }
    } catch {
      return emptyCache(identity)
    }
  }

  private saveCache(): void {
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true })
      const tmp = `${this.cachePath}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(this.cache)}\n`)
      renameSync(tmp, this.cachePath)
    } catch (error) {
      this.log('ERROR', { where: 'planner.saveCache', message: describeError(error) })
    }
  }

  private trimCache(): void {
    const entries = Object.entries(this.cache.entries)
    if (entries.length <= MAX_CACHE_ENTRIES) return
    entries.sort((a, b) => b[1].ts - a[1].ts)
    this.cache.entries = Object.fromEntries(entries.slice(0, MAX_CACHE_ENTRIES))
  }
}
