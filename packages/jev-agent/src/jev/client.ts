// jev.ts - the JEV POLICY layer.
//
// One interface, two implementations:
//
//   * TypeSafeJevPolicy - the real thing, wired to the *proven* path:
//
//       ai (v7) -> experimental_evaluate({ model: 'typesafe-ai/jev', state, questions })
//
//     Many questions are batched into ONE call (action / mine_target /
//     combat_target / danger / route_danger / goal_progress / need_replan)
//     and only the answers we need are adopted. The primary question is a
//     *grounded macro-action choice* whose labels are the deterministic
//     candidate ids that actually exist right now.
//
//   * FallbackJevPolicy - a clearly-marked deterministic local policy used ONLY
//     when the caller explicitly opts in (`forceFallback: true`, wired from
//     `BUDDY_POLICY=fallback` for offline/CI). A model failure never selects it:
//     `createJevPolicy` throws a FatalModelError when no key resolves, and the
//     controller turns an exhausted Jev call into a FATAL + process exit.
//
// Verified SDK facts this file encodes:
//   * `experimental_evaluate` question types are `choice` | `score` | `boolean`.
//     There is NO `noul` type on this path.
//   * probabilities are rounded to `rounding.probabilityDecimals` (2 by default);
//     `usage.inputTokens` / `usage.outputTokens` are available.
//   * `providerMetadata.typesafe.confidence[questionId]` carries TypeSafe's
//     *calibrated* per-question confidence. This is NOT distribution sharpness
//     and NOT an accuracy claim - it must be validated against real outcomes,
//     which is exactly what the decision log in `decisionlog.ts` records
//     (predicted confidence vs observed action result) for a reliability diagram.
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { experimental_evaluate as evaluate } from 'ai'
import type { Experimental_EvaluationQuestion } from 'ai'
import type { Candidate } from '../candidates.ts'
import { FatalModelError } from '../modelFailure.ts'
import type { WorldState } from '../state.ts'

type EvaluateArgs = Parameters<typeof evaluate>[0]
type EvaluationState = EvaluateArgs['state']
type EvaluationQuestion = Experimental_EvaluationQuestion

/**
 * Who produced the action answers.
 *
 * `reflex` is the code-owned hard-safety reflex (issue #436 section B): a
 * uniquely-determined action for an immediate safety fact, executed by
 * deterministic code WITHOUT a model call. It is a distinct provenance on
 * purpose, so a reviewer can separate "Jev chose" (`typesafe`) from
 * "deterministic fallback answered" (`fallback`) from "code finished a
 * uniquely-determined safety action" (`reflex`).
 */
export type JevPolicyKind = 'typesafe' | 'fallback' | 'reflex'

/** Where the answer came from, for the decision log. */
export type JevSource = 'jev' | 'fallback' | 'reflex'

export type JevQuestionType = 'choice' | 'score' | 'boolean'

export interface JevAnswer {
  name: string
  type: JevQuestionType
  /**
   * choice: the selected option id.
   * score: the fractional position in [0, levels-1].
   * boolean: P(true), in [0, 1].
   */
  value: string | number
  /** probability mass on `value`, when the primitive exposes a distribution */
  probability: number | null
  /**
   * TypeSafe's *calibrated* per-question confidence
   * (`providerMetadata.typesafe.confidence[name]`). null when the provider did
   * not report one (e.g. boolean questions) or for the rule-based fallback.
   * Never assume it is "distribution sharpness" - validate it against outcomes.
   */
  confidence: number | null
  probabilities: Record<string, number> | null
  /** score: the ordered level labels the fractional score indexes into */
  legend: string[] | null
  note: string | null
}

export interface JevUsage {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
}

export interface JevResult {
  callId: string
  policy: JevPolicyKind
  source: JevSource
  model: string
  latencyMs: number
  usage: JevUsage | null
  answers: Record<string, JevAnswer>
  /** Number of actual model-provider evaluate attempts; absent for legacy/offline policies. */
  providerAttempts?: number
  /** Serving backend provider/profile (provenance); absent for legacy/offline policies. */
  provider?: string
  profileId?: string
}

export interface JevRequest {
  stage: string
  state: WorldState
  candidates: readonly Candidate[]
  /** Internal telemetry hook called immediately before each model-provider evaluate attempt. */
  onProviderAttempt?: () => void
  /** Bounded V4 authority frame for a non-Option choice such as grounded Reach routing. */
  decisionFrame?: {
    readonly kind: 'vtr-reach-route'
    readonly instructions: string
    readonly context: Readonly<Record<string, unknown>>
  }
  /** CORE + trigger-specific set to send; defaults to the full set. */
  questionNames?: readonly QuestionName[]
  /**
   * Issue #437: the versioned, bounded semantic projection Jev consumes instead
   * of the primitive trace, plus its hash. Optional so every legacy/offline
   * caller and fixture keeps working unchanged; when present the authority
   * kernel ships it as the model's semantic state.
   */
  semanticProjection?: unknown | null
  projectionHash?: string | null
  /** §7.1 evidence: which semantic boundary authorized this provider call. */
  decisionReason?: string
}

export interface JevPolicy {
  readonly kind: JevPolicyKind
  readonly model: string
  /** Serving backend provider/profile of a model-authoritative policy (provenance only). */
  readonly provider?: string
  readonly profileId?: string
  decide(request: JevRequest, signal?: AbortSignal): Promise<JevResult>
}

export class JevPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JevPolicyError'
  }
}

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

/** Append-only JSONL sink. One record per line, flushed per write. */
export class JsonlWriter {
  readonly path: string

  constructor(path: string) {
    this.path = path
    mkdirSync(dirname(path), { recursive: true })
    // Materialize an empty journal immediately so no-call runs still have a
    // real, hashable artifact covering the writer's lifetime. Append mode
    // preserves existing bytes if a caller deliberately reopens a sink.
    closeSync(openSync(path, 'a'))
  }

  write(record: unknown): void {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`)
  }
}

export interface JevCallRecord {
  record: 'jev-call'
  callId: string
  ts: string
  policy: JevPolicyKind
  model: string
  stage: string
  /** Cumulative number of entered provider evaluate calls in this decision; absent in older/offline records. */
  providerAttempts?: number
  latencyMs: number
  /** rate-limit retries already consumed before this successful attempt */
  rateLimitRetries: number
  /** cumulative backoff slept before this attempt (excluded from latencyMs) */
  rateLimitWaitMs: number
  /** bounded perception snapshot persisted for evidence (the model receives `toEvaluationState`) */
  state: unknown
  questions: unknown
  response: { model: string; usage: unknown; answers: Record<string, JevAnswer> } | null
  error: string | null
}

export interface JevRetryRecord {
  record: 'jev-retry'
  callId: string
  ts: string
  attempt: number
  delayMs: number
  totalWaitMs: number
  error: string
  /** Cumulative entered provider evaluate calls; a scheduled retry is not itself an attempt. */
  providerAttempts?: number
}

export interface JevOutcomeRecord {
  record: 'jev-outcome'
  callId: string
  ts: string
  policy: JevPolicyKind
  actionId: string | null
  executed: boolean
  verified: boolean
  failureCode: string | null
  goalProgress: number
  note: string
}

export type AgentLevel = 'info' | 'warn' | 'error'

export interface AgentEventRecord {
  record: 'agent-event'
  ts: string
  tick: number | null
  source: string
  level: AgentLevel
  message: string
  detail: Record<string, unknown>
}

/**
 * Human-readable console output + machine-readable JSONL in one call, so the
 * recorded run and the log file always tell the same story.
 */
export class EventLogger {
  private readonly writer: JsonlWriter | null
  private readonly echo: boolean

  constructor(writer: JsonlWriter | null, echo: boolean) {
    this.writer = writer
    this.echo = echo
  }

  log(
    source: string,
    level: AgentLevel,
    message: string,
    detail: Record<string, unknown> = {},
    tick: number | null = null,
  ): void {
    if (this.echo) {
      const suffix = Object.keys(detail).length > 0 ? ` ${JSON.stringify(detail)}` : ''
      process.stdout.write(`[${source}] ${message}${suffix}\n`)
    }
    if (this.writer !== null) {
      const record: AgentEventRecord = {
        record: 'agent-event',
        ts: new Date().toISOString(),
        tick,
        source,
        level,
        message,
        detail,
      }
      this.writer.write(record)
    }
  }

  info(source: string, message: string, detail: Record<string, unknown> = {}, tick: number | null = null): void {
    this.log(source, 'info', message, detail, tick)
  }

  warn(source: string, message: string, detail: Record<string, unknown> = {}, tick: number | null = null): void {
    this.log(source, 'warn', message, detail, tick)
  }

  error(source: string, message: string, detail: Record<string, unknown> = {}, tick: number | null = null): void {
    this.log(source, 'error', message, detail, tick)
  }
}

// ---------------------------------------------------------------------------
// the batched question set
// ---------------------------------------------------------------------------

export const PRIMARY_INSTRUCTIONS =
  'You are the local policy head of a Minecraft bot. Choose exactly ONE id from the ' +
  'action list: the single best macro-action for the bot to execute right now. Every id ' +
  'refers to a concrete target that exists in the supplied world state. Answer with the id ' +
  'verbatim; never invent an id. The id already embeds its target (e.g. MINE:b12_64_8, ' +
  'MOVE:p3_64_8, CRAFT:oak_planks); do NOT answer a separate target. The state field ' +
  'signals.failedCandidates maps candidate ids to how many times they recently failed, so ' +
  'prefer an id with no recorded failures. The state field goalQueue is the long-horizon ' +
  'plan from System 2: follow its current goal while plan_still_valid is high.'

/**
 * Boolean answers have NO calibrated per-outcome confidence: the primitive only
 * exposes a probability. A boolean is therefore read as a probability band, never
 * as `threshold + providerMetadata.confidence`.
 *
 *   p <= 0.30  -> strong false
 *   p >= 0.70  -> strong true
 *   in between -> uncertain (keep the current safe action on the first hit;
 *                 escalate only when uncertainty repeats or stacks with a
 *                 no-progress / deterministic anomaly)
 */
export const BOOLEAN_LOW = 0.3
export const BOOLEAN_HIGH = 0.7

export const GOAL_PROGRESS_LEVELS = [
  'no progress toward the goal',
  'barely started (<25%)',
  'about a quarter done',
  'about half done',
  'nearly or fully complete',
] as const

/** Ordered danger levels. `score` is the fractional position in this list. */
export const DANGER_LEVELS = ['safe', 'minor risk', 'dangerous', 'lethal'] as const

/** Ordered plan-validity levels for the core `plan_still_valid` score. */
export const PLAN_VALID_LEVELS = [
  'plan is broken',
  'plan is mostly broken',
  'plan is questionable',
  'plan is mostly valid',
  'plan is valid',
] as const

/** Ordered situation-comprehension levels for the core `situation_understood` score. */
export const SITUATION_LEVELS = [
  'situation is not understood',
  'mostly unfamiliar',
  'partially understood',
  'mostly understood',
  'fully understood',
] as const

/**
 * §6/§18-D typed-head contract. All requested heads are answered in ONE batched
 * evaluate() over the same canonical DecisionState; no head sees another's
 * answer, so every consumer is a code-owned deterministic gate, never a
 * head-to-head inference chain.
 *
 *   head             | type   | set      | consumer                       | authority boundary
 *   -----------------|--------|----------|--------------------------------|------------------------------
 *   action           | Choice | always   | decisionIdFrom -> commitment   | the ONLY actuation authority:
 *                    |        |          |  -> guard -> executor lease    | it embeds its grounded target;
 *                    |        |          |                                | no other head can name a
 *                    |        |          |                                | candidate or dispatch a Skill.
 *   abandon_option   | Noul   | always   | abandonRequested -> verdict -> | WHETHER only: ends the active
 *                    |        |          |  applyAbandon (threshold +     | Option; never selects WHICH
 *                    |        |          |  deferral/cooldown gates)      | candidate or forces success.
 *   danger           | Score  | threat   | gateDanger -> decision journal | calibration evidence only:
 *                    |        | trigger  |  (dangerGate band/confidence)  | no actuation consumer.
 *   should_retreat   | Noul   | threat   | shouldRetreatFrom band ->      | calibration evidence only:
 *                    |        | trigger  |  decision journal              | no actuation consumer.
 *   SHADOW_*         | -      | never    | none                           | defined for offline replay
 *                    |        |          |                                | only; not in QUESTION_NAMES,
 *                    |        |          |                                | so they cannot be requested.
 *   vtr-reach-route  | frame  | explicit | VTR reach route decision       | journaled `jev-policy-input`;
 *                    |        | caller   | policy (not pi/beta authority) | separate contract, no Option
 *                    |        |          |                                | or actuation authority.
 *
 * An unused or evidence-only head answer cannot execute anything: the only
 * path from answers to mutation is `decisionIdFrom(result.answers.action)`.
 */
export const AUTHORITATIVE_QUESTION_NAMES = ['action', 'abandon_option'] as const

/**
 * §18 Gate F: a System One `Choice` requires at least two labels, and §6/§18
 * forbids skipping the model merely because the grounded offer is a singleton.
 * A one-candidate offer is still a real judgment - "the sole grounded action,
 * or the Option cannot proceed as offered" - so singleton Choices carry an
 * explicit DECLINE label as the second leg. DECLINE is never an actuation: it
 * is beta-form evidence that the sole means was refused, routed to the abandon
 * verdict (`actionDeclined`). It is NOT a resurrected WAIT/ESCALATE control -
 * it cannot extend a dead option; it only ends it. Added ONLY to singleton
 * Choices; with >=2 candidates WHICH is already a real question.
 */
export const ACTION_DECLINE_LABEL = 'DECLINE'
export const SAFETY_QUESTION_NAMES = ['danger', 'should_retreat'] as const
/**
 * Demoted to shadow metrics (issue #11): still defined and logged by code, but
 * never sent as steering questions and never consumed by the controller.
 */
export const SHADOW_QUESTION_NAMES = [
  'goal_progress',
  'plan_still_valid',
  'situation_understood',
  'goal_blocked',
  'strategy_change_needed',
] as const
export const QUESTION_NAMES = [...AUTHORITATIVE_QUESTION_NAMES, ...SAFETY_QUESTION_NAMES] as const

export type QuestionName = (typeof QUESTION_NAMES)[number]
export type ShadowQuestionName = (typeof SHADOW_QUESTION_NAMES)[number]
export type QuestionSetKind = 'core' | 'threat' | 'stall' | 'all'

export const ABANDON_THRESHOLD_DEFAULT = 0.5

/**
 * `BUDDY_ABANDON_THRESHOLD` overrides the binary beta threshold for replans;
 * otherwise the caller's explicit/model-calibrated `fallback`, otherwise the
 * historical default. Thresholds never silently transfer between models.
 */
export function resolveAbandonThreshold(fallback: number = ABANDON_THRESHOLD_DEFAULT): number {
  const raw = Number(process.env.BUDDY_ABANDON_THRESHOLD)
  if (Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw
  return fallback
}

/** Resolve a trigger class to the exact question set that is sent. */
export function questionNamesFor(kind: QuestionSetKind): readonly QuestionName[] {
  switch (kind) {
    case 'core':
      return AUTHORITATIVE_QUESTION_NAMES
    case 'threat':
      return [...AUTHORITATIVE_QUESTION_NAMES, ...SAFETY_QUESTION_NAMES]
    case 'stall':
      return AUTHORITATIVE_QUESTION_NAMES
    case 'all':
      return QUESTION_NAMES
  }
}

/** Every question is optional: only the requested set is present in a call. */
export type JevQuestions = Partial<Record<QuestionName, EvaluationQuestion>>

/**
 * Prompt strategy: ONE batched evaluation of the CORE + trigger-specific set.
 * `action` is the primary, grounded macro-action choice (labels are real
 * candidate ids that already embed their target). The scores/booleans are the
 * semantic facts the deterministic controller integrates.
 */
export function buildQuestions(
  candidates: readonly Candidate[],
  names: readonly QuestionName[] = QUESTION_NAMES,
): JevQuestions {
  const actionCriteria: Record<string, string> = {}
  for (const candidate of candidates) actionCriteria[candidate.id] = candidate.label
  // §18 Gate F: same singleton-offer DECLINE leg as buildAuthorityQuestions.
  if (candidates.length === 1) {
    actionCriteria[ACTION_DECLINE_LABEL] = 'decline the only grounded action: this Option cannot proceed as offered'
  }

  const all: Record<QuestionName, EvaluationQuestion> = {
    action: {
      type: 'choice',
      instructions: PRIMARY_INSTRUCTIONS,
      criteria: actionCriteria,
    },
    abandon_option: {
      type: 'boolean',
      instructions:
        'Should the current Option (the current subgoal/plan) be abandoned and replanned now, given ' +
        'the live inventory, tool rank and repeated failures? Answer with P(true). Code owns ' +
        'preconditions and success predicates; this is the only vote on whether to give up on the option.',
      criteria: {
        true: 'abandon the current option and hand control back for a replan',
        false: 'keep pursuing the current option',
      },
    },
    danger: {
      type: 'score',
      instructions:
        'How dangerous is the current situation for the bot right now? Use the ordered ' +
        'levels from safe to lethal. Judge only immediate physical danger (lava, fire, ' +
        'hostile mob in melee range, very low health, deep drop).',
      criteria: [...DANGER_LEVELS],
    },
    should_retreat: {
      type: 'boolean',
      instructions:
        'Should the bot break off what it is doing and move away to safety right now? ' +
        'Answer true only for immediate physical danger, not for a merely inconvenient target.',
      criteria: {
        true: 'retreat to safety now',
        false: 'the current action is safe enough to continue',
      },
    },
  }

  const out: JevQuestions = {}
  for (const name of names) out[name] = all[name]
  return out
}

/**
 * The id the model selected for the primary question, or null if unusable.
 * `action` is the ONLY authoritative choice: the target lives inside the
 * grounded candidate id, so the executor never composes action + target answers.
 */
export function decisionIdFrom(result: JevResult): string | null {
  const answer = result.answers.action
  if (answer === undefined) return null
  if (answer.type !== 'choice') return null
  if (answer.value === ACTION_DECLINE_LABEL) return null // a decline is never an actuation
  return typeof answer.value === 'string' ? answer.value : null
}

/**
 * The model declined the sole grounded action on a singleton offer. That is a
 * beta-form vote ("this Option cannot proceed as offered"), never WHICH
 * authority - consumers must route it through the abandon verdict machinery.
 */
export function actionDeclined(result: JevResult): boolean {
  const answer = result.answers.action
  return answer?.type === 'choice' && answer.value === ACTION_DECLINE_LABEL
}

export function sourceOf(policy: JevPolicyKind): JevSource {
  if (policy === 'typesafe') return 'jev'
  return policy === 'reflex' ? 'reflex' : 'fallback'
}

export type BooleanBand = 'strong_false' | 'uncertain' | 'strong_true'

/** Map a boolean answer's P(true) to the 0.30/0.70 band. */
export function booleanBand(probability: number | null | undefined): BooleanBand | null {
  if (typeof probability !== 'number') return null
  if (probability >= BOOLEAN_HIGH) return 'strong_true'
  if (probability <= BOOLEAN_LOW) return 'strong_false'
  return 'uncertain'
}

/** Adopt `should_retreat` only on a strong-true band; uncertainty keeps the current action. */
export function shouldRetreatFrom(result: JevResult): boolean {
  return booleanBand(result.answers.should_retreat?.probability) === 'strong_true'
}

// ---------------------------------------------------------------------------
// defensive parsing of the raw evaluate() response
// ---------------------------------------------------------------------------

function mapChoiceAnswer(name: string, answer: unknown, confidence: number | null): JevAnswer {
  const probabilities = readNumberRecord(answer, 'probabilities') ?? {}
  const selected = readString(answer, 'choice')
  if (selected === null) {
    throw new JevPolicyError(`choice answer "${name}" was malformed: ${safeJson(answer)}`)
  }
  return {
    name,
    type: 'choice',
    value: selected,
    probability: probabilities[selected] ?? null,
    confidence,
    probabilities,
    legend: null,
    note: null,
  }
}

function mapScoreAnswer(name: string, answer: unknown, legend: readonly string[], confidence: number | null): JevAnswer {
  const value = readNumber(answer, 'score')
  if (value === null) {
    throw new JevPolicyError(`score answer "${name}" was malformed: ${safeJson(answer)}`)
  }
  return {
    name,
    type: 'score',
    value,
    probability: null,
    confidence,
    probabilities: readNumberRecord(answer, 'probabilities') ?? {},
    legend: [...legend],
    note:
      confidence === null
        ? 'provider reported no confidence for this score; a score without certainty is never acted on'
        : null,
  }
}

function mapBooleanAnswer(name: string, answer: unknown, confidence: number | null): JevAnswer {
  const value = readNumber(answer, 'probability')
  if (value === null) {
    throw new JevPolicyError(`boolean answer "${name}" was malformed: ${safeJson(answer)}`)
  }
  return {
    name,
    type: 'boolean',
    value,
    probability: value,
    confidence,
    probabilities: { true: value, false: 1 - value },
    legend: null,
    note: 'boolean probability is P(true), not confidence in either outcome',
  }
}

const SCORE_LEGENDS: Partial<Record<QuestionName, readonly string[]>> = {
  danger: DANGER_LEVELS,
}

/** Whether the model's `abandon_option` beta crosses the replan threshold. */
export function abandonRequested(result: JevResult, threshold = resolveAbandonThreshold()): boolean {
  const probability = result.answers.abandon_option?.probability
  return typeof probability === 'number' && probability >= threshold
}

// ---------------------------------------------------------------------------
// #32: keep the raw Boolean probability, never collapse it to `> 0.5`
// ---------------------------------------------------------------------------

/**
 * A boolean answer kept as a probability plus the derived booleans, so the raw
 * value survives API parse -> internal result -> JSONL. `0.51` and `0.99` stay
 * distinguishable, and so do `0.01` and `0.49`; `atHalf` is the legacy `> 0.5`
 * view, `would` is this question's own named threshold.
 */
export interface BooleanEstimate {
  /** raw P(true), exactly as the primitive returned it */
  probability: number
  /** the old binary view (probability >= 0.5), kept for existing consumers */
  atHalf: boolean
  /** the named, configurable threshold applied to this question */
  threshold: number
  /** the decision at `threshold`; authority is never granted implicitly */
  would: boolean
}

/** One boolean question's estimate, or null when no usable probability exists. */
export function booleanEstimate(probability: number | null | undefined, threshold: number): BooleanEstimate | null {
  if (typeof probability !== 'number' || !Number.isFinite(probability)) return null
  return { probability, atHalf: probability >= 0.5, threshold, would: probability >= threshold }
}

/** The named thresholds for the boolean questions. Raw P(true) is always kept. */
export function booleanThresholds(): Record<string, number> {
  return {
    abandon_option: resolveAbandonThreshold(),
    should_retreat: BOOLEAN_HIGH,
  }
}

/**
 * Every boolean answer as a raw-probability estimate. Score/choice answers are
 * skipped: this block exists only so a 0.08 never becomes an indistinguishable
 * `false` in the decision record (#32). Unknown questions default to 0.5.
 */
export function booleanEstimates(
  answers: Record<string, JevAnswer>,
  thresholds: Record<string, number> = booleanThresholds(),
): Record<string, BooleanEstimate> {
  const out: Record<string, BooleanEstimate> = {}
  for (const [name, answer] of Object.entries(answers)) {
    if (answer.type !== 'boolean') continue
    const raw =
      typeof answer.probability === 'number'
        ? answer.probability
        : typeof answer.value === 'number'
          ? answer.value
          : null
    const estimate = booleanEstimate(raw, thresholds[name] ?? 0.5)
    if (estimate !== null) out[name] = estimate
  }
  return out
}

// ---------------------------------------------------------------------------
// #22: beta (`abandon_option`) SHADOW comparison
// ---------------------------------------------------------------------------

export type BetaVerdict = 'abandon' | 'continue'

/**
 * The comparable pair per decision: what beta WOULD have decided (raw
 * probability + named threshold) next to what the controller actually did.
 * Agreement is measurable offline; `actual` is never derived from beta itself
 * when beta is in shadow mode.
 */
export interface BetaShadow {
  optionId: string | null
  beta: number | null
  threshold: number
  would: BetaVerdict
  actual: BetaVerdict
  agree: boolean
}

export interface BetaShadowInput {
  optionId: string | null
  beta: number | null
  actualReplan: boolean
  threshold?: number
}

export function betaShadowDecision(input: BetaShadowInput): BetaShadow {
  const threshold = input.threshold ?? resolveAbandonThreshold()
  const would: BetaVerdict = input.beta !== null && input.beta >= threshold ? 'abandon' : 'continue'
  const actual: BetaVerdict = input.actualReplan ? 'abandon' : 'continue'
  return { optionId: input.optionId, beta: input.beta, threshold, would, actual, agree: would === actual }
}

/** `BETA_SHADOW option=<id> beta=<p> threshold=<t> would=<abandon|continue> actual=<...>` */
export function formatBetaShadow(shadow: BetaShadow): string {
  return (
    `BETA_SHADOW option=${shadow.optionId ?? 'null'} beta=${shadow.beta ?? 'null'} ` +
    `threshold=${shadow.threshold} would=${shadow.would} actual=${shadow.actual}`
  )
}

/** Map exactly one requested question's raw answer to the defensive JevAnswer shape. */
function mapAnswer(name: QuestionName, raw: unknown, providerMetadata: unknown): JevAnswer {
  const confidence = readCalibratedConfidence(providerMetadata, name)
  const legend = SCORE_LEGENDS[name]
  if (legend !== undefined) return mapScoreAnswer(name, raw, legend, confidence)
  if (name === 'action') return mapChoiceAnswer(name, raw, confidence)
  return mapBooleanAnswer(name, raw, confidence)
}

function member(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined
  return (source as Record<string, unknown>)[key]
}

function readNumber(source: unknown, key: string): number | null {
  const value = member(source, key)
  return typeof value === 'number' ? value : null
}

function readString(source: unknown, key: string): string | null {
  const value = member(source, key)
  return typeof value === 'string' ? value : null
}

function readNumberRecord(source: unknown, key: string): Record<string, number> | null {
  const value = member(source, key)
  if (typeof value !== 'object' || value === null) return null
  const out: Record<string, number> = {}
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue === 'number') out[entryKey] = entryValue
  }
  return out
}

/**
 * TypeSafe's calibrated per-question confidence lives in
 * `providerMetadata.typesafe.confidence[questionId]`. Shape-checked, never trusted.
 */
function readCalibratedConfidence(providerMetadata: unknown, name: string): number | null {
  const typesafe = member(providerMetadata, 'typesafe')
  const confidence = member(typesafe, 'confidence')
  const value = member(confidence, name)
  return typeof value === 'number' ? value : null
}

function readUsage(usage: unknown): JevUsage | null {
  if (typeof usage !== 'object' || usage === null) return null
  return {
    inputTokens: readNumber(usage, 'inputTokens'),
    outputTokens: readNumber(usage, 'outputTokens'),
    totalTokens: readNumber(usage, 'totalTokens'),
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return safeJson(error)
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '<unserialisable>'
  }
}

// ---------------------------------------------------------------------------
// real policy: ai v7 experimental_evaluate -> typesafe-ai/jev
// ---------------------------------------------------------------------------

/** The proven gateway key location. Read-only; the value is never logged. */
export const JEV_KEY_FILE = '/home/s0u7a/.config/kimaki-secrets/vercel-ai-gateway.key'

export const DEFAULT_JEV_MODEL = 'typesafe-ai/jev'

/**
 * #11 role split. Jev (pi/beta) owns grounded action choice and keeps
 * `DEFAULT_JEV_MODEL` — it is not swappable for the LLM. Every *semantic*
 * upper-layer role is the LLM side and shares this default: the System2 planning
 * authority, Mercury plan repair, and the advisor. They must not silently fall
 * back to Jev's model, which would collapse the two authorities into one.
 * Override per role with BUDDY_PLANNER_MODEL / BUDDY_MERCURY_MODEL /
 * BUDDY_ADVISOR_MODEL.
 */
export const DEFAULT_LLM_MODEL = 'meta/muse-spark-1.3-contributor'

export interface KeyResolution {
  key: string
  /** human-readable description of where the key came from (never the key) */
  origin: string
}

/**
 * Resolve the gateway key from the 0600 file first, then the environment.
 * Returns null when neither is present, which selects the fallback policy.
 */
export function resolveJevApiKey(): KeyResolution | null {
  try {
    const key = readFileSync(JEV_KEY_FILE, 'utf8').trim()
    if (key.length > 0) return { key, origin: `file:${JEV_KEY_FILE}` }
  } catch {
    // fall through to the environment
  }
  const fromEnv = (process.env.AI_GATEWAY_API_KEY ?? '').trim()
  if (fromEnv.length > 0) return { key: fromEnv, origin: 'env:AI_GATEWAY_API_KEY' }
  return null
}

export interface JevPolicyOptions {
  writer: JsonlWriter
  /**
   * Gateway dialect only: null -> DEFAULT_JEV_MODEL / AI_GATEWAY_MODEL env
   * override. A direct backend profile pins its own model id.
   */
  model: string | null
  /** Typed Decision Plane backend profile id; unset -> BUDDY_DECISION_PROFILE / the committed default. */
  decisionProfile?: string | null
  timeoutMs: number
  maxRetries: number
  /** how many times a 429 gateway rate limit is retried before giving up */
  rateLimitRetries: number
  /** linear backoff base: attempt N sleeps base * N (excluded from latencyMs) */
  rateLimitBaseDelayMs: number
  /** force the local deterministic policy even when a key is present */
  forceFallback?: boolean
  /** credential resolver seam for tests; defaults to the selected profile's own resolver */
  resolveKey?: () => KeyResolution | null
  /**
   * §18 Gate F: explicit beta (abandon_option) adoption threshold. Unset ->
   * the selected profile's measured calibration, then the historical 0.5.
   */
  abandonThreshold?: number
}

/**
 * The AI SDK may wrap a 429 in an `AI_RetryError` (whose `lastError`/`errors`
 * hold the real cause), so the detection has to walk the chain.
 */
function isRateLimitError(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== 'object' || error === null) return false
  const record = error as Record<string, unknown>
  if (record.statusCode === 429) return true
  const name = record.name
  if (typeof name === 'string' && name.includes('RateLimit')) return true
  if (isRateLimitError(record.lastError, depth + 1)) return true
  if (isRateLimitError(record.cause, depth + 1)) return true
  const errors = record.errors
  return Array.isArray(errors) && errors.some((entry) => isRateLimitError(entry, depth + 1))
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Project the world state down to exactly the fields the policy reasons about.
 *
 * The full `WorldState` carries the sensor's own bookkeeping (inventory slots,
 * raw terrain samples, entity positions, the whole subgoal history, the clock),
 * which costs input tokens on every call without changing a single answer. The
 * candidate ids and their labels already carry the executable detail, so this
 * keeps the goal, the goal queue's current entry, the inventory counts, the
 * nearest entities/blocks and the failure memory, and drops the rest.
 */
function toEvaluationState(state: WorldState): EvaluationState {
  const compact = {
    tick: state.tick,
    self: {
      position: state.self.position,
      health: state.self.health,
      food: state.self.food,
      heldItem: state.self.heldItem,
    },
    inventory: state.inventory.counts,
    entities: state.entities.slice(0, 6).map((entity) => ({
      id: entity.id,
      name: entity.name,
      distance: entity.distance,
      hostile: entity.hostile,
      // P1 durability: a hostile's threat context must survive the compact
      // projection, otherwise the decision layer sees a name at a distance and
      // cannot tell an armed attacker with line of sight from a wandering mob.
      lineOfSight: entity.lineOfSight,
      heldItem: entity.heldItem,
      attackedSelf: entity.attackedSelf,
    })),
    blocks: state.blocks.map((block) => ({
      kind: block.kind,
      name: block.name,
      position: block.position,
      distance: block.distance,
      inReach: block.inReach,
      walkUp: block.hasAdjacentStandable,
    })),
    goal: {
      description: state.goal.description,
      targetItem: state.goal.targetItem,
      requiredCount: state.goal.requiredCount,
      haveCount: state.goal.haveCount,
      progress: state.goal.progress,
      complete: state.goal.complete,
    },
    goalQueue: {
      empty: state.goalQueue.empty,
      depth: state.goalQueue.depth,
      current: state.goalQueue.current === null
        ? null
        : {
            description: state.goalQueue.current.description,
            targetItem: state.goalQueue.current.targetItem,
            haveCount: state.goalQueue.current.haveCount,
            requiredCount: state.goalQueue.current.requiredCount,
          },
    },
    currentOption: state.currentOption ?? null,
    signals: {
      failedCandidates: state.signals.failedCandidates,
      escalationRecommended: state.signals.escalationRecommended,
      lastFailureCode: state.signals.lastFailureCode,
    },
  }
  // The AI SDK expects a plain JSON value; the compact object has no index
  // signature, so round-trip it through JSON (no `any`, no ts-ignore).
  return JSON.parse(JSON.stringify(compact)) as EvaluationState
}

/**
 * Bounds on the perception snapshot persisted in jev-calls.jsonl. Every call
 * used to embed the full WorldState (one measured record: 45 KB, 31 KB of it
 * `signals.knownResources` with 269 entries), which grew the evidence log to
 * ~4.7 GB and made it unreadable. The model payload (`toEvaluationState`) is
 * NOT derived from this: these limits only bound what is written to disk.
 */
export const JEV_SNAPSHOT_LIMITS = {
  /** hard ceiling on one serialised snapshot (bytes); over-budget states take the lean path */
  maxBytes: 32 * 1024,
  entities: 8,
  blocks: 32,
  terrain: 8,
  stations: 32,
  placementSpots: 8,
  descent: 6,
  cuts: 8,
  recentEvents: 8,
  failedCandidates: 48,
  knownResources: 48,
  goalQueueGoals: 8,
} as const

export type JevSnapshotLimits = typeof JEV_SNAPSHOT_LIMITS

function snapshotBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

function capRecord(record: Readonly<Record<string, number>>, limit: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(record).slice(0, limit)) out[key] = value
  return out
}

function snapshotBounds(state: WorldState): Record<string, number> {
  return {
    entities: state.entities.length,
    blocks: state.blocks.length,
    terrain: state.terrain.standable.length,
    craftingTables: state.craftingTables.length,
    furnaces: state.furnaces?.length ?? 0,
    placementSpots: state.placementSpots.length,
    knownResources: state.signals.knownResources?.length ?? 0,
    failedCandidates: Object.keys(state.signals.failedCandidates).length,
    goalQueueGoals: state.goalQueue.goals.length,
  }
}

/**
 * Project the full WorldState down to a size-bounded evidence snapshot: long
 * arrays are capped (their true lengths survive in `bounds`) while the
 * decision-critical fields - self, inventory counts, goal, current queue entry,
 * stations with their `sensed`/`remembered` source, failed-candidate memory -
 * are kept. Falls back to a scalars-and-counts frame when even the capped form
 * exceeds the byte budget, so one record can never be unbounded.
 */
export function boundedStateSnapshot(
  state: WorldState,
  limits: JevSnapshotLimits = JEV_SNAPSHOT_LIMITS,
): unknown {
  // `zeroProgressRoutes` is code-owned internal retry memory: its facts already
  // reach the model as the offered/withheld candidate set, so the raw ledger is
  // never shipped (it would only grow the prompt).
  const { zeroProgressRoutes: _zeroProgressRoutes, ...promptSignals } = state.signals
  const bounded = {
    schemaVersion: state.schemaVersion,
    tick: state.tick,
    timestampMs: state.timestampMs,
    self: state.self,
    inventory: { counts: state.inventory.counts, totalItems: state.inventory.totalItems },
    entities: state.entities.slice(0, limits.entities),
    blocks: state.blocks.slice(0, limits.blocks),
    terrain: { standable: state.terrain.standable.slice(0, limits.terrain) },
    craftingTables: state.craftingTables.slice(0, limits.stations),
    furnaces: (state.furnaces ?? []).slice(0, limits.stations),
    placementSpots: state.placementSpots.slice(0, limits.placementSpots),
    descent: (state.descent ?? []).slice(0, limits.descent),
    stepCuts: (state.stepCuts ?? []).slice(0, limits.cuts),
    headroomCuts: (state.headroomCuts ?? []).slice(0, limits.cuts),
    goal: state.goal,
    goalQueue: { ...state.goalQueue, goals: state.goalQueue.goals.slice(0, limits.goalQueueGoals) },
    currentOption: state.currentOption ?? null,
    recentEvents: state.recentEvents.slice(-limits.recentEvents),
    signals: {
      ...promptSignals,
      knownResources: (state.signals.knownResources ?? []).slice(0, limits.knownResources),
      failedCandidates: capRecord(state.signals.failedCandidates, limits.failedCandidates),
    },
    bounds: snapshotBounds(state),
  }
  if (snapshotBytes(bounded) <= limits.maxBytes) return bounded
  const { description: _description, ...goal } = state.goal
  const lean = {
    schemaVersion: state.schemaVersion,
    tick: state.tick,
    timestampMs: state.timestampMs,
    self: state.self,
    inventory: { counts: state.inventory.counts, totalItems: state.inventory.totalItems },
    goal,
    currentOption: state.currentOption ?? null,
    signals: {
      consecutiveFailures: state.signals.consecutiveFailures,
      lastFailureCode: state.signals.lastFailureCode,
      lastPathStatus: state.signals.lastPathStatus,
      escalationRecommended: state.signals.escalationRecommended,
      // The critical-damage/starvation evidence is a survival fact, not a
      // diagnostic: even the size-degraded snapshot must not hide a body pinned
      // at the starvation floor, or the option layer loses the one fact saying
      // only a food route can end the damage.
      criticalDamage: state.signals.criticalDamage ?? null,
    },
    bounds: snapshotBounds(state),
    note: 'snapshot_over_budget',
  }
  return snapshotBytes(lean) <= limits.maxBytes ? lean : { note: 'snapshot_over_budget', tick: state.tick }
}

class TypeSafeJevPolicy implements JevPolicy {
  readonly kind = 'typesafe' as const
  readonly model: string
  readonly keyOrigin: string
  private readonly writer: JsonlWriter
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly rateLimitRetries: number
  private readonly rateLimitBaseDelayMs: number

  constructor(options: JevPolicyOptions & { key: KeyResolution }) {
    this.writer = options.writer
    this.timeoutMs = options.timeoutMs
    this.maxRetries = options.maxRetries
    this.rateLimitRetries = options.rateLimitRetries
    this.rateLimitBaseDelayMs = options.rateLimitBaseDelayMs
    this.keyOrigin = options.key.origin
    this.model = options.model ?? process.env.AI_GATEWAY_MODEL ?? DEFAULT_JEV_MODEL
    // The gateway provider reads AI_GATEWAY_API_KEY at request time.
    process.env.AI_GATEWAY_API_KEY = options.key.key
  }

  async decide(request: JevRequest, signal?: AbortSignal): Promise<JevResult> {
    const callId = randomUUID()
    const requested = request.questionNames ?? QUESTION_NAMES
    const questions = buildQuestions(request.candidates, requested)
    const maxAttempts = Math.max(1, this.maxRetries + 1)
    let attempt = 0
    let generalAttempt = 0
    let rateLimitWaitMs = 0
    for (;;) {
      if (signal?.aborted === true) throw new FatalModelError('jev-policy', generalAttempt, `aborted before attempt ${generalAttempt + 1}`)
      generalAttempt += 1
      const attemptStart = Date.now()
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
      const abortSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
      try {
        const response = await evaluate({
          model: this.model,
          state: toEvaluationState(request.state),
          questions,
          abortSignal,
          maxRetries: 0,
        })
        const latencyMs = Date.now() - attemptStart
        const answers: Record<string, JevAnswer> = {}
        for (const name of requested) {
          answers[name] = mapAnswer(name, response.answers[name], response.providerMetadata)
        }
        const usage = readUsage(response.usage)
        const record: JevCallRecord = {
          record: 'jev-call',
          callId,
          ts: new Date().toISOString(),
          policy: this.kind,
          model: this.model,
          stage: request.stage,
          latencyMs,
          rateLimitRetries: attempt,
          rateLimitWaitMs,
          state: boundedStateSnapshot(request.state),
          questions,
          response: { model: this.model, usage, answers },
          error: null,
        }
        this.writer.write(record)
        return { callId, policy: this.kind, source: 'jev', model: this.model, latencyMs, usage, answers }
      } catch (error) {
        const message = describeError(error)
        if (attempt < this.rateLimitRetries && isRateLimitError(error)) {
          attempt += 1
          generalAttempt -= 1
          const delayMs = this.rateLimitBaseDelayMs * attempt
          rateLimitWaitMs += delayMs
          this.writer.write({
            record: 'jev-retry',
            callId,
            ts: new Date().toISOString(),
            attempt,
            delayMs,
            totalWaitMs: rateLimitWaitMs,
            error: message,
          } satisfies JevRetryRecord)
          await sleep(delayMs)
          continue
        }
        if (generalAttempt < maxAttempts) {
          this.writer.write({
            record: 'jev-retry',
            callId,
            ts: new Date().toISOString(),
            attempt: generalAttempt,
            delayMs: 0,
            totalWaitMs: rateLimitWaitMs,
            error: message,
          } satisfies JevRetryRecord)
          continue
        }
        const record: JevCallRecord = {
          record: 'jev-call',
          callId,
          ts: new Date().toISOString(),
          policy: this.kind,
          model: this.model,
          stage: request.stage,
          latencyMs: Date.now() - attemptStart,
          rateLimitRetries: attempt,
          rateLimitWaitMs,
          state: boundedStateSnapshot(request.state),
          questions,
          response: null,
          error: message,
        }
        this.writer.write(record)
        throw new FatalModelError('jev-policy', generalAttempt, message)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// fallback policy: deterministic, clearly marked, no network
// ---------------------------------------------------------------------------

export const FALLBACK_MODEL = 'deterministic-local-fallback'

/** A candidate that failed this many times recently is skipped by the fallback. */
export const FALLBACK_FAILURE_LIMIT = 2

function fallbackPriority(state: WorldState, candidates: readonly Candidate[]): Candidate | null {
  const failed = state.signals.failedCandidates
  const fresh = candidates.filter((candidate) => (failed[candidate.id] ?? 0) < FALLBACK_FAILURE_LIMIT)
  const pool = fresh.length > 0 ? fresh : candidates
  const mines = pool.filter((candidate) => candidate.kind === 'MINE' && candidate.meta.clearance !== true)
  // prefer the goal item, then nearest (the generator already sorts by distance)
  const preferred = mines.find((candidate) => candidate.targetName === state.goal.targetItem)
  if (preferred !== undefined) return preferred
  if (mines.length > 0) return mines[0] ?? null
  const eat = pool.find((candidate) => candidate.kind === 'EAT')
  if (eat !== undefined) return eat
  const attack = pool.find((candidate) => candidate.kind === 'ATTACK')
  if (attack !== undefined) return attack
  const craft = pool.find((candidate) => candidate.kind === 'CRAFT')
  if (craft !== undefined) return craft
  const place = pool.find((candidate) => candidate.kind === 'PLACE')
  if (place !== undefined) return place
  const retrieve = pool.find((candidate) => candidate.kind === 'RETRIEVE')
  if (retrieve !== undefined) return retrieve
  const step = pool.find((candidate) => candidate.kind === 'STEP')
  if (step !== undefined) return step
  const move = pool.find((candidate) => candidate.kind === 'MOVE')
  if (move !== undefined) return move
  const clearance = pool.find((candidate) => candidate.kind === 'MINE' && candidate.meta.clearance === true)
  if (clearance !== undefined) return clearance
  const wait = pool.find((candidate) => candidate.kind === 'WAIT')
  return wait ?? pool[0] ?? candidates[0] ?? null
}

function progressLevel(progress: number, complete: boolean): number {
  if (complete) return 4
  if (progress <= 0) return 0
  if (progress < 0.25) return 1
  if (progress < 0.5) return 2
  if (progress < 1) return 3
  return 4
}

function dangerLevel(health: number, nearestHazardDistance: number | null): number {
  if (health <= 6 || (nearestHazardDistance !== null && nearestHazardDistance <= 2)) return 3
  if (health <= 12) return 2
  if (nearestHazardDistance !== null && nearestHazardDistance <= 3) return 1
  return 0
}

class FallbackJevPolicy implements JevPolicy {
  readonly kind = 'fallback' as const
  readonly model = FALLBACK_MODEL
  private readonly writer: JsonlWriter

  constructor(options: JevPolicyOptions) {
    this.writer = options.writer
  }

  async decide(request: JevRequest): Promise<JevResult> {
    const callId = randomUUID()
    const requestedAnswers = request.questionNames ?? QUESTION_NAMES
    const questions = buildQuestions(request.candidates, requestedAnswers)
    const startedAt = Date.now()

    const chosen = fallbackPriority(request.state, request.candidates)
    const nearestHazard = request.state.blocks.find((block) => block.kind === 'hazard')
    const level = progressLevel(request.state.goal.progress, request.state.goal.complete)
    const dangerScore = dangerLevel(request.state.self.health, nearestHazard?.distance ?? null)
    // Deterministic answers: action confidence stays null (a rule-based pick is
    // not a measurable distribution), while `danger` carries confidence 1 because
    // the level is *computed* from mechanical state, not estimated. `note` tags
    // the provenance so calibration can exclude the fallback from reliability
    // diagrams (they join real Jev predictions to real outcomes only).
    const note = 'deterministic-fallback'
    const shouldRetreat = request.state.self.health <= 6 || (nearestHazard !== undefined && nearestHazard.distance <= 2)
    const escalating = request.state.signals.escalationRecommended
    const abandon = escalating ? 1 : 0
    const planValidLevel = escalating ? 1 : 4
    const situationLevel = request.state.goalQueue.empty && !request.state.goal.complete ? 2 : 4

    const allAnswers: Record<QuestionName, JevAnswer> = {
      action: {
        name: 'action',
        type: 'choice',
        value: chosen?.id ?? 'WAIT',
        probability: 1,
        confidence: null,
        probabilities: chosen === null ? {} : { [chosen.id]: 1 },
        legend: null,
        note,
      },
      danger: {
        name: 'danger',
        type: 'score',
        value: dangerScore,
        probability: null,
        confidence: 1,
        probabilities: { [String(dangerScore)]: 1 },
        legend: [...DANGER_LEVELS],
        note: `${note}; level computed mechanically, certainty 1 by construction`,
      },
      should_retreat: {
        name: 'should_retreat',
        type: 'boolean',
        value: shouldRetreat ? 1 : 0,
        probability: shouldRetreat ? 1 : 0,
        confidence: null,
        probabilities: { true: shouldRetreat ? 1 : 0, false: shouldRetreat ? 0 : 1 },
        legend: null,
        note: `${note}; boolean P(true)`,
      },
      abandon_option: {
        name: 'abandon_option',
        type: 'boolean',
        value: abandon ? 1 : 0,
        probability: abandon ? 1 : 0,
        confidence: null,
        probabilities: { true: abandon ? 1 : 0, false: abandon ? 0 : 1 },
        legend: null,
        note: `${note}; deterministic beta (escalation/stall), threshold ${resolveAbandonThreshold()}`,
      },
    }

    const answers: Record<string, JevAnswer> = {}
    for (const name of requestedAnswers) answers[name] = allAnswers[name]

    const latencyMs = Date.now() - startedAt
    const record: JevCallRecord = {
      record: 'jev-call',
      callId,
      ts: new Date().toISOString(),
      policy: this.kind,
      model: this.model,
      stage: request.stage,
      latencyMs,
      rateLimitRetries: 0,
      rateLimitWaitMs: 0,
      state: boundedStateSnapshot(request.state),
      questions,
      response: { model: this.model, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, answers },
      error: null,
    }
    this.writer.write(record)
    return {
      callId,
      policy: this.kind,
      source: 'fallback',
      model: this.model,
      latencyMs,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      answers,
    }
  }
}

export interface CreateJevPolicyResult {
  policy: JevPolicy
  /** which implementation was selected, and why */
  reason: string
}

/**
 * THE swap point. `forceFallback: true` is the ONLY way to get the deterministic
 * policy; it is an explicit offline/CI opt-in (BUDDY_POLICY=fallback). Without
 * it a resolvable gateway key selects the real policy, and an unresolvable key
 * is a fatal model-configuration failure, never a silent degradation.
 */
export function createJevPolicy(options: JevPolicyOptions): JevPolicy {
  if (options.forceFallback === true) return new FallbackJevPolicy(options)
  const resolve = options.resolveKey ?? resolveJevApiKey
  const resolved = resolve()
  if (resolved !== null) {
    return new TypeSafeJevPolicy({ ...options, key: resolved })
  }
  throw new FatalModelError('jev-policy-key', 1, 'no gateway key resolved and forceFallback was not set')
}

export function writeOutcome(writer: JsonlWriter, record: Omit<JevOutcomeRecord, 'record' | 'ts'>): void {
  writer.write({ record: 'jev-outcome', ts: new Date().toISOString(), ...record } satisfies JevOutcomeRecord)
}
