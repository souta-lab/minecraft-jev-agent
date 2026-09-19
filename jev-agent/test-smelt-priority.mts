// test-smelt-priority.mts - live M2 blocker (run-mu8b2647-rj7f): a stale ore
// descent outranked a smelt whose inputs were already held.
//
// Evidence (buddy.log, generation gen-mu8b26nc-wpx9j5):
//   PLAN source=ladder goals=["descend_to:Y=-3","collect 3 x raw_iron",
//     "smelt 3 x iron_ingot", ...] rung=raw_iron
//   HEARTBEAT ... rung=iron_ingot queue=descend_to:Y=-3 depth=24 done=8 action=DESCEND
//   inv={"raw_iron":3,"charcoal":1,...}
// The deterministic single-shot plan was built while raw_iron was 0, so the
// ladder floor prepended the ORE descent. Once raw_iron+charcoal were held the
// plan was never re-derived: `smeltPriorityGoal` was never consulted again and
// the smelt (and its PREREQ_OPTION -> FURNACE_READY -> SMELT_DONE chain) never
// ran. `staleOreDescend` retires the obsolete descent so the queue advances.
//
// Run: npx tsx test-smelt-priority.mts
import { staleOreDescend } from './src/controller.ts'
import { GoalQueue } from './src/goalQueue.ts'
import type { PlannedGoal } from './src/goalQueue.ts'
import { compilePlannedGoal, isOptionStartable, makeOptionSnapshot } from './src/optionSpec.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const DESCEND_IRON: PlannedGoal = {
  kind: 'descend',
  description: 'descend_to:Y=-3',
  targetItem: 'raw_iron',
  requiredCount: 1,
  targetY: -3,
  dimension: 'minecraft:overworld',
  core: true,
}
const COLLECT_IRON: PlannedGoal = { kind: 'collect', description: 'collect 3 x raw_iron', targetItem: 'raw_iron', requiredCount: 3, core: true }
const SMELT_IRON: PlannedGoal = { kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3, core: true }
const DESCEND_DIAMOND: PlannedGoal = {
  kind: 'descend',
  description: 'descend_to:Y=-5',
  targetItem: 'diamond',
  requiredCount: 1,
  targetY: -5,
  dimension: 'minecraft:overworld',
  core: true,
}

const withFurnace = makeOptionSnapshot({ inventory: { raw_iron: 3, charcoal: 1 }, knownStations: ['furnace'] })
const noFurnace = makeOptionSnapshot({ inventory: { raw_iron: 3, charcoal: 1 } })
const noFuel = makeOptionSnapshot({ inventory: { raw_iron: 3 }, knownStations: ['furnace'] })
const notEnoughIron = makeOptionSnapshot({ inventory: { raw_iron: 1, charcoal: 1 }, knownStations: ['furnace'] })

function queueOf(goals: PlannedGoal[]): GoalQueue {
  const queue = new GoalQueue()
  queue.applyPlan(goals, 'mechanical', 'replace')
  return queue
}

addCase('(a) inputs+fuel held: the stale raw_iron descent is retired in favour of the smelt', () => {
  const queue = queueOf([DESCEND_IRON, COLLECT_IRON, SMELT_IRON])
  const stale = staleOreDescend(queue.current!, queue.state.goals, withFurnace)
  const pass = stale !== null && stale.kind === 'smelt' && stale.targetItem === 'iron_ingot'
  return { pass, detail: `current=${queue.current?.description ?? 'none'} staleFor=${stale?.description ?? 'none'}` }
})

addCase('(a) retiring the descent lets the queue head reach the smelt', () => {
  const queue = queueOf([DESCEND_IRON, COLLECT_IRON, SMELT_IRON])
  if (staleOreDescend(queue.current!, queue.state.goals, withFurnace) !== null) queue.markDone()
  const afterRetire = queue.current
  if (afterRetire?.kind === 'collect') queue.markProgress(3)
  const head = queue.current
  const pass = afterRetire?.kind === 'collect' && head?.kind === 'smelt' && head.targetItem === 'iron_ingot'
  return { pass, detail: `afterRetire=${afterRetire?.description ?? 'none'} head=${head?.description ?? 'none'}` }
})

addCase('(b) no fuel: the descent is NOT retired', () => {
  const queue = queueOf([DESCEND_IRON, COLLECT_IRON, SMELT_IRON])
  const stale = staleOreDescend(queue.current!, queue.state.goals, noFuel)
  return { pass: stale === null, detail: `staleFor=${stale?.description ?? 'none'}` }
})

addCase('(b) not enough raw_iron: the descent is NOT retired', () => {
  const queue = queueOf([DESCEND_IRON, COLLECT_IRON, SMELT_IRON])
  const stale = staleOreDescend(queue.current!, queue.state.goals, notEnoughIron)
  return { pass: stale === null, detail: `staleFor=${stale?.description ?? 'none'}` }
})

addCase('(b) a descent for a different ore is untouched', () => {
  const queue = queueOf([DESCEND_DIAMOND, COLLECT_IRON, SMELT_IRON])
  const stale = staleOreDescend(queue.current!, queue.state.goals, withFurnace)
  return { pass: stale === null, detail: `staleFor=${stale?.description ?? 'none'}` }
})

addCase('(b) no smelt goal in the queue: nothing is retired', () => {
  const queue = queueOf([DESCEND_IRON, COLLECT_IRON])
  const stale = staleOreDescend(queue.current!, queue.state.goals, withFurnace)
  return { pass: stale === null, detail: `staleFor=${stale?.description ?? 'none'}` }
})

addCase('(c) furnace still required: the item preconditions hold, so the descent advances to the smelt furnace path', () => {
  const queue = queueOf([DESCEND_IRON, COLLECT_IRON, SMELT_IRON])
  const stale = staleOreDescend(queue.current!, queue.state.goals, noFurnace)
  // The smelt itself is not startable without the furnace...
  const spec = compilePlannedGoal(SMELT_IRON, noFurnace)
  // ...but the furnace is a station precondition, so it does not block retiring
  // the stale ore descent: the existing furnace prereq path must lead.
  const stationUnmet = spec.preconditions.some((predicate) => predicate.kind === 'stationKnown')
  const pass = stale !== null && stale.kind === 'smelt' && stationUnmet && isOptionStartable(spec, noFurnace) === false
  return {
    pass,
    detail: `staleFor=${stale?.description ?? 'none'} stationUnmet=${stationUnmet} startable=${isOptionStartable(spec, noFurnace)}`,
  }
})

let failures = 0
process.stdout.write('M2 smelt priority - stale ore descent retirement\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} smelt-priority cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
