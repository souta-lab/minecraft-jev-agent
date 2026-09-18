// decisionlog.ts - the decision record written for every Jev decision.
//
// Each record is a complete, self-contained training/calibration example:
//
//   {
//     "stateHash": "...", "candidates": [], "jev": {}, "chosenAction": "...",
//     "confidence": 0.87,
//     "result": { "success": true, "durationMs": 1240, "damageTaken": 0, "progress": 1 }
//   }
//
// `result` is attached when the action finishes and is correlated by action id
// (the executor's epoch, which is unique per owned action). The `calibration`
// block carries predicted confidence next to the observed outcome for every
// question that reported a confidence, which is precisely what a reliability
// diagram consumes: bin by predicted confidence, measure the empirical success
// rate in each bin.
import { createHash } from 'node:crypto'
import type { Candidate } from './candidates.ts'
import type { GatedScore } from './gating.ts'
import type { GoalQueueStateLog } from './goalQueue.ts'
import { booleanEstimates } from './jev.ts'
import type { BooleanEstimate, JevAnswer, JevPolicyKind, JevQuestionType, JevSource, JevUsage } from './jev.ts'
import type { DecisionTrigger } from './scheduler.ts'
import type { WorldState } from './state.ts'
import type { LlmSummonReason } from './system2.ts'

export interface DecisionCandidateLog {
  id: string
  kind: string
  label: string
  targetName: string | null
  inReach: boolean
  failedCount: number
  /** #56: deterministic Skill attribution within the active Option. */
  optionSkill: string | null
}

export interface DecisionJevLog {
  policy: JevPolicyKind
  source: JevSource
  model: string
  callId: string
  latencyMs: number
  usage: JevUsage | null
  answers: Record<string, JevAnswer>
  dangerGate: GatedScore
  trigger: DecisionTrigger
}

export interface CalibrationEntry {
  question: string
  type: JevQuestionType
  /** calibrated confidence the provider reported for this question */
  predictedConfidence: number | null
  answerValue: string | number | null
  /** score answers: nearest level label */
  level: string | null
  /** observed outcome of the correlated action; null until it completes */
  observedSuccess: boolean | null
  observedDamageTaken: number | null
  observedProgress: number | null
}

export interface DecisionResultLog {
  actionId: string
  success: boolean
  durationMs: number
  damageTaken: number
  progress: number
  status: string
  failureCode: string | null
  verified: boolean
  blockRemoved: boolean
  dropObserved: boolean
}

/** Whether Jev's `need_llm` interrupt woke System 2 for this decision, and why. */
export interface DecisionLlmResummonLog {
  triggered: boolean
  reason: LlmSummonReason | null
  detail: string | null
}

/**
 * Hard LLM accounting for the decision. `called` is true only when the
 * long-horizon brain was actually invoked during this tick; the M1 acceptance
 * gate requires it to be false on every record. `planCalls` counts the one-time
 * bootstrap plan provision and `runtimeCalls` every exception-driven summon.
 */
export interface DecisionLlmLog {
  called: boolean
  runtimeCalls: number
  planCalls: number
}

/** A subgoal-queue transition observed during this tick, with the live inventory. */
export interface DecisionSubgoalLog {
  fromId: string | null
  fromDescription: string | null
  toId: string | null
  toDescription: string | null
  trigger: DecisionTrigger
  inventory: Record<string, number>
}

export interface DecisionRecord {
  record: 'decision'
  decisionId: string
  ts: string
  stateHash: string
  tick: number
  trigger: DecisionTrigger
  source: JevSource
  /** #36: stable causal chain id linking plan/Option -> candidate -> action -> VERIFY */
  chainId: string | null
  /** #36: OptionSpec id compiled from the plan row driving this decision */
  optionId: string | null
  /** #36: high-level strategy/plan provenance that produced the row */
  strategy: string | null
  candidates: DecisionCandidateLog[]
  jev: DecisionJevLog
  chosenAction: string
  confidence: number | null
  /** set only when a danger override replaced the Jev action */
  dangerOverride: string | null
  /** Jev's raw P(need_llm=true); null when the answer was absent */
  needLlm: number | null
  /** true when P(need_llm) >= NEED_LLM_THRESHOLD - Jev's interrupt line to System 2 */
  needLlmAdopted: boolean
  /** #32: every boolean answer as a raw probability + named threshold (0.08 stays 0.08) */
  booleanEstimates: Record<string, BooleanEstimate>
  /** the goal queue as Jev saw it (depth + current goal) */
  goalQueueState: GoalQueueStateLog
  /** whether an LLM re-summon was triggered by this decision, and why */
  llmResummon: DecisionLlmResummonLog
  /** hard LLM call accounting for this decision (M1 gate: called === false) */
  llm: DecisionLlmLog
  /** subgoal transition caused by the action this tick observed, if any */
  subgoal: DecisionSubgoalLog | null
  /** live inventory counts as Jev saw them */
  inventory: Record<string, number>
  calibration: CalibrationEntry[]
  result: DecisionResultLog | null
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) out[key] = canonicalize(record[key])
    return out
  }
  return value
}

/**
 * A stable hash of the world state: canonical key order, wall-clock
 * `timestampMs` excluded so two sensors observing the same world collide.
 */
export function stableStateHash(state: WorldState): string {
  const stable: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(state)) {
    if (key === 'timestampMs') continue
    stable[key] = value
  }
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(stable))).digest('hex')}`
}

export function logCandidates(
  candidates: readonly Candidate[],
  failedCandidates: Record<string, number>,
): DecisionCandidateLog[] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    kind: candidate.kind,
    label: candidate.label,
    targetName: candidate.targetName,
    inReach: candidate.inReach,
    failedCount: failedCandidates[candidate.id] ?? 0,
    optionSkill: typeof candidate.meta.optionSkill === 'string' ? candidate.meta.optionSkill : null,
  }))
}

export function buildCalibration(
  answers: Record<string, JevAnswer>,
  outcome: { success: boolean; damageTaken: number; progress: number } | null,
): CalibrationEntry[] {
  return Object.values(answers).map((answer) => ({
    question: answer.name,
    type: answer.type,
    predictedConfidence: answer.confidence,
    answerValue: answer.value,
    level:
      answer.type === 'score' && answer.legend !== null && typeof answer.value === 'number'
        ? answer.legend[Math.max(0, Math.min(answer.legend.length - 1, Math.round(answer.value)))] ?? null
        : null,
    observedSuccess: outcome === null ? null : outcome.success,
    observedDamageTaken: outcome === null ? null : outcome.damageTaken,
    observedProgress: outcome === null ? null : outcome.progress,
  }))
}

export interface DecisionRecordInput {
  decisionId: string
  tick: number
  trigger: DecisionTrigger
  stateHash: string
  chainId?: string | null
  optionId?: string | null
  strategy?: string | null
  candidates: readonly Candidate[]
  failedCandidates: Record<string, number>
  jev: DecisionJevLog
  chosenAction: string
  confidence: number | null
  dangerOverride: string | null
  needLlm: number | null
  needLlmAdopted: boolean
  goalQueueState: GoalQueueStateLog
  llmResummon: DecisionLlmResummonLog
  llm: DecisionLlmLog
  subgoal: DecisionSubgoalLog | null
  inventory: Record<string, number>
}

export function makeDecisionRecord(input: DecisionRecordInput): DecisionRecord {
  return {
    record: 'decision',
    decisionId: input.decisionId,
    ts: new Date().toISOString(),
    stateHash: input.stateHash,
    tick: input.tick,
    trigger: input.trigger,
    source: input.jev.source,
    chainId: input.chainId ?? null,
    optionId: input.optionId ?? null,
    strategy: input.strategy ?? null,
    candidates: logCandidates(input.candidates, input.failedCandidates),
    jev: input.jev,
    chosenAction: input.chosenAction,
    confidence: input.confidence,
    dangerOverride: input.dangerOverride,
    needLlm: input.needLlm,
    needLlmAdopted: input.needLlmAdopted,
    booleanEstimates: booleanEstimates(input.jev.answers),
    goalQueueState: input.goalQueueState,
    llmResummon: input.llmResummon,
    llm: input.llm,
    subgoal: input.subgoal,
    inventory: input.inventory,
    calibration: buildCalibration(input.jev.answers, null),
    result: null,
  }
}

export function attachResult(
  record: DecisionRecord,
  result: Omit<DecisionResultLog, 'success'> & { success: boolean },
): void {
  record.result = { ...result }
  record.calibration = buildCalibration(record.jev.answers, {
    success: result.success,
    damageTaken: result.damageTaken,
    progress: result.progress,
  })
}
