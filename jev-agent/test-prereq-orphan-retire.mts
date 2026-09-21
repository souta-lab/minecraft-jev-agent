// test-prereq-orphan-retire.mts - #prereq-orphan / #prereq-order regression.
//
// Live blocker (source `6ee333a`/`d5f969e`, runId `run-mub35qdr-1e1dh`): the
// durable GoalQueue ledger held a `protected=true core=true`
// `smelt:iron_ingot` row whose only dependent, `craft:flint_and_steel`, was
// already done and had consumed the ingot. The dead row stayed the queue head
// (`CANDIDATE_STARVATION blockedBy=precondition:station:furnace repeat=36`)
// while the real M2 next step, `collect:obsidian`, waited behind it. Mercury
// then patched the station rows in BEHIND the row that needed them.
//
// Cases:
//   (a) the exact measured ledger -> the orphaned smelt is retired with
//       `PREREQ_RETIRED ... reason=all_dependents_resolved`, the station rows it
//       orphaned cascade, and the queue advances to `collect:obsidian`;
//   (b) a still-required prerequisite (live dependent) is NOT retired;
//   (c) a retired protected/core row is not silently dropped: it stays in the
//       durable ledger as `impossible` with a recording detail, and a protected
//       row that is still required survives untouched;
//   (d) the station rows for a genuinely needed smelt are ordered BEFORE it
//       (`PREREQ_REORDERED`), and nothing is dropped/completed.
//
// Run: bun test ./test-prereq-orphan-retire.mts
import { GoalQueue, PREREQ_REORDERED, PREREQ_RETIRED, setPrereqAuditSink } from './src/goalQueue.ts'
import type { GoalKind, GoalStatus, QueuedGoal } from './src/goalQueue.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

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
 * The exact durable ledger measured live in `run-mub35qdr-1e1dh`
 * (`buddy-driver/buddy-ledger.json`), including the `g44..g47` station rows
 * Mercury patched in behind the smelt they were meant to unblock.
 */
function liveLedger(): QueuedGoal[] {
  return [
    row({ id: 'g1:collect:raw_iron', kind: 'collect', targetItem: 'raw_iron', requiredCount: 1, status: 'done', haveCount: 3, protected: true, core: true }),
    row({ id: 'g2:smelt:iron_ingot', kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 1, status: 'active', protected: true, core: true }),
    row({ id: 'g3:collect:flint', kind: 'collect', targetItem: 'flint', requiredCount: 1, status: 'done', haveCount: 1, protected: true, core: true }),
    row({ id: 'g4:craft:flint_and_steel', kind: 'craft', targetItem: 'flint_and_steel', requiredCount: 1, status: 'done', haveCount: 1, protected: true, core: true }),
    row({ id: 'g5:collect:obsidian', kind: 'collect', targetItem: 'obsidian', requiredCount: 10, status: 'active', protected: true, core: true }),
    row({ id: 'g6:place:obsidian', kind: 'place', targetItem: 'obsidian', requiredCount: 10, status: 'pending', protected: false, core: true }),
    row({ id: 'g7:place:nether_portal', kind: 'place', targetItem: 'nether_portal', requiredCount: 1, status: 'pending', protected: false, core: true }),
    row({ id: 'g44:craft:crafting_table', kind: 'craft', targetItem: 'crafting_table', requiredCount: 1, status: 'pending' }),
    row({ id: 'g45:place:crafting_table', kind: 'place', targetItem: 'crafting_table', requiredCount: 1, status: 'pending' }),
    row({ id: 'g46:craft:furnace', kind: 'craft', targetItem: 'furnace', requiredCount: 1, status: 'pending' }),
    row({ id: 'g47:place:furnace', kind: 'place', targetItem: 'furnace', requiredCount: 1, status: 'pending' }),
  ]
}

function restoreLiveLedger(lines: string[]): GoalQueue {
  setPrereqAuditSink((line) => lines.push(line))
  const queue = new GoalQueue()
  queue.restore({ counter: 47, goals: liveLedger(), revision: 7 })
  return queue
}

function marker(lines: readonly string[], prefix: string): string[] {
  return lines.filter((line) => line.startsWith(prefix))
}

addCase('(a) the exact live ledger retires the orphaned smelt and advances to collect:obsidian', () => {
  const lines: string[] = []
  const queue = restoreLiveLedger(lines)
  const goals = queue.state.goals
  const smelt = goals.find((goal) => goal.id === 'g2:smelt:iron_ingot')
  const retired = marker(lines, PREREQ_RETIRED)
  const smeltLine = retired.find((line) => line.includes('id=g2:smelt:iron_ingot'))
  const retiredIds = retired.map((line) => (line.match(/id=(\S+)/) ?? [])[1] ?? '')
  const pass =
    smelt?.status === 'impossible' &&
    smelt.detail?.includes('reason=all_dependents_resolved') === true &&
    smeltLine?.includes('item=iron_ingot') === true &&
    smeltLine?.includes('reason=all_dependents_resolved') === true &&
    smeltLine?.includes('dependents=1') === true &&
    smeltLine?.includes('protected=true') === true &&
    smeltLine?.includes('core=true') === true &&
    // the station rows the smelt orphaned cascade behind it
    retiredIds.includes('g46:craft:furnace') &&
    retiredIds.includes('g47:place:furnace') &&
    retiredIds.length === 3 &&
    queue.current?.id === 'g5:collect:obsidian' &&
    queue.current?.kind === 'collect' &&
    queue.current?.targetItem === 'obsidian'
  return {
    pass,
    detail: `current=${queue.current?.id ?? 'none'} retired=[${retiredIds.join(',')}] lines=[${retired.join(' | ')}]`,
  }
})

addCase('(b) a still-required prerequisite is NOT retired', () => {
  const lines: string[] = []
  setPrereqAuditSink((line) => lines.push(line))
  const queue = new GoalQueue()
  queue.restore({
    counter: 3,
    goals: [
      row({ id: 'g1:collect:raw_iron', kind: 'collect', targetItem: 'raw_iron', requiredCount: 1, status: 'done', haveCount: 1 }),
      // smelt is live work: its consumer craft:flint_and_steel is still pending
      row({ id: 'g2:smelt:iron_ingot', kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 1, status: 'active', protected: true, core: true }),
      row({ id: 'g3:craft:flint_and_steel', kind: 'craft', targetItem: 'flint_and_steel', requiredCount: 1, status: 'pending' }),
    ],
  })
  const smelt = queue.state.goals.find((goal) => goal.id === 'g2:smelt:iron_ingot')
  const pass =
    smelt?.status === 'active' &&
    marker(lines, PREREQ_RETIRED).length === 0 &&
    queue.current?.id === 'g2:smelt:iron_ingot'
  return {
    pass,
    detail: `smeltStatus=${smelt?.status} current=${queue.current?.id ?? 'none'} retired=${marker(lines, PREREQ_RETIRED).length}`,
  }
})

addCase('(c) a retired protected/core row is not silently dropped, and a required protected row survives', () => {
  const lines: string[] = []
  const queue = restoreLiveLedger(lines)
  const goals = queue.state.goals
  const smelt = goals.find((goal) => goal.id === 'g2:smelt:iron_ingot')
  const obsidian = goals.find((goal) => goal.id === 'g5:collect:obsidian')
  const frame = goals.find((goal) => goal.id === 'g6:place:obsidian')
  const portal = goals.find((goal) => goal.id === 'g7:place:nether_portal')
  const smeltStatus: string | undefined = smelt?.status
  const pass =
    // the retired row is retained in the durable ledger, explicitly marked
    smelt !== undefined &&
    smeltStatus !== 'done' &&
    smeltStatus === 'impossible' &&
    typeof smelt.detail === 'string' &&
    smelt.detail.includes('retired prerequisite') &&
    smelt.detail.includes('dependents=1') &&
    // the explicit audit line is the opposite of a silent drop
    marker(lines, PREREQ_RETIRED).some((line) => line.includes('id=g2:smelt:iron_ingot')) &&
    // required protected/core rows are untouched
    obsidian?.status === 'active' &&
    frame?.status === 'pending' &&
    portal?.status === 'pending' &&
    queue.state.done === 3
  return {
    pass,
    detail: `smelt=${smelt?.status}/${smelt?.detail ?? 'none'} obsidian=${obsidian?.status} frame=${frame?.status} portal=${portal?.status} done=${queue.state.done}`,
  }
})

addCase('(d) the station rows Mercury patches behind a needed active smelt are ordered before it', () => {
  const lines: string[] = []
  setPrereqAuditSink((line) => lines.push(line))
  const queue = new GoalQueue()
  // 1. the smelt is the committed active head (genuinely needed: no dependent
  //    has consumed its target, so it is NOT retired).
  queue.applyPlan(
    [{ kind: 'smelt', description: 'smelt 1 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 1, protected: true }],
    'llm',
  )
  const smeltBefore = queue.current?.targetItem
  // 2. Mercury patches the station chain in BEHIND it (the measured live shape).
  queue.applyPlan(
    [
      { kind: 'craft', description: 'craft 1 x crafting_table', targetItem: 'crafting_table', requiredCount: 1 },
      { kind: 'place', description: 'place 1 x crafting_table', targetItem: 'crafting_table', requiredCount: 1 },
      { kind: 'craft', description: 'craft 1 x furnace', targetItem: 'furnace', requiredCount: 1 },
      { kind: 'place', description: 'place 1 x furnace', targetItem: 'furnace', requiredCount: 1 },
    ],
    'llm',
    'patch',
    { reason: 'mercury station patch' },
  )
  const unfinished = queue.state.goals.filter((goal) => goal.status === 'pending' || goal.status === 'active')
  const index = (kind: string, item: string): number =>
    unfinished.findIndex((goal) => goal.kind === kind && goal.targetItem === item)
  const craftFurnace = index('craft', 'furnace')
  const placeFurnace = index('place', 'furnace')
  const smelt = index('smelt', 'iron_ingot')
  const reordered = marker(lines, PREREQ_REORDERED)
  const pass =
    smeltBefore === 'iron_ingot' &&
    unfinished.length === 5 &&
    craftFurnace !== -1 &&
    placeFurnace !== -1 &&
    smelt !== -1 &&
    craftFurnace < placeFurnace &&
    placeFurnace < smelt &&
    reordered.some((line) => line.includes('item=furnace') && line.includes('before=')) &&
    unfinished.every((goal) => goal.status !== 'done' && goal.status !== 'impossible') &&
    // the needed smelt was kept, not dropped, and both station rows survive
    unfinished.filter((goal) => goal.targetItem === 'furnace').length === 2
  return {
    pass,
    detail: `headBefore=${smeltBefore} order=[${unfinished.map((goal) => `${goal.kind}:${goal.targetItem}`).join(' -> ')}] current=${queue.current?.description ?? 'none'} moves=[${reordered.join(' | ')}]`,
  }
})

let failures = 0
process.stdout.write('prerequisite orphan retirement / ordering\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
setPrereqAuditSink(null)
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} prerequisite reconciliation cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
