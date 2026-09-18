// test-pillar-search.mts - M2 heuristic audit: the PILLAR_UP search/cost/retry
// heuristics are localized in `PillarSearchPolicy` and every decision reports
// `{ chosen, score, alternatives, reason }`.
//
// Also pins behaviour equivalence with the audited extraction points:
// `selectPlaceableBlock`, `selectPillarFallbackColumn` and
// `planVerticalApproach(...).steps` must agree with the policy decisions.
//
//   npm run pillar-search-test
import {
  decidePillarPlaceBlock,
  decidePillarRelocation,
  decidePillarStepBudget,
  DEFAULT_PILLAR_SEARCH_POLICY,
  formatPillarSearch,
} from './src/pillarSearch.ts'
import type { PillarColumnProbe } from './src/pillarSearch.ts'
import {
  PILLAR_UP_STEP_CAP,
  planVerticalApproach,
  selectPillarFallbackColumn,
  selectPlaceableBlock,
} from './src/verticalPlan.ts'
import type { Vec3Json } from './src/state.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const open = (cell: Vec3Json): PillarColumnProbe => ({
  cell,
  supported: true,
  feetClear: true,
  headClear: true,
  aboveHeadClear: true,
  unsafe: false,
})

addCase('the policy defaults are the audited constants (step cap 24, relocations 2, headroom attempts 2)', () => {
  const pass =
    DEFAULT_PILLAR_SEARCH_POLICY.stepCap === 24 &&
    DEFAULT_PILLAR_SEARCH_POLICY.maxRelocations === 2 &&
    DEFAULT_PILLAR_SEARCH_POLICY.headroomAttempts === 2 &&
    PILLAR_UP_STEP_CAP === DEFAULT_PILLAR_SEARCH_POLICY.stepCap
  return {
    pass,
    detail: `stepCap=${DEFAULT_PILLAR_SEARCH_POLICY.stepCap} relocations=${DEFAULT_PILLAR_SEARCH_POLICY.maxRelocations} headroomAttempts=${DEFAULT_PILLAR_SEARCH_POLICY.headroomAttempts} PILLAR_UP_STEP_CAP=${PILLAR_UP_STEP_CAP}`,
  }
})

addCase('place-block decision reports chosen, score, alternatives and reason; matches selectPlaceableBlock', () => {
  const counts = { cobblestone: 2, dirt: 5, oak_planks: 1 }
  const decision = decidePillarPlaceBlock(counts)
  const legacy = selectPlaceableBlock(counts)
  const pass =
    decision.chosen === 'cobblestone' &&
    decision.score === 0 &&
    decision.kind === 'place-block' &&
    decision.reason === 'priority_order' &&
    decision.alternatives.map((entry) => entry.option).join(',') === 'dirt,oak_planks' &&
    legacy?.name === decision.chosen &&
    legacy.count === 2
  return { pass, detail: formatPillarSearch(decision) }
})

addCase('place-block refuses with none_held when no priority block is held', () => {
  const decision = decidePillarPlaceBlock({})
  const pass = decision.chosen === null && decision.reason === 'none_held' && decision.alternatives.length === 0
  return { pass, detail: formatPillarSearch(decision) }
})

addCase('step-budget chunks a 56-block gap to the cap and keeps a small gap exact', () => {
  const capped = decidePillarStepBudget(56)
  const small = decidePillarStepBudget(5)
  const pass =
    capped.steps === 24 &&
    capped.chosen === '24' &&
    capped.score === 24 &&
    capped.reason === 'bounded_by_step_cap' &&
    capped.alternatives.length === 0 &&
    small.steps === 5 &&
    small.reason === 'gap_below_step_cap' &&
    small.alternatives.some((entry) => entry.option === '24' && entry.reason === 'step_cap')
  return { pass, detail: `${formatPillarSearch(capped)} | ${formatPillarSearch(small)}` }
})

addCase('step-budget equivalence: planVerticalApproach uses the same bounded steps', () => {
  const feet = { x: 39, y: 31, z: 33 }
  const plan = planVerticalApproach({
    selfFeetY: feet.y,
    selfPosition: feet,
    target: { x: 43, y: 66, z: 33 },
    tunnel: null,
    descent: [],
    placeable: { name: 'cobblestone', count: 119 },
  })
  const decision = decidePillarStepBudget(66 - 31)
  const pass = plan?.kind === 'pillar' && plan.steps === decision.steps && plan.steps === 24
  return { pass, detail: `plan.steps=${plan?.kind === 'pillar' ? plan.steps : 'none'} decision.steps=${decision.steps}` }
})

addCase('relocation decision ranks open grounded columns and matches selectPillarFallbackColumn', () => {
  const feet = { x: 40, y: 8, z: 31 }
  const probes = [
    open({ x: 41, y: 8, z: 31 }),
    open({ x: 40, y: 8, z: 32 }),
    open({ x: 40, y: 8, z: 30 }),
  ]
  const decision = decidePillarRelocation({ relocations: 0, probes, self: feet })
  const legacy = selectPillarFallbackColumn(probes, feet)
  const pass =
    decision.chosen === '41,8,31' &&
    decision.target?.x === 41 &&
    decision.score === 1 &&
    decision.reason === 'nearest_open_grounded_column' &&
    legacy?.x === 41 &&
    legacy?.z === 31 &&
    decision.alternatives.length === 2
  return { pass, detail: formatPillarSearch(decision) }
})

addCase('relocation keeps probe order as the tie-break (same score -> first probe wins)', () => {
  const feet = { x: 40, y: 8, z: 31 }
  const probes = [open({ x: 40, y: 8, z: 32 }), open({ x: 41, y: 8, z: 31 })]
  const decision = decidePillarRelocation({ relocations: 1, probes, self: feet })
  const legacy = selectPillarFallbackColumn(probes, feet)
  const pass = decision.chosen === '40,8,32' && legacy?.x === 40 && legacy?.z === 32
  return { pass, detail: formatPillarSearch(decision) }
})

addCase('relocation refuses at the budget with everything still ranked in alternatives', () => {
  const feet = { x: 40, y: 8, z: 31 }
  const decision = decidePillarRelocation({ relocations: 2, probes: [open({ x: 41, y: 8, z: 31 })], self: feet })
  const pass =
    decision.chosen === null &&
    decision.target === null &&
    decision.reason === 'relocation_budget_exhausted' &&
    decision.alternatives.some((entry) => entry.option === '41,8,31' && entry.reason === 'grounded_open_column')
  return { pass, detail: formatPillarSearch(decision) }
})

addCase('relocation reports the filter that rejected each candidate, never hiding a considerable option', () => {
  const feet = { x: 40, y: 8, z: 31 }
  const probes: PillarColumnProbe[] = [
    { ...open({ x: 41, y: 8, z: 31 }), unsafe: true },
    { ...open({ x: 39, y: 8, z: 31 }), supported: false },
    { ...open({ x: 40, y: 8, z: 30 }), feetClear: false },
    { ...open({ x: 40, y: 8, z: 32 }), headClear: false, aboveHeadClear: false },
    open({ x: 41, y: 8, z: 32 }),
    open({ x: 41, y: 8, z: 33 }),
  ]
  const decision = decidePillarRelocation({ relocations: 0, probes, self: feet })
  const reasons = decision.alternatives.map((entry) => entry.reason).join(',')
  const pass =
    decision.chosen === '41,8,32' &&
    reasons.includes('hazard_column') &&
    reasons.includes('no_solid_support') &&
    reasons.includes('feet_blocked') &&
    reasons.includes('head_blocked') &&
    reasons.includes('grounded_open_column')
  return { pass, detail: formatPillarSearch(decision) }
})

addCase('the PILLAR_SEARCH line is one marker line with chosen, score, alternatives and reason', () => {
  const line = formatPillarSearch(decidePillarPlaceBlock({ stone: 3 }))
  const pass =
    line.startsWith('PILLAR_SEARCH ') &&
    line.includes('kind=place-block') &&
    line.includes('chosen=stone') &&
    line.includes('score=1') &&
    line.includes('alternatives=[]') &&
    line.includes('reason=priority_order')
  return { pass, detail: line }
})

let failures = 0
process.stdout.write('M2 heuristic audit - localized pillar search policy decisions\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} pillar-search cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
