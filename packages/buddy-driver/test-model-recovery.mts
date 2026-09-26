import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vec3 } from 'vec3'
import { FatalModelError, ModelRecoveryRequested, assertRecoveryModelAuthority, modelAuthorityIdentityMismatch, modelResponseAuthorityMismatch } from '../jev-agent/src/modelFailure.ts'
import { GoalQueue } from '../jev-agent/src/goalQueue.ts'
import { applySystem2RecoveryFence } from '../jev-agent/src/system2/authority.ts'
import { JevController } from '../jev-agent/src/controller.ts'
import type { Bot } from 'mineflayer'
import type { System2Brain } from '../jev-agent/src/system2/service.ts'
import { MercurySystem2 } from './mercury-system2.ts'
import type { MercuryStateSummary } from './mercury-system2.ts'
import { createTestKernelAuthority } from '../jev-agent/test-vtr-kernel-authority-stub.mts'
import {
  MODEL_RECOVERY_ACTIVE_GENERATION_POLL_MS,
  MODEL_RETRY_BASE_DELAY_MS,
  MODEL_RETRY_MAX_DELAY_MS,
  ModelAvailabilityTracker,
  modelFailureDisposition,
  modelRecoveryStartGate,
  modelRetryDelayMs,
  recordSystem2PlanResponse,
  recordSystem2RecoveryRejection,
  runGenerationRestartStep,
  stopGenerationForModelRecovery,
} from './model-recovery.ts'
import { isTransientSystem2ProviderFailure } from './mercury-system2.ts'

const SOURCE_SHA = 'c4698e51a98d2a484e43b94112ded3433bdea3f7'

describe('model authority recovery host policy', () => {
  test('controller cancellation aborts in-flight System2 transport without changing queue or authority', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system2-generation-cancel-'))
    const bot = Object.assign(new EventEmitter(), {
      inventory: { items: () => [] },
      entity: { position: new Vec3(0, 64, 0) },
      game: { dimension: 'minecraft:overworld' },
      health: 20,
      food: 20,
      registry: { itemsByName: {}, recipes: {}, materials: {}, blocksByName: {} },
      findBlocks: () => [],
    }) as unknown as Bot
    let transportStarted!: () => void
    const started = new Promise<void>((resolve) => { transportStarted = resolve })
    let requestAborted = false
    let fatalFailures = 0
    const mercuryLogs: string[] = []
    const appliedMarkers: Record<string, unknown>[] = []
    const summary: MercuryStateSummary = {
      humanMission: 'Defeat the Ender Dragon',
      trigger: 'no_progress',
      wakeReason: 'action_impossible',
      wakeDetail: 'controller cancellation regression',
      position: { x: 0, y: 64, z: 0 },
      dimension: 'minecraft:overworld',
      health: 20,
      toolRank: 0,
      inventory: {},
      stations: { craftingTables: 0, furnaces: 0 },
      knownOres: [],
      recentFailures: [],
      consecutiveWait: 0,
      queue: { depth: 1, done: 0, current: 'collect oak log', hasImpossible: false },
      objective: { targetItem: 'oak_log', requiredCount: 2, haveCount: 0, complete: false },
      deathHistory: [],
      allowedGoals: { collect: ['oak_log'], craft: [], smelt: [] },
    }
    const mercury = new MercurySystem2({
      summarize: () => summary,
      log: (event) => mercuryLogs.push(event),
      callsPath: join(dir, 'mercury-calls.jsonl'),
      cachePath: join(dir, 'mercury-cache.json'),
      model: 'meta/muse-spark-1.3-contributor',
      localEndpoint: null,
      resolveKey: () => ({ key: 'test-key', origin: 'test' }),
      retries: 2,
      transport: ({ signal }) => new Promise((_resolve, reject) => {
        transportStarted()
        if (signal === undefined) {
          reject(new Error('generation signal was not passed to transport'))
          return
        }
        signal.addEventListener('abort', () => {
          requestAborted = true
          reject(signal.reason)
        }, { once: true })
      }),
    })
    const controller = new JevController(bot, {
      goalItem: 'ender_pearl',
      goalCount: 12,
      logDir: dir,
      forceFallbackPolicy: true,
      kernelAuthority: createTestKernelAuthority(),
      eventSink: (event, detail) => {
        if (event === 'SYSTEM2_PLAN_APPLIED') appliedMarkers.push(detail)
      },
      terminateOnModelFailure: (error) => {
        fatalFailures += 1
        throw error
      },
    })
    controller.setSystem2(mercury)
    const internals = controller as unknown as {
      running: boolean
      queue: GoalQueue
      summonLlm(reason: 'action_impossible', detail: string): unknown
    }
    internals.queue.applyPlan([
      { kind: 'collect', description: 'collect oak log', targetItem: 'oak_log', requiredCount: 2 },
    ], 'llm', 'replace')
    const queueBefore = internals.queue.state
    const revisionBefore = internals.queue.revision
    const authorityBefore = controller.system2AuthorityStack
    internals.running = true

    internals.summonLlm('action_impossible', 'current head is blocked')
    await started
    controller.stopForModelRecovery()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(requestAborted).toBe(true)
    expect(internals.queue.revision).toBe(revisionBefore)
    expect(internals.queue.state).toEqual(queueBefore)
    expect(controller.system2AuthorityStack).toEqual(authorityBefore)
    expect(controller.isRunning).toBe(false)
    expect(mercury.callCount).toBe(0)
    expect(mercury.fallbackCount).toBe(0)
    expect(fatalFailures).toBe(0)
    expect(mercuryLogs).toContain('MERCURY_REQUEST_CANCELLED')
    expect(mercuryLogs).not.toContain('FATAL')
    expect(appliedMarkers).toHaveLength(0)
  })

  test('a real System2 503 still returns a host recovery signal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system2-503-recovery-'))
    const summary: MercuryStateSummary = {
      humanMission: 'Defeat the Ender Dragon',
      trigger: 'no_progress',
      wakeReason: 'queue_empty',
      wakeDetail: '503 regression',
      position: null,
      dimension: 'minecraft:overworld',
      health: 20,
      toolRank: 0,
      inventory: {},
      stations: { craftingTables: 0, furnaces: 0 },
      knownOres: [],
      recentFailures: [],
      consecutiveWait: 0,
      queue: { depth: 0, done: 0, current: null, hasImpossible: false },
      objective: null,
      deathHistory: [],
      allowedGoals: { collect: ['oak_log'], craft: [], smelt: [] },
    }
    const mercury = new MercurySystem2({
      summarize: () => summary,
      log: () => undefined,
      callsPath: join(dir, 'mercury-calls.jsonl'),
      cachePath: join(dir, 'mercury-cache.json'),
      model: 'meta/muse-spark-1.3-contributor',
      localEndpoint: null,
      resolveKey: () => ({ key: 'test-key', origin: 'test' }),
      retries: 0,
      transport: async () => {
        throw Object.assign(new Error('Service temporarily unavailable'), { statusCode: 503 })
      },
    })
    let hostStopCalled = false
    let outage: unknown = null
    try {
      await mercury.plan({
        reason: 'queue_empty', detail: '503 regression', tick: 1,
        goalQueueState: { depth: 0, current: null, empty: true, hasImpossible: false, done: 0, goals: [] },
        objective: { targetItem: 'ender_pearl', requiredCount: 12, haveCount: 0, complete: false },
        recentEvents: [], recentOutcomes: [],
      })
    } catch (error) {
      outage = error
    }
    expect(outage).toBeInstanceOf(FatalModelError)
    if (!(outage instanceof FatalModelError)) throw new Error('System2 503 did not produce a FatalModelError')
    const recovery = stopGenerationForModelRecovery(outage, 'gen-system2-503', { stop: () => { hostStopCalled = true } })
    expect(outage).toMatchObject({ context: 'system2-authority', retryable: true })
    expect(modelFailureDisposition(outage, true)).toBe('recover-generation')
    expect(hostStopCalled).toBe(true)
    expect(recovery).toMatchObject({ context: 'system2-authority', generationId: 'gen-system2-503' })
  })

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

    const plane = readFileSync(new URL('../jev-agent/src/system2-plane.ts', import.meta.url), 'utf8')
    const applyStart = plane.indexOf('const applyPlan = (): QueuedGoal[] => {', plane.indexOf('const answersTheHead'))
    const applyEnd = plane.indexOf('let added: QueuedGoal[]', applyStart)
    const fenceCall = plane.indexOf('const fenced = applySystem2RecoveryFence(', applyEnd)
    const mutations = plane.slice(applyStart, applyEnd)
    expect(applyStart).toBeGreaterThanOrEqual(0)
    expect(applyEnd).toBeGreaterThan(applyStart)
    expect(fenceCall).toBeGreaterThan(applyEnd)
    expect(mutations).toContain('host.queue.replaceAnsweredHead(')
    expect(mutations).toContain('host.queue.applyPlan(')
    expect(plane.slice(fenceCall, plane.indexOf('added = fenced.value', fenceCall))).toContain('}, applyPlan)')
  })

  test('controller rejection leaves the queue unchanged, stops its generation, and host retry starts fresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system2-recovery-controller-'))
    const expectedAuthority = { provider: 'local-mercury', model: 'mercury:qwen3.5-9b-local' }
    const now = Date.parse('2026-09-24T12:00:00.000Z')
    const tracker = new ModelAvailabilityTracker()
    tracker.admitGenerationAuthority(expectedAuthority, 'system2', SOURCE_SHA)
    tracker.recordUnavailable({
      generationId: 'gen-before-recovery',
      context: 'system2-authority',
      attempts: 3,
      error: 'transient provider 503',
      authorityKind: 'system2',
      authority: expectedAuthority,
      sourceSha: SOURCE_SHA,
    }, now)
    tracker.recordRetryStarted()
    expect(tracker.admitGenerationAuthority(expectedAuthority, 'system2', SOURCE_SHA)).toMatchObject({
      allowed: true,
      reason: 'same-recovery-authority',
    })

    const bot = Object.assign(new EventEmitter(), {
      inventory: { items: () => [] },
      entity: { position: new Vec3(0, 64, 0) },
      game: { dimension: 'minecraft:overworld' },
      health: 20,
      food: 20,
      registry: { itemsByName: {}, recipes: {}, materials: {}, blocksByName: {} },
      findBlocks: () => [],
    }) as unknown as Bot

    let controller!: JevController
    let generationActive = true
    let generationStarts = 0
    let retryStarts = 0
    const rejectionReasons: string[] = []
    const pollDelays: number[] = []
    const restart = () => runGenerationRestartStep(
      'model-unavailable',
      MODEL_RECOVERY_ACTIVE_GENERATION_POLL_MS,
      {
        blocked: () => false,
        generationActive: () => generationActive,
        waitForGenerationStop: (delayMs) => { pollDelays.push(delayMs) },
        recordModelRetryStarted: () => {
          retryStarts += 1
          tracker.recordRetryStarted()
        },
        startGeneration: () => { generationStarts += 1 },
      },
    )
    controller = new JevController(bot, {
      goalItem: 'ender_pearl',
      goalCount: 12,
      logDir: dir,
      forceFallbackPolicy: true,
      kernelAuthority: createTestKernelAuthority(),
      recoverySystem2Authority: expectedAuthority,
      recoverySourceSha: SOURCE_SHA,
      generationSourceSha: SOURCE_SHA,
      rejectSystem2RecoveryPlan: (rejection) => {
        rejectionReasons.push(rejection.reason)
        const transition = recordSystem2RecoveryRejection(tracker, {
          reason: rejection.reason,
          actualAuthority: rejection.actualAuthority,
          actualSourceSha: rejection.actualSourceSha,
        }, now + 1_000)
        expect(transition.retry).not.toBeNull()
        expect(restart()).toBe('waiting-for-generation-stop')
        controller.stopForModelRecovery()
        generationActive = controller.isRunning
        throw new ModelRecoveryRequested('system2-authority', 'gen-recovery-integration')
      },
    })
    controller.setSystem2({
      provider: expectedAuthority.provider,
      model: 'qwen3.5-9b-local',
      authorityModel: 'qwen3.5-9b-local',
      authorityStack: expectedAuthority,
      plan: async () => ({
        op: 'replace',
        goals: [{ kind: 'collect', description: 'collect stone', targetItem: 'stone', requiredCount: 2 }],
        note: 'cached recovery fixture',
        provenance: { intentSource: 'cached' },
      }),
    } satisfies System2Brain)

    const internals = controller as unknown as {
      running: boolean
      queue: GoalQueue
      summonLlm(reason: 'action_impossible', detail: string): unknown
    }
    internals.queue.applyPlan([
      { kind: 'collect', description: 'collect oak log', targetItem: 'oak_log', requiredCount: 2 },
    ], 'llm', 'replace')
    const queueBefore = internals.queue.state
    const revisionBefore = internals.queue.revision
    internals.running = true

    internals.summonLlm('action_impossible', 'current head is blocked')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(rejectionReasons).toEqual(['response-source-mismatch'])
    expect(internals.queue.revision).toBe(revisionBefore)
    expect(internals.queue.state).toEqual(queueBefore)
    expect(controller.isRunning).toBe(false)
    expect(pollDelays).toEqual([MODEL_RECOVERY_ACTIVE_GENERATION_POLL_MS])
    expect(restart()).toBe('started')
    expect(retryStarts).toBe(1)
    expect(generationStarts).toBe(1)
    expect(tracker.snapshot()).toMatchObject({ state: 'degraded', retryAt: null })

    const appliedMarkers: Record<string, unknown>[] = []
    const appliedResponses: ReturnType<typeof recordSystem2PlanResponse>[] = []
    const freshController = new JevController(bot, {
      goalItem: 'ender_pearl',
      goalCount: 12,
      logDir: dir,
      forceFallbackPolicy: true,
      kernelAuthority: createTestKernelAuthority(),
      recoverySystem2Authority: expectedAuthority,
      recoverySourceSha: SOURCE_SHA,
      generationSourceSha: SOURCE_SHA,
      eventSink: (event, detail) => {
        if (event !== 'SYSTEM2_PLAN_APPLIED') return
        appliedMarkers.push(detail)
        const provider = typeof detail.provider === 'string' ? detail.provider : null
        const model = typeof detail.model === 'string' ? detail.model : null
        // The generation event adapter stamps its boot-bound source SHA before
        // forwarding this marker into the resident host's recovery handler.
        appliedResponses.push(recordSystem2PlanResponse(
          tracker,
          provider === null || model === null ? null : { provider, model },
          typeof detail.intentSource === 'string' ? detail.intentSource : null,
          SOURCE_SHA,
          now + 2_000,
          detail.accepted === true,
        ))
      },
    })
    freshController.setSystem2({
      provider: expectedAuthority.provider,
      model: 'qwen3.5-9b-local',
      authorityModel: 'qwen3.5-9b-local',
      authorityStack: expectedAuthority,
      plan: async () => ({
        op: 'replace',
        goals: [{ kind: 'collect', description: 'collect stone', targetItem: 'stone', requiredCount: 2 }],
        note: 'fresh local-mercury recovery answer',
        provenance: { intentSource: 'intent', intent: 'collect stone using the present workspace' },
      }),
    } satisfies System2Brain)
    const freshInternals = freshController as unknown as {
      running: boolean
      summonLlm(reason: 'action_impossible', detail: string): unknown
    }
    freshInternals.running = true
    freshInternals.summonLlm('action_impossible', 'retry the current head with a fresh model response')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    freshController.stop()

    expect(appliedMarkers).toHaveLength(1)
    expect(appliedMarkers[0]).toMatchObject({
      provider: 'local-mercury',
      model: 'mercury:qwen3.5-9b-local',
      intentSource: 'intent',
    })
    expect(appliedResponses).toHaveLength(1)
    expect(appliedResponses[0]).toMatchObject({ accepted: true, recovered: true, responseSource: 'system2' })
    expect(tracker.snapshot()).toMatchObject({ state: 'available', recoveryAuthority: null, recoverySourceSha: null })

    // A provider-authored plan can still be rejected by the code-owned queue
    // verifier. That marker must not restore System2 authority; the HOST keeps
    // the run degraded and arms a typed retry instead.
    tracker.recordUnavailable({
      generationId: 'gen-before-rejected-application',
      context: 'system2-authority',
      attempts: 2,
      error: 'transient provider 503',
      authorityKind: 'system2',
      authority: expectedAuthority,
      sourceSha: SOURCE_SHA,
    }, now + 3_000)
    tracker.recordRetryStarted()
    const rejectedMarkers: Record<string, unknown>[] = []
    const rejectedResponses: ReturnType<typeof recordSystem2PlanResponse>[] = []
    const rejectedController = new JevController(bot, {
      goalItem: 'ender_pearl',
      goalCount: 12,
      logDir: dir,
      forceFallbackPolicy: true,
      kernelAuthority: createTestKernelAuthority(),
      recoverySystem2Authority: expectedAuthority,
      recoverySourceSha: SOURCE_SHA,
      generationSourceSha: SOURCE_SHA,
      eventSink: (event, detail) => {
        if (event !== 'SYSTEM2_PLAN_APPLIED') return
        rejectedMarkers.push(detail)
        const provider = typeof detail.provider === 'string' ? detail.provider : null
        const model = typeof detail.model === 'string' ? detail.model : null
        rejectedResponses.push(recordSystem2PlanResponse(
          tracker,
          provider === null || model === null ? null : { provider, model },
          typeof detail.intentSource === 'string' ? detail.intentSource : null,
          SOURCE_SHA,
          now + 4_000,
          detail.accepted === true,
        ))
      },
    })
    rejectedController.setSystem2({
      provider: expectedAuthority.provider,
      model: 'qwen3.5-9b-local',
      authorityModel: 'qwen3.5-9b-local',
      authorityStack: expectedAuthority,
      plan: async () => ({
        op: 'complete',
        goals: [],
        note: 'completion request without code-owned proof',
        provenance: { intentSource: 'intent', intent: 'complete the current option' },
      }),
    } satisfies System2Brain)
    const rejectedInternals = rejectedController as unknown as {
      running: boolean
      summonLlm(reason: 'action_impossible', detail: string): unknown
    }
    rejectedInternals.running = true
    rejectedInternals.summonLlm('action_impossible', 'completion requires code-owned verification')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    rejectedController.stop()

    expect(rejectedMarkers).toHaveLength(1)
    expect(rejectedMarkers[0]).toMatchObject({ accepted: false, op: 'complete' })
    expect(rejectedResponses).toHaveLength(1)
    expect(rejectedResponses[0]).toMatchObject({
      accepted: false,
      recovered: false,
      reason: 'plan-application-rejected',
      responseSource: 'system2',
      retry: { attempt: 2, delayMs: 10_000 },
    })
    expect(tracker.snapshot()).toMatchObject({
      state: 'degraded',
      recoveryAuthorityKind: 'system2',
      recoveryAuthority: expectedAuthority,
      recoverySourceSha: SOURCE_SHA,
      lastRecoveryRejection: { reason: 'plan-application-rejected' },
    })
    expect(modelRecoveryStartGate(tracker.snapshot(), now + 4_001)).toMatchObject({
      allowed: false,
      reason: 'retry-backoff',
    })
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
    expect(context).toContain('recordSystem2PlanResponse(')
    expect(context).toContain('recordSystem2RecoveryRejection(')
    expect(context).toContain('authorityKind: detail.authorityKind === \'system2\' ? \'system2\' : \'jev\'')

    const generationEntry = readFileSync(new URL('./generation-entry.ts', import.meta.url), 'utf8')
    expect(generationEntry).toContain('recoveryPolicyAuthority: ctx.recoveryPolicyAuthority ?? null')
    expect(generationEntry).toContain('requireFreshProviderDecision: ctx.recoverySystem2Authority !== undefined && ctx.recoverySystem2Authority !== null')
    expect(generationEntry.match(/requireFreshProviderDecision: ctx\.recoverySystem2Authority/g)?.length).toBe(2)
    expect(generationEntry).toContain('sourceSha: ctx.sourceSha ?? null')
    expect(runner).toContain("admitGenerationAuthority(system2Authority, 'system2', status.sourceSha)")
    expect(runner).toContain('recoverySourceSha')
    const mercury = readFileSync(new URL('./mercury-system2.ts', import.meta.url), 'utf8')
    expect(mercury).toContain('if (cached !== undefined && !this.requireFreshProviderDecision)')
    const controller = readFileSync(new URL('../jev-agent/src/controller-legacy.ts', import.meta.url), 'utf8')
    expect(
      controller + readFileSync(new URL('../jev-agent/src/system2-plane.ts', import.meta.url), 'utf8'),
    ).toMatch(/provider: system2Authority\.provider,\s*model: system2Authority\.model,/)
    const decisionEpochs = readFileSync(new URL('../jev-agent/src/decision-epochs.ts', import.meta.url), 'utf8')
    const decisionSource = controller + decisionEpochs
    const decisionStart = decisionSource.indexOf('const result = await host.jev.decide({')
    const authorityCheck = decisionSource.indexOf('assertRecoveryModelAuthority(', decisionStart)
    const recordDecision = decisionSource.indexOf('host.lastDecision = result', decisionStart)
    expect(authorityCheck).toBeGreaterThan(decisionStart)
    expect(authorityCheck).toBeLessThan(recordDecision)
    expect(decisionSource.slice(authorityCheck, recordDecision)).toContain('result.source')
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
