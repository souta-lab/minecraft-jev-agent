// test-m1.mts - deterministic proof of the M1 mechanics, no bot and no network:
//
//   1. the M1 plan JSON maps to the four ordered subgoals;
//   2. the pure recipe planner emits the exact craft/place chain for the M1
//      inventory states (oak_log -> oak_planks -> crafting_table -> stick ->
//      place table -> wooden_pickaxe) using the REAL 1.21.11 recipes;
//   3. the single-shot planner stub supplies the plan once and never again;
//   4. a craft subgoal completes on the live inventory count.
import { createRequire } from 'node:module'
import { createRecipeIndex, planNextCraftStep } from './src/crafting.ts'
import type { CraftOp } from './src/crafting.ts'
import { GoalQueue } from './src/goalQueue.ts'
import { FixedPlanSystem2, M1_PLAN_JSON, planFromJson } from './src/system2.ts'
import type { System2PlanRequest } from './src/system2.ts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11') as unknown
const index = createRecipeIndex(registry)

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}

const cases: Case[] = []

function addCase(name: string, run: Case['run']): void {
  cases.push({ name, run })
}

function opKey(op: CraftOp | null): string {
  if (op === null) return 'none'
  return op.type === 'craft' ? `craft:${op.item}${op.requiresTable ? '@table' : ''}` : `place:${op.item}`
}

addCase('recipe index resolves the 1.21.11 crafting chain', () => {
  const planks = index.recipesFor('oak_planks')
  const pickaxe = index.recipesFor('wooden_pickaxe')
  const table = index.recipesFor('crafting_table')
  const pass =
    index.version === '1.21.11' &&
    planks[0] !== undefined &&
    planks[0].ingredients.some((i) => i.item === 'oak_log') &&
    table.some((variant) => !variant.requiresTable) &&
    pickaxe.some((variant) => variant.requiresTable)
  return {
    pass,
    detail: `version=${index.version} oak_planks<=${planks[0]?.ingredients.map((i) => `${i.item}x${i.count}`).join('+')} pickaxeRequiresTable=${pickaxe.some((v) => v.requiresTable)}`,
  }
})

addCase('M1 plan JSON maps to the four ordered subgoals', () => {
  const goals = planFromJson(M1_PLAN_JSON)
  const pass =
    goals.length === 4 &&
    goals[0]?.kind === 'collect' &&
    goals[0]?.targetItem === 'oak_log' &&
    goals[0]?.requiredCount === 3 &&
    goals[1]?.kind === 'craft' &&
    goals[1]?.targetItem === 'crafting_table' &&
    goals[2]?.targetItem === 'wooden_pickaxe' &&
    goals[3]?.kind === 'collect' &&
    goals[3]?.targetItem === 'cobblestone' &&
    goals[3]?.requiredCount === 16
  return { pass, detail: goals.map((g) => `${g.kind}:${g.targetItem}x${g.requiredCount}`).join(' -> ') }
})

addCase('planner walks the exact M1 craft chain to wooden_pickaxe', () => {
  const inventory: Record<string, number> = { oak_log: 3 }
  const steps: string[] = []
  const apply = (op: CraftOp): void => {
    steps.push(opKey(op))
    if (op.type === 'place') {
      return
    }
    if (op.item === 'oak_planks') {
      inventory.oak_log = (inventory.oak_log ?? 0) - 1
      inventory.oak_planks = (inventory.oak_planks ?? 0) + 4
    } else if (op.item === 'crafting_table') {
      inventory.oak_planks = (inventory.oak_planks ?? 0) - 4
      inventory.crafting_table = (inventory.crafting_table ?? 0) + 1
    } else if (op.item === 'stick') {
      inventory.oak_planks = (inventory.oak_planks ?? 0) - 2
      inventory.stick = (inventory.stick ?? 0) + 4
    } else if (op.item === 'wooden_pickaxe') {
      inventory.oak_planks = (inventory.oak_planks ?? 0) - 3
      inventory.stick = (inventory.stick ?? 0) - 2
      inventory.wooden_pickaxe = (inventory.wooden_pickaxe ?? 0) + 1
    }
  }

  let tableAvailable = false
  let currentGoal = 'crafting_table'
  let guard = 0
  while (guard < 12) {
    guard += 1
    const result = planNextCraftStep(index, currentGoal, inventory, tableAvailable)
    if (result.op === null) {
      if (currentGoal === 'wooden_pickaxe') break
      throw new Error(`no op for ${currentGoal}: ${result.reason}`)
    }
    if (result.op.type === 'place') tableAvailable = true
    apply(result.op)
    if (currentGoal === 'crafting_table' && (inventory.crafting_table ?? 0) >= 1) currentGoal = 'wooden_pickaxe'
  }

  const expected = [
    'craft:oak_planks',
    'craft:crafting_table',
    'craft:oak_planks',
    'craft:stick',
    'craft:oak_planks',
    'place:crafting_table',
    'craft:wooden_pickaxe@table',
  ]
  const pass =
    steps.length === expected.length &&
    steps.every((step, i) => step === expected[i]) &&
    (inventory.wooden_pickaxe ?? 0) === 1
  return { pass, detail: steps.join(' -> ') }
})

addCase('single-shot planner supplies the plan once then stays silent', async () => {
  const brain = new FixedPlanSystem2(null, planFromJson(M1_PLAN_JSON))
  const request: System2PlanRequest = {
    reason: 'queue_empty',
    detail: 'test',
    tick: 0,
    goalQueueState: { depth: 0, current: null, empty: true, hasImpossible: false, done: 0, goals: [] },
    objective: { targetItem: 'oak_log', requiredCount: 3, haveCount: 0, complete: false },
    recentEvents: [],
    recentOutcomes: [],
  }
  const first = await brain.plan(request)
  const second = await brain.plan(request)
  return {
    pass: first.goals.length === 4 && second.goals.length === 0 && brain.callCount === 2,
    detail: `first=${first.goals.length} goals, second=${second.goals.length} goals, calls=${brain.callCount}`,
  }
})

addCase('craft subgoal completes on the live inventory count', () => {
  const queue = new GoalQueue()
  queue.applyPlan(planFromJson(M1_PLAN_JSON), 'llm')
  queue.markProgress(3)
  const afterCollect = queue.state.current?.targetItem ?? null
  queue.markProgress(1)
  const afterTable = queue.state.current?.targetItem ?? null
  queue.markProgress(1)
  const afterPickaxe = queue.state.current?.targetItem ?? null
  const pass =
    afterCollect === 'crafting_table' &&
    afterTable === 'wooden_pickaxe' &&
    afterPickaxe === 'cobblestone' &&
    queue.state.done === 3
  return {
    pass,
    detail: `after 3 oak_log -> ${afterCollect}; after table -> ${afterTable}; after pickaxe -> ${afterPickaxe}; done=${queue.state.done}`,
  }
})

let failures = 0
process.stdout.write('M1 - plan queue + craft chain + single-shot planner\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} M1 cases passed\n`)

if (failures > 0) process.exit(1)
