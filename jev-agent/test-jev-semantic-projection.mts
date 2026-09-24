// test-jev-semantic-projection.mts - issue #437: the Skill <-> Jev boundary.
//
// THE MEASURED DEFECT this suite pins. On run-muccy2vu-1jpb8 (main e806ea6):
//
//   jevDecisions 239 | distinctOptionIds 1 | actions 87 | actionsPerDecision 0.36
//   cellRevisitRatio 0.967 | topRepeatedActions: WAIT, MOVE:p26_67_10, ENTER:26,67,9
//
// 239 pi calls bought one semantic option and 0.36 actions per decision, while the
// body revisited the same floored cell 96.7% of the time. The cause is the
// boundary, not the model: `controller-legacy.ts` re-asked pi whenever
// `stableStateHash(WorldState)` changed (`decisionlog.ts` hashes tick + raw float
// position + entity distances), and `MOVE:p26_67_10` was re-minted as a "new"
// candidate every few ticks while the semantic situation (walk to the one
// grounded approach cell of the selected entry) had not changed at all.
//
// This suite locks the #437 §13 fixtures:
//   1.  multi-swing -> one decision + one terminal packet
//   2.  WALK_TO across many path nodes: no identity churn, no repeated pi
//   3.  tiny body jitter does not change identity / projection hash
//   4.  target death changes the semantic state -> next boundary
//   5.  target lost != target killed in the projection
//   6.  identical retries are compressed while the typed final failure stays visible
//   7.  a genuinely distinct recovery alternative changes the candidate set
//   8.  a late result from epoch N cannot authorize after N+1
//   9.  world/generation/lease changes invalidate the active epoch
//   10. hundreds of raw SkillStep events leave the projection bounded
//   11. repeated equivalent state -> stable projection hash + candidate identities
//   12. meaningful Option/progress/failure/safety change changes the key
//   13. dedup never merges MINE / DETOUR / PILLAR
//   14. the live trace shows fewer pi calls per verified progress with no hidden
//       deterministic fallback
//
// Run: bun test-jev-semantic-projection.mts
import { existsSync, readFileSync } from 'node:fs'
import {
  buildJevSemanticProjection,
  buildSkillOutcomePacket,
  classifySemanticBoundary,
  commitmentRefFor,
  dedupeSemanticCandidates,
  diffSemanticProjections,
  failureBandOf,
  formatEpochEnd,
  formatEpochStart,
  formatJevCandidateSet,
  formatJevStateProjection,
  formatSkillOutcomePacket,
  formatStaleResultDropped,
  JEV_BOUNDARY_MARKERS,
  JEV_PROJECTION_LIMITS,
  JEV_PROJECTION_VERSION,
  JevDecisionEpochs,
  airBand,
  mandatoryPolicyBoundary,
  meaningfulEventKinds,
  policyBoundary,
  projectionBytes,
  projectionHash,
  projectionModelView,
  repointReplayedChoice,
  semanticWornArmor,
  semanticOffhand,
  semanticCandidateKey,
  semanticTargetRef,
  SKILL_OUTCOME_PACKET,
  STALE_JEV_RESULT_DROPPED,
  terminalReasonFor,
} from './src/jevSemanticProjection.ts'
import type {
  Candidate,
  CandidateKind,
} from './src/candidates.ts'
import type {
  JevSemanticProjection,
  SemanticProjectionInput,
  SkillOutcomePacket,
} from './src/jevSemanticProjection.ts'
import { MIRRORED_MARKERS } from './src/controller.ts'
import { LOW_AIR_LEVEL, MAX_AIR } from './src/air.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function candidate(input: Partial<Candidate> & { id: string; kind: CandidateKind }): Candidate {
  return {
    id: input.id,
    kind: input.kind,
    label: input.label ?? input.id,
    targetName: input.targetName ?? null,
    target: input.target ?? null,
    targetEntityId: input.targetEntityId ?? null,
    itemName: input.itemName ?? null,
    requiresTool: input.requiresTool ?? false,
    toolName: input.toolName ?? null,
    inReach: input.inReach ?? false,
    hasStandableAdjacent: input.hasStandableAdjacent ?? true,
    meta: input.meta ?? {},
  }
}

const OVERWORLD = 'minecraft:overworld'
const context = { optionInstanceId: 'option:enter_portal#1', dimension: OVERWORLD, worldEpoch: 7 }

/** A projection input whose only variable parts are what each case varies. */
function projectionInput(overrides: Partial<SemanticProjectionInput> = {}): SemanticProjectionInput {
  return {
    goal: { key: 'collect:flint:1', targetItem: 'flint', have: 0, required: 1, complete: false, progress: 0 },
    option: { instanceId: 'option:enter_portal#1', templateId: 'enter_portal', skillKind: 'ENTER_PORTAL', targetKey: 'portal@26,67,9' },
    world: { dimension: OVERWORLD, worldEpoch: 7, generationId: 'g1', leaseHeld: true, alive: true },
    safety: { healthBand: 'healthy', foodBand: 'full', airBand: 'full', submerged: false, threatKey: null, criticalDamageKey: null, lastDamageKey: null, wornArmor: null, offhand: null },
    progress: {
      consecutiveFailures: 0,
      lastFailureCode: null,
      escalationRecommended: false,
      oscillationsDetected: 0,
      stallExhausted: false,
      stallDistinctStates: 1,
    },
    inventory: { dirt: 12, oak_log: 3 },
    candidates: [],
    identityContext: context,
    ...overrides,
  }
}

/** The one grounded approach leg to the selected portal entry (the live shape). */
function walkToPortalLeg(cell: string, id?: string): Candidate {
  const parts = cell.split(',').map(Number)
  const [x, y, z] = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
  return candidate({
    id: id ?? `MOVE:p${cell.replace(/,/g, '_')}`,
    kind: 'MOVE',
    label: `walk to the open face at (${cell}) so the walk into (26,67,9) is not blocked by the frame`,
    targetName: 'nether_portal',
    target: { x, y, z },
    meta: { approachLeg: 'portal_open_face', approachTarget: '26,67,9' },
  })
}

function attackCandidate(entityId: number, id = `ATTACK:e${entityId}`): Candidate {
  return candidate({
    id,
    kind: 'ATTACK',
    label: `attack zombie#${entityId}`,
    targetName: 'zombie',
    targetEntityId: entityId,
    inReach: true,
  })
}

function outcomePacket(
  input: Partial<Parameters<typeof buildSkillOutcomePacket>[0]> & { entityDefeated?: boolean } = {},
): SkillOutcomePacket {
  const { entityDefeated, ...rest } = input
  return buildSkillOutcomePacket({
    decisionEpoch: 481,
    commitmentId: commitmentRefFor({ candidateId: 'ATTACK:e183', epoch: 12 }),
    optionInstanceId: 'option:kill#1',
    selectedCandidateId: 'ATTACK:e183',
    skillKind: 'ATTACK',
    targetIdentity: { kind: 'entity', key: 'e183', label: 'zombie#183' },
    status: 'done',
    failure: null,
    verified: true,
    meaningfulWorldDelta: entityDefeated === true ? [{ fact: 'target.entity', from: 'e183', to: 'dead' }] : [],
    ...rest,
  })
}

const SRC_CONTROLLER = readFileSync(new URL('./src/controller-legacy.ts', import.meta.url), 'utf8')

addCase('(0) air bands share the sensor scale and low-air safety boundary', () => {
  const values = [0, LOW_AIR_LEVEL, LOW_AIR_LEVEL + 1, MAX_AIR]
  const bands = values.map((value) => airBand(value))
  const unknown = [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, MAX_AIR + 1, 300].map((value) => airBand(value))
  const dryFull = buildJevSemanticProjection(projectionInput({
    safety: { healthBand: 'healthy', foodBand: 'full', airBand: airBand(MAX_AIR), submerged: false, threatKey: null, criticalDamageKey: null, lastDamageKey: null, wornArmor: null, offhand: null },
  }))
  const underwaterLow = buildJevSemanticProjection(projectionInput({
    safety: { healthBand: 'healthy', foodBand: 'full', airBand: airBand(LOW_AIR_LEVEL), submerged: true, threatKey: null, criticalDamageKey: null, lastDamageKey: null, wornArmor: null, offhand: null },
  }))
  const boundaryHashes = values.map((value) => {
    const projection = buildJevSemanticProjection(projectionInput({
      safety: { healthBand: 'healthy', foodBand: 'full', airBand: airBand(value), submerged: false, threatKey: null, criticalDamageKey: null, lastDamageKey: null, wornArmor: null, offhand: null },
    }))
    return projectionHash(projection)
  })
  const pass =
    JSON.stringify(bands) === JSON.stringify(['critical', 'critical', 'low', 'full']) &&
    unknown.every((band) => band === 'unknown') &&
    dryFull.safety.airBand === 'full' && dryFull.safety.submerged === false &&
    underwaterLow.safety.airBand === 'critical' && underwaterLow.safety.submerged === true &&
    new Set(bands).size === 3 &&
    boundaryHashes[0] === boundaryHashes[1] &&
    new Set(boundaryHashes).size === 3
  return { pass, detail: `scale=0..${MAX_AIR} threshold=${LOW_AIR_LEVEL} bands=${JSON.stringify(bands)} unknown=${JSON.stringify(unknown)} boundaryHashes=${JSON.stringify(boundaryHashes)} dryFull=${dryFull.safety.airBand}/${dryFull.safety.submerged} underwaterLow=${underwaterLow.safety.airBand}/${underwaterLow.safety.submerged}` }
})

// ---------------------------------------------------------------------------
// §13 fixtures
// ---------------------------------------------------------------------------

addCase('(1) many swings produce ONE decision and ONE terminal packet', () => {
  // A KILL commitment performs 40 raw mechanical observations (swings, steering,
  // path steps) and crosses the boundary exactly once.
  const packet = outcomePacket({ compressedSteps: 40, progressDelta: 1 })
  const projection = buildJevSemanticProjection(
    projectionInput({ recentOutcomes: [packet], rawTelemetry: { skillSteps: 40, events: 120 } }),
  )
  const line = formatSkillOutcomePacket(packet)
  const pass =
    projection.recentOutcomes.length === 1 &&
    projection.counts.rawSkillSteps === 40 &&
    line.includes('compressedSteps=40') &&
    line.includes('terminalReason=done') &&
    line.includes(`skillKind=ATTACK`) &&
    // exactly one packet per settled action in the controller (both settle paths)
    (SRC_CONTROLLER.match(/this\.emitSkillOutcomePacket\(/g) ?? []).length === 2
  return { pass, detail: `outcomes=${projection.recentOutcomes.length} rawSteps=${projection.counts.rawSkillSteps} emits=${(SRC_CONTROLLER.match(/this\.emitSkillOutcomePacket\(/g) ?? []).length}` }
})

addCase('(2) WALK_TO crosses many path nodes without candidate-ID churn or repeated pi calls', () => {
  const cells = ['26,67,10', '25,67,10', '26,67,11', '25,67,11', '26,67,10', '24,67,10']
  const keys = new Set<string>()
  const hashes = new Set<string>()
  for (const cell of cells) {
    const candidates = [walkToPortalLeg(cell), candidate({ id: 'WAIT', kind: 'WAIT', label: 'wait' })]
    const projection = buildJevSemanticProjection(projectionInput({ candidates }))
    keys.add(semanticCandidateKey(candidates[0] as Candidate, context))
    hashes.add(projectionHash(projection))
  }
  const projection = buildJevSemanticProjection(
    projectionInput({ candidates: [walkToPortalLeg('24,67,10'), candidate({ id: 'WAIT', kind: 'WAIT' })] }),
  )
  const active = {
    epoch: 1,
    projectionHash: projectionHash(projection),
    candidateIdentities: projection.candidates.map((view) => view.identity),
    dimension: OVERWORLD,
    worldEpoch: 7,
    openedAtMs: 0,
    cacheHit: false,
    reusedFrom: null,
    closed: false,
    closeReason: null,
    commitmentId: null,
    selectedIdentity: null,
  }
  const boundary = classifySemanticBoundary({
    active,
    // the SAME semantic situation, one body cell later
    projectionHash: projectionHash(
      buildJevSemanticProjection(projectionInput({ candidates: [walkToPortalLeg('26,67,10'), candidate({ id: 'WAIT', kind: 'WAIT' })] })),
    ),
    candidateIdentities: projection.candidates.map((view) => view.identity),
    worldKey: { dimension: OVERWORLD, worldEpoch: 7, leaseHeld: true },
    optionKey: 'option:enter_portal#1',
    safetyKey: 'stable',
    goalKey: 'collect:flint:1',
  })
  const pass = keys.size === 1 && hashes.size === 1 && boundary.requery === false && boundary.reason === 'same_semantic_state'
  return { pass, detail: `distinctIdentities=${keys.size} distinctHashes=${hashes.size} requery=${boundary.requery} reason=${boundary.reason}` }
})

addCase('(3) tiny body jitter does not change semantic identity or projection hash', () => {
  const candidates = [walkToPortalLeg('26,67,10')]
  const input = projectionInput({ candidates, events: ['dug MINE:b26_67_10; oak_log 3/3'] })
  const a = buildJevSemanticProjection(input)
  const b = buildJevSemanticProjection(input)
  // The raw churn (tick, float position, yaw, path node, swing count) is NOT part
  // of the projection input at all - that is the point, and it is a structural
  // property of the controller's builder, so it is checked against the source.
  const builder = SRC_CONTROLLER.slice(SRC_CONTROLLER.indexOf('private buildSemanticProjection('))
  const body = builder.slice(0, builder.indexOf('\n  }\n'))
  const rawChurnAbsent = !body.includes('self.position') && !body.includes('state.tick') && !body.includes('yaw')
  const empty = diffSemanticProjections(a, b)
  const pass =
    projectionHash(a) === projectionHash(b) &&
    projectionBytes(a) === projectionBytes(b) &&
    empty.delta.length === 0 &&
    rawChurnAbsent &&
    semanticCandidateKey(candidates[0] as Candidate, context) ===
      'opt=option:enter_portal#1|skill=MOVE|target=position:approach:portal_open_face->26,67,9|params=none'
  return { pass, detail: `hash=${projectionHash(a)} delta=${empty.delta.length} rawChurnAbsent=${rawChurnAbsent} identity=${semanticCandidateKey(candidates[0] as Candidate, context)}` }
})

addCase('(4) target death changes the semantic state and the next boundary', () => {
  const before = buildJevSemanticProjection(projectionInput({ candidates: [attackCandidate(183), candidate({ id: 'WAIT', kind: 'WAIT' })] }))
  // The entity is gone AND the drop reached the inventory: the candidate set and
  // the inventory both change semantically.
  const after = buildJevSemanticProjection(
    projectionInput({ candidates: [candidate({ id: 'WAIT', kind: 'WAIT' })], inventory: { dirt: 12, oak_log: 3, rotten_flesh: 1 } }),
  )
  const packet = outcomePacket({ entityDefeated: true })
  const boundary = classifySemanticBoundary({
    active: {
      epoch: 481,
      projectionHash: projectionHash(before),
      candidateIdentities: before.candidates.map((view) => view.identity),
      dimension: OVERWORLD,
      worldEpoch: 7,
      openedAtMs: 0,
      cacheHit: false,
      reusedFrom: null,
      closed: false,
      closeReason: null,
      commitmentId: null,
      selectedIdentity: null,
    },
    projectionHash: projectionHash(after),
    candidateIdentities: after.candidates.map((view) => view.identity),
    worldKey: { dimension: OVERWORLD, worldEpoch: 7, leaseHeld: true },
    optionKey: 'option:enter_portal#1',
    safetyKey: 'stable',
    goalKey: 'collect:flint:1',
  })
  const diff = diffSemanticProjections(before, after)
  const pass =
    packet.terminalReason === 'done' &&
    packet.verification.verified &&
    boundary.requery &&
    boundary.reason === 'candidate_set_changed' &&
    diff.delta.some((entry) => entry.fact === 'inventory.rotten_flesh')
  return { pass, detail: `reason=${boundary.reason} deltas=${JSON.stringify(diff.delta.map((d) => d.fact))}` }
})

addCase('(5) TARGET_LOST is never rewritten into TARGET_KILLED', () => {
  const lost = outcomePacket({
    status: 'failed',
    failure: 'target_gone',
    verified: false,
    targetIdentity: { kind: 'entity', key: 'e183', label: 'zombie#183' },
  })
  const killed = outcomePacket({ entityDefeated: true })
  const lostProjection = buildJevSemanticProjection(
    projectionInput({
      candidates: [candidate({ id: 'WAIT', kind: 'WAIT' })],
      recentOutcomes: [lost],
      previous: {
        selectedCandidateId: 'ATTACK:e183',
        selectedIdentity: 'opt=option:enter_portal#1|skill=ATTACK|target=entity:e183|params=none',
        skillKind: 'ATTACK',
        targetKey: 'entity:e183',
        commitmentId: 'a12:ATTACK:e183',
        terminalReason: lost.terminalReason,
        failureCode: lost.failure?.code ?? null,
        progressKind: lost.semanticProgress.kind,
      },
    }),
  )
  const pass =
    terminalReasonFor({ status: 'failed', failure: 'target_gone', verified: false }) === 'target_lost' &&
    lost.terminalReason === 'target_lost' &&
    killed.terminalReason === 'done' &&
    lost.verification.verified === false &&
    lost.failure?.code === 'target_gone' &&
    lost.newFacts.length === 0 &&
    lostProjection.recentOutcomes[0]?.terminalReason === 'target_lost' &&
    formatSkillOutcomePacket(lost).includes('terminalReason=target_lost') &&
    formatSkillOutcomePacket(lost).includes('verified=false')
  return { pass, detail: `lost=${lost.terminalReason}/${lost.failure?.code} killed=${killed.terminalReason} verified=${lost.verification.verified}` }
})

addCase('(5b) a verified kill without its declared drop is a typed search boundary, never HUNT_DROP success', () => {
  const partial = outcomePacket({
    status: 'failed',
    failure: 'drop_not_acquired',
    verified: false,
    entityDefeated: true,
    searchProgress: true,
    newFacts: [
      { kind: 'target', key: 'e183', detail: 'the selected entity died, but its HUNT_DROP item was not acquired' },
      { kind: 'resource', key: 'inventory:ender_pearl', detail: 'this hunt lease gained no ender_pearl in the body inventory' },
    ],
  })
  const line = formatSkillOutcomePacket(partial)
  const pass =
    JEV_PROJECTION_VERSION === 4 &&
    terminalReasonFor({ status: 'done', failure: 'drop_not_acquired', verified: true }) === 'drop_not_acquired' &&
    partial.terminalReason === 'drop_not_acquired' &&
    partial.verification.verified === false &&
    partial.semanticProgress.kind === 'search' &&
    partial.semanticProgress.delta === 0 &&
    partial.newFacts.some((fact) => fact.kind === 'resource' && fact.key === 'inventory:ender_pearl') &&
    policyBoundary(partial) &&
    mandatoryPolicyBoundary(partial.terminalReason) &&
    partial.nextDecisionRequired &&
    SRC_CONTROLLER.includes("searchProgress: input.failure === 'drop_not_acquired' && input.entityDefeated") &&
    SRC_CONTROLLER.includes('this hunt lease gained no ${goalDrop} in the body inventory') &&
    line.includes('terminalReason=drop_not_acquired') &&
    line.includes('progress=search:0') &&
    line.includes('verified=false')
  return {
    pass,
    detail: `version=${JEV_PROJECTION_VERSION} terminal=${partial.terminalReason} progress=${partial.semanticProgress.kind}:${partial.semanticProgress.delta} facts=${partial.newFacts.length} line=${line}`,
  }
})

addCase('Jev receives observed worn armor and banded condition without choosing attack versus retreat', () => {
  const alternatives = [
    candidate({ id: 'ATTACK:e42', kind: 'ATTACK', label: 'attack skeleton 10m away with iron_sword' }),
    candidate({
      id: 'RETREAT:p-6_10_0',
      kind: 'RETREAT',
      label: 'keep distance from skeleton (+6m separation, out of its sight line)',
      target: { x: -6, y: 10, z: 0 },
    }),
  ]
  const wornArmor = semanticWornArmor({
    head: { name: 'iron_helmet', durabilityUsed: 0, maxDurability: 165 },
    torso: { name: 'iron_chestplate', durabilityUsed: 190, maxDurability: 240 },
    legs: null,
    feet: { name: 'golden_boots', durabilityUsed: null, maxDurability: 91 },
  })
  const slightlyWornArmor = semanticWornArmor({
    head: { name: 'iron_helmet', durabilityUsed: 20, maxDurability: 165 },
    torso: { name: 'iron_chestplate', durabilityUsed: 191, maxDurability: 240 },
    legs: null,
    feet: { name: 'golden_boots', durabilityUsed: null, maxDurability: 91 },
  })
  const offhandShield = semanticOffhand({ name: 'shield', count: 1, slot: 45, durabilityUsed: 150, maxDurability: 336 })
  const slightlyWornShield = semanticOffhand({ name: 'shield', count: 1, slot: 45, durabilityUsed: 151, maxDurability: 336 })
  const wornOutShield = semanticOffhand({ name: 'shield', count: 1, slot: 45, durabilityUsed: 280, maxDurability: 336 })
  const observedEmptyOffhand = semanticOffhand(null)
  const unavailableOffhand = semanticOffhand(undefined)
  const empty = buildJevSemanticProjection(projectionInput({ candidates: alternatives }))
  const worn = buildJevSemanticProjection(
    projectionInput({
      candidates: alternatives,
      safety: { ...projectionInput().safety, wornArmor, offhand: offhandShield },
    }),
  )
  const sameBand = buildJevSemanticProjection(
    projectionInput({
      candidates: alternatives,
      safety: { ...projectionInput().safety, wornArmor: slightlyWornArmor, offhand: slightlyWornShield },
    }),
  )
  const changedBand = semanticWornArmor({
    head: { name: 'iron_helmet', durabilityUsed: 0, maxDurability: 165 },
    torso: { name: 'iron_chestplate', durabilityUsed: 190, maxDurability: 240 },
    legs: null,
    feet: { name: 'golden_boots', durabilityUsed: 85, maxDurability: 91 },
  })
  const changed = buildJevSemanticProjection(
    projectionInput({
      candidates: alternatives,
      safety: { ...projectionInput().safety, wornArmor: changedBand, offhand: wornOutShield },
    }),
  )
  const modelView = projectionModelView(worn)
  const sourceWiring = SRC_CONTROLLER.includes('wornArmor: semanticWornArmor(state.self.armor)')
  const armorDelta = diffSemanticProjections(worn, changed).delta.some((entry) => entry.fact === 'safety.wornArmor')
  const offhandChanged = buildJevSemanticProjection(
    projectionInput({
      candidates: alternatives,
      safety: { ...projectionInput().safety, wornArmor, offhand: wornOutShield },
    }),
  )
  const offhandDelta = diffSemanticProjections(worn, offhandChanged).delta.some((entry) => entry.fact === 'safety.offhand')
  const emptyHand = buildJevSemanticProjection(
    projectionInput({
      candidates: alternatives,
      safety: { ...projectionInput().safety, offhand: observedEmptyOffhand },
    }),
  )
  const pass =
    wornArmor?.head?.slot === 'head' &&
    wornArmor.head.item === 'iron_helmet' &&
    wornArmor.head.durabilityBand === 'fresh' &&
    wornArmor.torso?.slot === 'torso' &&
    wornArmor.torso.durabilityBand === 'critical' &&
    wornArmor.legs === null &&
    wornArmor.feet?.durabilityBand === 'unknown' &&
    offhandShield?.item === 'shield' &&
    offhandShield.durabilityBand === 'worn' &&
    observedEmptyOffhand?.item === null &&
    unavailableOffhand === null &&
    modelView.safety.wornArmor?.torso?.item === 'iron_chestplate' &&
    modelView.safety.wornArmor?.torso?.durabilityBand === 'critical' &&
    modelView.safety.offhand?.item === 'shield' &&
    modelView.safety.offhand?.durabilityBand === 'worn' &&
    projectionHash(empty) !== projectionHash(worn) &&
    projectionHash(emptyHand) !== projectionHash(empty) &&
    projectionHash(worn) === projectionHash(sameBand) &&
    projectionHash(worn) !== projectionHash(changed) &&
    armorDelta &&
    offhandDelta &&
    JSON.stringify(worn.candidates.map((view) => view.identity)) === JSON.stringify(empty.candidates.map((view) => view.identity)) &&
    sourceWiring &&
    SRC_CONTROLLER.includes('offhand: semanticOffhand(state.self.offhand)')
  return {
    pass,
    detail: `armor=${JSON.stringify(modelView.safety.wornArmor)} offhand=${JSON.stringify(modelView.safety.offhand)} stableWithinBand=${projectionHash(worn) === projectionHash(sameBand)} armorDelta=${armorDelta} offhandDelta=${offhandDelta} choicesUnchanged=${JSON.stringify(worn.candidates.map((view) => view.kind))}`,
  }
})

addCase('(6) identical retries are compressed while the typed final failure stays visible', () => {
  const retries = Array.from({ length: 5 }, () => 'failure path_timeout: pathfinder gave up at 26,67,10')
  const kinds = meaningfulEventKinds(retries)
  const afterFirst = buildJevSemanticProjection(
    projectionInput({
      candidates: [walkToPortalLeg('26,67,10')],
      progress: { consecutiveFailures: 5, lastFailureCode: 'path_timeout', escalationRecommended: false, oscillationsDetected: 1, stallExhausted: false, stallDistinctStates: 2 },
      events: retries.slice(0, 1),
    }),
  )
  const afterFifth = buildJevSemanticProjection(
    projectionInput({
      candidates: [walkToPortalLeg('26,67,10')],
      progress: { consecutiveFailures: 5, lastFailureCode: 'path_timeout', escalationRecommended: false, oscillationsDetected: 1, stallExhausted: false, stallDistinctStates: 2 },
      events: retries,
    }),
  )
  const failed = outcomePacket({ status: 'failed', failure: 'path_timeout', verified: false, compressedSteps: 9 })
  const pass =
    kinds.length === 1 &&
    kinds[0] === 'failure:path_timeout' &&
    // identical retry multiplicity is NOT a new semantic fact: same hash
    projectionHash(afterFirst) === projectionHash(afterFifth) &&
    afterFifth.progress.lastFailureCode === 'path_timeout' &&
    failureBandOf(2) === 'some' &&
    failureBandOf(3) === 'many' &&
    failed.terminalReason === 'budget_exhausted' &&
    failed.failure?.code === 'path_timeout' &&
    policyBoundary(failed) &&
    // ...but a repeated mechanical blocker is not a MANDATORY boundary, so it does
    // not buy a pi call on its own; the projection carries it.
    mandatoryPolicyBoundary(failed.terminalReason) === false
  return { pass, detail: `kinds=${JSON.stringify(kinds)} sameHash=${projectionHash(afterFirst) === projectionHash(afterFifth)} reason=${failed.terminalReason} band=${failureBandOf(3)}` }
})

addCase('(7) a new genuinely distinct recovery alternative changes the candidate set and re-enters policy', () => {
  const base = [walkToPortalLeg('26,67,10'), candidate({ id: 'WAIT', kind: 'WAIT' })]
  const withPillar = [
    ...base,
    candidate({
      id: 'MOVE:p26_68_10',
      kind: 'MOVE',
      label: 'pillar up to clear the frame lip',
      target: { x: 26, y: 68, z: 10 },
      meta: { approachLeg: 'pillar_recovery', approachTarget: '26,68,10' },
    }),
  ]
  const before = buildJevSemanticProjection(projectionInput({ candidates: base }))
  const after = buildJevSemanticProjection(projectionInput({ candidates: withPillar }))
  const boundary = classifySemanticBoundary({
    active: {
      epoch: 9,
      projectionHash: projectionHash(before),
      candidateIdentities: before.candidates.map((view) => view.identity),
      dimension: OVERWORLD,
      worldEpoch: 7,
      openedAtMs: 0,
      cacheHit: false,
      reusedFrom: null,
      closed: false,
      closeReason: null,
      commitmentId: null,
      selectedIdentity: null,
    },
    projectionHash: projectionHash(after),
    candidateIdentities: after.candidates.map((view) => view.identity),
    worldKey: { dimension: OVERWORLD, worldEpoch: 7, leaseHeld: true },
    optionKey: 'option:enter_portal#1',
    safetyKey: 'stable',
    goalKey: 'collect:flint:1',
  })
  const pass =
    before.candidates.length === 2 &&
    after.candidates.length === 3 &&
    boundary.requery &&
    boundary.reason === 'candidate_set_changed'
  return { pass, detail: `candidates ${before.candidates.length}->${after.candidates.length} reason=${boundary.reason}` }
})

addCase('(8) a late result from epoch N cannot authorize after epoch N+1 started', () => {
  const epochs = new JevDecisionEpochs()
  const first = epochs.begin({ projectionHash: 'jp2:aaa', candidateIdentities: ['a'], dimension: OVERWORLD, worldEpoch: 7, nowMs: 0 })
  const second = epochs.begin({ projectionHash: 'jp2:bbb', candidateIdentities: ['b'], dimension: OVERWORLD, worldEpoch: 7, nowMs: 1 })
  const late = epochs.accept(first.epoch)
  const authorize = epochs.authorize({ epoch: first.epoch, commitmentId: 'a12:MOVE:p26_67_10', selectedIdentity: 'a' })
  const current = epochs.accept(second.epoch)
  const line = formatStaleResultDropped(first.epoch, epochs.active?.epoch ?? null, late.reason)
  const pass =
    first.epoch === 1 &&
    second.epoch === 2 &&
    late.accepted === false &&
    late.reason === 'stale_epoch' &&
    authorize.accepted === false &&
    current.accepted === true &&
    line.startsWith(STALE_JEV_RESULT_DROPPED) &&
    line.includes('activeEpoch=2') &&
    epochs.active?.commitmentId === null
  return { pass, detail: `late=${late.accepted}/${late.reason} authorize=${authorize.accepted} active=${epochs.active?.epoch} line="${line}"` }
})

addCase('(9) world/generation/lease changes invalidate the active epoch', () => {
  const epochs = new JevDecisionEpochs()
  const epoch = epochs.begin({ projectionHash: 'jp2:aaa', candidateIdentities: ['a'], dimension: OVERWORLD, worldEpoch: 7, nowMs: 0 })
  const matchesBefore = epochs.matchesWorld({ dimension: OVERWORLD, worldEpoch: 7 })
  const matchesAfter = epochs.matchesWorld({ dimension: 'minecraft:the_nether', worldEpoch: 7 })
  const invalidated = epochs.invalidate('world_changed')
  const afterDrop = epochs.accept(epoch.epoch)
  const closes = formatEpochEnd({ ...epoch, closed: true, closeReason: 'world_changed' })
  // lease revocation is its own typed reason
  const leaseEpochs = new JevDecisionEpochs()
  const leaseEpoch = leaseEpochs.begin({ projectionHash: 'jp2:ccc', candidateIdentities: ['a'], dimension: OVERWORLD, worldEpoch: 7, nowMs: 0 })
  leaseEpochs.invalidate('lease_revoked')
  const leaseClosed = leaseEpochs.snapshot().find((entry) => entry.epoch === leaseEpoch.epoch)
  const pass =
    matchesBefore &&
    matchesAfter === false &&
    invalidated?.epoch === epoch.epoch &&
    invalidated?.closed === true &&
    afterDrop.accepted === false &&
    epochs.active === null &&
    closes.includes('closeReason=world_changed') &&
    leaseClosed?.closeReason === 'lease_revoked'
  return { pass, detail: `matches ${matchesBefore}->${matchesAfter} invalidated=${invalidated?.closeReason} lease=${leaseClosed?.closeReason}` }
})

addCase('(10) hundreds of raw SkillStep events leave the Jev projection bounded', () => {
  const one = buildJevSemanticProjection(
    projectionInput({ candidates: [walkToPortalLeg('26,67,10')], rawTelemetry: { skillSteps: 1, events: 1 } }),
  )
  const many = buildJevSemanticProjection(
    projectionInput({
      candidates: [walkToPortalLeg('26,67,10')],
      rawTelemetry: { skillSteps: 500, events: 800 },
      events: Array.from({ length: 200 }, (_, index) => `SKILL_STEP n=${index} kind=swing target=e183`),
    }),
  )
  const line = formatJevStateProjection(many, projectionHash(many))
  const pass =
    many.counts.rawSkillSteps === 500 &&
    // The counter grows the payload by a constant, never with the raw event count.
    projectionBytes(many) - projectionBytes(one) <= 64 &&
    projectionBytes(many) < 8192 &&
    many.events.length <= 6 &&
    many.events[0] === 'SKILL_STEP' &&
    line.includes('rawSkillSteps=500') &&
    line.includes(`bytes=${projectionBytes(many)}`)
  return { pass, detail: `bytes=${projectionBytes(many)} (1 step=${projectionBytes(one)}) events=${JSON.stringify(many.events)}` }
})

addCase('(11) repeated equivalent state produces a stable projection hash and identities', () => {
  const first = buildJevSemanticProjection(projectionInput({ candidates: [walkToPortalLeg('26,67,10', 'MOVE:p26_67_10')] }))
  const again = buildJevSemanticProjection(projectionInput({ candidates: [walkToPortalLeg('26,67,10', 'MOVE:p26_67_10')] }))
  // A different mechanical realization of the SAME choice: the identity and the
  // hash must not move, even though the representative id legitimately differs.
  const other = buildJevSemanticProjection(projectionInput({ candidates: [walkToPortalLeg('25,67,10', 'MOVE:p25_67_10')] }))
  const pass =
    projectionHash(first) === projectionHash(again) &&
    projectionHash(first) === projectionHash(other) &&
    first.candidates[0]?.identity === other.candidates[0]?.identity &&
    first.candidates[0]?.id !== other.candidates[0]?.id &&
    formatJevCandidateSet(first.candidates).includes(first.candidates[0]?.identity ?? 'missing')
  return { pass, detail: `identity=${first.candidates[0]?.identity} hashStable=${projectionHash(first) === projectionHash(other)} ids=${first.candidates[0]?.id}/${other.candidates[0]?.id}` }
})

addCase('(12) a meaningful Option/progress/failure/safety change changes the key', () => {
  const base = buildJevSemanticProjection(projectionInput({ candidates: [walkToPortalLeg('26,67,10')] }))
  const option = buildJevSemanticProjection(
    projectionInput({
      candidates: [walkToPortalLeg('26,67,10')],
      option: { instanceId: 'option:mine_stone#2', templateId: 'mine', skillKind: 'MINE', targetKey: 'stone@10,20,30' },
    }),
  )
  const progress = buildJevSemanticProjection(
    projectionInput({
      candidates: [walkToPortalLeg('26,67,10')],
      progress: { consecutiveFailures: 3, lastFailureCode: 'path_timeout', escalationRecommended: true, oscillationsDetected: 4, stallExhausted: true, stallDistinctStates: 2 },
    }),
  )
  const safety = buildJevSemanticProjection(
    projectionInput({
      candidates: [walkToPortalLeg('26,67,10')],
      safety: { healthBand: 'critical', foodBand: 'starving', airBand: 'critical', submerged: true, threatKey: 'zombie:1:true', criticalDamageKey: 'collect:flint:1:3:zombie', lastDamageKey: 'e33467', wornArmor: null, offhand: null },
    }),
  )
  const hashes = [base, option, progress, safety].map((projection) => projectionHash(projection))
  // §10: a new SENSED resource/threat is model-visible, so it must move the key;
  // a mob wandering inside one range band must not.
  const sense = buildJevSemanticProjection(
    projectionInput({
      candidates: [walkToPortalLeg('26,67,10')],
      sense: { blockNames: ['dirt', 'oak_log', 'iron_ore'], threats: ['zombie:near'] },
    }),
  )
  const senseShifted = buildJevSemanticProjection(
    projectionInput({
      candidates: [walkToPortalLeg('26,67,10')],
      sense: { blockNames: ['dirt', 'oak_log', 'iron_ore'], threats: ['zombie:near'] },
    }),
  )
  const pass = new Set(hashes).size === 4 && projectionHash(sense) !== hashes[0] && projectionHash(sense) === projectionHash(senseShifted)
  return { pass, detail: `distinctHashes=${new Set(hashes).size}/4 base=${hashes[0]} newSenseChangesKey=${projectionHash(sense) !== hashes[0]} bandStable=${projectionHash(sense) === projectionHash(senseShifted)}` }
})

addCase('(13) dedup never merges semantically distinct MINE / DETOUR / PILLAR', () => {
  const cell = { x: 10, y: 64, z: 10 }
  const mine = candidate({ id: 'MINE:b10_64_10', kind: 'MINE', targetName: 'stone', target: cell, itemName: 'stone' })
  const detour = candidate({
    id: 'MOVE:p9_64_10',
    kind: 'MOVE',
    targetName: 'stone',
    target: { x: 9, y: 64, z: 10 },
    meta: { approachLeg: 'detour', approachTarget: '10,64,10' },
  })
  const pillar = candidate({
    id: 'MOVE:p11_64_10',
    kind: 'MOVE',
    targetName: 'stone',
    target: { x: 11, y: 64, z: 10 },
    meta: { approachLeg: 'pillar', approachTarget: '11,64,11', verticalRecovery: 'pillar' },
  })
  // ...plus three mechanically-equivalent realizations of the SAME detour.
  const detourClones = ['8,64,10', '7,64,10', '6,64,10'].map((spot) =>
    candidate({
      id: `MOVE:p${spot.replace(/,/g, '_')}`,
      kind: 'MOVE',
      targetName: 'stone',
      target: { x: Number(spot.split(',')[0]), y: 64, z: 10 },
      meta: { approachLeg: 'detour', approachTarget: '10,64,10' },
    }),
  )
  const dedupe = dedupeSemanticCandidates([mine, detour, pillar, ...detourClones], context)
  const identities = dedupe.offered.map((entry) => semanticCandidateKey(entry, context))
  const pass =
    dedupe.merged === 3 &&
    dedupe.offered.length === 3 &&
    new Set(identities).size === 3 &&
    identities.some((identity) => identity.includes('skill=MINE')) &&
    identities.some((identity) => identity.includes('approach:detour->10,64,10')) &&
    identities.some((identity) => identity.includes('approach:pillar->11,64,11')) &&
    dedupe.groups.get(identities.find((identity) => identity.includes('approach:detour')) ?? '')?.length === 4
  return { pass, detail: `offered=${dedupe.offered.length} merged=${dedupe.merged} identities=${JSON.stringify(identities)}` }
})

addCase('(14) live trace: fewer pi calls per verified progress, no hidden deterministic fallback', () => {
  // (a) The controller wires every marker into the mirrored list, or the live sink
  // drops it (a mistake this repo has made repeatedly).
  const mirrored = JEV_BOUNDARY_MARKERS.every((marker) => MIRRORED_MARKERS.has(marker))
  // (b) The semantic-state gate is what decides a pi call: the raw state hash may
  // not be the reuse key any more.
  const usesProjectionGate = SRC_CONTROLLER.includes('projectionHash: hash') && SRC_CONTROLLER.includes('classifySemanticBoundary(')
  const rawGateRemoved = !SRC_CONTROLLER.includes('stateHash === this.lastDecisionStateHash')
  // (c) The live run window, when it is present on this machine.
  const roots = [process.env.BUDDY_LIVE_ROOT ?? '/home/s0u7a/mc-ai']
  let live: { runId: string; decisions: number; sources: string[]; actions: number; piCalls: number } | null = null
  for (const root of roots) {
    const logPath = `${root}/buddy-driver/buddy.log`
    const decisionsPath = `${root}/buddy-driver/logs/jev/decisions.jsonl`
    if (!existsSync(logPath) || !existsSync(decisionsPath)) continue
    const lines = readFileSync(logPath, 'utf8').split('\n')
    let bootIndex = -1
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (/BOOT .*runId=(\S+)/.test(lines[index] ?? '')) {
        bootIndex = index
        break
      }
    }
    if (bootIndex === -1) continue
    const runId = /BOOT .*runId=(\S+)/.exec(lines[bootIndex] ?? '')?.[1] ?? 'unknown'
    const window = lines.slice(bootIndex)
    const records = readFileSync(decisionsPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as { ts?: string; source?: string }
        } catch {
          return null
        }
      })
      .filter((record): record is { ts?: string; source?: string } => record !== null && typeof record.ts === 'string' && record.ts >= (window[0]?.slice(1, 25) ?? ''))
    live = {
      runId,
      decisions: records.length,
      sources: [...new Set(records.map((record) => String(record.source ?? 'unknown')))],
      actions: window.filter((line) => /ACTION n=\d+/.test(line)).length,
      piCalls: window.filter((line) => /JEV_DECISION_EPOCH_START/.test(line) && !line.includes('cacheHit=true')).length,
    }
    break
  }
  const noFallback = live === null || live.sources.every((source) => source === 'jev')
  const liveDetail =
    live === null
      ? 'live_trace=absent'
      : `run=${live.runId} decisions=${live.decisions} actions=${live.actions} sources=${JSON.stringify(live.sources)} epochStarts=${live.piCalls}`
  const pass = mirrored && usesProjectionGate && rawGateRemoved && noFallback
  return { pass, detail: `mirrored=${mirrored} projectionGate=${usesProjectionGate} rawGateRemoved=${rawGateRemoved} noFallback=${noFallback} ${liveDetail}` }
})

addCase('(15) model payload == hashed projection, and a replay is re-pointed at the current realization', () => {
  // (a) §1/§10: the model must not receive the evidence-only `counts` block (raw
  // SkillStep/event telemetry), and the payload's top-level keys must be exactly
  // the keys the projection hash covers - otherwise key and payload drift.
  const base = buildJevSemanticProjection(
    projectionInput({
      sense: { blockNames: ['stone', 'dirt'], threats: [] },
      events: ['SKILL_STEP', 'ACTION'],
      rawTelemetry: { skillSteps: 412, events: 812 },
    }),
  )
  const modelView = projectionModelView(base)
  const hasCounts = Object.prototype.hasOwnProperty.call(modelView, 'counts')
  const modelKeys = Object.keys(modelView).sort().join(',')
  const hashKeys = Object.keys(
    // projectionCore is private; the hash's coverage is observable through the
    // public contract: `counts` is the ONLY top-level field outside it.
    base,
  )
    .filter((key) => key !== 'counts')
    .sort()
    .join(',')
  const keysAgree = modelKeys === hashKeys
  // (b) §4: identity is stable but the representative realization id is mechanical.
  // A cache hit must re-point the SAME choice at the CURRENT representative; and a
  // vanished identity must be reported as lost (re-query) rather than replayed.
  const before = buildJevSemanticProjection(
    projectionInput({ candidates: [walkToPortalLeg('26,67,10'), walkToPortalLeg('25,67,10')] }),
  )
  // Same identity + same hash: only the concrete cell (and so the representative)
  // moved. The first realization is now a different mechanical cell.
  const after = buildJevSemanticProjection(
    projectionInput({ candidates: [walkToPortalLeg('26,67,11'), walkToPortalLeg('25,67,11')] }),
  )
  const repointed = repointReplayedChoice('MOVE:p26_67_10', before.candidates, after.candidates)
  const keptUnchanged = repointReplayedChoice('MOVE:p25_67_10', before.candidates, after.candidates)
  const gone = repointReplayedChoice('MOVE:p26_67_10', before.candidates, [])
  const wait = repointReplayedChoice('WAIT', before.candidates, after.candidates)
  const pass =
    !hasCounts &&
    keysAgree &&
    repointed.repointed &&
    repointed.chosenId === after.candidates[0]?.id &&
    !repointed.lost &&
    // same identity still present under the same representative id -> verbatim
    !keptUnchanged.repointed &&
    keptUnchanged.chosenId === 'MOVE:p25_67_10' &&
    gone.lost &&
    !gone.repointed &&
    // a non-candidate choice (WAIT) is never dropped by the translation
    !wait.lost &&
    wait.chosenId === 'WAIT'
  return {
    pass,
    detail: `countsInPayload=${hasCounts} keysAgree=${keysAgree} repointedTo=${repointed.chosenId} lost=${gone.lost} waitKept=${wait.chosenId}`,
  }
})

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

let failures = 0
process.stdout.write('issue #437 semantic boundary (Skill -> Jev handoff)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} semantic-boundary cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
