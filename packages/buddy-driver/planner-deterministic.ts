// planner-deterministic.ts - the explicit DETERMINISTIC_BASELINE planner.
//
// This module implements the offline/rollback baseline for the System2 WHAT
// seam: a `System2Brain` that answers a replan request from the canonical
// capability ladder (`planner-ladder.ts`) with no model calls, no cache, and
// no advisor. It is reachable only when `BUDDY_PLANNER=deterministic` (or an
// explicit `mode: 'deterministic'` override) was selected at generation
// startup; a run in this mode is a labeled deterministic baseline, not
// Jev/System2 acceptance evidence.
//
// It owns no semantic authority beyond emitting `System2Plan` goal data on a
// replan boundary - the kernel-admitted transition path, Jev tactical policy,
// VERIFY and the actuation boundary are untouched by anything here.

import type { Bot } from 'mineflayer'
import type { PlanOp, PlannedGoal } from '../jev-agent/src/goalQueue.ts'
import type { System2Brain, System2Outcome, System2Plan, System2PlanRequest } from '../jev-agent/src/system2/service.ts'
import { hasBodyDelta, parseCapabilityGap } from '../jev-agent/src/replanThrottle.ts'
import { countSensedPortalFrameBlocks } from '../jev-agent/src/state.ts'
import { compilePlannedGoal, goalReadinessLabel, isOptionStartable } from '../jev-agent/src/optionSpec.ts'
import { formatSkillSelected, formatStrategyBodyDelta, generateSkillPlan, skillSignature } from '../jev-agent/src/skillCandidate.ts'
import type { SkillCandidate } from '../jev-agent/src/skillCandidate.ts'
import type { ResidentWorldMemory } from './resident-types.ts'
import {
  advanceMilestones,
  bestPickaxeRank,
  buildBodyChangeOption,
  buildPlanOptions,
  buildSkillGenerationInput,
  buildUpperAccessRecoveryOption,
  emptyMilestoneStream,
  goalSignature,
  inventoryCounts,
  isAdvisorStrategy,
  ladderFloorGoals,
  orderPlanGoalsByReadiness,
  plannerReadinessSnapshot,
  plannedGoalToSkillGoal,
  resolveRungSourceOfTruth,
  skillsForStrategy,
  upperAccessRecoveryApplies,
} from './planner-ladder.ts'
import type { Counts, DurableLadderProgress, MilestoneStreamState, PlanOption, SkillAdapterOptions } from './planner-ladder.ts'

export interface DeterministicPlannerOptions {
  bot: Bot
  world: ResidentWorldMemory
  log: (event: string, detail?: Record<string, unknown>) => void
  /** Refresh live server predicates before grounding a replan request. */
  refreshLiveFacts?: () => void
  /**
   * The run's durable ladder record (HOST-committed class-A ledger), when the
   * caller owns it. Every rung decision the baseline makes uses it, so a
   * non-lossy death cannot make the planner re-plan rungs the run already
   * reached. Absent (offline fixtures, tests) = live-inventory evidence only.
   */
  durableLadderProgress?: DurableLadderProgress | null
}

type PlannerReason = 'start' | 'queue_empty' | 'impossible' | 'stuck'

function mapReason(request: System2PlanRequest, firstCall: boolean): PlannerReason {
  if (firstCall && request.goalQueueState.depth === 0 && request.goalQueueState.done === 0) return 'start'
  if (request.reason === 'action_impossible') return 'impossible'
  if (request.reason === 'no_progress' || request.reason === 'need_llm' || request.reason === 'unknown_situation') return 'stuck'
  return 'queue_empty'
}

function trailingWaitStreak(outcomes: readonly System2Outcome[]): number {
  let streak = 0
  for (let i = outcomes.length - 1; i >= 0; i -= 1) {
    const outcome = outcomes[i]
    if (outcome === undefined || outcome.actionId !== 'WAIT') break
    streak += 1
  }
  return streak
}

const UPKEEP_GOAL: PlannedGoal = {
  kind: 'collect',
  description: 'collect 16 x raw_iron (resident upkeep)',
  targetItem: 'raw_iron',
  requiredCount: 16,
}

const FRONT_FALLBACK: PlanOption = { id: 'front_fallback', title: 'deterministic ladder front', goals: [UPKEEP_GOAL] }

function rejectionPlan(note: string): System2Plan {
  return { goals: [], note: `REPLAN_REJECTED no_body_delta (${note})`, op: 'continue' as PlanOp }
}

/**
 * The deterministic-baseline planner. Constructed per generation and handed to
 * `JevController.setSystem2()` only under an explicit `BUDDY_PLANNER=deterministic`
 * selection. The controller calls `plan()` only on replan boundaries
 * (queue empty / goal impossible / stall), never on the hot path.
 */
export class DeterministicPlanner implements System2Brain {
  /** labeled baseline: this brain performs no model calls */
  readonly model = 'deterministic'
  private readonly bot: Bot
  /** Live world-truth refresh (dimension / portal verdict) injected by the host. */
  private readonly refreshLiveFacts?: () => void
  /** dedupe for the PLAN_REASON diagnosis (#359) */
  private lastLoggedPlanReason: string | null = null
  private firstCall = true
  /** #392: predicate-backed milestone evidence; the frontier id alone proves nothing. */
  private milestones: MilestoneStreamState = emptyMilestoneStream()
  private lastBodySignature: string | null = null
  private lastBodyGoals: PlannedGoal[] = []
  private currentCounts: Counts = {}
  private currentPortalFrameBlocks = 0
  private adoptedRungId = 'wood'
  private readonly world: ResidentWorldMemory
  private readonly log: (event: string, detail?: Record<string, unknown>) => void
  /** the run's durable ladder record (archived ledger), when the caller supplied one. */
  private readonly durableLadderProgress: DurableLadderProgress | null = null

  constructor(options: DeterministicPlannerOptions) {
    this.bot = options.bot
    this.refreshLiveFacts = options.refreshLiveFacts
    this.world = options.world
    this.log = options.log
    this.durableLadderProgress = options.durableLadderProgress ?? null
  }

  async plan(request: System2PlanRequest): Promise<System2Plan> {
    const started = Date.now()
    // Refresh the live world facts BEFORE the rung evaluation and the plan
    // build so `this.world.dimension` / `this.world.portalVerified` reflect the
    // current server truth (the pre-refresh stale-dimension bug re-ignited an
    // already-lit portal instead of starting the post-portal goals).
    this.refreshLiveFacts?.()
    const counts = inventoryCounts(this.bot)
    this.currentCounts = counts
    this.currentPortalFrameBlocks = this.bot.entity === undefined ? 0 : countSensedPortalFrameBlocks(this.bot)
    this.log('PORTAL_FRAME_PROGRESS', { blocks: this.currentPortalFrameBlocks })
    const rung = resolveRungSourceOfTruth(counts, this.world, this.log, this.durableLadderProgress)
    this.adoptedRungId = rung.adoptedRungId
    const options = buildPlanOptions(counts, this.world, {
      placedFurnacesNear: this.placedFurnacesNear(),
      knownFurnaces: this.world.furnaces.length,
      resumeRungIndex: rung.adoptedRungIndex,
      portalFrameBlocks: this.currentPortalFrameBlocks,
      log: this.log,
    })
    const reason = mapReason(request, this.firstCall)
    this.firstCall = false
    this.emitMilestones(counts)
    const fallbackOption = options[0] ?? FRONT_FALLBACK
    const capabilityGap = parseCapabilityGap(request.recentEvents)
    const entity = this.bot.entity
    const botY = entity === undefined ? null : entity.position.y
    const surfaceOption = botY === null ? null : buildUpperAccessRecoveryOption(this.world, botY)
    const forcedSurface = capabilityGap !== null && surfaceOption !== null ? surfaceOption : null

    if (forcedSurface !== null) {
      this.logUpperAccessRecoveryPolicy(forcedSurface, options)
      this.logPlan('fallback', forcedSurface, reason, started, 'capability gap -> return_to_surface')
      return this.finishPlan(forcedSurface, request, 'capability gap -> return_to_surface', true, true)
    }

    const waitStreak = trailingWaitStreak(request.recentOutcomes)
    {
      const reasonValue = String(reason)
      if (this.lastLoggedPlanReason !== reasonValue) {
        this.lastLoggedPlanReason = reasonValue
        this.log('PLAN_REASON', { reason: reasonValue })
      }
    }
    const stalledOption =
      waitStreak >= 3
        ? buildBodyChangeOption(counts, this.world, {
            placedFurnacesNear: this.placedFurnacesNear(),
            knownFurnaces: this.world.furnaces.length,
            resumeRungIndex: rung.adoptedRungIndex,
            portalFrameBlocks: this.currentPortalFrameBlocks,
            log: this.log,
          })
        : null
    const deterministicOption = stalledOption ?? fallbackOption

    if (reason === 'queue_empty') {
      const floor = ladderFloorGoals(counts, this.world, {
        resumeRungIndex: rung.adoptedRungIndex,
        dimension: this.bot.game?.dimension ?? null,
        placedFurnacesNear: this.placedFurnacesNear(),
        knownFurnaces: this.world.furnaces.length,
        portalFrameBlocks: this.currentPortalFrameBlocks,
        log: this.log,
      })
      const floorOption: PlanOption = {
        id: `ladder_${floor.rungId}`,
        title: `deterministic ladder floor (${floor.rungId})`,
        goals: floor.goals,
      }
      this.logPlan('ladder', floorOption, reason, started, `queue_empty -> ladder floor rung=${floor.rungId} supplied=${floor.supplied}`)
      if (floor.goals.length === 0) {
        return { goals: [], note: `ladder floor empty (${floor.rungId})`, op: 'continue' as PlanOp }
      }
      return this.finishPlan(floorOption, request, `ladder floor (${floor.rungId})`, true)
    }

    const ordered = this.applyReadinessOrder(deterministicOption)
    this.logPlan('fallback', ordered, reason, started, 'deterministic baseline ladder')
    const option: PlanOption = { ...ordered, strategy: 'deterministic' }
    this.withSkills(option)
    this.logSkills('deterministic', option.skills ?? [])
    this.emitBodyDelta('deterministic', option)
    return { goals: option.goals, note: 'deterministic ladder baseline', op: 'replace' }
  }

  // -- internals ------------------------------------------------------------

  private finishPlan(option: PlanOption, request: System2PlanRequest, note: string, force = false, keepHead = false): System2Plan {
    if (!keepHead) option = this.applyReadinessOrder(option)
    this.withSkills(option)
    this.emitBodyDelta(option.strategy ?? option.id, option)
    const queue = request.goalQueueState
    const first = option.goals[0]
    const current = queue.current
    const alreadyActive =
      queue.depth > 0 &&
      current !== null &&
      first !== undefined &&
      current.kind === first.kind &&
      (current.targetItem ?? null) === (first.targetItem ?? null)
    if (alreadyActive && !force) {
      return { goals: [], note: `keep current plan (${note})`, op: 'continue' as PlanOp }
    }
    const adjusted = this.applyBodyDeltaRequirement(option, request, note)
    if (adjusted === null) return rejectionPlan(note)
    return { goals: adjusted.goals, note, op: 'replace' }
  }

  /**
   * Issue #44 requirement 3: a replacement must change the body. When the
   * chosen option is stationary relative to the blocked goal, substitute the
   * deterministic body-change option (descent/ore/retrieval). If even that
   * cannot change the body, reject the replan and keep the current plan.
   */
  private applyBodyDeltaRequirement(option: PlanOption, request: System2PlanRequest, note: string): PlanOption | null {
    const current = request.goalQueueState.current
    if (hasBodyDelta(option.goals, current)) return option
    const head = option.goals[0]
    if (head !== undefined && this.headReadyAndDifferent(head, current)) {
      this.log('PLAN_READY_APPLY', {
        preferred: goalReadinessLabel(head),
        over: current === null ? null : current.description,
        reason: 'preconditions_satisfied',
      })
      return option
    }
    const substitute = this.bodyChangeOption()
    if (hasBodyDelta(substitute.goals, current)) {
      this.log('REPLAN_BODY_CHANGE', {
        requested: option.id,
        replacement: substitute.id,
        reason: request.reason,
      })
      return substitute
    }
    this.log('REPLAN_REJECTED', {
      reason: 'no_body_delta',
      requested: option.id,
      current: current === null ? null : `${current.kind}:${current.targetItem ?? current.description}`,
      note,
    })
    return null
  }

  /**
   * Issue #46: a ready head that differs from the blocked current goal is
   * actionable now, so #44's body-delta gate must not reject it.
   */
  private headReadyAndDifferent(
    head: PlannedGoal,
    current: { kind: string; targetItem: string | null; description: string } | null,
  ): boolean {
    if (current === null) return false
    if (head.kind === current.kind && (head.targetItem ?? null) === current.targetItem) return false
    return isOptionStartable(compilePlannedGoal(head), plannerReadinessSnapshot(this.currentCounts, this.world))
  }

  private bodyChangeOption(): PlanOption {
    return buildBodyChangeOption(this.currentCounts, this.world, {
      placedFurnacesNear: this.placedFurnacesNear(),
      knownFurnaces: this.world.furnaces.length,
      log: this.log,
    })
  }

  private applyReadinessOrder(option: PlanOption): PlanOption {
    const goals = orderPlanGoalsByReadiness(option.goals, this.currentCounts, this.world, this.log)
    // Reference-identical only when nothing moved and no goal was marked ready;
    // otherwise the marks must be carried so the queue merge can honour them.
    const unchanged =
      goals.length === option.goals.length && goals.every((goal, index) => goal === option.goals[index])
    if (unchanged) return option
    return { ...option, goals }
  }

  /**
   * #29/#20: prove that a plan/strategy change actually reaches the body by
   * logging the compiled goals added/removed and the grounded skills relative to
   * the previous plan. A strategy label that compiles to the same goals AND the
   * same skills logs no delta.
   */
  private emitBodyDelta(strategy: string, option: PlanOption): void {
    const skills = option.skills ?? []
    const signature = `${goalSignature(option.goals)}#${skillSignature(skills)}`
    if (signature === this.lastBodySignature) return
    const same = (a: PlannedGoal, b: PlannedGoal): boolean =>
      a.kind === b.kind && (a.targetItem ?? null) === (b.targetItem ?? null) && (a.requiredCount ?? 1) === (b.requiredCount ?? 1)
    const added = option.goals.filter((goal) => !this.lastBodyGoals.some((previous) => same(goal, previous))).map((goal) => goal.description)
    const removed = this.lastBodyGoals.filter((previous) => !option.goals.some((goal) => same(goal, previous))).map((goal) => goal.description)
    this.lastBodySignature = signature
    this.lastBodyGoals = option.goals.map((goal) => ({ ...goal }))
    if (added.length === 0 && removed.length === 0 && skills.length === 0) return
    this.log('STRATEGY_BODY_DELTA', {
      strategy,
      added,
      removed,
      skills: skills.map((skillCandidate) => skillCandidate.id),
      skillKinds: skills.map((skillCandidate) => skillCandidate.kind),
      line: formatStrategyBodyDelta(strategy, skills),
    })
  }

  /**
   * #20: attach the grounded skill list to an option (idempotent). Strategy
   * options compile through the strategy; all others compile from their first goal.
   */
  private withSkills(option: PlanOption): PlanOption {
    if (option.skills !== undefined) return option
    const strategy =
      typeof option.strategy === 'string' && option.strategy.length > 0 && option.strategy !== 'deterministic'
        ? option.strategy
        : null
    option.skills =
      strategy !== null && isAdvisorStrategy(strategy)
        ? [...skillsForStrategy(strategy, this.currentCounts, this.world, this.botSkillOptions())]
        : generateSkillPlan(
            buildSkillGenerationInput(strategy, this.currentCounts, this.world, {
              ...this.botSkillOptions(),
              goal: plannedGoalToSkillGoal(option.goals[0]),
            }),
          ).skills
    return option
  }

  /** #20: log every grounded skill the selected strategy/option compiles to. */
  private logSkills(strategy: string, skills: readonly SkillCandidate[]): void {
    for (const skillCandidate of skills) {
      this.log('SKILL_SELECTED', {
        id: skillCandidate.id,
        kind: skillCandidate.kind,
        strategy,
        source: skillCandidate.source,
        line: formatSkillSelected(skillCandidate, strategy),
      })
    }
  }

  private botSkillOptions(): SkillAdapterOptions {
    const entity = this.bot.entity
    return {
      position:
        entity === undefined
          ? null
          : { x: Math.floor(entity.position.x), y: Math.floor(entity.position.y), z: Math.floor(entity.position.z) },
      dimension: this.bot.game?.dimension ?? null,
      health: this.bot.health ?? null,
      toolRank: bestPickaxeRank(this.currentCounts),
    }
  }

  private logPlan(source: 'fallback' | 'ladder', option: PlanOption, reason: PlannerReason, started: number, note: string): void {
    this.log('PLAN', {
      source,
      goals: option.goals.map((goal) => goal.description),
      ms: Date.now() - started,
      reason,
      rung: this.adoptedRungId,
      plan: option.id,
      note,
    })
  }

  private logUpperAccessRecoveryPolicy(option: PlanOption, alternatives: readonly PlanOption[]): void {
    const targetY = option.goals[0]?.targetY ?? null
    const entity = this.bot.entity
    const botY = entity === undefined ? null : entity.position.y
    this.log('UPPER_ACCESS_RECOVERY_POLICY', {
      chosen: option.id,
      targetY,
      score: targetY !== null && botY !== null ? Math.round(targetY - botY) : null,
      alternatives: alternatives.map((entry) => entry.id),
      reason: 'capability_gap',
    })
  }

  private emitMilestones(counts: Counts): void {
    const advanced = advanceMilestones(this.milestones, counts, this.world, this.durableLadderProgress)
    this.milestones = advanced.state
    for (const record of advanced.records) this.log('MILESTONE', { ...record })
  }

  private placedFurnacesNear(): number {
    const ids: number[] = []
    for (const name of ['furnace', 'blast_furnace', 'smoker']) {
      const block = this.bot.registry.blocksByName[name]
      if (block !== undefined) ids.push(block.id)
    }
    if (ids.length === 0) return 0
    try {
      return this.bot.findBlocks({ matching: ids, maxDistance: 48, count: 8 }).length
    } catch {
      return 0
    }
  }
}
