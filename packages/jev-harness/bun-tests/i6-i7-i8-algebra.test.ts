// I6 + I7 + I8 + #438 section 9/10/11/12/13 - the result algebra, raw
// probability preservation, versioned calibration, and confidence/abstention
// semantics.

import { describe, expect, test } from 'bun:test'
import { ArtifactIntegrityError, buildDecisionArtifact, codeFallbackRecord } from '../artifacts.ts'
import { CALIBRATION_TRANSFORMS, DEFAULT_THRESHOLDS, lookupTransform, resolveBetaThreshold } from '../calibration.ts'
import { JEV_HEADS } from '../heads.ts'
import { baseIdentity, booleanAnswer, choiceAnswer, scoreAnswer, scriptedProvider, failingProvider } from '../testing.ts'
import { betaRequest, scoreRequest } from '../testing.ts'
import { fixture, piRequestFor, testRun } from './support.ts'
import { toCausalIdentity } from '../identity.ts'

const RUN = testRun()
const IDENTITY = toCausalIdentity(baseIdentity())

describe('#438 section 22 I6 - no synthetic fallback is labelled as model output', () => {
  test('a provider failure produces a typed failure, never a value', async () => {
    const provider = failingProvider('provider_unavailable')
    const f = fixture({ provider })
    const result = await f.harness.choose(piRequestFor())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.modelAnswerPresent).toBe(false)
    expect(result.fallbackAuthority).toBe('code')
    expect('value' in result).toBe(false)
    const artifact = f.sink.artifacts()[0]
    expect(artifact?.fallbackAuthority).toBe('code')
    expect(artifact?.modelAnswerPresent).toBe(false)
    expect(artifact?.finalProposal).toEqual({ kind: 'none', reason: 'provider_unavailable' })
  })

  test('a provider timeout is never a calibrated beta probability', async () => {
    const provider = failingProvider('timeout')
    const f = fixture({ provider })
    const result = await f.harness.shouldTerminate(betaRequest())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('timeout')
    expect(JSON.stringify(result)).not.toContain('probability')
  })

  test('the artifact builder refuses model-labelled synthetic fallbacks', () => {
    const base = {
      run: RUN,
      createdAt: '2026-09-22T00:00:00.000Z',
      identity: IDENTITY,
      headId: 'pi_action_v3',
      headVersion: 3,
      headStatus: 'production' as const,
      primitive: 'choice' as const,
      resultSchema: 'pi_result_v1',
      projectionId: 'authority_state_v1',
      projectionVersion: 1,
      projectionHash: 'ph',
      projection: {},
      candidateIds: [],
      serializedCandidateIds: [],
      candidateOrdering: 'canonical' as const,
      candidateOrderSalt: null,
      candidateSetHash: 'ch',
      candidates: [],
      provider: null,
      model: null,
      transport: { attempts: 0, failures: [], retryReason: null, finalAttemptCount: 0, latencyMs: 0, timeoutMs: 1, aborted: false, questionIds: [] },
      cache: { hit: false, source: 'provider' as const, key: '', originalArtifactId: null, bypassed: null },
      rawTypedResponse: null,
      rawDistribution: null,
      decoded: null,
      calibration: null,
      finalProposal: { kind: 'none' as const, reason: 'provider_unavailable' as const },
      staleCheck: { checked: true, current: true, reason: null, mismatches: [], bound: IDENTITY, observed: IDENTITY },
      confidence: null,
      commitmentContext: null,
      stage: null,
    }
    expect(() => buildDecisionArtifact({ ...base, fallbackAuthority: 'model', modelAnswerPresent: false, result: { ok: false, kind: 'provider_unavailable', detail: null } })).toThrow(
      ArtifactIntegrityError,
    )
    expect(() =>
      buildDecisionArtifact({ ...base, fallbackAuthority: 'code', modelAnswerPresent: true, result: { ok: false, kind: 'timeout', detail: null } }),
    ).toThrow(ArtifactIntegrityError)
    expect(() =>
      buildDecisionArtifact({
        ...base,
        fallbackAuthority: 'model',
        modelAnswerPresent: true,
        result: { ok: true },
        staleCheck: { checked: true, current: false, reason: 'decision_epoch_advanced', mismatches: [], bound: IDENTITY, observed: IDENTITY },
      }),
    ).toThrow(ArtifactIntegrityError)
  })

  test('an explicit code fallback is separately labelled', () => {
    const record = codeFallbackRecord({
      run: RUN,
      ts: '2026-09-22T00:00:00.000Z',
      headId: 'pi_action_v3',
      decisionEpoch: 481,
      reason: 'documented deterministic WAIT for an explicit deterministic-baseline run',
      proposal: { kind: 'none', reason: 'provider_unavailable' },
    })
    expect(record.record).toBe('JEV_CODE_FALLBACK')
    expect(record.fallbackAuthority).toBe('code')
    expect(record.modelAnswerPresent).toBe(false)
  })
})

describe('#438 section 22 I7 - raw probability/distribution is preserved', () => {
  test('choice: the raw distribution is recorded before any transform', async () => {
    const probabilities = { 'kill:e183': 0.31, 'walk:portal-entry-1': 0.62, 'clear:block-26-68-11': 0.07 }
    const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: choiceAnswer('walk:portal-entry-1', probabilities) } })
    const f = fixture({ provider })
    const result = await f.harness.choose(piRequestFor())
    expect(result.ok).toBe(true)
    const artifact = f.sink.artifacts()[0]
    expect(artifact?.rawDistribution).toEqual({ kind: 'choice', probabilities })
    if (result.ok && result.value.kind === 'choice') {
      expect(result.value.raw).toEqual({ kind: 'choice', probabilities })
      expect(result.value.calibrated.ranking.map((entry) => entry.candidateId)).toEqual([
        'walk:portal-entry-1',
        'kill:e183',
        'clear:block-26-68-11',
      ])
    }
  })

  test('beta: raw P(true) survives a non-identity calibration transform', async () => {
    const heads = JEV_HEADS.map((head) =>
      head.id === 'beta_terminate_v2' ? { ...head, calibration: { transformId: 'beta_threshold_v2', transformVersion: 2 } } : head,
    )
    const provider = scriptedProvider({ kind: 'answer', answers: { beta_terminate_v2: booleanAnswer(0.6) } })
    const f = fixture({ provider, heads, allowExperimentalCalibration: true })
    const result = await f.harness.shouldTerminate(betaRequest())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.rawProbabilityTrue).toBe(0.6)
    expect(result.value.calibratedProbability).toBeCloseTo(0.36, 10)
    const artifact = f.sink.artifacts()[0]
    expect(artifact?.rawDistribution).toEqual({ kind: 'boolean', probabilityTrue: 0.6 })
    expect(artifact?.calibration?.input).toBe(0.6)
    expect(artifact?.calibration?.output).toBeCloseTo(0.36, 10)
    expect(artifact?.calibration?.transformId).toBe('beta_threshold_v2')
  })
})

describe('#438 section 22 I8 - calibration transform is versioned', () => {
  test('every successful artifact records a registered transform id + version', async () => {
    const provider = scriptedProvider({
      kind: 'answer',
      answers: { pi_action_v3: choiceAnswer('kill:e183'), beta_terminate_v2: booleanAnswer(0.4), danger_v1: scoreAnswer(2) },
    })
    const f = fixture({ provider })
    await f.harness.evaluateBatch([piRequestFor(), betaRequest(), scoreRequest()])
    const artifacts = f.sink.artifacts()
    expect(artifacts.length).toBe(3)
    for (const artifact of artifacts) {
      expect(artifact.calibration).not.toBeNull()
      const transform = lookupTransform(artifact.calibration?.transformId ?? '', artifact.calibration?.transformVersion ?? 0)
      expect(transform).not.toBeNull()
    }
  })

  test('the shipped registry never references an experimental transform', () => {
    for (const head of JEV_HEADS) {
      const transform = lookupTransform(head.calibration.transformId, head.calibration.transformVersion)
      expect(transform).not.toBeNull()
      expect(transform?.experimental).toBe(false)
    }
  })

  test('a beta threshold from the Option contract is used and recorded with its source', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: { beta_terminate_v2: booleanAnswer(0.3) } })
    const f = fixture({ provider })
    const request = betaRequest({
      option: {
        optionInstanceId: 'option:test:1',
        templateId: 'template:test',
        intent: 'obtain diamonds',
        preconditions: [],
        successFacts: [],
        abortThreshold: 0.2,
        allowedSkills: [],
      },
    })
    const result = await f.harness.shouldTerminate(request)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.threshold).toBe(0.2)
    expect(result.value.thresholdSource).toBe('option_contract')
    expect(result.value.proposal).toBe('terminate')
    const artifact = f.sink.artifacts()[0]
    expect(artifact?.calibration?.threshold).toBe(0.2)
    expect(artifact?.calibration?.thresholdSource).toBe('option_contract')
  })

  test('an invalid Option threshold falls back to the versioned registry default', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: { beta_terminate_v2: booleanAnswer(0.3) } })
    const f = fixture({ provider })
    const request = betaRequest({
      option: {
        optionInstanceId: 'option:test:1',
        templateId: 'template:test',
        intent: 'x',
        preconditions: [],
        successFacts: [],
        abortThreshold: 2,
        allowedSkills: [],
      },
    })
    const result = await f.harness.shouldTerminate(request)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const registryDefault = DEFAULT_THRESHOLDS['beta_abandon_default']
    expect(registryDefault).toBeDefined()
    if (registryDefault === undefined) return
    expect(result.value.threshold).toBe(registryDefault.value)
    expect(result.value.thresholdSource).toBe('registry_default')
    expect(resolveBetaThreshold(2).source).toBe('registry_default')
  })

  test('calibration transforms are pure numeric mappings (they cannot authorize safety)', () => {
    for (const transform of CALIBRATION_TRANSFORMS) {
      const output = transform.apply(0.5, { threshold: 0.5, scale: { id: 's', version: 1, min: 0, max: 1, levels: ['a', 'b'] } })
      expect(typeof output).toBe('number')
    }
  })
})

describe('#438 section 10/12/13 - strict decoding, confidence metadata, abstention', () => {
  test('boolean answers require a finite probability in range', async () => {
    const cases: readonly unknown[] = [
      {},
      { probability: null },
      { probability: '0.5' },
      { probability: Number.NaN },
      { probability: Number.POSITIVE_INFINITY },
      { probability: -0.1 },
      { probability: 1.1 },
      { value: true },
    ]
    for (const raw of cases) {
      const provider = scriptedProvider({ kind: 'answer', answers: { beta_terminate_v2: raw } })
      const f = fixture({ provider })
      const result = await f.harness.shouldTerminate(betaRequest())
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.kind).toBe('invalid_response')
    }
  })

  test('score answers must be finite and inside the declared scale', async () => {
    for (const raw of [{ score: 4 }, { score: -1 }, { score: Number.NaN }, { score: '2' }, {}]) {
      const provider = scriptedProvider({ kind: 'answer', answers: { danger_v1: raw } })
      const f = fixture({ provider })
      const result = await f.harness.score(scoreRequest())
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.kind).toBe('invalid_response')
    }
  })

  test('a valid score decodes to the declared ordered level', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: { danger_v1: scoreAnswer(2) } })
    const f = fixture({ provider })
    const result = await f.harness.score(scoreRequest())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.level).toBe('dangerous')
    expect(result.value.levelIndex).toBe(2)
    expect(result.value.scale.levels).toEqual(['safe', 'minor risk', 'dangerous', 'lethal'])
  })

  test('provider calibrated confidence is metadata and never bypasses Guard', async () => {
    const provider = scriptedProvider({
      kind: 'answer',
      answers: { pi_action_v3: choiceAnswer('kill:e183') },
      confidence: { pi_action_v3: 0.99 },
    })
    const f = fixture({ provider })
    const result = await f.harness.choose(piRequestFor())
    expect(result.ok).toBe(true)
    if (!result.ok || result.value.kind !== 'choice') return
    expect(result.value.confidence.value).toBe(0.99)
    expect(result.value.confidence.source).toBe('provider_calibrated_confidence')
    expect(result.value.confidence.guardBypass).toBe(false)
    expect(result.value.confidence.meansAbstention).toBe(false)
    expect(JSON.stringify(result.value)).not.toContain('"safe":true')
  })

  test('a missing confidence is null, not a fabricated default', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183') } })
    const f = fixture({ provider })
    const result = await f.harness.choose(piRequestFor())
    expect(result.ok).toBe(true)
    if (!result.ok || result.value.kind !== 'choice') return
    expect(result.value.confidence.value).toBeNull()
    expect(result.value.confidence.source).toBe('none')
  })

  test('abstention is only possible for a head that declares provider abstention', async () => {
    const raw = { type: 'choice', choice: null, abstention: true }
    const strict = fixture({ provider: scriptedProvider({ kind: 'answer', answers: { pi_action_v3: raw } }) })
    const rejected = await strict.harness.choose(piRequestFor())
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.kind).toBe('invalid_response')

    const heads = JEV_HEADS.map((head) => (head.id === 'pi_action_v3' ? { ...head, abstention: 'provider' as const } : head))
    const abstaining = fixture({ provider: scriptedProvider({ kind: 'answer', answers: { pi_action_v3: raw } }), heads })
    const result = await abstaining.harness.choose(piRequestFor())
    expect(result.ok).toBe(true)
    if (!result.ok || result.value.kind !== 'abstain') throw new Error('expected an explicit abstention')
    expect(result.value.reason).toBe('provider_abstained')
    expect(abstaining.sink.artifacts()[0]?.finalProposal).toEqual({ kind: 'abstain', reason: 'provider_abstained' })
  })

  test('low probability is not an abstention', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183', { 'kill:e183': 0.01 }) } })
    const f = fixture({ provider })
    const result = await f.harness.choose(piRequestFor())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.kind).toBe('choice')
  })
})
