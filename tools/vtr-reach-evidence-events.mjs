export function eventMessage(rows, marker) {
  return rows.filter((row) => {
    if (typeof row?.message !== 'string') return false
    return row.message.trim().split(/\s+/, 1)[0] === marker
  })
}

export function persistentActionIdentity({ reservations, outcomes, actuations, actionOutcomes = [] }) {
  const problems = []
  const legRows = [...reservations, ...outcomes]
  const uniqueValues = (rows, field) => [...new Set(rows.map((row) => row?.detail?.[field]).filter((value) => typeof value === 'string' && value.length > 0))]
  const missingValues = (rows, field) => rows.filter((row) => typeof row?.detail?.[field] !== 'string' || row.detail[field].length === 0).length

  for (const field of ['intentId', 'actionId']) {
    const missingLegValues = missingValues(legRows, field)
    const missingActionOutcomeValues = missingValues(actionOutcomes, field)
    const legValues = uniqueValues(legRows, field)
    const actuationValues = uniqueValues(actuations, field)
    const actionOutcomeValues = uniqueValues(actionOutcomes, field)
    if (missingLegValues > 0) problems.push({ field, reason: 'missing-on-mechanical-leg', count: missingLegValues })
    if (missingActionOutcomeValues > 0) problems.push({ field, reason: 'missing-on-action-outcome', count: missingActionOutcomeValues })
    if (legValues.length !== 1) problems.push({ field, reason: 'mechanical-legs-do-not-share-one-owner', values: legValues })
    if (actuationValues.length !== 1) problems.push({ field, reason: 'actuations-do-not-share-one-owner', values: actuationValues })
    if (legValues.length === 1 && actuationValues.length === 1 && legValues[0] !== actuationValues[0]) {
      problems.push({ field, reason: 'actuation-owner-does-not-match-mechanical-legs', leg: legValues[0], actuation: actuationValues[0] })
    }
    if (actionOutcomeValues.length > 1) problems.push({ field, reason: 'action-outcomes-do-not-share-one-owner', values: actionOutcomeValues })
    if (legValues.length === 1 && actionOutcomeValues.length === 1 && legValues[0] !== actionOutcomeValues[0]) {
      problems.push({ field, reason: 'action-outcome-owner-does-not-match-mechanical-legs', leg: legValues[0], actionOutcome: actionOutcomeValues[0] })
    }
  }
  if (actuations.length !== 1) problems.push({ field: 'actuations', reason: 'persistent-reach-proof-requires-one-actuation', count: actuations.length })
  if (actionOutcomes.length > 1) problems.push({ field: 'actionOutcomes', reason: 'persistent-reach-proof-allows-at-most-one-action-outcome', count: actionOutcomes.length })
  return { problems }
}

export function persistentSkillStartProof({ skillStartRows, actionId, mechanicalSteps, commitIndex, skillStartIndex, firstReservationIndex, outcomeIndex }) {
  if (skillStartRows.length === 0) return { status: 'INCOMPLETE', reason: 'no raw executor SKILL_START event was archived' }
  if (skillStartRows.length !== 1) return { status: 'FAIL', reason: 'persistent Reach proof requires exactly one SKILL_START', count: skillStartRows.length }
  const skillStartRow = skillStartRows[0]
  if (!/\bselectedBy=vtr-transition(?:\s|$)/.test(String(skillStartRow?.message ?? ''))) {
    return { status: 'FAIL', reason: 'the single SKILL_START was not selected by the VTR transition controller' }
  }
  const observedActionId = skillStartRow?.detail?.actionId
  if (typeof observedActionId !== 'string' || observedActionId.length === 0) {
    return { status: 'INCOMPLETE', reason: 'SKILL_START does not expose its Executor actionId', observedActionId: observedActionId ?? null }
  }
  if (typeof actionId !== 'string' || actionId.length === 0) {
    return { status: 'INCOMPLETE', reason: 'per-leg evidence does not establish one Executor actionId', observedActionId }
  }
  if (observedActionId !== actionId) {
    return { status: 'FAIL', reason: 'SKILL_START actionId differs from the VTR mechanical-leg owner', expectedActionId: actionId, observedActionId }
  }
  if (!Number.isInteger(mechanicalSteps)) return { status: 'INCOMPLETE', reason: 'terminal mechanical step count is unavailable' }
  if (mechanicalSteps < 3) return { status: 'FAIL', reason: 'persistent Reach proof requires at least three mechanical legs', mechanicalSteps }
  if (![commitIndex, skillStartIndex, firstReservationIndex, outcomeIndex].every(Number.isInteger)) {
    return { status: 'INCOMPLETE', reason: 'event indices are unavailable for Skill/leg ordering' }
  }
  if (!(commitIndex < skillStartIndex && skillStartIndex < firstReservationIndex && skillStartIndex < outcomeIndex)) {
    return { status: 'FAIL', reason: 'SKILL_START must occur after commit and before its first mechanical leg and terminal', commitIndex, skillStartIndex, firstReservationIndex, outcomeIndex }
  }
  return { status: 'PASS', actionId, mechanicalSteps }
}
