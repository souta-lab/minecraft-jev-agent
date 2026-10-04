// pillarSearch.ts - the localized search/cost/retry policy for PILLAR_UP.
//
// Audit docs/history/milestones/M2-HEURISTIC-AUDIT.md: the pillar step cap, relocation budget, headroom
// attempt bound, held-block priority and fallback-column ranking were implicit
// constants spread across verticalPlan.ts and executor.ts with no structured
// decision line. They are all SEARCH/COST/RETRY heuristics - allowed, but owned
// by one policy object that can report
// `{ chosen, score, alternatives, reason }` per decision, so a learned value
// function or Jev can replace them later.
//
// Pure and bot-free: the executor feeds live probes and inventory counts in.
import { resourceMatches } from './resourceClass.ts'
import type { Vec3Json } from './state.ts'

/**
 * Blocks that may be placed under the feet for a PILLAR_UP, in preference
 * order. The first name with a positive inventory count wins, so the choice is
 * deterministic and only solid, non-hazard building blocks are ever used.
 */
export const PILLAR_PLACE_PRIORITY: readonly string[] = [
  'cobblestone',
  'stone',
  'deepslate',
  'andesite',
  'diorite',
  'granite',
  'dirt',
  'netherrack',
  'oak_planks',
  'spruce_planks',
  'birch_planks',
  'jungle_planks',
  'acacia_planks',
  'dark_oak_planks',
  'mangrove_planks',
  'cherry_planks',
  'pale_oak_planks',
  'bamboo_planks',
  'crimson_planks',
  'warped_planks',
  'oak_log',
  'spruce_log',
  'birch_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log',
  'pale_oak_log',
  'bamboo_block',
  'crimson_stem',
  'warped_stem',
]

export interface PillarSearchPolicy {
  /** upper bound on one PILLAR_UP action's one-block placements */
  stepCap: number
  /** bounded same-action relocations away from a column whose ceiling cannot be cleared */
  maxRelocations: number
  /** bounded headroom dig attempts per column */
  headroomAttempts: number
  /** blocks that may be placed under the feet, in preference order */
  placePriority: readonly string[]
}

export const DEFAULT_PILLAR_SEARCH_POLICY: PillarSearchPolicy = {
  stepCap: 24,
  maxRelocations: 2,
  headroomAttempts: 2,
  placePriority: PILLAR_PLACE_PRIORITY,
}

export type PillarSearchKind = 'place-block' | 'step-budget' | 'relocate'

export interface PillarSearchAlternative {
  option: string
  /** lower is better; +Infinity when not rankable */
  score: number
  reason: string
}

/**
 * One `{ chosen, score, alternatives, reason }` decision. `target` carries the
 * chosen cell for spatial decisions (relocation), null otherwise.
 */
export interface PillarSearchDecision {
  kind: PillarSearchKind
  chosen: string | null
  target: Vec3Json | null
  score: number
  alternatives: PillarSearchAlternative[]
  reason: string
}

export interface PillarStepBudgetDecision extends PillarSearchDecision {
  kind: 'step-budget'
  steps: number
}

/** One probed neighbour column for the grounded pillar fallback. */
export interface PillarColumnProbe {
  /** feet cell of the neighbour column (same Y as the refused column) */
  cell: Vec3Json
  /** full solid support under the column */
  supported: boolean
  /** the feet cell itself is open */
  feetClear: boolean
  /** the block above the feet is open */
  headClear: boolean
  /** the second jump cell above the feet is open (2-block headroom) */
  aboveHeadClear: boolean
  /** fluid/hazard anywhere in the neighbour column (feet-1..feet+2) */
  unsafe: boolean
}

export interface PlaceableBlock {
  name: string
  count: number
}

function cellKey(cell: Vec3Json): string {
  return `${cell.x},${cell.y},${cell.z}`
}

/**
 * Pick the held pillar block from inventory counts by the policy priority.
 * `score` is the priority index; every other held priority block is an
 * alternative so the log shows what lost and why.
 */
export function decidePillarPlaceBlock(
  counts: Readonly<Record<string, number>>,
  policy: PillarSearchPolicy = DEFAULT_PILLAR_SEARCH_POLICY,
): PillarSearchDecision {
  const considered: PillarSearchAlternative[] = []
  for (let index = 0; index < policy.placePriority.length; index += 1) {
    const name = policy.placePriority[index]
    if (name === undefined) continue
    const count = counts[name] ?? 0
    if (count < 1) continue
    considered.push({ option: name, score: index, reason: 'priority_order' })
  }
  const best = considered[0] ?? null
  if (best === null) {
    return {
      kind: 'place-block',
      chosen: null,
      target: null,
      score: Number.POSITIVE_INFINITY,
      alternatives: [],
      reason: 'none_held',
    }
  }
  return {
    kind: 'place-block',
    chosen: best.option,
    target: null,
    score: best.score,
    alternatives: considered.slice(1),
    reason: 'priority_order',
  }
}

/** The bounded one-block step budget for one PILLAR_UP action. */
export function decidePillarStepBudget(
  dy: number,
  policy: PillarSearchPolicy = DEFAULT_PILLAR_SEARCH_POLICY,
): PillarStepBudgetDecision {
  const steps = Math.max(0, Math.min(Math.floor(dy), policy.stepCap))
  return {
    kind: 'step-budget',
    chosen: String(steps),
    target: null,
    steps,
    score: steps,
    alternatives: steps >= policy.stepCap ? [] : [{ option: String(policy.stepCap), score: policy.stepCap, reason: 'step_cap' }],
    reason: steps >= policy.stepCap ? 'bounded_by_step_cap' : 'gap_below_step_cap',
  }
}

function probeRejectionReason(probe: PillarColumnProbe): string | null {
  if (probe.unsafe) return 'hazard_column'
  if (!probe.supported) return 'no_solid_support'
  if (!probe.feetClear) return 'feet_blocked'
  if (!probe.headClear) return 'head_blocked'
  if (!probe.aboveHeadClear) return 'no_2_block_headroom'
  return null
}

/**
 * Rank the open, grounded fallback columns. Same score as the audited
 * implementation (`dy * 100 + horizontal`); the stable sort keeps the caller's
 * probe order as the tie-break, so there is no randomness and no flip-flop.
 */
export function rankPillarFallbackColumns(
  probes: readonly PillarColumnProbe[],
  self: Vec3Json,
): { cell: Vec3Json; score: number }[] {
  const ranked: { cell: Vec3Json; score: number }[] = []
  for (const probe of probes) {
    if (probeRejectionReason(probe) !== null) continue
    const dy = Math.abs(probe.cell.y - self.y)
    const horizontal = Math.hypot(probe.cell.x - self.x, probe.cell.z - self.z)
    ranked.push({ cell: probe.cell, score: dy * 100 + horizontal })
  }
  return ranked.sort((a, b) => a.score - b.score)
}

export interface PillarRelocationInput {
  /** relocations already spent this action */
  relocations: number
  policy?: PillarSearchPolicy
  probes: readonly PillarColumnProbe[]
  self: Vec3Json
}

/**
 * Choose the fallback column for a blocked PILLAR_UP ceiling, or refuse when the
 * relocation budget is spent or no probe qualifies. Every probe is reported:
 * feasible ones ranked, rejected ones with the filter that dropped them.
 */
export function decidePillarRelocation(input: PillarRelocationInput): PillarSearchDecision {
  const policy = input.policy ?? DEFAULT_PILLAR_SEARCH_POLICY
  const ranked = rankPillarFallbackColumns(input.probes, input.self)
  const rankedKeys = new Set(ranked.map((entry) => cellKey(entry.cell)))
  const losers = input.relocations >= policy.maxRelocations ? ranked : ranked.slice(1)
  const alternatives: PillarSearchAlternative[] = losers.map((entry) => ({
    option: cellKey(entry.cell),
    score: entry.score,
    reason: 'grounded_open_column',
  }))
  for (const probe of input.probes) {
    if (rankedKeys.has(cellKey(probe.cell))) continue
    alternatives.push({
      option: cellKey(probe.cell),
      score: Number.POSITIVE_INFINITY,
      reason: probeRejectionReason(probe) ?? 'not_ranked',
    })
  }
  if (input.relocations >= policy.maxRelocations) {
    return {
      kind: 'relocate',
      chosen: null,
      target: null,
      score: ranked[0]?.score ?? Number.POSITIVE_INFINITY,
      alternatives,
      reason: 'relocation_budget_exhausted',
    }
  }
  const best = ranked[0]
  if (best === undefined) {
    return {
      kind: 'relocate',
      chosen: null,
      target: null,
      score: Number.POSITIVE_INFINITY,
      alternatives,
      reason: 'no_open_grounded_column',
    }
  }
  return {
    kind: 'relocate',
    chosen: cellKey(best.cell),
    target: best.cell,
    score: best.score,
    alternatives,
    reason: 'nearest_open_grounded_column',
  }
}

/** The one structured decision line; every policy decision is logged with this. */
export function formatPillarSearch(decision: PillarSearchDecision): string {
  const alternatives = decision.alternatives
    .map((entry) => `${entry.option}@${Number.isFinite(entry.score) ? Math.round(entry.score * 100) / 100 : 'inf'}:${entry.reason}`)
    .join(',')
  const score = Number.isFinite(decision.score) ? Math.round(decision.score * 100) / 100 : 'inf'
  const target =
    decision.target === null ? '' : ` target=${decision.target.x},${decision.target.y},${decision.target.z}`
  return `PILLAR_SEARCH kind=${decision.kind} chosen=${decision.chosen ?? 'none'}${target} score=${score} alternatives=[${alternatives}] reason=${decision.reason}`
}

/**
 * The inventory a ROUTE may consume as scaffolding (pillar, bridge, descent
 * scaffold, pillar footing). Items that satisfy the active collect goal's target
 * are withheld: spending the held log to pillar toward a log, then mining the
 * placed block back, is a zero-sum loop whose both halves verify SUCCESS
 * (measured portal-p22: PILLAR_UP placing the only jungle_log -> MINE of that
 * placed block, 8+ cycles, wood rung stalled). Resource accounting only: no
 * route is ranked, and with nothing else held the route is refused
 * `no_placeable`, which opens the placeable-acquisition producers.
 */
export function routeScaffoldCounts(
  counts: Readonly<Record<string, number>>,
  goalQueue: { readonly current: { readonly kind: string; readonly targetItem: string | null } | null } | null | undefined,
): Readonly<Record<string, number>> {
  const current = goalQueue?.current ?? null
  const target = current !== null && current.kind === 'collect' ? current.targetItem : null
  if (target === null) return counts
  let withheld = false
  const spendable: Record<string, number> = {}
  for (const [name, count] of Object.entries(counts)) {
    if (resourceMatches(name, target)) withheld = true
    else spendable[name] = count
  }
  return withheld ? spendable : counts
}

/** The held pillar block from inventory counts; null when none is usable. */
export function selectPlaceableBlock(
  counts: Readonly<Record<string, number>>,
  policy: PillarSearchPolicy = DEFAULT_PILLAR_SEARCH_POLICY,
): PlaceableBlock | null {
  const decision = decidePillarPlaceBlock(counts, policy)
  if (decision.chosen === null) return null
  return { name: decision.chosen, count: counts[decision.chosen] ?? 0 }
}
