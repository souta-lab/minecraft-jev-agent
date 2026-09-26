// #11 beta: raw P(abandon) is interpreted at the exact current Option boundary.
import assert from 'node:assert/strict'
import { authorityDecisionMeta } from './src/jev/authority.ts'
import { abandonRequested } from './src/jev.ts'
import type { JevAnswer, JevRequest, JevResult } from './src/jev.ts'

function betaAnswer(probability: number): JevAnswer {
  return {
    name: 'abandon_option',
    type: 'boolean',
    value: probability,
    probability,
    confidence: null,
    probabilities: { true: probability, false: 1 - probability },
    legend: null,
    note: 'fixture',
  }
}

function request(threshold: number, instanceId = 'g7:smelt:iron_ingot'): JevRequest {
  return {
    state: {
      currentOption: {
        instanceId,
        templateId: 'smelt:iron_ingot',
        kind: 'smelt',
        target: { item: 'iron_ingot', count: 3 },
        preconditions: [],
        success: [],
        allowedSkills: ['SMELT'],
        abortThreshold: threshold,
        runtime: { startedAt: 1, verifiedProgress: 0, failures: 2, lastProgressAt: 1 },
      },
    },
  } as unknown as JevRequest
}

function tagged(probability: number, threshold: number): JevResult {
  const answers = { abandon_option: betaAnswer(probability) }
  const authorityDecision = authorityDecisionMeta(request(threshold), answers)
  return {
    callId: 'beta-fixture',
    policy: 'typesafe',
    source: 'jev',
    model: 'typesafe-ai/jev',
    latencyMs: 1,
    usage: null,
    answers,
    authorityDecision,
  } as JevResult & { authorityDecision: typeof authorityDecision }
}

const strict = tagged(0.72, 0.8)
const permissive = tagged(0.72, 0.6)

assert.equal(abandonRequested(strict), false, 'same raw beta stays below this Option threshold')
assert.equal(abandonRequested(permissive), true, 'same raw beta crosses this Option threshold')

const strictMeta = (strict as JevResult & { authorityDecision: ReturnType<typeof authorityDecisionMeta> }).authorityDecision
assert.equal(strictMeta.optionInstanceId, 'g7:smelt:iron_ingot')
assert.equal(strictMeta.optionTemplateId, 'smelt:iron_ingot')
assert.equal(strictMeta.betaProbability, 0.72)
assert.equal(strictMeta.betaThreshold, 0.8)
assert.equal(strictMeta.betaAdopt, false)

// Explicit threshold remains a compatibility/testing override; it must not
// mutate the stamped runtime decision itself.
assert.equal(abandonRequested(permissive, 0.9), false)
assert.equal(
  (permissive as JevResult & { authorityDecision: ReturnType<typeof authorityDecisionMeta> }).authorityDecision.betaAdopt,
  true,
)

process.stdout.write('#11 Option-instance beta threshold: PASS\n')
