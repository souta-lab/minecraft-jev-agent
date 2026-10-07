import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'bun:test'
import { shouldHoldDecisionForQueueEmptyPlan } from './src/system2-plane.ts'

describe('empty-queue System2 reconsideration boundary', () => {
  it('holds stale tactical dispatch only while a fresh System2 WHAT is pending, preserving the unique safety reflex', () => {
    assert.equal(shouldHoldDecisionForQueueEmptyPlan(true, true, false), true)
    assert.equal(shouldHoldDecisionForQueueEmptyPlan(true, false, false), false)
    assert.equal(shouldHoldDecisionForQueueEmptyPlan(false, true, false), false)
    assert.equal(shouldHoldDecisionForQueueEmptyPlan(true, true, true), false)
  })

  it('applies the hold after queue-empty summon and before any ordinary typed decision', () => {
    const controller = readFileSync(new URL('./src/controller.ts', import.meta.url), 'utf8')
    const tickStart = controller.indexOf('private async tick(trigger: DecisionTrigger')
    const tickEnd = controller.indexOf('\n  private jevLog(', tickStart)
    const tick = controller.slice(tickStart, tickEnd)
    const summon = tick.indexOf("this.summonLlm('queue_empty'")
    const hold = tick.indexOf('system2plane.shouldHoldDecisionForQueueEmptyPlan(', summon)
    const choice = tick.indexOf('await this.decide(state, candidates, trigger, causalStamp.chainId)', hold)

    assert.ok(tickStart >= 0 && tickEnd > tickStart)
    assert.ok(summon >= 0 && hold > summon && choice > hold)
    assert.match(tick.slice(hold, choice), /SYSTEM2_QUEUE_EMPTY_DECISION_HELD[\s\S]*?\breturn\b/)
  })
})
