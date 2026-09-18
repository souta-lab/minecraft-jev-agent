// test-protected-goals.mts - issue #55 regression suite.
//
// Proves that prerequisite/core goals are a typed, code-enforced property of the
// plan representation, not a convention:
//   (a) a replace that would drop a protected goal re-inserts it and logs
//       PROTECTED_GOAL_REINSERTED; the goal survives;
//   (b) an explicit abort with a reason may remove a protected goal, and the
//       removal is logged with that reason (ABANDON_REASON ... protected=true);
//   (c) unprotected goals can still be replaced normally;
//   (d) an equivalent producer in the replacement satisfies the protected goal;
//   (e) an empty replace while protected work remains is rejected wholesale;
//   (f) snapshot/restore keeps the protection identity;
//   (g) the OptionSpec compiler round-trips protected/core.
//
// Run: node ../jev-agent/node_modules/.bin/tsx test-protected-goals.mts
import { GoalQueue } from './src/goalQueue.ts'
import type { PlannedGoal, QueuedGoal } from './src/goalQueue.ts'
import { compilePlannedGoals, optionSpecsToPlannedGoals } from './src/optionSpec.ts'
import { PROTECTED_GOAL_DROPPED_REJECTED, PROTECTED_GOAL_REINSERTED } from './src/protectedGoals.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

function seed(): GoalQueue {
  const queue = new GoalQueue()
  queue.applyPlan(
    [
      { kind: 'collect', description: 'collect 3 x oak_log', targetItem: 'oak_log', requiredCount: 3 },
      { kind: 'craft', description: 'craft 1 x furnace', targetItem: 'furnace', requiredCount: 1, protected: true },
      { kind: 'place', description: 'place 1 x furnace', targetItem: 'furnace', requiredCount: 1, protected: true },
      { kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3, core: true },
    ],
    'mechanical',
  )
  return queue
}

function findGoal(queue: GoalQueue, kind: string, item: string): QueuedGoal | undefined {
  return queue.state.goals.find((goal) => goal.kind === kind && goal.targetItem === item)
}

addCase('(a) a replace that would drop a protected prerequisite re-inserts it and the goal survives', () => {
  const queue = seed()
  queue.markProgress(3)
  const lines: string[] = []
  const added = queue.applyPlan(
    [{ kind: 'collect', description: 'collect 1 x diamond', targetItem: 'diamond', requiredCount: 1 }],
    'llm',
    'replace',
    { reason: 'mercury repair', onProtection: (line) => lines.push(line) },
  )
  const craft = findGoal(queue, 'craft', 'furnace')
  const place = findGoal(queue, 'place', 'furnace')
  const smelt = findGoal(queue, 'smelt', 'iron_ingot')
  const diamond = findGoal(queue, 'collect', 'diamond')
  const reinserted = lines.filter((line) => line.startsWith(PROTECTED_GOAL_REINSERTED))
  const pass =
    craft !== undefined &&
    place !== undefined &&
    smelt !== undefined &&
    diamond !== undefined &&
    added.length === 1 &&
    reinserted.length === 3 &&
    reinserted.every((line) => line.includes('op=replace') && line.includes('reason=mercury repair'))
  return {
    pass,
    detail: `surviving=[${[craft?.kind, place?.kind, smelt?.kind].join(',')}] added=${added.length} reinserted=${reinserted.length} lines=[${reinserted.join(' | ')}]`,
  }
})

addCase('(b) an explicit abort with a reason may remove a protected goal and logs the reason', () => {
  const queue = seed()
  queue.markProgress(3)
  const lines: string[] = []
  queue.applyPlan([], 'llm', 'abort', {
    reason: 'impossible: no cobblestone and no known furnace',
    onProtection: (line) => lines.push(line),
  })
  const craft = findGoal(queue, 'craft', 'furnace')
  const details = queue.state.goals.filter((goal) => goal.status !== 'done').map((goal) => goal.detail)
  const abandon = lines.filter((line) => line.startsWith('ABANDON_REASON'))
  const pass =
    craft !== undefined &&
    craft.status === 'impossible' &&
    typeof craft.detail === 'string' &&
    craft.detail.includes('no cobblestone') &&
    craft.detail.includes('(protected)') &&
    abandon.length === 3 &&
    abandon.every((line) => line.includes('protected=true') && line.includes('no cobblestone')) &&
    details.every((detail) => detail !== 'aborted by replan')
  return {
    pass,
    detail: `craftStatus=${craft?.status} craftDetail=${craft?.detail} abandon=[${abandon.join(' | ')}]`,
  }
})

addCase('(c) unprotected goals are still replaced normally with no protection log', () => {
  const queue = new GoalQueue()
  queue.applyPlan(
    [
      { kind: 'collect', description: 'collect 1 x oak_log', targetItem: 'oak_log', requiredCount: 1 },
      { kind: 'craft', description: 'craft 1 x crafting_table', targetItem: 'crafting_table', requiredCount: 1 },
    ],
    'llm',
  )
  const lines: string[] = []
  const added = queue.applyPlan(
    [{ kind: 'collect', description: 'collect 1 x bread', targetItem: 'bread', requiredCount: 1 }],
    'llm',
    'replace',
    { reason: 'unrelated', onProtection: (line) => lines.push(line) },
  )
  const replaced = findGoal(queue, 'collect', 'bread')
  const stale = findGoal(queue, 'craft', 'crafting_table')
  const pass = replaced !== undefined && stale === undefined && added.length === 1 && lines.length === 0
  return { pass, detail: `replaced=${replaced?.targetItem} stale=${stale?.targetItem ?? 'none'} lines=${lines.length}` }
})

addCase('(d) a replace that supplies an equivalent producer satisfies the protected goal without re-insertion', () => {
  const queue = new GoalQueue()
  queue.applyPlan(
    [
      { kind: 'collect', description: 'collect 8 x cobblestone (furnace material)', targetItem: 'cobblestone', requiredCount: 8, protected: true },
      { kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3, core: true },
    ],
    'mechanical',
  )
  const lines: string[] = []
  queue.applyPlan(
    [
      { kind: 'collect', description: 'collect 4 x cobblestone', targetItem: 'cobblestone', requiredCount: 4 },
      { kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3 },
    ],
    'llm',
    'replace',
    { reason: 'equivalent path', onProtection: (line) => lines.push(line) },
  )
  const cobble = queue.state.goals.filter((goal) => goal.targetItem === 'cobblestone')
  const reinserted = lines.filter((line) => line.startsWith(PROTECTED_GOAL_REINSERTED))
  const pass = cobble.length === 1 && cobble[0]?.requiredCount === 4 && reinserted.length === 0
  return { pass, detail: `cobbleGoals=${cobble.length} requiredCount=${cobble[0]?.requiredCount} reinserted=${reinserted.length}` }
})

addCase('(e) an empty replace while protected work remains is rejected wholesale', () => {
  const queue = seed()
  queue.markProgress(3)
  const lines: string[] = []
  queue.applyPlan([], 'llm', 'replace', { reason: 'empty model repair', onProtection: (line) => lines.push(line) })
  const craft = findGoal(queue, 'craft', 'furnace')
  const rejected = lines.filter((line) => line.startsWith(PROTECTED_GOAL_DROPPED_REJECTED))
  const pass =
    craft !== undefined &&
    craft.status !== 'impossible' &&
    queue.state.done === 1 &&
    rejected.length === 3 &&
    rejected.every((line) => line.includes('op=replace') && line.includes('empty model repair'))
  return { pass, detail: `craftStatus=${craft?.status} done=${queue.state.done} rejected=${rejected.length} lines=[${rejected.join(' | ')}]` }
})

addCase('(f) snapshot/restore keeps the protection identity across a reload', () => {
  const queue = seed()
  const snapshot = queue.snapshot()
  const restored = new GoalQueue()
  restored.restore(snapshot)
  const lines: string[] = []
  restored.applyPlan(
    [{ kind: 'collect', description: 'collect 1 x diamond', targetItem: 'diamond', requiredCount: 1 }],
    'llm',
    'replace',
    { reason: 'after reload', onProtection: (line) => lines.push(line) },
  )
  const craft = findGoal(restored, 'craft', 'furnace')
  const reinserted = lines.filter((line) => line.startsWith(PROTECTED_GOAL_REINSERTED))
  const pass = craft !== undefined && craft.protected === true && reinserted.length === 3
  return { pass, detail: `protected=${craft?.protected} corePresent=${findGoal(restored, 'smelt', 'iron_ingot') !== undefined} reinserted=${reinserted.length}` }
})

addCase('(g) the OptionSpec compiler round-trips protected/core', () => {
  const goals: PlannedGoal[] = [
    { kind: 'place', description: 'place 1 x furnace', targetItem: 'furnace', requiredCount: 1, protected: true },
    { kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3, core: true },
  ]
  const back = optionSpecsToPlannedGoals(compilePlannedGoals(goals))
  const pass =
    back[0]?.protected === true &&
    back[0]?.core === undefined &&
    back[1]?.core === true &&
    back[1]?.protected === undefined
  return { pass, detail: `roundTrip=[${back.map((goal) => `${goal.kind}:p=${String(goal.protected)}:c=${String(goal.core)}`).join(',')}]` }
})

let failures = 0
process.stdout.write('issue #55 - protected/core goal enforcement\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} protected-goal cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
