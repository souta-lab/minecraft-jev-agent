// test-observability.mts - Issue #32 for the high-level planner: the raw
// strategy_change P(true) is preserved instead of being collapsed to `> 0.5`.
// Pure: imports only the exported parse helpers, no bot, no network.
import { readBooleanProbability, resolveStrategyChangeThreshold, STRATEGY_CHANGE_THRESHOLD_DEFAULT } from './planner.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

addCase('#32: 0.08 stays 0.08 (never collapsed to false)', () => {
  const probability = readBooleanProbability({ probability: 0.08 })
  const high = readBooleanProbability({ probability: 0.99 })
  const pass = probability === 0.08 && high === 0.99 && (probability ?? 0) < 0.5
  return { pass, detail: `p(0.08)=${probability} p(0.99)=${high}` }
})

addCase('#32: malformed / missing probability is explicit null', () => {
  const missing = readBooleanProbability({})
  const text = readBooleanProbability({ probability: 'yes' })
  const notFinite = readBooleanProbability({ probability: Number.NaN })
  return { pass: missing === null && text === null && notFinite === null, detail: `missing=${missing} text=${text} nan=${notFinite}` }
})

addCase('#32: strategy-change threshold is a named, configurable constant', () => {
  const def = resolveStrategyChangeThreshold({})
  const overridden = resolveStrategyChangeThreshold({ BUDDY_STRATEGY_CHANGE_THRESHOLD: '0.8' })
  const invalid = resolveStrategyChangeThreshold({ BUDDY_STRATEGY_CHANGE_THRESHOLD: '2' })
  const pass = def === 0.5 && STRATEGY_CHANGE_THRESHOLD_DEFAULT === 0.5 && overridden === 0.8 && invalid === 0.5
  return { pass, detail: `default=${def} overridden=${overridden} invalid->${invalid}` }
})

let failures = 0
process.stdout.write('planner observability - raw strategy_change probability (#32)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} planner-observability cases passed\n`)
if (failures > 0) process.exit(1)
