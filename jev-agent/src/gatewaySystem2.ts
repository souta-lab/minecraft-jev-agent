// gatewaySystem2.ts - opt-in real System 2 planner over Vercel AI Gateway.
//
// This layer is deliberately sparse and bounded:
//   * it is only called through the existing exception-driven System2Brain interface;
//   * it may change HIGH-LEVEL goals only (collect/craft/place/smelt);
//   * it never chooses block/entity coordinates or Mineflayer/Jev action ids;
//   * output is schema-constrained, locally validated, target-grounded, and only
//     then converted into PlannedGoal records by code.
//
// Default model: Inception Mercury 2.5. The model remains configurable so the same
// interface can A/B-test other Gateway models without changing controller logic.
import { generateText, jsonSchema, Output } from 'ai'
import type { PlanOp, PlannedGoal } from './goalQueue.ts'
import { resolveJevApiKey } from './jev.ts'
import type { JsonlWriter } from './jev.ts'
import type { System2Brain, System2Plan, System2PlanRequest } from './system2.ts'

export const DEFAULT_GATEWAY_SYSTEM2_MODEL = 'inception/mercury-2.5'

export type GatewayReasoningEffort =
  | 'provider-default'
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'

type ExecutableGoalKind = 'collect' | 'craft' | 'place' | 'smelt'

/**
 * Targets currently understood by the M1/M2 executor + resource-class resolver.
 * Callers may extend/replace this list when a new capability lands, but a model
 * never gets to invent arbitrary item ids by default.
 */
export const DEFAULT_SYSTEM2_TARGETS = [
  'log',
  'planks',
  'stone',
  'fuel',
  'food',
  'pickaxe',
  'oak_log',
  'birch_log',
  'spruce_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'mangrove_log',
  'cherry_log',
  'pale_oak_log',
  'cobblestone',
  'crafting_table',
  'wooden_pickaxe',
  'furnace',
  'stone_pickaxe',
  'charcoal',
  'coal',
  'raw_iron',
  'iron_ingot',
  'iron_pickaxe',
  'diamond',
  'diamond_pickaxe',
  'iron_chestplate',
  'iron_leggings',
  'iron_helmet',
  'iron_boots',
  'iron_sword',
] as const

export interface GatewayPlanGoal {
  kind: ExecutableGoalKind
  targetItem: string
  requiredCount: number
  detail?: string
}

export interface GatewayPlanOutput {
  op: PlanOp
  goals: GatewayPlanGoal[]
  note: string
}

export interface GatewaySystem2Options {
  writer: JsonlWriter | null
  model?: string
  maxOutputTokens?: number
  timeoutMs?: number
  maxRetries?: number
  reasoning?: GatewayReasoningEffort
  /** Explicitly grounded targets the model may put into returned goals. */
  allowedTargets?: readonly string[]
}

const PLAN_OPS = new Set<PlanOp>(['continue', 'patch', 'replace', 'abort'])
const GOAL_KINDS = new Set<ExecutableGoalKind>(['collect', 'craft', 'place', 'smelt'])
const ITEM_RE = /^[a-z0-9_]{1,80}$/
const MAX_GOALS = 16

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Local shape validation in addition to provider-side structured output. This is
 * pure/exported so CI can verify planner safety without making a network call.
 */
export function validateGatewayPlanOutput(
  value: unknown,
): { success: true; value: GatewayPlanOutput } | { success: false; error: Error } {
  if (!isRecord(value)) return { success: false, error: new Error('plan must be an object') }

  const op = value.op
  if (typeof op !== 'string' || !PLAN_OPS.has(op as PlanOp)) {
    return { success: false, error: new Error(`invalid plan op: ${String(op)}`) }
  }

  const note = value.note
  if (typeof note !== 'string' || note.length > 600) {
    return { success: false, error: new Error('note must be a string <= 600 chars') }
  }

  const rawGoals = value.goals
  if (!Array.isArray(rawGoals) || rawGoals.length > MAX_GOALS) {
    return { success: false, error: new Error(`goals must be an array with <= ${MAX_GOALS} entries`) }
  }

  if (op === 'abort' && rawGoals.length !== 0) {
    return { success: false, error: new Error('abort plans must not contain goals') }
  }

  const goals: GatewayPlanGoal[] = []
  for (let index = 0; index < rawGoals.length; index += 1) {
    const raw = rawGoals[index]
    if (!isRecord(raw)) return { success: false, error: new Error(`goal[${index}] must be an object`) }

    const kind = raw.kind
    if (typeof kind !== 'string' || !GOAL_KINDS.has(kind as ExecutableGoalKind)) {
      return { success: false, error: new Error(`goal[${index}] has unsupported kind: ${String(kind)}`) }
    }

    const targetItem = raw.targetItem
    if (typeof targetItem !== 'string' || !ITEM_RE.test(targetItem)) {
      return { success: false, error: new Error(`goal[${index}] has invalid targetItem`) }
    }

    const requiredCount = raw.requiredCount
    if (typeof requiredCount !== 'number' || !Number.isInteger(requiredCount) || requiredCount < 1 || requiredCount > 64) {
      return { success: false, error: new Error(`goal[${index}] requiredCount must be an integer in [1,64]`) }
    }

    const detail = raw.detail
    if (detail !== undefined && (typeof detail !== 'string' || detail.length > 300)) {
      return { success: false, error: new Error(`goal[${index}] detail must be <= 300 chars`) }
    }

    goals.push({
      kind: kind as ExecutableGoalKind,
      targetItem,
      requiredCount,
      ...(typeof detail === 'string' && detail.length > 0 ? { detail } : {}),
    })
  }

  return { success: true, value: { op: op as PlanOp, goals, note } }
}

export function validateGroundedTargets(
  output: GatewayPlanOutput,
  allowedTargets: ReadonlySet<string>,
): { success: true } | { success: false; error: Error } {
  for (let index = 0; index < output.goals.length; index += 1) {
    const target = output.goals[index]?.targetItem
    if (target === undefined || !allowedTargets.has(target)) {
      return { success: false, error: new Error(`goal[${index}] target is not grounded: ${String(target)}`) }
    }
  }
  return { success: true }
}

const gatewayPlanSchema = jsonSchema<GatewayPlanOutput>(
  {
    type: 'object',
    additionalProperties: false,
    properties: {
      op: { type: 'string', enum: ['continue', 'patch', 'replace', 'abort'] },
      goals: {
        type: 'array',
        maxItems: MAX_GOALS,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['collect', 'craft', 'place', 'smelt'] },
            targetItem: {
              type: 'string',
              minLength: 1,
              maxLength: 80,
              pattern: '^[a-z0-9_]+$',
            },
            requiredCount: { type: 'integer', minimum: 1, maximum: 64 },
            detail: { type: 'string', maxLength: 300 },
          },
          required: ['kind', 'targetItem', 'requiredCount'],
        },
      },
      note: { type: 'string', maxLength: 600 },
    },
    required: ['op', 'goals', 'note'],
  },
  { validate: validateGatewayPlanOutput },
)

const SYSTEM_PROMPT = `You are System 2, the sparse long-horizon recovery planner for an embodied Minecraft Java agent.

You do NOT control the body. Mineflayer owns mechanics and Jev owns the next grounded macro-action. You may only repair the high-level goal queue.

Allowed goal kinds are exactly: collect, craft, place, smelt.
Never emit MOVE/MINE/ATTACK coordinates, block ids, entity ids, yaw/pitch, paths, or free-form motor instructions.
Choose targetItem ONLY from the allowedTargets list supplied in the request.
Do not invent a new capability merely to escape a failure. Prefer the smallest plan change that can make progress.
Do not re-add completed work unless it is genuinely required again because the resource was consumed.

Plan operation semantics:
- continue: keep the current queue and append the returned goals.
- patch: keep completed history and the active goal, replace the pending tail.
- replace: replace all unfinished goals.
- abort: mark the remaining goal as impossible; goals MUST be empty.

Return only the schema-constrained plan.`

function compactPlannerState(request: System2PlanRequest, allowedTargets: readonly string[]): unknown {
  const goals = request.goalQueueState.goals
  return {
    reason: request.reason,
    detail: request.detail,
    tick: request.tick,
    objective: request.objective,
    allowedTargets,
    queue: {
      depth: request.goalQueueState.depth,
      current: request.goalQueueState.current,
      pending: goals
        .filter((goal) => goal.status === 'pending')
        .slice(0, 12)
        .map((goal) => ({ kind: goal.kind, targetItem: goal.targetItem, requiredCount: goal.requiredCount, detail: goal.detail })),
      recentlyDone: goals
        .filter((goal) => goal.status === 'done')
        .slice(-8)
        .map((goal) => ({ kind: goal.kind, targetItem: goal.targetItem, requiredCount: goal.requiredCount })),
      impossible: goals
        .filter((goal) => goal.status === 'impossible')
        .slice(-6)
        .map((goal) => ({ kind: goal.kind, targetItem: goal.targetItem, detail: goal.detail })),
    },
    recentEvents: request.recentEvents.slice(-12),
    recentOutcomes: request.recentOutcomes.slice(-12),
  }
}

function descriptionFor(goal: GatewayPlanGoal): string {
  const verb = goal.kind === 'collect' ? 'collect' : goal.kind
  return `${verb} ${goal.requiredCount} x ${goal.targetItem}`
}

export function plannedGoalsFromGateway(output: GatewayPlanOutput): PlannedGoal[] {
  if (output.op === 'abort') return []
  return output.goals.map((goal) => ({
    kind: goal.kind,
    description: descriptionFor(goal),
    targetItem: goal.targetItem,
    requiredCount: goal.requiredCount,
    ...(goal.detail === undefined ? {} : { detail: goal.detail }),
  }))
}

interface GatewaySystem2Record {
  record: 'system2-gateway-plan'
  ts: string
  callNumber: number
  model: string
  reason: System2PlanRequest['reason']
  latencyMs: number
  usage: unknown
  op: PlanOp
  returnedGoals: PlannedGoal[]
  note: string
}

/**
 * A real System2Brain backed by Vercel AI Gateway. It is opt-in: merely importing
 * this module performs no request. The caller chooses when to install it through
 * `controller.setSystem2()`.
 */
export class GatewaySystem2 implements System2Brain {
  readonly model: string
  private readonly writer: JsonlWriter | null
  private readonly maxOutputTokens: number
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly reasoning: GatewayReasoningEffort
  private readonly allowedTargets: readonly string[]
  private readonly allowedTargetSet: ReadonlySet<string>
  private calls = 0

  constructor(options: GatewaySystem2Options) {
    this.writer = options.writer
    this.model = options.model ?? process.env.SYSTEM2_MODEL ?? DEFAULT_GATEWAY_SYSTEM2_MODEL
    this.maxOutputTokens = options.maxOutputTokens ?? 1200
    this.timeoutMs = options.timeoutMs ?? 15000
    this.maxRetries = options.maxRetries ?? 1
    this.reasoning = options.reasoning ?? 'low'
    this.allowedTargets = [...new Set(options.allowedTargets ?? DEFAULT_SYSTEM2_TARGETS)]
    this.allowedTargetSet = new Set(this.allowedTargets)

    // Reuse the project's proven 0600 key-file/env resolution. The AI SDK Gateway
    // provider reads AI_GATEWAY_API_KEY at request time; never log the key itself.
    if ((process.env.AI_GATEWAY_API_KEY ?? '').trim().length === 0) {
      const resolved = resolveJevApiKey()
      if (resolved !== null) process.env.AI_GATEWAY_API_KEY = resolved.key
    }
  }

  get callCount(): number {
    return this.calls
  }

  async plan(request: System2PlanRequest): Promise<System2Plan> {
    if ((process.env.AI_GATEWAY_API_KEY ?? '').trim().length === 0) {
      throw new Error('GatewaySystem2 requires AI_GATEWAY_API_KEY or the configured local gateway key file')
    }

    this.calls += 1
    const startedAt = Date.now()
    const result = await generateText({
      model: this.model,
      system: SYSTEM_PROMPT,
      prompt: JSON.stringify(compactPlannerState(request, this.allowedTargets)),
      reasoning: this.reasoning,
      maxOutputTokens: this.maxOutputTokens,
      maxRetries: this.maxRetries,
      abortSignal: AbortSignal.timeout(this.timeoutMs),
      output: Output.object({
        name: 'MinecraftSystem2Plan',
        description: 'A bounded high-level repair plan for the Minecraft goal queue.',
        schema: gatewayPlanSchema,
      }),
    })

    const output = result.output
    const grounded = validateGroundedTargets(output, this.allowedTargetSet)
    if (!grounded.success) throw grounded.error

    const goals = plannedGoalsFromGateway(output)
    const latencyMs = Date.now() - startedAt

    this.writer?.write({
      record: 'system2-gateway-plan',
      ts: new Date().toISOString(),
      callNumber: this.calls,
      model: this.model,
      reason: request.reason,
      latencyMs,
      usage: result.usage,
      op: output.op,
      returnedGoals: goals,
      note: output.note,
    } satisfies GatewaySystem2Record)

    return { op: output.op, goals, note: output.note }
  }
}
