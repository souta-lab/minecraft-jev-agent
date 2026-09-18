// test-option-spec.mts - Issue #21 unit tests: OptionSpec validation, code
// predicate evaluation (inventory/dimension/WorldMemory), dependency expansion
// for unmet preconditions (#12 generalization) and the PlannedGoal <-> OptionSpec
// round-trip. Pure: no bot, no network, no model.
import {
  applyCompiledPlan,
  compileGoalQueue,
  compilePlannedGoal,
  compilePlannedGoals,
  dependencyGoalForPredicate,
  describePredicate,
  evaluatePredicate,
  evaluatePredicateTruth,
  evaluatePredicates,
  evaluatePredicatesTruth,
  expandOptionDependencies,
  formatPredicateUnknown,
  isOptionComplete,
  isOptionStartable,
  makeOptionSnapshot,
  optionSpecsToPlannedGoals,
  optionStartabilityTruth,
  orderGoalsByReadiness,
  resolveOptionCompilerEnabled,
  setPredicateUnknownSink,
  snapshotFromResident,
  validateOptionSpec,
  validatePredicate,
} from './src/optionSpec.ts'
import type { OptionSpec, OptionWorldSnapshot, Predicate } from './src/optionSpec.ts'
import { GoalQueue } from './src/goalQueue.ts'
import type { PlannedGoal } from './src/goalQueue.ts'
import { readFileSync } from 'node:fs'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const PLANKS_ONLY = makeOptionSnapshot({ inventory: { oak_log: 3, cobblestone: 5 }, toolRank: 2 })
const FURNACE_READY = makeOptionSnapshot({
  inventory: { raw_iron: 3, furnace: 1 },
  knownStations: ['furnace', 'crafting_table'],
  toolRank: 2,
})

function ids(specs: readonly OptionSpec[]): string[] {
  return specs.map((spec) => spec.id)
}

function sameGoal(a: PlannedGoal, b: PlannedGoal): boolean {
  return (
    a.kind === b.kind &&
    a.description === b.description &&
    (a.targetItem ?? null) === (b.targetItem ?? null) &&
    (a.requiredCount ?? 1) === (b.requiredCount ?? 1)
  )
}

function withPredicateUnknownCapture<T>(run: (lines: string[]) => T): T {
  const lines: string[] = []
  setPredicateUnknownSink((line) => {
    lines.push(line)
  })
  try {
    return run(lines)
  } finally {
    setPredicateUnknownSink(null)
  }
}

const HEALTH_SPEC: OptionSpec = {
  id: 'custom:survive',
  intent: 'stay alive',
  kind: 'custom',
  target: { count: 1 },
  preconditions: [{ kind: 'healthAtLeast', health: 10 }],
  success: [],
  skills: [],
  abortThreshold: 0.5,
}

addCase('OptionSpec validation accepts a well-formed compiled spec', () => {
  const spec = compilePlannedGoal({ kind: 'collect', description: 'collect 3 x raw_iron', targetItem: 'raw_iron', requiredCount: 3 })
  const errors = validateOptionSpec(spec)
  return { pass: errors.length === 0 && spec.id === 'collect:raw_iron' && spec.abortThreshold === 0.5, detail: `errors=[${errors.join('; ')}] id=${spec.id}` }
})

addCase('OptionSpec validation reports every structural problem', () => {
  const malformed = {
    id: 'bad id',
    intent: '',
    kind: 'nope',
    target: { count: 0 },
    preconditions: 'not-an-array',
    success: [],
    skills: [],
    abortThreshold: 2,
  } as unknown as OptionSpec
  const errors = validateOptionSpec(malformed)
  const has = (fragment: string): boolean => errors.some((error) => error.includes(fragment))
  const pass = has('id must be') && has('kind must be') && has('intent must be') && has('preconditions must be an array') && has('target.count') && has('abortThreshold')
  return { pass, detail: `errorCount=${errors.length} [${errors.join(' | ')}]` }
})

addCase('predicate: inventory counts resolve concrete items and semantic classes', () => {
  const log = evaluatePredicate({ kind: 'inventoryAtLeast', item: 'log', count: 3 }, PLANKS_ONLY)
  const noLog = evaluatePredicate({ kind: 'inventoryAtLeast', item: 'log', count: 4 }, PLANKS_ONLY)
  const stone = evaluatePredicate({ kind: 'inventoryClassAtLeast', cls: 'stone', count: 5 }, PLANKS_ONLY)
  const noStone = evaluatePredicate({ kind: 'inventoryClassAtLeast', cls: 'stone', count: 6 }, PLANKS_ONLY)
  return { pass: log && !noLog && stone && !noStone, detail: `log3=${log} log4=${noLog} stone5=${stone} stone6=${noStone}` }
})

addCase('predicate: dimension matches with or without the minecraft namespace', () => {
  const overworld = makeOptionSnapshot({ inventory: {}, dimension: 'minecraft:overworld' })
  const nether = makeOptionSnapshot({ inventory: {}, dimension: 'minecraft:the_nether' })
  const inOverworld = evaluatePredicate({ kind: 'dimensionIs', dimension: 'overworld' }, overworld)
  const inNether = evaluatePredicate({ kind: 'dimensionIs', dimension: 'overworld' }, nether)
  return { pass: inOverworld && !inNether, detail: `overworld=${inOverworld} nether=${inNether}` }
})

addCase('predicate: WorldMemory stations, ores and Y level are code-evaluated', () => {
  const snapshot = makeOptionSnapshot({
    inventory: {},
    knownStations: ['furnace'],
    knownOres: ['deepslate_iron_ore'],
    position: { x: 0, y: 12, z: 0 },
  })
  const station = evaluatePredicate({ kind: 'stationKnown', station: 'furnace' }, snapshot)
  const noTable = evaluatePredicate({ kind: 'stationKnown', station: 'crafting_table' }, snapshot)
  const ore = evaluatePredicate({ kind: 'oreKnown', item: 'raw_iron' }, snapshot)
  const deep = evaluatePredicate({ kind: 'levelAtMost', y: 16 }, snapshot)
  const shallow = evaluatePredicate({ kind: 'levelAtMost', y: 8 }, snapshot)
  return { pass: station && !noTable && ore && deep && !shallow, detail: `furnace=${station} table=${noTable} ore=${ore} y<=16=${deep} y<=8=${shallow}` }
})

addCase('predicate: pickaxe rank, health and unknown custom ids fail closed', () => {
  const snapshot = makeOptionSnapshot({ inventory: {}, toolRank: 2, health: 20 })
  const rank2 = evaluatePredicate({ kind: 'pickaxeRankAtLeast', rank: 2 }, snapshot)
  const rank3 = evaluatePredicate({ kind: 'pickaxeRankAtLeast', rank: 3 }, snapshot)
  const healthy = evaluatePredicate({ kind: 'healthAtLeast', health: 10 }, snapshot)
  const custom = evaluatePredicate({ kind: 'custom', id: 'not-registered' }, snapshot)
  const customRegistered = evaluatePredicate({ kind: 'custom', id: 'yes' }, snapshot, { yes: () => true })
  return { pass: rank2 && !rank3 && healthy && !custom && customRegistered, detail: `rank2=${rank2} rank3=${rank3} healthy=${healthy} unknown=${custom} registered=${customRegistered}` }
})

addCase('healthAtLeast: unknown health fails closed and logs PREDICATE_UNKNOWN (#59)', () => {
  return withPredicateUnknownCapture((lines) => {
    const unknownSnapshot = makeOptionSnapshot({ inventory: {}, health: null })
    const value = evaluatePredicate({ kind: 'healthAtLeast', health: 10 }, unknownSnapshot)
    const truth = evaluatePredicateTruth({ kind: 'healthAtLeast', health: 10 }, unknownSnapshot)
    const startable = isOptionStartable(HEALTH_SPEC, unknownSnapshot)
    const expected = formatPredicateUnknown({ kind: 'healthAtLeast', health: 10 }, ['health'])
    const logged = lines.includes(expected) && lines.every((line) => line.startsWith('PREDICATE_UNKNOWN'))
    return {
      pass: value === false && truth.truth === 'unknown' && !startable && logged && lines.length >= 2,
      detail: `value=${value} truth=${truth.truth} startable=${startable} lines=${JSON.stringify(lines)}`,
    }
  })
})

addCase('healthAtLeast: known-good true, known-bad false, no unknown log', () => {
  return withPredicateUnknownCapture((lines) => {
    const below = evaluatePredicate({ kind: 'healthAtLeast', health: 10 }, makeOptionSnapshot({ inventory: {}, health: 9 }))
    const at = evaluatePredicate({ kind: 'healthAtLeast', health: 10 }, makeOptionSnapshot({ inventory: {}, health: 10 }))
    const above = evaluatePredicate({ kind: 'healthAtLeast', health: 10 }, makeOptionSnapshot({ inventory: {}, health: 20 }))
    return { pass: !below && at && above && lines.length === 0, detail: `health9=${below} health10=${at} health20=${above} logs=${lines.length}` }
  })
})

addCase('dimensionIs/levelAtMost: unknown input fails closed and logs (#59 audit)', () => {
  return withPredicateUnknownCapture((lines) => {
    const noDimension = makeOptionSnapshot({ inventory: {}, dimension: null, position: { x: 0, y: 12, z: 0 } })
    const noPosition = makeOptionSnapshot({ inventory: {}, dimension: 'overworld', position: null })
    const dimensionUnknown = evaluatePredicate({ kind: 'dimensionIs', dimension: 'overworld' }, noDimension)
    const levelUnknown = evaluatePredicate({ kind: 'levelAtMost', y: 16 }, noPosition)
    const dimensionKnown = evaluatePredicate({ kind: 'dimensionIs', dimension: 'overworld' }, makeOptionSnapshot({ inventory: {}, dimension: 'minecraft:overworld' }))
    const levelGood = evaluatePredicate({ kind: 'levelAtMost', y: 16 }, makeOptionSnapshot({ inventory: {}, position: { x: 0, y: 12, z: 0 } }))
    const levelBad = evaluatePredicate({ kind: 'levelAtMost', y: 16 }, makeOptionSnapshot({ inventory: {}, position: { x: 0, y: 20, z: 0 } }))
    const logged =
      lines.some((line) => line === 'PREDICATE_UNKNOWN name=dimensionIs input=dimension=null -> false') &&
      lines.some((line) => line === 'PREDICATE_UNKNOWN name=levelAtMost input=position=null -> false')
    return {
      pass: !dimensionUnknown && !levelUnknown && dimensionKnown && levelGood && !levelBad && logged,
      detail: `dimUnknown=${dimensionUnknown} levelUnknown=${levelUnknown} dimKnown=${dimensionKnown} levelGood=${levelGood} levelBad=${levelBad} lines=${JSON.stringify(lines)}`,
    }
  })
})

addCase('tri-state: unknown is not true and fresh health re-enables startability (#59)', () => {
  return withPredicateUnknownCapture((lines) => {
    const unknownSnapshot = makeOptionSnapshot({ inventory: {}, health: null })
    const freshSnapshot = makeOptionSnapshot({ inventory: {}, health: 20 })
    const cold = optionStartabilityTruth(HEALTH_SPEC, unknownSnapshot)
    const warm = optionStartabilityTruth(HEALTH_SPEC, freshSnapshot)
    const aggregate = evaluatePredicatesTruth([{ kind: 'healthAtLeast', health: 10 }], unknownSnapshot)
    return {
      pass:
        cold === 'unknown' &&
        warm === 'true' &&
        aggregate.truth === 'unknown' &&
        aggregate.unknown.length === 1 &&
        isOptionStartable(HEALTH_SPEC, freshSnapshot) &&
        !isOptionStartable(HEALTH_SPEC, unknownSnapshot),
      detail: `cold=${cold} warm=${warm} aggregate=${aggregate.truth} unknown=${aggregate.unknown.length} logs=${lines.length}`,
    }
  })
})

addCase('custom: unregistered id is a proven false, not an unknown (#59 audit)', () => {
  return withPredicateUnknownCapture((lines) => {
    const snapshot = makeOptionSnapshot({ inventory: {} })
    const value = evaluatePredicate({ kind: 'custom', id: 'not-registered' }, snapshot)
    const truth = evaluatePredicateTruth({ kind: 'custom', id: 'not-registered' }, snapshot)
    return { pass: value === false && truth.truth === 'false' && lines.length === 0, detail: `value=${value} truth=${truth.truth} logs=${lines.length}` }
  })
})

addCase('tri-state aggregate prefers a proven false over an unknown (#59)', () => {
  return withPredicateUnknownCapture((lines) => {
    const snapshot = makeOptionSnapshot({ inventory: {}, health: null })
    const result = evaluatePredicatesTruth(
      [
        { kind: 'healthAtLeast', health: 10 },
        { kind: 'inventoryAtLeast', item: 'diamond', count: 1 },
      ],
      snapshot,
    )
    return {
      pass: result.truth === 'false' && result.unknown.length === 1 && result.unmet.length === 2 && lines.length === 1,
      detail: `truth=${result.truth} unknown=${result.unknown.length} unmet=${result.unmet.length} logs=${lines.length}`,
    }
  })
})

addCase('I(o): smelt iron_ingot is not startable without furnace + raw_iron', () => {
  const spec = compilePlannedGoal({ kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3 })
  const cold = isOptionStartable(spec, makeOptionSnapshot({ inventory: {} }))
  const warm = isOptionStartable(spec, FURNACE_READY)
  const { unmet } = evaluatePredicates(spec.preconditions, makeOptionSnapshot({ inventory: {} }))
  return { pass: !cold && warm && unmet.length === 2, detail: `cold=${cold} warm=${warm} unmet=[${unmet.map(describePredicate).join(', ')}]` }
})

addCase('success(s,o): completion is a code predicate, not a model answer', () => {
  const collect = compilePlannedGoal({ kind: 'collect', description: 'collect 3 x raw_iron', targetItem: 'raw_iron', requiredCount: 3 })
  const two = isOptionComplete(collect, makeOptionSnapshot({ inventory: { raw_iron: 2 } }))
  const three = isOptionComplete(collect, makeOptionSnapshot({ inventory: { raw_iron: 3 } }))
  const place = compilePlannedGoal({ kind: 'place', description: 'place 1 x furnace', targetItem: 'furnace', requiredCount: 1 })
  const placed = isOptionComplete(place, makeOptionSnapshot({ inventory: {}, knownStations: ['furnace'] }))
  const unplaced = isOptionComplete(place, makeOptionSnapshot({ inventory: { furnace: 1 } }))
  return { pass: !two && three && placed && !unplaced, detail: `raw2=${two} raw3=${three} station=${placed} heldOnly=${unplaced}` }
})

addCase('dependency expansion: smelt iron_ingot with no raw_iron expands to collect raw_iron', () => {
  const spec = compilePlannedGoal({ kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3 })
  const snapshot = makeOptionSnapshot({ inventory: {}, knownStations: ['furnace'], toolRank: 2 })
  const expansion = expandOptionDependencies(spec, snapshot)
  const order = ids(expansion.specs)
  const collect = expansion.specs[0]
  const pass =
    order.length === 2 &&
    order[0] === 'collect:raw_iron' &&
    order[1] === 'smelt:iron_ingot' &&
    collect !== undefined &&
    collect.target.count === 3
  return { pass, detail: `order=[${order.join(' -> ')}] collectCount=${collect?.target.count} added=[${expansion.added.join(',')}] blocked=[${expansion.blocked.join(';')}]` }
})

addCase('dependency expansion recurses through the tool chain without looping', () => {
  const spec = compilePlannedGoal({ kind: 'collect', description: 'collect 3 x raw_iron', targetItem: 'raw_iron', requiredCount: 3 })
  const expansion = expandOptionDependencies(spec, makeOptionSnapshot({ inventory: {}, toolRank: 0 }))
  const order = ids(expansion.specs)
  const hasStonePick = order.includes('craft:stone_pickaxe')
  const hasWoodPick = order.includes('craft:wooden_pickaxe')
  const hasCobble = order.includes('collect:cobblestone')
  const stoneBeforeOre = order.indexOf('craft:stone_pickaxe') < order.indexOf('collect:raw_iron')
  const finite = order.length <= 12
  return { pass: hasStonePick && hasWoodPick && hasCobble && stoneBeforeOre && finite, detail: `n=${order.length} order=[${order.join(' -> ')}]` }
})

addCase('dependency expansion: place furnace expands to craft furnace then collect cobblestone', () => {
  const spec = compilePlannedGoal({ kind: 'place', description: 'place 1 x furnace', targetItem: 'furnace', requiredCount: 1 })
  const expansion = expandOptionDependencies(spec, makeOptionSnapshot({ inventory: {} }))
  const order = ids(expansion.specs)
  const cobble = order.indexOf('collect:cobblestone')
  const craft = order.indexOf('craft:furnace')
  const place = order.indexOf('place:furnace')
  const ordered = cobble >= 0 && craft > cobble && place > craft
  return { pass: ordered, detail: `order=[${order.join(' -> ')}]` }
})

addCase('round-trip PlannedGoal -> OptionSpec -> goals preserves queue semantics', () => {
  const planned: PlannedGoal[] = [
    { kind: 'collect', description: 'collect 3 x log', targetItem: 'log', requiredCount: 3 },
    { kind: 'craft', description: 'craft 1 x crafting_table', targetItem: 'crafting_table', requiredCount: 1 },
    { kind: 'place', description: 'place 1 x furnace', targetItem: 'furnace', requiredCount: 1 },
    { kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3 },
    { kind: 'craft', description: 'craft 1 x iron_pickaxe', targetItem: 'iron_pickaxe', requiredCount: 1 },
    { kind: 'explore', description: 'locate the stronghold', targetItem: null, requiredCount: 1 },
  ]
  const specs = compilePlannedGoals(planned)
  const roundTripped = optionSpecsToPlannedGoals(specs)
  const preserved = roundTripped.length === planned.length && planned.every((goal, index) => {
    const back = roundTripped[index]
    return back !== undefined && sameGoal(goal, back)
  })
  const stable = specs.map((spec) => spec.id).join('|') === compilePlannedGoals(roundTripped).map((spec) => spec.id).join('|')
  return { pass: preserved && stable, detail: `ids=[${ids(specs).join(',')}] roundTripPreserved=${preserved}` }
})

addCase('compileGoalQueue compiles the current goal then every pending goal in order', () => {
  const queue = new GoalQueue()
  queue.applyPlan(
    [
      { kind: 'collect', description: 'collect 3 x log', targetItem: 'log', requiredCount: 3 },
      { kind: 'craft', description: 'craft 1 x crafting_table', targetItem: 'crafting_table', requiredCount: 1 },
      { kind: 'place', description: 'place 1 x furnace', targetItem: 'furnace', requiredCount: 1 },
    ],
    'llm',
  )
  const specs = compileGoalQueue(queue.state)
  return { pass: ids(specs).join(',') === 'collect:log,craft:crafting_table,place:furnace', detail: `ids=[${ids(specs).join(',')}] depth=${queue.state.depth}` }
})

addCase('flag: BUDDY_OPTION_COMPILER gates replacement and stays opt-in', () => {
  const planned: PlannedGoal[] = [{ kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3 }]
  const snapshot = makeOptionSnapshot({ inventory: {}, knownStations: ['furnace'], toolRank: 2 })
  const off = applyCompiledPlan(planned, snapshot, { enabled: false })
  const on = applyCompiledPlan(planned, snapshot, { enabled: true })
  const offUnchanged = off.goals.length === 1 && sameGoal(planned[0] as PlannedGoal, off.goals[0] as PlannedGoal)
  const onExpanded = on.goals.some((goal) => goal.targetItem === 'raw_iron') && on.goals.length === 2
  const envDefault = resolveOptionCompilerEnabled({})
  const envOn = resolveOptionCompilerEnabled({ BUDDY_OPTION_COMPILER: '1' })
  const envOff = resolveOptionCompilerEnabled({ BUDDY_OPTION_COMPILER: '0' })
  return { pass: offUnchanged && onExpanded && !envDefault && envOn && !envOff, detail: `offGoals=${off.goals.length} onGoals=[${on.goals.map((g) => g.targetItem).join(',')}] default=${envDefault} on=${envOn} off=${envOff}` }
})

addCase('snapshotFromResident maps WorldMemory stations into predicate state', () => {
  const snapshot = snapshotFromResident({
    inventory: { raw_iron: 3 },
    dimension: 'minecraft:overworld',
    position: null,
    health: null,
    toolRank: 2,
    craftingTables: [{ x: 1, y: 64, z: 1 }],
    furnaces: [],
    discoveredOres: ['iron_ore'],
  })
  const table = evaluatePredicate({ kind: 'stationKnown', station: 'crafting_table' }, snapshot)
  const furnace = evaluatePredicate({ kind: 'stationKnown', station: 'furnace' }, snapshot)
  const ore = evaluatePredicate({ kind: 'oreKnown', item: 'raw_iron' }, snapshot)
  return { pass: table && !furnace && ore, detail: `table=${table} furnace=${furnace} ore=${ore}` }
})

addCase('the compiler is model/network free (source has no LLM import)', () => {
  const source = readFileSync(new URL('./src/optionSpec.ts', import.meta.url), 'utf8')
  const noLlm = !/from ['"]ai['"]/.test(source) && !source.includes('experimental_evaluate') && !source.includes('resolveJevApiKey')
  const noMineflayerRuntime = !/^import\s+(?!type)[^;]*from ['"]mineflayer['"]/m.test(source)
  const unknownPredicate = validatePredicate({ kind: 'bogus' })
  return { pass: noLlm && noMineflayerRuntime && unknownPredicate !== null, detail: `noLlm=${noLlm} noMineflayerRuntime=${noMineflayerRuntime} unknownRejected=${unknownPredicate !== null}` }
})

addCase('dependencyGoalForPredicate is total for the supported predicate kinds', () => {
  const empty = makeOptionSnapshot({ inventory: {} })
  const spec = compilePlannedGoal({ kind: 'collect', description: 'collect 1 x diamond', targetItem: 'diamond', requiredCount: 1 })
  const rankPredicate: Predicate = { kind: 'pickaxeRankAtLeast', rank: 3 }
  const stationPredicate: Predicate = { kind: 'stationKnown', station: 'furnace' }
  const rankDep = dependencyGoalForPredicate(rankPredicate, spec, empty)
  const stationDep = dependencyGoalForPredicate(stationPredicate, spec, empty)
  const healthDep = dependencyGoalForPredicate({ kind: 'healthAtLeast', health: 5 }, spec, empty)
  const pass = rankDep?.targetItem === 'iron_pickaxe' && stationDep?.kind === 'place' && healthDep === null
  return { pass, detail: `rank=${rankDep?.targetItem} station=${stationDep?.targetItem} health=${healthDep === null ? 'null' : 'unexpected'}` }
})

addCase('readiness ordering moves a ready smelt ahead of an unmet collect (#46)', () => {
  const snapshot = makeOptionSnapshot({ inventory: { raw_iron: 3 }, knownStations: ['furnace'], toolRank: 1 })
  const goals: PlannedGoal[] = [
    { kind: 'collect', description: 'collect 1 x diamond', targetItem: 'diamond', requiredCount: 1 },
    { kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3 },
  ]
  const result = orderGoalsByReadiness(goals, snapshot)
  const move = result.moves[0]
  const pass =
    result.goals[0]?.kind === 'smelt' &&
    result.goals[0]?.targetItem === 'iron_ingot' &&
    result.goals[1]?.targetItem === 'diamond' &&
    result.ready.length === 1 &&
    result.blocked.length === 1 &&
    move?.preferred === 'smelt_iron_ingot' &&
    move?.over === 'collect 1 x diamond'
  return { pass, detail: `order=[${result.goals.map((goal) => goal.targetItem).join(',')}] moves=${JSON.stringify(result.moves)}` }
})

addCase('readiness ordering is stable when every goal is ready (#46)', () => {
  const snapshot = makeOptionSnapshot({ inventory: { raw_iron: 3, diamond: 1 }, knownStations: ['furnace'], toolRank: 2 })
  const goals: PlannedGoal[] = [
    { kind: 'collect', description: 'collect 1 x diamond', targetItem: 'diamond', requiredCount: 1 },
    { kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3 },
  ]
  const result = orderGoalsByReadiness(goals, snapshot)
  const pass =
    result.goals[0]?.targetItem === 'diamond' &&
    result.goals[1]?.targetItem === 'iron_ingot' &&
    result.moves.length === 0
  return { pass, detail: `order=[${result.goals.map((goal) => goal.targetItem).join(',')}] moves=${result.moves.length}` }
})

addCase('readiness ordering is stable when every goal is blocked (#46)', () => {
  const snapshot = makeOptionSnapshot({ inventory: {}, toolRank: 0 })
  const goals: PlannedGoal[] = [
    { kind: 'collect', description: 'collect 1 x diamond', targetItem: 'diamond', requiredCount: 1 },
    { kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3 },
  ]
  const result = orderGoalsByReadiness(goals, snapshot)
  const pass =
    result.goals[0]?.targetItem === 'diamond' &&
    result.goals[1]?.targetItem === 'iron_ingot' &&
    result.ready.length === 0 &&
    result.blocked.length === 2
  return { pass, detail: `order=[${result.goals.map((goal) => goal.targetItem).join(',')}] ready=${result.ready.length} blocked=${result.blocked.length}` }
})

let failures = 0
process.stdout.write('OptionSpec / deterministic predicate / dependency expansion (#21)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} option-spec cases passed\n`)
if (failures > 0) process.exit(1)
