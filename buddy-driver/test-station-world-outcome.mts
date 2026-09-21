// test-station-world-outcome.mts - #station-outcome regression.
//
// Live defect (source f148a34, run `run-mubndci6-11rgn`, generation
// `gen-mubndcyc-1p09k1`, body ~3,72,28, health 20, oak_log 10):
//
//   goal=craft:crafting_table:1
//   LOCAL_PROGRESS_STALL stalledMs=67197 -> 68365 -> 69707 -> 70968 -> ... -> 91864
//   CRAFT_STATION_ALREADY_KNOWN item=crafting_table station=crafting_table reason=known_station held=0 sensed=3
//   RETURN_TO_KNOWN_RESOURCE item=crafting_table name=crafting_table target=8,70,24 dist=6 vertical=none
//   ACTION n=4277 id=RETRIEVE:known:station:crafting_table:b8_70_24 kind=RETRIEVE phase=approaching
//   rung=wooden_pickaxe | TRAVERSAL_RECORDED from=3,69,27 to=-1,72,28 kind=climb result=blocked reason=wall
//
// The body walked toward a KNOWN crafting table (8,70,24), the candidate layer
// correctly refused to craft a duplicate station, and the `craft 1 x
// crafting_table` ROW never resolved: the ladder RUNG predicate already counted
// the placed station as satisfied (`has(c, 'crafting_table') ||
// world.craftingTables.length > 0`), but the same world half was never applied to
// the ROW, so the stalledMs timer climbed without bound and the ladder could not
// reach `craft 1 x wooden_pickaxe` - the goal the known station would serve.
//
// The fix is the world-outcome half of the station closure in
// `dominatedPrerequisiteReason` (`#station-outcome`,
// `reason=outcome_already_satisfied`): a `craft`/`place` row for a station item
// is finished work when a usable station of that kind is HELD or already
// placed-and-sensed in the world model - exactly the fact the rung predicate
// reads. The genuine no-station path is untouched (no station -> the row stays
// and craft+place runs), and a goal that is NOT world-satisfied keeps stalling
// and escalating as today.
//
// Run: bun ./test-station-world-outcome.mts
import { buildLadder, dominatedPrerequisiteReason } from './planner.ts'
import { emptyWorldMemory } from './resident-types.ts'
import {
  GoalQueue,
  NON_PROGRESS_ESCALATED,
  PREREQ_DOMINATED,
  formatNonProgressEscalated,
  setPrereqAuditSink,
} from '../jev-agent/src/goalQueue.ts'
import type { GoalKind, GoalQueueSnapshot, GoalStatus, QueuedGoal } from '../jev-agent/src/goalQueue.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

/** The live body's world: a crafting table placed at (8,70,24) (+ a neighbour). */
function worldWithTable() {
  const world = emptyWorldMemory()
  world.craftingTables.push({ x: 8, y: 70, z: 24 }, { x: 8, y: 70, z: 25 })
  return world
}

function worldWithFurnace() {
  const world = emptyWorldMemory()
  world.furnaces.push({ x: 3, y: 64, z: 3 })
  return world
}

/** The live rung context: 10 oak_log held, station known, wooden_pickaxe next. */
const LIVE_WOOD: Record<string, number> = { oak_log: 10 }

function row(
  partial: Partial<QueuedGoal> & {
    id: string
    kind: GoalKind
    targetItem: string | null
    requiredCount: number
    status: GoalStatus
  },
): QueuedGoal {
  return {
    description: `${partial.kind} ${partial.requiredCount} x ${partial.targetItem ?? 'none'}`,
    targetY: null,
    dimension: null,
    startCount: 0,
    haveCount: 0,
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
    ...partial,
  }
}

/**
 * The leftover protected row the live generation carried: an unfinished
 * `craft 1 x crafting_table` prerequisite followed by the goal that USES the
 * station. This is exactly the measured queue head + its next row.
 */
function stationRows(station: 'crafting_table' | 'furnace', next: { kind: GoalKind; item: string }): GoalQueueSnapshot {
  const rows: QueuedGoal[] = [
    row({ id: `g51:craft:${station}`, kind: 'craft', targetItem: station, requiredCount: 1, status: 'active', protected: true, core: true }),
  ]
  if (station === 'furnace') {
    rows.push(row({ id: 'g52:place:furnace', kind: 'place', targetItem: 'furnace', requiredCount: 1, status: 'pending', protected: true, core: true }))
  }
  rows.push(row({ id: `g54:${next.kind}:${next.item}`, kind: next.kind, targetItem: next.item, requiredCount: 1, status: 'pending', protected: true, core: true }))
  return { counter: 54, goals: rows, revision: 7 }
}

function proofFor(
  goal: Pick<QueuedGoal, 'kind' | 'targetItem' | 'requiredCount'>,
  counts: Record<string, number>,
  world: ReturnType<typeof emptyWorldMemory>,
) {
  return dominatedPrerequisiteReason(goal, counts, world)
}

function marker(lines: readonly string[], prefix: string): string[] {
  return lines.filter((line) => line.startsWith(prefix))
}

// ---------------------------------------------------------------------------
// (a) a KNOWN PLACED station retires the `craft <station>` row at runtime
// ---------------------------------------------------------------------------
addCase('(a) placed crafting_table retires the craft row with outcome_already_satisfied', () => {
  const proof = proofFor({ kind: 'craft', targetItem: 'crafting_table', requiredCount: 1 }, LIVE_WOOD, worldWithTable())
  return {
    pass:
      proof?.item === 'crafting_table' &&
      proof.reason === 'outcome_already_satisfied' &&
      proof.held.length === 0 &&
      proof.outcome?.join(',') === 'crafting_table@8,70,24,crafting_table@8,70,25',
    detail: `proof=${JSON.stringify(proof)}`,
  }
})

addCase('(a) the queue retires the row and the goal that USES the station takes the head', () => {
  const lines: string[] = []
  setPrereqAuditSink((line) => lines.push(line))
  const queue = new GoalQueue()
  queue.setDominatedPrerequisiteReason((goal) => proofFor(goal, LIVE_WOOD, worldWithTable()))
  queue.restore(stationRows('crafting_table', { kind: 'craft', item: 'wooden_pickaxe' }))
  const retired = queue.state.goals.find((goal) => goal.id === 'g51:craft:crafting_table')
  const dominated = marker(lines, PREREQ_DOMINATED)
  const line = dominated.find((entry) => entry.includes('id=g51:craft:crafting_table'))
  const pass =
    retired?.status === 'impossible' &&
    retired.detail?.includes('reason=outcome_already_satisfied') === true &&
    retired.detail?.includes('outcome=crafting_table@8,70,24') === true &&
    line?.includes('held=none') === true &&
    line?.includes('outcome=crafting_table@8,70,24') === true &&
    queue.current?.id === 'g54:craft:wooden_pickaxe'
  return {
    pass,
    detail: `retired=${retired?.status} current=${queue.current?.id ?? 'none'} dominated=[${dominated.join(' | ')}]`,
  }
})

addCase('(a) the ladder frontier with the same world is wooden_pickaxe, not crafting_table', () => {
  const ladder = buildLadder(LIVE_WOOD, worldWithTable())
  const wooden = ladder.goals.filter((goal) => goal.kind === 'craft' && goal.targetItem === 'wooden_pickaxe')
  const duplicate = ladder.goals.filter((goal) => goal.targetItem === 'crafting_table')
  return {
    pass: ladder.rungId === 'wooden_pickaxe' && wooden.length === 1 && duplicate.length === 0,
    detail: `rung=${ladder.rungId} goals=[${ladder.goals.map((goal) => goal.description).join(' | ')}]`,
  }
})

// ---------------------------------------------------------------------------
// (b) a HELD station satisfies the row through the normal DONE completion
// ---------------------------------------------------------------------------
addCase('(b) a held station is completion (goalAlreadyMet), not a world retirement', () => {
  const proof = proofFor({ kind: 'craft', targetItem: 'crafting_table', requiredCount: 1 }, { ...LIVE_WOOD, crafting_table: 1 }, emptyWorldMemory())
  const ladder = buildLadder({ ...LIVE_WOOD, crafting_table: 1 }, emptyWorldMemory())
  return {
    pass: proof === null && ladder.rungId === 'wooden_pickaxe',
    detail: `proof=${JSON.stringify(proof)} rung=${ladder.rungId}`,
  }
})

addCase('(b) the held station marks the row DONE and the using goal takes the head', () => {
  const queue = new GoalQueue()
  queue.setDominatedPrerequisiteReason((goal) => proofFor(goal, { ...LIVE_WOOD, crafting_table: 1 }, emptyWorldMemory()))
  queue.restore(stationRows('crafting_table', { kind: 'craft', item: 'wooden_pickaxe' }))
  // The live inventory now holds the station: progress resolves the row normally.
  queue.markProgress(1)
  const done = queue.state.goals.find((goal) => goal.id === 'g51:craft:crafting_table')
  return {
    pass: done?.status === 'done' && queue.current?.id === 'g54:craft:wooden_pickaxe',
    detail: `row=${done?.status} current=${queue.current?.id ?? 'none'}`,
  }
})

// ---------------------------------------------------------------------------
// (c) NO station known: the craft+place path is untouched
// ---------------------------------------------------------------------------
addCase('(c) with no station known the row stays and the ladder plans the craft', () => {
  const proof = proofFor({ kind: 'craft', targetItem: 'crafting_table', requiredCount: 1 }, LIVE_WOOD, emptyWorldMemory())
  const queue = new GoalQueue()
  queue.setDominatedPrerequisiteReason((goal) => proofFor(goal, LIVE_WOOD, emptyWorldMemory()))
  queue.restore(stationRows('crafting_table', { kind: 'craft', item: 'wooden_pickaxe' }))
  const ladder = buildLadder(LIVE_WOOD, emptyWorldMemory())
  const craft = ladder.goals.filter((goal) => goal.kind === 'craft' && goal.targetItem === 'crafting_table')
  return {
    pass:
      proof === null &&
      queue.current?.id === 'g51:craft:crafting_table' &&
      ladder.rungId === 'crafting_table' &&
      craft.length === 1,
    detail: `proof=${JSON.stringify(proof)} current=${queue.current?.id ?? 'none'} rung=${ladder.rungId} goals=[${ladder.goals.map((goal) => goal.description).join(' | ')}]`,
  }
})

// ---------------------------------------------------------------------------
// (d) the furnace analogue
// ---------------------------------------------------------------------------
addCase('(d) a placed furnace retires both the craft and the place furnace rows', () => {
  const proof = proofFor({ kind: 'craft', targetItem: 'furnace', requiredCount: 1 }, {}, worldWithFurnace())
  const place = proofFor({ kind: 'place', targetItem: 'furnace', requiredCount: 1 }, {}, worldWithFurnace())
  const queue = new GoalQueue()
  queue.setDominatedPrerequisiteReason((goal) => proofFor(goal, {}, worldWithFurnace()))
  queue.restore(stationRows('furnace', { kind: 'craft', item: 'stone_pickaxe' }))
  const craftRow = queue.state.goals.find((goal) => goal.id === 'g51:craft:furnace')
  const placeRow = queue.state.goals.find((goal) => goal.id === 'g52:place:furnace')
  return {
    pass:
      proof?.reason === 'outcome_already_satisfied' &&
      proof.outcome?.join(',') === 'furnace@3,64,3' &&
      place?.reason === 'outcome_already_satisfied' &&
      craftRow?.status === 'impossible' &&
      placeRow?.status === 'impossible' &&
      queue.current?.id === 'g54:craft:stone_pickaxe',
    detail: `proof=${JSON.stringify(proof)} place=${JSON.stringify(place)} craftRow=${craftRow?.status} placeRow=${placeRow?.status} current=${queue.current?.id ?? 'none'}`,
  }
})

addCase('(d) with no furnace the craft+place furnace path runs unchanged', () => {
  const noFurnace = emptyWorldMemory()
  // A held crafting_table satisfies the earlier rung, so the frontier IS furnace.
  const counts = { crafting_table: 1, wooden_pickaxe: 1, cobblestone: 20 }
  const proof = proofFor({ kind: 'craft', targetItem: 'furnace', requiredCount: 1 }, counts, noFurnace)
  const ladder = buildLadder(counts, noFurnace)
  // The furnace rung's OWN ordered pair leads the plan: craft then place.
  const first = ladder.goals[0]
  const second = ladder.goals[1]
  return {
    pass:
      proof === null &&
      ladder.rungId === 'furnace' &&
      first?.kind === 'craft' &&
      first.targetItem === 'furnace' &&
      second?.kind === 'place' &&
      second.targetItem === 'furnace',
    detail: `proof=${JSON.stringify(proof)} rung=${ladder.rungId} first=[${first?.description ?? 'none'} | ${second?.description ?? 'none'}]`,
  }
})

// ---------------------------------------------------------------------------
// (e) a goal that is NOT world-satisfied keeps stalling / escalating as today
// ---------------------------------------------------------------------------
addCase('(e) the station proof never retires a goal the world does not satisfy', () => {
  // A non-station production row with a station known is still live work.
  const unrelated = proofFor({ kind: 'collect', targetItem: 'cobblestone', requiredCount: 12 }, {}, worldWithTable())
  // A station row with NO station known is still live work (fixture (c)), and a
  // station row with neither held nor placed must not be retired.
  const unsatisfied = proofFor({ kind: 'craft', targetItem: 'furnace', requiredCount: 1 }, { crafting_table: 1 }, emptyWorldMemory())
  const queue = new GoalQueue()
  queue.setDominatedPrerequisiteReason((goal) => proofFor(goal, {}, worldWithTable()))
  queue.restore({
    counter: 1,
    goals: [row({ id: 'g1:collect:cobblestone', kind: 'collect', targetItem: 'cobblestone', requiredCount: 12, status: 'active', protected: true, core: true })],
    revision: 1,
  })
  return {
    pass: unrelated === null && unsatisfied === null && queue.current?.id === 'g1:collect:cobblestone',
    detail: `unrelated=${JSON.stringify(unrelated)} unsatisfied=${JSON.stringify(unsatisfied)} current=${queue.current?.id ?? 'none'}`,
  }
})

addCase('(e) a genuine non-advancing head still escalates (NON_PROGRESS_ESCALATED)', () => {
  const queue = new GoalQueue()
  queue.setDominatedPrerequisiteReason((goal) => proofFor(goal, {}, worldWithTable()))
  queue.restore({
    counter: 37,
    goals: [row({ id: 'g37:collect:food', kind: 'collect', targetItem: 'food', requiredCount: 3, status: 'active', optional: true })],
    revision: 1,
  })
  // The optional row is not world-satisfied, so the station proof leaves it at the
  // head; the existing bounded non-progress watchdog still escalates it.
  const proof = proofFor({ kind: 'collect', targetItem: 'food', requiredCount: 3 }, {}, worldWithTable())
  let escalated: ReturnType<GoalQueue['reconcileNonProgressingHead']> | null = null
  for (let i = 0; i < 12; i += 1) escalated = queue.reconcileNonProgressingHead({ limit: 3 })
  const line = escalated === null ? '' : formatNonProgressEscalated(escalated)
  return {
    pass:
      proof === null &&
      escalated?.action === 'escalate' &&
      escalated.reason === 'no_alternative' &&
      line.startsWith(NON_PROGRESS_ESCALATED),
    detail: `proof=${JSON.stringify(proof)} line=${line}`,
  }
})

let failures = 0
process.stdout.write('station world-outcome closure (#station-outcome)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
setPrereqAuditSink(null)
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} passed\n`)
if (failures > 0) process.exit(1)
