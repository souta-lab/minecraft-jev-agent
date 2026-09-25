import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'bun:test'
import { assessReachViability } from './src/vtr/reach-safety.ts'

const controller = readFileSync(new URL('./src/controller-legacy.ts', import.meta.url), 'utf8')

describe('VTR Reach safety wakeups use current viability truth', () => {
  it('does not interrupt a safe active contract for a stale damage or breath event', () => {
    for (const trigger of ['damage_taken', 'hp_changed', 'low_air', 'air_unknown_head_submerged'] as const) {
      const assessment = assessReachViability(trigger, {
        criticalHealth: false,
        needsBreathEscape: false,
        environmentalHazard: false,
        activeThreat: false,
      })
      assert.equal(assessment.safetyTrigger, true)
      assert.equal(assessment.shouldInterrupt, false, `trigger=${trigger} is only a wakeup, not current danger`)
      assert.deepEqual(assessment.unsafeFacts, [])
    }
  })

  it('interrupts on the same current unsafe fact even when no safety event woke the scheduler', () => {
    const assessment = assessReachViability('heartbeat', {
      criticalHealth: false,
      needsBreathEscape: true,
      environmentalHazard: false,
      activeThreat: false,
    })
    assert.equal(assessment.shouldInterrupt, true)
    assert.deepEqual(assessment.unsafeFacts, ['breath_escape_required'])
  })

  it('keeps a noncritical damage edge inside the risk-bounded Reach contract', () => {
    const assessment = assessReachViability('damage_taken', {
      criticalHealth: false,
      needsBreathEscape: false,
      environmentalHazard: false,
      activeThreat: false,
    })
    assert.equal(assessment.shouldInterrupt, false)
    assert.equal(assessment.safetyTrigger, true)
  })

  it('wires the assessment into production and journals ignored stale safety edges', () => {
    assert.match(controller, /assessReachViability\(trigger,\s*\{/)
    assert.match(controller, /active !== null && viability\.shouldInterrupt/)
    assert.match(controller, /safetyInterruption:/)
    assert.match(controller, /VTR_SAFETY_TRIGGER_STALE/)
  })
})
