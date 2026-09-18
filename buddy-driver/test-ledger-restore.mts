// test-ledger-restore.mts - ledger restore must not revive stale furnace acquisition goals.
// Pure: no Bot, no network, no live host.
import { emptyWorldMemory } from './resident-types.ts'
import type { GoalKind, GoalQueueSnapshot, GoalStatus } from '../jev-agent/src/goalQueue.ts'
import { ledgerIsConsistent, selectLedgerSnapshot } from './generation-entry.ts'

interface Case {
  name: string
  expected: boolean
  observed: boolean
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
]

let failures = 0
process.stdout.write('Ledger restore furnace consistency\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const pass = testCase.observed === testCase.expected
  if (!pass) failures += 1
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      expected=${String(testCase.expected)} observed=${String(testCase.observed)}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} ledger-restore cases passed\n`)
if (failures > 0) process.exit(1)
