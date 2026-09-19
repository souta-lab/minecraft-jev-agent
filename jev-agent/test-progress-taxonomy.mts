// test-progress-taxonomy.mts - Issue #121 pure failure/progress taxonomy.
// No Mineflayer, network, model, or clock: the fixture is deterministic.
import assert from 'node:assert/strict'
import { classifyProgress, progressEvidence } from './src/progressTaxonomy.ts'
import { decideActionOutcome } from './src/actionPostcondition.ts'

let checks = 0
const ok = (label: string): void => {
  checks += 1
  console.log(`  ok ${checks} - ${label}`)
}

{
  const result = classifyProgress({ status: 'done', verified: true, itemsGained: 1, goalProgressDelta: 1 })
  assert.equal(result.code, 'goal_progress')
  assert.equal(result.productive, true)
  assert.equal(result.resetsStrategicStall, true)
  assert.deepEqual(progressEvidence(result), {
    family: 'goal_progress',
    reasonCode: 'goal_progress',
    status: 'success',
    verified: true,
    observable: true,
    productive: true,
    resetsStrategicStall: true,
    goalProgressDelta: 1,
    searchProgressDelta: 0,
    mechanicalProgress: true,
  })
  ok('verified goal progress is productive and resets strategic stall')
}

{
  const result = classifyProgress({ status: 'done', verified: true, progressed: true, searchProgressDelta: 1 })
  assert.equal(result.code, 'search_progress')
  assert.equal(result.productive, true)
  assert.equal(result.resetsStrategicStall, true)
  ok('verified search/frontier progress is productive even without an item gain')
}

{
  const result = classifyProgress({ status: 'done', verified: true, progressed: true })
  assert.equal(result.code, 'mechanical_success')
  assert.equal(result.observable, true)
  assert.equal(result.productive, false)
  assert.equal(result.resetsStrategicStall, false)
  ok('movement/body change without goal or search progress does not reset strategic stall')
}

{
  const result = classifyProgress({ status: 'done', verified: false, itemsGained: 0, blockRemoved: false })
  assert.equal(result.code, 'postcondition_unverified')
  assert.equal(result.status, 'failure')
  assert.equal(result.productive, false)
  assert.equal(result.resetsStrategicStall, false)
  ok('done plus unverified plus zero observable change is a typed failure')
}

{
  const decision = decideActionOutcome({
    kind: 'SMELT',
    status: 'done',
    verified: false,
    itemsGained: 0,
    blockRemoved: false,
  })
  assert.equal(decision.classification.code, 'postcondition_unverified')
  assert.match(decision.unverifiedLine ?? '', /reason=postcondition_unverified$/)
  ok('legacy action decision carries the typed reason and marker projection')
}

{
  const unreachable = classifyProgress({ status: 'failed', verified: false, failure: 'path_no_path' })
  const stalled = classifyProgress({ status: 'failed', verified: false, failure: 'path_stuck' })
  assert.equal(unreachable.code, 'target_unreachable')
  assert.equal(unreachable.status, 'blocked')
  assert.equal(stalled.code, 'timeout_stall')
  assert.equal(stalled.status, 'failure')
  ok('reachability and timeout/stall failures remain distinct')
}

{
  const blocked = classifyProgress({ status: 'failed', verified: false, initiationBlocked: true })
  const impossible = classifyProgress({ status: 'failed', verified: false, structurallyImpossible: true })
  const abandoned = classifyProgress({ status: 'failed', verified: false, abandonRequested: true })
  assert.equal(blocked.code, 'initiation_blocked')
  assert.equal(impossible.code, 'structurally_impossible')
  assert.equal(abandoned.code, 'semantic_abandon')
  assert.equal(abandoned.status, 'abandoned')
  ok('precondition, impossible, and semantic-abandon families are explicit')
}

{
  const cancelled = classifyProgress({ status: 'cancelled', verified: false, failure: 'cancelled' })
  assert.equal(cancelled.code, 'cancelled')
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.resetsStrategicStall, false)
  ok('cancellation is lifecycle state, never productive progress')
}

console.log(`progress-taxonomy: ${checks}/${checks} checks passed`)
