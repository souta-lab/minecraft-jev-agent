// test-prereq-option.mts - issue #58 unit proof for flexible prerequisite
// satisfaction: cost-scored path generation (place held / known station /
// craft-and-place), the exact PREREQ_OPTION and PREREQ_SWITCH log lines, the
// stall-triggered path switch, and that the parent goal stays protected.
//
// Run: bun test-prereq-option.mts
import {
  decideFurnacePrereqObservation,
  evaluatePrereqStall,
  formatFurnacePrereqSatisfied,
  formatPrereqOption,
  formatPrereqRankShadow,
  formatPrereqSwitch,
  furnacePrereqSatisfiedObservation,
  nextPrereqPath,
  planPrereqOptions,
  preferPrereqPath,
  PREREQ_RANK_POLICY_DEFAULT,
  prereqProgressSignature,
  prereqSubjectForGoal,
  resolvePrereqRankPolicy,
  resolvePrereqStallTicks,
  selectPrereqPath,
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

addCase('(a3) #78: crafting from held materials beats a close known station', () => {
  const decision = planPrereqOptions(
    input({
      stoneCount: 8,
      tableAvailable: true,
      knownStation: { name: 'furnace', position: { x: 3, y: 0, z: 0 } },
    }),
  )
  const pass = decision.chosen === 'craft_and_place'
  return { pass, detail: decision.line }
})

addCase('(a4) live M2 blocker: a blacklisted known station loses to craft_and_place, not WAIT', () => {
  const decision = planPrereqOptions(
    input({
      stoneCount: 119,
      tableAvailable: true,
      knownStation: { name: 'furnace', position: { x: 22, y: 66, z: 29 } },
      unreachableStations: new Set(['furnace@22,66,29']),
      self: { x: 39, y: 10, z: 34 },
    }),
  )
  const known = decision.options.find((option) => option.path === 'use_known_station')
  const pass =
    decision.chosen === 'craft_and_place' &&
    known?.feasible === false &&
    known.reason === 'known_station_unreachable'
  return { pass, detail: `${decision.line} | known=${known?.reason ?? 'missing'}` }
})

addCase('(a5) #11 v2: the cheaper feasible path wins, rank is only a shadow baseline', () => {
  const decision = planPrereqOptions(
    input({
      stoneCount: 8,
      tableAvailable: true,
      knownStation: { name: 'furnace', position: { x: 44, y: 0, z: 0 } },
    }),
  )
  const craft = decision.options.find((option) => option.path === 'craft_and_place')
  const known = decision.options.find((option) => option.path === 'use_known_station')
  const shadow = formatPrereqRankShadow(decision, decision.chosen)
  const pass =
    decision.chosen === 'craft_and_place' &&
    decision.policy === 'cost' &&
    craft?.feasible === true &&
    craft.cost === 4 &&
    known?.feasible === true &&
    known.cost === 48 &&
    shadow === 'PREREQ_RANK_SHADOW policy=cost cost_choice=craft_and_place rank_choice=craft_and_place agree=true'
  return { pass, detail: `${decision.line} | ${shadow} | craft=${craft?.cost ?? 'none'} known=${known?.cost ?? 'none'}` }
})

addCase('(a6) #11 v2: cost and rank diverge -> cost decides, rank shadow-logged, env restores rank', () => {
  const diverging = input({
    heldCount: 1,
    placementSpot: { x: 5, y: 0, z: 0 },
    knownStation: { name: 'furnace', position: { x: 0, y: 0, z: 0 } },
  })
  const costDecision = planPrereqOptions(diverging)
  const rankDecision = planPrereqOptions({ ...diverging, rankPolicy: 'rank' })
  const shadow = formatPrereqRankShadow(costDecision, costDecision.chosen)
  const pass =
    costDecision.chosen === 'use_known_station' &&
    costDecision.rankBaseline === 'place_held' &&
    shadow === 'PREREQ_RANK_SHADOW policy=cost cost_choice=use_known_station rank_choice=place_held agree=false' &&
    rankDecision.chosen === 'place_held' &&
    rankDecision.rankBaseline === 'place_held' &&
    resolvePrereqRankPolicy({}) === PREREQ_RANK_POLICY_DEFAULT &&
    PREREQ_RANK_POLICY_DEFAULT === 'cost' &&
    resolvePrereqRankPolicy({ BUDDY_PREREQ_RANK_POLICY: 'rank' }) === 'rank' &&
    resolvePrereqRankPolicy({ BUDDY_PREREQ_RANK_POLICY: 'nope' }) === 'cost'
  return { pass, detail: `${shadow} | cost_choice=${costDecision.chosen} rank_choice=${rankDecision.chosen}` }
})

addCase('(2) selectPrereqPath never returns null while a feasible option exists', () => {
  const onlyCraft = planPrereqOptions(input({ stoneCount: 8, tableAvailable: true }))
  const withKnown = planPrereqOptions(
    input({
      stoneCount: 8,
      tableAvailable: true,
      knownStation: { name: 'furnace', position: { x: 44, y: 0, z: 0 } },
    }),
  )
  const allAbandoned = new Set<PrereqPath>(['place_held', 'use_known_station', 'craft_and_place'])
  const noFeasible = planPrereqOptions(input({}))
  const pass =
    selectPrereqPath(onlyCraft, new Set<PrereqPath>(['craft_and_place'])) === 'craft_and_place' &&
    selectPrereqPath(onlyCraft, allAbandoned) === 'craft_and_place' &&
    selectPrereqPath(withKnown, allAbandoned) === 'craft_and_place' &&
    selectPrereqPath(withKnown, new Set<PrereqPath>(['craft_and_place'])) === 'use_known_station' &&
    selectPrereqPath(noFeasible, new Set<PrereqPath>()) === null &&
    selectPrereqPath(noFeasible, allAbandoned) === null
  return {
    pass,
    detail: `onlyCraftAllAbandoned=${selectPrereqPath(onlyCraft, allAbandoned)} withKnown=${selectPrereqPath(withKnown, new Set(['craft_and_place']))} none=${selectPrereqPath(noFeasible, allAbandoned)}`,
  }
})

addCase('(2) preferPrereqPath survives an abandoned forced path and stays non-null', () => {
  const held = planPrereqOptions(
    input({
      heldCount: 1,
      placementSpot: { x: 2, y: 0, z: 0 },
      knownStation: { name: 'furnace', position: { x: 9, y: 0, z: 0 } },
    }),
  )
  const craftOnly = planPrereqOptions(input({ stoneCount: 8, tableAvailable: true }))
  const base = selectPrereqPath(craftOnly, new Set<PrereqPath>(['craft_and_place']))
  const revived = preferPrereqPath(base, null, craftOnly)
  const pass =
    base === 'craft_and_place' &&
    revived === 'craft_and_place' &&
    preferPrereqPath(null, null, craftOnly) === 'craft_and_place' &&
    preferPrereqPath(null, null, held) === 'place_held' &&
    preferPrereqPath(null, 'use_known_station', held) === 'use_known_station' &&
    preferPrereqPath('place_held', 'use_known_station', held) === 'use_known_station' &&
    preferPrereqPath(null, null, planPrereqOptions(input({}))) === null
  return {
    pass,
    detail: `abandonedForcedBase=${base} revived=${revived} fallback=${preferPrereqPath(null, null, craftOnly)} forced=${preferPrereqPath(null, 'use_known_station', held)}`,
  }
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

addCase('an ALREADY-satisfied furnace is its own typed observation, never a PREREQ_OPTION', () => {
  const subject = prereqSubjectForGoal(smeltGoal)
  const satisfied = furnacePrereqSatisfiedObservation({ subject, sensedStationCount: 1 })
  const notSatisfied = furnacePrereqSatisfiedObservation({ subject, sensedStationCount: 0 })
  const notApplicable = furnacePrereqSatisfiedObservation({ subject: null, sensedStationCount: 3 })
  const exact = formatFurnacePrereqSatisfied('sensed')
  const pass =
    satisfied === 'FURNACE_PREREQ_ALREADY_SATISFIED resource=furnace source=sensed' &&
    exact === satisfied &&
    !satisfied.includes('PREREQ_OPTION ') &&
    notSatisfied === null &&
    notApplicable === null
  return { pass, detail: `satisfied=${satisfied ?? 'null'} notSatisfied=${notSatisfied ?? 'null'} notApplicable=${notApplicable ?? 'null'}` }
})

addCase('the already-satisfied observation is emitted once per goal, never as a PREREQ_OPTION', () => {
  const subject = prereqSubjectForGoal(smeltGoal)
  const line = formatFurnacePrereqSatisfied('sensed')
  const first = decideFurnacePrereqObservation({ subject, sensedStationCount: 1, goalKey: 'g2:smelt', previousKey: null })
  const repeat = decideFurnacePrereqObservation({
    subject,
    sensedStationCount: 1,
    goalKey: 'g2:smelt',
    previousKey: first.key,
  })
  const nextGoal = decideFurnacePrereqObservation({
    subject,
    sensedStationCount: 1,
    goalKey: 'g3:smelt',
    previousKey: first.key,
  })
  const pass =
    first.line === line &&
    first.key === `g2:smelt|${line}` &&
    repeat.line === null &&
    repeat.key === first.key &&
    nextGoal.line === line &&
    nextGoal.key === `g3:smelt|${line}` &&
    first.line !== null &&
    !first.line.includes('PREREQ_OPTION ')
  return {
    pass,
    detail: `first=${first.line ?? 'null'} repeat=${repeat.line ?? 'null'} nextGoal=${nextGoal.line ?? 'null'}`,
  }
})

addCase('an unsatisfied (or inapplicable) prerequisite returns null so PREREQ_OPTION can still fire', () => {
  const subject = prereqSubjectForGoal(smeltGoal)
  const noFurnace = decideFurnacePrereqObservation({ subject, sensedStationCount: 0, goalKey: 'g2:smelt', previousKey: null })
  const noSubject = decideFurnacePrereqObservation({ subject: null, sensedStationCount: 3, goalKey: 'g2:smelt', previousKey: null })
  const pass = noFurnace.line === null && noFurnace.key === null && noSubject.line === null && noSubject.key === null
  return { pass, detail: `noFurnace=${JSON.stringify(noFurnace)} noSubject=${JSON.stringify(noSubject)}` }
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
