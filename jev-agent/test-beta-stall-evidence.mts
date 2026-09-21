// test-beta-stall-evidence.mts - issue #360 §8: beta never abandons.
//
// Measured live (m3-live `run.jsonl`, 2026-09-21T12:46:21.695Z ->
// 2026-09-21T13:34:50.960Z, 48.5 min): 2148 beta outputs, mean 0.25, median 0.25,
// min 0.18, max 0.36, threshold 0.5, `beta >= 0.5: 0`. In the same window there
// were 401 `OSCILLATION_DETECTED`, `goal`/`search` progress 0, and ~0.05%
// locomotion efficiency.
//
// Traced cause: `authorityState()` (jev-authority.ts) showed beta only
// `recentOutcomes` (all verified `progress=body` success), `failedCandidates`,
// `consecutiveFailures`, `lastFailureCode`, `lastPathStatus` and
// `escalationRecommended=false`. It carried NO oscillation count, NO
// state-recurrence evidence and NO zero-semantic-progress clock, while
// `BETA_INSTRUCTIONS` told the model that "body/search progress is real progress"
// and that a local failure is "not semantic exhaustion". The model was asked a
// semantic question with only evidence that the local loop was healthy.
//
// These cases are pure (no bot, no model call).
import assert from 'node:assert/strict'
import { buildAuthorityQuestions } from './src/jev-authority.ts'
import { authorityState } from './src/jev-authority.ts'
import type { StrategicStallEvidence } from './src/strategicStall.ts'

const exhausted: StrategicStallEvidence = {
  optionInstanceId: 'g2:surface:log',
  windowSize: 24,
  distinctStates: 3,
  bodyProgressDecisions: 24,
  semanticProgressDecisions: 0,
  horizon: 24,
  maxDistinctStates: 3,
  exhausted: true,
  exhaustedRepeats: 0,
}

const healthy: StrategicStallEvidence = {
  ...exhausted,
  windowSize: 5,
  distinctStates: 5,
  bodyProgressDecisions: 5,
  exhausted: false,
}

function requestWith(evidence: StrategicStallEvidence | null, oscillationsDetected: number): unknown {
  return {
    stage: 'policy-tick-test',
    candidates: [],
    questionNames: ['action', 'abandon_option'],
    state: {
      tick: 42,
      timestampMs: 0,
      self: { position: { x: 3.5, y: 67, z: 18.5 }, health: 20, food: 18 },
      inventory: { counts: { oak_log: 4 } },
      entities: [],
      blocks: [],
      terrain: { standable: [] },
      craftingTables: [],
      furnaces: [],
      placementSpots: [],
      portalFrameSites: [],
      portalFrame: null,
      descent: null,
      stepCuts: [],
      headroomCuts: [],
      goal: { id: 'g2:surface:log', description: 'recover vertical access to y>=86', targetItem: 'log', requiredCount: 1, startCount: 0, haveCount: 4, progress: 1, complete: false, startedAtMs: 0 },
      goalQueue: { depth: 1, empty: false, current: { id: 'g2:surface:log' } },
      currentOption: { instanceId: 'g2:surface:log', templateId: 'recover_vertical_access' },
      recentOutcomes: [
        { actionId: 'MOVE:p3_67_18', status: 'done', failure: null, verified: true, execution: 'success', verification: 'verified', progress: 'body', progressKinds: ['body'], control: 'none' },
      ],
      recentEvents: [],
      signals: {
        failedCandidates: {},
        consecutiveFailures: 0,
        lastFailureCode: null,
        lastPathStatus: 'success',
        escalationRecommended: false,
        knownResources: [],
        strategicNonProgress: evidence,
        oscillationsDetected,
      },
    },
  }
}

// 1. The recurrence evidence and the oscillation count must reach the model.
const stalledState = authorityState(requestWith(exhausted, 401) as never) as {
  signals: { strategicNonProgress: StrategicStallEvidence | null; oscillationsDetected: number }
}
assert.deepEqual(stalledState.signals.strategicNonProgress, exhausted)
assert.equal(stalledState.signals.oscillationsDetected, 401)

const healthyState = authorityState(requestWith(healthy, 0) as never) as {
  signals: { strategicNonProgress: StrategicStallEvidence | null; oscillationsDetected: number }
}
assert.equal(healthyState.signals.strategicNonProgress?.exhausted, false)
assert.equal(healthyState.signals.oscillationsDetected, 0)

const noOptionState = authorityState(requestWith(null, 0) as never) as {
  signals: { strategicNonProgress: StrategicStallEvidence | null }
}
assert.equal(noOptionState.signals.strategicNonProgress, null)

// 2. The beta question text must teach the model how to read that evidence
//    without turning it into a universal "always abandon" rule.
const questions = buildAuthorityQuestions([], ['abandon_option'])
const beta = questions.abandon_option
assert.ok(beta !== undefined && beta.type === 'boolean')
const instructions = String(beta.instructions)
assert.match(instructions, /strategicNonProgress/)
assert.match(instructions, /exhausted=true/)
assert.match(instructions, /signals\.oscillationsDetected/)
assert.match(instructions, /NOT exhaustion/)
assert.match(instructions, /body\/search progress is real progress/)

process.stdout.write('beta stall evidence (#360 §8): PASS\n')
