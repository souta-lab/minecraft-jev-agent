// I4 + I5 - epoch equality and stale-result fencing (#438 section 7/8, #437 section 3).
//
// The harness - not the call site - owns this. A late or no-longer-current answer
// must be dropped, marked STALE_JEV_RESULT_DROPPED, and must never be
// reinterpreted against the newer state nor authorize a SkillCommitment.

import { describe, expect, test } from 'bun:test'
import { scriptedProvider, choiceAnswer, booleanAnswer } from '../testing.ts'
import { skillCommitmentHandoff } from '../contract.ts'
import { STALE_JEV_RESULT_DROPPED } from '../identity.ts'
import { fixture, flakyProvider, mutatingProvider, piRequestFor } from './support.ts'
import { baseIdentity, betaRequest } from '../testing.ts'

describe('#438 section 22 I4 - every result carries the request decision epoch', () => {
  test('a successful choice carries the bound epoch on the value and the artifact', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183') } })
    const f = fixture({ provider })
    const result = await f.harness.choose(piRequestFor())
    expect(result.ok).toBe(true)
    if (!result.ok || result.value.kind !== 'choice') return
    expect(result.value.decisionEpoch).toBe(481)
    expect(result.value.evidence.decisionEpoch).toBe(481)
    expect(f.sink.artifacts()[0]?.decisionEpoch).toBe(481)
  })

  test('a failure carries no epoch claim and no model answer', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: choiceAnswer('ghost') } })
    const f = fixture({ provider })
    const result = await f.harness.choose(piRequestFor())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.modelAnswerPresent).toBe(false)
    expect(result.fallbackAuthority).toBe('code')
    expect('value' in result).toBe(false)
  })
})

describe('#438 section 22 I5 / section 7 - stale results cannot authorize execution', () => {
  const cases: readonly { readonly name: string; readonly mutate: (identity: ReturnType<typeof fixture>['identity']) => void }[] = [
    { name: 'decision epoch advanced', mutate: (identity) => identity.advanceEpoch() },
    { name: 'world epoch changed', mutate: (identity) => identity.setWorld('server|overworld', 4) },
    { name: 'world key changed', mutate: (identity) => identity.setWorld('server|the_nether', 3) },
    { name: 'generation changed', mutate: (identity) => identity.setGeneration('gen-2') },
    { name: 'option instance changed', mutate: (identity) => identity.setOptionInstance('option:test:2') },
  ]

  for (const scenario of cases) {
    test(`a completion that lands after the ${scenario.name} is dropped as stale`, async () => {
      let identityRef: ReturnType<typeof fixture>['identity'] | null = null
      const provider = mutatingProvider({
        answers: { pi_action_v3: choiceAnswer('kill:e183', { 'kill:e183': 0.9 }) },
        mutate: () => {
          if (identityRef !== null) scenario.mutate(identityRef)
        },
      })
      const f = fixture({ provider })
      identityRef = f.identity
      const request = piRequestFor()
      const result = await f.harness.choose(request)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.kind).toBe('stale')
      expect(result.modelAnswerPresent).toBe(false)

      const artifact = f.sink.artifacts()[0]
      expect(artifact?.staleCheck.checked).toBe(true)
      expect(artifact?.staleCheck.current).toBe(false)
      expect(artifact?.staleCheck.reason).not.toBeNull()
      expect(artifact?.finalProposal.kind).toBe('none')
      expect(artifact?.decoded).toBeNull()
      expect(artifact?.rawTypedResponse).toEqual(choiceAnswer('kill:e183', { 'kill:e183': 0.9 }))

      const drops = f.sink.staleDrops()
      expect(drops.length).toBe(1)
      expect(drops[0]?.record).toBe(STALE_JEV_RESULT_DROPPED)
      expect(drops[0]?.artifactId).toBe(artifact?.artifactId)

      // #25.8 / #436 section 4: a stale result can never create a SkillCommitment.
      expect(skillCommitmentHandoff(result, { decisionEpoch: 482, optionInstanceId: 'option:test:1' })).toBeNull()
    })
  }

  test('a stale result is not written to the cache', async () => {
    let identityRef: ReturnType<typeof fixture>['identity'] | null = null
    const provider = mutatingProvider({
      answers: { pi_action_v3: choiceAnswer('kill:e183') },
      mutate: () => identityRef?.advanceEpoch(),
    })
    const { MemoryHarnessCache } = await import('../cache.ts')
    const cache = new MemoryHarnessCache()
    const f = fixture({ provider, cache })
    identityRef = f.identity
    const result = await f.harness.choose(piRequestFor())
    expect(result.ok).toBe(false)
    expect(cache.size()).toBe(0)
  })

  test('a stale completion for beta never appears as a calibrated probability', async () => {
    let identityRef: ReturnType<typeof fixture>['identity'] | null = null
    const provider = mutatingProvider({
      answers: { beta_terminate_v2: booleanAnswer(0.25) },
      mutate: () => identityRef?.advanceEpoch(),
    })
    const f = fixture({ provider })
    identityRef = f.identity
    const result = await f.harness.shouldTerminate(betaRequest())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('stale')
  })
})

describe('#438 section 8 - transport retry is not policy retry', () => {
  test('a retryable transport failure is retried while the request is current and recorded', async () => {
    const provider = flakyProvider({
      failures: 2,
      kind: 'provider_unavailable',
      answers: { pi_action_v3: choiceAnswer('kill:e183') },
    })
    const f = fixture({ provider, transport: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => undefined } })
    const result = await f.harness.choose(piRequestFor())
    expect(result.ok).toBe(true)
    expect(provider.calls).toBe(3)
    const artifact = f.sink.artifacts()[0]
    expect(artifact?.transport.attempts).toBe(3)
    expect(artifact?.transport.finalAttemptCount).toBe(3)
    expect(artifact?.transport.failures.length).toBe(2)
    expect(artifact?.transport.retryReason).toContain('retry 2/3')
  })

  test('a retry stops when the causal identity moved (stale instead of reuse)', async () => {
    let identityRef: ReturnType<typeof fixture>['identity'] | null = null
    const provider = flakyProvider({
      failures: 5,
      kind: 'provider_unavailable',
      answers: { pi_action_v3: choiceAnswer('kill:e183') },
      onFailure: () => identityRef?.advanceEpoch(),
    })
    const f = fixture({ provider, transport: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => undefined } })
    identityRef = f.identity
    const result = await f.harness.choose(piRequestFor())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('stale')
    expect(provider.calls).toBe(1)
    expect(f.sink.artifacts()[0]?.transport.retryReason).toBe('stale_before_retry')
    expect(f.sink.staleDrops().length).toBe(1)
  })

  test('a decodable but inconvenient answer is NEVER retried (no policy retry)', async () => {
    // The chosen candidate has the LOWEST probability: a policy retry would ask
    // again. The harness must not.
    const provider = scriptedProvider({
      kind: 'answer',
      answers: { pi_action_v3: choiceAnswer('kill:e183', { 'kill:e183': 0.05, 'walk:portal-entry-1': 0.95 }) },
    })
    const f = fixture({ provider, transport: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => undefined } })
    const result = await f.harness.choose(piRequestFor())
    expect(result.ok).toBe(true)
    expect(provider.dispatches.length).toBe(1)
    expect(f.sink.artifacts()[0]?.transport.attempts).toBe(1)
  })

  test('bounding: transport failures exhaust into a typed failure, never a default answer', async () => {
    const provider = flakyProvider({ failures: 99, kind: 'timeout', answers: {} })
    const f = fixture({ provider, transport: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => undefined } })
    const result = await f.harness.shouldTerminate(betaRequest({ identity: baseIdentity() }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('timeout')
    expect(provider.calls).toBe(2)
  })
})
