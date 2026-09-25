import assert from 'node:assert/strict'
import test from 'node:test'
import { eventMessage, persistentActionIdentity } from './vtr-reach-evidence-events.mjs'

const row = (message, detail = {}) => ({ message, detail })

test('event token selection does not treat typed refusals as successful mechanical outcomes', () => {
  const rows = [
    row('VTR_MECHANICAL_OUTCOME transition=t1 status=done'),
    row('VTR_MECHANICAL_OUTCOME_REFUSED transition=t1 reason=lease'),
    row('VTR_MECHANICAL_OUTCOME_REJECTED transition=t1 reason=stale'),
  ]

  assert.deepEqual(eventMessage(rows, 'VTR_MECHANICAL_OUTCOME'), [rows[0]])
  assert.deepEqual(eventMessage(rows, 'VTR_MECHANICAL_OUTCOME_REFUSED'), [rows[1]])
})

test('persistent Reach evidence binds multiple legs to one VTR intent and action', () => {
  const reservations = [1, 2, 3].map((step) => row('VTR_MECHANICAL_STEP_RESERVED', { stepId: `s${step}`, intentId: 'intent-1', actionId: 'action-1' }))
  const outcomes = [1, 2, 3].map((step) => row('VTR_MECHANICAL_STEP_OUTCOME', { stepId: `s${step}`, intentId: 'intent-1', actionId: 'action-1' }))
  const actuations = [row('VTR_TRANSITION_ACTUATION', { intentId: 'intent-1', actionId: 'action-1' })]

  assert.deepEqual(persistentActionIdentity({ reservations, outcomes, actuations }), { problems: [] })
})

test('persistent Reach evidence rejects one actuation per mechanical leg', () => {
  const reservations = [1, 2, 3].map((step) => row('VTR_MECHANICAL_STEP_RESERVED', { stepId: `s${step}`, intentId: `intent-${step}`, actionId: `action-${step}` }))
  const outcomes = [1, 2, 3].map((step) => row('VTR_MECHANICAL_STEP_OUTCOME', { stepId: `s${step}`, intentId: `intent-${step}`, actionId: `action-${step}` }))
  const actuations = [1, 2, 3].map((step) => row('VTR_TRANSITION_ACTUATION', { intentId: `intent-${step}`, actionId: `action-${step}` }))

  const result = persistentActionIdentity({ reservations, outcomes, actuations })
  assert.ok(result.problems.some((problem) => problem.field === 'intentId' && problem.reason === 'mechanical-legs-do-not-share-one-owner'))
  assert.ok(result.problems.some((problem) => problem.field === 'actionId' && problem.reason === 'mechanical-legs-do-not-share-one-owner'))
  assert.ok(result.problems.some((problem) => problem.field === 'actuations' && problem.reason === 'persistent-reach-proof-requires-one-actuation'))
})

