#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { buildVtrObserverReadModel, renderVtrObserverHtml } from './vtr-observer-read-model.mjs'

const sourceSha = 'a'.repeat(40)
const worldKey = { serverId: 'observer-test', dimension: 'minecraft:overworld', worldEpoch: 9 }
const runId = 'run-vtr-read-model'
const generationId = 'generation-vtr-read-model'
const transitionId = 'transition-reach-1'
const contractHash = 'contract-hash-1'
const now = Date.parse('2026-09-25T10:00:03.000Z')
const event = (name, ts, detail = {}) => ({ event: name, ts, detail })
const progress = (sequence, ts, latestPredicateDistance, bestPredicateDistance) => ({
  observedAt: ts,
  sequence,
  latestPredicateDistance,
  bestPredicateDistance,
  reachability: 'reachable',
  frontierId: `frontier-${sequence}`,
  evidenceId: `observation-${sequence}`,
})
const snapshot = {
  observedAt: '2026-09-25T10:00:02.900Z',
  resident: {
    available: true,
    connected: true,
    runId,
    sourceCommit: sourceSha,
    sourceCommitBinding: 'run-BOOT+GENERATION_READY',
    generationId,
    generationBoundary: { observedAt: '2026-09-25T09:59:59.000Z', generationId },
    worldKey,
  },
  mission: {
    status: 'observed',
    id: 'mission:reach-oak',
    title: 'Reach the observed oak log',
    predicate: { kind: 'within-interaction-reach', item: 'oak_log' },
    provenance: { source: 'VTR_TRANSITION_COMMIT.detail.mission', runId, generationId },
  },
  events: [event('HEARTBEAT', '2026-09-25T10:00:02.500Z', { health: 20, food: 20 })],
  truth: { position: { x: 8, y: 64, z: 3 }, dimension: 'minecraft:overworld', health: 20, food: 20, inventory: { oak_log: 0 } },
  vtr: {
    status: 'observed',
    binding: { confidence: 'direct', runId, generationId, sourceSha, worldKey },
    latest: {
      transitionId,
      contractHash,
      status: 'verified_success',
      committedAt: '2026-09-25T10:00:00.000Z',
      mission: { id: 'mission:reach-oak', kind: 'within-interaction-reach', item: 'oak_log' },
      desiredPredicate: { id: 'reach.oak-log', expected: true },
      contract: {
        requires: [{ id: 'world.loaded', expected: true }],
        ensures: [{ id: 'reach.oak-log', expected: true }],
        invariants: [{ id: 'body.alive', expected: true }],
        admissibleEffects: [{ kind: 'locomotion' }],
        budget: { maxMechanicalSteps: 20, risk: { damage: 0 } },
        witness: { id: 'oak_log@8,64,3' },
        progressDefinition: { measure: 'predicate_distance', bodyMotionOnlyCredit: false },
      },
      progressHistory: [
        progress(1, '2026-09-25T10:00:00.100Z', 12, 12),
        progress(2, '2026-09-25T10:00:01.100Z', 8, 8),
        progress(3, '2026-09-25T10:00:02.100Z', 9, 8),
      ],
      progressEvent: event('VTR_TRANSITION_PROGRESS', '2026-09-25T10:00:02.100Z'),
      mechanical: {
        reservationCount: 2,
        steps: [
          { stepId: 'leg-1', leg: 1, status: 'mechanical_outcome_observed', stepOutcome: { status: 'active', outcome: 'CONTINUING' }, actuations: [{ event: event('VTR_TRANSITION_ACTUATION', '2026-09-25T10:00:00.500Z', { authority: 'vtr-transition-controller', candidate: 'MOVE:oak-log' }) }] },
          { stepId: 'leg-2', leg: 2, status: 'mechanical_outcome_observed', stepOutcome: { status: 'terminal', outcome: 'SUCCESS', verified: true }, actuations: [{ event: event('VTR_TRANSITION_ACTUATION', '2026-09-25T10:00:01.500Z', { authority: 'vtr-transition-controller', candidate: 'JUMP:oak-log' }) }] },
        ],
      },
      routeDecision: {
        actor: 'jev', source: 'jev', selectedRoute: { routeId: 'reach:walk', grounded: true },
        routeIds: ['reach:walk', 'reach:jump'], probabilities: { 'reach:walk': 0.7, 'reach:jump': 0.3 },
        actionProbability: 0.7, latencyMs: 42, observedAt: '2026-09-25T10:00:00.050Z',
      },
      actuation: { authority: 'vtr-transition-controller', selectedBy: 'vtr_transition_controller', event: event('VTR_TRANSITION_ACTUATION', '2026-09-25T10:00:01.500Z') },
      verification: { truth: 'TRUE', verified: true, predicates: [{ id: 'reach.oak-log', truth: 'true' }], evidenceIds: ['verify:reach-oak'], event: event('VTR_TRANSITION_VERIFY', '2026-09-25T10:00:02.200Z'), binding: { runId, generationId, sourceSha, worldKey } },
      outcome: { kind: 'SUCCESS', typed: { kind: 'SUCCESS', evidenceIds: ['verify:reach-oak'] }, event: event('VTR_TRANSITION_OUTCOME', '2026-09-25T10:00:02.300Z') },
      binding: { confidence: 'direct', runId, generationId, sourceSha, worldKey },
    },
  },
}

const alignedProbe = {
  readOnly: true,
  status: 'partial',
  binding: { probeRunId: runId, probeGenerationId: generationId, probeWorld: worldKey },
}
const model = buildVtrObserverReadModel(snapshot, { now, currentWorldProbe: alignedProbe })
assert.equal(model.schema, 'ai-buddy-vtr-observer/v1')
assert.equal(model.readOnly, true)
assert.equal(model.run.id, runId)
assert.equal(model.run.sourceCommit, sourceSha)
assert.equal(model.run.generationId, generationId)
assert.equal(model.freshnessMs, 100)
assert.equal(model.vtr.status, 'observed')
assert.equal(model.worldObservation.dimension, 'minecraft:overworld')
assert.equal(model.worldObservation.live, true)
assert.equal(model.mission.predicate.kind, 'within-interaction-reach')
assert.equal(model.transition.transitionId, transitionId)
assert.equal(model.transition.contractHash, contractHash)
assert.equal(model.transition.owner.authority, 'VTR')
assert.equal(model.transition.routingDecision.actor, 'jev')
assert.deepEqual(model.transition.routingDecision.offeredRouteIds, ['reach:walk', 'reach:jump'])
assert.deepEqual(model.transition.routingDecision.probabilities, { 'reach:walk': 0.7, 'reach:jump': 0.3 })
assert.equal(model.transition.routingDecision.routeId, 'reach:walk')
assert.equal(model.transition.routingDecision.selectedProbability, 0.7)
assert.equal(model.transition.progress.latest.latestPredicateDistance, 9)
assert.equal(model.transition.progress.bestPredicateDistance, 8)
assert.equal(model.transition.progress.observationSequence, 3)
assert.equal(model.transition.progress.reachability, 'reachable')
assert.equal(model.transition.progress.evidenceId, 'observation-3')
assert.equal(model.transition.progress.trendStatus, 'no_new_best_observed')
assert.equal(model.transition.progress.lastBestChangeAt, '2026-09-25T10:00:01.100Z')
assert.equal(model.transition.progress.unchangedAgeMs, 1900)
assert.equal(model.transition.mechanical.legCount, 2)
assert.equal(model.transition.mechanical.settledCount, 1)
assert.equal(model.transition.mechanical.activeCount, 1)
assert.equal(model.transition.verification.truth, 'TRUE')
assert.equal(model.transition.verification.verified, true)
assert.equal(model.transition.outcome.kind, 'SUCCESS')
assert.equal(model.transition.outcome.status, 'verified_success')
assert.deepEqual(model.transition.outcome.evidenceIds, ['verify:reach-oak'])
assert.equal(model.world.currentProbe.summaryBinding.status, 'aligned')
assert.equal(Object.hasOwn(model, 'goal'), false)
assert.equal(Object.hasOwn(model, 'option'), false)
assert.equal(Object.hasOwn(model, 'choices'), false)

const singleSample = buildVtrObserverReadModel({
  ...snapshot,
  vtr: { ...snapshot.vtr, latest: { ...snapshot.vtr.latest, progressHistory: [progress(1, '2026-09-25T10:00:02.100Z', 9, 9)] } },
}, { now })
assert.equal(singleSample.transition.progress.status, 'observed')
assert.equal(singleSample.transition.progress.trendStatus, 'unknown')
assert.equal(singleSample.transition.progress.stall.status, 'unknown')
assert.equal(singleSample.transition.progress.unchangedAgeMs, null)
assert.ok(singleSample.unknown.includes('vtr_transition_progress_unavailable_or_insufficient_history'))

const missingHistory = buildVtrObserverReadModel({
  ...snapshot,
  vtr: { ...snapshot.vtr, latest: { ...snapshot.vtr.latest, progressHistory: [] } },
}, { now })
assert.equal(missingHistory.transition.progress.status, 'unknown')
assert.equal(missingHistory.transition.progress.trendStatus, 'unknown')
assert.equal(missingHistory.transition.progress.reachability, 'unknown')
assert.equal(missingHistory.transition.progress.evidenceId, null)

const secretSnapshot = {
  ...snapshot,
  mission: { ...snapshot.mission, title: 'Bearer hiddenCredential123' },
  vtr: { ...snapshot.vtr, latest: { ...snapshot.vtr.latest, contract: { ...snapshot.vtr.latest.contract, privateToken: 'hidden-value' } } },
}
const redactedModel = buildVtrObserverReadModel(secretSnapshot, { now })
assert.match(redactedModel.mission.title, /Bearer \[REDACTED\]/)
assert.doesNotMatch(JSON.stringify(redactedModel), /hiddenCredential123|hidden-value|privateToken/)

const mismatchedProbe = buildVtrObserverReadModel(snapshot, {
  now,
  currentWorldProbe: { ...alignedProbe, binding: { ...alignedProbe.binding, probeWorld: { ...worldKey, worldEpoch: 10 } } },
})
assert.equal(mismatchedProbe.world.currentProbe.summaryBinding.status, 'mismatch')

const incompleteIdentity = buildVtrObserverReadModel({
  ...snapshot,
  vtr: { ...snapshot.vtr, binding: { ...snapshot.vtr.binding, worldKey: { serverId: 'observer-test', dimension: 'minecraft:overworld' } } },
}, { now })
assert.equal(incompleteIdentity.transition, null)
assert.ok(incompleteIdentity.unknown.includes('vtr_run_generation_source_world_boundary_unavailable'))

const unverifiedSuccess = buildVtrObserverReadModel({
  ...snapshot,
  vtr: { ...snapshot.vtr, latest: {
    ...snapshot.vtr.latest,
    status: 'success_without_verified_predicate',
    verification: { ...snapshot.vtr.latest.verification, truth: 'FALSE', verified: false },
  } },
}, { now })
assert.equal(unverifiedSuccess.transition.outcome.kind, 'SUCCESS')
assert.equal(unverifiedSuccess.transition.outcome.status, 'terminal')
assert.equal(unverifiedSuccess.transition.verification.verified, false)
assert.ok(unverifiedSuccess.unknown.includes('vtr_deterministic_verification_not_true'))

const html = renderVtrObserverHtml()
for (const heading of ['ミッション', '遷移', '所有者 / 経路', '実行した機械的ステップ', '決定的検証 / 型付き結果', '証拠の鮮度', '候補経路', '候補ごとの確率', '不明 / 未確認の項目']) {
  assert.ok(html.includes(heading), `human view renders ${heading}`)
}
assert.ok(html.includes("new EventSource('/events')"))
assert.ok(html.includes("fetch('/api/vtr-view'"))
assert.doesNotMatch(html, /s\.goal|s\.option|betaAuthority|GoalQueue|OptionLedger/)

console.log('vtr-observer-read-model: PASS')
