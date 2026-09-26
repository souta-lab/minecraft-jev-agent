// test-skill-candidate.mts - Issue #20 unit tests: grounded SkillCandidate
// generation from the current strategy/goal + world memory + inventory, the
// code-checked preconditions, dependency expansion for unmet preconditions, and
// the proof that materially different strategies yield different skill lists.
// Pure: no bot, no network, no model.
import { readFileSync } from 'node:fs'
import {
  generateSkillPlan,
  generateSkillCandidates,
  expandSkillDependencies,
  evaluateSkillPreconditions,
  isSkillExecutable,
  skillSignature,
  formatSkillSelected,
  formatStrategyBodyDelta,
  branchMineSkill,
  type SkillCandidate,
  type SkillGenerationInput,
} from './src/skillCandidate.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const BASE: SkillGenerationInput = {
  inventory: { stone_pickaxe: 1 },
  toolRank: 2,
  position: { x: 10, y: 57, z: 10 },
  dimension: 'minecraft:overworld',
  world: {
    knownResources: [{ name: 'iron_ore', kind: 'ore', x: 25, y: 49, z: 36 }],
    craftingTables: [{ x: 1, y: 64, z: 1 }],
    furnaces: [],
    discoveredOres: ['iron_ore'],
  },
  goal: { kind: 'collect', targetItem: 'raw_iron', requiredCount: 3 },
}

const NO_KNOWN: SkillGenerationInput = {
  ...BASE,
  world: { knownResources: [], craftingTables: [], furnaces: [], discoveredOres: [] },
}

const STRATEGIES = ['branch_mine', 'explore_cave', 'return_to_known_ore', 'descend_to_y16'] as const

function ids(skills: readonly SkillCandidate[]): string[] {
  return skills.map((skill) => skill.id)
}

function plan(strategy: string, input: SkillGenerationInput = BASE): SkillCandidate[] {
  return generateSkillPlan({ ...input, strategy }).skills
}

addCase('every strategy compiles to its own grounded skill kind', () => {
  const byKind = new Map<string, string>()
  for (const strategy of STRATEGIES) {
    const skills = plan(strategy)
    byKind.set(strategy, skills.map((skill) => skill.kind).join(','))
  }
  const branch = byKind.get('branch_mine') ?? ''
  const cave = byKind.get('explore_cave') ?? ''
  const known = byKind.get('return_to_known_ore') ?? ''
  const descend = byKind.get('descend_to_y16') ?? ''
  const pass =
    branch.includes('branch_mine') &&
    cave.includes('explore_cave') &&
    known.includes('return_to_known_resource') &&
    descend.includes('descend_to') &&
    descend.includes('staircase')
  return { pass, detail: `branch=${branch} cave=${cave} known=${known} descend=${descend}` }
})

addCase('grounded parameters are deterministic and code-derived (no free text)', () => {
  const branch = plan('branch_mine')
  const known = plan('return_to_known_ore')
  const branchId = branch[0]?.id ?? ''
  const knownSkill = known.find((skill) => skill.kind === 'return_to_known_resource')
  const target = knownSkill?.target
  const noSpaces = ids([...branch, ...known]).every((id) => !/\s/.test(id))
  const knownGrounded =
    target?.position?.x === 25 && target?.position?.y === 49 && target?.position?.z === 36 && target?.resourceName === 'iron_ore'
  const pass =
    branchId === 'branch_mine:origin=10_57_10:heading=S:length=6' &&
    knownGrounded &&
    noSpaces &&
    knownSkill?.id === 'return_to_known_resource:raw_iron:mem=iron_ore@25_49_36'
  return { pass, detail: `branchId=${branchId} knownTarget=${JSON.stringify(target ?? null)} noSpaces=${noSpaces}` }
})

addCase('the same state generates the same skill list twice (pure)', () => {
  const first = skillSignature(plan('branch_mine'))
  const second = skillSignature(plan('branch_mine'))
  const goalFirst = skillSignature(generateSkillCandidates({ ...BASE, strategy: null }))
  const goalSecond = skillSignature(generateSkillCandidates({ ...BASE, strategy: null }))
  return { pass: first === second && goalFirst === goalSecond, detail: `strategy=${first} goal=${goalFirst}` }
})

addCase('two materially different strategies yield DIFFERENT skill lists for the same state', () => {
  const signatures = STRATEGIES.map((strategy) => skillSignature(plan(strategy)))
  const distinct = new Set(signatures)
  const pairwise =
    signatures[0] !== signatures[1] && signatures[1] !== signatures[2] && signatures[2] !== signatures[3] && signatures[0] !== signatures[3]
  return {
    pass: distinct.size === STRATEGIES.length && signatures.every((signature) => signature.length > 0) && pairwise,
    detail: `distinct=${distinct.size}/${STRATEGIES.length} sigs=${JSON.stringify(signatures)}`,
  }
})

addCase('a satisfied precondition leaves a single grounded skill', () => {
  const skills = plan('return_to_known_ore')
  const executable = skills.filter((skill) => isSkillExecutable(skill, BASE))
  return { pass: skills.length === 1 && executable.length === 1, detail: `skills=${ids(skills).join(',')} executable=${executable.length}` }
})

addCase('an unmet precondition expands into the dependency chain instead of stopping', () => {
  const skills = plan('return_to_known_ore', NO_KNOWN)
  const expansion = expandSkillDependencies(plan('return_to_known_ore', NO_KNOWN).at(-1) as SkillCandidate, NO_KNOWN)
  const hasExplore = skills.some((skill) => skill.kind === 'explore_cave')
  const keepsPrimary = skills.some((skill) => skill.kind === 'return_to_known_resource')
  const blockedWithProducer = expansion.blocked.filter((message) => message.includes('knownResourceFor')).length
  return {
    pass: hasExplore && keepsPrimary && skills.length === 2 && blockedWithProducer === 0,
    detail: `skills=${ids(skills).join(',')} added=${expansion.added.join(',')} blocked=${expansion.blocked.join(';') || 'none'}`,
  }
})

addCase('a missing tool expands to the pickaxe/station prerequisite chain', () => {
  const weak: SkillGenerationInput = { ...BASE, toolRank: 0, inventory: {}, world: { knownResources: [], craftingTables: [], furnaces: [], discoveredOres: [] } }
  const expansion = expandSkillDependencies(branchMineSkill(BASE), weak)
  const kinds = expansion.skills.map((skill) => skill.kind)
  const firstIsTable = expansion.skills[0]?.id === 'craft:crafting_table:count=1'
  const hasPlace = kinds.includes('place_station')
  const hasPickaxe = kinds.includes('craft') && expansion.skills.some((skill) => skill.target?.item === 'stone_pickaxe')
  return {
    pass: expansion.added.length === 3 && firstIsTable && hasPlace && hasPickaxe && kinds.at(-1) === 'branch_mine',
    detail: `order=${ids(expansion.skills).join(' -> ')} added=${expansion.added.length}`,
  }
})

addCase('preconditions are code-checked facts, not model text', () => {
  const branch = branchMineSkill(BASE)
  const ok = evaluateSkillPreconditions(branch, BASE)
  const weak = evaluateSkillPreconditions(branch, { ...BASE, toolRank: 0 })
  const goalSkills = generateSkillCandidates({ ...BASE, strategy: null })
  return {
    pass: ok.ok && !weak.ok && weak.unmet.length === 1 && goalSkills.some((skill) => skill.kind === 'collect_block'),
    detail: `ok=${ok.ok} weakUnmet=${weak.unmet.map((predicate) => predicate.kind).join(',')} goal=${ids(goalSkills).join(',')}`,
  }
})

addCase('the generator is model/network free (source has no LLM or mineflayer import)', () => {
  const source = readFileSync(new URL('./src/skillCandidate.ts', import.meta.url), 'utf8')
  const noLlm = !/from ['"]ai['"]/.test(source) && !source.includes('experimental_evaluate') && !source.includes('resolveJevApiKey')
  const noMineflayerRuntime = !/^import\s+(?!type)[^;]*from ['"]mineflayer['"]/m.test(source)
  const noBotCall = !source.includes('bot.dig') && !source.includes('bot.pathfinder')
  return { pass: noLlm && noMineflayerRuntime && noBotCall, detail: `noLlm=${noLlm} noMineflayerRuntime=${noMineflayerRuntime} noBotCall=${noBotCall}` }
})

let failures = 0
process.stdout.write('Grounded SkillCandidate / strategy grounding / dependency expansion (#20)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}

process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write('fixture log excerpt (planner wiring, same state):\n')
for (const strategy of STRATEGIES) {
  const skills = plan(strategy)
  for (const skill of skills) process.stdout.write(`  ${formatSkillSelected(skill, strategy)}\n`)
  process.stdout.write(`  ${formatStrategyBodyDelta(strategy, skills)}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} skill-candidate cases passed\n`)
if (failures > 0) process.exit(1)
