import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'bun:test'
import { submitSystem2Handoff } from './src/system2Handoff.ts'

describe('typed Jev to System2 escalation handoff', () => {
  it('invokes the System2 dispatcher once and returns its concrete request id', () => {
    const calls: Array<{ reason: string; detail: string }> = []
    const result = submitSystem2Handoff(
      { reason: 'action_impossible', detail: 'candidate set exhausted' },
      (reason, detail) => {
        calls.push({ reason, detail })
        return { triggered: true, reason, detail, requestId: 'request-123' }
      },
    )

    assert.deepEqual(calls, [{ reason: 'action_impossible', detail: 'candidate set exhausted' }])
    assert.deepEqual(result, {
      status: 'submitted',
      reason: 'action_impossible',
      detail: 'candidate set exhausted',
      requestId: 'request-123',
    })
  })

  it('reports a typed unavailable result when the controller suppresses the request', () => {
    let calls = 0
    const result = submitSystem2Handoff(
      { reason: 'action_impossible', detail: 'candidate set exhausted' },
      (reason, detail) => {
        calls += 1
        return { triggered: false, reason, detail: 'replan throttle: no new information' }
      },
    )

    assert.equal(calls, 1)
    assert.deepEqual(result, {
      status: 'unavailable',
      reason: 'action_impossible',
      detail: 'candidate set exhausted',
      blocker: 'replan throttle: no new information',
    })
  })

  it('reports when the resident controller is no longer available', () => {
    const result = submitSystem2Handoff(
      { reason: 'queue_empty', detail: 'the current horizon ended' },
      () => null,
    )

    assert.deepEqual(result, {
      status: 'unavailable',
      reason: 'queue_empty',
      detail: 'the current horizon ended',
      blocker: 'controller_not_running',
    })
  })

  it('wires ESCALATE settlement to the dispatcher and never queues the same completion decision', () => {
    const controller = readFileSync(new URL('./src/controller-legacy.ts', import.meta.url), 'utf8')
    const executor = readFileSync(new URL('./src/executor.ts', import.meta.url), 'utf8')
    const candidates = readFileSync(new URL('./src/candidates.ts', import.meta.url), 'utf8')
    const start = controller.indexOf("if (result.kind === 'ESCALATE') {")
    const end = controller.indexOf("const trigger =", start)
    assert.ok(start >= 0 && end > start, 'ESCALATE settlement branch exists before ordinary completion dispatch')
    const branch = controller.slice(start, end)

    assert.match(branch, /submitSystem2Handoff\(/)
    assert.match(branch, /this\.summonLlm\(summonReason, summonDetail\)/)
    assert.match(branch, /ESCALATE_HANDOFF status=submitted/)
    assert.match(branch, /ESCALATE_HANDOFF status=unavailable/)
    assert.match(branch, /\breturn\b/)
    assert.doesNotMatch(branch, /requestDecision\(trigger, detail\)/)
    assert.match(branch, /pendingTrigger = pickHigherPriority\(this\.pendingTrigger, deferred\)/)
    assert.match(branch, /requestDecision\(deferred\.trigger, deferred\.detail\)/)
    assert.doesNotMatch(executor, /'escalating', 'handed to System 2'/)
    assert.match(executor, /handoff_request_staged/)
    assert.match(candidates, /request System 2 review/)
  })
})
