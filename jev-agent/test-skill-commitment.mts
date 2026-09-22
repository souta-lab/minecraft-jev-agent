// issue #436 Phase 1 - the SkillCommitment contract + evidence, and the #437
// decision-epoch/packet interface on the Skill side.
//
// What this fixture pins (no behaviour expansion; the commitment layer must be
// invisible to execution and load-bearing for evidence):
//
//   1. ONE policy selection produces ONE commitment whose identity spans the
//      whole action: SKILL_COMMIT -> SKILL_STEP(authority=MECHANICAL_CONTINUATION)
//      -> SKILL_END all carry the same commitmentId, and the settled
//      ExecutionResult carries that commitmentId + typed skillOutcome.
//   2. The declared EffectEnvelope is enforced: a step outside it FAILS CLOSED
//      (typed `effect_envelope_violation`, no side effect performed), and the
//      envelope cannot silently expand.
//   3. Target identity is causal and exact: an ATTACK commitment targets the
//      entity ID (not the mob type), `targetIdentityViolation` names a change,
//      and world/epoch/lease changes invalidate a commitment (with
//      `enter_portal`'s dimension change as the deliberate exception).
//   4. A late/superseded action can never resurrect its commitment: its outcome
//      is LEASE_REVOKED and the active commitment belongs to the newer action.
//   5. Deterministic DONE stays code-owned (the §2 reason is `done`, no policy
//      boundary), while a typed invalidity maps to a policy-boundary reason.
//   6. #437 section 3: ONE vocabulary. `SKILL_COMMIT` / `SKILL_OUTCOME_PACKET` /
//      `STALE_JEV_RESULT_DROPPED` are formatted by `jevSemanticProjection.ts`, and
//      the REAL `SkillCommitment.commitmentId` + `CausalTargetIdentity` key are
//      what they carry - the commitment layer defines none of those markers.
//   7. Lifecycle invalidation (section 14/23): a worldEpoch change fails a live
//      commitment closed, and an UNOBSERVED dimension is not a verdict.
//   8. §3's forbidden `candidateCount == 1 -> skip Jev` shortcut does not exist
//      in the contract module's surface.
//
//   bun test ./test-skill-commitment.mts
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { Bot } from 'mineflayer'
import { Executor, defaultExecutorOptions } from './src/executor.ts'
import { EventLogger } from './src/jev.ts'
import type { AgentLevel } from './src/jev-legacy.ts'
import type { Candidate } from './src/candidates.ts'
import {
  commitmentInvalidation,
  createSkillCommitment,
  declaredPostconditions,
  effectEnvelopeHash,
  effectViolation,
  envelopeExpanded,
  envelopeForCandidate,
  formatSkillPolicyBoundary,
  isPolicyBoundaryOutcome,
  skillOutcomeForFailure,
  skillTerminalReasonFor,
  targetIdentityKey,
  targetIdentityOf,
  targetIdentityViolation,
  sameTargetIdentity,
} from './src/skillCommitment.ts'
import type { CausalTargetIdentity, EffectEnvelope } from './src/skillCommitment.ts'
import * as skillCommitment from './src/skillCommitment.ts'
import {
  buildSkillOutcomePacket,
  formatSkillCommit,
  formatSkillOutcomePacket,
  formatStaleResultDropped,
  policyBoundary,
  STALE_JEV_RESULT_DROPPED,
  terminalReasonFor,
} from './src/jevSemanticProjection.ts'

const require = createRequire(import.meta.url)
const REGISTRY = require('minecraft-data')('1.21.11')

class CapturingLogger extends EventLogger {
  readonly lines: string[] = []
  constructor() {
    super(null, false)
  }
  override log(
    source: string,
    level: AgentLevel,
    message: string,
    detail: Record<string, unknown> = {},
    tick: number | null = null,
  ): void {
    this.lines.push(message)
    super.log(source, level, message, detail, tick)
  }
  has(prefix: string): boolean {
    return this.lines.some((line) => line.startsWith(prefix))
  }
  matching(prefix: string): string[] {
    return this.lines.filter((line) => line.startsWith(prefix))
  }
  containing(fragment: string): string[] {
    return this.lines.filter((line) => line.includes(fragment))
  }
}

interface Fixture {
  bot: Bot
  logger: CapturingLogger
  equips: () => number
  swings: () => number
  armorSlots: ({ name?: string } | null)[]
}

function makeFixture(options: { armorWorn?: string } = {}): Fixture {
  const emitter = new EventEmitter()
  const chestId = REGISTRY.itemsByName.iron_chestplate.id
  const swordId = REGISTRY.itemsByName.iron_sword.id
  const armorSlots: ({ name?: string } | null)[] = new Array(46).fill(null)
  if (options.armorWorn !== undefined) armorSlots[6] = { name: options.armorWorn }
  let equips = 0
  let swings = 0
  const mob = { id: 31, name: 'zombie', kind: 'hostile', height: 1.95, isValid: true, position: { x: 1, y: 64, z: 0 } }
  let heldName: string | null = 'cobblestone'
  const bot = emitter as EventEmitter & Record<string, any>
  Object.assign(bot, {
    registry: REGISTRY,
    health: 20,
    physicsEnabled: true,
    entity: { id: 1, position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, onGround: true, width: 0.6, height: 1.8 },
    entities: { 31: mob },
    game: { dimension: 'minecraft:overworld' },
    inventory: {
      slots: armorSlots,
      items: () => [
        { name: 'iron_chestplate', type: chestId, count: 1, slot: 39 },
        { name: 'iron_sword', type: swordId, count: 1, slot: 36 },
      ],
      count: (id: number) => (id === chestId ? 1 : id === swordId ? 1 : 0),
    },
    pathfinder: {
      setMovements: () => undefined,
      setGoal: () => undefined,
      stop: () => undefined,
      getPathTo: () => ({ status: 'success', path: [] }),
    },
    lookAt: async () => undefined,
    equip: async (item: { name: string }, destination: string) => {
      equips += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      // issue #436 section 11: the executor VERIFIES the live main hand after a
      // weapon equip, so the fixture models it like the real bot does.
      if (destination === 'hand') heldName = item.name
      const index = { head: 5, torso: 6, legs: 7, feet: 8 }[destination as 'head' | 'torso' | 'legs' | 'feet']
      if (index !== undefined) armorSlots[index] = { name: item.name }
    },
    attack: () => {
      swings += 1
      setTimeout(() => emitter.emit('entityHurt', mob, bot.entity), 5)
    },
    stopDigging: () => undefined,
    setControlState: () => undefined,
  })
  Object.defineProperty(bot, 'heldItem', {
    get: () => (heldName === null ? null : { name: heldName, type: 1, count: 64, slot: 36 }),
    configurable: true,
  })
  return { bot: bot as unknown as Bot, logger: new CapturingLogger(), equips: () => equips, swings: () => swings, armorSlots }
}

const PROVENANCE = {
  decisionEpoch: 7,
  decisionId: 'call_abc123',
  optionInstanceId: 'opt_nether_1',
  selectedBy: 'jev',
  stateFingerprint: 'hash_xyz',
  worldEpoch: 3,
}

function equipCandidate(): Candidate {
  return {
    id: 'EQUIP:torso:iron_chestplate',
    kind: 'EQUIP',
    label: 'equip iron_chestplate to torso',
    targetName: 'iron_chestplate',
    target: null,
    targetEntityId: null,
    itemName: 'iron_chestplate',
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 1, slot: 'torso', itemName: 'iron_chestplate', replaced: 'none', ...PROVENANCE },
  }
}

function attackCandidate(entityId: number): Candidate {
  return {
    id: `ATTACK:e${entityId}`,
    kind: 'ATTACK',
    label: 'attack zombie',
    targetName: 'zombie',
    target: { x: 1, y: 64, z: 0 },
    targetEntityId: entityId,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 1, entityId, distance: 1, ...PROVENANCE },
  }
}

function makeExecutor(
  fixture: Fixture,
  options: { envelopeOverride?: EffectEnvelope; observedWorldEpoch?: () => number } = {},
): Executor {
  return new Executor(fixture.bot, fixture.logger, {
    ...defaultExecutorOptions,
    goalItem: 'iron_chestplate',
    verifyTimeoutMs: 300,
    pickupPathTimeoutMs: 300,
    ...(options.envelopeOverride === undefined ? {} : { effectEnvelopeOverride: options.envelopeOverride }),
    ...(options.observedWorldEpoch === undefined ? {} : { observedWorldEpoch: options.observedWorldEpoch }),
  })
}

const FULL_ENVELOPE: EffectEnvelope = {
  mayMove: true,
  mayLook: true,
  mayJump: true,
  maySprint: true,
  mayAttackEntityIds: [],
  mayDigBlocks: [],
  mayPlaceBlocks: [],
  mayEquipItems: [],
  mayUseStations: [],
  mayTransferInventory: [],
}

let total = 0
let failures = 0
const report = (pass: boolean, name: string, detail: string): void => {
  total += 1
  if (!pass) failures += 1
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}\n`)
  process.stdout.write(`      ${detail}\n`)
}

process.stdout.write('issue #436 Phase 1 - SkillCommitment identity, effect envelope, evidence\n')
process.stdout.write('issue #437 §2/§3 - SkillOutcomePacket + decision-epoch isolation\n')
process.stdout.write(`${'-'.repeat(84)}\n`)

// ===========================================================================
// 1. ONE selection -> ONE commitment identity across the whole action
// ===========================================================================

{
  const fixture = makeFixture()
  const result = await makeExecutor(fixture).claim(equipCandidate()).completion
  const steps = fixture.logger.matching('SKILL_STEP')
  const ends = fixture.logger.matching('SKILL_END')
  // The controller emits SKILL_COMMIT at the authorize site (section 3); the
  // executor emits the step/end evidence against the same commitment identity.
  const commitment = result.commitmentId ?? 'none'
  const commitLine = formatSkillCommit({
    epoch: 7,
    commitmentId: commitment,
    leaseEpoch: 1,
    candidateId: 'EQUIP:torso:iron_chestplate',
    selectedIdentity: 'EQUIP:torso:iron_chestplate',
    skillKind: 'EQUIP',
    projectionHash: 'ph_1',
  })
  const pass =
    result.status === 'done' &&
    result.verified === true &&
    result.skillOutcome === 'SUCCESS' &&
    result.skillTerminalReason === 'done' &&
    commitment.startsWith('c') &&
    steps.length >= 1 &&
    steps.every((line) => line.includes(`commitmentId=${commitment}`)) &&
    steps.some(
      (line) =>
        line.startsWith('SKILL_STEP skill=equip_item step=equip authority=MECHANICAL_CONTINUATION') &&
        line.includes('commitmentId='),
    ) &&
    ends.length === 1 &&
    ends[0]?.includes(`commitmentId=${commitment}`) === true &&
    ends[0]?.includes('outcome=SUCCESS') === true &&
    ends[0]?.includes('failureCode=none') === true &&
    ends[0]?.includes('verification=verified') === true &&
    ends[0]?.includes('targetIdentity=[item=iron_chestplate') === true &&
    commitLine.startsWith(`SKILL_COMMIT epoch=7 commitmentId=${commitment} lease=1 skill=EQUIP`)
  report(
    pass,
    '1. one selection -> one commitment identity across SKILL_COMMIT/STEP/END + result',
    `status=${result.status} commitmentId=${commitment} steps=${steps.length} ends=${ends.length} ` +
      `terminalReason=${result.skillTerminalReason}\n      | ${commitLine}\n      | ${steps[0] ?? ''}\n      | ${ends[0] ?? ''}`,
  )
}

// ===========================================================================
// 2. effect envelope is enforced (fail closed) and cannot expand silently
// ===========================================================================

{
  const fixture = makeFixture()
  const executor = makeExecutor(fixture, { envelopeOverride: { ...FULL_ENVELOPE } })
  const result = await executor.claim(equipCandidate()).completion
  const violation = fixture.logger.matching('SKILL_ENVELOPE_VIOLATION')
  const pass =
    result.status === 'failed' &&
    result.failure === 'effect_envelope_violation' &&
    result.skillOutcome === 'MECHANICALLY_BLOCKED' &&
    result.skillTerminalReason === 'blocked' &&
    fixture.equips() === 0 &&
    violation.length === 1 &&
    (violation[0]?.includes('reason=equip_item_not_declared:iron_chestplate') ?? false) &&
    fixture.logger.matching('SKILL_END').some((line) => line.includes('failureCode=effect_envelope_violation'))
  report(
    pass,
    '2. a step outside the declared envelope FAILS CLOSED (typed, no side effect)',
    `status=${result.status} failure=${result.failure} equips=${fixture.equips()} violation=${JSON.stringify(violation)}`,
  )
}

{
  const declared = envelopeForCandidate(equipCandidate(), { equipItems: ['iron_chestplate'] })
  const expanded = { ...declared, mayDigBlocks: [{ position: { x: 1, y: 64, z: 0 }, name: 'stone' }] }
  const pass =
    effectViolation(declared, { type: 'equip', itemName: 'iron_chestplate', destination: 'torso' }) === null &&
    effectViolation(declared, { type: 'equip', itemName: 'diamond_chestplate', destination: 'torso' }) ===
      'equip_item_not_declared:diamond_chestplate' &&
    effectViolation(declared, { type: 'attack', entityId: 31 }) === 'attack_entity_not_declared:e31' &&
    effectViolation(declared, { type: 'move' }) === 'move_not_declared' &&
    effectEnvelopeHash(declared) !== effectEnvelopeHash(expanded) &&
    envelopeExpanded(declared, expanded) === true &&
    envelopeExpanded(declared, { ...declared }) === false
  report(
    pass,
    '2b. envelope checks are exact (item/entity/cell) and expansion is detectable',
    `equipOk=${effectViolation(declared, { type: 'equip', itemName: 'iron_chestplate', destination: 'torso' })} ` +
      `wrongItem=${effectViolation(declared, { type: 'equip', itemName: 'diamond_chestplate', destination: 'torso' })} ` +
      `attack=${effectViolation(declared, { type: 'attack', entityId: 31 })} move=${effectViolation(declared, { type: 'move' })} ` +
      `expanded=${envelopeExpanded(declared, expanded)}`,
  )
}

// ===========================================================================
// 3. causal target identity + invalidation
// ===========================================================================

{
  const ctx = { dimension: 'minecraft:overworld', worldEpoch: 3 }
  const e31 = targetIdentityOf(attackCandidate(31), ctx)
  const e44 = targetIdentityOf(attackCandidate(44), ctx)
  const commit = createSkillCommitment({
    decisionEpoch: 7,
    optionInstanceId: 'opt_nether_1',
    decisionId: 'call_abc123',
    candidate: attackCandidate(31),
    target: e31,
    expectedPostconditions: declaredPostconditions(attackCandidate(31)),
    allowedEffects: envelopeForCandidate(attackCandidate(31)),
    selectedBy: 'jev_pi',
    selectedAtStateFingerprint: 'hash_xyz',
  })
  const lease = commitmentInvalidation({
    commitment: commit,
    observedDimension: 'minecraft:overworld',
    observedWorldEpoch: 3,
    leaseHeld: false,
  })
  const epoch = commitmentInvalidation({
    commitment: commit,
    observedDimension: 'minecraft:overworld',
    observedWorldEpoch: 4,
    leaseHeld: true,
  })
  const world = commitmentInvalidation({
    commitment: commit,
    observedDimension: 'minecraft:the_nether',
    observedWorldEpoch: 3,
    leaseHeld: true,
  })
  const portal = createSkillCommitment({
    decisionEpoch: 7,
    optionInstanceId: 'opt_nether_1',
    decisionId: 'call_abc123',
    candidate: { ...attackCandidate(31), kind: 'ENTER_PORTAL', id: 'ENTER:1_64_0' } as Candidate,
    target: { kind: 'portal_site', position: { x: 1, y: 64, z: 0 }, dimension: 'minecraft:overworld', worldEpoch: 3 },
    expectedPostconditions: ['the body dimension equals the selected target dimension'],
    allowedEffects: envelopeForCandidate({ ...attackCandidate(31), kind: 'ENTER_PORTAL' } as Candidate),
    selectedBy: 'jev_pi',
    selectedAtStateFingerprint: 'hash_xyz',
  })
  const portalChange = commitmentInvalidation({
    commitment: portal,
    observedDimension: 'minecraft:the_nether',
    observedWorldEpoch: 3,
    leaseHeld: true,
  })
  const pass =
    e31.kind === 'entity' &&
    e31.entityId === 31 &&
    e31.mobType === 'zombie' &&
    sameTargetIdentity(e31, e31) === true &&
    sameTargetIdentity(e31, e44) === false &&
    targetIdentityViolation(e31, e44)?.startsWith('target_identity_changed:') === true &&
    targetIdentityViolation(e31, e31) === null &&
    commit.skillKind === 'kill' &&
    commit.target.kind === 'entity' &&
    commit.expectedPostconditions.some((line) => line.includes('entityDead')) &&
    commit.selectedBy === 'jev_pi' &&
    lease === 'LEASE_REVOKED' &&
    epoch === 'WORLD_CHANGED' &&
    world === 'WORLD_CHANGED' &&
    portalChange === null
  report(
    pass,
    '3. entity identity is causal (id, not mob type); lease/epoch/dimension invalidate (portal exception kept)',
    `e31=${JSON.stringify(e31)} violation=${targetIdentityViolation(e31, e44)} lease=${lease} epoch=${epoch} world=${world} portal=${portalChange}`,
  )
}

// ===========================================================================
// 4. a late/asynchronous completion cannot resurrect a stale commitment
// ===========================================================================

{
  const fixture = makeFixture()
  const executor = makeExecutor(fixture)
  const first = executor.claim(attackCandidate(31))
  // The second selection supersedes the first while it is still running.
  const second = executor.claim(equipCandidate())
  const firstResult = await first.completion
  const secondResult = await second.completion
  const pass =
    firstResult.status === 'cancelled' &&
    firstResult.skillOutcome === 'LEASE_REVOKED' &&
    secondResult.status === 'done' &&
    secondResult.commitmentId !== firstResult.commitmentId &&
    fixture.logger
      .matching('SKILL_END')
      .some((line) => line.includes(`commitmentId=${firstResult.commitmentId}`) && line.includes('outcome=LEASE_REVOKED')) &&
    executor.current === null
  report(
    pass,
    '4. a superseded action settles LEASE_REVOKED; its commitment cannot be resurrected',
    `first=${firstResult.status}/${firstResult.skillOutcome} second=${secondResult.status}/${secondResult.skillOutcome} ` +
      `firstId=${firstResult.commitmentId} secondId=${secondResult.commitmentId}`,
  )
}

// ===========================================================================
// 5. deterministic DONE vs typed policy boundary
// ===========================================================================

{
  const fixture = makeFixture({ armorWorn: 'iron_chestplate' })
  const result = await makeExecutor(fixture).claim(equipCandidate()).completion
  const boundary = fixture.logger.matching('SKILL_POLICY_BOUNDARY')
  const pass =
    result.status === 'done' &&
    result.verified === true &&
    result.skillTerminalReason === 'done' &&
    fixture.equips() === 0 &&
    boundary.length === 0
  report(
    pass,
    '5. deterministic DONE is code-owned: no boundary, no re-ask, verified evidence',
    `status=${result.status} verified=${result.verified} terminalReason=${result.skillTerminalReason} boundary=${boundary.length}`,
  )
}

{
  // A vanished target is a typed invalidity -> policy boundary.
  const fixture = makeFixture()
  delete (fixture.bot.entities as Record<number, unknown>)[31]
  const result = await makeExecutor(fixture).claim(attackCandidate(31)).completion
  const packet = buildSkillOutcomePacket({
    decisionEpoch: PROVENANCE.decisionEpoch,
    commitmentId: result.commitmentId ?? 'none',
    optionInstanceId: PROVENANCE.optionInstanceId,
    selectedCandidateId: 'ATTACK:e31',
    skillKind: 'ATTACK',
    targetIdentity: { kind: 'entity', key: result.skillTargetIdentityKey ?? 'none', label: 'zombie' },
    status: result.status,
    failure: result.failure,
    verified: result.verified === true,
  })
  const pass =
    result.status === 'failed' &&
    result.failure === 'target_gone' &&
    result.skillOutcome === 'TARGET_INVALIDATED' &&
    result.skillTerminalReason === 'target_lost' &&
    // §2: a vanished entity is TARGET_LOST (not the generic `blocked` fallback)
    packet.terminalReason === 'target_lost' &&
    policyBoundary(packet) === true &&
    isPolicyBoundaryOutcome('TARGET_INVALIDATED') === true &&
    isPolicyBoundaryOutcome('SUCCESS') === false &&
    skillOutcomeForFailure('target_gone', 'failed') === 'TARGET_INVALIDATED' &&
    skillOutcomeForFailure('submerged', 'failed') === 'SAFETY_INTERRUPT' &&
    skillOutcomeForFailure('cancelled', 'cancelled') === 'LEASE_REVOKED' &&
    skillOutcomeForFailure(null, 'done') === 'SUCCESS'
  report(
    pass,
    '5b. typed invalidity is a policy boundary with a typed outcome mapping',
    `status=${result.status} failure=${result.failure} packet=${JSON.stringify({ terminalReason: packet.terminalReason, next: packet.nextDecisionRequired })}`,
  )
}

// ===========================================================================
// 6. #437 packet/marker vocabulary + §3 non-bypass invariant
// ===========================================================================

{
  const boundaryLine = formatSkillPolicyBoundary({
    skillKind: 'kill',
    reason: 'target_lost',
    alternatives: ['ATTACK:e44', 'HOLD_ITEM:iron_sword'],
    commitmentId: 'c1234abcd',
    decisionEpoch: 7,
    detail: 'selected entity e31 is gone',
  })
  // A boundary with no commitment in flight keeps the exact canonical shape.
  const bareBoundary = formatSkillPolicyBoundary({
    skill: 'ATTACK:e31',
    reason: 'multiple_grounded_escapes',
    alternatives: ['MOVE:a', 'MOVE:b'],
  })
  const staleLine = formatStaleResultDropped(6, 7, 'late_skill_outcome_from_superseded_decision_epoch')
  const commit = createSkillCommitment({
    decisionEpoch: 9,
    optionInstanceId: 'opt_x',
    decisionId: 'call_y',
    candidate: attackCandidate(31),
    target: targetIdentityOf(attackCandidate(31), { dimension: 'minecraft:overworld', worldEpoch: 1 }),
    expectedPostconditions: declaredPostconditions(attackCandidate(31)),
    allowedEffects: envelopeForCandidate(attackCandidate(31)),
    selectedBy: 'jev_pi',
    selectedAtStateFingerprint: 'fp',
  })
  const packet = buildSkillOutcomePacket({
    decisionEpoch: commit.decisionEpoch,
    commitmentId: commit.commitmentId,
    optionInstanceId: commit.optionInstanceId,
    selectedCandidateId: commit.candidateId,
    skillKind: 'ATTACK',
    targetIdentity: { kind: 'entity', key: targetIdentityKeyOf(commit.target), label: 'zombie' },
    status: 'failed',
    failure: 'target_gone',
    verified: false,
  })
  const packetLine = formatSkillOutcomePacket(packet)
  const exports = skillCommitment as unknown as Record<string, unknown>
  const pass =
    boundaryLine.startsWith(
      'SKILL_POLICY_BOUNDARY skill=kill reason=target_lost alternatives=[ATTACK:e44,HOLD_ITEM:iron_sword]',
    ) &&
    boundaryLine.includes('commitmentId=c1234abcd decisionEpoch=7') &&
    bareBoundary === 'SKILL_POLICY_BOUNDARY skill=ATTACK:e31 reason=multiple_grounded_escapes alternatives=[MOVE:a,MOVE:b]' &&
    staleLine.startsWith(`${STALE_JEV_RESULT_DROPPED} epoch=6 activeEpoch=7`) &&
    // The HANDOFF packet closes the REAL commitment, with the causal identity.
    packet.commitmentId === commit.commitmentId &&
    packet.terminalReason === 'target_lost' &&
    packet.nextDecisionRequired === true &&
    packet.targetIdentity.key.includes('entity=e31') &&
    packetLine.includes(`commitmentId=${commit.commitmentId}`) &&
    terminalReasonFor({ status: 'failed', failure: 'target_gone', verified: false }) === 'target_lost' &&
    skillTerminalReasonFor('TARGET_INVALIDATED') === 'target_lost' &&
    skillTerminalReasonFor('SUCCESS') === 'done' &&
    // §3: the forbidden shortcut must not exist anywhere in the contract surface.
    exports.bypassJevWhenSingleCandidate === undefined &&
    exports.shouldBypassJev === undefined &&
    exports.skipJevForSingleCandidate === undefined &&
    !Object.keys(exports).some((name) => /bypass|skipJev/i.test(name))
  report(
    pass,
    '6. ONE vocabulary: #437 owns the packet/markers, the commitment feeds its real id',
    `${boundaryLine}\n      | ${bareBoundary}\n      | ${staleLine}\n      | ${packetLine}\n      | exportedBypassNames=${Object.keys(exports).filter((name) => /bypass|skipJev/i.test(name)).join(',') || 'none'}`,
  )
}

function targetIdentityKeyOf(identity: CausalTargetIdentity): string {
  return targetIdentityKey(identity)
}

// ===========================================================================
// 7. lifecycle invalidation (section 14/23): world epoch, dimension, lease
// ===========================================================================

{
  // The committed entity target was grounded at worldEpoch 3; the live world is
  // 4. (An ITEM target carries no world epoch by construction: it is not in the
  // world, so `commitmentInvalidation` correctly keeps it valid - see 7b.)
  const fixture = makeFixture()
  const result = await makeExecutor(fixture, { observedWorldEpoch: () => 4 }).claim(attackCandidate(31)).completion
  const invalidated = fixture.logger.matching('SKILL_INVALIDATED')
  const pass =
    result.status === 'failed' &&
    result.failure === 'world_changed' &&
    result.skillOutcome === 'WORLD_CHANGED' &&
    result.skillTerminalReason === 'world_changed' &&
    fixture.swings() === 0 &&
    invalidated.length === 1 &&
    (invalidated[0]?.includes('reason=WORLD_CHANGED') ?? false) &&
    (invalidated[0]?.includes('observedWorldEpoch=4') ?? false) &&
    fixture.logger.matching('SKILL_END').some((line) => line.includes('outcome=WORLD_CHANGED'))
  report(
    pass,
    '7. a worldEpoch change invalidates the live commitment (fail closed, no side effect)',
    `status=${result.status} failure=${result.failure} outcome=${result.skillOutcome} swings=${fixture.swings()} invalidated=${JSON.stringify(invalidated)}`,
  )
}

{
  // `unknown` is the UNOBSERVED dimension, never a verdict: it must not
  // invalidate a commitment (a fixture host with no game state / unloaded world).
  const ctx = { dimension: 'minecraft:the_nether', worldEpoch: 3 }
  const commit = createSkillCommitment({
    decisionEpoch: 1,
    optionInstanceId: 'opt_nether_1',
    decisionId: 'call_z',
    candidate: attackCandidate(31),
    target: targetIdentityOf(attackCandidate(31), ctx),
    expectedPostconditions: declaredPostconditions(attackCandidate(31)),
    allowedEffects: envelopeForCandidate(attackCandidate(31)),
    selectedBy: 'jev_pi',
    selectedAtStateFingerprint: 'fp',
  })
  const unknown = commitmentInvalidation({
    commitment: commit,
    observedDimension: 'unknown',
    observedWorldEpoch: 3,
    leaseHeld: true,
  })
  const same = commitmentInvalidation({
    commitment: commit,
    observedDimension: 'minecraft:the_nether',
    observedWorldEpoch: 3,
    leaseHeld: true,
  })
  const other = commitmentInvalidation({
    commitment: commit,
    observedDimension: 'minecraft:overworld',
    observedWorldEpoch: 3,
    leaseHeld: true,
  })
  report(
    unknown === null && same === null && other === 'WORLD_CHANGED',
    '7b. an unobserved dimension is not a verdict; a real dimension change is',
    `unknown=${unknown} same=${same} other=${other}`,
  )
}

process.stdout.write(`${'-'.repeat(84)}\n`)
process.stdout.write(`${total - failures}/${total} skill-commitment (Phase 1) cases passed\n`)
if (failures > 0) process.exit(1)
