// #11/#56: normal execution must materialise first-class Options.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { applyCompiledPlan, makeOptionSnapshot } from './src/optionSpec.ts'
import type { PlannedGoal } from './src/goalQueue.ts'

// The compiler is unconditional: applyCompiledPlan compiles unless a caller
// explicitly passes enabled:false for an A/B fixture, and no environment
// switch can select the retired verbatim-PlannedGoal path.
const optionSpecSource = readFileSync(new URL('./src/optionSpec.ts', import.meta.url), 'utf8')
const legacySource = readFileSync(new URL('./src/optionSpec-legacy.ts', import.meta.url), 'utf8')
assert.ok(!/BUDDY_OPTION_COMPILER/.test(optionSpecSource), 'optionSpec.ts must not read BUDDY_OPTION_COMPILER')
assert.ok(!/BUDDY_OPTION_COMPILER/.test(legacySource), 'optionSpec-legacy.ts must not read BUDDY_OPTION_COMPILER')
assert.ok(!/resolveOptionCompilerEnabled/.test(optionSpecSource + legacySource), 'no env resolver may remain')

const planned: PlannedGoal[] = [{ kind: 'smelt', description: 'smelt 1 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 1 }]
const snapshot = makeOptionSnapshot({ inventory: { coal: 1 }, knownStations: ['furnace'], toolRank: 2 })
const compiled = applyCompiledPlan(planned, snapshot)
assert.ok(compiled.goals.length > 1 || compiled.goals.some((g) => g.targetItem !== 'iron_ingot'), 'default compilation must expand prerequisites')

process.stdout.write('#11 first-class Option default: PASS\n')
