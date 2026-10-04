#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAiSummary, buildObserverSnapshot, buildWorldProbe, createObserver, parseBuddyLogLine, parseDetail, parseRunnerOutEvents, parseVtrRunJsonlEvents, projectVtrTransitions, readVtrRunJsonlEvents, startObserverServer } from './buddy-observer.mjs'
import { buildVtrObserverReadModel, renderVtrObserverHtml } from './vtr-observer-read-model.mjs'

// Constructing the always-on service must remain safe when no active mission
// source exists; repository milestone labels are not runtime mission evidence.
const observerWithoutRun = createObserver({ runtimeDir: '/tmp/observer-without-live-run' })
assert.equal(observerWithoutRun.mission, null)

const detail = parseDetail('action=MINE:b1 abandon=0.37 decision=continue goals=["collect 3 x iron","smelt 3 x iron_ingot"] note="has spaces"')
assert.equal(detail.action, 'MINE:b1')
assert.equal(detail.abandon, 0.37)
assert.equal(detail.decision, 'continue')
assert.deepEqual(detail.goals, ['collect 3 x iron', 'smelt 3 x iron_ingot'])
assert.equal(detail.note, 'has spaces')

const parsed = parseBuddyLogLine('[2026-09-21T12:00:00.000Z] JEV_HEADS action=MINE:b1 abandon=0.37 decision=continue betaAuthority=false')
assert.equal(parsed?.event, 'JEV_HEADS')
assert.equal(parsed?.detail.action, 'MINE:b1')
assert.equal(parsed?.detail.betaAuthority, false)

const fatalEvents = parseRunnerOutEvents([
  '[2026-09-21T12:00:00.000Z] BOOT pid=1 runId=run-1 source=abc',
  '[policy] FATAL {"trigger":"block_broken","code":"MODEL_UNAVAILABLE","context":"jev-authority","attempts":4,"error":"GatewayInternalServerError: Service unavailable; Bearer abc123"}',
  '[2026-09-21T12:00:10.000Z] ERROR code=MODEL_UNAVAILABLE action=terminate-resident pid=1 exitCode=1',
], { runId: 'run-1', bootTs: '2026-09-21T12:00:00.000Z' })
assert.equal(fatalEvents.length, 1)
assert.equal(fatalEvents[0]?.ts, '2026-09-21T12:00:10.000Z')
assert.equal(fatalEvents[0]?.detail.runId, 'run-1')
assert.equal(fatalEvents[0]?.detail.context, 'jev-authority')
assert.match(fatalEvents[0]?.detail.error ?? '', /Bearer \[REDACTED\]/)
assert.doesNotMatch(fatalEvents[0]?.detail.error ?? '', /abc123/)
assert.deepEqual(parseRunnerOutEvents([
  '[2026-09-21T12:00:00.000Z] BOOT pid=1 runId=old source=abc',
  '[policy] FATAL {"code":"MODEL_UNAVAILABLE","context":"jev-authority"}',
  '[2026-09-21T12:00:10.000Z] ERROR code=MODEL_UNAVAILABLE action=terminate-resident pid=1 exitCode=1',
], { runId: 'run-2', bootTs: '2026-09-21T12:01:00.000Z' }), [])

const report = {
  ok: true,
  data: {
    runId: 'run-1',
    connected: true,
    frozen: false,
    generationId: 'gen-7',
    generationHash: 'abc123',
    milestone: 'iron_pickaxe',
    worldKey: { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 1 },
    status: {
      rungId: 'diamond',
      rungIndex: 9,
      policyKind: 'jev',
      policyProvider: 'typesafe-ai',
      policyModel: 'typesafe-ai/jev',
      system2AuthorityStack: { provider: 'local-mercury', model: 'deterministic|mercury:qwen3.5-9b-local' },
      system2LastAuthority: { provider: 'mercury', model: 'qwen3.5-9b-local' },
      deterministicFallbackEnabled: false,
      queue: {
        depth: 2,
        done: 4,
        revision: 11,
        current: {
          id: 'g5',
          kind: 'collect',
          description: 'collect 3 x raw_iron',
          status: 'active',
          targetItem: 'raw_iron',
          haveCount: 1,
          requiredCount: 3,
          semanticOptionIntent: 'rebuild equipment',
          semanticOptionTemplateId: 'collect:raw_iron',
          semanticOptionInstanceId: 'collect:raw_iron#c3',
        },
      },
      currentAction: { id: 'MINE:b1', kind: 'MINE', phase: 'running', startedAt: 1 },
      truth: { position: { x: 1, y: 62, z: 3 }, health: 18, food: 17, dimension: 'minecraft:overworld', onGround: true, inventory: { raw_iron: 1 } },
    },
  },
}

const observerSourceSha = 'a'.repeat(40)
const observerWorldKey = { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 1 }
const observerRunMetadata = (runId = 'run-1', generationId = 'gen-7') => ({
  runArtifactsMatched: true,
  sourceSha: observerSourceSha,
  sourceShaConflict: false,
  acceptance: { runId, gitCommit: observerSourceSha, generationId },
  predicates: { runId, sourceSha: observerSourceSha, generationId },
})
const observerBoot = (runId = 'run-1', ts = '2026-09-21T11:59:59.000Z', worldKey = observerWorldKey) => parseBuddyLogLine(
  `[${ts}] BOOT pid=1 runId=${runId} source=${observerSourceSha} worldKey=${JSON.stringify(worldKey)}`,
)
const observerGenerationReady = (generationId = 'gen-7', ts = '2026-09-21T12:00:00.000Z') => parseBuddyLogLine(
  `[${ts}] GENERATION_READY runId=run-1 id=${generationId} generationId=${generationId} sourceSha=${observerSourceSha}`,
)

const events = [
  parseBuddyLogLine('[2026-09-21T12:00:00.000Z] SYSTEM2_AUTHORITY_INPUT provider=mercury model=qwen3.5-9b-local trigger=post_death reason=no_progress'),
  parseBuddyLogLine('[2026-09-21T12:00:01.000Z] SYSTEM2_AUTHORITY_DECISION provider=mercury model=qwen3.5-9b-local trigger=post_death strategy=rebuild_equipment goals=["collect 3 x raw_iron"]'),
  parseBuddyLogLine('[2026-09-21T12:00:02.000Z] JEV_HEADS action=MINE:b1 abandon=0.37 decision=continue betaAuthority=false'),
  parseBuddyLogLine('[2026-09-21T12:00:03.000Z] ACTION n=9 id=MINE:b1 kind=MINE phase=running rung=diamond'),
].filter((event) => event !== null)

const anchoredEvents = events.map((event) => ({ ...event, detail: { ...event.detail, generationId: 'gen-7' } }))
const snapshot = buildObserverSnapshot({
  report,
  events: anchoredEvents,
  mission: {
    id: 'M4',
    title: 'Ender Dragon',
    provenance: { source: 'SYSTEM2_AUTHORITY_INPUT.humanMission', runId: 'run-1', generationId: 'gen-7' },
  },
  runBoot: observerBoot(),
  runMetadata: observerRunMetadata(),
  runGenerationReady: observerGenerationReady(),
  now: 1_795_000_000_000,
})
assert.equal(snapshot.resident.connected, true)
assert.equal(snapshot.goal.frontier, 'diamond')
assert.equal(snapshot.goal.queue.current?.description, 'collect 3 x raw_iron')
assert.equal(snapshot.option?.intent, 'rebuild equipment')
assert.equal(snapshot.decisionTrace.jev?.detail.action, 'MINE:b1')
assert.equal(snapshot.decisionTrace.system2Decision?.detail.strategy, 'rebuild_equipment')
assert.equal(snapshot.action?.kind, 'MINE')
assert.equal(snapshot.authority.system2?.last?.model, 'qwen3.5-9b-local')
assert.deepEqual(snapshot.mission, {
  status: 'observed',
  id: 'M4',
  title: 'Ender Dragon',
  provenance: {
    status: 'run_generation_bound',
    source: 'SYSTEM2_AUTHORITY_INPUT.humanMission',
    runId: 'run-1',
    generationId: 'gen-7',
    sourceCommit: observerSourceSha,
  },
})

const unavailableMissionSnapshot = buildObserverSnapshot({
  report: { ok: false, error: 'resident-unavailable' },
  events: [],
  // A static repository label alone is not current-run mission evidence.
  mission: { id: 'M4', title: 'Ender Dragon' },
})
assert.deepEqual(unavailableMissionSnapshot.mission, {
  status: 'unknown',
  id: null,
  title: null,
  provenance: {
    status: 'unbound',
    source: null,
    runId: null,
    generationId: null,
    reason: 'mission_live_run_identity_unavailable',
  },
})
assert.ok(buildAiSummary(unavailableMissionSnapshot).unknown.includes('mission_live_run_identity_unavailable'))
const unknownVtrReadModel = buildVtrObserverReadModel(unavailableMissionSnapshot, { now: Date.parse('2026-09-21T12:00:03.000Z') })
assert.equal(unknownVtrReadModel.schema, 'ai-buddy-vtr-observer/v1')
assert.equal(unknownVtrReadModel.mission.status, 'unknown')
assert.equal(unknownVtrReadModel.transition, null)
assert.equal(unknownVtrReadModel.status.available, false)
assert.ok(unknownVtrReadModel.unknown.includes('live_run_identity_unavailable'))
assert.equal(Object.hasOwn(unknownVtrReadModel, 'goal'), false)
assert.equal(Object.hasOwn(unknownVtrReadModel, 'option'), false)
assert.equal(Object.hasOwn(unknownVtrReadModel, 'choices'), false)

const missionWithoutSourceSnapshot = buildObserverSnapshot({
  report,
  events: anchoredEvents,
  mission: { id: 'M4', title: 'Ender Dragon' },
  runBoot: observerBoot(),
  runMetadata: observerRunMetadata(),
  runGenerationReady: observerGenerationReady(),
})
assert.equal(missionWithoutSourceSnapshot.mission.status, 'unknown')
assert.equal(missionWithoutSourceSnapshot.mission.id, null)
assert.equal(missionWithoutSourceSnapshot.mission.title, null)
assert.equal(missionWithoutSourceSnapshot.mission.provenance.reason, 'mission_source_unavailable')

const crossRunMissionSnapshot = buildObserverSnapshot({
  report,
  events: anchoredEvents,
  mission: {
    id: 'M4',
    title: 'Ender Dragon',
    provenance: { source: 'SYSTEM2_AUTHORITY_INPUT.humanMission', runId: 'run-prior', generationId: 'gen-7' },
  },
  runBoot: observerBoot(),
  runMetadata: observerRunMetadata(),
  runGenerationReady: observerGenerationReady(),
})
assert.equal(crossRunMissionSnapshot.mission.status, 'unknown')
assert.equal(crossRunMissionSnapshot.mission.id, null)
assert.equal(crossRunMissionSnapshot.mission.title, null)
assert.equal(crossRunMissionSnapshot.mission.provenance.reason, 'mission_source_run_mismatch')

const laggedGenerationEvents = [
  parseBuddyLogLine(`[2026-09-23T19:36:20.000Z] BOOT pid=1 runId=run-observer-1 source=${observerSourceSha} worldKey=${JSON.stringify(observerWorldKey)}`),
  parseBuddyLogLine(`[2026-09-23T19:36:23.559Z] GENERATION_READY runId=run-observer-1 id=gen-current generationId=gen-current sourceSha=${observerSourceSha}`),
  parseBuddyLogLine('[2026-09-23T19:36:28.302Z] JEV_HEADS action=MOVE:b99_67_79 generationId=gen-current'),
  parseBuddyLogLine('[2026-09-23T19:36:35.344Z] HEARTBEAT pos=99,67,79 generationId=gen-current'),
].filter((event) => event !== null)
const laggedGenerationMetadata = {
  runArtifactsMatched: true,
  sourceSha: observerSourceSha,
  sourceShaConflict: false,
  acceptance: { runId: 'run-observer-1', gitCommit: observerSourceSha, generationId: 'gen-prior' },
  predicates: { runId: 'run-observer-1', sourceSha: observerSourceSha, generationId: 'gen-older' },
}
const laggedGenerationSnapshot = buildObserverSnapshot({
  report: { ...report, data: { ...report.data, runId: 'run-observer-1', generationId: 'gen-current' } },
  events: laggedGenerationEvents,
  mission: { id: 'M3', title: 'Nether progression' },
  runBoot: laggedGenerationEvents[0],
  runMetadata: laggedGenerationMetadata,
  runGenerationReady: laggedGenerationEvents[1],
  now: Date.parse('2026-09-23T19:36:47.952Z'),
})
const laggedGenerationSummary = buildAiSummary(laggedGenerationSnapshot, { now: Date.parse('2026-09-23T19:36:47.952Z') })
assert.equal(laggedGenerationSnapshot.resident.sourceCommit, observerSourceSha)
assert.equal(laggedGenerationSnapshot.resident.generationBoundary?.generationId, 'gen-current')
assert.equal(laggedGenerationSnapshot.resident.generationBoundary?.artifactGenerations.acceptance.status, 'different_from_live_generation')
assert.equal(laggedGenerationSnapshot.resident.generationBoundary?.artifactGenerations.predicates.status, 'different_from_live_generation')
assert.equal(laggedGenerationSnapshot.decisionTrace.jev?.detail.action, 'MOVE:b99_67_79')
assert.equal(laggedGenerationSummary.worldObservation?.live, true)
assert.equal(laggedGenerationSummary.unknown.includes('current_generation_boundary_unavailable'), false)
assert.equal(laggedGenerationSummary.unknown.includes('no_choice_event_observed'), false)
assert.equal(laggedGenerationSummary.unknown.includes('world_heartbeat_stale_or_missing'), false)

const unboundGenerationSnapshot = buildObserverSnapshot({
  report: { ...report, data: { ...report.data, runId: 'run-observer-1', generationId: 'gen-current' } },
  events: laggedGenerationEvents,
  mission: { id: 'M3', title: 'Nether progression' },
  runBoot: laggedGenerationEvents[0],
  runMetadata: {
    ...laggedGenerationMetadata,
    predicates: { ...laggedGenerationMetadata.predicates, sourceSha: 'b'.repeat(40) },
  },
  runGenerationReady: laggedGenerationEvents[1],
})
assert.equal(unboundGenerationSnapshot.resident.generationBoundary, null)
assert.equal(unboundGenerationSnapshot.decisionTrace.jev, null)
assert.equal(unboundGenerationSnapshot.mission.status, 'unknown')
assert.equal(unboundGenerationSnapshot.mission.id, null)
assert.equal(unboundGenerationSnapshot.mission.title, null)
assert.equal(unboundGenerationSnapshot.mission.provenance.reason, 'mission_current_generation_boundary_unavailable')

// Same-world minor reload: GENERATION_READY carries the minor's new sourceSha
// while BOOT and the acceptance artifacts keep the host-boot sha. The split is
// designed reload provenance, not a conflict — the generation must still bind
// and the live generation sha becomes the reported sourceCommit.
const reloadSourceSha = 'c'.repeat(40)
const reloadedGenerationEvents = [
  laggedGenerationEvents[0],
  parseBuddyLogLine(`[2026-09-23T19:40:23.559Z] GENERATION_READY runId=run-observer-1 id=gen-reloaded generationId=gen-reloaded sourceSha=${reloadSourceSha}`),
  parseBuddyLogLine('[2026-09-23T19:40:28.302Z] JEV_HEADS action=MOVE:b99_67_79 generationId=gen-reloaded sourceSha=' + reloadSourceSha),
].filter((event) => event !== null)
const reloadedGenerationSnapshot = buildObserverSnapshot({
  report: { ...report, data: { ...report.data, runId: 'run-observer-1', generationId: 'gen-reloaded' } },
  events: reloadedGenerationEvents,
  mission: {
    id: 'M3',
    title: 'Nether progression',
    provenance: { source: 'SYSTEM2_AUTHORITY_INPUT.humanMission', runId: 'run-observer-1', generationId: 'gen-reloaded' },
  },
  runBoot: reloadedGenerationEvents[0],
  runMetadata: laggedGenerationMetadata,
  runGenerationReady: reloadedGenerationEvents[1],
  now: Date.parse('2026-09-23T19:40:47.952Z'),
})
assert.equal(reloadedGenerationSnapshot.resident.generationBoundary?.generationId, 'gen-reloaded')
assert.equal(reloadedGenerationSnapshot.resident.sourceCommit, reloadSourceSha)
assert.equal(reloadedGenerationSnapshot.resident.sourceCommitConflict, false)
assert.equal(reloadedGenerationSnapshot.mission.status, 'observed')
assert.equal(reloadedGenerationSnapshot.decisionTrace.jev?.detail.action, 'MOVE:b99_67_79')

// V4 live missions and Reach transitions are visible before HOST writes the
// final acceptance artifact. The run/generation/source/world chain itself is
// sufficient for read-only live projection.
const vtrMission = { id: 'run-mission:oak_log:1', kind: 'inventory_at_least', item: 'oak_log', count: 1 }
const vtrWorldKey = 'local|overworld|1'
const vtrTransitionId = 'transition-live-1'
const vtrContractHash = 'contract-live-1'
const vtrIdentity = {
  worldKey: vtrWorldKey,
  dimension: 'overworld',
  worldEpoch: 1,
  generationId: 'gen-7',
  leaseId: 'gen-7',
}
const vtrCommitRecord = {
  record: 'agent-event',
  ts: '2026-09-21T12:00:01.000Z',
  tick: 3,
  source: 'vtr',
  level: 'info',
  message: `VTR_TRANSITION_COMMIT id=${vtrTransitionId} ensures=reach.resource-source contractHash=${vtrContractHash}`,
  detail: {
    transitionId: vtrTransitionId,
    contractHash: vtrContractHash,
    mission: vtrMission,
    desiredPredicate: { id: 'reach.resource-source', proposition: { kind: 'within-interaction-reach-of-resource-source', item: 'oak_log' }, expected: true },
    requires: [{ id: 'mission.unsatisfied', expected: true }],
    ensures: [{ id: 'reach.resource-source', expected: true }],
    invariants: [{ id: 'body.alive', expected: true }],
    admissibleEffects: [{ kind: 'locomotion', maxUses: null }],
    budget: { maxMechanicalSteps: 24, maxElapsedMs: 120000, resources: {}, risk: { damage: 1 } },
    progressDefinition: { measure: 'predicate_distance', predicateId: 'reach.resource-source', evidenceBasis: 'grounded_world_observation', bodyMotionOnlyCredit: false },
    identity: vtrIdentity,
    witness: { witnessId: 'oak_log@6,63,489', target: { x: 6, y: 63, z: 489 } },
    initialRouteIds: ['MOVE:b6_63_489'],
    routePolicy: 'nearest grounded admissible route within the committed Reach predicate',
  },
}
const vtrJournalEvents = parseVtrRunJsonlEvents([
  vtrCommitRecord,
  {
    record: 'agent-event', ts: '2026-09-21T12:00:01.250Z', source: 'vtr',
    message: `VTR_TRANSITION_PROGRESS id=${vtrTransitionId}`,
    detail: { transitionId: vtrTransitionId, contractHash: vtrContractHash, progress: { latestPredicateDistance: 9, bestPredicateDistance: 8, reachability: 'reachable', observationSequence: 3, frontierId: 'frontier-3', evidenceId: 'world-observation-3' } },
  },
  {
    record: 'agent-event', ts: '2026-09-21T12:00:01.050Z', source: 'vtr',
    message: `VTR_TRANSITION_PROGRESS id=${vtrTransitionId}`,
    detail: { transitionId: vtrTransitionId, contractHash: vtrContractHash, progress: { latestPredicateDistance: 12, bestPredicateDistance: 12, reachability: 'reachable', observationSequence: 1, frontierId: 'frontier-1', evidenceId: 'world-observation-1' } },
  },
  {
    record: 'agent-event', ts: '2026-09-21T12:00:01.150Z', source: 'vtr',
    message: `VTR_TRANSITION_PROGRESS id=${vtrTransitionId}`,
    detail: { transitionId: vtrTransitionId, contractHash: vtrContractHash, progress: { latestPredicateDistance: 8, bestPredicateDistance: 8, reachability: 'reachable', observationSequence: 2, frontierId: 'frontier-2', evidenceId: 'world-observation-2' } },
  },
  {
    record: 'agent-event', ts: '2026-09-21T12:00:01.100Z', source: 'vtr',
    message: `VTR_TRANSITION_ACTUATION id=${vtrTransitionId}`,
    detail: { transitionId: vtrTransitionId, contractHash: vtrContractHash, candidate: 'MOVE:b6_63_489', target: { x: 5, y: 63, z: 490 }, selectedBy: 'vtr_transition_controller', authority: 'vtr-transition-controller', leaseEpoch: 1 },
  },
  {
    record: 'agent-event', ts: '2026-09-21T12:00:02.000Z', source: 'vtr',
    message: `VTR_TRANSITION_VERIFY id=${vtrTransitionId} truth=TRUE`,
    detail: {
      transitionId: vtrTransitionId, contractHash: vtrContractHash, truth: 'TRUE',
      predicates: [{ id: 'reach.resource-source', expected: true, truth: 'true', evidenceId: 'verify:3:oak_log@6,63,489' }],
      evidenceIds: ['verify:3:oak_log@6,63,489'], verifiedAtMs: 1790000002000,
      runId: 'run-1', generationId: 'gen-7', sourceSha: observerSourceSha,
      worldKey: vtrWorldKey, worldEpoch: 1, dimension: 'overworld',
      identityMatches: true, predicatesVerified: true,
    },
  },
  {
    record: 'agent-event', ts: '2026-09-21T12:00:02.010Z', source: 'vtr',
    message: `VTR_TRANSITION_OUTCOME id=${vtrTransitionId} outcome=SUCCESS`,
    detail: {
      transitionId: vtrTransitionId, contractHash: vtrContractHash,
      outcome: { kind: 'SUCCESS', contractHash: vtrContractHash, evidenceIds: ['verify:3:oak_log@6,63,489'] },
      boundary: 'mechanical-step-outcome',
      usage: { mechanicalSteps: 1, elapsedMs: 1000, resources: {}, risk: {}, effects: { locomotion: 1 } },
      metrics: { verifiedTransitionCompletion: 1, mechanicalStepsPerTransition: 1, jevCallsPerTransition: 0, modelCallsPerMechanicalStep: 0, typedTerminalOutcome: 'SUCCESS', duplicateAuthority: false },
    },
  },
])
assert.equal(vtrJournalEvents.length, 7)
const vtrBoot = parseBuddyLogLine(`[2026-09-21T11:59:59.000Z] BOOT pid=1 runId=run-1 source=${observerSourceSha} worldKey=${JSON.stringify(observerWorldKey)} mission={"kind":"inventory_at_least","item":"oak_log","count":1,"source":"BUDDY_MISSION_* or default"}`)
const vtrReady = observerGenerationReady('gen-7', '2026-09-21T12:00:00.000Z')
const liveVtrSnapshot = buildObserverSnapshot({
  report: { ...report, data: { ...report.data, worldKey: { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 1 } } },
  events: [vtrBoot, vtrReady, ...vtrJournalEvents],
  runBoot: vtrBoot,
  runMetadata: {
    runArtifactsMatched: false,
    sourceSha: null,
    sourceShaConflict: false,
    acceptance: null,
    predicates: { runId: 'run-1', sourceSha: observerSourceSha, generationId: 'gen-7' },
  },
  runGenerationReady: vtrReady,
  now: Date.parse('2026-09-21T12:00:03.000Z'),
})
assert.equal(liveVtrSnapshot.resident.generationBoundary?.generationId, 'gen-7')
assert.equal(liveVtrSnapshot.resident.sourceCommit, observerSourceSha)
assert.equal(liveVtrSnapshot.resident.sourceCommitBinding, 'run-BOOT+GENERATION_READY')
assert.equal(liveVtrSnapshot.mission.status, 'observed')
assert.equal(liveVtrSnapshot.mission.provenance.source, 'VTR_TRANSITION_COMMIT.detail.mission')
assert.deepEqual(liveVtrSnapshot.mission.predicate, { kind: 'inventory_at_least', item: 'oak_log', count: 1 })
assert.equal(liveVtrSnapshot.vtr.latest.transitionId, vtrTransitionId)
assert.equal(liveVtrSnapshot.vtr.latest.status, 'verified_success')
assert.equal(liveVtrSnapshot.vtr.latest.verification.verified, true)
assert.equal(liveVtrSnapshot.vtr.latest.outcome.metrics.jevCallsPerTransition, 0)
assert.equal(liveVtrSnapshot.vtr.latest.modelMetrics, null, 'legacy outcome call totals must not fabricate a model-metrics event')
assert.equal(liveVtrSnapshot.vtr.latest.modelMetrics?.jevModelProviderEvaluateAttempts ?? null, null, 'provider attempts are unknown without their event')
assert.equal(liveVtrSnapshot.vtr.latest.modelMetricsEventCount, 0)
assert.equal(liveVtrSnapshot.vtr.latest.modelMetricsConsistency.status, 'UNKNOWN')
assert.equal(liveVtrSnapshot.vtr.latest.modelMetricsConsistency.mechanicalSteps.status, 'UNKNOWN')
assert.equal(liveVtrSnapshot.vtr.latest.modelMetricsConsistency.typedTerminalOutcome.status, 'UNKNOWN')
assert.equal(liveVtrSnapshot.vtr.latest.progressHistory.length, 3)
assert.equal(liveVtrSnapshot.vtr.latest.contract.progressDefinition.bodyMotionOnlyCredit, false)
const liveVtrReadModel = buildVtrObserverReadModel(liveVtrSnapshot, { now: Date.parse('2026-09-21T12:00:03.000Z') })
assert.equal(liveVtrReadModel.schema, 'ai-buddy-vtr-observer/v1')
assert.equal(liveVtrReadModel.readOnly, true)
assert.equal(liveVtrReadModel.run.id, 'run-1')
assert.equal(liveVtrReadModel.run.sourceCommit, observerSourceSha)
assert.equal(liveVtrReadModel.run.generationId, 'gen-7')
assert.equal(liveVtrReadModel.transition.id, vtrTransitionId)
assert.equal(liveVtrReadModel.transition.contractHash, vtrContractHash)
assert.equal(liveVtrReadModel.transition.owner.authority, 'VTR')
assert.equal(liveVtrReadModel.transition.progress.latest.latestPredicateDistance, 9)
assert.equal(liveVtrReadModel.transition.progress.bestPredicateDistance, 8)
assert.equal(liveVtrReadModel.transition.progress.observationSequence, 3)
assert.equal(liveVtrReadModel.transition.progress.reachability, 'reachable')
assert.equal(liveVtrReadModel.transition.progress.evidenceId, 'world-observation-3')
assert.equal(liveVtrReadModel.transition.progress.trendStatus, 'no_new_best_observed')
assert.equal(liveVtrReadModel.transition.progress.lastBestChangeAt, '2026-09-21T12:00:01.150Z')
assert.equal(liveVtrReadModel.transition.progress.unchangedAgeMs, 1850)
assert.equal(liveVtrReadModel.transition.verification.truth, 'TRUE')
assert.equal(liveVtrReadModel.transition.verification.verified, true)
assert.equal(liveVtrReadModel.transition.outcome.kind, 'SUCCESS')
assert.equal(liveVtrReadModel.transition.outcome.evidenceIds[0], 'verify:3:oak_log@6,63,489')
for (const legacyKey of ['goal', 'option', 'choices', 'authority', 'recentChoiceOutcomes']) {
  assert.equal(Object.hasOwn(liveVtrReadModel, legacyKey), false, `primary VTR read model excludes legacy ${legacyKey}`)
}
const liveVtrSummary = buildAiSummary(liveVtrSnapshot, { now: Date.parse('2026-09-21T12:00:03.000Z') })
assert.equal(liveVtrSummary.choices.jev, null)
assert.equal(liveVtrSummary.choices.jevStatus, 'not_recorded')
assert.equal(liveVtrSummary.choices.vtr.latestDecision.actor, 'vtr')
assert.equal(liveVtrSummary.choices.latest.actor, 'vtr')
assert.equal(liveVtrSummary.transition.status, 'verified_success')
assert.equal(liveVtrSummary.unknown.includes('no_choice_event_observed'), false)
assert.match(liveVtrSummary.headline, /VTR outcome=SUCCESS; predicate verification=TRUE/)

const unacceptedLiveRunSnapshot = buildObserverSnapshot({
  report: { ...report, data: { ...report.data, worldKey: observerWorldKey } },
  events: [vtrBoot, vtrReady, ...vtrJournalEvents],
  runBoot: vtrBoot,
  runMetadata: {
    runArtifactsMatched: false,
    sourceSha: null,
    sourceShaConflict: false,
    acceptance: null,
    predicates: { record: 'milestone-predicates', runId: 'run-1', sourceSha: observerSourceSha, generationId: 'gen-7' },
  },
  runGenerationReady: vtrReady,
})
assert.equal(unacceptedLiveRunSnapshot.resident.generationBoundary?.generationId, 'gen-7')
assert.equal(unacceptedLiveRunSnapshot.resident.sourceCommit, observerSourceSha)
assert.equal(unacceptedLiveRunSnapshot.mission.status, 'observed')
assert.equal(unacceptedLiveRunSnapshot.vtr.latest.status, 'verified_success')

const mismatchedBootWorld = observerBoot('run-1', '2026-09-21T11:59:59.000Z', {
  serverId: 'other-server', dimension: 'minecraft:overworld', worldEpoch: 1,
})
const mismatchedBootWorldSnapshot = buildObserverSnapshot({
  report: { ...report, data: { ...report.data, worldKey: observerWorldKey } },
  events: [mismatchedBootWorld, vtrReady, ...vtrJournalEvents],
  runBoot: mismatchedBootWorld,
  runMetadata: {
    runArtifactsMatched: false,
    sourceSha: null,
    sourceShaConflict: false,
    acceptance: null,
    predicates: { record: 'milestone-predicates', runId: 'run-1', sourceSha: observerSourceSha, generationId: 'gen-7' },
  },
  runGenerationReady: vtrReady,
})
assert.equal(mismatchedBootWorldSnapshot.resident.generationBoundary, null)
assert.equal(mismatchedBootWorldSnapshot.vtr.status, 'unknown')
assert.equal(mismatchedBootWorldSnapshot.mission.status, 'unknown')

const mismatchedReadyWorld = parseBuddyLogLine(
  `[2026-09-21T12:00:00.000Z] GENERATION_READY runId=run-1 id=gen-7 generationId=gen-7 sourceSha=${observerSourceSha} worldKey={"serverId":"other-server","dimension":"minecraft:overworld","worldEpoch":1}`,
)
const mismatchedReadyWorldSnapshot = buildObserverSnapshot({
  report: { ...report, data: { ...report.data, worldKey: observerWorldKey } },
  events: [vtrBoot, mismatchedReadyWorld, ...vtrJournalEvents],
  runBoot: vtrBoot,
  runMetadata: { runArtifactsMatched: false, sourceSha: null, sourceShaConflict: false, acceptance: null, predicates: null },
  runGenerationReady: mismatchedReadyWorld,
})
assert.equal(mismatchedReadyWorldSnapshot.resident.generationBoundary, null)
assert.equal(mismatchedReadyWorldSnapshot.vtr.status, 'unknown')

const bootMissionSnapshot = buildObserverSnapshot({
  report: { ...report, data: { ...report.data, worldKey: { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 1 } } },
  events: [vtrBoot, vtrReady],
  runBoot: vtrBoot,
  runMetadata: { runArtifactsMatched: false, sourceSha: null, sourceShaConflict: false, acceptance: null, predicates: null },
  runGenerationReady: vtrReady,
})
assert.equal(bootMissionSnapshot.mission.status, 'observed')
assert.equal(bootMissionSnapshot.mission.id, null)
assert.equal(bootMissionSnapshot.mission.title, 'Acquire 1 oak_log')
assert.equal(bootMissionSnapshot.mission.provenance.source, 'BOOT.detail.mission')
assert.deepEqual(bootMissionSnapshot.mission.predicate, { kind: 'inventory_at_least', item: 'oak_log', count: 1 })

// A later stale-source/world transition cannot displace the live transition;
// a wrong-run VERIFY cannot close it either.
const staleVtrEvents = parseVtrRunJsonlEvents([
  {
    record: 'agent-event', ts: '2026-09-21T12:00:02.100Z', source: 'vtr',
    message: 'VTR_TRANSITION_COMMIT id=stale-source',
    detail: {
      transitionId: 'stale-source', contractHash: 'stale-contract', mission: { id: 'prior', kind: 'inventory_at_least', item: 'stone', count: 1 },
      identity: { ...vtrIdentity, sourceSha: 'b'.repeat(40) },
    },
  },
  {
    record: 'agent-event', ts: '2026-09-21T12:00:02.200Z', source: 'vtr',
    message: `VTR_TRANSITION_COMMIT id=stale-world`,
    detail: { transitionId: 'stale-world', contractHash: 'stale-world-contract', identity: { ...vtrIdentity, worldKey: 'other|overworld|1' } },
  },
  {
    record: 'agent-event', ts: '2026-09-21T12:00:02.250Z', source: 'vtr',
    message: 'VTR_TRANSITION_COMMIT id=stale-generation',
    detail: { transitionId: 'stale-generation', contractHash: 'stale-generation-contract', identity: { ...vtrIdentity, generationId: 'gen-prior' } },
  },
  {
    record: 'agent-event', ts: '2026-09-21T12:00:02.300Z', source: 'vtr',
    message: `VTR_TRANSITION_VERIFY id=${vtrTransitionId} truth=FALSE`,
    detail: {
      transitionId: vtrTransitionId, contractHash: vtrContractHash, truth: 'FALSE', runId: 'run-prior',
      generationId: 'gen-7', sourceSha: observerSourceSha, worldKey: vtrWorldKey,
      identityMatches: true, predicatesVerified: true,
    },
  },
])
const staleIdentitySnapshot = buildObserverSnapshot({
  report: { ...report, data: { ...report.data, worldKey: { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 1 } } },
  events: [vtrBoot, vtrReady, ...vtrJournalEvents, ...staleVtrEvents],
  runBoot: vtrBoot,
  runMetadata: { runArtifactsMatched: false, sourceSha: null, sourceShaConflict: false, acceptance: null, predicates: { runId: 'run-1', sourceSha: observerSourceSha, generationId: 'gen-7' } },
  runGenerationReady: vtrReady,
})
assert.equal(staleIdentitySnapshot.vtr.transitions.length, 1)
assert.equal(staleIdentitySnapshot.vtr.latest.transitionId, vtrTransitionId)
assert.equal(staleIdentitySnapshot.vtr.latest.status, 'verified_success')

// Exercise the live observer ingress, not only the pure projector: a
// structured VTR journal commit + bound Jev route choice + VERIFY + terminal
// outcome must preserve Jev's route decision separately from VTR admission.
const ingressRuntimeDir = mkdtempSync(join(tmpdir(), 'buddy-observer-vtr-ingress-'))
const ingressRunId = 'run-observer-vtr-ingress'
const ingressGenerationId = 'gen-observer-vtr-ingress'
const ingressSourceSha = 'c'.repeat(40)
const ingressWorldKey = 'observer-local|overworld|44'
const ingressContractHash = 'contract-observer-vtr-ingress'
const ingressTransitionId = 'transition-observer-vtr-ingress'
const ingressMission = { id: 'mission:oak-log', kind: 'inventory_at_least', item: 'oak_log', count: 1 }
const ingressBootTs = '2026-09-21T12:59:59.000Z'
const ingressReadyTs = '2026-09-21T13:00:00.000Z'
const ingressCommitTs = '2026-09-21T13:00:01.000Z'
const ingressRouteTs = '2026-09-21T13:00:01.050Z'
const ingressRouteMirrorTs = '2026-09-21T13:00:01.051Z'
const ingressIntentRefusedTs = '2026-09-21T13:00:01.052Z'
const ingressLegacyRevokedTs = '2026-09-21T13:00:01.055Z'
const ingressLegOneReserveTs = '2026-09-21T13:00:01.060Z'
const ingressLegOneActuationTs = '2026-09-21T13:00:01.065Z'
const ingressLegOneOutcomeTs = '2026-09-21T13:00:01.070Z'
const ingressLegTwoReserveTs = '2026-09-21T13:00:01.080Z'
const ingressLegTwoActuationTs = '2026-09-21T13:00:01.085Z'
const ingressLegTwoOutcomeTs = '2026-09-21T13:00:01.090Z'
const ingressVerifyTs = '2026-09-21T13:00:02.000Z'
const ingressOutcomeTs = '2026-09-21T13:00:02.010Z'
const ingressModelMetricsTs = '2026-09-21T13:00:02.015Z'
const ingressOrphanTs = '2026-09-21T13:00:02.020Z'
const ingressWorld = {
  serverId: 'observer-local',
  dimension: 'minecraft:overworld',
  worldEpoch: 44,
}
const ingressContractIdentity = {
  runId: ingressRunId,
  generationId: ingressGenerationId,
  sourceSha: ingressSourceSha,
  worldKey: ingressWorldKey,
  dimension: 'overworld',
  worldEpoch: 44,
}
const ingressCommit = {
  record: 'agent-event',
  ts: ingressCommitTs,
  source: 'vtr',
  message: `VTR_TRANSITION_COMMIT id=${ingressTransitionId} ensures=reach.resource-source contractHash=${ingressContractHash}`,
  detail: {
    runId: ingressRunId,
    generationId: ingressGenerationId,
    sourceSha: ingressSourceSha,
    worldKey: ingressWorldKey,
    dimension: 'overworld',
    worldEpoch: 44,
    transitionId: ingressTransitionId,
    contractHash: ingressContractHash,
    mission: ingressMission,
    desiredPredicate: { id: 'reach.resource-source', proposition: { kind: 'within-interaction-reach-of-resource-source', item: 'oak_log' }, expected: true },
    requires: [{ id: 'mission.unsatisfied', expected: true }],
    ensures: [{ id: 'reach.resource-source', expected: true }],
    invariants: [{ id: 'body.alive', expected: true }],
    admissibleEffects: [{ kind: 'locomotion', maxUses: null }],
    budget: { maxMechanicalSteps: 24, maxElapsedMs: 120000, resources: {}, risk: { damage: 1 } },
    identity: ingressContractIdentity,
  },
}
const ingressRouteDetail = {
  transitionId: ingressTransitionId,
  contractHash: ingressContractHash,
  desiredPredicate: { id: 'reach.resource-source' },
  routeIds: ['reach:oak-log:walk', 'reach:oak-log:jump'],
  selectedRouteId: 'reach:oak-log:jump',
  source: 'jev',
  policy: 'typesafe',
  model: 'typesafe-ai/jev',
  callId: 'jev-reach-route-call-1',
  latencyMs: 27,
  actionProbability: 0.72,
  probabilities: { 'reach:oak-log:walk': 0.28, 'reach:oak-log:jump': 0.72 },
  identity: {
    worldKey: ingressWorldKey,
    dimension: 'overworld',
    worldEpoch: 44,
    generationId: ingressGenerationId,
    leaseId: ingressGenerationId,
  },
}
const ingressRouteRecord = {
  record: 'agent-event',
  ts: ingressRouteTs,
  source: 'vtr',
  message: `VTR_REACH_ROUTE_DECISION transition=${ingressTransitionId} selected=reach:oak-log:jump source=jev policy=typesafe model=typesafe-ai/jev`,
  detail: ingressRouteDetail,
}
const ingressBoundRouteDetail = { ...ingressRouteDetail, ...ingressContractIdentity }
const ingressRouteMirrorLine = `[${ingressRouteMirrorTs}] VTR_REACH_ROUTE_DECISION ${Object.entries(ingressBoundRouteDetail)
  .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ')}`
const ingressVerify = {
  record: 'agent-event',
  ts: ingressVerifyTs,
  source: 'vtr',
  message: `VTR_TRANSITION_VERIFY id=${ingressTransitionId} truth=TRUE`,
  detail: {
    runId: ingressRunId,
    generationId: ingressGenerationId,
    sourceSha: ingressSourceSha,
    worldKey: ingressWorldKey,
    dimension: 'overworld',
    worldEpoch: 44,
    transitionId: ingressTransitionId,
    contractHash: ingressContractHash,
    truth: 'TRUE',
    predicates: [{ id: 'reach.resource-source', expected: true, truth: 'true', evidenceId: 'verify:observer-vtr-ingress' }],
    evidenceIds: ['verify:observer-vtr-ingress'],
    identityMatches: true,
    predicatesVerified: true,
  },
}
const ingressOutcome = {
  record: 'agent-event',
  ts: ingressOutcomeTs,
  source: 'vtr',
  message: `VTR_TRANSITION_OUTCOME id=${ingressTransitionId} outcome=SUCCESS`,
  detail: {
    runId: ingressRunId,
    generationId: ingressGenerationId,
    sourceSha: ingressSourceSha,
    worldKey: ingressWorldKey,
    dimension: 'overworld',
    worldEpoch: 44,
    transitionId: ingressTransitionId,
    contractHash: ingressContractHash,
    outcome: { kind: 'SUCCESS', contractHash: ingressContractHash, evidenceIds: ['verify:observer-vtr-ingress'] },
    usage: { mechanicalSteps: 2, elapsedMs: 1000, resources: {}, risk: {}, effects: { locomotion: 2 } },
    metrics: { verifiedTransitionCompletion: 1, mechanicalStepsPerTransition: 2, jevCallsPerTransition: 0, typedTerminalOutcome: 'SUCCESS', duplicateAuthority: false },
  },
}
const ingressStepEvent = (ts, event, detail, message) => ({
  record: 'agent-event',
  ts,
  source: 'vtr',
  message,
  detail: { ...ingressContractIdentity, transitionId: ingressTransitionId, contractHash: ingressContractHash, ...detail },
})
const ingressIntentRefused = ingressStepEvent(
  ingressIntentRefusedTs,
  'VTR_RUNTIME_INTENT_REFUSED',
  { intentId: 'intent-refused', routeId: 'MOVE:stale', reason: 'route-not-in-current-observation' },
  `VTR_RUNTIME_INTENT_REFUSED transition=${ingressTransitionId} intent=intent-refused reason=route-not-in-current-observation`,
)
const ingressLegacyActuationRevoked = ingressStepEvent(
  ingressLegacyRevokedTs,
  'VTR_ORPHAN_ACTUATION_REVOKED',
  { actionId: 'MOVE:legacy', authority: 'legacy', reason: 'vtr-transition-owns-body' },
  `VTR_ORPHAN_ACTUATION_REVOKED transition=${ingressTransitionId} action=MOVE:legacy`,
)
const ingressModelMetrics = ingressStepEvent(
  ingressModelMetricsTs,
  'VTR_TRANSITION_MODEL_METRICS',
  {
    typedTerminalOutcome: 'SUCCESS',
    mechanicalSteps: 2,
    jevDecisionFrameInvocations: 2,
    jevDecisionFramesPerMechanicalStep: 1,
    jevModelProviderEvaluateAttempts: 5,
    jevModelProviderEvaluateAttemptsPerMechanicalStep: 2.5,
    policy: 'jev-reach-route',
    model: 'model-as-recorded',
    provider: 'provider-as-recorded',
    identity: ingressContractIdentity,
  },
  `VTR_TRANSITION_MODEL_METRICS transitionId=${ingressTransitionId} contractHash=${ingressContractHash} outcome=SUCCESS mechanicalSteps=2 decisionFrameInvocations=2 providerEvaluateAttempts=5`,
)
const ingressMechanicalRecords = [
  ingressStepEvent(
    ingressLegOneReserveTs,
    'VTR_MECHANICAL_STEP_RESERVED',
    { intentId: 'intent-leg-1', stepId: 'step-leg-1', leg: 1, effectKind: 'locomotion', usage: { mechanicalSteps: 1 } },
    `VTR_MECHANICAL_STEP_RESERVED transition=${ingressTransitionId} step=step-leg-1 leg=1`,
  ),
  ingressStepEvent(
    ingressLegOneActuationTs,
    'VTR_TRANSITION_ACTUATION',
    { intentId: 'intent-leg-1', stepId: 'step-leg-1', candidate: 'MOVE:oak-1', target: { x: 5, y: 63, z: 490 }, selectedBy: 'vtr_transition_controller', authority: 'vtr-transition-controller', leaseEpoch: 1 },
    `VTR_TRANSITION_ACTUATION id=${ingressTransitionId} step=step-leg-1`,
  ),
  ingressStepEvent(
    ingressLegOneOutcomeTs,
    'VTR_MECHANICAL_STEP_OUTCOME',
    {
      intentId: 'intent-leg-1', stepId: 'step-leg-1', leg: 1, status: 'active', outcome: 'CONTINUING',
      verified: false, contractHash: ingressContractHash, identity: ingressContractIdentity,
      observedAtMs: Date.parse(ingressLegOneOutcomeTs), usage: { mechanicalSteps: 1 },
    },
    `VTR_MECHANICAL_STEP_OUTCOME transition=${ingressTransitionId} step=step-leg-1 leg=1 status=active outcome=CONTINUING verified=false`,
  ),
  ingressStepEvent(
    ingressLegTwoReserveTs,
    'VTR_MECHANICAL_STEP_RESERVED',
    { intentId: 'intent-leg-2', stepId: 'step-leg-2', leg: 2, effectKind: 'locomotion', usage: { mechanicalSteps: 2 } },
    `VTR_MECHANICAL_STEP_RESERVED transition=${ingressTransitionId} step=step-leg-2 leg=2`,
  ),
  ingressStepEvent(
    ingressLegTwoActuationTs,
    'VTR_TRANSITION_ACTUATION',
    { intentId: 'intent-leg-2', stepId: 'step-leg-2', candidate: 'MOVE:oak-2', target: { x: 6, y: 63, z: 490 }, selectedBy: 'vtr_transition_controller', authority: 'vtr-transition-controller', leaseEpoch: 2 },
    `VTR_TRANSITION_ACTUATION id=${ingressTransitionId} step=step-leg-2`,
  ),
  ingressStepEvent(
    ingressLegTwoOutcomeTs,
    'VTR_MECHANICAL_STEP_OUTCOME',
    {
      intentId: 'intent-leg-2', stepId: 'step-leg-2', leg: 2, status: 'terminal', outcome: 'SUCCESS',
      verified: true, contractHash: ingressContractHash, identity: ingressContractIdentity,
      observedAtMs: Date.parse(ingressLegTwoOutcomeTs), usage: { mechanicalSteps: 2 },
    },
    `VTR_MECHANICAL_STEP_OUTCOME transition=${ingressTransitionId} step=step-leg-2 leg=2 status=terminal outcome=SUCCESS verified=true`,
  ),
  ingressStepEvent(
    '2026-09-21T13:00:01.091Z',
    'VTR_MECHANICAL_OUTCOME',
    { intentId: 'intent-leg-2', result: { actionId: 'MOVE:oak-2', status: 'completed', verified: true } },
    `VTR_MECHANICAL_OUTCOME transition=${ingressTransitionId} intent=intent-leg-2 status=completed`,
  ),
]
const ingressOrphanActionOutcome = ingressStepEvent(
  ingressOrphanTs,
  'VTR_ORPHAN_ACTION_OUTCOME',
  { intentId: 'intent-leg-2', result: { actionId: 'MOVE:oak-2', status: 'cancelled', verified: false, skillOutcome: 'LEASE_REVOKED', failure: 'cancelled' } },
  `VTR_ORPHAN_ACTION_OUTCOME transition=${ingressTransitionId} intent=intent-leg-2 action=MOVE:oak-2 status=cancelled`,
)
const wrongBoundaryRecord = (ts, id, identityOverrides) => ({
  record: 'agent-event',
  ts,
  source: 'vtr',
  message: `VTR_TRANSITION_COMMIT id=${id} ensures=stale contractHash=${id}-contract`,
  detail: {
    runId: identityOverrides.runId ?? ingressRunId,
    generationId: identityOverrides.generationId ?? ingressGenerationId,
    sourceSha: identityOverrides.sourceSha ?? ingressSourceSha,
    worldKey: identityOverrides.worldKey ?? ingressWorldKey,
    transitionId: id,
    contractHash: `${id}-contract`,
    mission: { id: `stale:${id}`, kind: 'inventory_at_least', item: 'stone', count: 1 },
    identity: { ...ingressContractIdentity, ...identityOverrides },
  },
})
const wrongRouteBoundaryRecord = (ts, overrides) => ({
  record: 'agent-event',
  ts,
  source: 'vtr',
  message: `VTR_REACH_ROUTE_DECISION transition=${ingressTransitionId} selected=stale-route source=jev`,
  detail: { ...ingressBoundRouteDetail, ...overrides },
})
const wrongRunVerify = {
  ...ingressVerify,
  ts: '2026-09-21T13:00:03.000Z',
  message: `VTR_TRANSITION_VERIFY id=${ingressTransitionId} truth=FALSE`,
  detail: { ...ingressVerify.detail, runId: 'run-prior', truth: 'FALSE', identityMatches: false, predicatesVerified: false },
}
const ingressRecords = [
  ingressCommit,
  ingressRouteRecord,
  ingressIntentRefused,
  ingressLegacyActuationRevoked,
  ...ingressMechanicalRecords,
  ingressVerify,
  ingressOutcome,
  ingressModelMetrics,
  ingressOrphanActionOutcome,
  wrongRouteBoundaryRecord('2026-09-21T13:00:02.100Z', { runId: 'run-prior' }),
  wrongRouteBoundaryRecord('2026-09-21T13:00:02.200Z', { generationId: 'gen-prior' }),
  wrongRouteBoundaryRecord('2026-09-21T13:00:02.300Z', { sourceSha: 'd'.repeat(40) }),
  wrongRouteBoundaryRecord('2026-09-21T13:00:02.400Z', { worldKey: 'other-world|overworld|44' }),
  wrongBoundaryRecord('2026-09-21T13:00:03.100Z', 'wrong-run', { runId: 'run-prior' }),
  wrongBoundaryRecord('2026-09-21T13:00:03.200Z', 'wrong-generation', { generationId: 'gen-prior' }),
  wrongBoundaryRecord('2026-09-21T13:00:03.300Z', 'wrong-source', { sourceSha: 'd'.repeat(40) }),
  wrongBoundaryRecord('2026-09-21T13:00:03.400Z', 'wrong-world', { worldKey: 'other-world|overworld|44' }),
  wrongRunVerify,
]

mkdirSync(join(ingressRuntimeDir, 'data', 'resident'), { recursive: true })
mkdirSync(join(ingressRuntimeDir, 'logs', 'jev'), { recursive: true })
writeFileSync(join(ingressRuntimeDir, 'buddy.log'), [
  `[${ingressBootTs}] BOOT pid=1 runId=${ingressRunId} source=${ingressSourceSha} worldKey=${JSON.stringify(ingressWorld)}`,
  `[${ingressReadyTs}] GENERATION_READY runId=${ingressRunId} id=${ingressGenerationId} generationId=${ingressGenerationId} sourceSha=${ingressSourceSha}`,
  ingressRouteMirrorLine,
].join('\n') + '\n')
writeFileSync(join(ingressRuntimeDir, 'data', 'resident', `milestone-predicates-${ingressRunId}.json`), JSON.stringify({
  record: 'milestone-predicates', runId: ingressRunId, generationId: ingressGenerationId, sourceSha: ingressSourceSha,
}))
assert.equal(existsSync(join(ingressRuntimeDir, 'data', 'resident', `acceptance-${ingressRunId}.json`)), false)
writeFileSync(join(ingressRuntimeDir, 'logs', 'jev', 'run.jsonl'), ingressRecords.map((record) => JSON.stringify(record)).join('\n') + '\n')
const ingressSocketPath = join(ingressRuntimeDir, 'data', 'resident', 'control.sock')
const ingressReportData = {
  ...report.data,
  runId: ingressRunId,
  generationId: ingressGenerationId,
  worldKey: ingressWorld,
}
const ingressControlServer = createServer((socket) => {
  let pending = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    pending += chunk
    const newline = pending.indexOf('\n')
    if (newline < 0) return
    const request = JSON.parse(pending.slice(0, newline))
    socket.end(`${JSON.stringify({ id: request.id, ok: true, data: ingressReportData })}\n`)
  })
})
try {
  await new Promise((resolve, reject) => {
    ingressControlServer.once('error', reject)
    ingressControlServer.listen(ingressSocketPath, resolve)
  })
  const ingressSnapshot = await createObserver({ runtimeDir: ingressRuntimeDir }).snapshot()
  const ingressSummary = buildAiSummary(ingressSnapshot)
  assert.equal(ingressSnapshot.vtr.transitions.length, 1, 'run/generation/source/world mismatches must not enter the live VTR projection')
  assert.equal(ingressSnapshot.resident.sourceCommit, ingressSourceSha)
  assert.equal(ingressSnapshot.resident.sourceCommitBinding, 'run-BOOT+GENERATION_READY')
  assert.equal(ingressSnapshot.resident.generationBoundary?.generationId, ingressGenerationId)
  assert.equal(ingressSnapshot.vtr.latest.status, 'verified_success')
  assert.equal(ingressSnapshot.vtr.latest.routeDecision.actor, 'jev')
  assert.equal(ingressSnapshot.vtr.latest.routeDecision.selectedRoute.grounded, true)
  assert.equal(ingressSnapshot.vtr.latest.routeDecision.selectedRoute.routeId, 'reach:oak-log:jump')
  assert.equal(ingressSnapshot.vtr.latestRouteDecision.source, 'jev')
  assert.equal(ingressSnapshot.vtr.latestRouteDecision.model, 'typesafe-ai/jev')
  assert.equal(ingressSnapshot.vtr.latestRouteDecision.callId, 'jev-reach-route-call-1')
  assert.equal(ingressSnapshot.vtr.latestRouteDecision.binding.runId, ingressRunId)
  assert.equal(ingressSnapshot.vtr.latestRouteDecision.binding.generationId, ingressGenerationId)
  assert.equal(ingressSnapshot.vtr.latestRouteDecision.binding.sourceSha, ingressSourceSha)
  assert.deepEqual(ingressSnapshot.vtr.latestRouteDecision.binding.worldKey, ingressWorld)
  assert.deepEqual(ingressSnapshot.vtr.latestRouteDecision.probabilities, {
    'reach:oak-log:walk': 0.28,
    'reach:oak-log:jump': 0.72,
  })
  const ingressVtrReadModel = buildVtrObserverReadModel(ingressSnapshot, {
    now: Date.parse('2026-09-21T13:00:03.000Z'),
  })
  assert.deepEqual(ingressVtrReadModel.transition.routingDecision.offeredRouteIds, [
    'reach:oak-log:walk', 'reach:oak-log:jump',
  ])
  assert.equal(ingressVtrReadModel.transition.routingDecision.routeId, 'reach:oak-log:jump')
  assert.deepEqual(ingressVtrReadModel.transition.routingDecision.probabilities, {
    'reach:oak-log:walk': 0.28,
    'reach:oak-log:jump': 0.72,
  })
  assert.equal(ingressVtrReadModel.transition.routingDecision.selectedProbability, 0.72)
  assert.equal(ingressVtrReadModel.transition.owner.authority, 'VTR')
  assert.equal(ingressSnapshot.vtr.latest.verification.truth, 'TRUE')
  assert.equal(ingressSnapshot.vtr.latest.outcome.kind, 'SUCCESS')
  assert.equal(ingressSnapshot.vtr.latest.modelMetricsEventCount, 1)
  assert.equal(ingressSnapshot.vtr.latest.modelMetricsConsistency.status, 'CONSISTENT')
  assert.equal(ingressSnapshot.vtr.latest.modelMetricsConsistency.mechanicalSteps.status, 'CONSISTENT')
  assert.deepEqual(ingressSnapshot.vtr.latest.modelMetricsConsistency.mechanicalSteps.sources, {
    modelMetrics: 2,
    transitionUsage: 2,
    transitionMetric: 2,
    reservations: 2,
    stepOutcomes: 2,
  })
  assert.equal(ingressSnapshot.vtr.latest.modelMetricsConsistency.typedTerminalOutcome.status, 'CONSISTENT')
  assert.deepEqual(ingressSnapshot.vtr.latest.modelMetricsConsistency.typedTerminalOutcome.sources, {
    modelMetrics: 'SUCCESS',
    transitionOutcome: 'SUCCESS',
    transitionMetric: 'SUCCESS',
    terminalStepOutcome: 'SUCCESS',
  })
  assert.deepEqual(ingressSnapshot.vtr.latest.modelMetrics, {
    transitionId: ingressTransitionId,
    contractHash: ingressContractHash,
    typedTerminalOutcome: 'SUCCESS',
    mechanicalSteps: 2,
    jevDecisionFrameInvocations: 2,
    jevDecisionFramesPerMechanicalStep: 1,
    jevModelProviderEvaluateAttempts: 5,
    jevModelProviderEvaluateAttemptsPerMechanicalStep: 2.5,
    policy: 'jev-reach-route',
    model: 'model-as-recorded',
    provider: 'provider-as-recorded',
    identity: ingressContractIdentity,
    observedAt: ingressModelMetricsTs,
    event: {
      ts: ingressModelMetricsTs,
      event: 'VTR_TRANSITION_MODEL_METRICS',
      detail: {
        ...ingressContractIdentity,
        transitionId: ingressTransitionId,
        contractHash: ingressContractHash,
        identity: ingressContractIdentity,
        typedTerminalOutcome: 'SUCCESS',
        mechanicalSteps: 2,
        jevDecisionFrameInvocations: 2,
        jevDecisionFramesPerMechanicalStep: 1,
        jevModelProviderEvaluateAttempts: 5,
        jevModelProviderEvaluateAttemptsPerMechanicalStep: 2.5,
        policy: 'jev-reach-route',
        model: 'model-as-recorded',
        provider: 'provider-as-recorded',
      },
    },
  })
  assert.notEqual(
    ingressSnapshot.vtr.latest.modelMetrics.jevDecisionFrameInvocations,
    ingressSnapshot.vtr.latest.modelMetrics.jevModelProviderEvaluateAttempts,
    'frame invocations must remain distinct from provider evaluate attempts, which include retries',
  )
  assert.equal(ingressSnapshot.vtr.latestRouteDecision.model, 'typesafe-ai/jev', 'metric model/provider labels stay as emitted')
  assert.equal(ingressSnapshot.vtr.latest.mechanical.reservationCount, 2)
  assert.equal(ingressSnapshot.vtr.latest.mechanical.actuationEventCount, 2)
  assert.equal(ingressSnapshot.vtr.latest.mechanical.stepOutcomeEventCount, 2)
  assert.equal(ingressSnapshot.vtr.latest.mechanical.actionOutcomeEventCount, 1)
  assert.equal(ingressSnapshot.vtr.latest.mechanical.mechanicalOutcomeEventCount, 3)
  assert.deepEqual(ingressSnapshot.vtr.latest.lifecycleEvents.map((event) => event.event), [
    'VTR_RUNTIME_INTENT_REFUSED',
    'VTR_ORPHAN_ACTUATION_REVOKED',
    'VTR_ORPHAN_ACTION_OUTCOME',
  ])
  assert.deepEqual(ingressSnapshot.vtr.latest.mechanical.steps.map((step) => ({
    stepId: step.stepId,
    leg: step.leg,
    status: step.status,
    stepOutcome: step.stepOutcome,
    correlation: step.correlation,
    traceEvents: step.trace.map((event) => event.event),
  })), [
    {
      stepId: 'step-leg-1',
      leg: 1,
      status: 'mechanical_outcome_observed',
      stepOutcome: {
        event: 'VTR_MECHANICAL_STEP_OUTCOME',
        stepId: 'step-leg-1',
        leg: 1,
        status: 'active',
        outcome: 'CONTINUING',
        verified: false,
        reason: null,
        contractHash: ingressContractHash,
        identity: ingressContractIdentity,
        observedAtMs: Date.parse(ingressLegOneOutcomeTs),
        usage: { mechanicalSteps: 1 },
        observedAt: ingressLegOneOutcomeTs,
      },
      correlation: { reservation: 'step-id', actuation: 'step-id', outcome: 'step-id' },
      traceEvents: ['VTR_MECHANICAL_STEP_RESERVED', 'VTR_TRANSITION_ACTUATION', 'VTR_MECHANICAL_STEP_OUTCOME'],
    },
    {
      stepId: 'step-leg-2',
      leg: 2,
      status: 'mechanical_outcome_observed',
      stepOutcome: {
        event: 'VTR_MECHANICAL_STEP_OUTCOME',
        stepId: 'step-leg-2',
        leg: 2,
        status: 'terminal',
        outcome: 'SUCCESS',
        verified: true,
        reason: null,
        contractHash: ingressContractHash,
        identity: ingressContractIdentity,
        observedAtMs: Date.parse(ingressLegTwoOutcomeTs),
        usage: { mechanicalSteps: 2 },
        observedAt: ingressLegTwoOutcomeTs,
      },
      correlation: { reservation: 'step-id', actuation: 'step-id', outcome: 'step-id' },
      traceEvents: ['VTR_MECHANICAL_STEP_RESERVED', 'VTR_TRANSITION_ACTUATION', 'VTR_MECHANICAL_STEP_OUTCOME', 'VTR_MECHANICAL_OUTCOME'],
    },
  ])
  const withoutLegTwoStepOutcomeProjection = projectVtrTransitions({
    events: parseVtrRunJsonlEvents(ingressRecords).filter((event) => !(event.event === 'VTR_MECHANICAL_STEP_OUTCOME' && event.detail.stepId === 'step-leg-2')),
    runId: ingressRunId,
    generationId: ingressGenerationId,
    sourceCommit: ingressSourceSha,
    worldKey: ingressWorld,
    generationStartedAt: Date.parse(ingressReadyTs),
  }).latest
  const withoutLegTwoStepOutcome = withoutLegTwoStepOutcomeProjection.mechanical.steps.find((step) => step.stepId === 'step-leg-2')
  assert.equal(withoutLegTwoStepOutcome.stepOutcome, null, 'intent-level action outcomes must not be promoted into step outcomes')
  assert.equal(withoutLegTwoStepOutcome.outcome, null, 'missing exact step marker must remain unobserved')
  assert.equal(withoutLegTwoStepOutcome.intentOutcome.event, 'VTR_MECHANICAL_OUTCOME')
  assert.equal(withoutLegTwoStepOutcome.status, 'intent_outcome_only')
  assert.equal(withoutLegTwoStepOutcome.correlation.outcome, 'intent-id-only')
  assert.equal(withoutLegTwoStepOutcomeProjection.modelMetricsConsistency.mechanicalSteps.status, 'UNKNOWN', 'a missing per-step outcome is incomplete evidence, not an inferred completion')
  assert.deepEqual(withoutLegTwoStepOutcomeProjection.modelMetricsConsistency.mechanicalSteps.missingStepOutcomeIds, ['step-leg-2'])
  assert.equal(withoutLegTwoStepOutcomeProjection.modelMetricsConsistency.typedTerminalOutcome.terminalStepAgreement, 'UNKNOWN')
  assert.equal(withoutLegTwoStepOutcomeProjection.modelMetricsConsistency.status, 'UNKNOWN')

  const inconsistentMetrics = projectVtrTransitions({
    events: parseVtrRunJsonlEvents(ingressRecords).map((event) => event.event === 'VTR_TRANSITION_MODEL_METRICS'
      ? { ...event, detail: { ...event.detail, mechanicalSteps: 3, typedTerminalOutcome: 'BUDGET_EXHAUSTED' } }
      : event),
    runId: ingressRunId,
    generationId: ingressGenerationId,
    sourceCommit: ingressSourceSha,
    worldKey: ingressWorld,
    generationStartedAt: Date.parse(ingressReadyTs),
  }).latest
  assert.equal(inconsistentMetrics.modelMetricsConsistency.status, 'MISMATCH')
  assert.equal(inconsistentMetrics.modelMetricsConsistency.mechanicalSteps.status, 'MISMATCH')
  assert.equal(inconsistentMetrics.modelMetricsConsistency.typedTerminalOutcome.status, 'MISMATCH')

  const withoutOutcome = projectVtrTransitions({
    events: parseVtrRunJsonlEvents(ingressRecords).filter((event) => event.event !== 'VTR_TRANSITION_OUTCOME'),
    runId: ingressRunId,
    generationId: ingressGenerationId,
    sourceCommit: ingressSourceSha,
    worldKey: ingressWorld,
    generationStartedAt: Date.parse(ingressReadyTs),
  }).latest
  assert.equal(withoutOutcome.modelMetricsConsistency.status, 'UNKNOWN', 'missing terminal source must remain unknown')
  assert.equal(withoutOutcome.modelMetricsConsistency.typedTerminalOutcome.status, 'UNKNOWN')
  assert.equal(withoutOutcome.modelMetrics.jevModelProviderEvaluateAttempts, 5, 'provider attempts remain the direct event count, not a terminal fallback')
  assert.equal(ingressSummary.vtr.latest.outcomeConsistency.status, 'contradiction')
  assert.equal(ingressSummary.vtr.latest.outcomeConsistency.contradictions[0].kind, 'orphan_action_after_success')
  assert.equal(ingressSummary.vtr.latest.outcomeConsistency.contradictions[0].actionStatus, 'cancelled')
  assert.match(ingressSummary.headline, /Lifecycle contradiction: orphan action MOVE:oak-2 reported cancelled after Transition SUCCESS \(predicate verification=TRUE\)/)
  assert.equal(ingressSnapshot.vtr.latest.binding.runId, ingressRunId)
  assert.equal(ingressSnapshot.vtr.latest.binding.generationId, ingressGenerationId)
  assert.equal(ingressSnapshot.vtr.latest.binding.sourceSha, ingressSourceSha)
  assert.deepEqual(ingressSnapshot.vtr.latest.binding.worldKey, ingressWorld)
  assert.equal(ingressSnapshot.mission.status, 'observed')
  assert.equal(ingressSnapshot.mission.provenance.source, 'VTR_TRANSITION_COMMIT.detail.mission')
  assert.deepEqual(ingressSnapshot.mission.predicate, { kind: 'inventory_at_least', item: 'oak_log', count: 1 })
  assert.equal(ingressSummary.transition.status, 'verified_success')
  assert.deepEqual(ingressSummary.transition.modelMetrics, ingressSnapshot.vtr.latest.modelMetrics)
  assert.equal(ingressSummary.transition.routeDecision.source, 'jev')
  assert.equal(ingressSummary.choices.vtr.latestDecision.actor, 'jev')
  assert.equal(ingressSummary.choices.vtr.latestDecision.event, 'VTR_REACH_ROUTE_DECISION')
  assert.equal(ingressSummary.choices.vtr.latestDecision.selected.routeId, 'reach:oak-log:jump')
  assert.equal(ingressSummary.choices.vtr.latestDecision.selected.grounded, true)
  assert.equal(ingressSummary.choices.vtr.latestAdmission.actor, 'vtr')
  assert.equal(ingressSummary.choices.jevReachRouteDecision.callId, 'jev-reach-route-call-1')
  assert.equal(ingressSummary.choices.vtr.latestDecision.selected.transitionId, ingressTransitionId)
  assert.equal(ingressSummary.choices.vtr.latestDecision.selected.ensures, 'reach.resource-source')
  assert.equal(ingressSummary.choices.latest.actor, 'jev')
  assert.equal(ingressSummary.choices.latest.selected.transitionId, ingressTransitionId)
  assert.equal(ingressSummary.choices.jevStatus, 'observed')
  assert.equal(ingressSummary.unknown.includes('jev_call_context_unavailable'), false)

  // A mature log pushes both the resident-start BOOT and this generation's
  // GENERATION_READY past the 1MB backward boundary-scan window. The
  // head-anchored scan must still find BOOT and the growing backward scan must
  // still reach READY to bind the generation boundary.
  writeFileSync(join(ingressRuntimeDir, 'buddy.log'), [
    `[${ingressBootTs}] BOOT pid=1 runId=${ingressRunId} source=${ingressSourceSha} worldKey=${JSON.stringify(ingressWorld)}`,
    `[${ingressReadyTs}] GENERATION_READY runId=${ingressRunId} id=${ingressGenerationId} generationId=${ingressGenerationId} sourceSha=${ingressSourceSha}`,
    'x'.repeat(1024 * 1024 + 256 * 1024),
    ingressRouteMirrorLine,
  ].join('\n') + '\n')
  const matureSnapshot = await createObserver({ runtimeDir: ingressRuntimeDir }).snapshot()
  assert.equal(matureSnapshot.resident.generationBoundary?.generationId, ingressGenerationId)
  assert.equal(matureSnapshot.resident.sourceCommit, ingressSourceSha)
  assert.equal(matureSnapshot.resident.sourceCommitBinding, 'run-BOOT+GENERATION_READY')
  assert.equal(matureSnapshot.mission.status, 'observed')
  assert.equal(matureSnapshot.vtr.transitions.length, 1)
} finally {
  await new Promise((resolve) => ingressControlServer.close(resolve))
  rmSync(ingressRuntimeDir, { recursive: true, force: true })
}

const fallbackRouteRecord = {
  record: 'agent-event',
  ts: '2026-09-21T13:00:03.000Z',
  source: 'vtr',
  message: `VTR_REACH_ROUTE_DECISION transition=${ingressTransitionId} selected=reach:oak-log:walk source=fallback policy=fallback`,
  detail: {
    ...ingressBoundRouteDetail,
    selectedRouteId: 'reach:oak-log:walk',
    source: 'fallback',
    policy: 'fallback',
    model: 'fallback-local',
    callId: 'fallback-reach-route-call-1',
    actionProbability: 1,
    probabilities: { 'reach:oak-log:walk': 1 },
  },
}
const fallbackBoot = parseBuddyLogLine(`[${ingressBootTs}] BOOT pid=1 runId=${ingressRunId} source=${ingressSourceSha} worldKey=${JSON.stringify(ingressWorld)}`)
const fallbackReady = parseBuddyLogLine(`[${ingressReadyTs}] GENERATION_READY runId=${ingressRunId} id=${ingressGenerationId} generationId=${ingressGenerationId} sourceSha=${ingressSourceSha}`)
const fallbackRouteSnapshot = buildObserverSnapshot({
  report: { ...report, data: { ...report.data, runId: ingressRunId, generationId: ingressGenerationId, worldKey: ingressWorld } },
  events: [fallbackBoot, fallbackReady, ...parseVtrRunJsonlEvents([ingressCommit, ingressVerify, ingressOutcome, fallbackRouteRecord])],
  runBoot: fallbackBoot,
  runMetadata: {
    runArtifactsMatched: false,
    sourceSha: null,
    sourceShaConflict: false,
    acceptance: null,
    predicates: { runId: ingressRunId, sourceSha: ingressSourceSha, generationId: ingressGenerationId },
  },
  runGenerationReady: fallbackReady,
  now: Date.parse('2026-09-21T13:00:04.000Z'),
})
const fallbackRouteSummary = buildAiSummary(fallbackRouteSnapshot, { now: Date.parse('2026-09-21T13:00:04.000Z') })
assert.equal(fallbackRouteSnapshot.vtr.latestDecision.actor, 'fallback')
assert.equal(fallbackRouteSnapshot.vtr.latestRouteDecision.source, 'fallback')
assert.equal(fallbackRouteSnapshot.vtr.latestRouteDecision.callId, 'fallback-reach-route-call-1')
assert.equal(fallbackRouteSummary.choices.latest.actor, 'fallback')
assert.equal(fallbackRouteSummary.choices.latest.selected.routeId, 'reach:oak-log:walk')
assert.equal(fallbackRouteSummary.choices.jevStatus, 'not_recorded')
assert.equal(fallbackRouteSummary.choices.jevReachRouteDecision, null)

const boundedRunLogDir = mkdtempSync(join(tmpdir(), 'buddy-observer-vtr-'))
try {
  const runLogPath = join(boundedRunLogDir, 'run.jsonl')
  const oversizedEarlierRecord = `${JSON.stringify({ ...vtrCommitRecord, detail: { filler: 'x'.repeat(2048) } })}\n`
  const boundedLaterRecord = `${JSON.stringify({
    record: 'agent-event', ts: '2026-09-21T12:00:02.400Z', source: 'vtr',
    message: 'VTR_REACH_PROBE_HOLD', detail: { reason: 'bounded-tail' },
  })}\n`
  writeFileSync(runLogPath, oversizedEarlierRecord + boundedLaterRecord)
  assert.deepEqual(readVtrRunJsonlEvents(runLogPath, Buffer.byteLength(boundedLaterRecord) + 1).map((entry) => entry.event), ['VTR_REACH_PROBE_HOLD'])
} finally {
  rmSync(boundedRunLogDir, { recursive: true, force: true })
}

const combatEvents = [
  observerBoot('run-1', '2026-09-21T12:00:00.000Z'),
  parseBuddyLogLine('[2026-09-21T12:00:10.000Z] JEV_HEADS action=ATTACK:e1 abandon=0.12 decision=continue chainId=combat-1 generationId=gen-7'),
  parseBuddyLogLine('[2026-09-21T12:00:11.000Z] SKILL_END actionId=ATTACK:e1 outcome=SUCCESS failure=null generationId=gen-7'),
  parseBuddyLogLine('[2026-09-21T12:00:11.010Z] SKILL_OUTCOME_PACKET actionId=ATTACK:e1 terminalReason=done progress=body delta=1 nextDecisionRequired=true generationId=gen-7'),
  parseBuddyLogLine('[2026-09-21T12:00:11.020Z] CAUSAL record=causal chainId=combat-1 candidateId=ATTACK:e1 actionId=ATTACK:e1 verified=true status=done progressDelta=1 generationId=gen-7'),
].filter((event) => event !== null)

const combatCall = {
  record: 'jev-call',
  callId: 'call-current-run',
  ts: '2026-09-21T12:00:10.000Z',
  generationId: 'gen-7',
  policy: 'typesafe-ai',
  model: 'typesafe-ai/jev',
  stage: 'policy-tick-1-start',
  latencyMs: 240,
  response: {
    answers: {
      action: {
        value: 'ATTACK:e1',
        probability: 0.74,
        confidence: 0.8,
        probabilities: { 'ATTACK:e1': 0.74, 'RETREAT:p2': 0.18, WAIT: 0.08 },
        note: 'model-authoritative-pi',
      },
      abandon_option: { value: 0.12, probability: 0.12, probabilities: { true: 0.12, false: 0.88 } },
    },
  },
  error: null,
  state: {
    semantic: {
      world: { dimension: 'overworld', worldEpoch: 1, generationId: null, alive: true, leaseHeld: true },
      safety: { airBand: 'unknown', submerged: true },
    },
    self: {
      position: { x: 10, y: 64, z: 20 },
      dimension: 'overworld',
      health: 16,
      food: 17,
      air: null,
      feetInWater: true,
      eyesInWater: true,
      envHazard: { active: false, drowning: null, kinds: [] },
      heldItem: 'iron_sword',
      armor: { head: null, torso: { name: 'iron_chestplate', count: 1, slot: 6, durabilityUsed: 197, maxDurability: 240 }, legs: null, feet: null },
      offhand: { name: 'shield', count: 1, slot: 45, durabilityUsed: 8, maxDurability: 336 },
    },
    inventory: { iron_sword: 1, ender_pearl: 2 },
    goal: { id: 'g1:collect:log', description: 'collect log', targetItem: 'log', requiredCount: 3, haveCount: 1, progress: 1, complete: false },
    currentOption: { semanticInstanceId: 'collect:log#c3', semanticIntent: 'collect log', allowedSkills: ['BRANCH_MINE'] },
    goalQueue: { depth: 1, empty: false },
    candidates: [
      { id: 'ATTACK:e1', kind: 'ATTACK', label: 'attack skeleton at 4.2m with iron sword', targetName: 'skeleton', meta: { distance: 4.2, weapon: 'iron_sword', targetHostile: true, targetLineOfSight: true } },
      { id: 'RETREAT:p2', kind: 'RETREAT', label: 'move 5m away from skeleton', meta: { threatName: 'skeleton', threatDistance: 4.2, separationGain: 5, outsideReach: true } },
      { id: 'WAIT', kind: 'WAIT', label: 'wait briefly', meta: {} },
    ],
    nearestEntities: [
      { id: 1, name: 'skeleton', kind: 'Hostile mobs', position: { x: 14, y: 64, z: 20 }, distance: 4.2, hostile: true, lineOfSight: true, heldItem: 'bow' },
      { id: 2, name: 'spider', kind: 'Hostile mobs', position: { x: 13, y: 64, z: 21 }, distance: 3.2, hostile: true, lineOfSight: false },
    ],
    nearestBlocks: [{ kind: 'log', name: 'acacia_log', position: { x: 11, y: 68, z: 20 }, distance: 4, diggable: true, inReach: false }],
    signals: {
      threat: { active: true, inDanger: true, inContact: false, hostileCount: 2, threatName: 'skeleton', threatDistance: 4.2, threatHeldItem: 'bow', threatLineOfSight: true },
      knownResources: [{ name: 'acacia_log', kind: 'log', position: { x: 11, y: 68, z: 20 }, dimension: 'minecraft:overworld', worldEpoch: 1 }],
      strategicNonProgress: { optionInstanceId: 'collect:log#c3', windowSize: 4, distinctStates: 2, bodyProgressDecisions: 4, semanticProgressDecisions: 0, horizon: 24, maxDistinctStates: 4, exhausted: false, exhaustedRepeats: 0 },
      oscillationsDetected: 0,
    },
    recentOutcomes: [],
  },
}

const combatSnapshot = buildObserverSnapshot({
  report,
  events: combatEvents,
  mission: { id: 'M4', title: 'Ender Dragon' },
  runBoot: combatEvents[0],
  runMetadata: observerRunMetadata(),
  runGenerationReady: observerGenerationReady('gen-7', '2026-09-21T12:00:01.000Z'),
  jevCalls: [
    { ...combatCall, callId: 'old-run', ts: '2026-09-21T11:59:59.000Z' },
    combatCall,
    { ...combatCall, callId: 'wrong-world-epoch', ts: '2026-09-21T12:00:10.001Z', state: { ...combatCall.state, semantic: { world: { dimension: 'overworld', worldEpoch: 2 } } } },
  ],
  now: Date.parse('2026-09-21T12:00:12.000Z'),
})
const combatSummary = buildAiSummary(combatSnapshot, { now: Date.parse('2026-09-21T12:00:12.000Z') })
assert.equal(combatSummary.choices.jevEvidence.available, true)
assert.equal(combatSummary.choices.jevEvidence.callId, 'call-current-run')
assert.equal(combatSummary.choices.jevEvidence.binding.confidence, 'strong')
assert.equal(combatSummary.choices.jevEvidence.binding.directRunId, false)
assert.equal(combatSummary.choices.jevEvidence.answer.action.value, 'ATTACK:e1')
assert.equal(combatSummary.choices.jevEvidence.selectedCandidate.meta.weapon, 'iron_sword')
assert.ok(combatSummary.choices.jevEvidence.alternatives.some((entry) => entry.id === 'RETREAT:p2'))
assert.equal(combatSummary.choices.jevEvidence.state.threat.primary.threatHeldItem, 'bow')
assert.equal(combatSummary.choices.jevEvidence.state.threat.nearbyHostiles.length, 2)
assert.deepEqual(combatSummary.choices.jevCombatDecision.self.armor, combatCall.state.self.armor)
assert.deepEqual(combatSummary.choices.jevCombatDecision.self.offhand, combatCall.state.self.offhand)
assert.equal(combatSummary.choices.jevEvidence.state.self.air, null)
assert.equal(combatSummary.choices.jevEvidence.state.self.envHazard.drowning, null)
assert.deepEqual(combatSummary.choices.jevEvidence.state.safety, { airBand: 'unknown', submerged: true })
assert.equal(combatSummary.choices.jevCombatDecision.self.air, null)
assert.equal(combatSummary.choices.jevCombatDecision.self.envHazard.drowning, null)
assert.equal(combatSummary.choices.jevEvidence.state.resources.known[0].name, 'acacia_log')
assert.equal(combatSummary.choices.jevEvidence.state.structures.status, 'not_recorded')
assert.equal(combatSummary.progress.liveGoal.fraction, 1 / 3)
assert.equal(combatSummary.progress.stallStatus, 'tracked_not_exhausted')
assert.equal(combatSummary.execution.selectedChoiceOutcome.causal.detail.status, 'done')
assert.equal(combatSummary.execution.selectedChoiceOutcome.skillOutcome.detail.progress, 'body')
assert.deepEqual(combatSummary.choices.jevEvidence.rationale, { status: 'not_emitted', text: null })
assert.equal(Object.hasOwn(combatSummary.choices.jevEvidence, 'questions'), false)

const gatewayFailure = {
  record: 'jev-call',
  callId: 'jev-503-call',
  ts: '2026-09-21T12:00:09.000Z',
  model: 'typesafe-ai/jev',
  stage: 'policy-tick-2-start',
  latencyMs: 812,
  error: 'GatewayInternalServerError: Service temporarily unavailable. api_key=private-token',
  retryable: true,
  providerDiagnostics: {
    httpStatus: 503,
    providerErrorCode: 'provider_overloaded',
    errorName: 'GatewayInternalServerError',
    requestId: 'iad1::sfo1::gateway-503-1234',
    requestIdHeader: 'x-vercel-id',
    authorization: 'Bearer private-token',
  },
  state: {
    semantic: {
      world: { dimension: 'overworld', worldEpoch: 1, generationId: null },
    },
  },
}
const providerFailureSnapshot = buildObserverSnapshot({
  report,
  events: combatEvents,
  runBoot: combatEvents[0],
  runMetadata: observerRunMetadata(),
  runGenerationReady: observerGenerationReady('gen-7', '2026-09-21T12:00:01.000Z'),
  jevCalls: [
    { ...gatewayFailure, callId: 'old-run-failure', ts: '2026-09-21T11:59:59.000Z' },
    gatewayFailure,
    { ...gatewayFailure, callId: 'wrong-world-failure', state: { semantic: { world: { dimension: 'overworld', worldEpoch: 2 } } } },
    { ...gatewayFailure, callId: 'wrong-generation-failure', generationId: 'gen-old' },
  ],
  now: Date.parse('2026-09-21T12:00:12.000Z'),
})
const providerFailureSummary = buildAiSummary(providerFailureSnapshot, { now: Date.parse('2026-09-21T12:00:12.000Z') })
assert.equal(providerFailureSummary.authority.jevRecentFailures.length, 1)
assert.equal(providerFailureSummary.authority.jevRecentFailures[0].callId, 'jev-503-call')
assert.deepEqual(providerFailureSummary.authority.jevRecentFailures[0].providerDiagnostics, {
  httpStatus: 503,
  providerErrorCode: 'provider_overloaded',
  errorName: 'GatewayInternalServerError',
  requestId: 'iad1::sfo1::gateway-503-1234',
  requestIdHeader: 'x-vercel-id',
})
assert.equal(providerFailureSummary.authority.jevRecentFailures[0].binding.confidence, 'generation-window-inferred')
assert.ok(!JSON.stringify(providerFailureSummary.authority.jevRecentFailures).includes('private-token'))
const unboundProviderFailureSnapshot = buildObserverSnapshot({
  report,
  events: combatEvents,
  runBoot: combatEvents[0],
  runMetadata: null,
  runGenerationReady: null,
  jevCalls: [gatewayFailure],
  now: Date.parse('2026-09-21T12:00:12.000Z'),
})
assert.deepEqual(unboundProviderFailureSnapshot.authority.jevRecentFailures, [])

const recoveryBoot = observerBoot('run-1', '2026-09-21T12:00:00.000Z')
recoveryBoot.detail.worldKey = { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 1 }
const failedGeneration = 'gen-failed'
const recoveryModelAvailability = {
  state: 'degraded',
  consecutiveFailures: 1,
  retryAt: '2026-09-21T12:00:29.000Z',
  lastFailure: {
    ts: '2026-09-21T12:00:09.500Z',
    generationId: failedGeneration,
    context: 'jev-authority',
    attempts: 1,
    error: 'GatewayInternalServerError: Service temporarily unavailable.',
    authorityKind: 'jev',
    authority: { provider: 'typesafe-ai', model: 'typesafe-ai/jev' },
    sourceSha: observerSourceSha,
  },
  recoveredAt: null,
}
const { generationId: _discardedGeneration, worldKey: _discardedWorld, ...recoveryReportData } = report.data
const recoveryReport = {
  ok: true,
  data: {
    ...recoveryReportData,
    runId: 'run-1',
    modelAvailability: recoveryModelAvailability,
  },
}
const recoveryCall = {
  ...gatewayFailure,
  callId: 'recovery-run-window-call',
  ts: '2026-09-21T12:00:09.100Z',
  state: {
    semantic: {
      world: { dimension: 'overworld', worldEpoch: 1, generationId: null },
    },
  },
}
const recoverySnapshot = buildObserverSnapshot({
  report: recoveryReport,
  events: [],
  runBoot: recoveryBoot,
  runMetadata: observerRunMetadata('run-1', failedGeneration),
  runGenerationReady: null,
  jevCalls: [
    { ...recoveryCall, callId: 'prior-run-call', ts: '2026-09-21T11:59:59.000Z' },
    recoveryCall,
    { ...recoveryCall, callId: 'prior-world-call', state: { semantic: { world: { dimension: 'nether', worldEpoch: 2, generationId: null } } } },
    { ...recoveryCall, callId: 'wrong-generation-call', generationId: 'gen-other' },
  ],
  now: Date.parse('2026-09-21T12:00:12.000Z'),
})
const recoverySummary = buildAiSummary(recoverySnapshot, { now: Date.parse('2026-09-21T12:00:12.000Z') })
assert.equal(recoverySnapshot.resident.generationId, null)
assert.equal(recoverySnapshot.resident.generationBoundary, null)
assert.equal(recoverySummary.status.availabilityReason, 'MODEL_UNAVAILABLE')
assert.equal(recoverySummary.authority.jevRecentFailures.length, 1)
assert.equal(recoverySummary.authority.jevRecentFailures[0].callId, 'recovery-run-window-call')
assert.equal(recoverySummary.authority.jevRecentFailures[0].binding.failedGenerationId, failedGeneration)
assert.equal(recoverySummary.authority.jevRecentFailures[0].binding.confidence, 'run-window-inferred')
assert.equal(recoverySummary.authority.jevRecentFailures[0].binding.method, 'BOOT-runId+sourceSha+lastFailure+run-window+world-epoch+dimension-when-observed')
const exactGenerationSnapshot = buildObserverSnapshot({
  report: recoveryReport,
  events: [],
  runBoot: recoveryBoot,
  runMetadata: observerRunMetadata('run-1', failedGeneration),
  runGenerationReady: null,
  jevCalls: [{ ...recoveryCall, callId: 'exact-failed-generation-call', generationId: failedGeneration }],
  now: Date.parse('2026-09-21T12:00:12.000Z'),
})
assert.equal(exactGenerationSnapshot.authority.jevRecentFailures[0].binding.confidence, 'direct')

const sourceMismatchBoot = { ...recoveryBoot, detail: { ...recoveryBoot.detail, source: 'b'.repeat(40) } }
const sourceMismatchSnapshot = buildObserverSnapshot({
  report: recoveryReport,
  events: [],
  runBoot: sourceMismatchBoot,
  runMetadata: observerRunMetadata('run-1', failedGeneration),
  runGenerationReady: null,
  jevCalls: [recoveryCall],
  now: Date.parse('2026-09-21T12:00:12.000Z'),
})
assert.deepEqual(sourceMismatchSnapshot.authority.jevRecentFailures, [])
const failureSourceMismatchSnapshot = buildObserverSnapshot({
  report: {
    ...recoveryReport,
    data: {
      ...recoveryReport.data,
      modelAvailability: {
        ...recoveryModelAvailability,
        lastFailure: { ...recoveryModelAvailability.lastFailure, sourceSha: 'b'.repeat(40) },
      },
    },
  },
  events: [],
  runBoot: recoveryBoot,
  runMetadata: observerRunMetadata('run-1', failedGeneration),
  runGenerationReady: null,
  jevCalls: [recoveryCall],
  now: Date.parse('2026-09-21T12:00:12.000Z'),
})
assert.deepEqual(failureSourceMismatchSnapshot.authority.jevRecentFailures, [])

const toolChoiceEvents = [
  observerBoot('run-1', '2026-09-21T12:01:00.000Z'),
  parseBuddyLogLine('[2026-09-21T12:01:10.000Z] TOOL_CHOICE actionId=MINE:b1 toolName=mine tier=wood generationId=gen-7'),
  parseBuddyLogLine('[2026-09-21T12:01:10.500Z] SKILL_END actionId=MINE:b1 outcome=SUCCESS failure=null generationId=gen-7'),
  parseBuddyLogLine('[2026-09-21T12:01:10.510Z] SKILL_OUTCOME_PACKET actionId=MINE:b1 terminalReason=done progress=body delta=1 nextDecisionRequired=true generationId=gen-7'),
  parseBuddyLogLine('[2026-09-21T12:01:10.520Z] CAUSAL record=causal chainId=tool-chain candidateId=MINE:b1 actionId=MINE:b1 verified=true status=done progressDelta=1 generationId=gen-7'),
].filter((event) => event !== null)
const toolChoiceCall = {
  ...combatCall,
  callId: 'tool-choice-call',
  ts: '2026-09-21T12:01:09.500Z',
  response: { answers: { action: { value: 'MINE:b1', probability: 0.95, confidence: 0.9, probabilities: { 'MINE:b1': 0.95, WAIT: 0.05 } } } },
  state: { ...combatCall.state, candidates: [{ id: 'MINE:b1', kind: 'MINE', label: 'mine the nearby oak log', meta: { distance: 2, diggable: true } }] },
}
const toolChoiceSnapshot = buildObserverSnapshot({
  report,
  events: toolChoiceEvents,
  mission: { id: 'M4', title: 'Ender Dragon' },
  runBoot: toolChoiceEvents[0],
  runMetadata: observerRunMetadata(),
  runGenerationReady: observerGenerationReady('gen-7', '2026-09-21T12:01:01.000Z'),
  jevCalls: [toolChoiceCall],
})
const toolChoiceSummary = buildAiSummary(toolChoiceSnapshot)
assert.equal(toolChoiceSummary.choices.latest?.event, 'TOOL_CHOICE')
assert.equal(toolChoiceSummary.choices.jevEvidence?.binding.choiceEvent, 'TOOL_CHOICE')
assert.equal(toolChoiceSummary.choices.jevEvidence?.binding.confidence, 'strong')
assert.equal(toolChoiceSummary.choices.jevEvidence?.selectedCandidate?.id, 'MINE:b1')
assert.equal(toolChoiceSummary.execution.selectedChoiceOutcome?.joinMethod, 'action+generation+nearest-timestamp')
assert.equal(toolChoiceSummary.execution.selectedChoiceOutcome?.joinConfidence, 'inferred')

const aiSummary = buildAiSummary({
  ...snapshot,
  resident: { ...snapshot.resident, available: false, connected: false },
  events: [...snapshot.events, fatalEvents[0]],
})
assert.equal(aiSummary.authority.jev.provider, 'typesafe-ai')
assert.equal(aiSummary.authority.jev.model, 'typesafe-ai/jev')
assert.equal(aiSummary.authority.system2.configured.provider, 'local-mercury')
assert.equal(aiSummary.authority.system2.configured.model, 'deterministic|mercury:qwen3.5-9b-local')
assert.equal(aiSummary.authority.system2.last.provider, 'mercury')
assert.equal(aiSummary.authority.system2.last.model, 'qwen3.5-9b-local')
assert.equal(aiSummary.authority.deterministicFallbackEnabled, false)
assert.ok(!aiSummary.unknown.includes('effective_jev_provider_model_unavailable'))
assert.equal(aiSummary.runtimeFailure?.event, 'FATAL')
assert.equal(aiSummary.runtimeFailure?.detail.context, 'jev-authority')
assert.equal(aiSummary.status.availabilityReason, 'MODEL_UNAVAILABLE')
assert.match(aiSummary.headline, /Runtime failure: MODEL_UNAVAILABLE \(jev-authority\)/)

const degradedSummary = buildAiSummary({
  ...snapshot,
  resident: {
    ...snapshot.resident,
    modelAvailability: {
      state: 'degraded',
      consecutiveFailures: 2,
      retryAt: '2026-09-21T12:00:20.000Z',
      lastFailure: { ts: '2026-09-21T12:00:10.000Z', context: 'jev-authority', attempts: 4, error: '503 unavailable' },
      recoveredAt: null,
    },
  },
  events: [
    ...snapshot.events,
    { ts: '2026-09-21T12:00:10.000Z', event: 'MODEL_UNAVAILABLE', detail: { context: 'jev-authority' } },
    { ts: '2026-09-21T12:00:11.000Z', event: 'HEARTBEAT', detail: { pos: { x: 1, y: 62, z: 3 } } },
  ],
}, { now: Date.parse('2026-09-21T12:00:20.000Z') })
assert.equal(degradedSummary.status.available, false)
assert.equal(degradedSummary.status.hostAvailable, true)
assert.equal(degradedSummary.status.connected, true)
assert.equal(degradedSummary.status.availabilityReason, 'MODEL_UNAVAILABLE')
assert.equal(degradedSummary.worldObservation?.live, true)
assert.deepEqual(degradedSummary.worldObservation?.position, { x: 1, y: 62, z: 3 })
assert.ok(degradedSummary.unknown.includes('model_authority_unavailable'))
assert.match(degradedSummary.headline, /retryAt=2026-09-21T12:00:20.000Z/)

const recoveredSummary = buildAiSummary({
  ...snapshot,
  resident: {
    ...snapshot.resident,
    modelAvailability: {
      state: 'available',
      consecutiveFailures: 0,
      retryAt: null,
      lastFailure: { ts: '2026-09-21T12:00:10.000Z', context: 'jev-authority', attempts: 4, error: '503 unavailable' },
      recoveredAt: '2026-09-21T12:00:30.000Z',
    },
  },
  events: [
    ...snapshot.events,
    { ts: '2026-09-21T12:00:10.000Z', event: 'FATAL', detail: { code: 'MODEL_UNAVAILABLE', context: 'jev-authority' } },
    { ts: '2026-09-21T12:00:30.000Z', event: 'MODEL_RECOVERED', detail: { generationId: 'gen-8' } },
    { ts: '2026-09-21T12:00:31.000Z', event: 'HEARTBEAT', detail: { pos: { x: 1, y: 62, z: 3 } } },
  ],
}, { now: Date.parse('2026-09-21T12:00:40.000Z') })
assert.equal(recoveredSummary.status.available, true)
assert.equal(recoveredSummary.runtimeFailure, null)
assert.equal(recoveredSummary.worldObservation?.live, true)

const worldProbe = buildWorldProbe({
  report: {
    ok: true,
    data: {
      runId: 'run-1',
      generationId: 'gen-7',
      worldKey: { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 1 },
      status: {
        milestonePredicates: [{
          id: 'ender_pearl', milestone: 'M3', satisfied: false, observedAt: '2026-09-21T12:00:00.000Z',
          source: 'host-observe:rung:ender_pearls', evidence: { rungId: 'ender_pearls', dimension: 'minecraft:overworld', items: { ender_pearl: 0 } },
        }],
      },
    },
  },
  reportAfter: {
    ok: true,
    data: {
      runId: 'run-1',
      generationId: 'gen-7',
      worldKey: { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 1 },
    },
  },
  state: {
    ok: true,
    data: {
      capturedAt: '2026-09-21T12:00:10.000Z',
      runId: 'run-1',
      generationId: 'gen-7',
      worldKey: { serverId: 'local', dimension: 'overworld', worldEpoch: 1 },
      truth: { position: { x: 1, y: 64, z: 2 }, health: 18, food: 16, dimension: 'overworld', inventory: { ender_pearl: 0 } },
      world: { dimension: 'overworld', day: 1, timeOfDay: 18000 },
      area: {
        blocks: { unknown: 4, counts: { grass_block: 500, oak_log: 4 }, hazards: [], portals: [], support: { name: 'grass_block', position: { x: 1, y: 63, z: 2 } } },
        entities: [
          { id: 2, name: 'zombie', type: 'mob', kind: 'Hostile mobs', position: { x: 3, y: 64, z: 2 }, distance: 2, health: 20 },
          { id: 3, name: 'pig', type: 'mob', kind: 'Passive mobs', position: { x: 2, y: 64, z: 2 }, distance: 1, health: 10 },
        ],
      },
    },
  },
  radius: 6,
  verticalRadius: 3,
  observedAt: '2026-09-21T12:00:10.100Z',
})
assert.equal(worldProbe.status, 'partial')
assert.equal(worldProbe.identityAligned, true)
assert.equal(worldProbe.dataComplete, false)
assert.equal(worldProbe.readOnly, true)
assert.equal(worldProbe.binding.sameGeneration, true)
assert.equal(worldProbe.player.health, 18)
assert.equal(worldProbe.area.scannedBlocks, 1183)
assert.equal(worldProbe.area.unknownBlocks, 4)
assert.equal(worldProbe.area.hostiles.length, 1)
assert.equal(worldProbe.milestones.entries[0]?.id, 'ender_pearl')
assert.equal(worldProbe.structures.status, 'not_identifiable_from_local_block_entity_probe')
assert.ok(worldProbe.unknown.includes('some_scanned_blocks_unloaded_or_unknown'))

const completeWorldProbe = buildWorldProbe({
  report: { ok: true, data: { runId: 'run-1', generationId: 'gen-7', worldKey: { serverId: 'local', dimension: 'overworld', worldEpoch: 1 } } },
  reportAfter: { ok: true, data: { runId: 'run-1', generationId: 'gen-7', worldKey: { serverId: 'local', dimension: 'overworld', worldEpoch: 1 } } },
  state: { ok: true, data: { runId: 'run-1', generationId: 'gen-7', worldKey: { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 1 }, area: { blocks: { unknown: 0, counts: {}, hazards: [], portals: [] }, entities: [] } } },
})
assert.equal(completeWorldProbe.status, 'partial')
assert.equal(completeWorldProbe.identityAligned, true)
assert.equal(completeWorldProbe.dataComplete, false)
assert.ok(completeWorldProbe.unknown.includes('world_cache_diagnostic_unavailable'))
assert.ok(completeWorldProbe.unknown.includes('entity_cache_diagnostic_unavailable'))
assert.ok(completeWorldProbe.unknown.includes('support_current_footing_scope_unverified'))

const mismatchedWorldProbe = buildWorldProbe({
  report: { ok: true, data: { runId: 'run-1', worldKey: { serverId: 'local', dimension: 'overworld', worldEpoch: 1 } } },
  state: { ok: true, data: { runId: 'run-1', generationId: 'gen-8', worldKey: { serverId: 'local', dimension: 'overworld', worldEpoch: 2 }, area: { blocks: { unknown: 0, counts: {}, hazards: [], portals: [] }, entities: [] } } },
})
assert.equal(mismatchedWorldProbe.status, 'partial')
assert.equal(mismatchedWorldProbe.milestones.status, 'not_joined')
assert.ok(mismatchedWorldProbe.unknown.includes('report_state_world_mismatch_or_unknown'))

// Exercise the actual HTTP surface with an isolated empty runtime directory.
// This starts only an in-process observer fixture; it does not launch a resident
// or Minecraft server, and a live run is never inferred from a server process.
const httpObserverRuntimeDir = mkdtempSync(join(tmpdir(), 'buddy-observer-vtr-http-'))
const { server: httpObserverServer, url: httpObserverUrl } = startObserverServer({
  runtimeDir: httpObserverRuntimeDir,
  hostname: '127.0.0.1',
  port: 0,
})
try {
  const pageResponse = await fetch(`${httpObserverUrl}/`)
  assert.equal(pageResponse.status, 200)
  const page = await pageResponse.text()
  assert.match(page, /AI Buddy · 検証済み遷移/)
  assert.match(page, /ミッション/)
  assert.match(page, /遷移契約/)
  assert.match(page, /決定的検証 \/ 型付き結果/)
  assert.match(page, /new EventSource\('\/events'\)/)
  assert.doesNotMatch(page, /s\.goal|s\.option|betaAuthority|GoalQueue|OptionLedger/)

  const apiResponse = await fetch(`${httpObserverUrl}/api/ai-summary`)
  assert.equal(apiResponse.status, 200)
  const api = await apiResponse.json()
  assert.equal(api.schema, 'ai-buddy-vtr-observer/v1')
  assert.equal(api.status.available, false)
  assert.equal(api.run.id, null)
  assert.equal(api.run.sourceCommit, null)
  assert.equal(api.run.generationId, null)
  assert.equal(api.transition, null)
  assert.equal(api.worldObservation, null)
  assert.equal(api.vtr.status, 'unknown')
  assert.ok(api.unknown.includes('live_run_identity_unavailable'))
  assert.equal(Object.hasOwn(api, 'goal'), false)
  assert.equal(Object.hasOwn(api, 'option'), false)
  assert.equal(Object.hasOwn(api, 'choices'), false)

  const fallbackResponse = await fetch(`${httpObserverUrl}/api/vtr-view`)
  const fallback = await fallbackResponse.json()
  assert.equal(fallback.schema, api.schema)
  assert.equal(fallback.status.available, api.status.available)
  assert.equal(fallback.run.id, api.run.id)
  assert.equal(fallback.transition, api.transition)
} finally {
  await httpObserverServer.stop(true)
  rmSync(httpObserverRuntimeDir, { recursive: true, force: true })
}

// Campaign registry mode: the canonical observer follows the capability run's
// active-run.json rather than a fixed directory. Three states are exercised:
// missing registry, stale registry (recorded pids dead), and a live registry
// entry whose runtime dir has no resident socket (run booting).
const registryDir = mkdtempSync(join(tmpdir(), 'buddy-observer-registry-'))
const registryPath = join(registryDir, 'active-run.json')
const registryObserver = createObserver({ registryPath })
try {
  // Missing registry -> explicit no-active-run, never stale state.
  const absent = buildVtrObserverReadModel(await registryObserver.snapshot(), { now: Date.now() })
  assert.equal(absent.status.available, false)
  assert.equal(absent.status.connected, false)
  assert.equal(absent.status.availabilityReason, 'no_active_campaign_run')
  assert.equal(absent.run.id, null)
  const absentSnapshot = await registryObserver.snapshot()
  assert.equal(absentSnapshot.campaign.status, 'no_active_campaign_run')
  const absentProbe = await registryObserver.worldProbe()
  assert.equal(absentProbe.error, 'no_active_campaign_run')

  // Stale registry: pids that cannot exist stay dead -> still no_active_campaign_run.
  const staleRuntime = join(registryDir, 'stale-runtime')
  mkdirSync(staleRuntime, { recursive: true })
  writeFileSync(registryPath, JSON.stringify({
    record: 'capability-active-run',
    runId: 'stale-run-1',
    runtimeDir: staleRuntime,
    runnerPid: 4194303,
    residentPid: 4194304,
  }))
  const stale = await registryObserver.snapshot()
  assert.equal(stale.campaign.status, 'no_active_campaign_run')
  assert.equal(stale.campaign.staleRegistryRunId, 'stale-run-1')

  // Live registry (this process stands in as the runner pid) -> observer binds
  // to the recorded runtime dir and reports the run identity even before the
  // resident socket answers.
  const liveRuntime = join(registryDir, 'live-runtime')
  mkdirSync(liveRuntime, { recursive: true })
  writeFileSync(registryPath, JSON.stringify({
    record: 'capability-active-run',
    runId: 'cohort-run-9',
    runtimeDir: liveRuntime,
    runnerPid: process.pid,
    residentPid: process.pid,
    sha: 'feedface',
    seed: '777001',
    port: 26601,
    mission: { id: 'inventory_at_least(log,1)' },
    protocolVersion: 'v2',
    start: { x: 128, y: 70, z: -256 },
    startedAt: new Date().toISOString(),
  }))
  const live = await registryObserver.snapshot()
  assert.equal(live.campaign.status, 'active')
  assert.equal(live.campaign.runId, 'cohort-run-9')
  assert.equal(live.campaign.protocolVersion, 'v2')
  assert.deepEqual(live.campaign.start, { x: 128, y: 70, z: -256 })
  assert.equal(live.campaign.mission.id, 'inventory_at_least(log,1)')
  assert.equal(registryObserver.currentRuntimeDir(), liveRuntime)
  const liveReadModel = buildVtrObserverReadModel(live, { now: Date.now() })
  assert.equal(liveReadModel.status.connected, false, 'no resident socket yet -> not connected')
  assert.ok(liveReadModel.unknown.includes('resident_report_unavailable'))

  // Registry cleared again -> immediately back to no-active, no cached identity.
  rmSync(registryPath)
  const cleared = await registryObserver.snapshot()
  assert.equal(cleared.campaign.status, 'no_active_campaign_run')
  assert.equal(cleared.campaign.staleRegistryRunId, undefined)
} finally {
  rmSync(registryDir, { recursive: true, force: true })
}

console.log('buddy-observer: PASS')
