// test-system2.mts - deterministic safety/shape tests for the real Gateway System 2 adapter.
// No network, no Minecraft server, no API key required.
import {
  plannedGoalsFromGateway,
  validateGatewayPlanOutput,
} from './src/gatewaySystem2.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
function addCase(name: string, run: Case['run']): void {
  cases.push({ name, run })
}

addCase('accepts a bounded patch plan and converts it to PlannedGoal', () => {
  const checked = validateGatewayPlanOutput({
    op: 'patch',
    goals: [{ kind: 'collect', targetItem: 'raw_iron', requiredCount: 3, detail: 'recover after surface search stalled' }],
    note: 'Search for iron before changing the rest of the ladder.',
  })
  if (!checked.success) return { pass: false, detail: checked.error.message }
  const goals = plannedGoalsFromGateway(checked.value)
  const goal = goals[0]
  const pass =
    goals.length === 1 &&
    goal?.kind === 'collect' &&
    goal.targetItem === 'raw_iron' &&
    goal.requiredCount === 3 &&
    goal.description === 'collect 3 x raw_iron'
  return { pass, detail: JSON.stringify({ checked: checked.value, goals }) }
})

addCase('rejects motor-level action kinds', () => {
  const checked = validateGatewayPlanOutput({
    op: 'replace',
    goals: [{ kind: 'MOVE', targetItem: 'p12_64_8', requiredCount: 1 }],
    note: 'bad motor plan',
  })
  return { pass: !checked.success, detail: checked.success ? 'unexpectedly accepted' : checked.error.message }
})

addCase('rejects coordinate-like / free-form target names', () => {
  const checked = validateGatewayPlanOutput({
    op: 'replace',
    goals: [{ kind: 'collect', targetItem: 'raw iron at 12,64,8', requiredCount: 3 }],
    note: 'bad target',
  })
  return { pass: !checked.success, detail: checked.success ? 'unexpectedly accepted' : checked.error.message }
})

addCase('abort requires an empty goal list', () => {
  const bad = validateGatewayPlanOutput({
    op: 'abort',
    goals: [{ kind: 'collect', targetItem: 'log', requiredCount: 1 }],
    note: 'contradictory abort',
  })
  const good = validateGatewayPlanOutput({ op: 'abort', goals: [], note: 'No executable recovery remains.' })
  const goodGoals = good.success ? plannedGoalsFromGateway(good.value) : ['invalid']
  return {
    pass: !bad.success && good.success && goodGoals.length === 0,
    detail: `bad=${bad.success ? 'accepted' : bad.error.message}; good=${good.success}; goals=${goodGoals.length}`,
  }
})

addCase('rejects unreasonable counts', () => {
  const zero = validateGatewayPlanOutput({
    op: 'patch',
    goals: [{ kind: 'collect', targetItem: 'stone', requiredCount: 0 }],
    note: 'zero',
  })
  const huge = validateGatewayPlanOutput({
    op: 'patch',
    goals: [{ kind: 'collect', targetItem: 'stone', requiredCount: 65 }],
    note: 'huge',
  })
  return { pass: !zero.success && !huge.success, detail: `zero=${zero.success} huge=${huge.success}` }
})

addCase('allows current resource-class names without special model privileges', () => {
  const checked = validateGatewayPlanOutput({
    op: 'continue',
    goals: [
      { kind: 'collect', targetItem: 'log', requiredCount: 2 },
      { kind: 'collect', targetItem: 'stone', requiredCount: 12 },
    ],
    note: 'Continue the deterministic capability ladder.',
  })
  if (!checked.success) return { pass: false, detail: checked.error.message }
  const goals = plannedGoalsFromGateway(checked.value)
  return {
    pass: goals.map((goal) => goal.targetItem).join(',') === 'log,stone',
    detail: goals.map((goal) => goal.description).join(' -> '),
  }
})

let failures = 0
process.stdout.write('Gateway System 2 - bounded structured planner tests\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} System 2 cases passed\n`)
if (failures > 0) process.exit(1)
