// I9 + I11 + I12 + #438 sections 5/15/18 - cache semantics, replayable
// artifacts, and "unknown is not false".
//
// These are the invariants that make the harness's evidence chain trustworthy:
// a cache key that covers the model-visible state, an artifact stream that can be
// replayed without the provider, and an epistemic vocabulary that cannot
// silently become `false`/`0`/`[]`.

import { describe, expect, test } from 'bun:test'
import { decisionArtifactId, parseHarnessJsonl } from '../artifacts.ts'
import type { HarnessCache, HarnessCacheEntry, JevCacheKeyMaterial } from '../cache.ts'
import { CACHE_KEY_VERSION, jevCacheKey, MemoryHarnessCache } from '../cache.ts'
import { known, notObserved, requireKnown, sensorError, UNKNOWN, UnknownFactError, epistemicToJson } from '../contract.ts'
import { corpusFrom, createReplayHarness } from '../replay.ts'
import {
  baseIdentity,
  betaRequest,
  candidate,
  choiceAnswer,
  scoreAnswer,
  scriptedProvider,
  testRun,
} from '../testing.ts'
import { assertCandidateSet, booleanFact, candidateSetHash, serializeCandidate } from '../candidates.ts'
import {
  AUTHORITY_STATE_PROJECTION,
  PROJECTION_SCHEMAS,
  ProjectionSchemaError,
  UndeclaredProjectionFieldError,
  buildProjection,
  declaredProjectionFields,
  lookupProjectionSchema,
} from '../semanticProjection.ts'
import { JEV_HEADS } from '../heads.ts'
import { projectionHash } from '../canonical.ts'
import { scoreRequest } from '../testing.ts'
import { fixture, piRequestFor } from './support.ts'

// ---------------------------------------------------------------------------
// I9 - the cache key covers every model-visible semantic input (#438 section 15)
// ---------------------------------------------------------------------------

const CACHE_MATERIAL: JevCacheKeyMaterial = {
  headId: 'pi_action_v3',
  headVersion: 3,
  primitive: 'choice',
  projectionId: AUTHORITY_STATE_PROJECTION,
  projectionVersion: 1,
  projectionHash: 'ph-1',
  candidateSetHash: 'ch-1',
  provider: 'typesafe',
  model: 'typesafe-ai/jev',
  calibrationTransformId: 'choice_distribution_v1',
  calibrationTransformVersion: 1,
  thresholdParameterId: null,
  thresholdParameterVersion: null,
  worldKey: 'server|overworld',
  worldEpoch: 3,
  optionInstanceId: 'option:test:1',
}

describe('#438 section 22 I9 - the cache key covers model-visible projection + candidate set', () => {
  test('identical semantic material yields the same versioned key', () => {
    expect(jevCacheKey(CACHE_MATERIAL)).toBe(jevCacheKey({ ...CACHE_MATERIAL }))
    expect(jevCacheKey(CACHE_MATERIAL).startsWith(`jev:${CACHE_KEY_VERSION}:`)).toBe(true)
  })

  test('every model-visible input changes the key', () => {
    const base = jevCacheKey(CACHE_MATERIAL)
    const mutations: Readonly<Record<string, Partial<typeof CACHE_MATERIAL>>> = {
      projectionHash: { projectionHash: 'ph-2' },
      candidateSetHash: { candidateSetHash: 'ch-2' },
      headVersion: { headVersion: 4 },
      provider: { provider: 'vercel-gateway' },
      model: { model: 'typesafe-ai/jev-next' },
      projectionVersion: { projectionVersion: 2 },
      calibrationTransformVersion: { calibrationTransformVersion: 2 },
      thresholdParameterId: { thresholdParameterId: 'beta_abandon_default' },
      worldKey: { worldKey: 'server|nether' },
      worldEpoch: { worldEpoch: 4 },
      optionInstanceId: { optionInstanceId: 'option:test:2' },
    }
    for (const [field, patch] of Object.entries(mutations)) {
      const mutated = jevCacheKey({ ...CACHE_MATERIAL, ...patch })
      expect(`${field}:${mutated === base ? 'collision' : 'distinct'}`).toBe(`${field}:distinct`)
    }
  })

  test('a cache hit is evidence-visible and replays the same captured answer', async () => {
    const cache = new MemoryHarnessCache()
    const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183', { 'kill:e183': 0.7 }) } })
    const f = fixture({ provider, cache })
    const first = await f.harness.choose(piRequestFor())
    const second = await f.harness.choose(piRequestFor())
    expect(provider.dispatches.length).toBe(1)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok || first.value.kind !== 'choice' || second.value.kind !== 'choice') return
    expect(second.value.selectedCandidateId).toBe(first.value.selectedCandidateId)
    expect(second.value.raw).toEqual(first.value.raw)
    // The replay carries the CURRENT decision id/epoch but points at the original artifact.
    expect(second.value.evidence.decisionId).not.toBe(first.value.evidence.decisionId)
    expect(second.value.evidence.cache).toEqual({
      hit: true,
      source: 'cache',
      key: cache.keys()[0] ?? '',
      originalArtifactId: first.artifactId,
      bypassed: null,
    })
    const replayArtifact = f.sink.artifacts()[1]
    expect(replayArtifact?.cache.hit).toBe(true)
    expect(replayArtifact?.cache.originalArtifactId).toBe(first.artifactId)
    expect(replayArtifact?.rawTypedResponse).toEqual(f.sink.artifacts()[0]?.rawTypedResponse ?? null)
  })

  test('the replay limit forces a fresh call and records the bypass', async () => {
    const cache = new MemoryHarnessCache(1)
    const provider = scriptedProvider(
      { kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183') } },
      { kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183') } },
      { kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183') } },
    )
    const f = fixture({ provider, cache })
    await f.harness.choose(piRequestFor())
    await f.harness.choose(piRequestFor())
    await f.harness.choose(piRequestFor())
    expect(provider.dispatches.length).toBe(2)
    expect(f.sink.artifacts()[2]?.cache.bypassed).toBe('replay_limit')
  })

  test('#25.15 a cached answer can never select a candidate missing from the current request', async () => {
    const cache = new MemoryHarnessCache()
    const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183', { 'kill:e183': 0.8 }) } })
    const f = fixture({ provider, cache })
    const first = await f.harness.choose(piRequestFor())
    expect(first.ok).toBe(true)
    const key = cache.keys()[0]
    expect(key).toBeDefined()
    if (key === undefined) return
    const stored = cache.entry(key)
    expect(stored).not.toBeNull()
    if (stored === null) return

    // Serve the SAME cache entry but make its raw answer name a candidate that is
    // not in this request's closed candidate set (as if the candidate registry
    // moved between capture and replay).
    const poisoned: HarnessCacheEntry = { ...stored, rawTypedResponse: choiceAnswer('kill:vanished-entity', { 'kill:vanished-entity': 0.9 }) }
    const crafted: HarnessCache = {
      get: (requested) => (requested === key ? poisoned : null),
      put: () => undefined,
      isReplayExhausted: () => false,
    }
    const g = fixture({ provider, cache: crafted })
    const result = await g.harness.choose(piRequestFor())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('invalid_response')
    expect(result.modelAnswerPresent).toBe(false)
    // The poisoned answer is never replayed into a selection.
    expect(g.sink.artifacts()[0]?.finalProposal).toEqual({ kind: 'none', reason: 'invalid_response' })
    expect(provider.dispatches.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// I11 - every authoritative decision artifact is replayable (#438 section 18)
// ---------------------------------------------------------------------------

describe('#438 section 22 I11 - every authoritative decision artifact is replayable', () => {
  test('an artifact records everything replay needs', async () => {
    const provider = scriptedProvider({
      kind: 'answer',
      answers: {
        pi_action_v3: choiceAnswer('walk:portal-entry-1', { 'walk:portal-entry-1': 0.6, 'kill:e183': 0.4 }),
        beta_terminate_v2: { type: 'boolean', probability: 0.42 },
        danger_v1: scoreAnswer(2, { safe: 0.1, dangerous: 0.9 }),
      },
      confidence: { pi_action_v3: 0.6 },
    })
    const f = fixture({ provider })
    const requests = [piRequestFor(), betaRequest(), scoreRequest()]
    await f.harness.evaluateBatch(requests)
    const artifacts = f.sink.artifacts()
    expect(artifacts.length).toBe(3)
    for (const [index, artifact] of artifacts.entries()) {
      const request = requests[index]
      expect(request).toBeDefined()
      if (request === undefined) continue
      expect(artifact.rawTypedResponse).not.toBeNull()
      expect(artifact.projection).toEqual(request.projection.payload)
      expect(artifact.projectionHash).toBe(projectionHash(request.projection))
      expect(artifact.projectionVersionKey).toBe(`${request.projection.projectionId}@${request.projection.version}`)
      const candidateCount = (request as { candidates?: readonly unknown[] }).candidates?.length ?? 0
      expect(artifact.candidateIds.length).toBe(candidateCount)
      expect(artifact.serializedCandidateIds.length).toBe(artifact.candidateIds.length)
      expect(artifact.headId).toBe(request.headId)
      expect(artifact.headVersion).toBeGreaterThan(0)
      expect(artifact.resultSchema).not.toBeNull()
      expect(artifact.provider).toBe(provider.providerId)
      expect(artifact.model).toBe(provider.modelId)
      expect(artifact.transport.attempts).toBe(1)
      // The batch is one provider request, so each head records the batch's question ids.
      expect(artifact.transport.questionIds).toContain(request.headId)
      expect(artifact.rawDistribution).not.toBeNull()
      expect(artifact.calibration).not.toBeNull()
      expect(artifact.createdAt).toBe('2026-09-22T00:00:00.000Z')
      // Artifact identity is a pure function of the recorded causal identity.
      expect(artifact.artifactId).toBe(
        decisionArtifactId({
          runId: artifact.runId,
          decisionId: artifact.decisionId,
          headId: artifact.headId,
          headVersion: artifact.headVersion,
          decisionEpoch: artifact.decisionEpoch,
          optionInstanceId: artifact.optionInstanceId,
          projectionHash: artifact.projectionHash,
          candidateSetHash: artifact.candidateSetHash,
        }),
      )
    }
  })

  test('the JSONL stream round-trips and the replay adapter reproduces every proposal', async () => {
    const provider = scriptedProvider({
      kind: 'answer',
      answers: {
        pi_action_v3: choiceAnswer('kill:e183', { 'kill:e183': 0.55, 'walk:portal-entry-1': 0.45 }),
        beta_terminate_v2: { type: 'boolean', probability: 0.61 },
      },
    })
    const f = fixture({ provider })
    const requests = [piRequestFor(), betaRequest()]
    await f.harness.evaluateBatch(requests)
    const original = f.sink.artifacts()

    const parsed = parseHarnessJsonl(f.sink.toJsonl())
    expect(parsed.length).toBe(f.sink.all().length)
    const replay = createReplayHarness({
      corpus: corpusFrom(parsed),
      run: testRun(),
      identity: f.identity,
      transport: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => undefined },
    })
    const replayed = await replay.harness.evaluateBatch(requests)
    expect(replay.misses()).toEqual([])
    expect(replay.servedArtifactIds()).toEqual(original.map((artifact) => artifact.artifactId))
    for (const [index, result] of replayed.entries()) {
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      const artifact = original[index]
      expect(artifact).toBeDefined()
      if (artifact === undefined) continue
      expect(result.value.evidence.projectionHash).toBe(artifact.projectionHash)
      expect(artifact.rawDistribution).not.toBeNull()
      expect(JSON.stringify(result.value.raw)).toBe(JSON.stringify(artifact.rawDistribution))
      if (artifact.finalProposal.kind === 'selected' && result.value.kind === 'choice') {
        expect(result.value.selectedCandidateId).toBe(artifact.finalProposal.candidateId)
      }
      if (artifact.finalProposal.kind === 'terminate' && result.value.kind === 'termination') {
        expect(result.value.rawProbabilityTrue).toBe(artifact.finalProposal.probability)
      }
    }
  })

  test('an emitted artifact is immutable (replay cannot rewrite history)', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183') } })
    const f = fixture({ provider })
    await f.harness.choose(piRequestFor())
    const artifact = f.sink.artifacts()[0]
    expect(artifact).toBeDefined()
    if (artifact === undefined) return
    expect(Object.isFrozen(artifact)).toBe(true)
    expect(Object.isFrozen(artifact.transport)).toBe(true)
    expect(() => {
      // @ts-expect-error deliberate mutation of a frozen evidence record
      artifact.finalProposal = { kind: 'none', reason: 'provider_unavailable' }
    }).toThrow()
  })
})

// ---------------------------------------------------------------------------
// I12 - unknown / error is not silently normalized to false/empty (#438 section 6)
// ---------------------------------------------------------------------------

describe('#438 section 22 I12 - unknown/error is never normalized to false/empty', () => {
  test('the epistemic vocabulary keeps its discriminator through serialization', () => {
    expect(UNKNOWN).not.toEqual(known(false))
    expect(epistemicToJson(UNKNOWN)).toEqual({ state: 'unknown' })
    expect(epistemicToJson(notObserved())).toEqual({ state: 'not_observed' })
    expect(epistemicToJson(sensorError('inventory packet dropped'))).toEqual({
      state: 'sensor_error',
      detail: 'inventory packet dropped',
    })
    expect(epistemicToJson(known(false))).toEqual({ state: 'known', value: false })
    expect(() => requireKnown(UNKNOWN, 'portal verified')).toThrow(UnknownFactError)
    expect(() => requireKnown(notObserved(), 'portal verified')).toThrow(UnknownFactError)
    expect(() => requireKnown(sensorError('x'), 'portal verified')).toThrow(UnknownFactError)
    expect(requireKnown(known(false), 'portal verified')).toBe(false)
  })

  test('a projection accepts unknown/not_observed/sensor_error as first-class facts', () => {
    const projection = buildProjection({
      projectionId: AUTHORITY_STATE_PROJECTION,
      fields: {
        target: known('e183'),
        worldFacts: { portal: UNKNOWN, nether: notObserved(), health: sensorError('stale packet') },
        previousOutcome: known(null),
      },
    })
    const payload = projection.payload as Record<string, unknown>
    expect(payload.worldFacts).toEqual({
      portal: { state: 'unknown' },
      nether: { state: 'not_observed' },
      health: { state: 'sensor_error', detail: 'stale packet' },
    })
    // Declared-but-absent fields become explicit unknown, never false/0/[].
    expect(payload.relevantInventory).toEqual({ state: 'unknown' })
    expect(payload.failureMemory).toEqual({ state: 'unknown' })
  })

  test('candidate facts keep unknown/not_observed distinct from boolean false', () => {
    const unknownCandidate = candidate('walk:portal-entry-1', { facts: { portalVerified: { kind: 'unknown' } } })
    const falseCandidate = candidate('walk:portal-entry-1', { facts: { portalVerified: booleanFact(false) } })
    assertCandidateSet([unknownCandidate])
    expect(serializeCandidate(unknownCandidate).facts).not.toEqual(serializeCandidate(falseCandidate).facts)
    expect(unknownCandidate.facts).not.toEqual(falseCandidate.facts)
    expect(candidateSetHash([unknownCandidate])).not.toBe(candidateSetHash([falseCandidate]))
  })

  test('a missing provider distribution is null/empty and never fabricated', async () => {
    const provider = scriptedProvider({
      kind: 'answer',
      answers: { pi_action_v3: choiceAnswer('kill:e183'), danger_v1: scoreAnswer(1) },
    })
    const f = fixture({ provider })
    await f.harness.evaluateBatch([piRequestFor(), scoreRequest()])
    const [choiceArtifact, scoreArtifact] = f.sink.artifacts()
    // Choice: no probabilities map was returned, so no per-candidate probability is invented.
    expect(choiceArtifact?.rawDistribution).toEqual({ kind: 'choice', probabilities: {} })
    // Score: the optional distribution is explicitly null, not `{}` masquerading as measured.
    expect(scoreArtifact?.rawDistribution).toEqual({ kind: 'score', rawScore: 1, probabilities: null })
  })

  test('failures are typed outcomes, never an empty/ok value', async () => {
    const emptyCandidateRequest = piRequestFor({ candidates: [] })
    const provider = scriptedProvider({ kind: 'answer', answers: {} })
    const f = fixture({ provider })
    const empty = await f.harness.choose(emptyCandidateRequest)
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.kind).toBe('empty_candidate_set')
    expect(provider.dispatches.length).toBe(0)
    expect('value' in empty).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// section 5 / #25.12-14 - versioned semantic projection contract
// ---------------------------------------------------------------------------

describe('#438 section 5 - the versioned semantic projection contract', () => {
  test('#25.12 the same semantic state yields deterministic projection + candidate hashes', () => {
    const stateA = buildProjection({
      projectionId: AUTHORITY_STATE_PROJECTION,
      fields: { option: { intent: 'obtain diamonds' }, target: known('e183'), safety: known('safe') },
    })
    // Same semantic state, different member insertion order + explicit undefined
    // members (which canonical serialization drops).
    const stateB = buildProjection({
      projectionId: AUTHORITY_STATE_PROJECTION,
      fields: {
        safety: known('safe'),
        target: known('e183'),
        velocity: undefined,
        option: { intent: 'obtain diamonds' },
      },
    })
    expect(projectionHash(stateA)).toBe(projectionHash(stateB))
    expect(stateA.version).toBe(1)

    const forward = [candidate('a', {}), candidate('b', {}), candidate('c', {})]
    const reversed = [...forward].reverse()
    expect(candidateSetHash(forward)).toBe(candidateSetHash(reversed))
  })

  test('#25.13 body jitter cannot enter the projection (hash is jitter-invariant)', () => {
    for (const jitter of [
      { position: { x: 10.5, y: 64, z: -3.25 } },
      { velocity: { x: 0.1, y: -0.08, z: 0 } },
      { healthFloat: 19.4831 },
      { tick: 918_273 },
      { nearbyEntities: ['e1', 'e2'] },
      { yaw: 91.3 },
    ]) {
      expect(() => buildProjection({ projectionId: AUTHORITY_STATE_PROJECTION, fields: jitter })).toThrow(
        UndeclaredProjectionFieldError,
      )
    }
    // The only accepted jitter shape is "not supplied at all".
    const withUndefinedJitter = buildProjection({
      projectionId: AUTHORITY_STATE_PROJECTION,
      fields: { target: known('e183'), position: undefined },
    })
    const withoutJitter = buildProjection({ projectionId: AUTHORITY_STATE_PROJECTION, fields: { target: known('e183') } })
    expect(projectionHash(withUndefinedJitter)).toBe(projectionHash(withoutJitter))
  })

  test('#25.14 a meaningful target/progress/failure change does change the projection hash', () => {
    const base = buildProjection({
      projectionId: AUTHORITY_STATE_PROJECTION,
      fields: { target: known('e183'), meaningfulProgress: known(['mined 1 diamond']), failureMemory: known([]) },
    })
    const changedTarget = buildProjection({
      projectionId: AUTHORITY_STATE_PROJECTION,
      fields: { target: known('e184'), meaningfulProgress: known(['mined 1 diamond']), failureMemory: known([]) },
    })
    const changedProgress = buildProjection({
      projectionId: AUTHORITY_STATE_PROJECTION,
      fields: { target: known('e183'), meaningfulProgress: known(['mined 2 diamonds']), failureMemory: known([]) },
    })
    const changedFailure = buildProjection({
      projectionId: AUTHORITY_STATE_PROJECTION,
      fields: {
        target: known('e183'),
        meaningfulProgress: known(['mined 1 diamond']),
        failureMemory: known(['walk_to blocked by lava']),
      },
    })
    const hashes = new Set([
      projectionHash(base),
      projectionHash(changedTarget),
      projectionHash(changedProgress),
      projectionHash(changedFailure),
    ])
    expect(hashes.size).toBe(4)
  })

  test('every registered head consumes a declared projection contract', () => {
    for (const head of JEV_HEADS) {
      const schema = lookupProjectionSchema(head.stateProjection)
      expect(schema === null ? `undeclared:${head.id}` : 'declared').toBe('declared')
      expect(schema === null ? [] : schema.fields.length).toBeGreaterThan(0)
      expect(declaredProjectionFields(head.stateProjection).length).toBe(schema?.fields.length ?? -1)
    }
    expect(PROJECTION_SCHEMAS.length).toBeGreaterThanOrEqual(5)
  })

  test('an unregistered projection id is a loud configuration error', () => {
    expect(() => buildProjection({ projectionId: 'made_up_state_v9', fields: {} })).toThrow(ProjectionSchemaError)
    expect(lookupProjectionSchema('made_up_state_v9')).toBeNull()
  })

  test('the harness refuses a projection built at the wrong version of a declared contract', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183') } })
    const f = fixture({ provider })
    const request = piRequestFor({
      projection: { projectionId: AUTHORITY_STATE_PROJECTION, version: 7, payload: { target: known('e183') } },
    })
    const result = await f.harness.choose(request)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('invalid_request')
    expect(provider.dispatches.length).toBe(0)
  })

  test('a projection is bound to its request identity (same state, different epoch → different artifact)', async () => {
    const provider = scriptedProvider(
      { kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183') } },
      { kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183') } },
    )
    const f = fixture({ provider })
    const projection = buildProjection({ projectionId: AUTHORITY_STATE_PROJECTION, fields: { target: known('e183') } })
    const first = await f.harness.choose(piRequestFor({ projection, identity: baseIdentity({ decisionEpoch: 481 }) }))
    f.identity.advanceEpoch()
    const second = await f.harness.choose(piRequestFor({ projection, identity: baseIdentity({ decisionEpoch: 482 }) }))
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.value.evidence.projectionHash).toBe(second.value.evidence.projectionHash)
    expect(first.value.decisionEpoch).toBe(481)
    expect(second.value.decisionEpoch).toBe(482)
    expect(first.artifactId).not.toBe(second.artifactId)
  })
})
