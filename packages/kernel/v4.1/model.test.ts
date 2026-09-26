import { describe, expect, test } from 'bun:test'
import * as model from './model.ts'

describe('V4.1.2 model compatibility facade', () => {
  test('facade exposes the transactional kernel entrypoints', () => {
    expect(typeof model.createTransitionContract).toBe('function')
    expect(typeof model.createKernelState).toBe('function')
    expect(typeof model.applyKernelCommand).toBe('function')
    expect(typeof model.replayKernelEvents).toBe('function')
    expect(typeof model.recoverKernelFromJournal).toBe('function')
    expect(typeof model.buildJevDecisionFrame).toBe('function')
    expect(typeof model.admitJevDecision).toBe('function')
  })

  test('facade does not expose V4.1.1 unsafe authority helpers', () => {
    const exported = new Set(Object.keys(model))
    for (const unsafe of [
      'grantLeaseBundle', 'releaseTransitionLeases', 'activateTransition',
      'suspendTransition', 'resumeTransition', 'putTransition',
      'mutateTransition', 'removeTransition', 'effectCommitIsCurrent',
      'requestPreemption', 'executePreemption',
    ]) expect(exported.has(unsafe)).toBe(false)
  })
})
