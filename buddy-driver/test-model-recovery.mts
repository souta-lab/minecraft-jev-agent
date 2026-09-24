import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { FatalModelError, ModelRecoveryRequested, assertRecoveryModelAuthority, modelAuthorityIdentityMismatch, modelResponseAuthorityMismatch } from '../jev-agent/src/modelFailure.ts'
import { GoalQueue } from '../jev-agent/src/goalQueue.ts'
import { applySystem2RecoveryFence } from '../jev-agent/src/system2Authority.ts'
import {
  MODEL_RECOVERY_ACTIVE_GENERATION_POLL_MS,
  MODEL_RETRY_BASE_DELAY_MS,
  MODEL_RETRY_MAX_DELAY_MS,
  ModelAvailabilityTracker,
  modelFailureDisposition,
  modelRecoveryStartGate,
  modelRetryDelayMs,
  runGenerationRestartStep,
  stopGenerationForModelRecovery,
} from './model-recovery.ts'
import { isTransientSystem2ProviderFailure } from './mercury-system2.ts'

const SOURCE_SHA = 'c4698e51a98d2a484e43b94112ded3433bdea3f7'

describe('model authority recovery host policy', () => {
  test('uses bounded exponential backoff', () => {
    expect(modelRetryDelayMs(1)).toBe(5_000)
    expect(modelRetryDelayMs(2)).toBe(10_000)
    expect(modelRetryDelayMs(3)).toBe(20_000)
    expect(modelRetryDelayMs(100)).toBe(MODEL_RETRY_MAX_DELAY_MS)
  })

  test('recovers only typed transient model-authority failures after controller startup', () => {
    expect(modelFailureDisposition({ context: 'jev-authority', retryable: true }, true)).toBe('recover-generation')
    expect(modelFailureDisposition({ context: 'system2-authority', retryable: true }, true)).toBe('recover-generation')
    expect(modelFailureDisposition({ context: 'jev-policy-key', retryable: true }, true)).toBe('terminate-process')
    expect(modelFailureDisposition({ context: 'system2-plan', retryable: true }, true)).toBe('terminate-process')
    expect(modelFailureDisposition({ context: 'system2-authority', retryable: false }, true)).toBe('terminate-process')
    expect(modelFailureDisposition({ context: 'mercury:queue_empty', retryable: true }, true)).toBe('terminate-process')
    expect(modelFailureDisposition({ context: 'jev-authority', retryable: false }, true)).toBe('terminate-process')
    expect(modelFailureDisposition({ context: 'jev-authority', retryable: true }, false)).toBe('terminate-process')
  })

  test('classifies only explicit transient System2 transport errors for host recovery', () => {
    expect(isTransientSystem2ProviderFailure({
      name: 'GatewayInternalServerError',
      message: 'Service temporarily unavailable. Please try again shortly.',
    })).toBe(true)
    expect(isTransientSystem2ProviderFailure({ statusCode: 503, name: 'APICallError' })).toBe(true)
    expect(isTransientSystem2ProviderFailure({ cause: { code: 'ECONNRESET' } })).toBe(true)
    expect(isTransientSystem2ProviderFailure({ statusCode: 401, name: 'APICallError', message: 'Invalid API key' })).toBe(false)
    expect(isTransientSystem2ProviderFailure(new Error('invalid plan: missing goals'))).toBe(false)
    expect(isTransientSystem2ProviderFailure(new Error('hourly budget exhausted'))).toBe(false)
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

    const system2Outage = new FatalModelError('system2-authority', 3, '503 Service unavailable', true)
    stopped = false
    const system2Signal = stopGenerationForModelRecovery(system2Outage, 'gen-old', { stop: () => { stopped = true } })
    expect(stopped).toBe(true)
    expect(system2Signal).toMatchObject({ context: 'system2-authority', generationId: 'gen-old' })
    stopped = false
    expect(stopGenerationForModelRecovery(new FatalModelError('mercury:queue_empty', 3, 'invalid API key', false), 'gen-old', {
      stop: () => { stopped = true },
    })).toBeNull()
    expect(stopped).toBe(false)
  })

  test('records degraded, retrying, and recovered transitions with provenance', () => {
    const tracker = new ModelAvailabilityTracker()
    expect(tracker.snapshot()).toEqual({
      state: 'unknown', consecutiveFailures: 0, retryAt: null, lastFailure: null, recoveredAt: null,
      recoveryAuthorityKind: null, recoveryAuthority: null, recoverySourceSha: null, lastRecoveryRejection: null,
    })

    expect(tracker.admitGenerationAuthority({ provider: 'typesafe-ai', model: 'typesafe-ai/jev' }, 'jev', SOURCE_SHA)).toMatchObject({
      allowed: true, reason: 'ordinary-generation',
    })
    const first = tracker.recordUnavailable({
      generationId: 'gen-old', context: 'jev-authority', attempts: 4, error: 'GatewayInternalServerError: unavailable', authorityKind: 'jev', sourceSha: SOURCE_SHA,
    }, Date.parse('2026-09-23T00:00:00.000Z'))
    expect(first.attempt).toBe(1)
    expect(first.delayMs).toBe(5_000)
    expect(first.retryAt).toBe('2026-09-23T00:00:05.000Z')
    expect(tracker.snapshot()).toMatchObject({
      state: 'degraded',
      recoveryAuthorityKind: 'jev',
      recoverySourceSha: SOURCE_SHA,
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
    expect(tracker.admitGenerationAuthority(oldAuthority, 'jev', SOURCE_SHA).allowed).toBe(true)
    tracker.recordUnavailable({
      generationId: 'gen-old', context: 'jev-authority', attempts: 3,
      authorityKind: 'jev',
      error: 'GatewayInternalServerError: Service temporarily unavailable',
      sourceSha: SOURCE_SHA,
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

    const sameAuthority = tracker.admitGenerationAuthority(oldAuthority, 'jev', SOURCE_SHA)
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

  test('System2 recovery pins its own provider/model and requires a fresh provider-authored plan', () => {
    const tracker = new ModelAvailabilityTracker()
    const jev = { provider: 'typesafe-ai', model: 'typesafe-ai/jev' }
    const system2 = { provider: 'muse-spark', model: 'meta/muse-spark-1.3-contributor' }
    expect(tracker.admitGenerationAuthority(jev, 'jev', SOURCE_SHA).allowed).toBe(true)
    expect(tracker.admitGenerationAuthority(system2, 'system2', SOURCE_SHA).allowed).toBe(true)
    tracker.recordUnavailable({
      generationId: 'gen-old',
      context: 'system2-authority',
      attempts: 3,
      error: 'GatewayInternalServerError: Service temporarily unavailable',
      authorityKind: 'system2',
      authority: system2,
      sourceSha: SOURCE_SHA,
    }, Date.parse('2026-09-23T00:00:00.000Z'))
    expect(tracker.snapshot()).toMatchObject({
      state: 'degraded',
      recoveryAuthorityKind: 'system2',
      recoveryAuthority: system2,
      recoverySourceSha: SOURCE_SHA,
      lastFailure: { authorityKind: 'system2', authority: system2 },
    })

    tracker.recordRetryStarted()
    expect(tracker.admitGenerationAuthority(jev, 'jev', SOURCE_SHA)).toMatchObject({
      allowed: true,
      reason: 'other-recovery-authority',
    })
    expect(tracker.admitGenerationAuthority({ ...system2, model: 'meta/other' }, 'system2', SOURCE_SHA)).toMatchObject({
      allowed: false,
      reason: 'model-mismatch',
      authorityKind: 'system2',
    })
    expect(tracker.admitGenerationAuthority(system2, 'system2', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({
      allowed: false,
      reason: 'source-mismatch',
      expectedSourceSha: SOURCE_SHA,
    })
    expect(tracker.admitGenerationAuthority(system2, 'system2', SOURCE_SHA)).toMatchObject({
      allowed: true,
      reason: 'same-recovery-authority',
    })
    expect(tracker.recordPolicyResponse(system2, 'system2-cache', Date.parse('2026-09-23T00:00:01.000Z'), 'system2')).toMatchObject({
      accepted: false,
      recovered: false,
      reason: 'response-source-mismatch',
    })
    expect(tracker.snapshot().state).toBe('degraded')
    expect(tracker.recordPolicyResponse(system2, 'system2', Date.parse('2026-09-23T00:00:02.000Z'), 'system2')).toEqual({
      accepted: true,
      recovered: true,
      reason: null,
    })
    expect(tracker.snapshot()).toMatchObject({
      state: 'available',
      recoveryAuthorityKind: null,
      recoveryAuthority: null,
      recoverySourceSha: null,
    })
  })

  test('System2 recovery fence rejects cached plan before answer-head retirement or queue apply', () => {
    const system2 = { provider: 'muse-spark', model: 'meta/muse-spark-1.3-contributor' }
    const queue = new GoalQueue()
    queue.applyPlan([
      { kind: 'collect', description: 'collect oak log', targetItem: 'oak_log', requiredCount: 2 },
    ], 'llm', 'replace')
    const before = queue.state
    const revisionBefore = queue.revision
    let queueMutationEntered = false
    const fenced = applySystem2RecoveryFence({
      expectedAuthority: system2,
      actualAuthority: system2,
      expectedSourceSha: SOURCE_SHA,
      actualSourceSha: SOURCE_SHA,
      intentSource: 'cached',
    }, () => {
      queueMutationEntered = true
      const head = queue.current
      if (head !== null) queue.replaceAnsweredHead({
        headId: head.id,
        requestId: 'request-recovered',
        reason: 'no_progress',
      })
      return queue.applyPlan([
        { kind: 'collect', description: 'collect stone', targetItem: 'stone', requiredCount: 3 },
      ], 'llm', 'replace')
    })
    expect(fenced).toMatchObject({ applied: false, rejection: { reason: 'response-source-mismatch' } })
    expect(queueMutationEntered).toBe(false)
    expect(queue.revision).toBe(revisionBefore)
    expect(queue.state).toEqual(before)

    const controller = readFileSync(new URL('../jev-agent/src/controller-legacy.ts', import.meta.url), 'utf8')
    const applyStart = controller.indexOf('const applyPlan = (): QueuedGoal[] => {', controller.indexOf('const answersTheHead'))
    const applyEnd = controller.indexOf('\n        let added: QueuedGoal[]', applyStart)
    const fenceCall = controller.indexOf('const fenced = applySystem2RecoveryFence(', applyEnd)
    const mutations = controller.slice(applyStart, applyEnd)
    expect(applyStart).toBeGreaterThanOrEqual(0)
    expect(applyEnd).toBeGreaterThan(applyStart)
    expect(fenceCall).toBeGreaterThan(applyEnd)
    expect(mutations).toContain('this.queue.replaceAnsweredHead(')
    expect(mutations).toContain('this.queue.applyPlan(')
    expect(controller.slice(fenceCall, controller.indexOf('added = fenced.value', fenceCall))).toContain('}, applyPlan)')
  })

  test('scheduled recovery stays armed while a generation drains, then starts retry', () => {
    let generationActive = true
    let blocked = false
    const scheduledDelays: number[] = []
    let retryStarts = 0
    let generationStarts = 0
    const runStep = () => runGenerationRestartStep(
      'model-unavailable',
      MODEL_RECOVERY_ACTIVE_GENERATION_POLL_MS,
      {
        blocked: () => blocked,
        generationActive: () => generationActive,
        waitForGenerationStop: (delayMs) => { scheduledDelays.push(delayMs) },
        recordModelRetryStarted: () => { retryStarts += 1 },
        startGeneration: () => { generationStarts += 1 },
      },
    )

    expect(runStep()).toBe('waiting-for-generation-stop')
    expect(scheduledDelays).toEqual([MODEL_RECOVERY_ACTIVE_GENERATION_POLL_MS])
    expect(retryStarts).toBe(0)
    expect(generationStarts).toBe(0)

    generationActive = false
    expect(runStep()).toBe('started')
    expect(retryStarts).toBe(1)
    expect(generationStarts).toBe(1)

    const runner = readFileSync(new URL('./agent-runner.mts', import.meta.url), 'utf8')
    const restartStart = runner.indexOf('function scheduleGenerationRestart(')
    const restartEnd = runner.indexOf('\nfunction scheduleGenerationConnectionRetry(', restartStart)
    const restart = runner.slice(restartStart, restartEnd)
    expect(restart).toContain('runGenerationRestartStep(reason, MODEL_RECOVERY_ACTIVE_GENERATION_POLL_MS')
    expect(restart).toContain('scheduleGenerationRestart(reason, pollDelayMs)')
    expect(restart).toContain('void startGeneration(`recovery:${reason}`)')
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
      generationId: 'gen-old', context: 'jev-authority', attempts: 1, error: '503 unavailable', authorityKind: 'jev', sourceSha: SOURCE_SHA,
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
      recoveryAuthorityKind: null,
      recoveryAuthority: null,
      recoverySourceSha: null,
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
    const gateHelperStart = source.indexOf('function gateModelRecoveryStart(')
    const gateHelperEnd = source.indexOf('\nfunction inspectGenerationAuthority(', gateHelperStart)
    const gateHelper = source.slice(gateHelperStart, gateHelperEnd)
    expect(gateHelperStart).toBeGreaterThanOrEqual(0)
    expect(gateHelperEnd).toBeGreaterThan(gateHelperStart)
    const gate = gateHelper.indexOf('modelRecoveryStartGate(modelAvailability.snapshot())')
    const defer = gateHelper.indexOf("scheduleGenerationRestart('model-unavailable', recoveryGate.delayMs)")
    const dueTransition = gateHelper.indexOf("if (recoveryGate.reason === 'retry-due')")
    const retryStarted = gateHelper.indexOf('modelAvailability.recordRetryStarted()', dueTransition)
    expect(gate).toBeGreaterThanOrEqual(0)
    expect(defer).toBeGreaterThan(gate)
    expect(dueTransition).toBeGreaterThan(gate)
    expect(retryStarted).toBeGreaterThan(dueTransition)
    expect(gateHelper.slice(gate, defer)).toContain('recoveryGate.delayMs')

    const start = source.indexOf('async function startGeneration(trigger: string)')
    const end = source.indexOf('\nfunction scheduleGenerationRestart(', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const body = source.slice(start, end)
    const gateCall = body.indexOf("gateModelRecoveryStart(trigger, 'generation')")
    const moduleLoad = body.indexOf('await loadGenerationModule(false)')
    const create = body.indexOf('mod.createGeneration(ctx)')
    expect(gateCall).toBeGreaterThanOrEqual(0)
    expect(gateCall).toBeLessThan(moduleLoad)
    expect(create).toBeGreaterThan(moduleLoad)
    const authorityAdmission = body.indexOf('inspectGenerationAuthority(gen, trigger)')
    const generationStart = body.indexOf('gen.start()')
    expect(authorityAdmission).toBeGreaterThan(create)
    expect(authorityAdmission).toBeLessThan(generationStart)
    expect(body.slice(authorityAdmission, generationStart)).toContain("discardStagedProposals(gen.id, 'model-recovery-authority-rejected')")
    const rejectionStart = source.indexOf('function logRejectedGenerationAuthority(')
    const rejectionEnd = source.indexOf('\nasync function startGeneration(', rejectionStart)
    const rejection = source.slice(rejectionStart, rejectionEnd)
    expect(rejection).toContain('started: false')

    const reloadStart = source.indexOf('async function performReload(trigger: string)')
    const reloadEnd = source.indexOf('\n// ---------------------------------------------------------------------------\n// control channel', reloadStart)
    const reload = source.slice(reloadStart, reloadEnd)
    const reloadGate = reload.indexOf("gateModelRecoveryStart(trigger, 'reload')")
    const build = reload.indexOf('await buildGeneration()')
    const candidateCreate = reload.indexOf('candidate = mod.createGeneration(ctx)')
    const reloadAuthority = reload.indexOf('inspectGenerationAuthority(candidate, `reload:${trigger}`)')
    const candidateAttach = reload.indexOf('candidate.attach()')
    const swap = reload.indexOf('swapGeneration(makeSwapPorts(previousModule), candidate)')
    expect(reloadGate).toBeGreaterThanOrEqual(0)
    expect(reloadGate).toBeLessThan(build)
    expect(candidateCreate).toBeGreaterThan(build)
    expect(reloadAuthority).toBeGreaterThan(candidateCreate)
    expect(reloadAuthority).toBeLessThan(candidateAttach)
    expect(candidateAttach).toBeLessThan(swap)
    expect(reload).toContain('deferredModelReloadTrigger = trigger')

    const swapPortsStart = source.indexOf('function makeSwapPorts(previousModule: GenerationModule | null)')
    const swapPortsEnd = source.indexOf('\nfunction watchGenerationStop(', swapPortsStart)
    const swapPorts = source.slice(swapPortsStart, swapPortsEnd)
    const buildResumeStart = swapPorts.indexOf('buildResume: () => {')
    const buildResumeEnd = swapPorts.indexOf('\n    },\n    dispose:', buildResumeStart)
    const buildResume = swapPorts.slice(buildResumeStart, buildResumeEnd)
    expect(buildResume).toContain("gateModelRecoveryStart(trigger, 'rollback')")
    expect(buildResume.indexOf("gateModelRecoveryStart(trigger, 'rollback')")).toBeLessThan(buildResume.indexOf('previousModule.createGeneration(ctx)'))
    expect(buildResume.indexOf('previousModule.createGeneration(ctx)')).toBeLessThan(buildResume.indexOf('inspectGenerationAuthority(resumed, trigger)'))
    expect(buildResume.indexOf('inspectGenerationAuthority(resumed, trigger)')).toBeLessThan(buildResume.indexOf('return resumed'))
    expect(buildResume).toContain("discardStagedProposals(resumed.id, 'rollback-model-authority-rejected')")
  })

  test('recovery authority flows from host snapshot into Jev and the live result is checked before selection', () => {
    const runner = readFileSync(new URL('./agent-runner.mts', import.meta.url), 'utf8')
    const contextStart = runner.indexOf('function makeGenerationContext(')
    const contextEnd = runner.indexOf('\nfunction ', contextStart + 1)
    const context = runner.slice(contextStart, contextEnd)
    expect(context).toContain('recoveryPolicyAuthority: availabilityAtCreate.state === \'degraded\'')
    expect(context).toContain('availabilityAtCreate.recoveryAuthority')
    expect(context).toContain('recoverySystem2Authority: availabilityAtCreate.state === \'degraded\'')
    expect(context).toContain('modelAvailability.recordPolicyResponse(')
    expect(context).toContain('modelAvailability.recordRecoveryRejected(response.reason, authority)')
    expect(context).toContain("recordPolicyResponse(authority, responseSource, Date.now(), 'system2')")
    expect(context).toContain('authorityKind: detail.authorityKind === \'system2\' ? \'system2\' : \'jev\'')

    const generationEntry = readFileSync(new URL('./generation-entry.ts', import.meta.url), 'utf8')
    expect(generationEntry).toContain('recoveryPolicyAuthority: ctx.recoveryPolicyAuthority ?? null')
    expect(generationEntry).toContain('requireFreshProviderDecision: ctx.recoverySystem2Authority !== undefined && ctx.recoverySystem2Authority !== null')
    expect(generationEntry).toContain('sourceSha: ctx.sourceSha ?? null')
    expect(runner).toContain("admitGenerationAuthority(system2Authority, 'system2', status.sourceSha)")
    expect(runner).toContain('recoverySourceSha')
    const mercury = readFileSync(new URL('./mercury-system2.ts', import.meta.url), 'utf8')
    expect(mercury).toContain('if (cached !== undefined && !this.requireFreshProviderDecision)')
    const controller = readFileSync(new URL('../jev-agent/src/controller-legacy.ts', import.meta.url), 'utf8')
    expect(controller).toContain('provider: this.system2Provider,\n            model: this.system2Model,')
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
