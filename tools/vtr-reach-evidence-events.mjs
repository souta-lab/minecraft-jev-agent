export function eventMessage(rows, marker) {
  return rows.filter((row) => {
    if (typeof row?.message !== 'string') return false
    return row.message.trim().split(/\s+/, 1)[0] === marker
  })
}

export function persistentActionIdentity({ reservations, outcomes, actuations }) {
  const problems = []
  const legRows = [...reservations, ...outcomes]
  const uniqueValues = (rows, field) => [...new Set(rows.map((row) => row?.detail?.[field]).filter((value) => typeof value === 'string' && value.length > 0))]
  const missingValues = (rows, field) => rows.filter((row) => typeof row?.detail?.[field] !== 'string' || row.detail[field].length === 0).length

  for (const field of ['intentId', 'actionId']) {
    const missingLegValues = missingValues(legRows, field)
    const legValues = uniqueValues(legRows, field)
    const actuationValues = uniqueValues(actuations, field)
    if (missingLegValues > 0) problems.push({ field, reason: 'missing-on-mechanical-leg', count: missingLegValues })
    if (legValues.length !== 1) problems.push({ field, reason: 'mechanical-legs-do-not-share-one-owner', values: legValues })
    if (actuationValues.length !== 1) problems.push({ field, reason: 'actuations-do-not-share-one-owner', values: actuationValues })
    if (legValues.length === 1 && actuationValues.length === 1 && legValues[0] !== actuationValues[0]) {
      problems.push({ field, reason: 'actuation-owner-does-not-match-mechanical-legs', leg: legValues[0], actuation: actuationValues[0] })
    }
  }
  if (actuations.length !== 1) problems.push({ field: 'actuations', reason: 'persistent-reach-proof-requires-one-actuation', count: actuations.length })
  return { problems }
}
