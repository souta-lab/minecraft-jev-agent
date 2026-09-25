import assert from 'node:assert/strict'
import test from 'node:test'
import { eventMessage, persistentActionIdentity, persistentSkillStartProof } from './vtr-reach-evidence-events.mjs'

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
  const actionOutcomes = [row('VTR_MECHANICAL_OUTCOME', { intentId: 'intent-1', actionId: 'action-1' })]

  assert.deepEqual(persistentActionIdentity({ reservations, outcomes, actuations, actionOutcomes }), { problems: [] })
  assert.ok(persistentActionIdentity({ reservations, outcomes, actuations, actionOutcomes: [row('VTR_MECHANICAL_OUTCOME', { intentId: 'intent-2', actionId: 'action-2' })] }).problems.some((problem) => problem.reason === 'action-outcome-owner-does-not-match-mechanical-legs'))
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

test('one VTR-selected SKILL_START binds the persistent action and starts before its multiple legs', () => {
  const start = row('SKILL_START skill=WALK_TO selectedBy=vtr-transition', { actionId: 'action-1' })
  const base = { skillStartRows: [start], actionId: 'action-1', mechanicalSteps: 3, commitIndex: 2, skillStartIndex: 3, firstReservationIndex: 4, outcomeIndex: 12 }
  assert.equal(persistentSkillStartProof(base).status, 'PASS')
  assert.equal(persistentSkillStartProof({ ...base, actionId: 'action-2' }).status, 'FAIL')
  assert.equal(persistentSkillStartProof({ ...base, skillStartIndex: 5 }).status, 'FAIL')
  assert.equal(persistentSkillStartProof({ ...base, skillStartRows: [start, start] }).status, 'FAIL')
  assert.equal(persistentSkillStartProof({ ...base, skillStartRows: [row('SKILL_START selectedBy=vtr-transition')]}).status, 'INCOMPLETE')
})
