import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { FatalModelError, ModelRecoveryRequested } from '../jev-agent/src/modelFailure.ts'
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
    })

    const first = tracker.recordUnavailable({
      generationId: 'gen-old', context: 'jev-authority', attempts: 4, error: 'GatewayInternalServerError: unavailable',
    }, Date.parse('2026-09-23T00:00:00.000Z'))
    expect(first.attempt).toBe(1)
    expect(first.delayMs).toBe(5_000)
    expect(first.retryAt).toBe('2026-09-23T00:00:05.000Z')
    expect(tracker.snapshot().state).toBe('degraded')

    tracker.recordRetryStarted()
    expect(tracker.snapshot().retryAt).toBeNull()
    expect(tracker.recordSuccess(Date.parse('2026-09-23T00:00:06.000Z'))).toBe(true)
    expect(tracker.snapshot()).toMatchObject({
      state: 'available', consecutiveFailures: 0, retryAt: null,
      recoveredAt: '2026-09-23T00:00:06.000Z',
      lastFailure: { generationId: 'gen-old', context: 'jev-authority', attempts: 4 },
    })
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
  })
})
