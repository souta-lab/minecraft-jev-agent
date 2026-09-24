import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { FatalModelError, ModelRecoveryRequested, assertRecoveryModelAuthority, modelAuthorityIdentityMismatch, modelResponseAuthorityMismatch } from '../jev-agent/src/modelFailure.ts'
import {
  MODEL_RETRY_BASE_DELAY_MS,
  MODEL_RETRY_MAX_DELAY_MS,
  ModelAvailabilityTracker,
  modelFailureDisposition,
  modelRecoveryStartGate,
  modelRetryDelayMs,
  stopGenerationForModelRecovery,
} from './model-recovery.ts'

describe('model authority recovery host policy', () => {
  test('uses bounded exponential backoff', () => {
    expect(modelRetryDelayMs(1)).toBe(5_000)
    expect(modelRetryDelayMs(2)).toBe(10_000)
    expect(modelRetryDelayMs(3)).toBe(20_000)
    expect(modelRetryDelayMs(100)).toBe(MODEL_RETRY_MAX_DELAY_MS)
  })

  test('recovers only retryable Jev failures after controller startup', () => {
    expect(modelFailureDisposition({ context: 'jev-authority', retryable: true }, true)).toBe('recover-generation')
    expect(modelFailureDisposition({ context: 'jev-policy-key', retryable: true }, true)).toBe('terminate-process')
    expect(modelFailureDisposition({ context: 'system2-plan', retryable: true }, true)).toBe('terminate-process')
    expect(modelFailureDisposition({ context: 'jev-authority', retryable: false }, true)).toBe('terminate-process')
    expect(modelFailureDisposition({ context: 'jev-authority', retryable: true }, false)).toBe('terminate-process')
  })

  test('stops the failed generation and returns a fresh-generation recovery signal', () => {
    const outage = new FatalModelError('jev-authority', 4, '503 Service unavailable', true)
    let stopped = false
    const signal = stopGenerationForModelRecovery(outage, 'gen-old', { stop: () => { stopped = true } })
    expect(stopped).toBe(true)
    expect(signal).toBeInstanceOf(ModelRecoveryRequested)
    expect(signal).toMatchObject({ context: 'jev-authority', generationId: 'gen-old' })

    stopped = false
    expect(stopGenerationForModelRecovery(new FatalModelError('system2-plan', 3, 'no response', true), 'gen-old', {
      stop: () => { stopped = true },
    })).toBeNull()
    expect(stopped).toBe(false)
    expect(stopGenerationForModelRecovery(outage, 'gen-old', null)).toBeNull()
  })

  test('records degraded, retrying, and recovered transitions with provenance', () => {
    const tracker = new ModelAvailabilityTracker()
    expect(tracker.snapshot()).toEqual({
      state: 'unknown', consecutiveFailures: 0, retryAt: null, lastFailure: null, recoveredAt: null,
      recoveryAuthority: null, lastRecoveryRejection: null,
    })

    expect(tracker.admitGenerationAuthority({ provider: 'typesafe-ai', model: 'typesafe-ai/jev' })).toMatchObject({
      allowed: true, reason: 'ordinary-generation',
    })
    const first = tracker.recordUnavailable({
      generationId: 'gen-old', context: 'jev-authority', attempts: 4, error: 'GatewayInternalServerError: unavailable',
    }, Date.parse('2026-09-23T00:00:00.000Z'))
    expect(first.attempt).toBe(1)
    expect(first.delayMs).toBe(5_000)
    expect(first.retryAt).toBe('2026-09-23T00:00:05.000Z')
    expect(tracker.snapshot()).toMatchObject({
      state: 'degraded',
      recoveryAuthority: { provider: 'typesafe-ai', model: 'typesafe-ai/jev' },
      lastFailure: { authority: { provider: 'typesafe-ai', model: 'typesafe-ai/jev' } },
    })

    tracker.recordRetryStarted()
    expect(tracker.snapshot().retryAt).toBeNull()
    expect(tracker.recordPolicyResponse(
      { provider: 'typesafe-ai', model: 'typesafe-ai/jev' }, 'jev', Date.parse('2026-09-23T00:00:06.000Z'),
    )).toEqual({ accepted: true, recovered: true, reason: null })
    expect(tracker.snapshot()).toMatchObject({
      state: 'available', consecutiveFailures: 0, retryAt: null,
      recoveredAt: '2026-09-23T00:00:06.000Z',
      lastFailure: { generationId: 'gen-old', context: 'jev-authority', attempts: 4 },
      recoveryAuthority: null,
    })
  })

  test('fault-injected outage recovery requires the pinned Jev identity at candidate start and response', () => {
    const tracker = new ModelAvailabilityTracker()
    const oldAuthority = { provider: 'typesafe-ai', model: 'typesafe-ai/jev' }
    const t0 = Date.parse('2026-09-23T00:00:00.000Z')
    expect(tracker.admitGenerationAuthority(oldAuthority).allowed).toBe(true)
    tracker.recordUnavailable({
      generationId: 'gen-old', context: 'jev-authority', attempts: 3,
      error: 'GatewayInternalServerError: Service temporarily unavailable',
    }, t0)

    tracker.recordRetryStarted()
    const wrongProvider = { provider: 'openai-compatible', model: 'typesafe-ai/jev' }
    const providerAdmission = tracker.admitGenerationAuthority(wrongProvider)
    expect(providerAdmission).toMatchObject({ allowed: false, reason: 'provider-mismatch', expected: oldAuthority })
    const providerRetry = tracker.recordRecoveryRejected('provider-mismatch', wrongProvider, t0 + 5_000)
    expect(providerRetry).toMatchObject({ attempt: 2, delayMs: 10_000, retryAt: '2026-09-23T00:00:15.000Z' })
    expect(modelRecoveryStartGate(tracker.snapshot(), t0 + 5_001)).toMatchObject({ allowed: false, reason: 'retry-backoff' })

    tracker.recordRetryStarted()
    const wrongModel = { provider: 'typesafe-ai', model: 'typesafe-ai/jev-next' }
    const modelAdmission = tracker.admitGenerationAuthority(wrongModel)
    expect(modelAdmission).toMatchObject({ allowed: false, reason: 'model-mismatch' })
    expect(tracker.recordPolicyResponse(wrongModel, 'jev', t0 + 15_001)).toMatchObject({
      accepted: false, recovered: false, reason: 'model-mismatch',
    })
    expect(tracker.snapshot().state).toBe('degraded')

    const noIdentity = tracker.admitGenerationAuthority(null)
    expect(noIdentity).toMatchObject({ allowed: false, reason: 'actual-identity-missing' })

    const sameAuthority = tracker.admitGenerationAuthority(oldAuthority)
    expect(sameAuthority).toMatchObject({ allowed: true, reason: 'same-recovery-authority' })
    expect(tracker.recordPolicyResponse(oldAuthority, 'fallback', t0 + 15_002)).toMatchObject({
      accepted: false, recovered: false, reason: 'response-source-mismatch',
    })
    expect(tracker.snapshot().state).toBe('degraded')
    expect(tracker.recordPolicyResponse(oldAuthority, 'jev', t0 + 15_003)).toEqual({
      accepted: true, recovered: true, reason: null,
    })
    expect(tracker.snapshot()).toMatchObject({ state: 'available', recoveryAuthority: null })
  })

  test('authority validator rejects absent or changed identity and non-Jev response sources', () => {
    const expected = { provider: 'typesafe-ai', model: 'typesafe-ai/jev' }
    expect(modelAuthorityIdentityMismatch(expected, null)).toBe('actual-identity-missing')
    expect(modelAuthorityIdentityMismatch(null, expected)).toBe('expected-identity-missing')
    expect(modelAuthorityIdentityMismatch(expected, { provider: 'other', model: expected.model })).toBe('provider-mismatch')
    expect(modelAuthorityIdentityMismatch(expected, { provider: expected.provider, model: 'other-model' })).toBe('model-mismatch')
    expect(modelResponseAuthorityMismatch(expected, expected, 'fallback')).toBe('response-source-mismatch')
    expect(modelResponseAuthorityMismatch(expected, expected, 'jev')).toBeNull()
    expect(() => assertRecoveryModelAuthority(expected, { provider: 'other', model: expected.model }, 'jev')).toThrow(
      expect.objectContaining({ context: 'jev-authority', retryable: true }),
    )
  })

  test('central generation-start gate prevents lifecycle wakes from bypassing outage backoff', () => {
    const tracker = new ModelAvailabilityTracker()
    const failedAt = Date.parse('2026-09-23T00:00:00.000Z')
    const failure = tracker.recordUnavailable({
      generationId: 'gen-old', context: 'jev-authority', attempts: 1, error: '503 unavailable',
    }, failedAt)

    expect(modelRecoveryStartGate(tracker.snapshot(), failedAt + 1)).toEqual({
      allowed: false,
      reason: 'retry-backoff',
      delayMs: failure.delayMs - 1,
    })
    expect(modelRecoveryStartGate(tracker.snapshot(), Date.parse(failure.retryAt))).toEqual({
      allowed: true,
      reason: 'retry-due',
      delayMs: 0,
    })

    // The scheduled recovery timer clears retryAt immediately before starting
    // the fresh generation. That start and any coalesced wake share this window.
    tracker.recordRetryStarted()
    expect(modelRecoveryStartGate(tracker.snapshot(), Date.parse(failure.retryAt))).toEqual({
      allowed: true,
      reason: 'retry-already-started',
      delayMs: 0,
    })
  })

  test('does not defer ordinary availability and fails closed on a malformed degraded deadline', () => {
    const base = {
      consecutiveFailures: 1,
      retryAt: 'not-a-date',
      lastFailure: null,
      recoveredAt: null,
      recoveryAuthority: null,
      lastRecoveryRejection: null,
    }
    expect(modelRecoveryStartGate({ ...base, state: 'available' }, 0)).toEqual({
      allowed: true,
      reason: 'not-degraded',
      delayMs: 0,
    })
    expect(modelRecoveryStartGate({ ...base, state: 'degraded' }, 0)).toEqual({
      allowed: false,
      reason: 'invalid-retry-deadline',
      delayMs: MODEL_RETRY_BASE_DELAY_MS,
    })
  })

  test('resident checks the retry gate before loading or starting any lifecycle generation', () => {
    const source = readFileSync(new URL('./agent-runner.mts', import.meta.url), 'utf8')
    const start = source.indexOf('async function startGeneration(trigger: string)')
    const end = source.indexOf('\nfunction scheduleGenerationRestart(', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const body = source.slice(start, end)
    const gate = body.indexOf('modelRecoveryStartGate(modelAvailability.snapshot())')
    const defer = body.indexOf("scheduleGenerationRestart('model-unavailable', recoveryGate.delayMs)")
    const dueTransition = body.indexOf("if (recoveryGate.reason === 'retry-due')")
    const retryStarted = body.indexOf('modelAvailability.recordRetryStarted()', dueTransition)
    const moduleLoad = body.indexOf('await loadGenerationModule(false)')
    const create = body.indexOf('mod.createGeneration(ctx)')

    expect(gate).toBeGreaterThanOrEqual(0)
    expect(defer).toBeGreaterThan(gate)
    expect(moduleLoad).toBeGreaterThan(defer)
    expect(create).toBeGreaterThan(moduleLoad)
    expect(dueTransition).toBeGreaterThan(gate)
    expect(retryStarted).toBeGreaterThan(dueTransition)
    expect(retryStarted).toBeLessThan(moduleLoad)
    expect(body.slice(gate, moduleLoad)).toContain("reason: 'model-recovery-backoff'")
    expect(body.slice(gate, defer)).toContain('recoveryGate.delayMs')
    const authorityAdmission = body.indexOf('modelAvailability.admitGenerationAuthority(candidateAuthority)')
    const generationStart = body.indexOf('gen.start()')
    expect(authorityAdmission).toBeGreaterThan(create)
    expect(authorityAdmission).toBeLessThan(generationStart)
    expect(body.slice(authorityAdmission, generationStart)).toContain('started: false')
    expect(body.slice(authorityAdmission, generationStart)).toContain("discardStagedProposals(gen.id, 'model-recovery-authority-rejected')")
  })

  test('recovery authority flows from host snapshot into Jev and the live result is checked before selection', () => {
    const runner = readFileSync(new URL('./agent-runner.mts', import.meta.url), 'utf8')
    const contextStart = runner.indexOf('function makeGenerationContext(')
    const contextEnd = runner.indexOf('\nfunction ', contextStart + 1)
    const context = runner.slice(contextStart, contextEnd)
    expect(context).toContain('recoveryPolicyAuthority: availabilityAtCreate.state === \'degraded\'')
    expect(context).toContain('availabilityAtCreate.recoveryAuthority')
    expect(context).toContain('modelAvailability.recordPolicyResponse(')
    expect(context).toContain('modelAvailability.recordRecoveryRejected(response.reason, authority)')

    const generationEntry = readFileSync(new URL('./generation-entry.ts', import.meta.url), 'utf8')
    expect(generationEntry).toContain('recoveryPolicyAuthority: ctx.recoveryPolicyAuthority ?? null')
    const controller = readFileSync(new URL('../jev-agent/src/controller-legacy.ts', import.meta.url), 'utf8')
    const decisionStart = controller.indexOf('const result = await this.jev.decide({')
    const authorityCheck = controller.indexOf('assertRecoveryModelAuthority(', decisionStart)
    const recordDecision = controller.indexOf('this.lastDecision = result', decisionStart)
    expect(authorityCheck).toBeGreaterThan(decisionStart)
    expect(authorityCheck).toBeLessThan(recordDecision)
    expect(controller.slice(authorityCheck, recordDecision)).toContain('result.source')
  })

  test('host quiesce drains the controller before revoking an incumbent lease', () => {
    const generationSource = readFileSync(new URL('./generation-entry.ts', import.meta.url), 'utf8')
    const quiesceStart = generationSource.indexOf('async function quiesce(): Promise<void>')
    const quiesceEnd = generationSource.indexOf('\n  function proposeLedger()', quiesceStart)
    const quiesceBody = generationSource.slice(quiesceStart, quiesceEnd)
    expect(quiesceStart).toBeGreaterThanOrEqual(0)
    expect(quiesceEnd).toBeGreaterThan(quiesceStart)
    expect(quiesceBody).toContain('await controller.quiesce()')
    expect(quiesceBody).not.toContain('Promise.race')

    const runner = readFileSync(new URL('./agent-runner.mts', import.meta.url), 'utf8')
    const startGeneration = runner.indexOf('async function startGeneration(trigger: string)')
    const startGenerationEnd = runner.indexOf('\nfunction scheduleGenerationRestart(', startGeneration)
    const startBody = runner.slice(startGeneration, startGenerationEnd)
    const replacementStart = startBody.indexOf('if (generation !== null)')
    const replacementEnd = startBody.indexOf('const mod = await loadGenerationModule(false)', replacementStart)
    const replacementBody = startBody.slice(replacementStart, replacementEnd)
    expect(replacementBody.indexOf('await old.quiesce()')).toBeGreaterThanOrEqual(0)
    expect(replacementBody.indexOf('await old.quiesce()')).toBeLessThan(
      replacementBody.indexOf("revokeLease('replaced-by-new-generation')"),
    )

    const simdeathStart = runner.indexOf("if (cmd === 'simdeath'")
    const simdeathEnd = runner.indexOf("if (mode === 'hard')", simdeathStart)
    const simdeathBody = runner.slice(simdeathStart, simdeathEnd)
    expect(simdeathBody.indexOf('await old.quiesce()')).toBeGreaterThanOrEqual(0)
    expect(simdeathBody.indexOf('await old.quiesce()')).toBeLessThan(simdeathBody.indexOf("revokeLease('simdeath')"))

    const shutdownStart = runner.indexOf('async function shutdown(reason: string)')
    const shutdownQuiesce = runner.indexOf('quiesce: async () =>', shutdownStart)
    const shutdownDispose = runner.indexOf('disposeGeneration: () =>', shutdownQuiesce)
    const shutdownBody = runner.slice(shutdownQuiesce, shutdownDispose)
    expect(shutdownStart).toBeGreaterThanOrEqual(0)
    expect(shutdownDispose).toBeGreaterThan(shutdownQuiesce)
    expect(shutdownBody.indexOf('await active.quiesce()')).toBeGreaterThanOrEqual(0)
    expect(shutdownBody.indexOf('await active.quiesce()')).toBeLessThan(shutdownBody.indexOf("revokeLease('shutdown')"))

    const worldEpoch = readFileSync(new URL('./world-epoch.ts', import.meta.url), 'utf8')
    expect(worldEpoch.indexOf('await previous.quiesce()')).toBeGreaterThanOrEqual(0)
    expect(worldEpoch.indexOf('await previous.quiesce()')).toBeLessThan(worldEpoch.indexOf("ports.revokeLease('worldreset')"))
  })
})
