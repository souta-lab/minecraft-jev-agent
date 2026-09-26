// test-furnace-transfer.mts - transactional furnace-window transfer guards.
// Pure fixtures for the live M2 failure: a SMELT input transfer succeeded,
// fuel transfer failed, and the next attempt saw `destination full`.
import { ExecutorError, executeFurnaceSmelt, formatSmeltLog } from './src/executor.ts'
import type { SmeltFurnaceWindow } from './src/executor.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

function deps(
  window: SmeltFurnaceWindow,
  items: () => Array<{ name: string; type: number; count: number }>,
  lines: string[],
): Parameters<typeof executeFurnaceSmelt>[0] {
  return {
    openFurnace: async () => window,
    inventoryItems: items,
    countItem: (name) => items().filter((entry) => entry.name === name).reduce((sum, entry) => sum + entry.count, 0),
    wait: async () => undefined,
    ensureOwned: () => undefined,
    timeoutMs: 1,
    log: (event, detail) => lines.push(formatSmeltLog(event, detail)),
  }
}

const params = {
  inputItem: 'oak_log',
  fuelItem: 'oak_log',
  outputItem: 'charcoal',
  inputCount: 1,
  fuelCount: 1,
}

addCase('same input/fuel item is preflighted as one shared inventory budget', async () => {
  const stash = [{ name: 'oak_log', type: 1, count: 1 }]
  let inputCalls = 0
  let fuelCalls = 0
  const window: SmeltFurnaceWindow = {
    putInput: async () => { inputCalls += 1 },
    putFuel: async () => { fuelCalls += 1 },
    outputItem: () => null,
    takeOutput: async () => undefined,
    close: () => undefined,
  }
  const lines: string[] = []
  let error: unknown = null
  try {
    await executeFurnaceSmelt(deps(window, () => stash, lines), params)
  } catch (caught) {
    error = caught
  }
  const typed = error instanceof ExecutorError && error.code === 'smelt_error'
  const pass = typed && inputCalls === 0 && fuelCalls === 0 && lines.length === 0
  return { pass, detail: `typed=${typed} inputCalls=${inputCalls} fuelCalls=${fuelCalls} lines=${lines.join('|') || 'none'}` }
})

addCase('fuel-transfer failure rolls back a newly placed input and emits no placement marker', async () => {
  const stash = [{ name: 'oak_log', type: 1, count: 2 }]
  let inputCalls = 0
  let rollbackCalls = 0
  const window: SmeltFurnaceWindow = {
    putInput: async (_type, _meta, count) => {
      inputCalls += 1
      stash[0]!.count -= count
    },
    putFuel: async () => { throw new Error('destination full') },
    outputItem: () => null,
    takeOutput: async () => undefined,
    takeInput: async () => {
      rollbackCalls += 1
      stash[0]!.count += 1
    },
    close: () => undefined,
  }
  const lines: string[] = []
  let error: unknown = null
  try {
    await executeFurnaceSmelt(deps(window, () => stash, lines), params)
  } catch (caught) {
    error = caught
  }
  const typed = error instanceof ExecutorError && error.code === 'smelt_error'
  const pass = typed && inputCalls === 1 && rollbackCalls === 1 && stash[0]!.count === 2 && lines.length === 1 && lines[0]!.startsWith('SMELT_ROLLBACK ')
  return { pass, detail: `typed=${typed} inputCalls=${inputCalls} rollbackCalls=${rollbackCalls} oak_log=${stash[0]!.count} lines=${lines.join('|')}` }
})

addCase('a matching pre-existing input slot is reused before adding fuel', async () => {
  const stash = [
    { name: 'oak_log', type: 1, count: 0 },
    { name: 'birch_planks', type: 2, count: 1 },
    { name: 'charcoal', type: 3, count: 0 },
  ]
  let inputCalls = 0
  let fuelCalls = 0
  let outputPending = true
  const window: SmeltFurnaceWindow = {
    inputItem: () => ({ name: 'oak_log', count: 1 }),
    fuelItem: () => null,
    putInput: async () => { inputCalls += 1 },
    putFuel: async (_type, _meta, count) => {
      fuelCalls += 1
      stash[1]!.count -= count
    },
    outputItem: () => outputPending ? { name: 'charcoal', count: 1 } : null,
    takeOutput: async () => {
      outputPending = false
      stash[2]!.count += 1
    },
    close: () => undefined,
  }
  const lines: string[] = []
  const outcome = await executeFurnaceSmelt(
    { ...deps(window, () => stash, lines), timeoutMs: 100 },
    { ...params, fuelItem: 'birch_planks' },
  )
  const pass = inputCalls === 0 && fuelCalls === 1 && outcome.gained === 1 && stash[2]!.count === 1 && lines.some((line) => line.startsWith('SMELT_PLACED '))
  return { pass, detail: `inputCalls=${inputCalls} fuelCalls=${fuelCalls} gained=${outcome.gained} charcoal=${stash[2]!.count} lines=${lines.join('|')}` }
})

let failures = 0
process.stdout.write('furnace transfer transaction guards\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const result = await testCase.run()
  if (!result.pass) failures += 1
  process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${result.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} furnace transfer cases passed\n`)
if (failures > 0) process.exit(1)
