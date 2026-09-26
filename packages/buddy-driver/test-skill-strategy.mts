// test-skill-strategy.mts - Issue #20 integration: the planner's strategy ->
// skill adapter. Proves the exact function the resident planner calls compiles
// strategies to different grounded skills and expands unmet preconditions.
import { compileStrategyOption, skillsForStrategy, plannedGoalToSkillGoal, goalsForStrategy, goalSignature } from './planner.ts'
import { emptyWorldMemory } from './resident-types.ts'
import type { ResidentWorldMemory } from './resident-types.ts'
import { formatSkillSelected, formatStrategyBodyDelta, skillSignature } from '../jev-agent/src/skillCandidate.ts'
import type { SkillCandidate } from '../jev-agent/src/skillCandidate.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const COUNTS = { stone_pickaxe: 1 }
const WORLD: ResidentWorldMemory = {
  ...emptyWorldMemory(),
  discoveredOres: ['iron_ore'],
  craftingTables: [{ x: 1, y: 64, z: 1 }],
  knownResources: [{ name: 'iron_ore', kind: 'ore', x: 25, y: 49, z: 36, dimension: 'minecraft:overworld', worldEpoch: 1 }],
}
const OPTS = { position: { x: 10, y: 57, z: 10 }, dimension: 'minecraft:overworld', toolRank: 2, goal: plannedGoalToSkillGoal({ kind: 'collect', description: 'collect 3 x raw_iron', targetItem: 'raw_iron', requiredCount: 3 }) }
const STRATEGIES = ['branch_mine', 'explore_cave', 'return_to_known_ore', 'descend_to_y16'] as const

function ids(skills: readonly SkillCandidate[]): string[] {
  return skills.map((skill) => skill.id)
}

addCase('planner adapter grounds each strategy to a distinct skill list', () => {
  const signatures = STRATEGIES.map((strategy) => skillSignature(skillsForStrategy(strategy, COUNTS, WORLD, OPTS)))
  const pass = new Set(signatures).size === STRATEGIES.length && signatures.every((signature) => signature.length > 0)
  return { pass, detail: `distinct=${new Set(signatures).size}/${STRATEGIES.length}` }
})

addCase('planner adapter grounds the known-ore skill to the remembered cell', () => {
  const skills = skillsForStrategy('return_to_known_ore', COUNTS, WORLD, OPTS)
  const target = skills[0]?.target
  const pass =
    skills.length === 1 &&
    target?.position?.x === 25 &&
    target?.position?.y === 49 &&
    target?.position?.z === 36 &&
    target?.memoryId === 'iron_ore@25_49_36'
  return { pass, detail: `skills=${ids(skills).join(',')} target=${JSON.stringify(target ?? null)}` }
})

addCase('planner adapter expands a weak tool into the prerequisite chain', () => {
  const weakWorld: ResidentWorldMemory = { ...emptyWorldMemory() }
  const skills = skillsForStrategy('branch_mine', {}, weakWorld, { position: { x: 10, y: 57, z: 10 }, dimension: 'minecraft:overworld', toolRank: 0, goal: plannedGoalToSkillGoal({ kind: 'collect', description: 'collect 3 x raw_iron', targetItem: 'raw_iron', requiredCount: 3 }) })
  const pass = skills.length === 4 && skills.at(-1)?.kind === 'branch_mine' && skills[0]?.id === 'craft:crafting_table:count=1'
  return { pass, detail: `order=${ids(skills).join(' -> ')}` }
})

addCase('the compiled goal plan also differs between the collect strategies (#29)', () => {
  const signatures = ['branch_mine', 'explore_cave', 'return_to_known_ore'].map((strategy) =>
    goalSignature(goalsForStrategy(strategy as (typeof STRATEGIES)[number], COUNTS, WORLD, { placedFurnacesNear: 0 })),
  )
  return { pass: new Set(signatures).size === 3, detail: `distinct=${new Set(signatures).size}/3 sigs=${JSON.stringify(signatures)}` }
})

addCase('typed strategy options preserve distinct intent, objective, and candidates (#29)', () => {
  const options = STRATEGIES.slice(0, 3).map((strategy) =>
    compileStrategyOption(strategy, COUNTS, WORLD, {
      placedFurnacesNear: 0,
      skill: OPTS,
    }),
  )
  const identities = options.map((option) => `${option.strategy}|${option.objective.targetItem}|${option.objective.requiredCount}`)
  const bodies = options.map((option) => `${goalSignature(option.goals)}#${skillSignature(option.skills)}`)
  const pass =
    options.every((option) => option.objective.targetItem === 'raw_iron' && option.objective.requiredCount === 3) &&
    new Set(identities).size === 3 &&
    new Set(bodies).size === 3
  return { pass, detail: `identities=${JSON.stringify(identities)} bodies=${JSON.stringify(bodies)}` }
})

let failures = 0
process.stdout.write('Planner strategy -> grounded skill adapter (#20)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write('resident-wiring fixture excerpt:\n')
for (const strategy of STRATEGIES) {
  const skills = skillsForStrategy(strategy, COUNTS, WORLD, OPTS)
  for (const skill of skills) process.stdout.write(`  ${formatSkillSelected(skill, strategy)}\n`)
  process.stdout.write(`  ${formatStrategyBodyDelta(strategy, skills)}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} skill-strategy cases passed\n`)
if (failures > 0) process.exit(1)
