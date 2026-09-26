// candidate-diagnostics.ts — legacy candidate/skill execution log projection.
//
// Extracted from `controller-legacy.ts`. These functions only translate
// candidates, results, and refusals into structured log rows; they own no
// authority and mutate nothing except per-tick dedup keys on the host. They
// are legacy evidence plumbing, not a semantic source of truth.

import type { Bot } from 'mineflayer'
import { BRIDGE_AUTHORITY_META, BRIDGE_REFUSED_META } from '../bridgeRoute.ts'
import type { Candidate } from '../candidates.ts'
import { formatDigRouteProgress, formatDigRouteRefused } from '../digRoute.ts'
import type { DigRouteRefusal } from '../digRoute.ts'
import type { ExecutionResult } from '../executor.ts'
import type { EventLogger } from '../jev.ts'
import { formatLevelScanStep } from '../levelScan.ts'
import { formatSkillStep } from '../netherPortalPlan.ts'
import { distance } from '../state.ts'
import { countBlockedLogs, formatCandidateAcquisition, formatCandidateAcquisitionRefused, formatLogRoute, isFoodItem, logRouteOf, pickFood, staleKnownResources } from '../candidates.ts'
import type { CandidateOptions, CandidateReachability } from '../candidates.ts'
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
