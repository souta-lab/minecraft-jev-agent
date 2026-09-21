// causal.ts - Issue #36: end-to-end causal ids for the policy stack.
//
// A human can already correlate a high-level decision with its physical result
// from timestamps, but an offline evaluator (#23) should not have to guess. This
// module mints ONE chain id per Jev decision and threads it through:
//
//   plan/Option -> candidate set -> chosen action -> executor action -> VERIFY
//
// It never builds tracing infrastructure: the ids are plain strings written into
// the existing decision records and agent-event JSONL. Unknown/missing parent
// links are explicit `null`, never silently inferred from timestamps.
//
// Determinism: the id itself is a uuid (stable within a run), but every derived
// field (option id, plan revision, strategy) is a pure function of plain data so
// the chain is reproducible in unit tests with no bot and no model.
import { randomUUID } from 'node:crypto'
import { stableOptionId } from './optionSpec.ts'
import type { PlannedGoal } from './goalQueue.ts'
import type { ActionOutcomeTaxonomy } from './actionPostcondition.ts'

/**
 * The subset of a queued goal the causal layer needs. Kept structural so the
 * real `QueuedGoal` (and any future Option row) can be passed without a cast.
 */
export interface CausalGoalRef {
  id: string
  kind: PlannedGoal['kind']
  description: string
  targetItem: string | null
  requiredCount: number
  /** where the plan row came from: bootstrap | llm | mechanical */
  origin: string
  /** Canonical Option identity, when the queue row has been compiled. */
  optionInstanceId?: string
  optionTemplateId?: string
  /** Canonical System2 semantic owner when this row is a prerequisite. */
  semanticOptionInstanceId?: string
  semanticOptionTemplateId?: string
  optionSpec?: { id: string }
}

/** The ids fixed at DECISION time, carried into every downstream log. */
export interface CausalStamp {
  chainId: string
  /** Canonical semantic Option id, e.g. `front_charcoal` or `goto:raw_iron`. */
  optionId: string | null
  /** Exact semantic Option instance identity, when available. */
  semanticOptionInstanceId?: string | null
  /** the GoalQueue row id (the local plan revision), e.g. `g3:collect:raw_iron` */
  planId: string | null
  /** the high-level strategy that produced the row (host-supplied or origin:kind) */
  strategy: string | null
}

/** The full chain, completed when the executor action settles. */
export interface CausalChain extends CausalStamp {
  /** the candidate id Jev committed to (the chosen macro-action) */
  candidateId: string | null
  /** the executor's action id, unique per owned action */
  actionId: string | null
  verified: boolean | null
  status: string | null
  /** the item the action actually produced, when known */
  resource: string | null
  progressDelta: number | null
  /**
   * True when the action left observable evidence (item, removed block,
   * deterministic body change, live arrival, or a strict-post-condition kind).
   * A chain may never carry `verified=true status=done` with `observable=false`.
   */
  observable: boolean
  execution: ActionOutcomeTaxonomy['execution'] | null
  verification: ActionOutcomeTaxonomy['verification'] | null
  progress: ActionOutcomeTaxonomy['progress']
  progressKinds: string[]
  control: ActionOutcomeTaxonomy['control']
}

/** Mint a fresh chain id. uuid, never a timestamp, so ids are race-free. */
export function makeChainId(): string {
  return randomUUID()
}

/** Stable OptionSpec id for a plan row, or null when there is no current row. */
export function optionIdForGoal(goal: CausalGoalRef | null | undefined): string | null {
  if (goal === null || goal === undefined) return null
  if (typeof goal.semanticOptionTemplateId === 'string' && goal.semanticOptionTemplateId.length > 0) {
    return goal.semanticOptionTemplateId
  }
  if (typeof goal.optionTemplateId === 'string' && goal.optionTemplateId.length > 0) return goal.optionTemplateId
  if (goal.optionSpec !== undefined && typeof goal.optionSpec.id === 'string' && goal.optionSpec.id.length > 0) return goal.optionSpec.id
  return stableOptionId({
    kind: goal.kind,
    description: goal.description,
    targetItem: goal.targetItem,
    requiredCount: goal.requiredCount,
  })
}

/** The local plan revision id (the GoalQueue row id). */
export function planRevisionForGoal(goal: CausalGoalRef | null | undefined): string | null {
  return goal === null || goal === undefined ? null : goal.id
}

/**
 * The strategy label for a plan row when the host did not supply one. This is
 * NOT a model answer: it is the provenance + goal kind of the deterministic plan
 * row (`llm:collect`, `bootstrap:craft`, ...), enough for an offline evaluator to
 * group chains without timestamp heuristics.
 */
export function derivedStrategyForGoal(goal: CausalGoalRef | null | undefined): string | null {
  return goal === null || goal === undefined ? null : `${goal.origin}:${goal.kind}`
}

export interface CausalStampInput {
  chainId: string
  goal: CausalGoalRef | null | undefined
  /** host-supplied strategy; falls back to `origin:kind` when absent */
  strategy?: string | null
}

/** Freeze the ids a decision is threaded by. Pure; safe to call before any action. */
export function makeCausalStamp(input: CausalStampInput): CausalStamp {
  return {
    chainId: input.chainId,
    optionId: optionIdForGoal(input.goal),
    semanticOptionInstanceId: input.goal?.semanticOptionInstanceId ?? input.goal?.optionInstanceId ?? null,
    planId: planRevisionForGoal(input.goal),
    strategy: input.strategy ?? derivedStrategyForGoal(input.goal),
  }
}

export interface CausalOutcomeInput {
  candidateId: string | null
  actionId: string | null
  verified: boolean | null
  status: string | null
  resource?: string | null
  progressDelta?: number | null
  observable?: boolean
  taxonomy?: ActionOutcomeTaxonomy
}

/** Complete a stamp with the executor outcome, preserving every decision-time id. */
export function completeCausalChain(stamp: CausalStamp, outcome: CausalOutcomeInput): CausalChain {
  return {
    chainId: stamp.chainId,
    optionId: stamp.optionId,
    semanticOptionInstanceId: stamp.semanticOptionInstanceId ?? null,
    planId: stamp.planId,
    strategy: stamp.strategy,
    candidateId: outcome.candidateId,
    actionId: outcome.actionId,
    verified: outcome.verified,
    status: outcome.status,
    resource: outcome.resource ?? null,
    progressDelta: outcome.progressDelta ?? null,
    observable: outcome.observable ?? (outcome.verified === true && outcome.status === 'done'),
    execution: outcome.taxonomy?.execution ?? null,
    verification: outcome.taxonomy?.verification ?? null,
    progress: outcome.taxonomy?.progress ?? (outcome.observable === true ? 'body' : 'none'),
    progressKinds: outcome.taxonomy?.progressKinds.slice() ?? (outcome.observable === true ? ['body'] : ['none']),
    control: outcome.taxonomy?.control ?? 'none',
  }
}

function text(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? 'null' : value
}

/** The human-readable one-line marker mirrored into the resident log. */
export function formatCausalLine(chain: CausalChain): string {
  return (
    `CAUSAL chain=${chain.chainId} option=${text(chain.optionId)} semanticOptionInstance=${text(chain.semanticOptionInstanceId)} plan=${text(chain.planId)} ` +
    `strategy=${text(chain.strategy)} candidate=${text(chain.candidateId)} action=${text(chain.actionId)} ` +
    `verified=${chain.verified === null ? 'null' : String(chain.verified)} status=${text(chain.status)} ` +
    `resource=${text(chain.resource)} progressDelta=${chain.progressDelta === null ? 'null' : String(chain.progressDelta)} ` +
    `observable=${String(chain.observable)} execution=${chain.execution ?? 'null'} ` +
    `verification=${chain.verification ?? 'null'} progress=${chain.progress} ` +
    `progressKinds=${chain.progressKinds.join(',')} control=${chain.control}`
  )
}

/** The structured payload attached to the agent-event JSONL line. */
export function causalRecord(chain: CausalChain): Record<string, unknown> {
  return {
    record: 'causal',
    chainId: chain.chainId,
    optionId: chain.optionId,
    semanticOptionInstanceId: chain.semanticOptionInstanceId,
    planId: chain.planId,
    strategy: chain.strategy,
    candidateId: chain.candidateId,
    actionId: chain.actionId,
    verified: chain.verified,
    status: chain.status,
    resource: chain.resource,
    progressDelta: chain.progressDelta,
    observable: chain.observable,
    execution: chain.execution,
    verification: chain.verification,
    progress: chain.progress,
    progressKinds: chain.progressKinds,
    control: chain.control,
  }
}
