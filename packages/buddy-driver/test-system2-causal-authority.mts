// Regression coverage for the causal System2/Option boundary exposed by the
// captured M2 audit. Pure fixtures: no server, bot, network, or model call.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyActionOutcome, truthfulActionOutcome } from '../jev-agent/src/actionPostcondition.ts'
import { canAuthoritativelyAbandonOption } from '../jev-agent/src/controller.ts'
import { GoalQueue } from '../jev-agent/src/goalQueue.ts'
import { applyCompiledPlan, currentOptionContextForQueuedGoal, makeOptionSnapshot } from '../jev-agent/src/optionSpec.ts'
import { buildAuthorityQuestions } from '../jev-agent/src/jev/authority.ts'
import { evaluateSystem2Apply, system2BodyOwned } from '../jev-agent/src/system2/authority.ts'
import { system2ApplyIdentity } from '../jev-agent/src/system2-plane.ts'
import {
  evaluateBetaTerminationBoundary,
  evaluateCandidateStarvationBoundary,
  shouldWakeSystem2AfterLocalFailure,
} from '../jev-agent/src/system2/escalation.ts'
import { system2AuthorityIdentity } from '../jev-agent/src/system2/service.ts'
import { compileMercuryGoal, validateMercuryPlan } from './mercury-system2.ts'
import { augmentPlannerWorldWithLiveStations, PlannerBrain } from './planner.ts'
import { emptyWorldMemory } from './resident-types.ts'

function goal(source: Parameters<typeof compileMercuryGoal>[0]) {
  const compiled = compileMercuryGoal(source)
  if (compiled === null) throw new Error(`fixture did not compile: ${JSON.stringify(source)}`)
  return compiled
}

// 1. Request -> meaningful local progress -> old response: discard, never apply.
const request = {
  requestId: 'req-stale',
  queueRevision: 7,
  optionInstanceId: 'instance-old',
  optionTemplateId: 'explore:cave',
  worldEpoch: 4,
  stateFingerprint: 'fp-before',
  objectiveFingerprint: 'objective:dragon',
  inventoryFingerprint: 'oak_log=5',
  dimension: 'minecraft:overworld',
  worldTopologyRevision: 30,
  worldFactsFingerprint: 'known-resources=oak_log@10,64,10',
  threatFingerprint: 'clear',
  survivalFingerprint: 'food=20;health=20;held=null',
  authorityEpoch: 11,
}
const bodyMoved = evaluateSystem2Apply(request, {
  queueRevision: 7,
  optionInstanceId: 'instance-old',
  optionTemplateId: 'explore:cave',
  worldEpoch: 4,
  // This fingerprint includes body position and is kept for diagnostics, but a
  // successful MOVE alone does not revoke an otherwise-current System2 answer.
  stateFingerprint: 'fp-after-descend',
  objectiveFingerprint: 'objective:dragon',
  inventoryFingerprint: 'oak_log=5',
  dimension: 'minecraft:overworld',
  worldTopologyRevision: 30,
  worldFactsFingerprint: 'known-resources=oak_log@10,64,10',
  threatFingerprint: 'clear',
  survivalFingerprint: 'food=20;health=20;held=null',
  authorityEpoch: 11,
  actionInFlight: false,
})
assert.equal(bodyMoved.apply, true, `body-only movement reasons=${bodyMoved.reasons.join(',')}`)
assert.deepEqual(bodyMoved.reasons, [])
const bodyMovedAgain = evaluateSystem2Apply(request, {
  queueRevision: 7,
  optionInstanceId: 'instance-old',
  optionTemplateId: 'explore:cave',
  worldEpoch: 4,
  stateFingerprint: 'fp-after-multiple-search-moves',
  objectiveFingerprint: 'objective:dragon',
  inventoryFingerprint: 'oak_log=5',
  dimension: 'minecraft:overworld',
  // Chunk residency may change as the body moves; only an actual observed block
  // edit advances this topology fence.
  worldTopologyRevision: 30,
  worldFactsFingerprint: 'known-resources=oak_log@10,64,10',
  threatFingerprint: 'clear',
  survivalFingerprint: 'food=20;health=20;held=null',
  authorityEpoch: 11,
  actionInFlight: false,
})
assert.equal(bodyMovedAgain.apply, true, `multiple body-only moves reasons=${bodyMovedAgain.reasons.join(',')}`)
const changedWorldFacts = evaluateSystem2Apply(request, {
  ...request,
  worldFactsFingerprint: 'known-resources=oak_log@10,64,10;stone@12,64,10',
  actionInFlight: false,
})
assert.equal(changedWorldFacts.apply, false)
assert.ok(changedWorldFacts.reasons.includes('world_facts_changed'))
const changedInventory = evaluateSystem2Apply(request, {
  ...request,
  inventoryFingerprint: 'oak_log=4',
  actionInFlight: false,
})
assert.equal(changedInventory.apply, false)
assert.ok(changedInventory.reasons.includes('inventory_changed'))
const changedQueue = evaluateSystem2Apply(request, {
  ...request,
  queueRevision: request.queueRevision + 1,
  actionInFlight: false,
})
assert.equal(changedQueue.apply, false)
assert.ok(changedQueue.reasons.includes('queue_revision_changed'))
const changedDimension = evaluateSystem2Apply(request, {
  ...request,
  dimension: 'minecraft:the_nether',
  actionInFlight: false,
})
assert.equal(changedDimension.apply, false)
assert.ok(changedDimension.reasons.includes('dimension_changed'))
const changedTopology = evaluateSystem2Apply(request, {
  ...request,
  worldTopologyRevision: request.worldTopologyRevision + 1,
  actionInFlight: false,
})
assert.equal(changedTopology.apply, false)
assert.ok(changedTopology.reasons.includes('world_topology_changed'))
const changedThreat = evaluateSystem2Apply(request, {
  ...request,
  threatFingerprint: 'zombie:in_contact',
  actionInFlight: false,
})
assert.equal(changedThreat.apply, false)
assert.ok(changedThreat.reasons.includes('threat_state_changed'))
const changedSurvival = evaluateSystem2Apply(request, {
  ...request,
  survivalFingerprint: 'food=0;health=5;held=stone_pickaxe',
  actionInFlight: false,
})
assert.equal(changedSurvival.apply, false)
assert.ok(changedSurvival.reasons.includes('survival_state_changed'))
const changedObjective = evaluateSystem2Apply(request, {
  ...request,
  objectiveFingerprint: 'objective:other',
  actionInFlight: false,
})
assert.equal(changedObjective.apply, false)
assert.ok(changedObjective.reasons.includes('objective_changed'))
const criticalEvent = evaluateSystem2Apply(request, {
  ...request,
  authorityEpoch: request.authorityEpoch + 1,
  actionInFlight: false,
})
assert.equal(criticalEvent.apply, false)
assert.ok(criticalEvent.reasons.includes('authority_epoch_changed'))
const legacyRequest = {
  requestId: 'req-legacy',
  queueRevision: 7,
  optionInstanceId: null,
  optionTemplateId: null,
  worldEpoch: 4,
  stateFingerprint: 'legacy-before',
  authorityEpoch: 11,
}
const legacyStateFingerprintChange = evaluateSystem2Apply(legacyRequest, {
  ...legacyRequest,
  stateFingerprint: 'legacy-after',
  actionInFlight: false,
})
assert.equal(legacyStateFingerprintChange.apply, false)
assert.ok(legacyStateFingerprintChange.reasons.includes('state_fingerprint_changed'))
assert.equal(
  evaluateSystem2Apply(request, {
    ...request,
    actionInFlight: false,
  }).apply,
  true,
)
assert.equal(system2BodyOwned('WAIT'), false)
assert.equal(system2BodyOwned('ESCALATE'), false)
assert.equal(system2BodyOwned('MINE'), true)
assert.equal(system2BodyOwned(null), false)

// portal-p1/v2-n5 regression (2026-09-27): every authored plan was discarded
// because the apply identity hashed world-scale churn the plan could not name -
// hostiles far outside the danger envelope, the raw sensed-block snapshot, and
// the packet-level block revision. The identity must stay stable across that
// noise while still fencing the durable basis a plan is authored against.
{
  const hostile = (id: number, distance: number, attackedSelf = false) => ({
    id,
    name: 'zombie',
    kind: 'Hostile mobs',
    username: null,
    position: { x: distance, y: 64, z: 0 },
    distance,
    hostile: true,
    lineOfSight: true,
    heldItem: null,
    activeItemUse: null,
    health: 20,
    attackedSelf,
  })
  const world = (overrides: Record<string, unknown>) => ({
    inventory: { counts: { oak_log: 2 } },
    entities: [],
    blocks: [],
    signals: { knownResources: [], threat: null },
    craftingTables: [],
    furnaces: [],
    self: {
      dimension: 'minecraft:overworld',
      envHazard: null,
      health: 20,
      food: 20,
      air: null,
      heldItem: null,
      offhand: null,
      armor: null,
      activeItemUse: null,
    },
    ...overrides,
  })
  const host = {
    objectiveState: () => ({ goal: 'dragon' }),
    inventorySnapshot: () => ({ oak_log: 2 }),
    bot: { game: { dimension: 'minecraft:overworld' } },
    scheduler: { blockRevision: 30 },
    lastWorldState: null,
  }
  const identityFor = (w: unknown) =>
    system2ApplyIdentity(host as never, w as never)
  const baseline = identityFor(world({}))
  // Packet-level block revision is not part of the freshness identity.
  assert.equal('worldTopologyRevision' in baseline, false)
  // Distant hostile spawn/move outside the 8m danger envelope: identical threat fingerprint.
  const distant = identityFor(world({ entities: [hostile(1, 120.5)] }))
  const distantMoved = identityFor(world({ entities: [hostile(1, 118.2)] }))
  assert.equal(distant.threatFingerprint, baseline.threatFingerprint)
  assert.equal(distantMoved.threatFingerprint, baseline.threatFingerprint)
  // A hostile inside the danger radius IS material: the fingerprint must change.
  const near = identityFor(world({ entities: [hostile(2, 6.5)] }))
  assert.notEqual(near.threatFingerprint, baseline.threatFingerprint)
  // An actively-attacking hostile is material at any distance.
  const attacker = identityFor(world({ entities: [hostile(3, 30, true)] }))
  assert.notEqual(attacker.threatFingerprint, baseline.threatFingerprint)
  // The sensed-block snapshot is execution-time input, not plan basis.
  const scanned = identityFor(
    world({ blocks: [{ kind: 'log', name: 'oak_log', position: { x: 3, y: 64, z: 9 }, diggable: true }] }),
  )
  assert.equal(scanned.worldFactsFingerprint, baseline.worldFactsFingerprint)
  // Durable resources/stations remain fenced: a changed waypoint must invalidate.
  const remembered = {
    kind: 'log',
    name: 'oak_log',
    position: { x: 3, y: 64, z: 9 },
    dimension: 'minecraft:overworld',
    worldEpoch: 1,
  }
  const withResource = identityFor(world({ signals: { knownResources: [remembered], threat: null } }))
  assert.notEqual(withResource.worldFactsFingerprint, baseline.worldFactsFingerprint)
}

// 2. Body/search progress is evidence even when the semantic goal is unchanged.
const descend = classifyActionOutcome({
  kind: 'DESCEND',
  status: 'done',
  verified: true,
  itemsGained: 0,
  blockRemoved: false,
  progressed: true,
})
assert.equal(descend.progress, 'search')
assert.deepEqual(new Set(descend.progressKinds), new Set(['body', 'search']))
const truthfulDescend = truthfulActionOutcome({
  kind: 'DESCEND',
  status: 'done',
  verified: true,
  itemsGained: 0,
  blockRemoved: false,
  progressed: true,
})
assert.equal(truthfulDescend.verified, true)
assert.equal(truthfulDescend.status, 'done')
assert.equal(truthfulDescend.observableProgress, true)
const truthfulZeroDescend = truthfulActionOutcome({
  kind: 'DESCEND',
  status: 'done',
  verified: true,
  itemsGained: 0,
  blockRemoved: false,
  progressed: false,
})
assert.equal(truthfulZeroDescend.verified, false)
assert.equal(truthfulZeroDescend.status, 'zero_progress')

// 3. WAIT is not productive goal progress.
const wait = classifyActionOutcome({
  kind: 'WAIT',
  status: 'done',
  verified: true,
  itemsGained: 0,
  blockRemoved: false,
})
assert.equal(wait.progress, 'none')
assert.equal(wait.verification, 'not_applicable')

// 4. ESCALATE is control-plane transfer, not a physical failure.
const escalate = classifyActionOutcome({
  kind: 'ESCALATE',
  status: 'failed',
  verified: false,
  itemsGained: 0,
  blockRemoved: false,
})
assert.equal(escalate.control, 'escalate')
assert.equal(escalate.execution, 'control')
assert.equal(escalate.invalidity, 'none')
assert.equal(escalate.progress, 'none')

// 4b. Attempt failure is not automatically proof of same-state invalidity.
const transientPathFailure = classifyActionOutcome({
  kind: 'MOVE',
  status: 'failed',
  verified: false,
  itemsGained: 0,
  blockRemoved: false,
  failureCode: 'path_timeout',
})
assert.equal(transientPathFailure.execution, 'failure')
assert.equal(transientPathFailure.invalidity, 'none')
const deterministicGone = classifyActionOutcome({
  kind: 'ATTACK',
  status: 'failed',
  verified: false,
  itemsGained: 0,
  blockRemoved: false,
  failureCode: 'target_gone',
})
assert.equal(deterministicGone.execution, 'failure')
assert.equal(deterministicGone.invalidity, 'deterministic')

const waitTaxonomy = classifyActionOutcome({
  kind: 'WAIT',
  status: 'done',
  verified: true,
  itemsGained: 0,
  blockRemoved: false,
})
assert.equal(waitTaxonomy.control, 'wait')
assert.equal(waitTaxonomy.execution, 'control')
assert.equal(waitTaxonomy.progress, 'none')

// 5. Beta has no semantic authority without one canonical current Option.
assert.equal(canAuthoritativelyAbandonOption(null), false)
assert.equal(canAuthoritativelyAbandonOption('explore:cave'), true)

// 6. Lowered mechanics retain the model-selected semantic Option identity.
const gotoRawIron = goal({ kind: 'goto_resource', item: 'raw_iron' })
assert.equal(gotoRawIron.kind, 'collect')
assert.equal(gotoRawIron.optionTemplateId, 'goto:raw_iron')
assert.equal(gotoRawIron.optionSpec?.id, 'goto:raw_iron')
assert.match(gotoRawIron.optionSpec?.intent ?? '', /^goto_resource raw_iron/)

const queue = new GoalQueue()
queue.applyPlan([gotoRawIron], 'llm', 'replace')
assert.equal(queue.current?.optionTemplateId, 'goto:raw_iron')
const compiledSemanticGoto = applyCompiledPlan(
  [gotoRawIron],
  makeOptionSnapshot({ inventory: {}, dimension: 'minecraft:overworld', knownOres: ['raw_iron'] }),
  { enabled: true },
)
const compiledGoto = compiledSemanticGoto.goals.find((candidate) => candidate.optionTemplateId === 'goto:raw_iron')
assert.equal(compiledGoto?.optionSpec?.id, 'goto:raw_iron')
assert.match(compiledGoto?.optionSpec?.intent ?? '', /^goto_resource raw_iron/)

const semanticSmelt = goal({ kind: 'smelt', item: 'iron_ingot', count: 3 })
const compiledSemanticSmelt = applyCompiledPlan(
  [semanticSmelt],
  makeOptionSnapshot({ inventory: { coal: 1 }, knownStations: ['furnace'], toolRank: 2 }),
  { enabled: true },
)
const compiledSmelt = compiledSemanticSmelt.goals.find((candidate) => candidate.optionTemplateId === 'smelt:iron_ingot')
assert.equal(compiledSmelt?.optionSpec?.id, 'smelt:iron_ingot')
assert.equal(compiledSemanticSmelt.goals[0]?.optionTemplateId, 'collect:raw_iron')
assert.equal(compiledSemanticSmelt.goals[0]?.semanticOptionTemplateId, 'smelt:iron_ingot')
assert.equal(compiledSemanticSmelt.goals[0]?.semanticOptionInstanceId, 'smelt:iron_ingot#c3')

// 6b. A model-selected multi-goal Option keeps one canonical semantic owner
// while prerequisite/execution rows retain their own mechanical identities.
const selectedSemanticPlan = applyCompiledPlan(
  [
    {
      kind: 'collect',
      description: 'collect 2 x log (fuel)',
      targetItem: 'log',
      requiredCount: 2,
      semanticOptionInstanceId: 'system2:front_charcoal',
      semanticOptionTemplateId: 'front_charcoal',
      semanticOptionIntent: 'next milestone: charcoal',
    },
    {
      kind: 'smelt',
      description: 'smelt 1 x charcoal',
      targetItem: 'charcoal',
      requiredCount: 1,
      semanticOptionInstanceId: 'system2:front_charcoal',
      semanticOptionTemplateId: 'front_charcoal',
      semanticOptionIntent: 'next milestone: charcoal',
    },
  ],
  makeOptionSnapshot({ inventory: {}, knownStations: ['furnace'], toolRank: 2 }),
  { enabled: true },
)
assert.ok(selectedSemanticPlan.goals.length >= 2)
for (const compiledGoal of selectedSemanticPlan.goals) {
  assert.equal(compiledGoal.semanticOptionTemplateId, 'front_charcoal')
  assert.equal(compiledGoal.semanticOptionInstanceId, 'system2:front_charcoal')
}
const selectedQueue = new GoalQueue()
selectedQueue.applyPlan(selectedSemanticPlan.goals, 'llm', 'replace')
assert.equal(selectedQueue.current?.semanticOptionTemplateId, 'front_charcoal')
assert.equal(currentOptionContextForQueuedGoal(selectedQueue.current)?.templateId, 'front_charcoal')

// The current Option exposes the non-semantic execution envelope explicitly;
// a prerequisite candidate must not look like an unrelated action to Jev.
const optionContext = currentOptionContextForQueuedGoal(queue.current)
assert.deepEqual(optionContext?.allowedSkills.slice(0, 3), ['SAFETY', 'CONTROL', 'PREREQUISITE'])
const prerequisiteQuestions = buildAuthorityQuestions([
  {
    id: 'MINE:stone',
    kind: 'MINE',
    label: 'mine stone',
    targetName: 'stone',
    target: { x: 0, y: 0, z: 0 },
    targetEntityId: null,
    itemName: 'cobblestone',
    requiresTool: true,
    toolName: 'pickaxe',
    inReach: true,
    hasStandableAdjacent: true,
    meta: {
      optionSkill: 'PREREQUISITE',
      prerequisiteRole: 'placeable_block',
      missingCapability: 'placeable_block',
      capabilityAcquisition: true,
    },
  },
])
const actionCriteria = prerequisiteQuestions.action?.criteria
const prerequisiteText =
  actionCriteria !== undefined && !Array.isArray(actionCriteria) && typeof actionCriteria === 'object'
    ? String((actionCriteria as Record<string, unknown>)['MINE:stone'] ?? '')
    : ''
assert.match(prerequisiteText, /optionSkill=PREREQUISITE/)
assert.match(prerequisiteText, /prerequisiteRole=placeable_block/)

// 7. A typed switch replaces the active semantic Option; patch does not.
const cave = goal({ kind: 'explore', mode: 'cave' })
queue.applyPlan([cave], 'llm', 'patch')
assert.equal(queue.current?.optionTemplateId, 'goto:raw_iron')
queue.applyPlan([cave], 'llm', 'replace')
assert.equal(queue.current?.optionTemplateId, 'explore:cave')
assert.notEqual(queue.current?.optionTemplateId, 'goto:raw_iron')

// 8. Repeated identical route failures stay local until the semantic boundary.
for (let i = 0; i < 20; i += 1) {
  assert.equal(
    shouldWakeSystem2AfterLocalFailure({
      failureCode: 'path_stuck',
      activeOption: true,
      semanticExhausted: false,
      semanticInvalid: false,
      semanticAbandoned: false,
    }).wake,
    false,
  )
}
assert.equal(
  shouldWakeSystem2AfterLocalFailure({
    failureCode: 'path_stuck',
    activeOption: true,
    semanticExhausted: true,
    semanticInvalid: false,
    semanticAbandoned: false,
  }).wake,
  true,
)
for (let i = 0; i < 20; i += 1) {
  assert.deepEqual(
    evaluateCandidateStarvationBoundary({
      activeOption: true,
      blockedBy: 'no_productive_action',
      missing: ['MOVE:p4_36_12:open_path'],
      semanticExhausted: false,
      semanticInvalid: false,
      semanticAbandoned: false,
    }),
    { wake: false, reason: 'local_recovery' },
  )
}
assert.deepEqual(
  evaluateCandidateStarvationBoundary({
    activeOption: true,
    blockedBy: 'no_productive_action',
    missing: [],
    semanticExhausted: true,
    semanticInvalid: false,
    semanticAbandoned: false,
  }),
  { wake: true, reason: 'semantic_boundary' },
)
assert.deepEqual(
  evaluateCandidateStarvationBoundary({
    activeOption: true,
    blockedBy: 'no_productive_action',
    missing: [],
    semanticExhausted: false,
    semanticInvalid: false,
    semanticAbandoned: false,
    localRecoveryExhausted: true,
  }),
  { wake: true, reason: 'semantic_boundary' },
)
assert.deepEqual(
  evaluateCandidateStarvationBoundary({
    activeOption: false,
    blockedBy: 'no_productive_action',
    missing: [],
    semanticExhausted: false,
    semanticInvalid: false,
    semanticAbandoned: false,
  }),
  { wake: false, reason: 'no_active_option' },
)

// A beta vote cannot turn a control tick or local body/search evidence into a
// System2 semantic wake. Only a typed semantic boundary crosses that edge.
assert.deepEqual(
  evaluateBetaTerminationBoundary({
    optionId: 'collect:log',
    requested: true,
    decisionActionId: 'WAIT',
    latestOutcome: null,
    semanticExhausted: false,
    semanticInvalid: false,
  }),
  { adopt: false, wake: false, reason: 'control_action' },
)
assert.equal(
  evaluateBetaTerminationBoundary({
    optionId: 'collect:log',
    requested: true,
    decisionActionId: 'MOVE:x',
    latestOutcome: { execution: 'success', progress: 'body', progressKinds: ['body'] },
    semanticExhausted: false,
    semanticInvalid: false,
  }).adopt,
  false,
)
for (let i = 0; i < 20; i += 1) {
  assert.equal(
    evaluateBetaTerminationBoundary({
      optionId: 'collect:log',
      requested: true,
      decisionActionId: 'MOVE:x',
      latestOutcome: { execution: 'failure', failure: 'path_stuck', progress: 'none', progressKinds: ['none'] },
      semanticExhausted: false,
      semanticInvalid: false,
    }).wake,
    false,
  )
}
assert.deepEqual(
  evaluateBetaTerminationBoundary({
    optionId: 'collect:log',
    requested: true,
    decisionActionId: 'MINE:oak_log',
    latestOutcome: null,
    semanticExhausted: true,
    semanticInvalid: false,
  }),
  { adopt: true, wake: true, reason: 'semantic_boundary' },
)

// 9. The report identity cannot mistake the Jev facade for Mercury authority.
assert.deepEqual(
  system2AuthorityIdentity({
    model: 'typesafe-ai/jev',
    provider: 'mercury',
    authorityModel: 'inception/mercury-2.5',
  }),
  { provider: 'mercury', model: 'inception/mercury-2.5' },
)

// 10. complete/abandon are current-Option lifecycle transitions, not empty replaces.
const completeQueue = new GoalQueue()
completeQueue.applyPlan([goal({ kind: 'collect', item: 'oak_log', count: 1 }), goal({ kind: 'collect', item: 'cobblestone', count: 1 })], 'llm', 'replace')
completeQueue.applyPlan([], 'llm', 'complete', { verifyCurrentComplete: () => true })
assert.equal(completeQueue.state.goals[0]?.status, 'done')
assert.equal(completeQueue.current?.targetItem, 'cobblestone')

const abandonQueue = new GoalQueue()
abandonQueue.applyPlan([goal({ kind: 'collect', item: 'oak_log', count: 1 }), goal({ kind: 'collect', item: 'cobblestone', count: 1 })], 'llm', 'replace')
abandonQueue.applyPlan([goal({ kind: 'collect', item: 'diamond', count: 1 })], 'llm', 'abandon', { reason: 'semantic switch' })
assert.equal(abandonQueue.state.goals.find((entry) => entry.targetItem === 'oak_log')?.status, 'impossible')
assert.equal(abandonQueue.state.goals.some((entry) => entry.targetItem === 'cobblestone'), false)
assert.equal(abandonQueue.current?.targetItem, 'diamond')

// 11. Merely re-observing the same count must not invalidate an in-flight System2 read.
const revisionQueue = new GoalQueue()
revisionQueue.applyPlan([goal({ kind: 'collect', item: 'oak_log', count: 1 })], 'llm', 'replace')
const revisionBefore = revisionQueue.revision
revisionQueue.markProgress(0)
assert.equal(revisionQueue.revision, revisionBefore)
revisionQueue.markProgress(1)
assert.equal(revisionQueue.revision, revisionBefore + 1)

// Lifecycle-only ops cannot smuggle a silently ignored replacement tail.
assert.equal(validateMercuryPlan({ op: 'complete', goals: [{ kind: 'collect', item: 'stone' }], reason: 'done' }).ok, false)
assert.equal(validateMercuryPlan({ op: 'abandon', goals: [{ kind: 'collect', item: 'stone' }], reason: 'switch' }).ok, true)
assert.equal(validateMercuryPlan({ op: 'complete', goals: [], reason: 'done' }).ok, true)
assert.equal(validateMercuryPlan({ op: 'abandon', goals: [], reason: 'switch' }).ok, true)

const reportBrain = new PlannerBrain({
  bot: {
    inventory: { items: () => [] },
    entity: { position: { x: 0, y: 64, z: 0 } },
    game: { dimension: 'minecraft:overworld' },
    health: 20,
    food: 20,
    registry: { blocksByName: {} },
    findBlocks: () => [],
  } as never,
  world: emptyWorldMemory(),
  log: () => undefined,
  mode: 'llm',
  mercury: { model: 'inception/mercury-2.5', provider: 'mercury' } as never,
})

const liveStationWorld = augmentPlannerWorldWithLiveStations(
  {
    findBlocks: ({ matching }: { matching: (block: { name: string }) => boolean }) =>
      matching({ name: 'crafting_table' }) ? [{ x: 1, y: 64, z: 1 }] : [{ x: 2, y: 64, z: 2 }],
  } as never,
  emptyWorldMemory(),
)
assert.equal(liveStationWorld.craftingTables.length, 1)
assert.equal(liveStationWorld.furnaces.length, 1)
assert.equal(reportBrain.provider, 'none')
assert.equal(reportBrain.authorityModel, 'none')
// #11 role split: this stack reports the configured System2 WHAT authority only.
// Jev's WHICH/WHETHER policy provider and model are separately exposed by the
// controller; they are not concatenated into System2's provider/model identity.
assert.deepEqual(reportBrain.authorityStack, {
  provider: 'mercury',
  model: 'inception/mercury-2.5',
})

console.log('system2-causal-authority: PASS (causal authority regressions)')
