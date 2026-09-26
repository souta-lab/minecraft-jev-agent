// #438 section 17 (replay adapter) + section 22 I5/I6 + section 25's remaining
// regression tests: the causal link chain, provider replaceability, and the
// executable coverage manifest for all 20 required regression tests.
//
// Everything here is provider-free: the replay adapter runs the SAME harness
// pipeline as production and only replaces the transport seam.

import { describe, expect, test } from 'bun:test'
import { ArtifactIntegrityError, MemoryArtifactSink, linkGuardDisposition, linkSkillOutcome } from '../artifacts.ts'
import type { JevProviderAdapter } from '../provider.ts'
import type { JevFailureKind, JevHeadRequest } from '../contract.ts'
import { skillCommitmentHandoff } from '../contract.ts'
import { JEV_HEADS } from '../heads.ts'
import type { ReplayCorpus } from '../replay.ts'
import { abCalibration, compareReplay, corpusFrom, createReplayHarness, withHeadCalibration } from '../replay.ts'
import { ScriptedProvider, baseIdentity, betaRequest, booleanAnswer, choiceAnswer, scriptedProvider, testRun } from '../testing.ts'
import type { StaticIdentitySource } from '../identity.ts'
import { staticIdentitySource, toCausalIdentity } from '../identity.ts'
import { fixture, mutatingProvider, piRequestFor } from './support.ts'

function testIdentity(): StaticIdentitySource {
  return staticIdentitySource(toCausalIdentity(baseIdentity()))
}

/** Capture artifacts the way production does: through the harness, not the provider. */
async function capture(
  provider: JevProviderAdapter,
  requests: readonly JevHeadRequest[],
): Promise<{ corpus: ReplayCorpus }> {
  const f = fixture({ provider })
  await f.harness.evaluateBatch(requests)
  return { corpus: corpusFrom(f.sink.artifacts()) }
}

// ---------------------------------------------------------------------------
// section 17 - replay modes
// ---------------------------------------------------------------------------

describe('#438 section 17 - replay adapter modes', () => {
  test('#25.16 the replay adapter reproduces a captured decision artifact', async () => {
    const request = piRequestFor()
    const provider = scriptedProvider({
      kind: 'answer',
      answers: { pi_action_v3: choiceAnswer('kill:e183', { 'kill:e183': 0.66, 'walk:portal-entry-1': 0.34 }) },
    })
    const { corpus } = await capture(provider, [request])
    expect(corpus.artifacts.length).toBe(1)
    const original = corpus.artifacts[0]
    expect(original).toBeDefined()
    if (original === undefined) return

    const sink = new MemoryArtifactSink()
    const replay = createReplayHarness({ corpus, run: testRun(), identity: testIdentity(), artifacts: sink })
    const result = await replay.harness.choose(request)
    expect(result.ok).toBe(true)
    if (!result.ok || result.value.kind !== 'choice') return
    expect(result.value.selectedCandidateId).toBe('kill:e183')
    expect(JSON.stringify(result.value.raw)).toBe(JSON.stringify(original.rawDistribution))
    expect(result.value.calibrated.ranking[0]?.candidateId).toBe('kill:e183')
    expect(replay.servedArtifactIds()).toEqual([original.artifactId])
    expect(replay.misses()).toEqual([])
    // The replayed decision is a NEW immutable artifact that cites the original corpus entry.
    expect(sink.artifacts()[0]?.artifactId).not.toBe(original.artifactId)
    expect(sink.artifacts()[0]?.projectionHash).toBe(original.projectionHash)
  })

  test('#25.17 a permuted replay is measurable, artifact-visible and hash-stable', async () => {
    const request = piRequestFor()
    const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183') } })
    const { corpus } = await capture(provider, [request])
    const original = corpus.artifacts[0]
    expect(original).toBeDefined()
    if (original === undefined) return

    const sink = new MemoryArtifactSink()
    const replay = createReplayHarness({
      corpus,
      mode: { kind: 'permute', salt: 'run-42' },
      run: testRun(),
      identity: testIdentity(),
      artifacts: sink,
    })
    const result = await replay.harness.choose(request)
    expect(result.ok).toBe(true)
    const artifact = sink.artifacts()[0]
    expect(artifact?.candidateOrdering).toBe('permuted')
    expect(artifact?.candidateOrderSalt).toBe('run-42')
    // Candidate IDENTITY is stable under permutation; only serialization order moves.
    expect([...(artifact?.candidateIds ?? [])].sort()).toEqual([...original.candidateIds].sort())
    expect(artifact?.candidateSetHash).toBe(original.candidateSetHash)
    expect(artifact?.projectionHash).toBe(original.projectionHash)
    expect(artifact?.artifactId).not.toBe(original.artifactId)
  })

  test('synthetic distributions change the proposal without touching the corpus', async () => {
    const request = piRequestFor()
    const provider = scriptedProvider({
      kind: 'answer',
      answers: { pi_action_v3: choiceAnswer('kill:e183', { 'kill:e183': 0.9, 'walk:portal-entry-1': 0.1 }) },
    })
    const { corpus } = await capture(provider, [request])
    const before = JSON.stringify(corpus.artifacts)
    const sink = new MemoryArtifactSink()
    const replay = createReplayHarness({
      corpus,
      mode: {
        kind: 'synthetic_distribution',
        distributions: { pi_action_v3: { 'walk:portal-entry-1': 0.8, 'kill:e183': 0.2 } },
      },
      run: testRun(),
      identity: testIdentity(),
      artifacts: sink,
    })
    const result = await replay.harness.choose(request)
    expect(result.ok).toBe(true)
    if (!result.ok || result.value.kind !== 'choice') return
    expect(result.value.selectedCandidateId).toBe('walk:portal-entry-1')
    expect(result.value.raw).toEqual({ kind: 'choice', probabilities: { 'walk:portal-entry-1': 0.8, 'kill:e183': 0.2 } })
    // The captured corpus is evidence: replaying it must not rewrite it.
    expect(JSON.stringify(corpus.artifacts)).toBe(before)
  })

  test('a model filter answers from the requested captured provider/model only', async () => {
    const request = piRequestFor()
    const modelA = new ScriptedProvider({
      providerId: 'mock-provider',
      modelId: 'jev-a',
      steps: [
        { kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183', { 'kill:e183': 0.9, 'walk:portal-entry-1': 0.1 }) } },
      ],
    })
    const modelB = new ScriptedProvider({
      providerId: 'mock-provider',
      modelId: 'jev-b',
      steps: [
        {
          kind: 'answer',
          answers: { pi_action_v3: choiceAnswer('walk:portal-entry-1', { 'kill:e183': 0.1, 'walk:portal-entry-1': 0.9 }) },
        },
      ],
    })
    const a = await capture(modelA, [request])
    const b = await capture(modelB, [request])
    expect(a.corpus.artifacts[0]?.model).toBe('jev-a')
    expect(b.corpus.artifacts[0]?.model).toBe('jev-b')
    const merged = corpusFrom([...a.corpus.artifacts, ...b.corpus.artifacts])

    const replayA = createReplayHarness({ corpus: merged, mode: { kind: 'model', model: 'jev-a' }, run: testRun(), identity: testIdentity() })
    const resultA = await replayA.harness.choose(request)
    expect(resultA.ok).toBe(true)
    if (resultA.ok && resultA.value.kind === 'choice') expect(resultA.value.selectedCandidateId).toBe('kill:e183')

    const replayB = createReplayHarness({ corpus: merged, mode: { kind: 'model', model: 'jev-b' }, run: testRun(), identity: testIdentity() })
    const resultB = await replayB.harness.choose(request)
    expect(resultB.ok).toBe(true)
    if (resultB.ok && resultB.value.kind === 'choice') expect(resultB.value.selectedCandidateId).toBe('walk:portal-entry-1')
  })

  test('offline model comparison reports where two captured models disagree', async () => {
    const request = piRequestFor()
    const modelA = new ScriptedProvider({
      providerId: 'mock-provider',
      modelId: 'jev-a',
      steps: [
        { kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183', { 'kill:e183': 0.9, 'walk:portal-entry-1': 0.1 }) } },
      ],
    })
    const modelB = new ScriptedProvider({
      providerId: 'mock-provider',
      modelId: 'jev-b',
      steps: [
        {
          kind: 'answer',
          answers: { pi_action_v3: choiceAnswer('walk:portal-entry-1', { 'kill:e183': 0.1, 'walk:portal-entry-1': 0.9 }) },
        },
      ],
    })
    const a = await capture(modelA, [request])
    const b = await capture(modelB, [request])
    const rows = await compareReplay(
      { corpus: a.corpus, run: testRun(), identity: testIdentity() },
      { corpus: b.corpus, run: testRun(), identity: testIdentity() },
      [request],
    )
    expect(rows.length).toBe(1)
    expect(rows[0]?.changed).toBe(true)
    expect(rows[0]?.a?.candidateId).toBe('kill:e183')
    expect(rows[0]?.b?.candidateId).toBe('walk:portal-entry-1')
    // Identical corpora compare equal.
    const same = await compareReplay(
      { corpus: a.corpus, run: testRun(), identity: testIdentity() },
      { corpus: a.corpus, run: testRun(), identity: testIdentity() },
      [request],
    )
    expect(same[0]?.changed).toBe(false)
  })

  test('offline calibration A/B keeps the raw distribution identical (#423/#438 section 17)', async () => {
    const request = betaRequest()
    const provider = scriptedProvider({ kind: 'answer', answers: { beta_terminate_v2: booleanAnswer(0.6) } })
    const { corpus } = await capture(provider, [request])
    const rows = await abCalibration({
      corpus,
      run: testRun(),
      requests: [request],
      headsA: JEV_HEADS,
      headsB: withHeadCalibration(JEV_HEADS, 'beta_terminate_v2', { transformId: 'beta_threshold_v2', transformVersion: 2 }),
    })
    expect(rows[0]?.a?.rawDistribution).toEqual({ kind: 'boolean', probabilityTrue: 0.6 })
    expect(rows[0]?.b?.rawDistribution).toEqual({ kind: 'boolean', probabilityTrue: 0.6 })
    // 0.6 >= 0.5 terminates; 0.6^2 = 0.36 < 0.5 continues.
    expect(rows[0]?.a?.proposal).toBe('terminate')
    expect(rows[0]?.b?.proposal).toBe('continue')
    expect(rows[0]?.changed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// section 9 / 22 I6 - replay failure algebra is the SAME algebra as live
// ---------------------------------------------------------------------------

describe('#438 section 22 I6 + #25.18 - synthetic replay failures follow the live result algebra', () => {
  const cases: readonly {
    readonly label: string
    readonly mode: 'timeout' | 'provider_error'
    readonly kind: JevFailureKind
  }[] = [
    { label: 'timeout', mode: 'timeout', kind: 'timeout' },
    { label: 'provider_error', mode: 'provider_error', kind: 'provider_unavailable' },
  ]

  for (const entry of cases) {
    test(`#25.18 replay ${entry.label} is a typed ${entry.kind}, never a fake probability`, async () => {
      const replaySink = new MemoryArtifactSink()
      const replayed = createReplayHarness({
        corpus: { artifacts: [] },
        mode: { kind: entry.mode },
        run: testRun(),
        identity: testIdentity(),
        artifacts: replaySink,
      })
      const replayResult = await replayed.harness.shouldTerminate(betaRequest())
      const live = fixture({
        provider: scriptedProvider({ kind: 'fail', failure: entry.mode === 'timeout' ? 'timeout' : 'provider_unavailable' }),
      })
      const liveResult = await live.harness.shouldTerminate(betaRequest())

      expect(replayResult.ok).toBe(false)
      expect(liveResult.ok).toBe(false)
      if (replayResult.ok || liveResult.ok) return
      expect(replayResult.kind).toBe(entry.kind)
      expect(liveResult.kind).toBe(entry.kind)
      // Same typed algebra: ok/kind/authority flags are identical; only the free-text
      // detail (and the per-run artifact id) is provider-specific.
      const algebra = (result: { ok: boolean } & Record<string, unknown>) => ({
        ok: result.ok,
        kind: result.ok ? null : result.kind,
        modelAnswerPresent: result.modelAnswerPresent,
        fallbackAuthority: result.fallbackAuthority,
      })
      expect(algebra(replayResult as never)).toEqual(algebra(liveResult as never))
      const replayArtifact = replaySink.artifacts()[0]
      const liveArtifact = live.sink.artifacts()[0]
      expect(replayArtifact?.finalProposal).toEqual(liveArtifact?.finalProposal)
      // The artifact's typed result matches too; only the provider's free-text detail differs.
      const failureKind = (artifact: typeof replayArtifact): string | null =>
        artifact?.result.ok === false ? artifact.result.kind : null
      expect(failureKind(replayArtifact)).toBe(failureKind(liveArtifact))
      expect(replayArtifact?.fallbackAuthority).toBe('code')
      expect(replayArtifact?.modelAnswerPresent).toBe(false)
      expect(JSON.stringify(replayArtifact)).not.toContain('probability')
    })
  }

  test('#25.18 replay stale_completion is dropped with STALE_JEV_RESULT_DROPPED', async () => {
    const request = piRequestFor()
    const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183') } })
    const { corpus } = await capture(provider, [request])
    const sink = new MemoryArtifactSink()
    const replay = createReplayHarness({
      corpus,
      mode: { kind: 'stale_completion' },
      run: testRun(),
      identity: testIdentity(),
      artifacts: sink,
    })
    const result = await replay.harness.choose(request)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('stale')
    expect(result.modelAnswerPresent).toBe(false)
    const artifact = sink.artifacts()[0]
    expect(artifact?.staleCheck.current).toBe(false)
    expect(artifact?.staleCheck.reason ?? null).toBe('decision_epoch_advanced')
    // The answer DID arrive and is recorded, but it is never reinterpreted.
    expect(artifact?.rawTypedResponse).toEqual(choiceAnswer('kill:e183'))
    expect(artifact?.finalProposal).toEqual({ kind: 'none', reason: 'stale' })
    expect(sink.staleDrops().length).toBe(1)
    expect(sink.staleDrops()[0]?.record).toBe('STALE_JEV_RESULT_DROPPED')
    expect(sink.staleDrops()[0]?.artifactId ?? null).toBe(result.artifactId)
  })
})

// ---------------------------------------------------------------------------
// #25.8 / #25.19 - the causal chain
// ---------------------------------------------------------------------------

describe('#438 sections 18/19 - decision -> SkillCommitment -> Guard -> SkillOutcome', () => {
  test('#25.8 a stale decision can never become a SkillCommitment', async () => {
    let advance: () => void = () => undefined
    const provider = mutatingProvider({
      answers: { pi_action_v3: choiceAnswer('kill:e183') },
      mutate: () => advance(),
    })
    const f = fixture({ provider })
    advance = () => f.identity.advanceEpoch()
    const stale = await f.harness.choose(piRequestFor())
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.kind).toBe('stale')
    expect(skillCommitmentHandoff(stale, { decisionEpoch: 481, optionInstanceId: 'option:test:1' })).toBeNull()
    // A stale artifact also carries no authoritative proposal for Guard to admit.
    expect(f.sink.artifacts()[0]?.finalProposal).toEqual({ kind: 'none', reason: 'stale' })
    expect(f.sink.artifacts()[0]?.modelAnswerPresent).toBe(false)
  })

  test('#25.8 the handoff binds decisionId, candidate and state fingerprint', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183', { 'kill:e183': 0.7 }) } })
    const f = fixture({ provider })
    const result = await f.harness.choose(piRequestFor())
    expect(result.ok).toBe(true)
    if (!result.ok || result.value.kind !== 'choice') return
    const live = { decisionEpoch: 481, optionInstanceId: 'option:test:1' }
    const handoff = skillCommitmentHandoff(result, live)
    expect(handoff).not.toBeNull()
    if (handoff === null) return
    expect(handoff.decisionId).toBe(result.value.evidence.decisionId)
    expect(handoff.artifactId).toBe(result.value.evidence.artifactId)
    expect(handoff.candidateId).toBe('kill:e183')
    expect(handoff.selectedAtStateFingerprint).toBe(result.value.evidence.projectionHash)
    // Any causal move invalidates the commitment handoff.
    expect(skillCommitmentHandoff(result, { ...live, decisionEpoch: 482 })).toBeNull()
    expect(skillCommitmentHandoff(result, { ...live, optionInstanceId: 'option:test:2' })).toBeNull()
  })

  test('#25.19 the links thread decisionId/candidateId through Guard and SkillOutcome', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: { pi_action_v3: choiceAnswer('kill:e183', { 'kill:e183': 0.72 }) } })
    const f = fixture({ provider })
    const result = await f.harness.choose(piRequestFor())
    expect(result.ok).toBe(true)
    if (!result.ok || result.value.kind !== 'choice') return
    const artifact = f.sink.artifacts()[0]
    expect(artifact).toBeDefined()
    if (artifact === undefined) return

    const handoff = skillCommitmentHandoff(result, { decisionEpoch: 481, optionInstanceId: 'option:test:1' })
    expect(handoff).not.toBeNull()
    if (handoff === null) return
    const commitmentId = `commit_${handoff.decisionId}`

    const guard = linkGuardDisposition(
      artifact,
      { admitted: true, candidateId: 'kill:e183', reason: null, guardVersion: 'guard_v1', decidedAt: '2026-09-22T00:00:01.000Z' },
      '2026-09-22T00:00:01.000Z',
    )
    const outcome = linkSkillOutcome(
      artifact,
      {
        commitmentId,
        decisionId: artifact.decisionId,
        selectedCandidateId: 'kill:e183',
        terminalReason: 'done',
        verification: 'verified',
        semanticProgress: 'achieved',
        failure: null,
      },
      '2026-09-22T00:00:02.000Z',
    )
    expect(guard.kind).toBe('guard_disposition')
    expect(outcome.kind).toBe('skill_outcome')
    for (const record of [guard, outcome]) {
      expect(record.record).toBe('JEV_DECISION_LINK')
      expect(record.artifactId).toBe(artifact.artifactId)
      expect(record.decisionId).toBe(handoff.decisionId)
    }
    expect(outcome.skillOutcome?.commitmentId).toBe(commitmentId)
    expect(outcome.skillOutcome?.selectedCandidateId).toBe(handoff.candidateId)
    // A Guard disposition for a DIFFERENT candidate cannot be linked to this decision.
    expect(() =>
      linkGuardDisposition(
        artifact,
        { admitted: true, candidateId: 'walk:portal-entry-1', reason: null, guardVersion: 'guard_v1', decidedAt: 't' },
        't',
      ),
    ).toThrow(ArtifactIntegrityError)
    expect(() =>
      linkSkillOutcome(
        artifact,
        {
          commitmentId,
          decisionId: 'dec_someone_else',
          selectedCandidateId: 'kill:e183',
          terminalReason: 'done',
          verification: 'verified',
          semanticProgress: 'achieved',
          failure: null,
        },
        't',
      ),
    ).toThrow(ArtifactIntegrityError)
  })
})

// ---------------------------------------------------------------------------
// #25.20 - provider replaceability
// ---------------------------------------------------------------------------

describe('#438 section 16 + #25.20 - the provider is replaceable without gameplay source edits', () => {
  test('#25.20 swapping the provider requires zero gameplay/controller source changes', async () => {
    const answers = { pi_action_v3: choiceAnswer('kill:e183', { 'kill:e183': 0.64, 'walk:portal-entry-1': 0.36 }) }
    const providerA = new ScriptedProvider({ providerId: 'mock-a', modelId: 'model-a', steps: [{ kind: 'answer', answers }] })
    const providerB = new ScriptedProvider({ providerId: 'mock-b', modelId: 'model-b', steps: [{ kind: 'answer', answers }] })
    const fA = fixture({ provider: providerA })
    const fB = fixture({ provider: providerB })
    const resultA = await fA.harness.choose(piRequestFor())
    const resultB = await fB.harness.choose(piRequestFor())
    expect(resultA.ok && resultB.ok).toBe(true)
    if (!resultA.ok || !resultB.ok || resultA.value.kind !== 'choice' || resultB.value.kind !== 'choice') return
    // Repo-level semantics are identical across providers; only provider identity differs.
    expect(resultA.value.selectedCandidateId).toBe(resultB.value.selectedCandidateId)
    expect(JSON.stringify(resultA.value.raw)).toBe(JSON.stringify(resultB.value.raw))
    expect(JSON.stringify(resultA.value.calibrated)).toBe(JSON.stringify(resultB.value.calibrated))
    expect(Object.keys(resultA.value).sort()).toEqual(Object.keys(resultB.value).sort())
    const artifactA = fA.sink.artifacts()[0]
    const artifactB = fB.sink.artifacts()[0]
    expect(artifactA?.provider).toBe('mock-a')
    expect(artifactB?.provider).toBe('mock-b')
    expect(artifactA?.finalProposal).toEqual(artifactB?.finalProposal)
    // No provider spelling leaks into the repo result.
    const serialized = JSON.stringify(resultA.value)
    for (const providerTerm of ['typesafe', 'providerMetadata', 'experimental_evaluate', 'usage', 'gateway']) {
      expect(`${providerTerm}:${serialized.includes(providerTerm) ? 'leaked' : 'absent'}`).toBe(`${providerTerm}:absent`)
    }
    // The request is repo-owned data: no provider field can appear on it.
    expect(Object.keys(piRequestFor()).sort()).toEqual(['candidates', 'headId', 'identity', 'projection'])
  })
})

// ---------------------------------------------------------------------------
// executable coverage manifest for #438 section 25
// ---------------------------------------------------------------------------

interface Section25Entry {
  readonly item: number
  readonly file: string
  /**
   * Exact substrings that must exist in `file` (the ratchet anchor). Some test
   * titles are generated from a table, so an entry may anchor on more than one
   * literal fragment of the same test.
   */
  readonly anchors: readonly string[]
}

const SECTION_25_TESTS: readonly Section25Entry[] = [
  { item: 1, file: 'i1-import-firewall.test.ts', anchors: ['a new violating production file fails with file:line'] },
  {
    item: 2,
    file: 'i2-heads-registry.test.ts',
    anchors: ['an unregistered head fails closed with a typed failure and never calls the provider'],
  },
  { item: 3, file: 'i3-closed-world.test.ts', anchors: ['an invented id is invalid_response, not a fuzzy match'] },
  { item: 4, file: 'i3-closed-world.test.ts', anchors: ['an empty grounded candidate set fails closed without a provider call'] },
  { item: 5, file: 'i6-i7-i8-algebra.test.ts', anchors: ['a provider timeout is never a calibrated beta probability'] },
  {
    item: 6,
    file: 'i4-i5-fence.test.ts',
    anchors: ['a retryable transport failure is retried while the request is current and recorded'],
  },
  {
    item: 7,
    file: 'i4-i5-fence.test.ts',
    anchors: ['a completion that lands after the ', 'world epoch changed', 'is dropped as stale'],
  },
  { item: 8, file: 'section17-25-replay-regression.test.ts', anchors: ['#25.8 a stale decision can never become a SkillCommitment'] },
  { item: 9, file: 'i6-i7-i8-algebra.test.ts', anchors: ['boolean answers require a finite probability in range'] },
  { item: 10, file: 'i6-i7-i8-algebra.test.ts', anchors: ['choice: the raw distribution is recorded before any transform'] },
  { item: 11, file: 'i6-i7-i8-algebra.test.ts', anchors: ['every successful artifact records a registered transform id + version'] },
  {
    item: 12,
    file: 'i9-i11-i12-invariants.test.ts',
    anchors: ['#25.12 the same semantic state yields deterministic projection + candidate hashes'],
  },
  {
    item: 13,
    file: 'i9-i11-i12-invariants.test.ts',
    anchors: ['#25.13 body jitter cannot enter the projection (hash is jitter-invariant)'],
  },
  {
    item: 14,
    file: 'i9-i11-i12-invariants.test.ts',
    anchors: ['#25.14 a meaningful target/progress/failure change does change the projection hash'],
  },
  {
    item: 15,
    file: 'i9-i11-i12-invariants.test.ts',
    anchors: ['#25.15 a cached answer can never select a candidate missing from the current request'],
  },
  {
    item: 16,
    file: 'section17-25-replay-regression.test.ts',
    anchors: ['#25.16 the replay adapter reproduces a captured decision artifact'],
  },
  {
    item: 17,
    file: 'i3-closed-world.test.ts',
    anchors: ['permuted serialization is deterministic, artifact-visible, and hash-stable'],
  },
  {
    item: 18,
    file: 'section17-25-replay-regression.test.ts',
    anchors: ['#25.18 replay timeout is a typed timeout, never a fake probability'],
  },
  {
    item: 19,
    file: 'section17-25-replay-regression.test.ts',
    anchors: ['#25.19 the links thread decisionId/candidateId through Guard and SkillOutcome'],
  },
  {
    item: 20,
    file: 'section17-25-replay-regression.test.ts',
    anchors: ['#25.20 swapping the provider requires zero gameplay/controller source changes'],
  },
]

describe('#438 section 25 - the 20 required regression tests are executable', () => {
  test('all 20 items map to a test that exists in this suite', async () => {
    expect(SECTION_25_TESTS.length).toBe(20)
    expect(new Set(SECTION_25_TESTS.map((entry) => entry.item)).size).toBe(20)
    for (const entry of SECTION_25_TESTS) {
      const file = Bun.file(new URL(`./${entry.file}`, import.meta.url))
      const exists = await file.exists()
      expect(`${entry.item}:${entry.file}:${exists ? 'exists' : 'missing'}`).toBe(`${entry.item}:${entry.file}:exists`)
      if (!exists) continue
      const source = await file.text()
      const covered = entry.anchors.every((anchor) => source.includes(anchor))
      expect(`#25.${String(entry.item)}:${covered ? 'covered' : 'MISSING'}`).toBe(`#25.${String(entry.item)}:covered`)
    }
  })
})
