import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { createInventoryReachTransition } from './src/reach/scheduler.ts'
import type { ReachIdentity } from './src/reach/transition.ts'

const identity: ReachIdentity = {
  worldKey: 'world-a|minecraft:overworld|9',
  dimension: 'minecraft:overworld',
  worldEpoch: 9,
  generationId: 'generation-a',
  leaseId: 'lease-a',
}

test('generic inventory Mission derives one bounded Reach contract from typed source facts', () => {
  const plan = createInventoryReachTransition({
    mission: { id: 'mission-any-item', kind: 'inventory_at_least', item: 'oak_log', count: 3 },
    interactionReach: 5,
    sourceNames: ['oak_log', 'oak_log', '', 'stripped_oak_log'],
    identity,
    transitionId: 'reach-transition-a',
  })

  assert.deepEqual(plan.desiredPredicate, {
    id: 'reach.resource-source',
    proposition: {
      kind: 'within-interaction-reach-of-resource-source',
      item: 'oak_log',
      sourceNames: ['oak_log', 'stripped_oak_log'],
      interactionReach: 5,
    },
    expected: true,
  })
  assert.deepEqual(plan.contract.requires.map(({ id }) => id), ['mission.unsatisfied', 'reach.source-grounded'])
  assert.deepEqual(plan.contract.ensures, [plan.desiredPredicate])
  assert.equal(plan.contract.invariants[0]?.id, 'body.alive')
  assert.deepEqual(plan.contract.admissibleEffects, [{ kind: 'locomotion', maxUses: null }])
  assert.equal(plan.contract.budget.maxMechanicalSteps, 24)
  assert.equal(plan.contract.budget.maxElapsedMs, 120_000)
  assert.deepEqual(plan.contract.budget.resources, {})
  assert.deepEqual(plan.contract.budget.risk, { damage: 1 })
  assert.equal(plan.contract.progressDefinition.measure, 'predicate_distance')
  assert.deepEqual(plan.contract.identity, identity)
  assert.equal(plan.contract.contractHash.length, 64)
})

test('the Mission-to-Reach derivation is independent of benchmark rung order and M3 names', async () => {
  const source = await Bun.file(new URL('./src/reach/scheduler.ts', import.meta.url)).text()
  assert.doesNotMatch(source, /RUNGS|frontierRung|M2|M3|nether|ender_eye|blaze/)
  const left = createInventoryReachTransition({
    mission: { id: 'mission-one', kind: 'inventory_at_least', item: 'copper_ingot', count: 4 },
    interactionReach: 4.5,
    sourceNames: ['copper_ore'],
    identity,
    transitionId: 'transition-left',
  })
  const right = createInventoryReachTransition({
    mission: { id: 'mission-two', kind: 'inventory_at_least', item: 'copper_ingot', count: 4 },
    interactionReach: 4.5,
    sourceNames: ['copper_ore'],
    identity,
    transitionId: 'transition-right',
  })
  assert.equal(left.contract.desiredPredicateIdentity, right.contract.desiredPredicateIdentity)
  assert.equal(left.contract.ensuresIdentity, right.contract.ensuresIdentity)
})

test('invalid Mission or interaction reach fails before a contract is committed', () => {
  assert.throws(() => createInventoryReachTransition({
    mission: { id: 'bad-mission', kind: 'inventory_at_least', item: 'stone', count: 0 },
    interactionReach: 5,
    sourceNames: ['stone'],
    identity,
    transitionId: 'bad-transition',
  }), /positive integer count/)
  assert.throws(() => createInventoryReachTransition({
    mission: { id: 'mission-a', kind: 'inventory_at_least', item: 'stone', count: 1 },
    interactionReach: Number.NaN,
    sourceNames: ['stone'],
    identity,
    transitionId: 'bad-transition',
  }), /positive and finite/)
})
