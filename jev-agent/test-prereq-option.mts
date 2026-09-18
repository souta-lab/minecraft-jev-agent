// test-prereq-option.mts - issue #58 unit proof for flexible prerequisite
// satisfaction: cost-scored path generation (place held / known station /
// craft-and-place), the exact PREREQ_OPTION and PREREQ_SWITCH log lines, the
// stall-triggered path switch, and that the parent goal stays protected.
//
// Run: npx tsx test-prereq-option.mts
import {
  evaluatePrereqStall,
  formatPrereqOption,
  formatPrereqSwitch,
  nextPrereqPath,
  planPrereqOptions,
  prereqProgressSignature,
  resolvePrereqStallTicks,
  PREREQ_STALL_TICKS_DEFAULT,
} from './src/prereqOption.ts'
import type { PrereqInput, PrereqPath, PrereqProgress } from './src/prereqOption.ts'
import { prerequisiteProtection, shouldAdoptAbandon } from './src/placementGuard.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const smeltGoal = { kind: 'smelt', targetItem: 'iron_ingot' }

function input(overrides: Partial<PrereqInput>): PrereqInput {
  return {
    goal: smeltGoal,
    heldCount: 0,
    placedCount: 0,
    stoneCount: 0,
    tableAvailable: false,
    placementSpot: null,
    knownStation: null,
    self: { x: 0, y: 0, z: 0 },
    ...overrides,
  }
}

addCase('(a) a held furnace wins place_held and logs the alternatives', () => {
  const decision = planPrereqOptions(
    input({
      heldCount: 1,
      placementSpot: { x: 2, y: 0, z: 0 },
      knownStation: { name: 'furnace', position: { x: 40, y: 0, z: 0 } },
    }),
  )
  const line = decision.line
  const expected = 'PREREQ_OPTION chosen=place_held over=[use_known_station,craft_and_place] reason=place_held cost=3'
  const pass = decision.chosen === 'place_held' && line === expected
  return { pass, detail: line }
})

addCase('(a2) crafting beats walking when the known station is far and materials are held', () => {
  const decision = planPrereqOptions(
    input({
      stoneCount: 8,
      tableAvailable: true,
      knownStation: { name: 'furnace', position: { x: 60, y: 0, z: 0 } },
    }),
  )
  const pass = decision.chosen === 'craft_and_place'
  return { pass, detail: decision.line }
})

addCase('(a3) a close known station beats crafting when no furnace is held', () => {
  const decision = planPrereqOptions(
    input({
      stoneCount: 8,
      tableAvailable: true,
      knownStation: { name: 'furnace', position: { x: 3, y: 0, z: 0 } },
    }),
  )
  const pass = decision.chosen === 'use_known_station'
  return { pass, detail: decision.line }
})

addCase('(b) a stalled path switches to the next-best path instead of repeating', () => {
  const decision = planPrereqOptions(
    input({
      heldCount: 1,
      placementSpot: { x: 2, y: 0, z: 0 },
      knownStation: { name: 'furnace', position: { x: 9, y: 0, z: 0 } },
    }),
  )
  const advanced = nextPrereqPath(decision, 'place_held')
  const signature = prereqProgressSignature('place_held', input({ heldCount: 1, placementSpot: { x: 2, y: 0, z: 0 } }))
  let progress: PrereqProgress | null = null
  let lastStalled = false
  for (let tick = 0; tick <= PREREQ_STALL_TICKS_DEFAULT; tick += 1) {
    const evaluated = evaluatePrereqStall({ previous: progress, path: 'place_held', signature, stallTicks: 40 })
    progress = evaluated.progress
    lastStalled = evaluated.stalled
  }
  const switchLine = formatPrereqSwitch('place_held', advanced ?? 'craft_and_place')
  const expected = 'PREREQ_SWITCH from=place_held to=use_known_station reason=no_progress'
  const pass = advanced === 'use_known_station' && lastStalled && switchLine === expected
  return { pass, detail: `${switchLine} advanced=${advanced ?? 'none'} stalledAt40=${lastStalled}` }
})

addCase('(b2) a real progress signature change re-arms the stall assertion', () => {
  const before = prereqProgressSignature('craft_and_place', input({ stoneCount: 4, tableAvailable: true }))
  const after = prereqProgressSignature('craft_and_place', input({ stoneCount: 8, tableAvailable: true }))
  let progress: PrereqProgress | null = { path: 'craft_and_place', signature: before, ticks: 39 }
  const evaluated = evaluatePrereqStall({ previous: progress, path: 'craft_and_place', signature: after, stallTicks: 40 })
  progress = evaluated.progress
  const pass = !evaluated.stalled && progress.ticks === 0
  return { pass, detail: `before=${before} after=${after} stalled=${evaluated.stalled} ticks=${progress.ticks}` }
})

addCase('(c) switching paths does not abandon the parent goal', () => {
  const protection = prerequisiteProtection({
    actionId: 'PLACE:furnace:p1_64_0',
    goals: [smeltGoal],
    placedFurnaceCount: 0,
  })
  const abandon = shouldAdoptAbandon({
    actionId: 'PLACE:furnace:p1_64_0',
    goals: [smeltGoal],
    placedFurnaceCount: 0,
    abandonRequested: true,
  })
  const pass = protection.protect && protection.line === 'PRECONDITION_PROTECTED option=PLACE:furnace because=prerequisite_of smelt_iron_ingot' && !abandon.adopt
  return { pass, detail: `${protection.line} adopt=${abandon.adopt}` }
})

addCase('the stall window defaults to 40 ticks and honours the override', () => {
  const dflt = resolvePrereqStallTicks({})
  const custom = resolvePrereqStallTicks({ BUDDY_PREREQ_STALL_TICKS: '7' })
  const invalid = resolvePrereqStallTicks({ BUDDY_PREREQ_STALL_TICKS: 'nope' })
  const pass = dflt === PREREQ_STALL_TICKS_DEFAULT && dflt === 40 && custom === 7 && invalid === PREREQ_STALL_TICKS_DEFAULT
  return { pass, detail: `default=${dflt} custom=${custom} invalid=${invalid}` }
})

addCase('the formatters emit the exact acceptance lines', () => {
  const option = formatPrereqOption('place_held', ['use_known_station', 'craft_and_place'], 'place_held cost=1')
  const switchLine = formatPrereqSwitch('use_known_station', 'craft_and_place')
  const pass =
    option === 'PREREQ_OPTION chosen=place_held over=[use_known_station,craft_and_place] reason=place_held cost=1' &&
    switchLine === 'PREREQ_SWITCH from=use_known_station to=craft_and_place reason=no_progress'
  return { pass, detail: `${option} | ${switchLine}` }
})

let failures = 0
process.stdout.write('issue #58 - flexible prerequisite satisfaction\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} prereq-option cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
