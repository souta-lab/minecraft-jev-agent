// System2 decision plane extracted from controller.ts.
// Owns the sparse System2 summon boundary and the semantic projection
// it consumes (facts, fingerprints, apply-identity, outcome memory).
// System2 stays a sparse repair service: it never actuates and never
// orders candidates; it returns plan requests the legacy queue
// consumes. No authority moves.
import { observedAir } from './air.ts'
import type { Candidate } from './candidates.ts'
import { optionIdForGoal } from './causal.ts'
import type { DecisionLlmResummonLog } from './decisionlog.ts'
import type { Executor } from './executor.ts'
import { failureCount } from './failureMemory.ts'
import type { GoalQueue, GoalQueueSnapshot, HeadAnswerWarrant, PlannedGoal, PlanOp, QueuedGoal } from './goalQueue.ts'
import type { EventLogger } from './jev.ts'
import { airBand, buildJevSemanticProjection, buildSemanticCombatFacts, diffSemanticProjections, foodBand, healthBand, semanticOffhand, semanticWornArmor, threatBand } from './jev/semantic-projection.ts'
import type { GroundedFact, JevSemanticProjection, PreviousDecisionFacts, SemanticProgressFacts, SkillOutcomePacket } from './jev/semantic-projection.ts'
import { FatalModelError, ModelRecoveryRequested, describeFailure, failLoud } from './modelFailure.ts'
import type { OptionWorldSnapshot } from './optionSpec.ts'
import { bestToolTier } from './reachability.ts'
import { formatLocalRecoveryExhausted, formatLocalRecoveryNoProgress, formatReplanThrottled } from './replanThrottle.ts'
import type { ReplanInputs, ReplanThrottle } from './replanThrottle.ts'
import type { DecisionScheduler, DecisionTrigger } from './scheduler.ts'
import { distance } from './state.ts'
import type { AgentSignals, KnownResource, GoalState, HarvestTool, Vec3Json, WorldState } from './state.ts'
import { System2RequestCancelledError } from './system2/service.ts'
import type { LlmSummonReason, System2BlockerFacts, System2Brain, System2GroundedAlternative, System2Objective, System2Outcome, System2PlanRequest, System2SemanticOutcome, System2ToolGap, System2WithheldCandidate } from './system2/service.ts'
import { applySystem2RecoveryFence, evaluateSystem2Apply, formatCompiledGoalRows, formatSystem2Discard, formatSystem2PlanApplied, system2BodyOwned } from './system2/authority.ts'
import type { System2ApplyState, System2RequestContext } from './system2/authority.ts'
import { SYSTEM2_SEMANTIC_HISTORY_LIMIT, acceptedSystem2PlanGoals, createSystem2SemanticOutcome, finalizeSystem2SemanticOutcomes, system2SemanticBlocker, system2SemanticFingerprint } from './system2/causal-history.ts'
import { buildSystem2BlockerFacts, emptySystem2PayloadShape, formatSystem2PayloadAbsentLine, formatSystem2PayloadLine, formatSystem2PayloadRefusedLine } from './system2/payload.ts'
import { bodySurvivalFacts, isDangerousThreat } from './threat.ts'
import type { Bot } from 'mineflayer'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { JevAgentOptions } from './controller-shared.ts'
import type { EscalationReason } from './escalation.ts'
import type { System2RecoveryFenceRejection } from './system2/authority.ts'
import type { FatalTerminator } from './modelFailure.ts'

export interface System2PlaneHost {
  activeRetrieval: { id: string; resource: string; knownName: string; target: Vec3Json } | null
  readonly bot: Bot
  capabilityGapActive: boolean
  capabilityGapSignature: string | null
  chosenCountsAtProgress: number
  compressedSkillSteps: number
  criticalStateVersion: number
  currentGoalKey(): string
  escalations: EscalationReason[]
  executor: Executor
  goal: GoalState
  headAnswerWarrant: HeadAnswerWarrant | null
  inventorySnapshot(): Record<string, number>
  lastEscalationAt: Map<EscalationReason, number>
  lastEscalationMs: number
  lastLlmSummonAt: Map<LlmSummonReason, number>
  lastProgress: number
  lastProgressAt: number
  lastSemanticProjection: JevSemanticProjection | null
  lastStateFingerprint: string
  lastWorldState: WorldState | null
  llmInFlight: boolean
  llmNotes: string[]
  llmSummonReasons: LlmSummonReason[]
  llmSummons: number
  logQueueDepthDelta(before: number, op: string, reason: string): void
  logger: EventLogger
  modelRecoveryStopping: boolean
  noProductiveRepeats: number
  noProductiveThisTick: boolean
  objectiveState(): System2Objective
  optionSnapshot(state: WorldState): OptionWorldSnapshot
  options: {
    readonly generationSourceSha?: string | null
    readonly knownResources?: readonly KnownResource[]
    readonly llmCooldownMs: number
    readonly recoverySourceSha?: string | null
    readonly recoverySystem2Authority?: { provider: string; model: string } | null
    readonly rejectSystem2RecoveryPlan?: (rejection: System2RecoveryFenceRejection) => never
    readonly singleShotPlanner: boolean
    readonly terminateOnModelFailure?: FatalTerminator
    readonly waitLimit: number
    readonly worldEpoch: number
}
  planSupplied: boolean
  presentedCandidateFacts: System2GroundedAlternative[]
  previousDecisionFacts(): PreviousDecisionFacts | null
  protectedGoalRetireReason(goal: QueuedGoal, incoming: readonly PlannedGoal[]): string | null
  queue: GoalQueue
  queuePreconditionSnapshot(): OptionWorldSnapshot
  recentEvents: string[]
  recentOutcomes: System2Outcome[]
  recentSemanticOutcomes: System2SemanticOutcome[]
  recentSkillOutcomes: SkillOutcomePacket[]
  rememberSystem2PlanOutcome(input: {
    proposalId: string
    operation: 'continue' | 'patch' | 'replace' | 'abandon' | 'complete' | 'abort'
    intentSource: System2SemanticOutcome['intentSource']
    intent: string
    requestedGoalsTotal: number
    acceptedGoals: readonly QueuedGoal[]
    optionInstanceBefore: string | null
    queueDoneBefore: number
    stateFingerprintBefore: string
    blockersBefore: System2BlockerFacts | null
    successSnapshot: OptionWorldSnapshot
  }): void
  replanInputs(): ReplanInputs
  readonly replanThrottle: ReplanThrottle
  requestDecision(trigger: DecisionTrigger, detail: Record<string, unknown>): void
  running: boolean
  runtimeLlmCalls: number
  scheduler: DecisionScheduler
  semanticFacts(state: WorldState): GroundedFact[]
  semanticOptionSnapshot(): OptionWorldSnapshot
  semanticStateFingerprint(): string
  signals: AgentSignals
  starvationContext: { blockedBy: string; missing: string[] } | null
  /**
   * Typed blockers that already exhausted their bounded local window at this
   * locality within the resident (portal-p14/p16/p17 `column_descent` loops):
   * causal history so a re-plan sees the constraint it must route around.
   */
  repeatedBlockerFacts(): readonly { reason: string; goals: readonly string[]; count: number }[]
  system2: System2Brain
  system2ApplyIdentity(state: WorldState | null): Pick<
    System2RequestContext,
    | 'objectiveFingerprint'
    | 'inventoryFingerprint'
    | 'dimension'
    | 'worldTopologyRevision'
    | 'worldFactsFingerprint'
    | 'threatFingerprint'
    | 'survivalFingerprint'
  >
  readonly system2AuthorityStack: { provider: string; model: string }
  system2BlockerFacts(): System2BlockerFacts | null
  readonly system2Model: string
  readonly system2Provider: string
  readonly tickCounter: number
  tickLlmCalls: number
  tickResummonLog: DecisionLlmResummonLog[]
  verifyQueuedGoalComplete(goal: QueuedGoal): boolean
  withheldCandidateFacts: System2WithheldCandidate[]
  withheldFactsFingerprint: string
  withheldToolGaps: System2ToolGap[]
  planCalls: number
  subgoalCount: number
  loadLedger(): GoalQueueSnapshot | null
  logSubgoalStart(goal: QueuedGoal, inventory: Record<string, number>, cause: string): void
}

export function semanticFacts(host: System2PlaneHost,
state: WorldState): GroundedFact[] {
  const facts: GroundedFact[] = []
  const resources = new Set<string>()
  for (const resource of state.signals.knownResources ?? []) {
    if (facts.length >= 8) break
    if (resources.has(resource.name)) continue
    resources.add(resource.name)
    facts.push({ kind: 'resource', key: resource.name, detail: `${resource.name} is known to the world memory` })
  }
  const portalSites = state.portalFrameSites?.length ?? 0
  if (portalSites > 0 || state.portalFrame != null) {
    facts.push({
      kind: 'structure',
      key: 'portal_frame',
      detail: state.portalFrame == null ? `${portalSites} portal site(s) grounded` : 'complete portal frame validated',
    })
  }
  if (host.activeRetrieval !== null) {
    facts.push({
      kind: 'target',
      key: `retrieval:${host.activeRetrieval.resource}`,
      detail: `the active retrieval target is ${host.activeRetrieval.resource}`,
    })
  }
  if (host.capabilityGapActive) {
    facts.push({
      kind: 'capability',
      key: host.capabilityGapSignature ?? 'capability_gap',
      detail: 'a capability gap is currently grounded',
    })
  }
  if (host.starvationContext !== null) {
    facts.push({
      kind: 'blocked',
      key: host.starvationContext.blockedBy,
      detail: `local candidates are blocked by ${host.starvationContext.blockedBy}`,
    })
  }
  // Accumulated negative constraints: a blocker that already exhausted its
  // bounded window at this locality under prior goals is proven CAN-refusal
  // evidence,
  // not a guess - the semantic projection carries it as its own fact class so a
  // re-plan cannot mistake it for a fresh, unexplored direction.
  for (const entry of host.repeatedBlockerFacts()) {
    if (facts.length >= 16) break
    if (host.starvationContext !== null && entry.reason === host.starvationContext.blockedBy) continue
    facts.push({
      kind: 'blocked',
      key: `repeated:${entry.reason}`,
      detail: `${entry.reason} exhausted local recovery ${entry.count}x under ${entry.goals.slice(0, 3).join('/')}`,
    })
  }
  const queue = state.goalQueue
  if (queue.current !== null) {
    facts.push({
      kind: 'goal',
      key: `${queue.current.id}:${queue.current.requiredCount ?? 0}`,
      detail: `queue head is ${queue.current.description}`,
    })
  }
  return facts
}


export function buildSemanticProjection(host: System2PlaneHost,

  state: WorldState,
  candidates: readonly Candidate[],
  mergedCandidates: number,
): JevSemanticProjection {
  const option = state.currentOption ?? null
  const optionId = optionIdForGoal(state.goalQueue.current) ?? option?.instanceId ?? null
  const threat = host.signals.threat ?? null
  const critical = host.signals.criticalDamage ?? null
  const lastDamage = host.signals.lastDamage ?? null
  const stall = host.signals.strategicNonProgress ?? null
  const progress: SemanticProgressFacts = {
    consecutiveFailures: host.signals.consecutiveFailures,
    lastFailureCode: host.signals.lastFailureCode ?? null,
    escalationRecommended: host.signals.escalationRecommended === true,
    oscillationsDetected: host.signals.oscillationsDetected ?? 0,
    stallExhausted: stall === null ? null : stall.exhausted === true,
    stallDistinctStates: stall === null ? null : stall.distinctStates ?? null,
  }
  const base = buildJevSemanticProjection({
    goal: {
      key: host.currentGoalKey(),
      targetItem: host.goal.targetItem ?? null,
      have: host.goal.haveCount,
      required: host.goal.requiredCount,
      complete: host.goal.complete === true,
      progress: host.goal.progress,
    },
    option: {
      instanceId: optionId,
      templateId: option?.templateId ?? null,
      skillKind: option?.kind ?? null,
      targetKey: option === null ? null : JSON.stringify(option.target),
    },
    world: {
      dimension: state.self.dimension,
      worldEpoch: host.options.worldEpoch,
      generationId: null,
      leaseHeld: true,
      alive: state.self.health > 0,
    },
    safety: {
      healthBand: healthBand(state.self.health),
      foodBand: foodBand(state.self.food),
      airBand: airBand(observedAir(state.self.air)),
      submerged:
        state.self.feetInWater === undefined && state.self.eyesInWater === undefined
          ? null
          : state.self.feetInWater === true || state.self.eyesInWater === true,
      threatKey:
        threat === null
          ? null
          : `${threat.threatName ?? 'unknown'}:${threatBand(threat.threatDistance ?? null)}:${threat.inContact === true}`,
      criticalDamageKey: critical === null ? null : `${critical.planKey}:${critical.consecutiveDamage}:${critical.sourceName ?? 'unattributed'}`,
      lastDamageKey: lastDamage === null ? null : `${lastDamage.sourceId ?? 'unknown'}`,
      wornArmor: semanticWornArmor(state.self.armor),
      offhand: semanticOffhand(state.self.offhand),
    },
    combat: buildSemanticCombatFacts({
      health: state.self.health,
      food: state.self.food,
      canRegenerate: bodySurvivalFacts(state.self).regenerating,
      heldWeapon: state.self.heldItem?.name ?? null,
      activeItemUse: state.self.activeItemUse ?? null,
      candidates,
      threat:
        threat === null
          ? null
          : {
              active: threat.active,
              threatId: threat.threatId,
              threatName: threat.threatName,
              threatDistance: threat.threatDistance,
              threatHeldItem: threat.threatHeldItem,
              activeItemUse: threat.threatActiveItemUse ?? null,
              threatEngaged: threat.threatEngaged,
              threatLineOfSight: threat.threatLineOfSight,
              inContact: threat.inContact,
              inDanger: threat.inDanger,
              hostileCount: threat.hostileCount,
            },
    }),
    progress,
    sense: {
      blockNames: state.blocks.map((block) => block.name),
      threats: state.entities
        .filter((entity) => entity.hostile === true)
        .map((entity) => `${entity.name ?? 'unknown'}:${threatBand(entity.distance)}`),
    },
    inventory: state.inventory.counts,
    events: state.recentEvents,
    candidates,
    identityContext: {
      optionInstanceId: optionId,
      dimension: state.self.dimension,
      worldEpoch: host.options.worldEpoch,
    },
    failureCount: (candidateId) => failureCount(state.signals.failedCandidates, candidateId),
    previous: host.previousDecisionFacts(),
    recentOutcomes: host.recentSkillOutcomes,
    facts: host.semanticFacts(state),
    rawTelemetry: { skillSteps: host.compressedSkillSteps, events: state.recentEvents.length },
  })
  const delta = diffSemanticProjections(host.lastSemanticProjection, base).delta
  return {
    ...base,
    meaningfulDelta: delta,
    counts: { ...base.counts, candidatesMerged: mergedCandidates },
  }
}


export function semanticOptionSnapshot(host: System2PlaneHost): OptionWorldSnapshot {
  return host.lastWorldState === null
    ? host.queuePreconditionSnapshot()
    : host.optionSnapshot(host.lastWorldState)
}


export function system2BlockerFacts(host: System2PlaneHost): System2BlockerFacts | null {
  const starvation = host.starvationContext
  const heldToolFamilies: HarvestTool[] = ['pickaxe', 'axe', 'shovel']
  const counts = host.inventorySnapshot()
  const built = buildSystem2BlockerFacts({
    ...(starvation === null ? {} : { blockedBy: starvation.blockedBy }),
    missing: starvation === null ? [] : starvation.missing,
    ...(host.noProductiveThisTick
      ? { repeats: { count: host.noProductiveRepeats, bound: host.options.waitLimit } }
      : {}),
    withheld: host.withheldCandidateFacts,
    toolsHeld: heldToolFamilies.map((tool) => ({ tool, tier: bestToolTier(counts, tool) })),
    toolGaps: host.withheldToolGaps,
    presented: host.presentedCandidateFacts,
    freshness: { measured: host.withheldFactsFingerprint, current: host.lastStateFingerprint },
  })
  if (built === null) {
    const empty = { ...emptySystem2PayloadShape(), absent: ['blockers'] }
    host.logger.info(
      'system2',
      formatSystem2PayloadLine(empty),
      { attached: false, absent: empty.absent },
      host.tickCounter,
    )
    return null
  }
  host.logger.warn(
    'system2',
    formatSystem2PayloadLine(built.shape),
    {
      withheld: built.facts.withheld,
      missing: built.facts.missing,
      blockedBy: built.facts.blockedBy ?? null,
      repeats: built.facts.repeats ?? null,
      tools: built.facts.tools,
      presented: built.facts.alternatives.presented,
      chars: built.shape.chars,
    },
    host.tickCounter,
  )
  for (const entry of built.shape.refused) {
    host.logger.warn(
      'system2',
      formatSystem2PayloadRefusedLine(entry),
      { ...entry, plane: 'controller' },
      host.tickCounter,
    )
  }
  for (const field of built.shape.absent) {
    host.logger.warn('system2', formatSystem2PayloadAbsentLine(field), { field }, host.tickCounter)
  }
  return built.facts
}


export function semanticStateFingerprint(host: System2PlaneHost): string {
  return system2SemanticFingerprint(
    host.lastStateFingerprint || 'unobserved',
    host.bot.game?.dimension ?? null,
    {
      health: Number.isFinite(host.bot.health) ? Math.round(host.bot.health * 10) / 10 : null,
      food: Number.isFinite(host.bot.food) ? host.bot.food : null,
      ...host.objectiveState(),
    },
  )
}


/** Bounded hold a fresh plan gets while a body-owned action is still in flight. */
const SYSTEM2_APPLY_DEFER_ATTEMPTS = 3
const SYSTEM2_APPLY_DEFER_MS = 1500

export function system2ApplyIdentity(host: System2PlaneHost,
state: WorldState | null): Pick<
  System2RequestContext,
  | 'objectiveFingerprint'
  | 'inventoryFingerprint'
  | 'dimension'
  | 'worldTopologyRevision'
  | 'worldFactsFingerprint'
  | 'threatFingerprint'
  | 'survivalFingerprint'
> {
  const world = state ?? host.lastWorldState
  const counts = world?.inventory.counts ?? host.inventorySnapshot()
  const inventoryFingerprint = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([item, count]) => `${item}=${count}`)
    .join(',')
  const result: Pick<
    System2RequestContext,
    | 'objectiveFingerprint'
    | 'inventoryFingerprint'
    | 'dimension'
    | 'worldTopologyRevision'
    | 'worldFactsFingerprint'
    | 'threatFingerprint'
    | 'survivalFingerprint'
  > = {
    objectiveFingerprint: JSON.stringify(host.objectiveState()),
    inventoryFingerprint,
    dimension: host.bot.game?.dimension ?? world?.self.dimension ?? null,
  }
  // `scheduler.blockRevision` is a packet-level revision: every block update in
  // the loaded world - including the resident's own digging and passive scans -
  // bumps it. Measured live (portal-p1, 2026-09-27): that alone discards plans
  // that are still correct, because the world never holds still across the
  // model round-trip. The durable facts below carry the semantic basis a plan
  // can name; a raw packet revision cannot distinguish a material change from
  // noise, so it is deliberately not part of the freshness identity.
  if (world === null) return result

  // Do not include distance, inReach, visible, adjacent-stand geometry or
  // position. They are body-relative affordances and are recomputed by the
  // live sensor / Option compiler when the answer is applied. Preserve the
  // durable resource/station identity so a changed/removed/new source cannot
  // inherit an old plan. The raw sensed-block snapshot is intentionally left
  // out: the sensed volume churns with the resident's own motion and scans
  // (portal-p1/v2-n5: `world_facts_changed` on benign rescan churn discarded
  // every authored plan), while execution re-grounds source blocks per
  // candidate anyway.
  const resources = (world.signals.knownResources ?? [])
    .map((resource) => ({
      kind: resource.kind,
      name: resource.name,
      at: [resource.position.x, resource.position.y, resource.position.z],
      dimension: resource.dimension ?? null,
      worldEpoch: resource.worldEpoch ?? null,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  result.worldFactsFingerprint = JSON.stringify({
    resources,
    stations: world.craftingTables
      .map((station) => [station.x, station.y, station.z])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    furnaces: (world.furnaces ?? [])
      .map((station) => [station.x, station.y, station.z])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  })
  const threat = world.signals.threat ?? null
  const hazard = world.self.envHazard
  const dangerousHostiles = world.entities
    .filter((entity) => entity.hostile && (isDangerousThreat(entity) || entity.attackedSelf === true))
  result.threatFingerprint = JSON.stringify({
    // Threat-relevant hostiles only: `isDangerousThreat` is the same 8m danger
    // boundary the candidate/survival layers use, and `attackedSelf` keeps a
    // hitting mob material at any distance. A zombie twitching far outside the
    // envelope cannot change what the plan should be - measured live (v2-n5,
    // portal-p1): it discarded every authored plan via `threat_state_changed`.
    //
    // And neither can per-entity tactics. The plan-material threat basis is
    // WHICH hostile kinds press the body, how many, and whether any is in
    // contact or has already hit it; per-entity id/position/health/item rows
    // are Jev-layer tactics the candidate offer re-grounds every tick anyway.
    // Measured live (portal-p17.2, 2026-09-28): a hostile-pocket camp churned
    // position/activeItemUse rows continuously, so every ~30s plan call landed
    // `threat_state_changed` - 30 PLAN_DISCARDED vs 0 applied, queue pinned
    // empty for ~10min while the body idled safe. Same doctrine as the
    // survival fingerprint's band-level basis (portal-p3).
    hostileNames: [...new Set(dangerousHostiles.map((entity) => entity.name ?? 'unknown'))].sort(),
    hostileCount: dangerousHostiles.length,
    anyAttackedSelf: dangerousHostiles.some((entity) => entity.attackedSelf === true),
    envelope: threat === null
      ? null
      : {
          active: threat.active,
          threatName: threat.threatName,
          inContact: threat.inContact,
          inDanger: threat.inDanger,
          hostileCount: threat.hostileCount,
        },
  })
  result.survivalFingerprint = JSON.stringify({
    // Bands, not raw vitals, and no held-item: a fractional health/food tick or
    // a work equip during the model round-trip cannot change what the plan
    // should be, yet it churned the raw fingerprint and discarded authored plans
    // (portal-p3, 2026-09-27: `survival_state_changed` fired on 0.5hp damage
    // ticks and routine tool equips, killing the explore/iron plans). Material
    // transitions still invalidate - crossing a health/food/air band, an armor
    // or offhand change, and any live environmental hazard.
    health: healthBand(world.self.health),
    food: foodBand(world.self.food),
    air: airBand(observedAir(world.self.air)),
    offhand: world.self.offhand ?? null,
    armor: world.self.armor ?? null,
    activeItemUse: world.self.activeItemUse ?? null,
    hazard: hazard?.active === true
      ? {
          inFire: hazard.inFire,
          inLava: hazard.inLava,
          onFire: hazard.onFire,
          drowning: hazard.drowning,
          headInWater: hazard.headInWater,
          adjacentLava: hazard.adjacentLava,
          kinds: hazard.kinds,
        }
      : null,
  })
  return result
}


export function rememberSystem2PlanOutcome(host: System2PlaneHost,
input: {
  proposalId: string
  operation: 'continue' | 'patch' | 'replace' | 'abandon' | 'complete' | 'abort'
  intentSource: System2SemanticOutcome['intentSource']
  intent: string
  requestedGoalsTotal: number
  acceptedGoals: readonly QueuedGoal[]
  optionInstanceBefore: string | null
  queueDoneBefore: number
  stateFingerprintBefore: string
  blockersBefore: System2BlockerFacts | null
  successSnapshot: OptionWorldSnapshot
}): void {
  const record = createSystem2SemanticOutcome({
    ...input,
    blockerBefore: system2SemanticBlocker(input.blockersBefore),
  })
  host.recentSemanticOutcomes = [...host.recentSemanticOutcomes, record].slice(-SYSTEM2_SEMANTIC_HISTORY_LIMIT)
  host.logger.info(
    'system2',
    `SYSTEM2_CAUSAL_PROPOSAL id=${record.proposalId} intentKey=${record.semanticIntentKey} op=${record.operation} requested=${record.requestedGoalsTotal} accepted=${record.acceptedGoalsTotal}`,
    { ...record },
    host.tickCounter,
  )
}


export function summonLlm(host: System2PlaneHost,
reason: LlmSummonReason, detail: string): DecisionLlmResummonLog | null {
  if (!host.running) return null
  if (host.queue.current?.origin === 'human') {
    host.logger.info(
      'system2',
      `HUMAN_INTENT_SYSTEM2_SUPPRESSED reason=${reason}`,
      { reason, detail, current: host.queue.current.description },
      host.tickCounter,
    )
    return { triggered: false, reason, detail: 'human intent owns WHAT until the interrupt completes or is cleared' }
  }
  if (host.options.singleShotPlanner && host.planSupplied) {
    host.logger.warn(
      'system2',
      `LLM summon suppressed reason=${reason} (single-shot planner: plan supplied once)`,
      { reason, detail },
      host.tickCounter,
    )
    return {
      triggered: false,
      reason,
      detail: 'single-shot planner: plan already supplied; the LLM must not be re-called',
    }
  }
  const now = Date.now()
  if (host.llmInFlight) {
    host.logger.info(
      'system2',
      `LLM summon suppressed reason=${reason} (a plan call is already in flight)`,
      { reason, detail },
      host.tickCounter,
    )
    return { triggered: false, reason, detail: 'a plan call is already in flight' }
  }
  const last = host.lastLlmSummonAt.get(reason) ?? 0
  if (reason !== 'queue_empty') {
    const throttle = host.replanThrottle.tryReplan(reason, host.replanInputs(), now)
    if (!throttle.allow) {
      const message = formatReplanThrottled(reason, throttle)
      host.logger.warn(
        'agent',
        message,
        { reason, ageMs: throttle.ageMs, stateHash: throttle.stateHash, because: throttle.kind },
        host.tickCounter,
      )
      if (throttle.kind === 'no_new_info') {
        // #78 counter: this local recovery has now been suppressed for
        // `count` consecutive zero-progress cycles with an unchanged
        // fingerprint. Bounded by `noInfoLimit`; see the exhausted branch.
        host.logger.warn(
          'agent',
          formatLocalRecoveryNoProgress(host.currentGoalKey(), reason, throttle),
          {
            reason,
            goal: host.currentGoalKey(),
            stateHash: throttle.stateHash,
            noInfoStreak: throttle.noInfoStreak,
            noInfoLimit: throttle.noInfoLimit,
          },
          host.tickCounter,
        )
      }
      return { triggered: false, reason, detail: message }
    }
    if (throttle.kind === 'exhausted') {
      // #78 escalation: N consecutive zero-progress cycles prove the local
      // recovery is itself stuck, which is a semantic boundary. The throttle
      // released the replan above, so the System2 call below is the explicit
      // escalation instead of an unbounded `REPLAN_THROTTLED no_new_info`.
      host.logger.warn(
        'agent',
        formatLocalRecoveryExhausted(host.currentGoalKey(), reason, throttle),
        {
          reason,
          goal: host.currentGoalKey(),
          stateHash: throttle.stateHash,
          noInfoStreak: throttle.noInfoStreak,
          noInfoLimit: throttle.noInfoLimit,
          boundary: 'semantic_boundary',
        },
        host.tickCounter,
      )
      // Same escalation vocabulary the rest of the controller uses, recorded
      // inline because `escalate()` would re-enter this throttle and
      // re-suppress the replan exhaustion just released. The throttle's own
      // N-cycle bound rate-limits this, so a cooldown is not needed.
      host.escalations.push('progress_stall')
      host.lastEscalationAt.set('progress_stall', now)
      host.lastEscalationMs = now
      host.signals.escalationRecommended = true
    }
  } else if (now - last < host.options.llmCooldownMs) {
    host.logger.info(
      'system2',
      `LLM summon suppressed reason=${reason} (${now - last}ms < ${host.options.llmCooldownMs}ms cooldown)`,
      { reason, detail },
      host.tickCounter,
    )
    return { triggered: false, reason, detail: `cooldown ${now - last}ms < ${host.options.llmCooldownMs}ms` }
  }

  host.lastLlmSummonAt.set(reason, now)
  host.llmInFlight = true
  host.llmSummons += 1
  host.runtimeLlmCalls += 1
  host.tickLlmCalls += 1
  host.llmSummonReasons.push(reason)

  const groundedDetail =
    host.noProductiveThisTick && host.starvationContext !== null
      ? `${detail}; grounded blocker=${host.starvationContext.blockedBy}${host.starvationContext.missing.length > 0 ? ` missing=${JSON.stringify(host.starvationContext.missing)}` : ''}`
      : detail
  const queueState = host.queue.state
  const currentOption = queueState.current
  const blockers = host.system2BlockerFacts()
  const semanticStateFingerprint = host.semanticStateFingerprint()
  const successSnapshotBefore = host.semanticOptionSnapshot()
  host.recentSemanticOutcomes = finalizeSystem2SemanticOutcomes(host.recentSemanticOutcomes, {
    stateFingerprint: semanticStateFingerprint,
    blocker: system2SemanticBlocker(blockers),
    snapshot: successSnapshotBefore,
  })
  const requestContext: System2RequestContext = {
    requestId: randomUUID(),
    queueRevision: host.queue.revision,
    optionInstanceId: currentOption?.semanticOptionInstanceId ?? currentOption?.optionInstanceId ?? null,
    optionTemplateId: currentOption?.semanticOptionTemplateId ?? currentOption?.optionTemplateId ?? null,
    worldEpoch: host.options.worldEpoch,
    stateFingerprint: host.lastStateFingerprint || 'unobserved',
    semanticStateFingerprint,
    ...host.system2ApplyIdentity(host.lastWorldState),
    // Search/body progress is not a WHAT change. Queue, objective, inventory,
    // world and threat inputs are fenced independently above/below; this epoch
    // catches safety-critical events even when the current sensor snapshot has
    // not yet been rebuilt for the event.
    authorityEpoch: host.criticalStateVersion,
  }
  const request: System2PlanRequest = {
    reason,
    detail: groundedDetail,
    tick: host.tickCounter,
    goalQueueState: queueState,
    objective: host.objectiveState(),
    recentEvents: host.recentEvents.slice(-8),
    recentOutcomes: host.recentOutcomes.slice(-8),
    recentSemanticOutcomes: host.recentSemanticOutcomes.slice(-SYSTEM2_SEMANTIC_HISTORY_LIMIT),
    requestContext,
    ...(blockers === null ? {} : { blockers }),
  }
  host.logger.info(
    'system2',
    `SYSTEM2_CAUSAL_HISTORY attached=${request.recentSemanticOutcomes?.length ?? 0} semanticState=${semanticStateFingerprint}`,
    { requestId: requestContext.requestId, records: request.recentSemanticOutcomes ?? [] },
    host.tickCounter,
  )
  const resummon: DecisionLlmResummonLog = {
    triggered: true,
    reason,
    detail: groundedDetail,
    requestId: requestContext.requestId,
  }
  host.tickResummonLog.push(resummon)

  // #plan-reconciliation: remember WHICH row and WHICH question this request is
  // about. `action_impossible`/`no_progress` are the summons that say "this head
  // cannot proceed"; if the answer authors a real plan, that plan supersedes the
  // head the model was asked about. One slot: the newest question wins.
  host.headAnswerWarrant =
    (reason === 'action_impossible' || reason === 'no_progress') && currentOption !== null
      ? {
          requestId: requestContext.requestId,
          headId: currentOption.id,
          headKey: `${currentOption.kind}:${currentOption.targetItem ?? currentOption.description}:${currentOption.requiredCount}`,
          reason,
        }
      : null

  host.logger.warn(
    'system2',
    `SUMMON LLM reason=${reason} queueDepth=${queueState.depth} current=${queueState.current?.description ?? 'none'} :: ${groundedDetail}`,
    {
      reason,
      queueDepth: queueState.depth,
      currentGoal: queueState.current?.description ?? null,
      detail: groundedDetail,
      model: host.system2Model,
      provider: host.system2Provider,
      requestId: requestContext.requestId,
      requestContext,
    },
    host.tickCounter,
  )

  void host.system2
    .plan(request)
    .then(async (plan) => {
      const staleDiscard = () => {
        host.logger.warn(
          'system2',
          `SYSTEM2_STALE_DISCARD reason=${host.modelRecoveryStopping ? 'authority_withdrawn' : 'controller_stopped'}`,
          { reason, requestId: requestContext.requestId, note: plan.note, op: plan.op ?? 'replace' },
          host.tickCounter,
        )
        host.llmInFlight = false
      }
      if (!host.running || host.modelRecoveryStopping) {
        staleDiscard()
        return
      }
      const buildCurrentContext = (): System2ApplyState => {
        const current = host.queue.state
        return {
          queueRevision: host.queue.revision,
          optionInstanceId: current.current?.semanticOptionInstanceId ?? current.current?.optionInstanceId ?? null,
          optionTemplateId: current.current?.semanticOptionTemplateId ?? current.current?.optionTemplateId ?? null,
          worldEpoch: host.options.worldEpoch,
          stateFingerprint: host.lastStateFingerprint || 'unobserved',
          ...host.system2ApplyIdentity(host.lastWorldState),
          authorityEpoch: host.criticalStateVersion,
          actionInFlight: system2BodyOwned(host.executor.current?.kind ?? null),
        }
      }
      let currentContext = buildCurrentContext()
      let validity = evaluateSystem2Apply(requestContext, currentContext)
      // A body-owned action in flight is the ONE transient apply fence: the plan
      // is still authored against this exact queue/world, so hold it briefly for
      // the mechanical continuation to land rather than paying a fresh model
      // call whose answer races the same fence again (measured: portal-p1 and
      // v2-n5 discarded every authored plan while STEP/DESCEND legs ran under an
      // empty queue). Every other reason - queue/objective/inventory/dimension/
      // epoch/threat/facts - still discards immediately.
      for (
        let deferAttempt = 0;
        deferAttempt < SYSTEM2_APPLY_DEFER_ATTEMPTS &&
          !validity.apply &&
          validity.reasons.every((deferReason) => deferReason === 'action_in_flight');
        deferAttempt += 1
      ) {
        host.logger.info(
          'system2',
          `SYSTEM2_APPLY_DEFER attempt=${deferAttempt + 1}/${SYSTEM2_APPLY_DEFER_ATTEMPTS} reason=action_in_flight`,
          { requestId: requestContext.requestId, deferMs: SYSTEM2_APPLY_DEFER_MS },
          host.tickCounter,
        )
        await new Promise((resolveDefer) => setTimeout(resolveDefer, SYSTEM2_APPLY_DEFER_MS))
        if (!host.running || host.modelRecoveryStopping) break
        currentContext = buildCurrentContext()
        validity = evaluateSystem2Apply(requestContext, currentContext)
      }
      if (!host.running || host.modelRecoveryStopping) {
        staleDiscard()
        return
      }
      if (!validity.apply) {
        const line = formatSystem2Discard(requestContext, validity.reasons)
        host.logger.warn(
          'system2',
          line,
          {
            requestId: requestContext.requestId,
            reasons: validity.reasons,
            requestContext,
            currentContext,
            note: plan.note,
            op: plan.op ?? 'replace',
          },
          host.tickCounter,
        )
        if (host.headAnswerWarrant?.requestId === requestContext.requestId) host.headAnswerWarrant = null
        host.llmInFlight = false
        host.requestDecision('llm_plan', { reason, discarded: true, reasons: validity.reasons })
        return
      }
      // #plan-reconciliation: an answer that carries a real plan for the head the
      // model was asked about supersedes that head. `patch` alone would keep the
      // active row - the measured loop survived its own escalation that way - so
      // the row is retired first, with typed mirrored evidence naming it and the
      // request, and only then is the plan applied. `abandon`/`abort`/`complete`
      // already resolve the head themselves and are left exactly as they were, and
      // a valueless answer replaces nothing.
      const warrant =
        host.headAnswerWarrant !== null && host.headAnswerWarrant.requestId === requestContext.requestId
          ? host.headAnswerWarrant
          : null
      if (warrant !== null) host.headAnswerWarrant = null
      // A pending/active HUMAN row owns WHAT until it is cleared, and `applyPlan`
      // refuses an llm plan while one exists - so the warrant must not retire the
      // head on an answer that could never be applied.
      const humanOwnsWhat = host.queue.state.goals.some(
        (queued) => queued.origin === 'human' && (queued.status === 'pending' || queued.status === 'active'),
      )
      const answersTheHead =
        warrant !== null &&
        !humanOwnsWhat &&
        plan.goals.length > 0 &&
        (plan.op === undefined || plan.op === 'patch' || plan.op === 'replace')
      const depthBefore = host.queue.state.depth
      const operation = plan.op ?? 'replace'
      const queueRevisionBeforeApply = host.queue.revision
      const currentBeforeApply = host.queue.state.current
      let operationRejected = false
      // Recovery provenance is checked at the actual commit point. Keep BOTH
      // queue mutations (answering the current head and installing the plan)
      // behind the host-owned fence so a cached/stale answer cannot mutate the
      // ledger before a post-apply marker notices it.
      const applyPlan = (): QueuedGoal[] => {
        if (answersTheHead && warrant !== null) {
          const replaced = host.queue.replaceAnsweredHead({
            headId: warrant.headId,
            requestId: warrant.requestId,
            reason: warrant.reason,
            note: plan.note,
            onReplaced: (line, detail) => host.logger.warn('queue', line, detail, host.tickCounter),
          })
          if (replaced !== null) {
            host.recentEvents.push(
              `head replaced by System2 answer: ${replaced.id} (${replaced.description}) reason=${warrant.reason} requestId=${requestContext.requestId}`,
            )
            host.logger.warn(
              'system2',
              `PLAN_HEAD_REPLACEMENT_APPLIED requestId=${requestContext.requestId} replaced=${replaced.id} goalQueueHead=${host.queue.current?.id ?? 'none'} op=${plan.op ?? 'replace'} goals=${plan.goals.length}`,
              {
                requestId: requestContext.requestId,
                replaced: replaced.id,
                replacedKey: warrant.headKey,
                reason: warrant.reason,
                op: plan.op ?? 'replace',
                goals: plan.goals.map((goal) => goal.description),
                head: host.queue.current?.id ?? null,
              },
              host.tickCounter,
            )
          }
        }
        return host.queue.applyPlan(plan.goals, 'llm', operation, {
          reason: plan.note,
          onProtection: (line) => {
            // GoalQueue reports the protected-empty-plan rejection on the
            // protection channel (there is no onOperationRejected callback).
            if (line.startsWith('PROTECTED_GOAL_DROPPED_REJECTED ')) operationRejected = true
            host.logger.warn('agent', line, { op: plan.op ?? 'replace', reason, phase: 'runtime' }, host.tickCounter)
          },
          onDuplicate: (line) => host.logger.warn('agent', line, { op: plan.op ?? 'replace', reason, phase: 'runtime' }, host.tickCounter),
          protectedGoalRetireReason: (goal, incoming) => host.protectedGoalRetireReason(goal, incoming),
          verifyCurrentComplete: (goal) => host.verifyQueuedGoalComplete(goal),
          onOperationRejected: (line) => {
            operationRejected = true
            host.logger.warn('system2', line, { requestId: requestContext.requestId, op: plan.op ?? 'replace' }, host.tickCounter)
          },
        })
      }
      let added: QueuedGoal[]
      if (host.options.recoverySystem2Authority !== undefined && host.options.recoverySystem2Authority !== null) {
        const fenced = applySystem2RecoveryFence({
          expectedAuthority: host.options.recoverySystem2Authority,
          actualAuthority: host.system2AuthorityStack,
          expectedSourceSha: host.options.recoverySourceSha ?? null,
          actualSourceSha: host.options.generationSourceSha ?? null,
          intentSource: plan.provenance?.intentSource ?? null,
        }, applyPlan)
        if (fenced.applied) {
          added = fenced.value
        } else {
          host.llmInFlight = false
          if (host.options.rejectSystem2RecoveryPlan === undefined) {
            throw new FatalModelError('system2-authority', 1, `recovery plan rejected (${fenced.rejection.reason}); host recovery handler unavailable`, true)
          }
          host.options.rejectSystem2RecoveryPlan(fenced.rejection)
          throw new FatalModelError('system2-authority', 1, 'host recovery handler returned without stopping the generation', true)
        }
      } else {
        added = applyPlan()
      }
      const acceptedGoals = acceptedSystem2PlanGoals({
        operation,
        added,
        currentBefore: currentBeforeApply,
        currentAfter: host.queue.state.current,
        applied: host.queue.revision > queueRevisionBeforeApply,
      })
      host.logQueueDepthDelta(depthBefore, operation, `summon:${reason}`)
      host.rememberSystem2PlanOutcome({
        proposalId: requestContext.requestId,
        operation,
        intentSource: plan.provenance?.intentSource ?? 'none',
        intent: plan.provenance?.intent ?? plan.note,
        requestedGoalsTotal: plan.goals.length,
        acceptedGoals,
        optionInstanceBefore: requestContext.optionInstanceId,
        queueDoneBefore: queueState.done,
        stateFingerprintBefore: requestContext.semanticStateFingerprint ?? 'unobserved',
        blockersBefore: blockers,
        successSnapshot: successSnapshotBefore,
      })
      if (added.length > 0) {
        host.chosenCountsAtProgress = host.lastProgress
        host.lastProgressAt = Date.now()
      }
      host.llmNotes.push(plan.note)
      if (host.llmNotes.length > 12) host.llmNotes.shift()
      // #system2-compile: the hand-off is typed and mirrored. The applied line
      // names the INTENT (which words the model wrote), the COMPILED rows (the
      // executable meaning: kind, target, dimension) and the apply outcome; an
      // answer that produced no row is a typed rejection naming why, never a
      // silent no-op. Code reports the model's WHAT here; it never picks one.
      const provenance = plan.provenance ?? null
      const compiledRows = added.map((goal) => ({
        id: goal.id,
        kind: goal.kind,
        targetItem: goal.targetItem ?? null,
        targetY: goal.targetY ?? null,
        dimension: goal.dimension ?? null,
        description: goal.description,
      }))
      const compiledSummary = formatCompiledGoalRows(compiledRows)
      const intentSource = provenance?.intentSource ?? 'unrecorded'
      const accepted = !operationRejected
      // `abort`/`complete`/`continue` are lifecycle ops whose meaning IS the op,
      // so an empty goal list is their correct shape; only a goal-carrying op can
      // "carry no goals".
      const planOp = plan.op ?? 'replace'
      const goalsExpected = planOp === 'patch' || planOp === 'replace'
      const system2Authority = host.system2AuthorityStack
      // The MIRRORED half of the hand-off: one marker line naming the model's own
      // words, the executable meaning of every accepted row, and the outcome. It
      // is emitted in BOTH evidence planes (MIRRORED_MARKERS), or the host log
      // cannot tell "the answer produced no row" from "the answer never applied".
      host.logger.warn(
        'system2',
        formatSystem2PlanApplied({
          requestId: requestContext.requestId,
          op: planOp,
          accepted,
          applied: added.length,
          depth: host.queue.state.depth,
          intentSource,
          uncompiled: provenance?.uncompiled?.length ?? 0,
          intent: provenance?.intent ?? plan.note,
          rows: compiledRows,
        }),
        {
          requestId: requestContext.requestId,
          reason,
          provider: system2Authority.provider,
          model: system2Authority.model,
          op: planOp,
          accepted,
          applied: added.length,
          compiled: compiledRows,
          uncompiled: provenance?.uncompiled ?? [],
          intentSource,
          intent: provenance?.intent ?? null,
          noGoalsReason: plan.goals.length === 0 && goalsExpected ? (provenance?.noGoalsReason ?? 'answer_carried_no_goals') : null,
          note: plan.note,
        },
        host.tickCounter,
      )
      if (plan.goals.length === 0 && goalsExpected) {
        const noGoalsReason = provenance?.noGoalsReason ?? 'answer_carried_no_goals'
        const intentText = (provenance?.intent ?? plan.note).slice(0, 200)
        host.logger.warn(
          'system2',
          `SYSTEM2_PLAN_NO_GOALS op=${planOp} reason=${noGoalsReason} intentSource=${intentSource} requestId=${requestContext.requestId} intent="${intentText}"`,
          {
            requestId: requestContext.requestId,
            reason,
            op: planOp,
            noGoalsReason,
            intentSource,
            intent: intentText,
            uncompiled: provenance?.uncompiled ?? [],
            note: plan.note,
          },
          host.tickCounter,
        )
        host.recentEvents.push(
          `System2 answered with no compilable goal (${noGoalsReason}); ${host.currentGoalKey()} held`,
        )
      }
      host.logger.info(
        'system2',
        `LLM plan applied provider=${system2Authority.provider} model=${system2Authority.model}: ${added.length} goal(s) depth=${host.queue.state.depth} intentSource=${intentSource} uncompiled=${provenance?.uncompiled?.length ?? 0} compiled=[${compiledSummary}] :: ${plan.note}`,
        {
          provider: system2Authority.provider,
          model: system2Authority.model,
          requestId: requestContext.requestId,
          requestContext,
          queueDepth: host.queue.state.depth,
          goals: added.map((goal) => goal.description),
          compiled: compiledRows,
          uncompiled: provenance?.uncompiled ?? [],
          intentSource,
          intent: provenance?.intent ?? null,
          note: plan.note,
        },
        host.tickCounter,
      )
      host.llmInFlight = false
      host.requestDecision('llm_plan', { reason, goals: added.length })
    })
    .catch((error: unknown) => {
      if (host.headAnswerWarrant?.requestId === requestContext.requestId) host.headAnswerWarrant = null
      host.llmInFlight = false
      if (error instanceof ModelRecoveryRequested) return
      if (error instanceof System2RequestCancelledError) {
        host.logger.warn(
          'system2',
          'SYSTEM2_REQUEST_CANCELLED',
          { reason, requestId: requestContext.requestId, cancellationReason: error.reason },
          host.tickCounter,
        )
        return
      }
      if (!host.running) {
        host.logger.warn(
          'system2',
          'SYSTEM2_STALE_DISCARD reason=controller_stopped_error',
          { reason, requestId: requestContext.requestId, error: describeFailure(error) },
          host.tickCounter,
        )
        return
      }
      const fatal = error instanceof FatalModelError ? error : new FatalModelError('system2-plan', 1, describeFailure(error))
      failLoud(fatal, (event, detail) => host.logger.error('system2', event, { reason, ...(detail ?? {}) }, host.tickCounter), host.options.terminateOnModelFailure)
    })

  return resummon
}

// ---------------------------------------------------------------------------
// Single-shot System2 bootstrap plan (moved from controller.ts): one
// queue_empty plan request applied through the protected/duplicate guards,
// journaled with its authority stack, then the phase ledger restored.
// ---------------------------------------------------------------------------

export async function bootstrapPlan(host: System2PlaneHost): Promise<void> {
  const before = host.queue.state
  const requestId = randomUUID()
  const semanticStateFingerprint = host.semanticStateFingerprint()
  const successSnapshotBefore = host.semanticOptionSnapshot()
  const requestContext: System2RequestContext = {
    requestId,
    queueRevision: host.queue.revision,
    optionInstanceId: before.current?.semanticOptionInstanceId ?? before.current?.optionInstanceId ?? null,
    optionTemplateId: before.current?.semanticOptionTemplateId ?? before.current?.optionTemplateId ?? null,
    worldEpoch: host.options.worldEpoch,
    stateFingerprint: host.lastStateFingerprint || 'unobserved',
    semanticStateFingerprint,
    ...host.system2ApplyIdentity(host.lastWorldState),
    // Physical/search progress advances the general progress epoch, but does
    // not by itself stale a long-horizon WHAT answer. Human intent and queue
    // edits have their own fences; safety-critical triggers still advance this
    // epoch and the sampled threat fingerprint below.
    authorityEpoch: host.criticalStateVersion,
  }
  const request: System2PlanRequest = {
    reason: 'queue_empty',
    detail: 'single-shot bootstrap: supply the long-horizon plan once',
    tick: host.tickCounter,
    goalQueueState: before,
    objective: host.objectiveState(),
    recentEvents: [],
    recentOutcomes: [],
    recentSemanticOutcomes: host.recentSemanticOutcomes.slice(-SYSTEM2_SEMANTIC_HISTORY_LIMIT),
    requestContext,
  }
  const plan = await host.system2.plan(request)
  host.planCalls += 1
  const depthBefore = host.queue.state.depth
  const queueRevisionBeforeApply = host.queue.revision
  const currentBeforeApply = host.queue.state.current
  const restoredHead = host.queue.current !== null
  const requestedOp = plan.op ?? 'replace'
  const op = resolveBootstrapPlanOp(host.queue, plan.op)
  let operationRejected = false
  const added = host.queue.applyPlan(plan.goals, 'llm', op, {
    reason: plan.note,
    onProtection: (line) => {
      // A protected empty plan is refused through this callback rather than
      // `onOperationRejected`; retain that decision in the run-scoped marker.
      if (line.startsWith('PROTECTED_GOAL_DROPPED_REJECTED ')) operationRejected = true
      host.logger.warn('agent', line, { op, requested: requestedOp, phase: 'bootstrap' }, host.tickCounter)
    },
    onDuplicate: (line) => host.logger.warn('agent', line, { op, requested: requestedOp, phase: 'bootstrap' }, host.tickCounter),
    protectedGoalRetireReason: (goal, incoming) => host.protectedGoalRetireReason(goal, incoming),
    onOperationRejected: (line) => {
      operationRejected = true
      host.logger.warn('system2', line, { requestId, op }, host.tickCounter)
    },
  })
  const acceptedGoals = acceptedSystem2PlanGoals({
    operation: op,
    added,
    currentBefore: currentBeforeApply,
    currentAfter: host.queue.state.current,
    applied: host.queue.revision > queueRevisionBeforeApply,
  })
  host.logQueueDepthDelta(depthBefore, op, `bootstrap`)
  host.rememberSystem2PlanOutcome({
    proposalId: requestId,
    operation: op,
    intentSource: plan.provenance?.intentSource ?? 'none',
    intent: plan.provenance?.intent ?? plan.note,
    requestedGoalsTotal: plan.goals.length,
    acceptedGoals,
    optionInstanceBefore: requestContext.optionInstanceId,
    queueDoneBefore: before.done,
    stateFingerprintBefore: semanticStateFingerprint,
    blockersBefore: null,
    successSnapshot: successSnapshotBefore,
  })
  const accepted = !operationRejected
  const provenance = plan.provenance ?? null
  const compiledRows = added.map((goal) => ({
    id: goal.id,
    kind: goal.kind,
    targetItem: goal.targetItem ?? null,
    targetY: goal.targetY ?? null,
    dimension: goal.dimension ?? null,
    description: goal.description,
  }))
  const system2Authority = host.system2AuthorityStack
  host.logger.warn(
    'system2',
    formatSystem2PlanApplied({
      requestId,
      op,
      accepted,
      applied: added.length,
      depth: host.queue.state.depth,
      intentSource: provenance?.intentSource ?? 'unrecorded',
      uncompiled: provenance?.uncompiled?.length ?? 0,
      intent: provenance?.intent ?? plan.note,
      rows: compiledRows,
    }),
    {
      requestId,
      provider: system2Authority.provider,
      model: system2Authority.model,
      op,
      requestedOp,
      accepted,
      applied: added.length,
      compiled: compiledRows,
      uncompiled: provenance?.uncompiled ?? [],
      intentSource: provenance?.intentSource ?? 'unrecorded',
      intent: provenance?.intent ?? null,
      note: plan.note,
    },
    host.tickCounter,
  )
  host.subgoalCount = Math.max(added.length, host.queue.size)
  if (restoredHead && op !== requestedOp) {
    host.logger.warn(
      'system2',
      `BOOTSTRAP_HEAD_PRESERVED current=${host.queue.current?.description ?? 'none'} op=${op} requested=${requestedOp} depth=${host.queue.state.depth}`,
      { op, requested: requestedOp, depth: host.queue.state.depth, current: host.queue.current?.description ?? null },
      0,
    )
  }
  host.planSupplied = true
  const restored = host.loadLedger()
  if (restored !== null) {
    host.queue.restore(restored)
    host.subgoalCount = Math.max(host.subgoalCount, restored.goals.length)
    host.logger.warn(
      'system2',
      `phase ledger restored: ${restored.goals.filter((goal) => goal.status === 'done').length} subgoal(s) already done; current=${host.queue.current?.description ?? 'none'}`,
      { done: restored.goals.filter((goal) => goal.status === 'done').length, total: restored.goals.length },
      0,
    )
  }
  const current = host.queue.current
  host.logger.warn(
    'system2',
    `bootstrap plan applied provider=${host.system2Provider} model=${host.system2Model} call=1 goals=${added.length} depth=${host.queue.state.depth} :: ${plan.note}`,
    {
      provider: host.system2Provider,
      model: host.system2Model,
      planCalls: host.planCalls,
      goals: added.map((goal) => goal.description),
      note: plan.note,
    },
    0,
  )
  if (current !== null) host.logSubgoalStart(current, host.inventorySnapshot(), 'bootstrap')
}
/**
 * The queue op the single-shot bootstrap plan is actually applied with (moved
 * from controller.ts; semantics in the doc above the function).
 * A restored, not-yet-done queue head is work the bot already committed to,
 * so bootstrap merges the ladder BEHIND it (`continue`); an empty queue keeps
 * the requested op, and an explicit `abort` is never overridden.
 */
export function resolveBootstrapPlanOp(queue: GoalQueue, requested: PlanOp | undefined): PlanOp {
  const op = requested ?? 'replace'
  if (op === 'replace' && queue.current !== null) return 'continue'
  return op
}
