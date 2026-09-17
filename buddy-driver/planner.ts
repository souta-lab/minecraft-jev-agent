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
import { matchesResourceClass, resourceMatches } from '../jev-agent/src/resourceClass.ts'
import type { ResourceClass } from '../jev-agent/src/resourceClass.ts'
import type { ResidentWorldMemory } from './resident-types.ts'
import { Advisor } from './advisor.ts'
import type { AdvisorDecision, AdvisorReason, AdvisorState, AdvisorStrategy } from './advisor.ts'
import type { MercurySystem2, MercuryTriggerReason } from './mercury-system2.ts'

export type Counts = Record<string, number>

// ---------------------------------------------------------------------------
// mode switch (env)
// ---------------------------------------------------------------------------

export type PlannerMode = 'llm' | 'deterministic'

/** `BUDDY_PLANNER=llm|deterministic|auto` (auto = llm when a gateway key exists). */
export function resolvePlannerMode(): PlannerMode {
  const raw = (process.env.BUDDY_PLANNER ?? 'auto').trim().toLowerCase()
  if (raw === 'deterministic' || raw === 'off' || raw === 'fallback' || raw === 'none') return 'deterministic'
  if (raw === 'llm' || raw === 'on') return 'llm'
  return resolveJevApiKey() !== null ? 'llm' : 'deterministic'
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

/** 0 none, 1 wooden, 2 stone, 3 iron, 4 diamond+ */
export function bestPickaxeRank(counts: Counts): number {
  const order = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']
  let rank = 0
  for (let i = 0; i < order.length; i += 1) {
    const name = order[i]
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
    // Stone is legitimately spent on the furnace and stone_pickaxe; a stone
    // pickaxe proves enough cobblestone was mined even when the count is low.
    satisfied: (c) => countClass(c, 'stone') >= 12 || bestPickaxeRank(c) >= 2,
    goals: () => [{ kind: 'collect', description: 'collect 12 x stone', targetItem: 'stone', requiredCount: 12 }],
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
    satisfied: (c) => has(c, 'charcoal') || has(c, 'coal'),
    goals: () => [
      { kind: 'collect', description: 'collect 2 x log (fuel)', targetItem: 'log', requiredCount: 2 },
      { kind: 'smelt', description: 'smelt 1 x charcoal', targetItem: 'charcoal', requiredCount: 1 },
    ],
  },
  {
    id: 'raw_iron',
    satisfied: (c) => (c['raw_iron'] ?? 0) + (c['iron_ingot'] ?? 0) >= 3,
    goals: (c) => [
      {
        kind: 'collect',
        description: 'collect 3 x raw_iron',
        targetItem: 'raw_iron',
        requiredCount: Math.max(1, 3 - ((c['raw_iron'] ?? 0) + (c['iron_ingot'] ?? 0))),
      },
    ],
  },
  {
    id: 'iron_ingot',
    satisfied: (c) => (c['iron_ingot'] ?? 0) >= 3,
    goals: (c) => [{ kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: Math.max(1, 3 - (c['iron_ingot'] ?? 0)) }],
  },
  {
    id: 'iron_pickaxe',
    satisfied: (c) => bestPickaxeRank(c) >= 3,
    goals: () => [{ kind: 'craft', description: 'craft 1 x iron_pickaxe', targetItem: 'iron_pickaxe', requiredCount: 1 }],
  },
  {
    id: 'iron_gear',
    satisfied: (c) =>
      has(c, 'iron_chestplate') && has(c, 'iron_leggings') && has(c, 'iron_helmet') && has(c, 'iron_boots') && has(c, 'iron_sword'),
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
  // --- M3: nether route (templates only; the current executor cannot run these) ---
  {
    id: 'nether_portal',
    future: true,
    satisfied: (c) => has(c, 'flint_and_steel') && countClass(c, 'stone') >= 0 && has(c, 'flint'),
    goals: () => [
      { kind: 'collect', description: 'collect 10 x obsidian', targetItem: 'obsidian', requiredCount: 10 },
      { kind: 'craft', description: 'craft 1 x flint_and_steel', targetItem: 'flint_and_steel', requiredCount: 1 },
      { kind: 'place', description: 'place 1 x nether_portal', targetItem: 'nether_portal', requiredCount: 1 },
    ],
  },
  {
    id: 'blaze_rods',
    future: true,
    satisfied: (c) => (c['blaze_rod'] ?? 0) >= 7,
    goals: () => [{ kind: 'collect', description: 'collect 7 x blaze_rod', targetItem: 'blaze_rod', requiredCount: 7 }],
  },
  {
    id: 'ender_pearls',
    future: true,
    satisfied: (c) => (c['ender_pearl'] ?? 0) >= 12,
    goals: () => [{ kind: 'collect', description: 'collect 12 x ender_pearl', targetItem: 'ender_pearl', requiredCount: 12 }],
  },
  {
    id: 'eyes_of_ender',
    future: true,
    satisfied: (c) => (c['eye_of_ender'] ?? 0) >= 12,
    goals: () => [{ kind: 'craft', description: 'craft 12 x eye_of_ender', targetItem: 'eye_of_ender', requiredCount: 12 }],
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

export interface PreconditionResult {
  ok: boolean
  need: string
}

/** A rung's prerequisite, checked before its goal is ever emitted. A goal whose
 * tool/material prerequisite is missing must never enter the queue: that is what
 * wedged the resident on `collect raw_iron` with an empty inventory. */
export function rungPrecondition(rung: Rung, c: Counts, w: ResidentWorldMemory): PreconditionResult {
  switch (rung.id) {
    case 'cobblestone':
      return { ok: bestPickaxeRank(c) >= 1, need: 'wooden_pickaxe' }
    case 'furnace':
      return { ok: countClass(c, 'stone') >= 8 || has(c, 'furnace') || w.furnaces.length > 0, need: '8 x stone' }
    case 'stone_pickaxe':
      return { ok: countClass(c, 'stone') >= 3 && bestPickaxeRank(c) >= 1, need: '3 x stone + wooden_pickaxe' }
    case 'charcoal':
      return { ok: has(c, 'furnace') || w.furnaces.length > 0, need: 'placed furnace' }
    case 'raw_iron':
      return { ok: bestPickaxeRank(c) >= 2, need: 'stone_pickaxe' }
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
      return { ok: bestPickaxeRank(c) >= 2, need: 'stone_pickaxe' }
    case 'diamond_pickaxe':
      return { ok: has(c, 'diamond'), need: 'diamond' }
    default:
      return { ok: true, need: '' }
  }
}

const ORE_RUNG_ITEM: Record<string, string> = { raw_iron: 'raw_iron', diamond: 'diamond' }

const ORE_HOME: Record<string, { item: string; ore: string; dimension: string }> = {
  raw_iron: { item: 'raw_iron', ore: 'iron_ore', dimension: 'minecraft:overworld' },
  diamond: { item: 'diamond', ore: 'diamond_ore', dimension: 'minecraft:overworld' },
}

/**
 * A bounded descent goal derived from the live inventory. Ore rungs need positive
 * evidence of a level below (`#9`); a stone-collection goal is that evidence
 * (`#4`), so digging resumes instead of the `collect raw_iron` WAIT wedge.
 * `requiredCount` is current+8 so the goal is never instantly complete.
 */
export function stoneDescentGoal(counts: Counts): PlannedGoal {
  const cobble = counts['cobblestone'] ?? 0
  return {
    kind: 'collect',
    description: `collect ${cobble + 8} x cobblestone (descend toward ore levels)`,
    targetItem: 'cobblestone',
    requiredCount: cobble + 8,
  }
}

function needsOreDescent(rungId: string, counts: Counts): boolean {
  const ore = ORE_RUNG_ITEM[rungId]
  if (ore === undefined) return false
  if ((counts[ore] ?? 0) > 0) return false
  return bestPickaxeRank(counts) >= 1
}

/** Inventory-derived prerequisite chain for a placed furnace (#43). */
export function furnacePrereqGoals(counts: Counts, placedFurnacesNear: number | undefined): PlannedGoal[] {
  if ((placedFurnacesNear ?? 0) > 0) return []
  const place: PlannedGoal = { kind: 'place', description: 'place 1 x furnace', targetItem: 'furnace', requiredCount: 1 }
  const craft: PlannedGoal = { kind: 'craft', description: 'craft 1 x furnace', targetItem: 'furnace', requiredCount: 1 }
  if (has(counts, 'furnace')) return [place]
  const stoneHave = countClass(counts, 'stone')
  if (stoneHave >= 8) return [craft, place]
  const need = Math.max(1, 8 - stoneHave)
  const collect: PlannedGoal = {
    kind: 'collect',
    description: `collect ${need} x cobblestone (furnace material)`,
    targetItem: 'cobblestone',
    requiredCount: need,
  }
  return [collect, craft, place]
}

function withFurnacePrereq(goals: PlannedGoal[], counts: Counts, placedFurnacesNear: number | undefined): PlannedGoal[] {
  if (!goals.some((goal) => goal.targetItem === 'charcoal')) return goals
  if (goals.some((goal) => goal.targetItem === 'furnace')) return goals
  const prereq = furnacePrereqGoals(counts, placedFurnacesNear)
  return prereq.length === 0 ? goals : [...prereq, ...goals]
}

/** A rung's goals, with the inventory-derived descent prerequisite prepended for
 * ore rungs whose ore is not held yet (#12). */
export function rungGoalsWithPrereq(rung: Rung, c: Counts, w: ResidentWorldMemory): PlannedGoal[] {
  const base = rung.goals(c, w)
  if (!needsOreDescent(rung.id, c)) return base
  return [stoneDescentGoal(c), ...base]
}

function withOreDescent(goals: PlannedGoal[], counts: Counts): PlannedGoal[] {
  const first = goals[0]
  const oreItem = first?.targetItem ?? null
  if (oreItem === null || !Object.values(ORE_RUNG_ITEM).includes(oreItem)) return goals
  if (!needsOreDescent(oreItem, counts)) return goals
  if (goals.some((goal) => goal.targetItem === 'cobblestone')) return goals
  return [stoneDescentGoal(counts), ...goals]
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

/** The executable ladder as a goal list, gated by per-rung preconditions. */
export function buildLadder(
  counts: Counts,
  world: ResidentWorldMemory,
  log?: (event: string, detail?: Record<string, unknown>) => void,
  opts?: { dimension?: string | null; placedFurnacesNear?: number },
): Ladder {
  const goals: PlannedGoal[] = []
  let rungIndex = RUNGS.length
  let rungId = 'complete'
  let prereqReplaced = false
  let unsatisfiable: string | null = null
  for (let i = 0; i < RUNGS.length; i += 1) {
    const rung = RUNGS[i]
    if (rung === undefined || rung.future === true) continue
    if (rung.satisfied(counts, world)) {
      if (log !== undefined) {
        for (const goal of rung.goals(counts, world)) {
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
    const emitted = withFurnacePrereq(rungGoalsWithPrereq(rung, counts, world), counts, opts?.placedFurnacesNear)
    const rungGoals = filterAlreadyMet(emitted, counts, rung.id, log)
    if (rungGoals.length === 0) continue
    if (rungIndex === RUNGS.length) {
      rungIndex = i
      rungId = rung.id
    }
    const description = rung.goals(counts, world)[0]?.description ?? rung.id
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
      log?.('LADDER_PREREQ', {
        goal: description,
        need: precondition.need,
        rungId: rung.id,
        replace: rungGoals.map((goal) => goal.description),
      })
      for (const goal of rungGoals) goals.push(goal)
      continue
    }
    for (const goal of rungGoals) goals.push(goal)
  }
  if (goals.length === 0) {
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
    if (rung === undefined || rung.future === true) continue
    if (!rung.satisfied(counts, world)) return { rungIndex: i, rungId: rung.id }
  }
  return { rungIndex: RUNGS.length, rungId: 'complete' }
}

export function debugFrontier(counts: Counts, world: ResidentWorldMemory): { rungIndex: number; rungId: string } {
  return computeFrontier(counts, world)
}

// ---------------------------------------------------------------------------
// candidate horizon plans (the bounded options the LLM chooses between)
// ---------------------------------------------------------------------------

export interface PlanOption {
  id: string
  title: string
  goals: PlannedGoal[]
}

/** Stable signature of a compiled goal list, for STRATEGY_BODY_DELTA (#29). */
export function goalSignature(goals: readonly PlannedGoal[]): string {
  return goals.map((goal) => `${goal.kind}:${goal.targetItem ?? goal.description}:${goal.requiredCount ?? 1}`).join('|')
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
  opts?: { placedFurnacesNear?: number; log?: (event: string, detail?: Record<string, unknown>) => void },
): PlanOption[] {
  const planGoals = (rung: Rung): PlannedGoal[] =>
    filterAlreadyMet(withFurnacePrereq(rungGoalsWithPrereq(rung, counts, world), counts, opts?.placedFurnacesNear), counts, rung.id, opts?.log)
  const unsat = reachableUnsatisfiedRungs(counts, world)
  if (unsat.length === 0) {
    return [
      {
        id: 'upkeep',
        title: 'resident upkeep',
        goals: [{ kind: 'collect', description: 'collect 16 x raw_iron (resident upkeep)', targetItem: 'raw_iron', requiredCount: 16 }],
      },
    ]
  }
  const options: PlanOption[] = []
  const first = unsat[0]
  if (first !== undefined) {
    options.push({ id: `front_${first.id}`, title: `next milestone: ${first.id}`, goals: planGoals(first) })
  }
  const two = unsat.slice(0, 2).flatMap((rung) => planGoals(rung))
  if (two.length > 0) options.push({ id: 'two_rungs', title: `next two milestones (${unsat.slice(0, 2).map((r) => r.id).join(' + ')})`, goals: two })
  const ironIndex = unsat.findIndex((rung) => rung.id === 'iron_pickaxe')
  if (ironIndex >= 0) {
    const iron = unsat.slice(0, ironIndex + 1).flatMap((rung) => planGoals(rung))
    if (iron.length > 0) options.push({ id: 'finish_iron_age', title: 'finish the iron age (raw_iron -> iron_ingot -> iron_pickaxe)', goals: iron })
  }
  const gearIndex = unsat.findIndex((rung) => rung.id === 'iron_gear')
  if (gearIndex >= 0) {
    const gear = unsat.slice(0, gearIndex + 1).flatMap((rung) => planGoals(rung))
    if (gear.length > 0) options.push({ id: 'iron_gear', title: 'full iron gear then diamond', goals: gear })
  }
  const diamondIndex = unsat.findIndex((rung) => rung.id === 'diamond_pickaxe')
  if (diamondIndex >= 0) {
    const diamond = unsat.slice(0, diamondIndex + 1).flatMap((rung) => planGoals(rung))
    if (diamond.length > 0) options.push({ id: 'diamond_road', title: 'push to diamond + diamond_pickaxe', goals: diamond })
  }
  const whole = unsat.flatMap((rung) => planGoals(rung))
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
  opts?: { placedFurnacesNear?: number; log?: (event: string, detail?: Record<string, unknown>) => void },
): PlanOption {
  const unsat = reachableUnsatisfiedRungs(counts, world)
  const planGoals = (rung: Rung): PlannedGoal[] =>
    filterAlreadyMet(withFurnacePrereq(rungGoalsWithPrereq(rung, counts, world), counts, opts?.placedFurnacesNear), counts, rung.id, opts?.log)
  const goals: PlannedGoal[] = []
  const pushUnique = (goal: PlannedGoal): void => {
    if (goals.some((existing) => existing.kind === goal.kind && existing.targetItem === goal.targetItem)) return
    goals.push(goal)
  }
  const oreRung = unsat.find((rung) => ORE_RUNG_ITEM[rung.id] !== undefined)
  if (oreRung !== undefined) for (const goal of planGoals(oreRung)) pushUnique(goal)
  const front = unsat[0]
  if (front !== undefined && front.id !== oreRung?.id) for (const goal of planGoals(front)) pushUnique(goal)
  if (goals.length === 0) pushUnique(stoneDescentGoal(counts))
  return { id: `body_change_${front?.id ?? 'upkeep'}`, title: `body-changing replan toward ${oreRung?.id ?? front?.id ?? 'ore'}`, goals }
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
  opts?: { placedFurnacesNear?: number },
): PlannedGoal[] {
  const rank = bestPickaxeRank(counts)
  const ladderFront = buildLadder(counts, world, undefined, opts).goals
  const stone = (n: number): PlannedGoal => ({ kind: 'collect', description: `collect ${n} x cobblestone`, targetItem: 'cobblestone', requiredCount: n })
  const iron = (n: number): PlannedGoal => ({ kind: 'collect', description: `collect ${n} x raw_iron`, targetItem: 'raw_iron', requiredCount: n })
  const chosen = (goals: PlannedGoal[]): PlannedGoal[] =>
    withFurnacePrereq(withOreDescent(goals, counts), counts, opts?.placedFurnacesNear)
  switch (strategy) {
    case 'descend_to_y16':
      return rank < 1 ? ladderFront : chosen([stone(24)])
    case 'explore_cave':
      return rank < 1 ? ladderFront : rank < 2 ? chosen([stone(16)]) : chosen([stone(12), iron(3)])
    case 'branch_mine':
      return rank < 1 ? ladderFront : rank < 2 ? chosen([stone(32)]) : chosen([stone(24), iron(3)])
    case 'return_to_known_ore':
      return rank < 2 ? (rank < 1 ? ladderFront : chosen([stone(16)])) : chosen([iron(3)])
    case 'smelt_and_craft':
      return chosen(ladderFront)
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

export interface PlannerCacheEntry {
  optionId: string
  costUsd: number
  ts: number
}

interface PlannerCacheFile {
  version: 1
  lastCallAt: number
  entries: Record<string, PlannerCacheEntry>
}

const MAX_CACHE_ENTRIES = 80

function emptyCache(): PlannerCacheFile {
  return { version: 1, lastCallAt: 0, entries: {} }
}

export interface PlannerOptions {
  bot: Bot
  world: ResidentWorldMemory
  log: (event: string, detail?: Record<string, unknown>) => void
  /** where the durable plan cache is mirrored (JSON, tmp -> rename). */
  cachePath: string
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
 * The resident high-level planner. It is constructed per generation and handed to
 * `JevController.setSystem2()`. The controller calls `plan()` only on replan
 * boundaries (queue empty / goal impossible / stall), never on the hot path.
 */
export class PlannerBrain implements System2Brain {
  readonly model: string
  private readonly bot: Bot
  private readonly world: ResidentWorldMemory
  private readonly log: (event: string, detail?: Record<string, unknown>) => void
  private readonly cachePath: string
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
  private postDeathHandled = false
  private lastAdvisorStrategy: AdvisorStrategy | null = null
  private lastAdvisorSignature: string | null = null
  private lastBodySignature: string | null = null
  private lastBodyGoals: PlannedGoal[] = []

  constructor(options: PlannerOptions) {
    this.bot = options.bot
    this.world = options.world
    this.log = options.log
    this.cachePath = options.cachePath
    this.mode = options.mode ?? resolvePlannerMode()
    this.minIntervalMs = options.minIntervalMs ?? Number(process.env.BUDDY_PLANNER_MIN_INTERVAL_MS ?? 45000)
    this.timeoutMs = options.timeoutMs ?? Number(process.env.BUDDY_PLANNER_TIMEOUT_MS ?? 9000)
    this.maxCalls = options.maxCalls ?? Number(process.env.BUDDY_PLANNER_MAX_CALLS ?? 200)
    this.model = options.model ?? process.env.BUDDY_PLANNER_MODEL ?? process.env.AI_GATEWAY_MODEL ?? DEFAULT_JEV_MODEL
    this.advisor = options.advisor
    this.mercury = options.mercury
    this.postDeathRecovery = options.postDeathRecovery === true
    this.cache = this.loadCache()
  }

  async plan(request: System2PlanRequest): Promise<System2Plan> {
    const started = Date.now()
    const counts = inventoryCounts(this.bot)
    const options = buildPlanOptions(counts, this.world, { placedFurnacesNear: this.placedFurnacesNear(), log: this.log })
    const reason = mapReason(request, this.firstCall)
    this.firstCall = false
    this.emitMilestones(counts)
    const fallbackOption = options[0] ?? FRONT_FALLBACK

    const waitStreak = trailingWaitStreak(request.recentOutcomes)
    const stalled = waitStreak >= 3
    const adviseReason = advisorReasonFor(reason, waitStreak)
    const mercuryTrigger = this.mercuryTriggerFor(adviseReason)
    const stalledOption = stalled
      ? buildBodyChangeOption(counts, this.world, { placedFurnacesNear: this.placedFurnacesNear(), log: this.log })
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
        const option: PlanOption = { id: `mercury_${repair.op}`, title: `mercury ${repair.op}`, goals: repair.goals }
        return this.finishPlanOp(option, request, repair.op, `mercury ${repair.op}: ${repair.strategy}`)
      }
      // Mercury already logged ADVISOR source=fallback; never use the Jev advisor here.
      this.logPlan('fallback', deterministicOption, reason, started, 0, 'mercury unavailable -> deterministic ladder')
      return this.finishPlan(deterministicOption, request, 'mercury unavailable', stalled)
    }

    if (this.advisor !== undefined && adviseReason !== null) {
      const decision = await this.advisor.decide(this.advisorState(counts, request, waitStreak), adviseReason)
      if (adviseReason === 'no_candidate') this.log('NO_PRODUCTIVE_CANDIDATE', { strategy: decision.strategy, reason: adviseReason })
      if (waitStreak >= 3) this.log('WAIT_LIMIT', { n: waitStreak, strategy: decision.strategy })
      const goals = decision.goals ?? goalsForStrategy(decision.strategy, counts, this.world, { placedFurnacesNear: this.placedFurnacesNear() })
      const option: PlanOption = { id: `advisor_${decision.strategy}`, title: `advisor strategy: ${decision.strategy}`, goals }
      this.logStrategySet(decision, goals)
      return this.finishPlan(option, request, `advisor ${decision.source} -> ${decision.strategy}`, stalled)
    }

    if (this.mode === 'deterministic') {
      this.logPlan('fallback', deterministicOption, reason, started, 0, 'planner disabled (deterministic mode)')
      this.emitBodyDelta(deterministicOption.id, deterministicOption)
      return { goals: deterministicOption.goals, note: 'deterministic ladder (planner disabled)', op: 'replace' }
    }

    const stateHash = this.hashState(counts, request)
    const bypassCache = reason === 'stuck' || reason === 'impossible'
    const cached = bypassCache ? undefined : this.cache.entries[stateHash]
    if (cached !== undefined) {
      const option = options.find((entry) => entry.id === cached.optionId) ?? deterministicOption
      this.logPlan('llm', option, reason, started, 0, `cached plan (${option.id})`, true)
      return this.finishPlan(option, request, `cached plan ${option.id}`, stalled)
    }

    const now = Date.now()
    if (this.calls > 0 && now - this.cache.lastCallAt < this.minIntervalMs) {
      this.logPlan('fallback', deterministicOption, reason, started, 0, `throttled ${now - this.cache.lastCallAt}ms < ${this.minIntervalMs}ms`)
      return this.finishPlan(deterministicOption, request, 'throttled: deterministic ladder', stalled)
    }
    if (this.calls >= this.maxCalls) {
      this.logPlan('fallback', deterministicOption, reason, started, 0, `call budget exhausted (${this.maxCalls})`)
      return this.finishPlan(deterministicOption, request, 'llm call budget exhausted', stalled)
    }

    try {
      const chosen = await this.askLlm(options, request)
      this.calls += 1
      this.cache.lastCallAt = Date.now()
      this.cache.entries[stateHash] = { optionId: chosen.optionId, costUsd: chosen.costUsd, ts: Date.now() }
      this.trimCache()
      this.saveCache()
      const option = stalled ? deterministicOption : (options.find((entry) => entry.id === chosen.optionId) ?? fallbackOption)
      const note = chosen.unknownChoice !== null ? `unknown choice ${chosen.unknownChoice} -> ${option.id}` : `llm chose ${option.id}`
      this.logPlan('llm', option, reason, started, chosen.costUsd, note, false, chosen.latencyMs, chosen)
      return this.finishPlan(option, request, note, stalled)
    } catch (error) {
      const message = describeError(error)
      const kind = isRateLimitError(error) ? 'rate_limited' : 'llm_error'
      this.logPlan('fallback', deterministicOption, reason, started, 0, `${kind}: ${message}`)
      return this.finishPlan(deterministicOption, request, `${kind}: ${message}`, stalled)
    }
  }

  // -- internals ------------------------------------------------------------

  private finishPlan(option: PlanOption, request: System2PlanRequest, note: string, force = false): System2Plan {
    this.emitBodyDelta(option.id, option)
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
    return { goals: option.goals, note, op: 'replace' }
  }

  private finishPlanOp(option: PlanOption, request: System2PlanRequest, op: PlanOp, note: string): System2Plan {
    if (op === 'abort') return { goals: [], note, op: 'abort' as PlanOp }
    this.emitBodyDelta(option.id, option)
    const queue = request.goalQueueState
    const first = option.goals[0]
    const current = queue.current
    const alreadyActive =
      queue.depth > 0 &&
      current !== null &&
      first !== undefined &&
      current.kind === first.kind &&
      (current.targetItem ?? null) === (first.targetItem ?? null)
    if (alreadyActive && op !== 'continue') {
      return { goals: [], note: `keep current plan (${note})`, op: 'continue' as PlanOp }
    }
    return { goals: option.goals, note, op }
  }

  /**
   * #29: prove that a plan/strategy change actually reaches the body by logging
   * the compiled goals added/removed relative to the previous plan. A strategy
   * label that compiles to the same goals logs no delta.
   */
  private emitBodyDelta(strategy: string, option: PlanOption): void {
    const signature = goalSignature(option.goals)
    if (signature === this.lastBodySignature) return
    const same = (a: PlannedGoal, b: PlannedGoal): boolean =>
      a.kind === b.kind && (a.targetItem ?? null) === (b.targetItem ?? null) && (a.requiredCount ?? 1) === (b.requiredCount ?? 1)
    const added = option.goals.filter((goal) => !this.lastBodyGoals.some((previous) => same(goal, previous))).map((goal) => goal.description)
    const removed = this.lastBodyGoals.filter((previous) => !option.goals.some((goal) => same(goal, previous))).map((goal) => goal.description)
    this.lastBodySignature = signature
    this.lastBodyGoals = option.goals.map((goal) => ({ ...goal }))
    if (added.length === 0 && removed.length === 0) return
    this.log('STRATEGY_BODY_DELTA', { strategy, added, removed })
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
    source: 'llm' | 'fallback',
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
      rung: option.id,
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
    const stable: Record<string, number> = {}
    for (const [name, n] of Object.entries(counts)) if (n > 0) stable[name] = n
    const payload = {
      inventory: stable,
      frontier: computeFrontier(counts, this.world).rungId,
      stations: { tables: this.world.craftingTables.length, furnaces: this.world.furnaces.length },
      ores: [...this.world.discoveredOres].sort(),
      objective: request.objective.targetItem,
      objectiveHave: request.objective.haveCount,
    }
    return createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
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
    const key = resolveJevApiKey()
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
    try {
      if (!existsSync(this.cachePath)) return emptyCache()
      const parsed = JSON.parse(readFileSync(this.cachePath, 'utf8')) as Partial<PlannerCacheFile>
      if (typeof parsed.lastCallAt !== 'number' || typeof parsed.entries !== 'object' || parsed.entries === null) return emptyCache()
      return { version: 1, lastCallAt: parsed.lastCallAt, entries: parsed.entries }
    } catch {
      return emptyCache()
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
