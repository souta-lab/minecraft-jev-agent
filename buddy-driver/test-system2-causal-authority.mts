// Regression coverage for the causal System2/Option boundary exposed by the
// captured M2 audit. Pure fixtures: no server, bot, network, or model call.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyActionOutcome, truthfulActionOutcome } from '../jev-agent/src/actionPostcondition.ts'
import { canAuthoritativelyAbandonOption } from '../jev-agent/src/controller-legacy.ts'
import { DEFAULT_LLM_MODEL } from '../jev-agent/src/jev.ts'
import { GoalQueue } from '../jev-agent/src/goalQueue.ts'
import { applyCompiledPlan, currentOptionContextForQueuedGoal, makeOptionSnapshot } from '../jev-agent/src/optionSpec.ts'
import { buildAuthorityQuestions } from '../jev-agent/src/jev-authority.ts'
import { evaluateSystem2Apply, system2BodyOwned } from '../jev-agent/src/system2Authority.ts'
import {
  evaluateBetaTerminationBoundary,
  evaluateCandidateStarvationBoundary,
  shouldWakeSystem2AfterLocalFailure,
} from '../jev-agent/src/system2Escalation.ts'
import { system2AuthorityIdentity } from '../jev-agent/src/system2.ts'
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
  authorityEpoch: 11,
}
const stale = evaluateSystem2Apply(request, {
  queueRevision: 7,
  optionInstanceId: 'instance-old',
  optionTemplateId: 'explore:cave',
  worldEpoch: 4,
  stateFingerprint: 'fp-after-descend',
  authorityEpoch: 12,
  actionInFlight: false,
})
assert.equal(stale.apply, false)
assert.ok(stale.reasons.includes('state_fingerprint_changed'))
assert.ok(stale.reasons.includes('authority_epoch_changed'))
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
  cachePath: join(mkdtempSync(join(tmpdir(), 'system2-authority-report-')), 'cache.json'),
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
// #11 role split: the planner authority is the LLM side and defaults to
// DEFAULT_LLM_MODEL (Jev's own model is unchanged and only Jev's policy uses it).
// Reference the constant so a model change cannot silently drift this fixture.
assert.deepEqual(reportBrain.authorityStack, {
  provider: 'hybrid',
  model: `typesafe-ai:${DEFAULT_LLM_MODEL}|mercury:inception/mercury-2.5`,
})

console.log('system2-causal-authority: PASS (causal authority regressions)')
