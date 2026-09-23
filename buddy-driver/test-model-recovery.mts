import { describe, expect, test } from 'bun:test'
import { FatalModelError, ModelRecoveryRequested } from '../jev-agent/src/modelFailure.ts'
import {
  MODEL_RETRY_MAX_DELAY_MS,
  ModelAvailabilityTracker,
  modelFailureDisposition,
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
})
