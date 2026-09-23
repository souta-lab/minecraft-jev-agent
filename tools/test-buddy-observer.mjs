#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { buildAiSummary, buildObserverSnapshot, buildWorldProbe, parseBuddyLogLine, parseDetail, parseRunnerOutEvents } from './buddy-observer.mjs'

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
const observerRunMetadata = (runId = 'run-1', generationId = 'gen-7') => ({
  runArtifactsMatched: true,
  sourceSha: observerSourceSha,
  sourceShaConflict: false,
  acceptance: { runId, gitCommit: observerSourceSha, generationId },
  predicates: { runId, sourceSha: observerSourceSha, generationId },
})
const observerBoot = (runId = 'run-1', ts = '2026-09-21T11:59:59.000Z') => parseBuddyLogLine(
  `[${ts}] BOOT pid=1 runId=${runId} source=${observerSourceSha}`,
)
const observerGenerationReady = (generationId = 'gen-7', ts = '2026-09-21T12:00:00.000Z') => parseBuddyLogLine(
  `[${ts}] GENERATION_READY id=${generationId}`,
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
  mission: { id: 'M4', title: 'Ender Dragon' },
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

const laggedGenerationEvents = [
  parseBuddyLogLine(`[2026-09-23T19:36:20.000Z] BOOT pid=1 runId=run-observer-1 source=${observerSourceSha}`),
  parseBuddyLogLine('[2026-09-23T19:36:23.559Z] GENERATION_READY id=gen-current'),
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
    semantic: { world: { dimension: 'overworld', worldEpoch: 1, generationId: null, alive: true, leaseHeld: true } },
    self: {
      position: { x: 10, y: 64, z: 20 },
      dimension: 'overworld',
      health: 16,
      food: 17,
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
assert.equal(combatSummary.choices.jevEvidence.state.resources.known[0].name, 'acacia_log')
assert.equal(combatSummary.choices.jevEvidence.state.structures.status, 'not_recorded')
assert.equal(combatSummary.progress.liveGoal.fraction, 1 / 3)
assert.equal(combatSummary.progress.stallStatus, 'tracked_not_exhausted')
assert.equal(combatSummary.execution.selectedChoiceOutcome.causal.detail.status, 'done')
assert.equal(combatSummary.execution.selectedChoiceOutcome.skillOutcome.detail.progress, 'body')
assert.deepEqual(combatSummary.choices.jevEvidence.rationale, { status: 'not_emitted', text: null })
assert.equal(Object.hasOwn(combatSummary.choices.jevEvidence, 'questions'), false)

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

console.log('buddy-observer: PASS')
