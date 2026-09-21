// test-iron-ingot-rung.mts - the `iron_ingot` ladder rung must not re-derive a
// dead smelt once its downstream product already exists (#prereq-orphan).
//
// Live blocker (runId `run-mub35qdr-1e1dh`): the bot held `flint_and_steel=1`
// and `diamond_pickaxe=1` while `iron_ingot=0`. `rung.satisfied` only looked at
// the raw ingot count, so `iron_ingot` stayed in `reachableUnsatisfiedRungs` and
// `buildPlanOptions` kept offering the mandatory-road options whose goals include
// `smelt ... iron_ingot` (plus the `craft/place crafting_table/furnace`
// prerequisite chain). Mercury then patched that dead smelt back into the
// durable queue on every consultation, behind the queue head it could never
// reach.
//
// The rung's ingots serve exactly two consumers: the iron pickaxe and the
// flint_and_steel. When BOTH are already fulfilled the rung is satisfied; when
// either is missing, more iron is genuinely needed and the rung stays open.
//
// Run: bun test ./test-iron-ingot-rung.mts
import { buildPlanOptions, computeFrontier, reachableUnsatisfiedRungs } from './planner.ts'
import type { Counts } from './planner-legacy.ts'
import { emptyWorldMemory } from './resident-types.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

function unsatIds(counts: Counts): string[] {
  return reachableUnsatisfiedRungs(counts, emptyWorldMemory()).map((rung) => rung.id)
}

/** The mandatory road options System2/Jev may choose from. */
const MANDATORY_OPTION_PREFIXES = ['front_', 'two_rungs', 'full_ladder', 'finish_iron_age', 'diamond_road']

function mandatorySmeltGoals(counts: Counts): string[] {
  return buildPlanOptions(counts, emptyWorldMemory())
    .filter((option) => MANDATORY_OPTION_PREFIXES.some((prefix) => option.id === prefix || option.id.startsWith(prefix)))
    .flatMap((option) => option.goals)
    .filter((goal) => goal.kind === 'smelt' && goal.targetItem === 'iron_ingot')
    .map((goal) => goal.description)
}

addCase('(a) holding the consumed flint_and_steel plus an iron pickaxe retires the rung', () => {
  // Only iron tier (rank 3), so the diamond-pickaxe capability closure does NOT
  // cover this rung: the new `satisfied` clause is what retires it.
  const counts: Counts = { flint_and_steel: 1, iron_pickaxe: 1, raw_iron: 2, cobblestone: 383 }
  const unsat = unsatIds(counts)
  const smeltGoals = mandatorySmeltGoals(counts)
  const pass = !unsat.includes('iron_ingot') && smeltGoals.length === 0
  return {
    pass,
    detail: `ironIngotUnsat=${unsat.includes('iron_ingot')} mandatorySmelt=[${smeltGoals.join(' | ')}]`,
  }
})

addCase('(a2) the measured live inventory (diamond pickaxe) also retires the rung', () => {
  const counts: Counts = { flint_and_steel: 1, diamond_pickaxe: 1, raw_iron: 2, cobblestone: 383 }
  const unsat = unsatIds(counts)
  const smeltGoals = mandatorySmeltGoals(counts)
  const frontier = computeFrontier(counts, emptyWorldMemory())
  const pass = !unsat.includes('iron_ingot') && smeltGoals.length === 0 && frontier.rungId !== 'iron_ingot'
  return {
    pass,
    detail: `frontier=${frontier.rungId} ironIngotUnsat=${unsat.includes('iron_ingot')} mandatorySmelt=[${smeltGoals.join(' | ')}]`,
  }
})

addCase('(b) a still-needed rung stays open (no iron-or-better pickaxe purpose served)', () => {
  // flint_and_steel is held, but only a stone pickaxe: the 3-ingot iron pickaxe
  // is still genuinely required.
  const counts: Counts = { flint_and_steel: 1, stone_pickaxe: 1, raw_iron: 2 }
  const unsat = unsatIds(counts)
  const smeltGoals = mandatorySmeltGoals(counts)
  const pass = unsat.includes('iron_ingot') && smeltGoals.length > 0
  return {
    pass,
    detail: `ironIngotUnsat=${unsat.includes('iron_ingot')} mandatorySmelt=${smeltGoals.length} [${smeltGoals[0] ?? 'none'}]`,
  }
})

addCase('(c) a still-needed rung stays open (no flint_and_steel consumer yet)', () => {
  // An iron pickaxe exists, but the flint_and_steel consumer is unmet.
  const counts: Counts = { iron_pickaxe: 1, raw_iron: 2, cobblestone: 64 }
  const unsat = unsatIds(counts)
  const smeltGoals = mandatorySmeltGoals(counts)
  const pass = unsat.includes('iron_ingot') && smeltGoals.length > 0
  return {
    pass,
    detail: `ironIngotUnsat=${unsat.includes('iron_ingot')} mandatorySmelt=${smeltGoals.length} [${smeltGoals[0] ?? 'none'}]`,
  }
})

addCase('(d) the raw ingot count still satisfies the rung', () => {
  const counts: Counts = { iron_ingot: 3 }
  const unsat = unsatIds(counts)
  const pass = !unsat.includes('iron_ingot') && mandatorySmeltGoals(counts).length === 0
  return { pass, detail: `ironIngotUnsat=${unsat.includes('iron_ingot')}` }
})

let failures = 0
process.stdout.write('iron_ingot rung dominated-step guard\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} iron_ingot rung cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
