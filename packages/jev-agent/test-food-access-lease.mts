import { expect, test } from 'bun:test'
import { requestDecision, type DecisionEpochsHost } from './src/decision-epochs.ts'
import type { TriggerEvent } from './src/scheduler.ts'

function harness(qualified = true, food = 0, health = 11) {
  const scheduled: TriggerEvent[] = []
  const current = {
    id: 'ASCEND:surface:p7_9_3', kind: 'MOVE', epoch: 1,
    commitment: { params: qualified ? { surfaceAccessAscent: true } : {} },
  }
  const host = {
    running: true, modelRecoveryStopping: false, ticking: false,
    executor: { current }, bot: { health, food }, tickCounter: 1,
    pendingTrigger: null, deferredTrigger: null,
    logger: { info() {}, warn() {}, error() {} },
    liveAir: () => 20,
    scheduleTick: (event: TriggerEvent) => scheduled.push(event),
  } as unknown as DecisionEpochsHost
  return { host, current, scheduled }
}

test('a selected grounded food-access ascent defers ordinary damage above critical health', () => {
  const h = harness()
  requestDecision(h.host, 'damage_taken', { health: 12, attackerId: null })
  expect(h.scheduled).toHaveLength(0)
  expect(h.host.deferredTrigger?.trigger).toBe('damage_taken')
  expect(Object.is(h.host.executor.current, h.current)).toBe(true)
  // A health update coalesces without replacing the selected action.
  requestDecision(h.host, 'hp_changed', { health: 11, previousHealth: 12 })
  expect(h.scheduled).toHaveLength(0)
  expect(h.host.deferredTrigger?.detail.health).toBe(12)
})

test('the same lease has a finite absorbed-hit budget', () => {
  const h = harness()
  for (let i = 0; i < 3; i++) requestDecision(h.host, 'damage_taken', { hit: i })
  expect(h.scheduled).toHaveLength(0)
  requestDecision(h.host, 'damage_taken', { hit: 3 })
  expect(h.scheduled).toHaveLength(1)
})

test('critical health, low air, a new mob and timeout still preempt food access', () => {
  const critical = harness(true, 0, 5)
  requestDecision(critical.host, 'damage_taken', {})
  expect(critical.scheduled).toHaveLength(1)
  for (const trigger of ['low_air', 'mob_appeared', 'action_timeout'] as const) {
    const h = harness()
    requestDecision(h.host, trigger, { air: 0 })
    expect(h.scheduled).toHaveLength(1)
  }
})

test('an id label alone and a body without the food emergency gain no deferral', () => {
  for (const h of [harness(false), harness(true, 10)]) {
    requestDecision(h.host, 'damage_taken', {})
    expect(h.scheduled).toHaveLength(1)
  }
})

test('completion re-evaluates the coalesced damage through the normal decision path', () => {
  const h = harness()
  requestDecision(h.host, 'damage_taken', { observed: 'hit' })
  const deferred = h.host.deferredTrigger!
  expect(h.scheduled).toHaveLength(0)
  // The controller drains this event after the original lease settles.
  ;(h.host.executor as unknown as { current: unknown }).current = null
  requestDecision(h.host, deferred.trigger, deferred.detail)
  expect(h.scheduled).toHaveLength(1)
  expect(h.scheduled[0]?.detail.observed).toBe('hit')
})
