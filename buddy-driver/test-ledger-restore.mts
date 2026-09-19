// test-ledger-restore.mts - ledger restore must not revive stale furnace acquisition goals,
// and a restored `done` goal whose live rung predicate is unmet must be reopened before any
// later-milestone goal can become active.
// Pure: no Bot, no network, no live host.
import { emptyWorldMemory } from './resident-types.ts'
import { GoalQueue } from '../jev-agent/src/goalQueue.ts'
import type { GoalKind, GoalQueueSnapshot, GoalStatus, QueuedGoal } from '../jev-agent/src/goalQueue.ts'
import { ledgerIsConsistent, selectLedgerSnapshot } from './generation-entry.ts'

interface Case {
  name: string
  expected: boolean
  observed: boolean
  detail?: string
}

function worldWithKnownFurnaces() {
  const world = emptyWorldMemory()
  world.furnaces.push({ x: 1, y: 64, z: 1 }, { x: 3, y: 64, z: 1 })
  return world
}

function snapshot(kind: GoalKind, targetItem: string, status: GoalStatus = 'active'): GoalQueueSnapshot {
  return {
    counter: 1,
    goals: [
      {
        id: `g1:${kind}:${targetItem}`,
        kind,
        description: `${kind} 1 x ${targetItem}`,
        targetItem,
        requiredCount: 1,
        targetY: null,
        dimension: null,
        startCount: 0,
        haveCount: 0,
        status,
        origin: 'llm',
        createdAt: 1,
        updatedAt: 1,
        detail: null,
      },
    ],
  }
}

/** A full queued goal with defaults, for the live-reconciliation cases. */
function queued(overrides: Partial<QueuedGoal> & Pick<QueuedGoal, 'id' | 'kind' | 'description' | 'targetItem'>): QueuedGoal {
  return {
    requiredCount: 1,
    targetY: null,
    dimension: null,
    startCount: 0,
    haveCount: 0,
    status: 'pending',
    origin: 'llm',
    createdAt: 1,
    updatedAt: 1,
    detail: null,
    ...overrides,
  }
}

function ledgerOf(goals: QueuedGoal[]): GoalQueueSnapshot {
  return { counter: goals.length + 10, goals }
}

/** The active goal the controller would run after restoring the selected snapshot. */
function restoredHead(host: GoalQueueSnapshot, counts: Record<string, number>): QueuedGoal | null {
  const chosen = selectLedgerSnapshot(host, null, counts, emptyWorldMemory())
  if (chosen === null) return null
  const queue = new GoalQueue()
  queue.restore(chosen.snapshot)
  return queue.current
}

/** A specific restored goal after the live-predicate reconciliation. */
function restoredGoal(host: GoalQueueSnapshot, counts: Record<string, number>, id: string): QueuedGoal | null {
  const chosen = selectLedgerSnapshot(host, null, counts, emptyWorldMemory())
  return chosen?.snapshot.goals.find((goal) => goal.id === id) ?? null
}

// The measured run-mu8ncid0-vwhn state: the ledger records the M2 smelt as done
// with haveCount=3, while the live bot holds only 2 iron ingots and the M3
// LLM-derived obsidian goal waits behind it.
const BUG_LEDGER = ledgerOf([
  queued({
    id: 'g2:smelt:iron_ingot',
    kind: 'smelt',
    description: 'smelt 3 x iron_ingot',
    targetItem: 'iron_ingot',
    requiredCount: 3,
    haveCount: 3,
    status: 'done',
  }),
  queued({
    id: 'g18:collect:obsidian',
    kind: 'collect',
    description: 'collect 1 x obsidian',
    targetItem: 'obsidian',
    requiredCount: 1,
    status: 'pending',
    origin: 'llm',
  }),
])

const cases: Case[] = [
  {
    name: 'active craft:furnace is stale when raw iron and two known furnaces are present',
    expected: false,
    observed: ledgerIsConsistent(
      { counter: 299, goals: [{ kind: 'craft', status: 'active', targetItem: 'furnace' }] },
      { raw_iron: 8 },
      worldWithKnownFurnaces(),
    ),
  },
  {
    name: 'pending place:furnace is stale when a furnace is held',
    expected: false,
    observed: ledgerIsConsistent(
      { counter: 300, goals: [{ kind: 'place', status: 'pending', targetItem: 'furnace' }] },
      { furnace: 1 },
      emptyWorldMemory(),
    ),
  },
  {
    name: 'active smelt:iron_ingot remains consistent with two known furnaces',
    expected: true,
    observed: ledgerIsConsistent(
      { counter: 301, goals: [{ kind: 'smelt', status: 'active', targetItem: 'iron_ingot' }] },
      { raw_iron: 8 },
      worldWithKnownFurnaces(),
    ),
  },
  {
    name: 'done furnace remains stale when no furnace is present',
    expected: false,
    observed: ledgerIsConsistent(
      { counter: 302, goals: [{ kind: 'craft', status: 'done', targetItem: 'furnace' }] },
      {},
      emptyWorldMemory(),
    ),
  },
  {
    name: 'host snapshot wins over a valid derived snapshot',
    expected: true,
    observed: selectLedgerSnapshot(snapshot('smelt', 'iron_ingot'), snapshot('collect', 'diamond'), { raw_iron: 8 }, worldWithKnownFurnaces())?.source === 'host-snapshot',
  },
  {
    name: 'stale host snapshot blocks a valid derived snapshot',
    expected: true,
    observed: selectLedgerSnapshot(snapshot('craft', 'furnace'), snapshot('smelt', 'iron_ingot'), { raw_iron: 8 }, worldWithKnownFurnaces()) === null,
  },
  {
    name: 'derived snapshot is used when host snapshot is absent',
    expected: true,
    observed: selectLedgerSnapshot(null, snapshot('smelt', 'iron_ingot'), { raw_iron: 8 }, worldWithKnownFurnaces())?.source === 'derived-file',
  },
  {
    name: 'BUG run-mu8ncid0-vwhn: live iron_ingot=2 reopens the restored done smelt before the M3 obsidian goal',
    expected: true,
    observed: (() => {
      const current = restoredHead(BUG_LEDGER, { iron_ingot: 2 })
      return current?.id === 'g2:smelt:iron_ingot' && current.status === 'active'
    })(),
    detail: `current=${restoredHead(BUG_LEDGER, { iron_ingot: 2 })?.id ?? 'none'} live iron_ingot=2`,
  },
  {
    name: 'positive control: live iron_ingot=3 keeps the restored smelt done (no spurious reopen)',
    expected: true,
    observed: (() => {
      const goal = restoredGoal(BUG_LEDGER, { iron_ingot: 3 }, 'g2:smelt:iron_ingot')
      return goal?.status === 'done' && goal.haveCount === 3
    })(),
    detail: `status=${restoredGoal(BUG_LEDGER, { iron_ingot: 3 }, 'g2:smelt:iron_ingot')?.status ?? 'none'} live iron_ingot=3`,
  },
  {
    name: 'generalized rung: done collect:raw_iron stays done when live iron_ingot=5 satisfies the raw_iron rung',
    expected: true,
    observed: (() => {
      const host = ledgerOf([
        queued({
          id: 'g1:collect:raw_iron',
          kind: 'collect',
          description: 'collect 3 x raw_iron',
          targetItem: 'raw_iron',
          requiredCount: 3,
          haveCount: 3,
          status: 'done',
        }),
      ])
      return restoredGoal(host, { iron_ingot: 5 }, 'g1:collect:raw_iron')?.status === 'done'
    })(),
  },
  {
    name: 'generalized rung: done collect:raw_iron reopens when live raw_iron=0 and iron_ingot=2 (<3)',
    expected: true,
    observed: (() => {
      const host = ledgerOf([
        queued({
          id: 'g1:collect:raw_iron',
          kind: 'collect',
          description: 'collect 3 x raw_iron',
          targetItem: 'raw_iron',
          requiredCount: 3,
          haveCount: 3,
          status: 'done',
        }),
      ])
      const goal = restoredGoal(host, { raw_iron: 0, iron_ingot: 2 }, 'g1:collect:raw_iron')
      return goal !== null && goal.status !== 'done' && goal.haveCount === 0
    })(),
  },
  {
    name: 'generalized rung: done craft:wooden_pickaxe stays done when a stone_pickaxe is held',
    expected: true,
    observed: (() => {
      const host = ledgerOf([
        queued({
          id: 'g1:craft:wooden_pickaxe',
          kind: 'craft',
          description: 'craft 1 x wooden_pickaxe',
          targetItem: 'wooden_pickaxe',
          requiredCount: 1,
          haveCount: 1,
          status: 'done',
        }),
      ])
      return restoredGoal(host, { stone_pickaxe: 1 }, 'g1:craft:wooden_pickaxe')?.status === 'done'
    })(),
  },
  {
    name: 'generalized rung: done craft:wooden_pickaxe is not left trusted when no pickaxe is held',
    expected: true,
    observed: (() => {
      const host = ledgerOf([
        queued({
          id: 'g1:craft:wooden_pickaxe',
          kind: 'craft',
          description: 'craft 1 x wooden_pickaxe',
          targetItem: 'wooden_pickaxe',
          requiredCount: 1,
          haveCount: 1,
          status: 'done',
        }),
      ])
      const chosen = selectLedgerSnapshot(host, null, {}, emptyWorldMemory())
      const goal = chosen?.snapshot.goals.find((candidate) => candidate.id === 'g1:craft:wooden_pickaxe') ?? null
      return chosen === null || goal?.status !== 'done'
    })(),
  },
  {
    name: 'generalized rung: done collect:diamond reopens when live diamond=0',
    expected: true,
    observed: (() => {
      const host = ledgerOf([
        queued({
          id: 'g1:collect:diamond',
          kind: 'collect',
          description: 'collect 1 x diamond',
          targetItem: 'diamond',
          requiredCount: 1,
          haveCount: 1,
          status: 'done',
        }),
      ])
      return restoredGoal(host, {}, 'g1:collect:diamond')?.status !== 'done'
    })(),
  },
  {
    name: 'generalized rung: done craft:iron_pickaxe stays done when a diamond_pickaxe is held',
    expected: true,
    observed: (() => {
      const host = ledgerOf([
        queued({
          id: 'g1:craft:iron_pickaxe',
          kind: 'craft',
          description: 'craft 1 x iron_pickaxe',
          targetItem: 'iron_pickaxe',
          requiredCount: 1,
          haveCount: 1,
          status: 'done',
        }),
      ])
      return restoredGoal(host, { diamond_pickaxe: 1 }, 'g1:craft:iron_pickaxe')?.status === 'done'
    })(),
  },
  {
    name: 'generalized rung: done smelt:charcoal reopens when live charcoal=0 (M2 charcoal gate)',
    expected: true,
    observed: (() => {
      const host = ledgerOf([
        queued({
          id: 'g1:smelt:charcoal',
          kind: 'smelt',
          description: 'smelt 1 x charcoal',
          targetItem: 'charcoal',
          requiredCount: 1,
          haveCount: 1,
          status: 'done',
        }),
      ])
      return restoredGoal(host, {}, 'g1:smelt:charcoal')?.status !== 'done'
    })(),
  },
]

let failures = 0
process.stdout.write('Ledger restore furnace consistency\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const pass = testCase.observed === testCase.expected
  if (!pass) failures += 1
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      expected=${String(testCase.expected)} observed=${String(testCase.observed)}${testCase.detail === undefined ? '' : ` ${testCase.detail}`}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} ledger-restore cases passed\n`)
if (failures > 0) process.exit(1)
