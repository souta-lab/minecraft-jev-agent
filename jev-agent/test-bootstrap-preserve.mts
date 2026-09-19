// test-bootstrap-preserve.mts - the single-shot bootstrap must not replace a
// RESTORED, not-yet-done current goal.
//
// Live evidence (run-mu8kgmjm-ujwg, BOOT 15:52:57.635Z, BUILD 9613fa6160b9):
//   15:52:58.679 LEDGER_RESTORED current=smelt 3 x iron_ingot
//   15:52:58.753 QUEUE_DEPTH op=replace reason=bootstrap
//   15:52:59+    RETRIEVE / WAIT for craft:iron_pickaxe, no SMELT/FURNACE marker
// buddy-driver restores the host ledger into the controller queue BEFORE
// controller.start() (generation-entry.ts restoreLedgerIntoController) and
// resident mode passes ledgerPath=null (generation-entry.ts), so the
// controller's own post-plan loadLedger() cannot re-read the ledger. Applying
// the planner ladder with op=replace therefore deleted the restored head and
// the smelt never became active.
//
// Run: npx tsx test-bootstrap-preserve.mts
import { resolveBootstrapPlanOp } from './src/controller.ts'
import { GoalQueue } from './src/goalQueue.ts'
import type { GoalQueueSnapshot, PlanOp, PlannedGoal, QueuedGoal } from './src/goalQueue.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

function queued(overrides: Partial<QueuedGoal> & Pick<QueuedGoal, 'id' | 'kind' | 'description'>): QueuedGoal {
  return {
    targetItem: null,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'pending',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
    ...overrides,
  }
}

const RESTORED_SMELT = queued({
  id: 'g20:smelt:iron_ingot',
  kind: 'smelt',
  description: 'smelt 3 x iron_ingot',
  targetItem: 'iron_ingot',
  requiredCount: 3,
  status: 'active',
})
const RESTORED_TAIL = queued({
  id: 'g21:collect:diamond',
  kind: 'collect',
  description: 'collect 3 x diamond',
  targetItem: 'diamond',
  requiredCount: 3,
})
const RESTORED_LEDGER: GoalQueueSnapshot = { counter: 21, goals: [RESTORED_SMELT, RESTORED_TAIL] }

// The planner ladder for the same moment: it leads with the pickaxe rung,
// exactly like the live `craft 1 x iron_pickaxe` plan.
const LADDER: PlannedGoal[] = [
  { kind: 'craft', description: 'craft 1 x iron_pickaxe', targetItem: 'iron_pickaxe', requiredCount: 1, core: true },
  { kind: 'collect', description: 'collect 1 x diamond', targetItem: 'diamond', requiredCount: 1, core: true },
]

/** The bootstrap sequence: restore the ledger, resolve the op, apply the plan. */
function bootstrap(snapshot: GoalQueueSnapshot | null, requestedOp: PlanOp | undefined): { queue: GoalQueue; op: PlanOp } {
  const queue = new GoalQueue()
  if (snapshot !== null) queue.restore(snapshot)
  const op = resolveBootstrapPlanOp(queue, requestedOp)
  queue.applyPlan(LADDER, 'llm', op)
  return { queue, op }
}

addCase('(a) a restored non-done current goal survives a bootstrap op=replace as the queue head', () => {
  const { queue, op } = bootstrap(RESTORED_LEDGER, 'replace')
  const head = queue.current
  const pass = op === 'continue' && head !== null && head.description === 'smelt 3 x iron_ingot' && head.status === 'active'
  return { pass, detail: `op=${op} head=${head?.description ?? 'none'} status=${head?.status ?? 'none'}` }
})

addCase('(b) the bootstrap ladder is merged BEHIND the restored head, not dropped', () => {
  const { queue } = bootstrap(RESTORED_LEDGER, 'replace')
  const descriptions = queue.state.goals.map((goal) => goal.description)
  const headIndex = descriptions.indexOf('smelt 3 x iron_ingot')
  const restoredTailIndex = descriptions.indexOf('collect 3 x diamond')
  const ladderCraftIndex = descriptions.indexOf('craft 1 x iron_pickaxe')
  const ladderCollectIndex = descriptions.indexOf('collect 1 x diamond')
  const pass =
    headIndex === 0 &&
    restoredTailIndex > headIndex &&
    ladderCraftIndex > headIndex &&
    ladderCollectIndex > headIndex
  return { pass, detail: `order=${JSON.stringify(descriptions)}` }
})

addCase('(c) fresh bootstrap (no ledger) still replaces: the ladder becomes the queue', () => {
  const { queue, op } = bootstrap(null, 'replace')
  const head = queue.current
  const pass = op === 'replace' && head !== null && head.description === 'craft 1 x iron_pickaxe' && queue.state.depth === 2
  return { pass, detail: `op=${op} head=${head?.description ?? 'none'} depth=${queue.state.depth}` }
})

addCase('(d) generality: the preserved head is any restored goal, not only the iron smelt', () => {
  const ledger: GoalQueueSnapshot = {
    counter: 5,
    goals: [
      queued({
        id: 'g4:craft:diamond_pickaxe',
        kind: 'craft',
        description: 'craft 1 x diamond_pickaxe',
        targetItem: 'diamond_pickaxe',
        status: 'active',
      }),
      queued({ id: 'g5:descend', kind: 'descend', description: 'descend_to:Y=-59', targetItem: 'diamond', targetY: -59, requiredCount: 1 }),
    ],
  }
  const { queue, op } = bootstrap(ledger, 'replace')
  const head = queue.current
  const pass = op === 'continue' && head !== null && head.description === 'craft 1 x diamond_pickaxe'
  return { pass, detail: `op=${op} head=${head?.description ?? 'none'}` }
})

addCase('(e) an explicit abort is never overridden by a restored head', () => {
  const { queue, op } = bootstrap(RESTORED_LEDGER, 'abort')
  const pass = op === 'abort' && queue.current === null
  return { pass, detail: `op=${op} current=${queue.current?.description ?? 'none'}` }
})

addCase('(f) a ledger whose goals are all done leaves bootstrap unchanged', () => {
  const ledger: GoalQueueSnapshot = {
    counter: 3,
    goals: [
      queued({
        id: 'g3:collect:raw_iron',
        kind: 'collect',
        description: 'collect 3 x raw_iron',
        targetItem: 'raw_iron',
        requiredCount: 3,
        status: 'done',
        haveCount: 3,
      }),
    ],
  }
  const { queue, op } = bootstrap(ledger, 'replace')
  const head = queue.current
  const pass = op === 'replace' && head !== null && head.description === 'craft 1 x iron_pickaxe' && queue.state.done === 1
  return { pass, detail: `op=${op} head=${head?.description ?? 'none'} done=${queue.state.done}` }
})

let failures = 0
process.stdout.write('Bootstrap must preserve a restored non-done current goal\n')
process.stdout.write('-'.repeat(78) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(78) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} bootstrap-preserve cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
