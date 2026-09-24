// test-gating.mts - model danger scores are evidence, never action authority.
//
// Run: bun run gating-test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'bun:test'
import { CRITICAL_COMBAT_HEALTH, restrictCandidatesAtCriticalHealth } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { decisionIdFrom } from './src/jev.ts'
import type { JevAnswer, JevResult } from './src/jev.ts'
import { gateDanger, DANGER_CONFIDENCE_THRESHOLD } from './src/gating.ts'
import { shouldPreemptActiveActionLease } from './src/scheduler.ts'

function dangerAnswer(value: number | null, confidence: number | null): JevAnswer {
  return {
    name: 'danger',
    type: 'score',
    value: value ?? 0,
    probability: null,
    confidence,
    probabilities: {},
    legend: ['safe', 'minor risk', 'dangerous', 'lethal'],
    note: null,
  }
}

function candidate(id: string, kind: Candidate['kind']): Candidate {
  return {
    id,
    kind,
    label: id,
    targetName: null,
    target: null,
    targetEntityId: kind === 'ATTACK' ? 7 : null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: {},
  }
}

const attack = candidate('ATTACK:e7', 'ATTACK')
const retreat = candidate('RETREAT:p1', 'RETREAT')
test('a high danger score remains evidence and cannot replace a valid Jev ATTACK', () => {
  const answer = dangerAnswer(3, 0.9)
  const highDanger: JevResult = {
    callId: 'danger-evidence',
    policy: 'typesafe',
    source: 'jev',
    model: 'test-model',
    latencyMs: 1,
    usage: null,
    answers: {
      action: {
        name: 'action',
        type: 'choice',
        value: 'ATTACK:e7',
        probability: 0.62,
        confidence: 0.8,
        probabilities: { 'ATTACK:e7': 0.62, 'RETREAT:p1': 0.38 },
        legend: null,
        note: null,
      },
      danger: answer,
    },
  }
  const classified = gateDanger(answer)
  assert.equal(classified.value, 3)
  assert.equal(classified.confidence, 0.9)
  assert.equal(classified.confidenceQualified, true)
  assert.match(classified.reason, /diagnostic only, no action authority/)

  // Pin the real selection path as well as the score parser: high danger evidence
  // must leave a valid Jev ATTACK untouched when RETREAT is also offered.
  const selectedId = decisionIdFrom(highDanger)
  assert.equal(selectedId, 'ATTACK:e7')
  assert.ok([attack.id, retreat.id].includes(selectedId ?? ''))
  const controllerSource = readFileSync(new URL('./src/controller-legacy.ts', import.meta.url), 'utf8')
  assert.match(controllerSource, /const dangerGate = gateDanger\(decision\.answers\.danger\)/)
  assert.match(controllerSource, /let chosenId = heldId/)
  assert.match(controllerSource, /dangerOverride: null/)
  assert.doesNotMatch(controllerSource, /applyDangerGate\s*\(/)
})

test('a low-confidence danger score remains visible as unqualified evidence', () => {
  const lowConfidence = gateDanger(dangerAnswer(0.91, 0.09))
  assert.equal(lowConfidence.value, 0.91)
  assert.equal(lowConfidence.confidenceQualified, false)
  assert.equal(lowConfidence.threshold, DANGER_CONFIDENCE_THRESHOLD)
})

test('exact code-owned low-health safety still interrupts ATTACK and narrows work choices', () => {
  assert.equal(
    shouldPreemptActiveActionLease('hp_changed', 'ATTACK', CRITICAL_COMBAT_HEALTH, CRITICAL_COMBAT_HEALTH),
    true,
  )
  assert.equal(
    shouldPreemptActiveActionLease('hp_changed', 'ATTACK', CRITICAL_COMBAT_HEALTH + 0.01, CRITICAL_COMBAT_HEALTH),
    false,
  )
  assert.equal(shouldPreemptActiveActionLease('action_completed', 'ATTACK', 1, CRITICAL_COMBAT_HEALTH), false)
  const work = candidate('MINE:b1', 'MINE')
  const criticalChoices = restrictCandidatesAtCriticalHealth(
    {
      self: { health: CRITICAL_COMBAT_HEALTH },
      entities: [{ hostile: true, distance: 1 }],
    } as never,
    [attack, retreat, work],
  )
  assert.deepEqual(criticalChoices.map(({ id }) => id), ['ATTACK:e7', 'RETREAT:p1'])
})
