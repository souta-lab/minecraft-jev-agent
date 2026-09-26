// I3 + #438 section 3/14/20 - closed-world candidate selection, canonical order,
// no hidden preference. Plus #25.4: an empty candidate set never synthesizes
// WAIT / first-candidate.

import { describe, expect, test } from 'bun:test'
import {
  HiddenPreferenceFieldError,
  DuplicateCandidateIdError,
  applyOrdering,
  candidateSetHash,
  choiceCriteria,
  permutedOrder,
} from '../candidates.ts'
import { booleanFact, numberFact, stringFact, unknownFact } from '../candidates.ts'
import type { CandidateFactValue } from '../contract.ts'
import { scriptedProvider, choiceAnswer, candidate } from '../testing.ts'
import { fixture, piRequestFor } from './support.ts'

const CANDIDATES = [
  candidate('walk:portal-entry-1', { skillKind: 'WALK_TO', facts: { pathCost: numberFact(12) } }),
  candidate('kill:e183', { skillKind: 'KILL', facts: { distance: numberFact(3.5), riskFlag: booleanFact(true) } }),
  candidate('clear:block-26-68-11', { skillKind: 'CLEAR_HEADROOM', facts: { postcondition: stringFact('air') } }),
]

describe('#438 section 3 / I3 - a decoded id must exist in the exact request candidate set', () => {
  test('a valid grounded id is accepted', async () => {
    const provider = scriptedProvider({
      kind: 'answer',
      answers: { pi_action_v3: choiceAnswer('kill:e183', { 'kill:e183': 0.7, 'walk:portal-entry-1': 0.3 }) },
    })
    const f = fixture({ provider })
    const result = await f.harness.choose(piRequestFor({ candidates: CANDIDATES }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    if (result.value.kind !== 'choice') throw new Error('expected a choice')
    expect(result.value.selectedCandidateId).toBe('kill:e183')
    expect(result.value.distribution).toEqual([
      { candidateId: 'clear:block-26-68-11', probability: 0 },
      { candidateId: 'kill:e183', probability: 0.7 },
      { candidateId: 'walk:portal-entry-1', probability: 0.3 },
    ])
  })

  test('an invented id is invalid_response, not a fuzzy match', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: choiceAnswer('mine:diamond_ore') } })
    const f = fixture({ provider })
    const result = await f.harness.choose(piRequestFor({ candidates: CANDIDATES }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('invalid_response')
    expect(result.detail).toContain('closed-world')
    const artifact = f.sink.artifacts()[0]
    expect(artifact?.rawTypedResponse).toEqual(choiceAnswer('mine:diamond_ore'))
    expect(artifact?.decoded).toBeNull()
  })

  test('an id that is valid in ANOTHER request is still invalid here', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: choiceAnswer('walk:portal-entry-1') } })
    const f = fixture({ provider })
    const result = await f.harness.choose(piRequestFor({ candidates: [candidate('kill:e183')] }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('invalid_response')
  })

  test('near-miss id shapes are not salvaged (case, whitespace, prefix, prose)', async () => {
    for (const raw of ['KILL:E183', ' kill:e183', 'kill:e183 ', 'kill:e183 because it is close', 'e183']) {
      const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: choiceAnswer(raw) } })
      const f = fixture({ provider })
      const result = await f.harness.choose(piRequestFor({ candidates: CANDIDATES }))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.kind).toBe('invalid_response')
    }
  })

  test('a distribution naming an unknown candidate id invalidates the whole answer', async () => {
    const provider = scriptedProvider({
      kind: 'answer',
      answers: { pi_action_v3: choiceAnswer('kill:e183', { 'kill:e183': 0.6, 'ghost:candidate': 0.4 }) },
    })
    const f = fixture({ provider })
    const result = await f.harness.choose(piRequestFor({ candidates: CANDIDATES }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('invalid_response')
  })

  test('a non-object answer is invalid_response (no prose salvage)', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: 'I would go north and mine' } })
    const f = fixture({ provider })
    const result = await f.harness.choose(piRequestFor({ candidates: CANDIDATES }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('invalid_response')
  })
})

describe('#438 section 9.4 / #25.4 - empty candidate set', () => {
  test('an empty grounded candidate set fails closed without a provider call', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: {} })
    const f = fixture({ provider })
    const result = await f.harness.choose(piRequestFor({ candidates: [] }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('empty_candidate_set')
    expect(provider.dispatches.length).toBe(0)
  })
})

describe('#438 section 14/20 - canonical order and hidden preference', () => {
  test('canonical order is by id, independent of insertion order', () => {
    const forward = applyOrdering(CANDIDATES, { kind: 'canonical' })
    const reverse = applyOrdering([...CANDIDATES].reverse(), { kind: 'canonical' })
    expect(forward.candidates.map((entry) => entry.id)).toEqual([
      'clear:block-26-68-11',
      'kill:e183',
      'walk:portal-entry-1',
    ])
    expect(reverse.candidates.map((entry) => entry.id)).toEqual(forward.candidates.map((entry) => entry.id))
    expect(candidateSetHash(CANDIDATES)).toBe(candidateSetHash([...CANDIDATES].reverse()))
  })

  test('candidate serialization order is recorded on the artifact', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183') } })
    const f = fixture({ provider })
    await f.harness.choose(piRequestFor({ candidates: CANDIDATES }))
    const artifact = f.sink.artifacts()[0]
    expect(artifact?.candidateOrdering).toBe('canonical')
    expect(artifact?.candidateOrderSalt).toBeNull()
    expect(artifact?.candidateIds).toEqual(artifact?.serializedCandidateIds)
  })

  test('permuted serialization is deterministic, artifact-visible, and hash-stable', () => {
    const first = permutedOrder(CANDIDATES, 'salt-1').map((entry) => entry.id)
    const second = permutedOrder(CANDIDATES, 'salt-1').map((entry) => entry.id)
    const other = permutedOrder(CANDIDATES, 'salt-2').map((entry) => entry.id)
    expect(first).toEqual(second)
    expect([...first].sort()).toEqual([...CANDIDATES].map((entry) => entry.id).sort())
    expect(candidateSetHash(permutedOrder(CANDIDATES, 'salt-1'))).toBe(candidateSetHash(CANDIDATES))
    void other
  })

  test('a permuted harness records the permutation and keeps candidate identity stable', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183') } })
    const f = fixture({ provider, ordering: { kind: 'permuted', salt: 'eval-salt' } })
    const result = await f.harness.choose(piRequestFor({ candidates: CANDIDATES }))
    expect(result.ok).toBe(true)
    const artifact = f.sink.artifacts()[0]
    expect(artifact?.candidateOrdering).toBe('permuted')
    expect(artifact?.candidateOrderSalt).toBe('eval-salt')
    expect([...(artifact?.serializedCandidateIds ?? [])].sort()).toEqual(
      [...(artifact?.candidateIds ?? [])].sort(),
    )
    // The criteria the provider saw follow the serialization order, not the id order.
    const criteria = choiceCriteria(applyOrdering(CANDIDATES, { kind: 'permuted', salt: 'eval-salt' }).candidates)
    expect(Object.keys(criteria)).toEqual([...(artifact?.serializedCandidateIds ?? [])])
  })

  test('hidden preference fields are a loud code bug, never silently stripped', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183') } })
    const f = fixture({ provider })
    const hiddenPreferenceCases: readonly Readonly<Record<string, CandidateFactValue>>[] = [
      { priority: numberFact(100) },
      { recommended: booleanFact(true) },
      { M3Preferred: booleanFact(true) },
      { preferBecausePortalRun: booleanFact(true) },
      { ranking: numberFact(1) },
    ]
    for (const facts of hiddenPreferenceCases) {
      await expect(
        f.harness.choose(piRequestFor({ candidates: [candidate('kill:e183', { facts })] })),
      ).rejects.toThrow(HiddenPreferenceFieldError)
    }
    expect(provider.dispatches.length).toBe(0)
  })

  test('deterministic factual metadata is allowed and reaches the criteria text', () => {
    const criteria = choiceCriteria(
      applyOrdering(
        [
          candidate('walk:portal-entry-1', {
            skillKind: 'WALK_TO',
            facts: { pathCost: numberFact(12), recentOutcome: stringFact('blocked'), unknownFact: unknownFact },
          }),
        ],
        { kind: 'canonical' },
      ).candidates,
    )
    expect(criteria['walk:portal-entry-1']).toContain('pathCost=12')
    expect(criteria['walk:portal-entry-1']).toContain('recentOutcome=blocked')
    expect(criteria['walk:portal-entry-1']).toContain('unknownFact=unknown')
  })

  test('duplicate candidate ids are rejected before any provider call', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183') } })
    const f = fixture({ provider })
    await expect(
      f.harness.choose(piRequestFor({ candidates: [candidate('kill:e183'), candidate('kill:e183')] })),
    ).rejects.toThrow(DuplicateCandidateIdError)
    expect(provider.dispatches.length).toBe(0)
  })
})
