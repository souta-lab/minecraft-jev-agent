// system2.ts - the LONG-HORIZON brain (System 2), stubbed but with a real interface.
//
// Jev is the *interrupt controller* for this layer:
//
//     Mineflayer -> Jev -> ( normal handling | need_llm=true -> LLM )
//
// The LLM is **exception-driven**, never periodic. It is summoned when:
//
//     queue_empty        the goal queue ran dry (the plan was consumed)
//     need_llm           Jev itself asked (its `need_llm` boolean was adopted)
//     action_impossible  an action is mechanically impossible (no path, no target, ...)
//     unknown_situation  an unexpected world state / policy error / death
//     no_progress        no goal progress for a long time
//
// and its answer is a list of high-level goals that is appended to the goal queue
// in `goalQueue.ts` and then consumed by Jev and Mineflayer. A real model is
// dropped in by implementing `System2Brain` - nothing else changes:
//
//     interface System2Brain {
//       plan(request: System2PlanRequest): Promise<System2Plan>
//     }
//
// `StubSystem2` is the shipped placeholder. It is deterministic, it logs every
// request/response as a `system2-plan` JSONL record, and it returns the documented
// horizon plan from the design:
//
//     [ collect_logs(n), craft_table, craft_pickaxe, mine_cobblestone(16) ]
//
// so the queue is exercised end to end today without a live model.
import type { GoalQueueState, PlanOp, PlannedGoal } from './goalQueue.ts'
import type { JsonlWriter } from './jev.ts'
import type { System2RequestContext } from './system2Authority.ts'

/** Why the long-horizon layer was woken up. */
export type LlmSummonReason =
  | 'need_llm'
  | 'queue_empty'
  | 'action_impossible'
  | 'unknown_situation'
  | 'no_progress'

export const LLM_SUMMON_REASONS: readonly LlmSummonReason[] = [
  'need_llm',
  'queue_empty',
  'action_impossible',
  'unknown_situation',
  'no_progress',
]

/** The deterministic objective the agent was configured with (the plan seed). */
export interface System2Objective {
  targetItem: string
  requiredCount: number
  haveCount: number
  complete: boolean
}

/** A compact outcome, so the planner can see what recently happened. */
export interface System2Outcome {
  actionId: string
  status: string
  failure: string | null
  verified: boolean
  detail: string
  /** Typed outcome evidence; optional for old/replayed records. */
  execution?: 'success' | 'failure' | 'cancelled' | 'control'
  verification?: 'verified' | 'unverified' | 'not_applicable'
  progress?: 'goal' | 'body' | 'search' | 'none'
  progressKinds?: string[]
  control?: 'none' | 'wait' | 'escalate'
}

export interface System2PlanRequest {
  reason: LlmSummonReason
  detail: string
  tick: number
  goalQueueState: GoalQueueState
  objective: System2Objective
  recentEvents: string[]
  recentOutcomes: System2Outcome[]
  /** Identity of the semantic state read by this asynchronous request. */
  requestContext?: System2RequestContext
}

export interface System2Plan {
  goals: PlannedGoal[]
  note: string
  /**
   * Typed semantic lifecycle operation. Natural-language notes are explanatory
   * only; GoalQueue owns the transition represented by this value.
   */
  op?: PlanOp
}

/**
 * THE swap point for a real model. Implement this, call `controller.setSystem2()`,
 * and the exception-driven goal-queue loop works unchanged.
 */
export interface System2Brain {
  readonly model: string
  /** Transport/authority provider, explicit in resident reports. */
  readonly provider?: string
  /** Effective model that actually owns semantic System2 decisions. */
  readonly authorityModel?: string
  plan(request: System2PlanRequest): Promise<System2Plan>
}

/** One explicit DTO for audit/report code; never infer authority from `model`. */
export function system2AuthorityIdentity(brain: Pick<System2Brain, 'model' | 'provider' | 'authorityModel'>): {
  provider: string
  model: string
} {
  return { provider: brain.provider ?? 'unknown', model: brain.authorityModel ?? brain.model }
}

export interface System2PlanRecord {
  record: 'system2-plan'
  ts: string
  requestedAt: number
  latencyMs: number
  stub: boolean
  model: string
  provider?: string
  authorityModel?: string
  requestContext?: System2RequestContext
  /** 1-based invocation index of this brain instance (single-shot plans on 1) */
  callNumber: number
  reason: LlmSummonReason
  detail: string
  tick: number
  queueDepthBefore: number
  currentGoalBefore: string | null
  objective: System2Objective
  returnedGoals: PlannedGoal[]
  note: string
}

/** The plan JSON shape the long-horizon model is specified to emit. */
export interface PlanSubgoalJson {
  type: 'collect' | 'craft' | 'place' | 'smelt'
  resource?: string
  resourceClass?: string
  item?: string
  count: number
}

export interface PlanJson {
  goal: string
  subgoals: PlanSubgoalJson[]
}

/**
 * The M1 plan, supplied once by the planner stub. It is plain data so the
 * runner, the tests and the goal queue all consume the exact same object.
 */
export const M1_PLAN_JSON: PlanJson = {
  goal: 'obtain_stone_tools',
  subgoals: [
    { type: 'collect', resource: 'oak_log', count: 3 },
    { type: 'craft', item: 'crafting_table', count: 1 },
    { type: 'craft', item: 'wooden_pickaxe', count: 1 },
    { type: 'collect', resource: 'cobblestone', count: 16 },
  ],
}

/**
 * Historical iron-age ladder, supplied once by the planner stub. It remains
 * available for regression fixtures and compatibility runs; it is not the
 * current M2 definition. The current M2 is the diamond-to-Nether-gate path in
 * MILESTONE-CONTRACT.json. The log species matches what is reachable around
 * the default spawn (birch); the iron/diamond targets are the sensor's yield
 * names (`raw_iron`, `diamond`).
 */
export const M2_PLAN_JSON: PlanJson = {
  goal: 'iron_age',
  subgoals: [
    { type: 'collect', resourceClass: 'log', count: 3 },
    { type: 'craft', item: 'crafting_table', count: 1 },
    { type: 'craft', item: 'wooden_pickaxe', count: 1 },
    { type: 'collect', resource: 'cobblestone', count: 12 },
    { type: 'craft', item: 'furnace', count: 1 },
    { type: 'place', item: 'furnace', count: 1 },
    { type: 'craft', item: 'stone_pickaxe', count: 1 },
    { type: 'collect', resourceClass: 'log', count: 2 },
    { type: 'smelt', item: 'charcoal', count: 1 },
    { type: 'collect', resource: 'raw_iron', count: 3 },
    { type: 'smelt', item: 'iron_ingot', count: 3 },
    { type: 'craft', item: 'iron_pickaxe', count: 1 },
    { type: 'collect', resource: 'diamond', count: 1 },
    { type: 'craft', item: 'diamond_pickaxe', count: 1 },
  ],
}

/** Map the plan JSON onto the queue's `PlannedGoal` records, preserving order. */
export function planFromJson(plan: PlanJson): PlannedGoal[] {
  return plan.subgoals.map((subgoal) => {
    if (subgoal.type === 'collect') {
      const item = subgoal.resourceClass ?? subgoal.resource ?? 'unknown'
      return {
        kind: 'collect',
        description: `collect ${subgoal.count} x ${item}`,
        targetItem: item,
        requiredCount: subgoal.count,
      }
    }
    const item = subgoal.item ?? 'unknown'
    const kind = subgoal.type === 'place' ? 'place' : subgoal.type === 'smelt' ? 'smelt' : 'craft'
    const verb = kind === 'craft' ? 'craft' : kind
    return {
      kind,
      description: `${verb} ${subgoal.count} x ${item}`,
      targetItem: item,
      requiredCount: subgoal.count,
    }
  })
}

/**
 * Pure helper: derive the summon reasons visible from a *snapshot* of conditions.
 * Event-driven reasons (need_llm, action_impossible, unknown_situation) are
 * supplied by the caller; this keeps the "should we wake System 2?" rule in one
 * place and unit-testable. Ordered most-authoritative first.
 */
export interface SummonConditions {
  queueEmpty: boolean
  needLlm: boolean
  actionImpossible: boolean
  unknownSituation: boolean
  noProgress: boolean
}

export function evaluateSummonConditions(conditions: SummonConditions): LlmSummonReason[] {
  const reasons: LlmSummonReason[] = []
  if (conditions.needLlm) reasons.push('need_llm')
  if (conditions.queueEmpty) reasons.push('queue_empty')
  if (conditions.actionImpossible) reasons.push('action_impossible')
  if (conditions.unknownSituation) reasons.push('unknown_situation')
  if (conditions.noProgress) reasons.push('no_progress')
  return reasons
}

/**
 * The documented horizon tail. When the objective is already satisfied and the
 * agent asks "what next?", this is the placeholder answer: a crafting/mining
 * chain that the current PoC cannot execute yet - which itself exercises the
 * `action_impossible` re-summon path.
 */
export const STUB_HORIZON_TAIL: readonly PlannedGoal[] = [
  { kind: 'craft', description: 'craft a crafting table', targetItem: 'crafting_table', requiredCount: 1 },
  { kind: 'craft', description: 'craft a wooden pickaxe', targetItem: 'wooden_pickaxe', requiredCount: 1 },
  { kind: 'collect', description: 'mine 16 cobblestone', targetItem: 'cobblestone', requiredCount: 16 },
]

export const STUB_SYSTEM2_MODEL = 'stub-system2'

/**
 * Build the deterministic placeholder plan for a request. Exported so the
 * deterministic test can assert the exact queue shape with no network.
 */
export function buildStubPlan(request: System2PlanRequest): PlannedGoal[] {
  if (request.objective.complete && request.goalQueueState.hasImpossible) {
    // nothing the stub can do about the impossible crafts; stop re-planning
    return []
  }
  if (request.objective.complete) {
    return [...STUB_HORIZON_TAIL]
  }
  const remaining = Math.max(1, request.objective.requiredCount - request.objective.haveCount)
  return [
    {
      kind: 'collect',
      description: `collect ${remaining} x ${request.objective.targetItem}`,
      targetItem: request.objective.targetItem,
      requiredCount: remaining,
      detail: 'bootstrap collect goal (seeded from the configured objective)',
    },
    ...STUB_HORIZON_TAIL,
  ]
}

export class StubSystem2 implements System2Brain {
  readonly model = STUB_SYSTEM2_MODEL
  readonly provider = 'stub'
  readonly authorityModel = STUB_SYSTEM2_MODEL
  private readonly writer: JsonlWriter | null

  constructor(writer: JsonlWriter | null) {
    this.writer = writer
  }

  async plan(request: System2PlanRequest): Promise<System2Plan> {
    const requestedAt = Date.now()
    const goals = buildStubPlan(request)
    const note =
      goals.length === 0
        ? 'stub: no executable long-horizon goal for this situation'
        : `stub horizon plan: ${goals.map((goal) => `${goal.kind}(${goal.targetItem ?? goal.description})`).join(' -> ')}`
    const record: System2PlanRecord = {
      record: 'system2-plan',
      ts: new Date().toISOString(),
      requestedAt,
      latencyMs: Date.now() - requestedAt,
      stub: true,
      model: this.model,
      provider: this.provider,
      authorityModel: this.authorityModel,
      ...(request.requestContext === undefined ? {} : { requestContext: request.requestContext }),
      callNumber: 1,
      reason: request.reason,
      detail: request.detail,
      tick: request.tick,
      queueDepthBefore: request.goalQueueState.depth,
      currentGoalBefore: request.goalQueueState.current?.description ?? null,
      objective: request.objective,
      returnedGoals: goals,
      note,
    }
    this.writer?.write(record)
    return { goals, note }
  }
}

export const SINGLE_SHOT_PLANNER_MODEL = 'stub-single-shot-planner'

/**
 * A single-shot planner: it returns the supplied plan on its FIRST invocation
 * and an empty plan on every later one. It still implements `System2Brain`, so
 * it is the real LLM swap point - only the transport is stubbed. This is what
 * lets the controller prove "the plan was supplied once, then the LLM was never
 * called again during the run".
 */
export class FixedPlanSystem2 implements System2Brain {
  readonly model = SINGLE_SHOT_PLANNER_MODEL
  readonly provider = 'stub'
  readonly authorityModel = SINGLE_SHOT_PLANNER_MODEL
  private readonly writer: JsonlWriter | null
  private readonly plannedGoals: readonly PlannedGoal[]
  private readonly note: string
  private calls = 0

  constructor(writer: JsonlWriter | null, plannedGoals: readonly PlannedGoal[], note = 'single-shot M1 plan') {
    this.writer = writer
    this.plannedGoals = plannedGoals
    this.note = note
  }

  get callCount(): number {
    return this.calls
  }

  async plan(request: System2PlanRequest): Promise<System2Plan> {
    this.calls += 1
    const first = this.calls === 1
    const goals = first ? [...this.plannedGoals] : []
    const note = first ? this.note : 'single-shot planner: plan already supplied, no further call'
    const record: System2PlanRecord = {
      record: 'system2-plan',
      ts: new Date().toISOString(),
      requestedAt: Date.now(),
      latencyMs: 0,
      stub: true,
      model: this.model,
      provider: this.provider,
      authorityModel: this.authorityModel,
      ...(request.requestContext === undefined ? {} : { requestContext: request.requestContext }),
      callNumber: this.calls,
      reason: request.reason,
      detail: request.detail,
      tick: request.tick,
      queueDepthBefore: request.goalQueueState.depth,
      currentGoalBefore: request.goalQueueState.current?.description ?? null,
      objective: request.objective,
      returnedGoals: goals,
      note,
    }
    this.writer?.write(record)
    return { goals, note }
  }
}
