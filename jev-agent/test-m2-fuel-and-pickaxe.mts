// test-m2-fuel-and-pickaxe.mts - the two remaining M2 boundaries from live run
// run-mu8c89s6-rnv6 (RC 14288ca), as bounded, no-bot regression cases.
//
// A. craft: the queue reached `craft 1 x iron_pickaxe` holding `iron_ingot:1`
//    and the plan produced `craft 9 iron_nugget` instead:
//      CAUSAL ... optionId=craft:iron_pickaxe candidateId=CRAFT:iron_nugget
//      CRAFT_INGREDIENT_PREREQ item=iron_pickaxe missing=iron_nugget
//        producer=craft iron_nugget
//    The recipe descent treated the ONE held ingot as both the missing
//    `iron_ingot x3` and the input of the reverse `iron_ingot <= iron_nugget x9`
//    recipe (`iron_nugget <= iron_ingot x1`), converting it to nuggets.
//
// B. smelt: a single SMELT placed `raw_iron x3` with one charcoal and harvested
//    only one ingot, then the planner saw raw_iron absent:
//      SMELT_DONE ... gained=1 inputItem=raw_iron fuelItem=charcoal
//      SMELT_INPUT_PREREQ item=iron_ingot input=raw_iron present=false
//    Fuel was already sufficient (charcoal = 8 smelts); the poll stopped at
//    `harvested === 0` (#199). The initiation layer also demanded only ONE fuel
//    unit, which under-counts a log fuel (1.5 smelts).
//
// Run: bun test-m2-fuel-and-pickaxe.mts
import { createRequire } from 'node:module'
import { createRecipeIndex, planNextCraftStep } from './src/crafting.ts'
import { compilePlannedGoal, isOptionStartable, makeOptionSnapshot } from './src/optionSpec.ts'
import type { Predicate } from './src/optionSpec.ts'
import { executeFurnaceSmelt, formatSmeltLog } from './src/executor.ts'
import type { SmeltFurnaceWindow } from './src/executor.ts'
import type { PlannedGoal } from './src/goalQueue.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const require = createRequire(import.meta.url)
const index = createRecipeIndex(require('minecraft-data')('1.21.11'))

// --- A/B: the pickaxe craft must never convert the held ingot to nuggets -------

/** Apply the chosen pickaxe recipe to a copy of the inventory, exactly once. */
function applyPickaxeRecipe(inventory: Record<string, number>): Record<string, number> {
  const variant = index
    .recipesFor('iron_pickaxe')
    .find((entry) => entry.ingredients.some((ingredient) => ingredient.item === 'iron_ingot'))
  if (variant === undefined) throw new Error('no iron_pickaxe recipe in the index')
  const out = { ...inventory }
  for (const ingredient of variant.ingredients) {
    out[ingredient.item] = (out[ingredient.item] ?? 0) - ingredient.count
    if ((out[ingredient.item] ?? 0) <= 0) delete out[ingredient.item]
  }
  out[variant.resultItem] = (out[variant.resultItem] ?? 0) + variant.resultCount
  return out
}

addCase('(a) iron_pickaxe with 3 ingots + 2 sticks crafts the pickaxe and consumes exactly the recipe', () => {
  const inventory = { iron_ingot: 3, stick: 2 }
  const plan = planNextCraftStep(index, 'iron_pickaxe', inventory, true)
  const applied = applyPickaxeRecipe(inventory)
  const pass =
    plan.op !== null &&
    plan.op.type === 'craft' &&
    plan.op.item === 'iron_pickaxe' &&
    plan.op.count === 1 &&
    plan.op.requiresTable === true &&
    applied.iron_pickaxe === 1 &&
    applied.iron_ingot === undefined &&
    applied.stick === undefined &&
    applied.iron_nugget === undefined
  return {
    pass,
    detail: `op=${JSON.stringify(plan.op)} after=${JSON.stringify(applied)}`,
  }
})

addCase('(b) an unsatisfiable iron_pickaxe craft fails typed and never yields a nugget op', () => {
  const oneIngot = planNextCraftStep(index, 'iron_pickaxe', { iron_ingot: 1, stick: 2 }, true)
  const twoIngots = planNextCraftStep(index, 'iron_pickaxe', { iron_ingot: 2, stick: 2 }, true)
  const empty = planNextCraftStep(index, 'iron_pickaxe', {}, true)
  const reasons = [oneIngot.reason, twoIngots.reason, empty.reason]
  const noNuggetOp = [oneIngot.op, twoIngots.op, empty.op].every(
    (op) => op === null || (op.type === 'craft' && op.item !== 'iron_nugget'),
  )
  const pass =
    oneIngot.op === null &&
    twoIngots.op === null &&
    empty.op === null &&
    reasons.every((reason) => reason === 'no satisfiable recipe for iron_pickaxe') &&
    noNuggetOp
  return {
    pass,
    detail: `one=${JSON.stringify(oneIngot)} two=${JSON.stringify(twoIngots)} empty=${JSON.stringify(empty)}`,
  }
})

addCase('(b) the live inventory transition cannot happen: 1 ingot is neither crafted nor converted', () => {
  const before = { iron_ingot: 1, stick: 2 }
  const plan = planNextCraftStep(index, 'iron_pickaxe', before, true)
  const opItem = plan.op !== null && plan.op.type === 'craft' ? plan.op.item : null
  const pass = plan.op === null && opItem === null && (before.iron_ingot ?? 0) === 1
  return { pass, detail: `op=${opItem ?? 'null'} reason=${plan.reason} ingot=${before.iron_ingot}` }
})

// --- C: fuel accounting demands enough fuel for N smelts -----------------------

const SMELT_IRON: PlannedGoal = {
  kind: 'smelt',
  description: 'smelt 3 x iron_ingot',
  targetItem: 'iron_ingot',
  requiredCount: 3,
}

function fuelPredicate(spec: ReturnType<typeof compilePlannedGoal>): Predicate | undefined {
  return spec.preconditions.find(
    (predicate) => predicate.kind === 'inventoryClassAtLeast' && predicate.cls === 'fuel',
  )
}

addCase('(c) smelt 3 needs 2 fuel units with one log but is startable with one charcoal', () => {
  const logOne = makeOptionSnapshot({ inventory: { raw_iron: 3, oak_log: 1 }, knownStations: ['furnace'] })
  const logTwo = makeOptionSnapshot({ inventory: { raw_iron: 3, oak_log: 2 }, knownStations: ['furnace'] })
  const charOne = makeOptionSnapshot({ inventory: { raw_iron: 3, charcoal: 1 }, knownStations: ['furnace'] })
  const logOnePred = fuelPredicate(compilePlannedGoal(SMELT_IRON, logOne))
  const logTwoPred = fuelPredicate(compilePlannedGoal(SMELT_IRON, logTwo))
  const charOnePred = fuelPredicate(compilePlannedGoal(SMELT_IRON, charOne))
  const logOneFuel = logOnePred?.kind === 'inventoryClassAtLeast' ? logOnePred.count : null
  const logTwoFuel = logTwoPred?.kind === 'inventoryClassAtLeast' ? logTwoPred.count : null
  const charOneFuel = charOnePred?.kind === 'inventoryClassAtLeast' ? charOnePred.count : null
  // one log = 1.5 smelts, so smelt 3 is NOT startable until a second log; one
  // charcoal = 8 smelts, so it is.
  const pass =
    logOneFuel === 2 &&
    logTwoFuel === 2 &&
    charOneFuel === 1 &&
    isOptionStartable(compilePlannedGoal(SMELT_IRON, logOne), logOne) === false &&
    isOptionStartable(compilePlannedGoal(SMELT_IRON, logTwo), logTwo) === true &&
    isOptionStartable(compilePlannedGoal(SMELT_IRON, charOne), charOne) === true
  return {
    pass,
    detail: `log1=${logOneFuel} log2=${logTwoFuel} charcoal1=${charOneFuel} startable(log1)=${isOptionStartable(compilePlannedGoal(SMELT_IRON, logOne), logOne)}`,
  }
})

// --- C2: one SMELT action harvests the whole placed batch ----------------------

async function runBatchSmelt(): Promise<{
  outcome: Awaited<ReturnType<typeof executeFurnaceSmelt>>
  stash: Record<string, number>
  placed: { input: number; fuel: number }
}> {
  const stash: Record<string, number> = { raw_iron: 3, coal: 1, iron_ingot: 0 }
  const placed = { input: 0, fuel: 0 }
  let pending = 0
  const window: SmeltFurnaceWindow = {
    putInput: async (_type, _meta, count) => {
      pending = count
      placed.input = count
      stash.raw_iron = (stash.raw_iron ?? 0) - count
    },
    putFuel: async (_type, _meta, count) => {
      placed.fuel = count
      stash.coal = (stash.coal ?? 0) - count
    },
    outputItem: () => (pending > 0 ? { count: 1 } : null),
    takeOutput: async () => {
      pending -= 1
      stash.iron_ingot = (stash.iron_ingot ?? 0) + 1
    },
    // The real furnace empties the input slot when the LAST smelt begins while
    // that item is still cooking. Report it empty for the whole batch, so the
    // test fails if the harvest stop condition depends on the input slot.
    inputItem: () => null,
    fuelItem: () => ({ count: placed.fuel }),
    close: () => undefined,
  }
  const outcome = await executeFurnaceSmelt(
    {
      openFurnace: async () => window,
      inventoryItems: () => Object.entries(stash).map(([name, count], type) => ({ name, type, count })),
      countItem: (name) => stash[name] ?? 0,
      wait: async () => undefined,
      ensureOwned: () => undefined,
      timeoutMs: 5000,
      log: (event, detail) => formatSmeltLog(event, detail),
    },
    { inputItem: 'raw_iron', fuelItem: 'coal', outputItem: 'iron_ingot', inputCount: 3, fuelCount: 1 },
  )
  return { outcome, stash, placed }
}

addCase('(c2) a SMELT that places 3 raw_iron harvests all 3 ingots even as the input slot empties', async () => {
  const { outcome, stash, placed } = await runBatchSmelt()
  const pass =
    placed.input === 3 &&
    outcome.placedInput === 3 &&
    outcome.gained === 3 &&
    stash.iron_ingot === 3 &&
    stash.raw_iron === 0
  return {
    pass,
    detail: `placed=${placed.input} gained=${outcome.gained} iron_ingot=${stash.iron_ingot} raw_iron_left=${stash.raw_iron}`,
  }
})

let failures = 0
process.stdout.write('M2 remaining boundaries: iron_pickaxe craft + batch fuel/smelt\n')
process.stdout.write('-'.repeat(78) + '\n')
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(78) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} M2 fuel/pickaxe cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
