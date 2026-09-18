// test-option-ladder.mts - Issue #21 dry-run demonstration: the compiled Options
// reproduce the current deterministic ladder for the M2 rungs, and the compiler
// is a no-op while BUDDY_OPTION_COMPILER is off. Pure: no bot, no server.
import { applyCompiledPlan, compilePlannedGoals, optionSpecsToPlannedGoals, makeOptionSnapshot } from '../jev-agent/src/optionSpec.ts'
import { bestPickaxeRank, buildPlanOptions, rungGoalsWithPrereq, RUNGS } from './planner.ts'
import { M2_PLAN_JSON, planFromJson } from '../jev-agent/src/system2.ts'
import { emptyWorldMemory } from './resident-types.ts'
import type { ResidentWorldMemory } from './resident-types.ts'
import type { PlannedGoal } from '../jev-agent/src/goalQueue.ts'
import { readFileSync } from 'node:fs'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const M2_LIVE: Record<string, number> = {
  crafting_table: 1,
  cobblestone: 22,
  oak_log: 2,
  stone_pickaxe: 1,
  furnace: 1,
  charcoal: 1,
}

const world = (over: Partial<ResidentWorldMemory> = {}): ResidentWorldMemory => ({ ...emptyWorldMemory(), ...over })

const M2_WORLD = world({ furnaces: [{ x: 1, y: 64, z: 1 }], discoveredOres: [] })

const M2_SNAPSHOT = makeOptionSnapshot({
  inventory: M2_LIVE,
  dimension: 'minecraft:overworld',
  toolRank: bestPickaxeRank(M2_LIVE),
  knownStations: ['furnace'],
})

function sameGoal(a: PlannedGoal, b: PlannedGoal): boolean {
  return (
    a.kind === b.kind &&
    a.description === b.description &&
    (a.targetItem ?? null) === (b.targetItem ?? null) &&
    (a.requiredCount ?? 1) === (b.requiredCount ?? 1)
  )
}

const M2_RUNG_IDS = ['cobblestone', 'furnace', 'stone_pickaxe', 'charcoal', 'raw_iron', 'iron_ingot', 'iron_pickaxe']

addCase('compiled Options match the current ladder for the M2 finish-iron-age rungs', () => {
  const option = buildPlanOptions(M2_LIVE, M2_WORLD).find((entry) => entry.id === 'finish_iron_age')
  if (option === undefined) return { pass: false, detail: 'finish_iron_age option missing from the ladder' }
  const compiled = applyCompiledPlan(option.goals, M2_SNAPSHOT, { enabled: true })
  const matches = compiled.goals.length === option.goals.length && option.goals.every((goal, index) => {
    const back = compiled.goals[index]
    return back !== undefined && sameGoal(goal, back)
  })
  const ladderIds = option.goals.map((goal) => `${goal.kind}:${goal.targetItem ?? ''}`)
  const addedKnown = compiled.added.every((id) => ladderIds.includes(id))
  return {
    pass: matches && addedKnown,
    detail: `ladder=[${option.goals.map((g) => g.targetItem).join(',')}] compiled=[${compiled.goals.map((g) => g.targetItem).join(',')}] added=[${compiled.added.join(',')}]`,
  }
})

addCase('every executable M2 rung compiles and round-trips to the same goal', () => {
  const mismatches: string[] = []
  for (const rung of RUNGS) {
    if (!M2_RUNG_IDS.includes(rung.id)) continue
    const goals = rungGoalsWithPrereq(rung, M2_LIVE, M2_WORLD)
    const specs = compilePlannedGoals(goals)
    const back = optionSpecsToPlannedGoals(specs)
    const ok = back.length === goals.length && goals.every((goal, index) => {
      const candidate = back[index]
      return candidate !== undefined && sameGoal(goal, candidate)
    })
    const idsStable = specs.every((spec, index) => {
      const goal = goals[index]
      return goal !== undefined && spec.id.startsWith(`${goal.kind}:`)
    })
    if (!ok || !idsStable) mismatches.push(rung.id)
  }
  return { pass: mismatches.length === 0, detail: `checked=${M2_RUNG_IDS.length} mismatches=[${mismatches.join(',')}]` }
})

addCase('the M2 plan JSON compiles into stable Option ids', () => {
  const specs = compilePlannedGoals(planFromJson(M2_PLAN_JSON))
  const ids = specs.map((spec) => spec.id)
  const expects = [
    'collect:log',
    'craft:crafting_table',
    'craft:wooden_pickaxe',
    'collect:cobblestone',
    'craft:furnace',
    'place:furnace',
    'craft:stone_pickaxe',
    'collect:log',
    'smelt:charcoal',
    'collect:raw_iron',
    'smelt:iron_ingot',
    'craft:iron_pickaxe',
    'collect:diamond',
    'craft:diamond_pickaxe',
  ]
  const deterministic = ids.join(',') === expects.join(',')
  const allValid = specs.every((spec) => spec.abortThreshold === 0.5 && spec.preconditions.length + spec.success.length > 0)
  return { pass: deterministic && allValid, detail: `n=${ids.length} ids=[${ids.join(',')}]` }
})

addCase('the compiler is opt-in: disabled keeps the ladder goals verbatim', () => {
  const option = buildPlanOptions(M2_LIVE, M2_WORLD).find((entry) => entry.id === 'finish_iron_age')
  if (option === undefined) return { pass: false, detail: 'finish_iron_age option missing from the ladder' }
  const disabled = applyCompiledPlan(option.goals, M2_SNAPSHOT, { enabled: false })
  const unchanged = disabled.goals.length === option.goals.length && option.goals.every((goal, index) => {
    const back = disabled.goals[index]
    return back !== undefined && sameGoal(goal, back)
  })
  const shadowSpecs = disabled.specs.length === option.goals.length
  return { pass: unchanged && shadowSpecs, detail: `enabled=${disabled.enabled} goals=${disabled.goals.length} shadowSpecs=${disabled.specs.length}` }
})

addCase('a cold bot still climbs the ladder front (no spurious expansion)', () => {
  const option = buildPlanOptions({}, world())[0]
  if (option === undefined) return { pass: false, detail: 'no ladder option for an empty inventory' }
  const cold = makeOptionSnapshot({ inventory: {}, toolRank: 0 })
  const compiled = applyCompiledPlan(option.goals, cold, { enabled: true })
  const matches = compiled.goals.length === option.goals.length && option.goals.every((goal, index) => {
    const back = compiled.goals[index]
    return back !== undefined && sameGoal(goal, back)
  })
  return { pass: matches && compiled.added.length === 0, detail: `ladder=[${option.goals.map((g) => g.targetItem).join(',')}] added=[${compiled.added.join(',')}]` }
})

addCase('an unmet smelt precondition is expanded in front of the ladder goal', () => {
  const spec = compilePlannedGoals([{ kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3 }])
  const expansion = applyCompiledPlan(
    [{ kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3 }],
    makeOptionSnapshot({ inventory: {}, knownStations: ['furnace'], toolRank: 2 }),
    { enabled: true },
  )
  const ids = expansion.specs.map((entry) => entry.id)
  const ok = spec.length === 1 && ids.join(',') === 'collect:raw_iron,smelt:iron_ingot'
  return { pass: ok, detail: `ids=[${ids.join(',')}] goals=[${expansion.goals.map((g) => g.targetItem).join(',')}]` }
})

addCase('the host wrapper emits the blocked-Option log and never silently drops the block (#50)', () => {
  const source = readFileSync(new URL('./option-brain.ts', import.meta.url), 'utf8')
  const emitsSharedMarker = source.includes('emitBlockedOptionLogs(result.blockedOptions, this.log)')
  const carriesStructured = source.includes('blockedOptions: result.blockedOptions')
  const goalsFromCompiled = source.includes('return { ...plan, goals: result.goals }')
  return { pass: emitsSharedMarker && carriesStructured && goalsFromCompiled, detail: `emit=${emitsSharedMarker} structured=${carriesStructured} goalsFromCompiled=${goalsFromCompiled}` }
})

let failures = 0
process.stdout.write('compiled Options vs the deterministic ladder (#21 dry run)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} option-ladder cases passed\n`)
if (failures > 0) process.exit(1)
