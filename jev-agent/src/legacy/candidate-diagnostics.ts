// candidate-diagnostics.ts — legacy candidate/skill execution log projection.
//
// Extracted from `controller-legacy.ts`. These functions only translate
// candidates, results, and refusals into structured log rows; they own no
// authority and mutate nothing except per-tick dedup keys on the host. They
// are legacy evidence plumbing, not a semantic source of truth.

import type { Bot } from 'mineflayer'
import { BRIDGE_AUTHORITY_META, BRIDGE_REFUSED_META } from '../bridgeRoute.ts'
import { ACTION_COMMIT, ACTION_PREEMPT, CANDIDATE_COMMIT_RELEASED, CANDIDATE_FLAP } from '../candidateCommitment.ts'
import { CRAFT_STATION_ALREADY_KNOWN } from '../candidates.ts'
import { ENV_HAZARD, ENV_HAZARD_CLEAR, ENV_HAZARD_NO_EXIT } from '../envHazard.ts'
import { FOOD_SOURCE_NONE } from '../foodSources.ts'
import { PLAN_HEAD_REPLACED, PLAN_IDENTITY_CHANGED, PLAN_ROW_RETIRED, ROW_DEFERRED_NOT_EXECUTABLE_HERE, ROW_NOT_EXECUTABLE_HERE } from '../goalQueue.ts'
import { GOAL_RETIRED_PREDICATE, GOAL_SUCCESS_PROBE_ERROR } from '../goalSuccess.ts'
import { ACTION_REJECTED } from '../policy.ts'
import { PREREQ_STATION_ALREADY_KNOWN } from '../prereqOption.ts'
import { PROTECTION_ABANDON_CONFLICT } from '../protectionConflict.ts'
import { ACTION_REPEAT_EXHAUSTED_MARKER, ACTION_REPEAT_MARKER, ACTION_TARGET_RETIRED_MARKER } from '../repeatedOutcomeEscalation.ts'
import { BETA_ABANDON_DEFERRED_MARKER, BETA_ABANDON_RELEASED_MARKER, WAIT_EXHAUSTED_MARKER, WAIT_STREAK_MARKER } from '../replanThrottle.ts'
import { MOVE_LEG_STOPPED } from '../stepLanding.ts'
import { DEATH_CAUSE, GUARD_REJECTIONS, MOB_IDENTITY_CHURN, SURVIVAL_NO_GROUNDED_ACTION, SURVIVAL_REGROUND, THREAT_BREAK_CONTACT, THREAT_CLEAR, THREAT_NEARBY, THREAT_NO_ESCAPE, THREAT_RANGED_UNANSWERED } from '../threat.ts'
import type { Candidate } from '../candidates.ts'
import { formatDigRouteProgress, formatDigRouteRefused } from '../digRoute.ts'
import type { DigRouteRefusal } from '../digRoute.ts'
import type { ExecutionResult } from '../executor.ts'
import type { EventLogger } from '../jev.ts'
import { formatLevelScanStep } from '../levelScan.ts'
import { formatSkillStep, SKILL_END, SKILL_INTERRUPT, SKILL_POLICY_BOUNDARY } from '../netherPortalPlan.ts'
import { distance } from '../state.ts'
import { countBlockedLogs, formatCandidateAcquisition, formatCandidateAcquisitionRefused, formatLogRoute, isFoodItem, logRouteOf, pickFood, selfContainedCraftCandidates, staleKnownResources } from '../candidates.ts'
import type { CandidateOptions, CandidateReachability } from '../candidates.ts'
import type { PlannedGoal, QueuedGoal } from '../goalQueue.ts'
import { compilePlannedGoal, evaluatePredicates } from '../optionSpec.ts'
import type { OptionWorldSnapshot, Predicate } from '../optionSpec.ts'
import type { System2ToolGap } from '../system2.ts'
import type { HarvestTool } from '../state.ts'
import { SYSTEM2_PAYLOAD, SYSTEM2_PAYLOAD_ABSENT, SYSTEM2_PAYLOAD_REFUSED } from '../system2Payload.ts'
import { bestToolTier } from '../reachability.ts'
import { NO_ATTACK_STAND, formatNoAttackStand } from '../combatClosure.ts'
import { capabilityKey, formatCandidateWithheld, formatDigAccessRetired, formatReachability } from '../reachability.ts'
import type { KnownResourceEvidence, KnownResourceFalsifiedReason, Vec3Json, WorldState } from '../state.ts'
import { formatApproachLeg } from '../zeroProgressRoute.ts'
import type { DigMemory } from '../worldMemory.ts'

export function formatKnownResourceFalsified(
  item: string,
  name: string,
  cell: Vec3Json,
  reason: KnownResourceFalsifiedReason,
): string {
  return `KNOWN_RESOURCE_FALSIFIED item=${item} name=${name} cell=${cell.x},${cell.y},${cell.z} reason=${reason}`
}

export function formatKnownResourceResighted(
  item: string,
  name: string,
  cell: Vec3Json,
  source: 'mob' | 'drop',
): string {
  return `KNOWN_RESOURCE_RESIGHTED item=${item} name=${name} cell=${cell.x},${cell.y},${cell.z} source=${source}`
}

export interface KnownResourceVerdictLatch {
  /** `<item>:<name>@<cell>:<reason>` already reported */
  falsified: Set<string>
  /** `<item>:<name>@<cell>` re-sight already reported */
  resighted: Set<string>
}

export type KnownResourceVerdict =
  | { kind: 'none' }
  | { kind: 'falsified'; reason: KnownResourceFalsifiedReason }
  | { kind: 'resighted'; source: 'mob' | 'drop' }

export function nextKnownResourceVerdict(
  latch: KnownResourceVerdictLatch,
  evidence: Pick<KnownResourceEvidence, 'item' | 'name' | 'position' | 'status' | 'reason' | 'source'>,
): KnownResourceVerdict {
  const base = `${evidence.item}:${evidence.name}@${evidence.position.x},${evidence.position.y},${evidence.position.z}`
  if (evidence.status === 'falsified') {
    const reason: KnownResourceFalsifiedReason = evidence.reason ?? 'block_mined'
    const key = `${base}:${reason}`
    if (latch.falsified.has(key)) return { kind: 'none' }
    latch.falsified.add(key)
    latch.resighted.delete(base)
    return { kind: 'falsified', reason }
  }
  if (evidence.status !== 'present' && evidence.status !== 'replaced') return { kind: 'none' }
  const withheld = [...latch.falsified].some((key) => key.startsWith(`${base}:`))
  for (const key of [...latch.falsified]) {
    if (key.startsWith(`${base}:`)) latch.falsified.delete(key)
  }
  if (evidence.source === undefined || !withheld || latch.resighted.has(base)) return { kind: 'none' }
  latch.resighted.add(base)
  return { kind: 'resighted', source: evidence.source }
}

function knownResourceVerdictDetail(
  evidence: KnownResourceEvidence,
  reason: KnownResourceFalsifiedReason | null,
): Record<string, unknown> {
  return {
    item: evidence.item,
    name: evidence.name,
    cell: evidence.position,
    observed: evidence.observed,
    claim: evidence.claim,
    ...(reason === null ? {} : { reason }),
    ...(evidence.source === undefined ? {} : { source: evidence.source }),
  }
}

/** Narrow host surface: logger, tick clock, body position, dedup cells. */
export interface CandidateDiagnosticsHost {
  logger: EventLogger
  tickCounter: number
  bot: Bot
  queue: {
    readonly current: { readonly kind?: string; readonly targetY?: number | null } | null
    readonly revision: number
  }
  digMemory: Pick<DigMemory, 'dirCount' | 'lastTunnel' | 'knownStoneY'>
  digRouteRefusalsThisTick: DigRouteRefusal[]
  lastBridgeRefusalKey: string | null
  lastSkillBoundaryKey: string | null
  lastLegReflexKey: string | null
  lastDigRouteRefusalKey: string | null
  lastCandidateSignature: string
  lastLogRouteSignature: string
  lastFoodMarkerSignature: string
  lastFoodLevel: number | null
  lastFoodCounts: Map<string, number> | null
  readonly loggedStaleResources: Set<string>
  readonly reachabilityLogSignatures: Map<string, string>
  knownResourceVerdicts: KnownResourceVerdictLatch
  logKnownResourceVerdicts(state: WorldState): void
  logReachabilityOnce(
    key: string,
    signature: string,
    flag: boolean,
    entry: CandidateReachability,
  ): void
}

export function logApproachLeg(host: CandidateDiagnosticsHost, candidate: Candidate): void {
    const target = candidate.target
    if (target === null) return
    const reason = typeof candidate.meta.approachLeg === 'string' ? candidate.meta.approachLeg : 'target_not_observable'
    host.logger.info(
      'agent',
      formatApproachLeg(reason, target),
      {
        actionId: candidate.id,
        target,
        resource: typeof candidate.meta.approachResource === 'string' ? candidate.meta.approachResource : null,
      },
      host.tickCounter,
    )
  }

  /**
   * The typed `BRIDGE_REFUSED reason=<no_block|no_verified_landing|hazard|
   * protected|budget> ...` facts: the leg needed a same-level gap crossed, the
   * sensor's bounded forward probe saw it, and the bridge was refused for a NAMED
   * reason (`bridgeRoute.ts`). Logged for WITHHELD candidates too, so the refusal is
   * visible on the tick it exists instead of looking like "no gap was ever seen".
   * Deduped like the other typed dead-end facts.
   */

export function logBridgeRefusals(host: CandidateDiagnosticsHost, offered: readonly Candidate[], withheld: readonly Candidate[]): void {
    const lines: string[] = []
    for (const candidate of [...offered, ...withheld]) {
      const line = candidate.meta[BRIDGE_REFUSED_META]
      if (typeof line === 'string' && line.length > 0 && !lines.includes(line)) lines.push(line)
    }
    const key = lines.length === 0 ? null : lines.join('|')
    if (key === host.lastBridgeRefusalKey) return
    host.lastBridgeRefusalKey = key
    if (key === null) return
    for (const line of lines) host.logger.warn('agent', line, { line }, host.tickCounter)
  }

  /**
   * The selected BRIDGE leg's #436 section 17 layer: `SKILL_STEP skill=<id>
   * step=bridge authority=<MECHANICAL_CONTINUATION|MANDATORY_PREREQUISITE>
   * evidence=... worldDelta=place_blocks=1 budget=<span>`. Logged when the action is
   * taken, so the marker means "the body is now running this bridge", and the layer
   * half says whether code finished a UNIQUE prerequisite (U1..U6) or merely
   * realized the route Jev selected. The `REFLEX reason=unique_binding_prerequisite`
   * proof, when there is one, rides `logLegReflexes` from the same candidate meta.
   */

export function logBridgeAuthority(host: CandidateDiagnosticsHost, candidate: Candidate): void {
    const detail = typeof candidate.meta[BRIDGE_AUTHORITY_META] === 'string' ? candidate.meta[BRIDGE_AUTHORITY_META] : null
    const skill = typeof candidate.meta.legContinuationSkill === 'string' ? candidate.meta.legContinuationSkill : 'BRIDGE(approach)'
    const line =
      detail === null
        ? formatSkillStep(skill, 'bridge', `target=${candidate.target === null ? 'unknown' : `${candidate.target.x},${candidate.target.y},${candidate.target.z}`}`)
        : formatSkillStep(skill, 'bridge', detail)
    host.logger.info('agent', line, {
      actionId: candidate.id,
      target: candidate.target,
      dir: candidate.meta.bridgeDir ?? null,
      block: candidate.meta.bridgeBlock ?? null,
      span: candidate.meta.bridgeSpan ?? null,
      mayPlaceBlocks: candidate.meta.mayPlaceBlocks === true,
    })
  }

  /**
   * The #436 `SKILL_POLICY_BOUNDARY skill=<id> reason=<reason> alternatives=[...]`
   * facts: where the offer grounded several NON-EQUIVALENT remedies and code
   * therefore stopped instead of ranking them (section 7 U3 / section 19 (8, 28) /
   * section 22). Deduped like the other typed facts, and logged for WITHHELD
   * candidates too, so the boundary is visible on the tick it exists.
   */

export function logSkillPolicyBoundaries(host: CandidateDiagnosticsHost, offered: readonly Candidate[], withheld: readonly Candidate[]): void {
    const lines: string[] = []
    for (const candidate of [...offered, ...withheld]) {
      const line = candidate.meta.legPolicyBoundary
      if (typeof line === 'string' && line.length > 0 && !lines.includes(line)) lines.push(line)
    }
    const key = lines.length === 0 ? null : lines.join('|')
    if (key === host.lastSkillBoundaryKey) return
    host.lastSkillBoundaryKey = key
    if (key === null) return
    for (const line of lines) host.logger.warn('agent', line, { line }, host.tickCounter)
  }

  /**
   * The #436 `REFLEX ownerSkill=<skill> reason=unique_binding_prerequisite
   * action=<step_up|step_over> cell=... via=... ledge=... evidence=...` facts: the
   * bounded mechanical continuation that is the UNIQUE way the active leg can
   * reach its waypoint from here (see `candidates.ts#pocketContinuations`).
   * Deduped like the other typed dead-end facts, and logged for the WITHHELD
   * candidates too, so "the only way out is this step" is visible in the resident
   * log even while Jev is still choosing (measured run-mucbyro1-1hqhm: the body
   * was stuck on a stuck MOVE with an empty contract and no such fact at all).
   */

export function logLegReflexes(host: CandidateDiagnosticsHost, offered: readonly Candidate[], withheld: readonly Candidate[]): void {
    const lines: string[] = []
    for (const candidate of [...offered, ...withheld]) {
      const line = candidate.meta.legReflex
      if (typeof line === 'string' && line.length > 0 && !lines.includes(line)) lines.push(line)
    }
    const key = lines.length === 0 ? null : lines.join('|')
    if (key === host.lastLegReflexKey) return
    host.lastLegReflexKey = key
    if (key === null) return
    for (const line of lines) {
      host.logger.info('agent', line, { line }, host.tickCounter)
    }
  }

  /**
   * The mechanical continuation Jev selected (`SKILL_STEP action=... cell=...
   * via=... ledge=... vertical=staircase-up`). Logged when the action is taken, so
   * the marker means "the body is now running this step", not "a step existed";
   * the ordinary MOVE/PATH/VERIFIED markers then report its outcome unchanged.
   */

export function logSkillStep(host: CandidateDiagnosticsHost, candidate: Candidate): void {
    const line = typeof candidate.meta.legContinuationLine === 'string' ? candidate.meta.legContinuationLine : null
    host.logger.info(
      'agent',
      line ??
        `SKILL_STEP action=${String(candidate.meta.legContinuationAction ?? 'step_up')} cell=${String(candidate.meta.legContinuationCell ?? 'unknown')} vertical=${String(candidate.meta.vertical ?? 'none')}`,
      {
        actionId: candidate.id,
        skill: typeof candidate.meta.legContinuationSkill === 'string' ? candidate.meta.legContinuationSkill : null,
        action: typeof candidate.meta.legContinuationAction === 'string' ? candidate.meta.legContinuationAction : null,
        cell: typeof candidate.meta.legContinuationCell === 'string' ? candidate.meta.legContinuationCell : null,
        via: typeof candidate.meta.legContinuationVia === 'string' ? candidate.meta.legContinuationVia : null,
        ledge: typeof candidate.meta.legContinuationLedge === 'string' ? candidate.meta.legContinuationLedge : null,
        vertical: typeof candidate.meta.vertical === 'string' ? candidate.meta.vertical : null,
      },
      host.tickCounter,
    )
  }

  /**
   * The selected LEVEL SCAN descent (`levelScan.ts`): nothing at the body's own level could
   * ground a route toward the travel/enter/retrieve target, so the bounded level scan offered
   * the own-column descent that STARTS a composed route ending strictly closer to the target.
   *
   * Logged when Jev actually selects it, so the marker means "this body is now descending
   * toward the scanned level", not "a route was enumerated". The line names the level, the
   * continuation cell and material, whether it is a dig or a walk, the pre-existing floor, the
   * per-level flood verdict (`levels=`) and the distance change; the §7 layer half rides the
   * same mirrored `SKILL_STEP` channel the wall entry uses.
   */

export function logLevelScan(host: CandidateDiagnosticsHost, candidate: Candidate): void {
    const line = typeof candidate.meta.levelScanLine === 'string' ? candidate.meta.levelScanLine : null
    if (line === null) return
    host.logger.info(
      'agent',
      line,
      {
        actionId: candidate.id,
        target: typeof candidate.meta.levelScanTarget === 'string' ? candidate.meta.levelScanTarget : null,
        level: typeof candidate.meta.levelScanLevel === 'number' ? candidate.meta.levelScanLevel : null,
        depth: typeof candidate.meta.levelScanDepth === 'number' ? candidate.meta.levelScanDepth : null,
        dir: typeof candidate.meta.levelScanDir === 'string' ? candidate.meta.levelScanDir : null,
        via: typeof candidate.meta.levelScanVia === 'string' ? candidate.meta.levelScanVia : null,
        cell: typeof candidate.meta.levelScanCell === 'string' ? candidate.meta.levelScanCell : null,
        block: typeof candidate.meta.levelScanBlock === 'string' ? candidate.meta.levelScanBlock : null,
        fromD: typeof candidate.meta.levelScanFrom === 'number' ? candidate.meta.levelScanFrom : null,
        toD: typeof candidate.meta.levelScanTo === 'number' ? candidate.meta.levelScanTo : null,
        alternatives:
          typeof candidate.meta.levelScanAlternatives === 'string' ? candidate.meta.levelScanAlternatives : null,
        evidence: typeof candidate.meta.levelScanEvidence === 'string' ? candidate.meta.levelScanEvidence : null,
      },
      host.tickCounter,
    )
    const authorityLine =
      typeof candidate.meta.levelScanAuthorityLine === 'string' ? candidate.meta.levelScanAuthorityLine : null
    if (authorityLine !== null) {
      host.logger.info('agent', authorityLine, { actionId: candidate.id, step: 'level_scan' }, host.tickCounter)
    }
  }

  /**
   * The settled level-scan descent measured against the world: the level the body actually
   * reached, how many own-column steps still separate it from the continuation's level, and
   * the distance to the target before/after. Emitted only when the descent measurably moved
   * the body DOWN toward the scanned level, so "the scan descended toward a route" is a
   * measured fact instead of an assumption, and a descent that did nothing is not reported.
   */

export function logLevelScanStep(host: CandidateDiagnosticsHost, result: ExecutionResult, candidate: Candidate): void {
    if (candidate.meta.levelScan !== true) return
    const targetText = typeof candidate.meta.levelScanTarget === 'string' ? candidate.meta.levelScanTarget : null
    const targetLevel = typeof candidate.meta.levelScanLevel === 'number' ? candidate.meta.levelScanLevel : null
    const fromD = typeof candidate.meta.levelScanFrom === 'number' ? candidate.meta.levelScanFrom : null
    if (targetText === null || targetLevel === null || fromD === null) return
    const parts = targetText.split(',').map((value) => Number(value))
    const [x, y, z] = parts
    if (x === undefined || y === undefined || z === undefined) return
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return
    const feet = {
      x: Math.floor(host.bot.entity.position.x),
      y: Math.floor(host.bot.entity.position.y),
      z: Math.floor(host.bot.entity.position.z),
    }
    const started = {
      x: typeof candidate.meta.wallX === 'number' ? candidate.meta.wallX : feet.x,
      y: typeof candidate.meta.wallY === 'number' ? candidate.meta.wallY : feet.y + 1,
      z: typeof candidate.meta.wallZ === 'number' ? candidate.meta.wallZ : feet.z,
    }
    // The measured claim: the body is one level LOWER than it was. A descent that did not
    // change the level is not progress and emits nothing.
    if (!(feet.y < started.y)) return
    const toD = Math.round(distance(feet, { x, y, z }) * 100) / 100
    host.logger.info(
      'agent',
      formatLevelScanStep({ from: started, to: feet, targetLevel, fromDistance: fromD, toDistance: toD }),
      { actionId: result.actionId, kind: result.kind, status: result.status, level: feet.y, targetLevel, fromD, toD },
      host.tickCounter,
    )
  }

  /**
   * The selected DIG route: the travel/enter/retrieve target had no walkable
   * route, so the offer grounded a bounded dig step toward it. Logged when Jev
   * actually selects it, so the marker means "this body is now digging the route",
   * not "a route was enumerated". The `from_d`/`to_d` pair is the mechanical
   * claim the route makes (the step lands strictly closer to the target), and the
   * settled action re-measures it in `DIG_ROUTE_PROGRESS`.
   */

export function logDigRoute(host: CandidateDiagnosticsHost, candidate: Candidate): void {
    const line = typeof candidate.meta.digRouteLine === 'string' ? candidate.meta.digRouteLine : null
    host.logger.info(
      'agent',
      line ?? `DIG_ROUTE reason=${String(candidate.meta.digRouteReason ?? 'no_walkable_route')} actionId=${candidate.id}`,
      {
        actionId: candidate.id,
        target: typeof candidate.meta.digRouteTarget === 'string' ? candidate.meta.digRouteTarget : null,
        bearing: typeof candidate.meta.digRouteBearing === 'string' ? candidate.meta.digRouteBearing : null,
        cell: typeof candidate.meta.digRouteCell === 'string' ? candidate.meta.digRouteCell : null,
        block: typeof candidate.meta.digRouteBlock === 'string' ? candidate.meta.digRouteBlock : null,
        kind: typeof candidate.meta.digRouteKind === 'string' ? candidate.meta.digRouteKind : null,
        fromD: typeof candidate.meta.digRouteFrom === 'number' ? candidate.meta.digRouteFrom : null,
        toD: typeof candidate.meta.digRouteTo === 'number' ? candidate.meta.digRouteTo : null,
        detour: candidate.meta.digRouteDetour === true,
        skipped: typeof candidate.meta.digRouteSkipped === 'string' ? candidate.meta.digRouteSkipped : null,
        skippedBlock:
          typeof candidate.meta.digRouteSkippedBlock === 'string' ? candidate.meta.digRouteSkippedBlock : null,
        entry: candidate.meta.digRouteEntry === true,
        entryMode: typeof candidate.meta.digRouteEntryMode === 'string' ? candidate.meta.digRouteEntryMode : null,
        entryLevel: typeof candidate.meta.digRouteEntryLevel === 'number' ? candidate.meta.digRouteEntryLevel : null,
        entryEvidence:
          typeof candidate.meta.digRouteEntryEvidence === 'string' ? candidate.meta.digRouteEntryEvidence : null,
      },
      host.tickCounter,
    )
    // The WALL ENTRY's own line (`DIG_ROUTE_ENTRY`): the same fact in the wall-entry
    // vocabulary - the cell the body came from, the heading, the tunnel level, the
    // pre-existing floor and how many alternatives were grounded. Emitted only for an
    // entry, so an ordinary dig route logs exactly what it logged before.
    const entryLine = typeof candidate.meta.digRouteEntryLine === 'string' ? candidate.meta.digRouteEntryLine : null
    if (entryLine !== null) {
      host.logger.info(
        'agent',
        entryLine,
        {
          actionId: candidate.id,
          dir: typeof candidate.meta.digRouteBearing === 'string' ? candidate.meta.digRouteBearing : null,
          mode: typeof candidate.meta.digRouteEntryMode === 'string' ? candidate.meta.digRouteEntryMode : null,
          level: typeof candidate.meta.digRouteEntryLevel === 'number' ? candidate.meta.digRouteEntryLevel : null,
          floorBlock: typeof candidate.meta.digRouteEntryFloorBlock === 'string' ? candidate.meta.digRouteEntryFloorBlock : null,
          alternatives:
            typeof candidate.meta.digRouteEntryAlternatives === 'string' ? candidate.meta.digRouteEntryAlternatives : null,
        },
        host.tickCounter,
      )
    }
    // #436 section 17 for the entry: the same mirrored `SKILL_STEP` channel the bridge
    // uses, so the layer half (`authority=MANDATORY_PREREQUISITE` when the entry was the
    // only grounded remedy / `MECHANICAL_CONTINUATION` when Jev had alternatives) is
    // live-visible for the action the body actually took.
    const authorityLine = typeof candidate.meta.digRouteAuthorityLine === 'string' ? candidate.meta.digRouteAuthorityLine : null
    if (authorityLine !== null) {
      host.logger.info('agent', authorityLine, { actionId: candidate.id, step: 'wall_entry' }, host.tickCounter)
    }
  }

  /**
   * The settled dig route measured against the world: `from_d` is what the route
   * claimed when it was offered and `to_d` the live distance now. Emitted only
   * when the distance actually shrank, so "the distance strictly decreases as the
   * body advances" is a measured fact per action instead of an assumption.
   */

export function logDigRouteProgress(host: CandidateDiagnosticsHost, result: ExecutionResult, candidate: Candidate): void {
    const fromD = typeof candidate.meta.digRouteFrom === 'number' ? candidate.meta.digRouteFrom : null
    const targetText = typeof candidate.meta.digRouteTarget === 'string' ? candidate.meta.digRouteTarget : null
    if (fromD === null || targetText === null) return
    const parts = targetText.split(',').map((value) => Number(value))
    const [x, y, z] = parts
    if (x === undefined || y === undefined || z === undefined) return
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return
    const target = { x, y, z }
    // Measured on the SAME basis the offer used (the floored feet cell), so a
    // body that dug and did not change its cell can never be reported as having
    // advanced: a fractional position 0.5 blocks into the old cell must not read
    // as a distance gain.
    const feet = {
      x: Math.floor(host.bot.entity.position.x),
      y: Math.floor(host.bot.entity.position.y),
      z: Math.floor(host.bot.entity.position.z),
    }
    const toD = Math.round(distance(feet, target) * 100) / 100
    if (!(toD < fromD)) return
    host.logger.info(
      'agent',
      formatDigRouteProgress(fromD, toD, target, feet),
      {
        actionId: result.actionId,
        kind: result.kind,
        status: result.status,
        fromD,
        toD,
        target,
      },
      host.tickCounter,
    )
  }

  /**
   * The typed `DIG_ROUTE_REFUSED` facts for this tick's travel/enter/retrieve
   * targets that could be neither walked to nor dug toward. Deduped like the
   * column-descent refusal (one line per distinct cause), so the dead end is
   * stated (hazard / unbreakable / no support / open floor / protected / no tool /
   * no step / spent) instead of the offer silently collapsing to WAIT + ESCALATE.
   */

export function logDigRouteRefusals(host: CandidateDiagnosticsHost, refusals: readonly DigRouteRefusal[]): void {
    host.digRouteRefusalsThisTick = refusals.map((refusal) => ({ ...refusal }))
    const lines = refusals.map((refusal) => formatDigRouteRefused(refusal))
    const key = lines.length === 0 ? null : lines.join('|')
    if (key === host.lastDigRouteRefusalKey) return
    host.lastDigRouteRefusalKey = key
    if (key === null) return
    for (let index = 0; index < refusals.length; index += 1) {
      const refusal = refusals[index]
      if (refusal === undefined) continue
      host.logger.warn(
        'agent',
        lines[index] ?? formatDigRouteRefused(refusal),
        {
          reason: refusal.reason,
          target: refusal.target,
          bearing: refusal.bearing,
          cell: refusal.cell,
          block: refusal.block,
          detail: refusal.detail,
        },
        host.tickCounter,
      )
    }
  }


export function logDescendPlan(host: CandidateDiagnosticsHost, candidate: Candidate): void {
    const dir = typeof candidate.meta.dir === 'string' ? candidate.meta.dir : 'unknown'
    const mode = candidate.meta.mode === 'down' ? 'down' : 'level'
    const focus = typeof candidate.meta.focusItem === 'string' ? candidate.meta.focusItem : 'unknown'
    const depth = host.digMemory.dirCount + 1
    host.logger.info(
      'agent',
      `DIG_PATH dir=${dir} depth=${depth} target=${focus}`,
      { actionId: candidate.id, mode, dir, depth },
      host.tickCounter,
    )
    // The heading PLAN of the descent: held while the world offers a safe step
    // under it, changed only with the typed obstruction that forced it. Without
    // this line a heading change was invisible in the log (the measured
    // `W 23 | E 17 | N 12 | S 8` histogram over 60 steps).
    const headingLine = typeof candidate.meta.headingLine === 'string' ? candidate.meta.headingLine : null
    if (headingLine !== null) {
      const changed = candidate.meta.planHeadingHeld === false
      host.logger[changed ? 'warn' : 'info'](
        'agent',
        headingLine,
        {
          actionId: candidate.id,
          planHeading: typeof candidate.meta.planHeading === 'string' ? candidate.meta.planHeading : dir,
          headingChangeReason:
            typeof candidate.meta.headingChangeReason === 'string' ? candidate.meta.headingChangeReason : null,
          headingChangeCell:
            typeof candidate.meta.headingChangeCell === 'string' ? candidate.meta.headingChangeCell : null,
          headingChangeBlock:
            typeof candidate.meta.headingChangeBlock === 'string' ? candidate.meta.headingChangeBlock : null,
        },
        host.tickCounter,
      )
    }
    const digCells = typeof candidate.meta.digCells === 'string' ? candidate.meta.digCells : null
    if (digCells !== null) {
      host.logger.info(
        'agent',
        `DESCEND_PROFILE cells=${digCells} count=${String(candidate.meta.digCount ?? 1)} tool=${String(candidate.meta.profileTool ?? 'hand')}`,
        { actionId: candidate.id, digCells },
        host.tickCounter,
      )
    }
    const tunnel = host.digMemory.lastTunnel
    if (host.digMemory.dirCount > 0 && tunnel !== null) {
      host.logger.info('agent', `REUSE_TUNNEL at=${tunnel.x},${tunnel.y},${tunnel.z}`, { actionId: candidate.id }, host.tickCounter)
    }
    if (mode === 'down' && host.digMemory.dirCount === 0) {
      const from = Math.floor(host.bot.entity.position.y)
      const predicateY = host.queue.current?.kind === 'descend' ? host.queue.current.targetY : null
      const to = typeof predicateY === 'number' ? predicateY : (host.digMemory.knownStoneY ?? from - 8)
      host.logger.info('agent', `STAIRCASE from_y=${from} to_y=${to}`, { actionId: candidate.id }, host.tickCounter)
    }
  }



export function logStaleKnownResources(host: CandidateDiagnosticsHost,
state: WorldState): void {
  for (const resource of staleKnownResources(state)) {
    const at = `${resource.position.x},${resource.position.y},${resource.position.z}`
    const key = `${resource.name}@${at}`
    if (host.loggedStaleResources.has(key)) continue
    host.loggedStaleResources.add(key)
    host.logger.info(
      'agent',
      `KNOWN_RESOURCE_STALE item=${resource.name} at=${at}`,
      { item: resource.name, at },
      host.tickCounter,
    )
  }
  host.logKnownResourceVerdicts(state)
}


export function logKnownResourceVerdicts(host: CandidateDiagnosticsHost,
state: WorldState): void {
  for (const evidence of state.knownResourceEvidence ?? []) {
    const verdict = nextKnownResourceVerdict(host.knownResourceVerdicts, evidence)
    if (verdict.kind === 'falsified') {
      host.logger.warn(
        'agent',
        formatKnownResourceFalsified(evidence.item, evidence.name, evidence.position, verdict.reason),
        knownResourceVerdictDetail(evidence, verdict.reason),
        host.tickCounter,
      )
      continue
    }
    if (verdict.kind === 'resighted') {
      host.logger.info(
        'agent',
        formatKnownResourceResighted(evidence.item, evidence.name, evidence.position, verdict.source),
        knownResourceVerdictDetail(evidence, null),
        host.tickCounter,
      )
    }
  }
}


export function logCandidates(host: CandidateDiagnosticsHost,
candidates: readonly Candidate[], state: WorldState): void {
  const option = state.currentOption
  const sensorBlocks = state.blocks
    .filter((block) => block.kind === 'log' || block.kind === 'stone' || block.kind === 'ore')
    .map((block) => ({
      kind: block.kind,
      name: block.name,
      yield: block.yield ?? null,
      position: block.position,
      distance: block.distance,
      diggable: block.diggable,
      inReach: block.inReach,
      visible: block.visible ?? null,
      hasAdjacentStandable: block.hasAdjacentStandable,
      adjacentStandable: block.adjacentStandable,
    }))
    .sort((left, right) =>
      `${left.kind}|${left.name}|${left.position.x},${left.position.y},${left.position.z}`.localeCompare(
        `${right.kind}|${right.name}|${right.position.x},${right.position.y},${right.position.z}`,
      ),
    )
    .slice(0, 32)
  const signature = JSON.stringify({
    optionInstanceId: option?.instanceId ?? null,
    optionTemplateId: option?.templateId ?? null,
    allowedSkills: option?.allowedSkills ?? [],
    queueRevision: host.queue.revision,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      optionSkill: candidate.meta.optionSkill ?? null,
      prerequisiteRole: candidate.meta.prerequisiteRole ?? null,
      missingCapability: candidate.meta.missingCapability ?? null,
    })),
    sensorBlocks,
  })
  if (signature === host.lastCandidateSignature) return
  host.lastCandidateSignature = signature
  host.logger.info(
    'candidates',
    `generated ${candidates.length} executable candidate(s); skipped ${countBlockedLogs(state)} blocked log(s) (canDig=false, no walk-up access)`,
    {
      ids: candidates.map((candidate) => candidate.id),
      detail: candidates.map((candidate) => candidate.label),
      option: option === undefined || option === null
        ? null
        : {
            instanceId: option.instanceId,
            templateId: option.templateId,
            allowedSkills: [...option.allowedSkills],
            queueRevision: host.queue.revision,
          },
      candidateEvidence: candidates.map((candidate) => ({
        id: candidate.id,
        kind: candidate.kind,
        optionSkill: candidate.meta.optionSkill ?? null,
        prerequisiteRole: candidate.meta.prerequisiteRole ?? null,
        missingCapability: candidate.meta.missingCapability ?? null,
        capabilityAcquisition: candidate.meta.capabilityAcquisition === true,
        included: true,
        exclusionReason: null,
      })),
      sensorBlocks,
    },
    host.tickCounter,
  )
}


export function logFoodState(host: CandidateDiagnosticsHost,
candidates: readonly Candidate[], state: WorldState, options: CandidateOptions): void {
  const threshold = options.eatBelowFood
  const food = state.self.food
  const held = pickFood(state)
  const routes = candidates.filter((candidate) => typeof candidate.meta.foodRoute === 'string')
  const signature = [
    food,
    threshold,
    held ?? 'none',
    routes
      .map((candidate) => `${String(candidate.meta.foodRoute)}:${String(candidate.meta.foodTarget)}`)
      .sort()
      .join(','),
  ].join('|')
  if (signature !== host.lastFoodMarkerSignature) {
    host.lastFoodMarkerSignature = signature
    if (food <= threshold) {
      host.logger.info(
        'food',
        `FOOD_LOW food=${food} threshold=${threshold}`,
        { food, threshold, heldFood: held },
        host.tickCounter,
      )
    }
    if (held !== null && food > threshold) {
      host.logger.info(
        'food',
        // The reason lives in the MESSAGE, but the mirror (`mirroredEventToken`
        // + the host renderer) keeps only the first token and the detail object,
        // so `reason=full` never reached the run log: the observed line was
        // `EAT_REFUSED food=15 threshold=18`, indistinguishable from the
        // no_food case. The discriminator is carried in the detail too.
        'EAT_REFUSED reason=full',
        { food, threshold, heldFood: held, reason: 'full' },
        host.tickCounter,
      )
    }
    if (held === null && food <= threshold) {
      host.logger.info(
        'food',
        'EAT_REFUSED reason=no_food',
        { food, threshold, reason: 'no_food' },
        host.tickCounter,
      )
    }
    for (const candidate of routes) {
      host.logger.info(
        'food',
        `FOOD_ROUTE kind=${String(candidate.meta.foodRoute)} target=${String(candidate.meta.foodTarget)}`,
        {
          candidate: candidate.id,
          kind: candidate.meta.foodRoute,
          target: candidate.meta.foodTarget,
          // The SENSED source this route serves: the block for forage/acquire
          // (`oak_leaves`), the item for a cook/hunt. Without it the mirrored
          // line names the consumable but not what the body perceived.
          source: candidate.targetName ?? null,
          distance: candidate.meta.distance ?? null,
        },
        host.tickCounter,
      )
    }
  }

  // FOOD_ACQUIRED is an inventory delta, not a route fact. The first observed
  // tick only seeds the baseline; a pre-existing stack is not an acquisition.
  const current = new Map<string, number>()
  for (const [name, count] of Object.entries(state.inventory.counts)) {
    if (!isFoodItem(name)) continue
    current.set(name, count)
    if (host.lastFoodCounts === null) continue
    const previous = host.lastFoodCounts.get(name) ?? 0
    if (count > previous) {
      host.logger.info(
        'food',
        `FOOD_ACQUIRED item=${name} count=${count}`,
        { item: name, count, previous },
        host.tickCounter,
      )
    }
  }
  // FOOD_EATEN is a BODY-state delta, not a route fact: the tick where the live
  // hunger bar ROSE. It names the consumable that left the inventory, the food
  // change and the health at that moment, so "the body ate and its food rose"
  // is run evidence instead of an inference stitched from two other counters.
  // Read BEFORE `lastFoodCounts` is advanced, so the delta is the eaten item.
  const level = state.self.food
  if (Number.isFinite(level) && host.lastFoodLevel !== null && level > host.lastFoodLevel) {
    const eaten =
      [...(host.lastFoodCounts ?? new Map<string, number>()).entries()].find(
        ([name, count]) => (state.inventory.counts[name] ?? 0) < count,
      )?.[0] ??
      held ??
      null
    host.logger.info(
      'food',
      `FOOD_EATEN item=${eaten ?? 'unknown'} food=${host.lastFoodLevel}->${level} health=${state.self.health}`,
      {
        item: eaten,
        from: host.lastFoodLevel,
        to: level,
        health: state.self.health,
        threshold,
      },
      host.tickCounter,
    )
  }
  if (Number.isFinite(level)) host.lastFoodLevel = level
  host.lastFoodCounts = current
}


export function logLogRoute(host: CandidateDiagnosticsHost,
candidates: readonly Candidate[]): void {
  const route = logRouteOf(candidates)
  if (route === null) return
  const signature = `${route.mode}|${route.target.x},${route.target.y},${route.target.z}|${route.candidateId}`
  if (signature === host.lastLogRouteSignature) return
  host.lastLogRouteSignature = signature
  host.logger.info(
    'candidates',
    formatLogRoute(route),
    { mode: route.mode, target: route.target, candidateId: route.candidateId },
    host.tickCounter,
  )
}


export function logReachability(host: CandidateDiagnosticsHost,

  evaluated: readonly CandidateReachability[],
  withheld: readonly CandidateReachability[],
): void {
  for (const entry of evaluated) {
    const candidateId = entry.candidate.id
    const signature = `reach:${entry.result.reachable}|${entry.result.reason}|${entry.fingerprint}`
    host.logReachabilityOnce(candidateId, signature, !entry.result.reachable, entry)
  }
  for (const entry of withheld) {
    const candidateId = entry.candidate.id
    const signature = `withheld:${entry.result.reason}|${entry.fingerprint}|${entry.suppressed}`
    host.logReachabilityOnce(`withheld:${candidateId}`, signature, true, entry)
  }
}


export function logReachabilityOnce(host: CandidateDiagnosticsHost,

  key: string,
  signature: string,
  asWarning: boolean,
  entry: CandidateReachability,
): void {
  if (host.reachabilityLogSignatures.get(key) === signature) return
  host.reachabilityLogSignatures.set(key, signature)
  const target = {
    candidateId: entry.candidate.id,
    kind: entry.candidate.kind,
    position: entry.candidate.target,
    barrier: null,
  }
  const detail = {
    candidate: entry.candidate.id,
    kind: entry.candidate.kind,
    reachable: entry.result.reachable,
    reason: entry.result.reason,
    missing: entry.result.missingCapabilities.map(capabilityKey),
    fingerprint: entry.fingerprint,
    suppressed: entry.suppressed,
  }
  const line = formatReachability(target, entry.result)
  if (asWarning) host.logger.warn('agent', line, detail, host.tickCounter)
  else host.logger.info('agent', line, detail, host.tickCounter)
  if (entry.withheld) {
    host.logger.warn(
      'agent',
      formatCandidateWithheld(entry.candidate.id, entry.result.reason),
      detail,
      host.tickCounter,
    )
    const refusal = entry.candidate.meta.digAccessRefusal
    const block = entry.candidate.target
    if (block !== null && (refusal === 'no_interaction_stand' || refusal === 'no_path_to_stand')) {
      host.logger.warn('agent', formatDigAccessRetired(block, refusal), detail, host.tickCounter)
    }
    // THE ACQUISITION ROUTE for this withheld fact: which grounded candidate(s)
    // would remove the missing precondition, or - when nothing obtainable exists
    // - the typed reason naming the item and count. Emitted with the withhold so
    // the two facts can never be read apart.
    for (const acquisition of entry.acquisition ?? []) {
      const acquisitionDetail = { ...detail, acquisition }
      host.logger.warn(
        'agent',
        acquisition.routes.length > 0
          ? formatCandidateAcquisition(entry.candidate.id, acquisition)
          : formatCandidateAcquisitionRefused(entry.candidate.id, acquisition),
        acquisitionDetail,
        host.tickCounter,
      )
    }
    // THE STANCE REFUSAL, mirrored with the full geometry: the entity, the melee
    // constant, the nearest stance the search examined and the fact that refused
    // it. Without this the only evidence that the body could not hit the target
    // would be a 0-swing `out_of_reach` / `verify_failed` lease later.
    const stance = entry.candidate.attackStandRefusal
    if (entry.result.reason === 'no_attack_stand' && stance !== undefined) {
      host.logger.warn(
        'agent',
        formatNoAttackStand(stance),
        {
          ...detail,
          marker: NO_ATTACK_STAND,
          entityId: stance.entityId,
          refusal: stance.refusal,
          nearestStand: stance.nearest,
          stand: stance.stand,
          path: stance.path,
        },
        host.tickCounter,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Candidate starvation / marker / goal-precondition projections (moved from
// controller-legacy.ts). Pure transforms only: facts out, no authority.
// ---------------------------------------------------------------------------

export const MIRRORED_MARKERS: ReadonlySet<string> = new Set([
  // Issue #437: the two evidence planes must both be live-visible. Without these
  // in the mirrored list the live sink DROPS them, and a reviewer cannot
  // reconstruct what Jev knew (`JEV_STATE_PROJECTION`/`JEV_CANDIDATE_SET`), which
  // epoch allowed the Skill to act (`SKILL_COMMIT`), why Jev was asked again
  // (`JEV_DECISION_EPOCH_*`), what semantics came back (`SKILL_OUTCOME_PACKET`),
  // or that a late model result was rejected (`STALE_JEV_RESULT_DROPPED`).
  'JEV_DECISION_EPOCH_START',
  'JEV_STATE_PROJECTION',
  'JEV_CANDIDATE_SET',
  'JEV_DECISION_EPOCH_END',
  'SKILL_COMMIT',
  'SKILL_OUTCOME_PACKET',
  'STALE_JEV_RESULT_DROPPED',
  'JEV_HEADS',
  'BETA_SHADOW',
  'CAUSAL',
  'SHADOW_METRICS',
  'TOOL_CHOICE',
  // The EQUIP plane (P0 evidence gap, measured 2026-09-22): these five markers
  // were emitted only into the generation-local sink (`logs/jev/run.jsonl`), so
  // `buddy.log` showed ZERO equip lines for a run that actually armed the body 124
  // times (`EQUIP_WEAPON item=diamond_sword replaced=stone_pickaxe reason=combat`)
  // and wore armour twice. A post-mortem reading only `buddy.log` therefore
  // concluded "the body never equipped" - which is exactly the wrong conclusion,
  // because the measured death shape is "the body was NOT armed at that moment",
  // not "the equip path is dead". WHICH weapon/armour the body holds is a survival
  // fact; both planes must carry it.
  'EQUIP_WEAPON',
  'EQUIP_WEAPON_REFUSED',
  'EQUIP_ARMOR',
  'EQUIP_ARMOR_REFUSED',
  // The armour PRODUCER plane, the other half of the same survival fact: the
  // equip markers above can only ever report armour that EXISTS. Measured live
  // (NETHER-SURVIVAL-2026-09-22, the fatal window) the body carried iron and no
  // armour, so `armor=0/4` was true for the whole run and no layer said why the
  // body could not simply make some. `ARMOR_CRAFT` names the grounded craft step
  // (piece, material, count, candidate) and `ARMOR_CRAFT_REFUSED` names the exact
  // shortfall (`material=iron_ingot need=8 have=2 shortfall=6`), so a post-mortem
  // can tell "nothing was craftable" from "the route was never offered".
  'ARMOR_CRAFT',
  'ARMOR_CRAFT_REFUSED',
  'WEAPON_CHOICE_REQUIRED',
  // The damage-race plane: whether the body's grounded escape actually outruns the
  // damage it is taking, and the typed statement when NO grounded escape exists.
  // Without these in the live record the measured magma_cube death shape (health
  // 16.704 -> 8.316 -> dead in ~4 s while three RETREAT cells were on offer and
  // re-grounded onto cells that never broke contact) cannot be told apart from a
  // body that simply had nowhere to go.
  'SURVIVAL_DAMAGE_RACE',
  'SURVIVAL_ESCAPE_NONE',
  'QUEUE_DEPTH',
  'PLACE_REFUSED',
  'DIG_PATH',
  // A final mutation-boundary refusal that names when a claimed vertical or
  // dynamic route reached a cell still owned by a validated live structure.
  'LIVE_STRUCTURE_MEMBER_DIG_REFUSED',
  'JUMP_ATTEMPT',
  'JUMP_FAIL',
  'JUMP_ESCAPE',
  'DESCEND_LIMIT',
  'STAIRCASE',
  'REUSE_TUNNEL',
  'TUNNEL_ENTRY_REFUSED',
  'LOCAL_CLEAR',
  'ASCEND_STEP',
  'ASCENT_PROGRESS',
  // The HORIZONTAL-ENVELOPE plane: whether a swing was legal because the body's own
  // height spans the first part of an upward gap. Measured 2026-09-22: 19/19 live
  // blaze hunts ended `HUNT_END ... target=blaze swings=0 hits=0`, and the closest
  // geometry ever reached was `gap_y=4 horizontal=1.70` - a target the feet-to-feet
  // measure called out of range and the body's own upper half is 2.93 m from. A
  // swing grounded that way must be visible in the live plane, or it reads as an
  // ordinary close-range attack and the correction cannot be audited.
  'MELEE_VERTICAL_REACH',
  // The descent half of the vertical vocabulary: a refused local descent names
  // its missing precondition, and a durable descent chunk is run evidence
  // (a `descend_plan` refusal that was never named is what left the M3 body
  // standing above its own lit gate).
  'DESCENT_REFUSED',
  'DESCENT_CHUNK',
  // The WALL ENTRY (`wallEntry.ts`): the tunnel a body opens when every walk step
  // around it is refused. Without this in the mirrored list the live sink DROPS the
  // one line that says which wall was opened, on which heading, at which level, and
  // that no fluid could reach the pocket - and "the body mined the wall because the
  // pocket is provably dry" cannot be told apart from an ordinary tunnel step.
  'DIG_ROUTE_ENTRY',
  // #system2-compile: the queue-side half of the System2 hand-off must be visible
  // in BOTH evidence planes. `LLM plan applied` (and therefore the compiled rows it
  // names) exists only in the run log, so without this marker the one line that
  // says WHY a model answer became no row - its typed reason - is dropped from the
  // host log, and "the answer carried no goals" cannot be told apart from "the
  // answer was never applied".
  'SYSTEM2_PLAN_NO_GOALS',
  // The applied half of the same record: what the answer BECAME.
  'SYSTEM2_PLAN_APPLIED',
  // A Jev-selected escalation is only a successful handoff when this marker
  // names the concrete System2 request that accepted it; suppressed requests
  // use the same marker with `status=unavailable` and a typed blocker.
  'ESCALATE_HANDOFF',
  // The BOUNDED LEVEL SCAN (`levelScan.ts`): the descent a body takes when NOTHING at its
  // own level can ground a route and the rock below can. Without these in the mirrored
  // list the live sink DROPS the two lines that say which level the body descended to, which
  // lateral continuation and material the route ends at, the per-level flood verdict, and
  // the distance change - and a descent that is the first step of a route that ends closer
  // cannot be told apart from a blind search descent.
  'LEVEL_SCAN',
  'LEVEL_SCAN_STEP',
  'PORTAL_ENTRY_UNVERIFIED',
  // The bounded direct walk into a non-solid portal cell: the live run needs
  // both the measured motion (`PORTAL_WALK_IN ... transferred=`) and the typed
  // pre-movement refusal, or its log cannot tell "walked in" from "never tried".
  'PORTAL_WALK_IN',
  'PORTAL_WALK_IN_REFUSED',
  // The step-aside onto an open face of the portal: the detour must be visible
  // in the run log, or "the body refused to step one block aside" cannot be
  // told apart from "no leg was ever grounded".
  'PORTAL_APPROACH_LEG',
  'PORTAL_APPROACH_REFUSED',
  // The COMPOSED entry climb: an interior above the body beyond the walk-in
  // tolerance is reached by the candidate's own grounded vertical contract, and
  // the live run needs both halves of its evidence. Without `PORTAL_ENTRY_CLIMB`
  // the live sink DROPS the line naming which climb ran, its own bound and its
  // outcome - and `SKILL_POLICY_BOUNDARY ... alternatives=[vertical:reuse(spent)]`
  // (run.jsonl 2026-09-22T15:47:37Z) cannot be told apart from a climb that was
  // really attempted. Without `PORTAL_ENTRY_CLIMB_REFUSED` the run shows only the
  // bare `not_level` walk-in refusal and hides the interior's height and the
  // climb that was (or was not) available.
  'PORTAL_ENTRY_CLIMB',
  'PORTAL_ENTRY_CLIMB_REFUSED',
  // The COMPOSED entry route's HORIZONTAL half (the same trial, second half): the
  // crossing leg places the floor of the void between the body's ledge and the
  // floated gate. It is grounded in the candidate layer
  // (`candidates.ts#entryCandidates`) and executed as ONE bounded `runBridgeLeg`
  // chunk, so this line is the entry route's own summary of WHICH span it declared
  // (direction, span, first placement cell, first landing) and WHAT the leg did.
  // `outcome=advanced` (the body moved onto the floor it placed) is deliberately
  // distinct from `outcome=placed` (a block exists but the body did NOT advance):
  // the previous lane's fixture proved a placement without a proven advance, and
  // that distinction is the whole point of this half. The per-step placements stay
  // on the existing mirrored `BRIDGE_*` markers; without this line the live sink
  // DROPS the entry-route summary and a reviewer cannot tell a crossing that ran
  // from one that was never grounded.
  'PORTAL_ENTRY_CROSS',
  // Issue #436: the Skill boundary and the reflex proof must both be live-visible,
  // or a reviewer cannot tell "Jev chose the target" from "code finished it".
  'SKILL_START',
  'SKILL_COMMIT',
  'SKILL_STEP',
  'SKILL_INTERRUPT',
  'SKILL_POLICY_BOUNDARY',
  'SKILL_END',
  'REFLEX',
  'PORTAL_WALK_IN_BLOCKED',
  SKILL_POLICY_BOUNDARY,
  'PILLAR_UP',
  'PILLAR_UP_STEP',
  'PILLAR_FAIL',
  'PILLAR_TAKEOFF',
  'PILLAR_SEARCH',
  // The typed PILLAR_UP step refusals (`verticalPlan.ts` `formatPillarRefused`).
  // Without this in the mirrored list the run log keeps only the opaque action
  // outcome and DROPS the line that names the cell, the obstacle and the cause -
  // so "this column could never be climbed" cannot be told apart from "the climb
  // was never attempted".
  'PILLAR_REFUSED',
  'HOP_PLAN',
  'DESCEND_STALLED',
  'DESCEND_PROGRESS',
  'DESCEND_NO_PROGRESS',
  'DIG_OSCILLATE',
  'MOVE_OSCILLATE',
  // The per-step landing guard (`stepLanding.ts`): a locomotion leg that stopped
  // BEFORE a lethal step must be visible in the run log, or "the body stopped at
  // the walkway edge" cannot be told apart from "the leg never ran" - the live
  // fortress death (`ENV_HAZARD kind=lava` -> `ENV_HAZARD_NO_EXIT` -> DEATH) was
  // a fall the leg took with no typed line at all.
  MOVE_LEG_STOPPED,
  'MOVE_FAILMEM',
  'MOVE_FAILMEM_RESET',
  'MOVE_TARGET_SKIPPED',
  // The cross-action bound on one action's own bounded outcome repeating
  // identically at one target. These three ARE the escalation, so they belong in
  // the live record: the sibling `ACTION_FAILURE_REPEAT`/`ACTION_FAILURE_EXHAUSTED`
  // pair was emitted with `logger.warn('agent', ...)` but never mirrored, and the
  // measured run shows `ACTION_FAILURE_REPEAT=0` / `ACTION_FAILURE_EXHAUSTED=0`
  // in 1.34M lines while one cell was re-issued 161 times. An unmirrored
  // escalation is an escalation no reader and no gate can see.
  ACTION_REPEAT_MARKER,
  ACTION_REPEAT_EXHAUSTED_MARKER,
  ACTION_TARGET_RETIRED_MARKER,
  'OSCILLATION_DETECTED',
  'RETURN_TO_KNOWN_RESOURCE',
  'RETRIEVE_STALLED',
  'LOCAL_RETRIEVAL_STALL',
  'LOCAL_RETRIEVE_RECOVERY',
  'LOCAL_DESCEND_STALL',
  'LOCAL_OSCILLATION_ESCAPE',
  'LOCAL_PROGRESS_STALL',
  'LOCAL_MOVE_OSCILLATION',
  'LOCAL_WAIT_RECOVERY',
  'KNOWN_RESOURCE_STALE',
  'KNOWN_RESOURCE_FALSIFIED',
  'KNOWN_RESOURCE_RESIGHTED',
  'KNOWN_RESOURCE_RETIRED',
  SKILL_END,
  SKILL_INTERRUPT,
  'EXPLORE',
  'REPLAN_THROTTLED',
  'REPLAN_REJECTED',
  'CAPABILITY_GAP',
  'LOCAL_CAPABILITY_GAP',
  'CAPABILITY_GAP_POLICY',
  'CAPABILITY_GAP_CLEARED',
  'RETURN_TO_SURFACE',
  'PRECONDITION_PROTECTED',
  'PLACE_RETRY',
  // Bounded-attempt terminal + typed frame-build causes are run-scoped
  // acceptance evidence: they prove the option was retired and the frame build
  // failed ONCE with a named cause instead of looping on `verify_failed`.
  'PLACE_RETRIES_EXHAUSTED',
  'FRAME_BUILD_INCOMPLETE',
  'FRAME_BUILD_UNGROUNDED',
  'FRAME_BUILD_BLOCKED',
  'PORTAL_FRAME_SITE_REJECTED',
  'PORTAL_FRAME_CELL_CLEARED',
  // Drowning is a P1 durability failure (DEATH ... cause=water, 2026-09-21
  // 16:59:34.792Z). The sensor fact and the scheduler preempt must be on the
  // mirrored event path so a body losing breath is run-scoped evidence rather
  // than only a line in the executor log.
  'BODY_SUBMERGED',
  'LOW_AIR_PREEMPT',
  // SAFE: the body's own environmental hazard (fire/lava/burning/drowning).
  // Measured live (`run-mucaq28q-1ftq1`) the body burned to death in the Nether
  // with ZERO lines naming fire, lava or burning, so these must be on the
  // mirrored path a post-mortem reads. (`REFLEX` / `SKILL_INTERRUPT` are already
  // above: one #436 vocabulary, owned by `netherPortalPlan.ts`.)
  ENV_HAZARD,
  ENV_HAZARD_NO_EXIT,
  ENV_HAZARD_CLEAR,
  'ABANDON_REASON',
  'ABANDON_REASON=retrieve_unverified',
  'PREREQ_OPTION',
  'PREREQ_RANK_SHADOW',
  'PREREQ_SWITCH',
  // OPERATOR RULE (station-use-before-craft): the smelt prerequisite withheld a
  // duplicate station craft because a usable station of that kind already
  // exists. Keep the typed fact on the mirrored event path so a run proves the
  // duplicate was refused for a named reason instead of merely being absent.
  PREREQ_STATION_ALREADY_KNOWN,
  'FURNACE_READY',
  'STATION_REGISTERED',
  // The container capability's evidence. A container interaction is otherwise
  // invisible in the run log: without these literals an OPEN that read a chest,
  // a transfer that took an item, a typed refusal (unreachable / occluded /
  // open_timeout / empty / contents_changed / no_room), and a verified shulker
  // placement that became a durable world fact would all be DROPPED by the
  // mirroring sink, and a reviewer could not tell "the box was opened" from
  // "the body never went near it".
  'CONTAINER_OPEN',
  'CONTAINER_EMPTY',
  'CONTAINER_TRANSFER',
  'CONTAINER_REFUSED',
  'CONTAINER_READY',
  'SMELT_DONE',
  'SMELT_INPUT_PREREQ',
  // The craft arm's OWN outcome evidence. Both transform arms are now on the
  // mirrored path: `SMELT_DONE` proves "smelt an input" and `CRAFT_DONE` proves
  // "obtain a tool" from the verified inventory delta. Without them the M2
  // chain's pickaxe crafts had no typed line in the run-scoped artifact at all.
  'CRAFT_DONE',
  'CRAFT_FAILED',
  'CRAFT_INGREDIENT_PREREQ',
  CRAFT_STATION_ALREADY_KNOWN,
  // Portal milestones are run-scoped acceptance evidence as well as human
  // diagnostics. Keep them on the same mirrored event path so the host-owned
  // M2 snapshot recorder receives the structured detail object; reconstructing
  // these markers from the all-time JSONL would lose run/generation authority.
  'PORTAL_SUPPORT_PLACED',
  'PORTAL_BLOCK_PLACED',
  'PORTAL_FRAME_READY',
  'PORTAL_LIT',
  'PORTAL_VERIFIED',
  'PORTAL_LIGHT_REFUSED',
  'OSCILLATION_DETECTED',
  'ABANDON_REASON=action_unverified',
  'ACTION_UNVERIFIED',
  ACTION_REJECTED,
  // The route-family vocabulary is run-scoped evidence: a settled route stage
  // failure, the exact route it spends, and a goal whose grounded routes are all
  // spent. Measured live (run-muc620xb-1d312) the recorder DID write
  // `ACTION_ZERO_PROGRESS ... kind=ENTER_PORTAL retry=1..20`, but the marker was
  // not mirrored, so the resident log showed zero of them and the frozen route
  // looked like a route that was never spent. Keep every existing route marker
  // here too (`ACTION_ZERO_PROGRESS`, the retirements, the approach leg) so the
  // next measurement reads the same facts the runtime acted on.
  'ROUTE_STAGE_FAILED',
  'ROUTE_SPENT',
  'ROUTE_ESCALATE',
  'ACTION_ZERO_PROGRESS',
  'DESCEND_RETIRED',
  'RETRIEVE_RETIRED',
  'RETRIEVE_ROUTE_BLOCKED',
  'APPROACH_LEG',
  // #predicate-retire: a row retired because its OWN success predicate already
  // held in world truth is a DONE decision, and the queue transition it causes
  // (the head moving to the next row) is exactly what the measured M3 blocker
  // turned on. Unmirrored it would be invisible in `buddy.log`: the run would
  // show a queue that silently advanced from an M2 row to the `blaze_rods` work
  // with no named reason.
  GOAL_RETIRED_PREDICATE,
  GOAL_SUCCESS_PROBE_ERROR,
  // The dig-route family: the target a travel/enter/retrieve goal could not walk
  // to, the bounded terrain route the offer grounded toward it, the typed cause
  // when even that could not be grounded, and the measured distance gain of a
  // settled dig step. A body sealed in its own shaft produced none of these
  // before (measured run-muc9k936-1f3vb: `presented=['WAIT','ESCALATE']` for
  // minutes while the known gate sat 21 blocks away), so the whole route family
  // must be observable run-scoped.
  'DIG_ROUTE',
  'DIG_ROUTE_REFUSED',
  'DIG_ROUTE_PROGRESS',
  // The BRIDGE/scaffold family (`bridgeRoute.ts`): the leg that places a floor
  // across a same-level gap and advances onto it, its per-step mechanic, its typed
  // end, and the typed reason a needed bridge was refused. A bridge that reaches
  // `buddy.log` only as a `MOVE` would be indistinguishable from an ordinary walk,
  // and the #436 section 5 effect (`mayPlaceBlocks` + the consumed block) would not
  // be auditable run-scoped.
  'BRIDGE_START',
  'BRIDGE_STEP',
  'BRIDGE_END',
  'BRIDGE_REFUSED',
  // The DOWNWARD SELF-LANDING family (`descentScaffold.ts`): the same bridge leg
  // rotated one level down - the body lays the floor of the cell under its own feet
  // and drops onto it. Same registration reason as the bridge: a descent that
  // reached `buddy.log` only as a `DESCEND` would be indistinguishable from a
  // staircase dig, and the #436 section 5 effect (the one block consumed, and the
  // one cell placed BELOW the body) would not be auditable run-scoped. Measured
  // need: 1912 `needs_descend` acquisitions carrying the correct
  // `descend_plan:no_support@25,78,-2:air` and no route able to answer it.
  'DESCEND_SCAFFOLD_START',
  'DESCEND_SCAFFOLD_STEP',
  'DESCEND_SCAFFOLD_END',
  'DESCEND_SCAFFOLD_REFUSED',
  // A locomotion route's OWN placement declaration (`routePlaceDeclaration.ts`).
  // The measured defect (live: `PILLAR_UP actionId=MOVE:b35_60_-26 ... failed
  // SKILL_ENVELOPE_VIOLATION violation=equip_item_not_declared:cobblestone`, and
  // the sibling `RETRIEVE:known:blaze_rod:b35_60_-22`) is a route that places a
  // block its commitment refused to let it equip. The fix authorizes exactly the
  // block(s) the route DECLARED at candidate time, so which block that was, which
  // meta key declared it, and whether it was actually carried must be readable
  // run-scoped - otherwise a reviewer sees only a different
  // `SKILL_COMMIT effectEnvelopeHash=` with no named cause. Unmirrored markers
  // never reach `buddy.log`, so this one is registered next to its family.
  'ROUTE_PLACE_DECLARED',
  // #436 reflex/continuation vocabulary: a bounded mechanical continuation that is
  // the UNIQUE binding prerequisite of the active leg (`REFLEX
  // reason=unique_binding_prerequisite`) and the mechanical step when it runs.
  'REFLEX',
  'SKILL_STEP',
  'SKILL_POLICY_BOUNDARY',
  'REACHABILITY',
  'CANDIDATE_WITHHELD',
  // The acquisition half of the withhold: WHEN a withheld candidate's missing
  // mechanical fact was answered by a grounded acquisition route, and - when none
  // exists - the typed reason with the item and count the body would need. The
  // measured freeze (main 38cbb22) was readable only as `CANDIDATE_WITHHELD
  // ... missing=[headroom@27,62,15]` plus `CANDIDATE_STARVATION
  // blockedBy=no_productive_action`: no line said whether the tool that clears the
  // cell was craftable from what the body carried, or that nothing obtainable
  // existed. These two markers are that fact, on both evidence planes.
  'CANDIDATE_ACQUISITION',
  'CANDIDATE_ACQUISITION_REFUSED',
  'CANDIDATE_STARVATION',
  'RESOURCE_SOURCE_NONE',
  // The M3 producer side of the same observability rule. A pearl need with no
  // sensed enderman produced MOVEs and nothing else in the run log: no marker
  // named the need, its producer mob, the absence of any sensed instance, or the
  // grounded search the tick was offering. `MOB_DROP_SOURCE_NONE` is that fact.
  'MOB_DROP_SOURCE_NONE',
  // A hunt is a bounded Skill; how it ended is run-scoped evidence, not a
  // private executor line. The measured live shape (an enderman that left the
  // tracked set before the first swing) reached only `status=failed`, so the
  // mechanical cause was unrecoverable from the log.
  'HUNT_END',
  'HUNT_RETARGET',
  'HUNT_TARGET_LOST',
  'HUNT_REACQUIRE_EXHAUSTED',
  // The HOVER half of the same vocabulary. Every measured blaze hunt ended
  // `HUNT_END ... reason=out_of_range swings=0 hits=0`, which reads as a failed
  // attempt; the mechanical cause was that a producer hovering above the walkway
  // has a vertical contact component no walk can express. A target the body's melee
  // envelope provably cannot be brought onto is now a NAMED fact (the contact
  // geometry, the vertical planner's own refusal, and the carried block a pillar
  // would consume), so unreachable and merely-missed are distinct run evidence.
  'HUNT_CONTACT_UNREACHABLE',
  // The HORIZONTAL/STANCE half of the same vocabulary, the one the operator's
  // screenshot was made of: a hostile in contact but embedded in geometry (line of
  // sight fails from every stance) or a hostile no stance within melee reach can be
  // walked to (the measured enderman at 6.11 m, distance frozen ~47 s, ZERO
  // swings). `NO_ATTACK_STAND` names the entity, the melee constant, the nearest
  // stance the search examined and the fact that refused it, so the withhold is
  // run evidence instead of a later 0-swing `out_of_reach` / `verify_failed` lease
  // that only LOOKS like a failed attempt.
  'NO_ATTACK_STAND',
  // The DROP half of the same vocabulary. A killed mob leaves an item ENTITY on
  // the ground, and the only thing that proves the kill produced anything is the
  // inventory delta after walking onto it. Without these two markers a run that
  // killed a blaze and then failed to collect the rod is indistinguishable, in
  // the run log, from one that never killed anything: `blaze_rod 0` with no
  // explanation. Positive (`PICKUP_ACQUIRED`) and typed-negative
  // (`PICKUP_NOT_ACQUIRED`) are separate, mirrored facts.
  'PICKUP_ACQUIRED',
  'PICKUP_NOT_ACQUIRED',
  // Starvation is a run-scoped survival fact, not a private diagnostic. The
  // measured live failure (run-muc0l5fp-158ak: `food=0` for the whole run, the
  // body pinned at the server's 1 HP starvation floor) emitted BODY_STARVING and
  // FOOD_LOW to the generation console only, because neither token rode the
  // mirrored event path - the run log showed a body doing heavy work with no
  // visible reason. Keep the whole hunger vocabulary mirrored so the state, the
  // refusal, the grounded route and the bounded dead end are all run evidence.
  'BODY_STARVING',
  'CRITICAL_DAMAGE',
  'CRITICAL_DAMAGE_EXHAUSTED',
  // Mob-fight state is run-scoped survival evidence, exactly like the hunger and
  // critical-damage vocabulary above. Measured live (run-muc3qbug-18vg3): the
  // body died in the Nether 18 s after arriving, and `THREAT_NEARBY` - which
  // names the mob, its distance, contact/danger, the code-owned weapon and
  // whether the body can regenerate - had been written 8 times to the
  // generation event stream but NEVER to buddy.log (0 occurrences in 71 MB),
  // because none of the threat tokens rode the mirrored event path. A
  // post-mortem of the death window therefore could not see that a spider was
  // inside melee contact. Keep the whole threat vocabulary, plus the
  // survival-regrounding pair, on the mirrored path.
  THREAT_NEARBY,
  THREAT_NO_ESCAPE,
  THREAT_CLEAR,
  SURVIVAL_REGROUND,
  SURVIVAL_NO_GROUNDED_ACTION,
  // The bounded identity-churn adoption (`threat.ts`): the one line that says a
  // chosen ATTACK's entity id was replaced by the SAME mob kind at the SAME place
  // while the body kept fighting it. Unmirrored, a reviewer sees only
  // `SURVIVAL_REGROUND`/`TARGET_LOST` and cannot tell a churn fight from a threat
  // that genuinely died, so the identity proof must ride the live sink.
  MOB_IDENTITY_CHURN,
  GUARD_REJECTIONS,
  'COMBAT_KIT_GAP',
  THREAT_RANGED_UNANSWERED,
  THREAT_BREAK_CONTACT,
  DEATH_CAUSE,
  'FOOD_LOW',
  'EAT_REFUSED',
  'FOOD_ROUTE',
  'FOOD_ACQUIRED',
  'FOOD_EATEN',
  FOOD_SOURCE_NONE,
  'LOG_ROUTE',
  'WEDGE_SUPPRESSED',
  PROTECTION_ABANDON_CONFLICT,
  CANDIDATE_FLAP,
  CANDIDATE_COMMIT_RELEASED,
  ACTION_COMMIT,
  ACTION_PREEMPT,
  WAIT_STREAK_MARKER,
  WAIT_EXHAUSTED_MARKER,
  BETA_ABANDON_DEFERRED_MARKER,
  BETA_ABANDON_RELEASED_MARKER,
  'BETA_DEFERRED',
  // Issue #436 section 17: three evidence lines were EMITTED but never mirrored, so the live
  // sink dropped them and a reviewer saw only the downstream outcome (`failure=effect_envelope_violation`
  // without WHICH effect or WHY). The envelope refusal is the fail-closed boundary itself, and the
  // invalidation/selection lines are the rest of the commitment lifecycle; all three belong in the
  // live record.
  'SKILL_ENVELOPE_VIOLATION',
  'SKILL_INVALIDATED',
  'SKILL_SELECTED',
  // #plan-reconciliation: the objective-identity reconciliation and the bounded
  // cross-dimension escalation. Unmirrored markers never reach buddy.log, which
  // is how the measured `g1:descend:raw_iron`-while-in-the-Nether stall stayed
  // invisible: the row's own predicate was unsatisfied, so no existing boundary
  // had anything to say about it.
  PLAN_IDENTITY_CHANGED,
  PLAN_ROW_RETIRED,
  PLAN_HEAD_REPLACED,
  'PLAN_IDENTITY_ADOPTED',
  'PLAN_IDENTITY_UNAVAILABLE',
  ROW_NOT_EXECUTABLE_HERE,
  ROW_DEFERRED_NOT_EXECUTABLE_HERE,
  'NO_PRODUCTIVE_HEAD_BOUND',
  'NO_PRODUCTIVE_HEAD_WINDOW',
  'ROW_NOT_EXECUTABLE_HERE_REPEATS',
  'ROW_NOT_EXECUTABLE_HERE_BINDING',
  'ROW_NOT_EXECUTABLE_HERE_BINDING_SKIPPED',
  'ROW_NOT_EXECUTABLE_HERE_INTERRUPT',
  'PLAN_HEAD_REPLACEMENT_APPLIED',
  // The equip plane was emitted but never mirrored, so `buddy.log` showed ZERO equip lines while the run-scoped
  // JSONL showed 124x EQUIP_WEAPON and 2x EQUIP_ARMOR. Measured consequence: a reader of the LIVE log concluded the
  // body was unarmed when it had in fact re-armed, and the inverse case - "Jev never chose ATTACK, so the weapon was
  // never drawn" - was invisible in the one log the runtime writes. The equip facts are how a survival question is
  // settled, so they belong in the live record like every other lifecycle line.
  'EQUIP_WEAPON',
  'EQUIP_ARMOR',
  // The System2 summon payload's SHAPE. The model's WHAT decision is only as
  // good as the state it is given, and the measured live loop (208 queue rows
  // for one objective, `CANDIDATE_WITHHELD`/`CANDIDATE_STARVATION` typing the
  // real blocker while the summoned payload carried none of it) was invisible in
  // the run record: a summon line showed a reason and a queue depth, never what
  // facts the model actually received. These three markers are counts-only (no
  // world-derived string is interpolated into the line), so they ride the
  // mirrored sink and a world name cannot forge a field or a second marker.
  SYSTEM2_PAYLOAD,
  SYSTEM2_PAYLOAD_REFUSED,
  SYSTEM2_PAYLOAD_ABSENT,
  // V4 Reach owns a committed navigation predicate across many mechanical
  // actions. These events carry contract identity and typed causal evidence.
  // The generation event sink binds run/generation/source identity to each
  // mirrored detail; without registration these exist only in shared run JSONL.
  'VTR_DUAL_AUTHORITY_FENCE',
  'VTR_REACH_ROUTE_DECISION',
  'VTR_MISSION_SNAPSHOT_REFUSED',
  'VTR_TERMINAL_HANDOFF_REFUSED',
  'VTR_RISK_OBSERVED',
  'VTR_TRANSITION_PROGRESS',
  'VTR_REACH_GUARD_REFUSED',
  'VTR_RUNTIME_INTENT_REFUSED',
  'VTR_EXECUTOR_CLAIM_REFUSED',
  'VTR_INTENT_RELEASE_REFUSED',
  'VTR_CONTROLLER_TICK_REFUSED',
  'VTR_RISK_OBSERVATION_REFUSED',
  'VTR_COMPLETION_REFUSED',
  'VTR_MECHANICAL_OUTCOME_REFUSED',
  'VTR_VERIFY_JOURNAL_REFUSED',
  'VTR_ROUTE_SELECTION_REQUIRED',
  'VTR_TRANSITION_ACTUATION',
  'VTR_ACTION_COMPLETION_HANDLER_FAILED',
  'VTR_SCHEDULER_HOLDS_NO_ADMISSIBLE_ROUTE',
  'VTR_SCHEDULER_HOLDS_TERMINAL',
  'VTR_REACH_PROBE_HOLD',
  'VTR_TRANSITION_COMMIT',
  'VTR_TRANSITION_MODEL_METRICS',
  'VTR_MECHANICAL_STEP_REFUSED',
  'VTR_MECHANICAL_STEP_RESERVED',
  'VTR_MECHANICAL_STEP_OUTCOME',
  'VTR_MECHANICAL_OUTCOME_REJECTED',
  'VTR_ORPHAN_ACTION_OUTCOME',
  'VTR_MECHANICAL_OUTCOME',
  'VTR_TERMINAL_ACTION_CORRELATED',
  'VTR_TERMINAL_ACTION_SETTLEMENT_MISMATCH',
  'VTR_TERMINAL_ACTION_CORRELATION_REFUSED',
  'VTR_TRANSITION_VERIFY',
  'VTR_TRANSITION_OUTCOME',
  'VTR_LEGACY_REACH_MOVE_WITHHELD',
  'VTR_LEGACY_REACH_HANDOFF',
  'VTR_REACH_AUTHORITY_REVOKE',
  'VTR_MISSION_RUNTIME_HOLD',
  'VTR_ORPHAN_ACTUATION_REVOKED',
  'VTR_SAFETY_TRIGGER_STALE',
  'VTR_MISSION_RUNTIME_TRANSITION_REFUSED',
])

export function mirroredEventToken(message: string): string | null {
  const token = message.split(' ')[0]
  if (token === undefined) return null
  if (token.startsWith('PORTAL_VERIFIED=')) return 'PORTAL_VERIFIED'
  return MIRRORED_MARKERS.has(token) ? token : null
}

/**
 * Starvation marker: the candidate set offered to the policy has no productive
 * option, so the only possible answers are WAIT/ESCALATE. `NO_PRODUCTIVE_CANDIDATE`
 * already warned about this, but it was not a mirrored marker, so it never
 * surfaced as the binding condition. Pure and exported so the contract is
 * unit-testable without a bot.
 *
 * The line has exactly one meaning per field:
 *   - `blockedBy` is the CURRENT GOAL's own deterministic blocker (its unmet
 *     precondition, else its own target's refusal reason, else
 *     `no_productive_action`). It is never a withheld sibling's reason.
 *   - `missing` is the ordered, bounded union of each withheld candidate's
 *     missing capability, tagged with that candidate's id:
 *     `["MINE:b40_10_33:tool:pickaxe@0","RETRIEVE:known:x:needs_ascend"]`.
 */
export function formatCandidateStarvation(
  presented: number,
  goal: string,
  blockedBy: string,
  missing: readonly string[] = [],
): string {
  const all = missing.length > 0 ? ` missing=${JSON.stringify(missing)}` : ''
  return `CANDIDATE_STARVATION presented=${presented} productive=0 goal="${goal}" blockedBy=${blockedBy}${all}`
}

export function candidateStarvationLine(
  candidates: readonly Candidate[],
  goal: string,
  goalComplete: boolean,
  blockedBy: string,
  missing: readonly string[] = [],
): string | null {
  if (goalComplete) return null
  const productive = candidates.some((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')
  return productive ? null : formatCandidateStarvation(candidates.length, goal, blockedBy, missing)
}

/** Upper bound on the `missing=[...]` union so the marker stays one readable line. */
export const MAX_STARVATION_MISSING = 8

/**
 * Each withheld candidate's missing capability, in candidate order, each token
 * tagged with its candidate id (`<candidateId>:<capability>`). A candidate whose
 * refusal names no capability contributes its reason instead, so no withheld
 * target is silently dropped. Deduped and bounded (`MAX_STARVATION_MISSING`) so
 * the list stays a stable, readable ordered set.
 */
export function candidateStarvationMissing(
  withheld: readonly CandidateReachability[],
  limit: number = MAX_STARVATION_MISSING,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of withheld) {
    const capabilities = entry.result.missingCapabilities.map(capabilityKey)
    const labels = capabilities.length > 0 ? capabilities : [entry.result.reason]
    for (const label of labels) {
      const token = `${entry.candidate.id}:${label}`
      if (seen.has(token)) continue
      seen.add(token)
      out.push(token)
      if (out.length >= limit) return out
    }
  }
  return out
}

/**
 * The typed TOOL truth behind a set of withheld candidates.
 *
 * Reachability already names a tool requirement on some capabilities
 * (`{kind:'tool', tool, tier}` from `missing_tool`, and
 * `{kind:'safe_column', reason:'no_tool', tool, tier}`). Those are the only
 * places the code ever states "a tool of family F at rank T is required", so
 * they are the only places this projection reads: it pairs each such
 * requirement with the body's own held rank (`bestToolTier`, the same scale
 * `capabilityKey` prints) and reports the requirement whenever the body does
 * not hold enough.
 *
 * Deliberately does NOT infer a tool need the reachability layer did not state
 * (e.g. a `headroom@x,y,z` capability names a cell, not a tool): inventing that
 * pairing here would be a deterministic domain rule masquerading as a measured
 * fact, and the model would be told a requirement code never established.
 *
 * Facts only; it refuses nothing and recommends nothing.
 */
export function withheldToolGaps(
  withheld: readonly CandidateReachability[],
  inventory: Readonly<Record<string, number>>,
): System2ToolGap[] {
  const out: System2ToolGap[] = []
  const seen = new Set<string>()
  for (const entry of withheld) {
    for (const capability of entry.result.missingCapabilities) {
      let tool: HarvestTool | null = null
      let requiredTier = 0
      if (capability.kind === 'tool') {
        tool = capability.tool
        requiredTier = capability.tier
      } else if (capability.kind === 'safe_column' && capability.reason === 'no_tool' && capability.tool !== null) {
        tool = capability.tool
        requiredTier = capability.tier ?? 0
      }
      if (tool === null) continue
      const heldTier = bestToolTier(inventory, tool)
      if (heldTier >= requiredTier) continue
      const key = `${tool}@${requiredTier}:${entry.candidate.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ tool, requiredTier, heldTier, candidate: entry.candidate.id })
    }
  }
  return out
}

/** True when a withheld candidate is a route for `item` itself (not a sibling). */
function candidateTargetsItem(candidate: Candidate, item: string): boolean {
  if (candidate.targetName === item) return true
  if (candidate.itemName === item) return true
  const known = candidate.meta.knownName
  return typeof known === 'string' && known === item
}

/**
 * The single reason the STARVED GOAL has no productive candidate, derived only
 * from the goal's own deterministic state: an unmet compiled precondition, else
 * the refusal reason of the goal's OWN route candidate (a withheld candidate
 * whose target is the goal's target item), else `no_productive_action`. A
 * withheld candidate for some other target (a prerequisite, a sibling) must
 * never leak into `blockedBy` - it belongs in `missing` tagged with its id.
 */
export function goalStarvationBlockedBy(
  preconditionCause: string | null,
  goal: Pick<QueuedGoal, 'kind' | 'targetItem'> | null,
  withheld: readonly CandidateReachability[],
): string {
  if (preconditionCause !== null) return preconditionCause
  if (goal === null || goal.kind !== 'collect') return 'no_productive_action'
  const target = goal.targetItem
  if (target === null) return 'no_productive_action'
  const own = withheld.find((entry) => candidateTargetsItem(entry.candidate, target))
  return own?.result.reason ?? 'no_productive_action'
}

function isProductiveCandidate(candidate: Candidate): boolean {
  return candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE'
}

/**
 * The starvation contract's actionable-goal clause: if the current goal is a
 * craft whose recipe inputs are held, the offered set must contain a productive
 * candidate. The candidate gate already runs this ladder, but it runs before the
 * controller's own filters (move-failure memory, furnace prerequisite), so the
 * last productive candidate can be removed afterwards. This backfills the
 * deterministic self-contained craft step for the current craft goal only when
 * nothing productive survives, so `productive` is > 0 and no starvation line is
 * emitted for a craftable goal.
 */
export function ensureCraftStepActionable(
  state: WorldState,
  candidates: readonly Candidate[],
  options: CandidateOptions,
): Candidate[] {
  if (candidates.some(isProductiveCandidate)) return [...candidates]
  const current = state.goalQueue?.current ?? null
  if (current === null || current.kind !== 'craft') return [...candidates]
  const seen = new Set(candidates.map((candidate) => candidate.id))
  const step = selfContainedCraftCandidates(state, options).filter((candidate) => !seen.has(candidate.id))
  return step.length === 0 ? [...candidates] : [...candidates, ...step]
}

/** Capability name for one unmet predicate, used in the `precondition:<cause>` blockedBy. */
function preconditionCauseName(predicate: Predicate): string {
  switch (predicate.kind) {
    case 'pickaxeRankAtLeast':
      return 'pickaxe'
    case 'inventoryAtLeast':
      return predicate.item
    case 'inventoryClassAtLeast':
      return `class:${predicate.cls}`
    case 'stationKnown':
      return `station:${predicate.station}`
    case 'oreKnown':
      return `ore:${predicate.item}`
    case 'dimensionIs':
      return `dimension:${predicate.dimension}`
    case 'levelAtMost':
      return `y<=${predicate.y}`
    case 'levelAtLeast':
      return `y>=${predicate.y}`
    case 'positionNear':
      return `position:${predicate.position.x},${predicate.position.y},${predicate.position.z}`
    case 'healthAtLeast':
      return 'health'
    case 'custom':
      return `custom:${predicate.id}`
  }
}

/**
 * The code-owned precondition that stops `goal` from starting, rendered as a
 * `blockedBy` cause (`precondition:pickaxe`), or null when it is startable. A
 * deterministic block must be surfaced instead of a generic `verify_failed`
 * spin, so the starvation line names what actually has to be produced.
 */
export function goalPreconditionCause(goal: PlannedGoal | null, snapshot: OptionWorldSnapshot): string | null {
  if (goal === null) return null
  const { ok, unmet } = evaluatePredicates(compilePlannedGoal(goal, snapshot).preconditions, snapshot)
  if (ok) return null
  const first = unmet[0]
  return first === undefined ? null : `precondition:${preconditionCauseName(first)}`
}
