// test-ladder.mts - #12 regression: a missing rung precondition becomes a
// LADDER_PREREQ plan replacement, never a generation stop. Pure, no bot.
import { buildLadder, goalsForStrategy, prerequisiteUnsatisfiable, rungGoalsWithPrereq, RUNGS } from './planner.ts'
import { emptyWorldMemory } from './resident-types.ts'
import type { ResidentWorldMemory } from './resident-types.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const world = (over: Partial<ResidentWorldMemory> = {}): ResidentWorldMemory => ({ ...emptyWorldMemory(), ...over })

const M2_LIVE = {
  cobblestone: 22,
  stone_pickaxe: 1,
  furnace: 1,
  charcoal: 1,
  oak_log: 2,
}

function rung(id: string) {
  const found = RUNGS.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`no rung ${id}`)
  return found
}

addCase('PRECONDITION_MISSING is immediately followed by LADDER_PREREQ and does not stop the ladder', () => {
  const log: Array<{ event: string; detail: Record<string, unknown> | undefined }> = []
  const ladder = buildLadder(M2_LIVE, world({ furnaces: [{ x: 1, y: 64, z: 1 }] }), (event, detail) => {
    log.push({ event, detail })
  })
  const missing = log.findIndex((entry) => entry.event === 'PRECONDITION_MISSING')
  const prereq = log.findIndex((entry) => entry.event === 'LADDER_PREREQ')
  const adjacent = missing >= 0 && prereq === missing + 1
  const chainIncludesOre = ladder.goals.some((goal) => goal.targetItem === 'raw_iron')
  const chainIncludesDescent = ladder.goals.some((goal) => goal.targetItem === 'cobblestone')
  const keptGoing = ladder.prereqReplaced && ladder.unsatisfiable === null && ladder.goals.length > 1
  return {
    pass: adjacent && chainIncludesOre && chainIncludesDescent && keptGoing,
    detail: `adjacent=${adjacent} replaced=${ladder.prereqReplaced} goals=[${ladder.goals.map((g) => g.targetItem).join(',')}]`,
  }
})

addCase('the descent prerequisite is emitted before its ore goal', () => {
  const goals = rungGoalsWithPrereq(rung('raw_iron'), M2_LIVE, world())
  const descent = goals.findIndex((goal) => goal.targetItem === 'cobblestone')
  const ore = goals.findIndex((goal) => goal.targetItem === 'raw_iron')
  const needed = M2_LIVE.cobblestone + 8
  const bounded = goals[0]?.requiredCount === needed
  return { pass: descent === 0 && ore === 1 && bounded, detail: `order=[${goals.map((g) => g.targetItem).join(',')}] required=${goals[0]?.requiredCount}` }
})

addCase('a provably unsatisfiable ore precondition is the only stop', () => {
  const none = prerequisiteUnsatisfiable(rung('raw_iron'), M2_LIVE, world(), 'minecraft:overworld')
  const known = prerequisiteUnsatisfiable(rung('raw_iron'), M2_LIVE, world({ discoveredOres: ['iron_ore'] }), 'minecraft:the_nether')
  const absent = prerequisiteUnsatisfiable(rung('raw_iron'), {}, world(), 'minecraft:the_nether')
  return {
    pass: none === null && known === null && absent !== null,
    detail: `overworld=${none} remembered=${known} netherAbsent=${absent}`,
  }
})

addCase('advisory ore strategies carry the descent prerequisite', () => {
  const goals = goalsForStrategy('return_to_known_ore', M2_LIVE, world({ furnaces: [{ x: 1, y: 64, z: 1 }] }))
  const descent = goals.some((goal) => goal.targetItem === 'cobblestone')
  const ore = goals.some((goal) => goal.targetItem === 'raw_iron')
  return { pass: descent && ore, detail: `goals=[${goals.map((g) => g.targetItem).join(',')}]` }
})

addCase('held furnace with none placed becomes a place-furnace prerequisite', () => {
  const counts = { ...M2_LIVE, charcoal: 0, furnace: 1 }
  const near = buildLadder(counts, world(), undefined, { placedFurnacesNear: 0 }).goals
  const placed = buildLadder(counts, world(), undefined, { placedFurnacesNear: 1 }).goals
  const placeIndex = near.findIndex((goal) => goal.kind === 'place' && goal.targetItem === 'furnace')
  const smeltIndex = near.findIndex((goal) => goal.targetItem === 'charcoal')
  const skippedWhenPlaced = !placed.some((goal) => goal.kind === 'place' && goal.targetItem === 'furnace')
  return {
    pass: placeIndex >= 0 && smeltIndex > placeIndex && skippedWhenPlaced,
    detail: `place@${placeIndex} charcoal@${smeltIndex} skippedWhenPlaced=${skippedWhenPlaced}`,
  }
})

let failures = 0
process.stdout.write('ladder precondition regression (#12)\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n      ${observed.detail}\n`)
}
process.stdout.write(`${cases.length - failures}/${cases.length} ladder cases passed\n`)
if (failures > 0) process.exit(1)
