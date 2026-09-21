// jev-authority.ts - small auditable REAL Jev policy kernel.
//
// This module deliberately knows nothing about Minecraft strategy ladders. It
// receives deterministic grounded candidates + world facts and asks the model
// two semantic questions:
//   pi   WHICH grounded action should execute now?
//   beta WHETHER the current Option should end?
// Safety scores remain model estimates consumed by deterministic safety gates.

import { randomUUID } from 'node:crypto'
import { experimental_evaluate as evaluate } from 'ai'
import type { Experimental_EvaluationQuestion } from 'ai'
import type { Candidate } from './candidates.ts'
import { FatalModelError } from './modelFailure.ts'
import type {
  JevAnswer,
  JevPolicy,
  JevPolicyOptions,
  JevRequest,
  JevResult,
  JevUsage,
  KeyResolution,
  QuestionName,
} from './jev-legacy.ts'
import { ABANDON_THRESHOLD_DEFAULT, DEFAULT_JEV_MODEL, DANGER_LEVELS, QUESTION_NAMES } from './jev-legacy.ts'

export const AUTHORITY_PRIMARY_INSTRUCTIONS =
  'You are Jev pi, the local policy head of an autonomous Minecraft agent. Choose exactly ONE id from the grounded ' +
  'action list: the action that best advances the CURRENT Option in the CURRENT world state. Every id is executable ' +
  'candidate data supplied by deterministic code; answer with the id verbatim and never invent an id. Candidate cost, ' +
  'distance, failure history, reachability, and prerequisite-path metadata are evidence. They are not universal ranking ' +
  'rules: reason over the whole state, current Option contract, recent outcomes, and available alternatives. When an ' +
  'ATTACK candidate is present, ATTACK versus MOVE, RETREAT, or WAIT is your pi decision: weigh the target identity and ' +
  'distance, health, food, equipment, immediate danger, current Option, and available alternatives. Do not attack merely ' +
  'because a mob exists, and do not ignore ATTACK merely because movement is cheaper. Deterministic code may ground and ' +
  'safety-check the candidate, but it must not choose attack for you or replace your valid attack choice with a different ' +
  'semantic action. The current Option allowedSkills is an envelope: SAFETY, CONTROL, and PREREQUISITE are always ' +
  'available when code has grounded them, alongside the Option-declared skills. A typed optionSkill=PREREQUISITE ' +
  'candidate is an actionable dependency route for the current Option, not an unrelated mission and not a reason to ' +
  'choose WAIT. Use the typed role/missing-capability facts as evidence, while retaining authority over WHICH candidate.'

const BETA_INSTRUCTIONS =
  'You are Jev beta. Decide whether the CURRENT Option should end now. Use its explicit preconditions/success facts, ' +
  'typed recent outcomes, and current grounded alternatives. True means end/abandon this Option and ask System 2 for ' +
  'WHAT comes next. False means keep the current Option. WAIT and ESCALATE are control-plane outcomes, not productive ' +
  'goal progress; body/search progress is real progress even when the goal item is unchanged. A local path failure is ' +
  'recovery evidence, not semantic exhaustion. Do not end the Option merely because one action failed if the Option ' +
  'remains viable. ' +
  'The code-owned signals.strategicNonProgress block is grounded evidence about the WHOLE recent trajectory, not one ' +
  'action: when it shows a full recurrence window (exhausted=true) of verified body-only decisions that returned to the ' +
  'same few states (distinctStates <= maxDistinctStates) with zero goal/search progress, the current local recovery is ' +
  'reiterating the same state instead of advancing, however successful each individual MOVE was. Treat that as ' +
  'exhaustion evidence: true means end this Option. Sustained signals.oscillationsDetected against zero goal/search ' +
  'progress is the same fact. The reverse also holds: a single productive action, one failure, or a window with real ' +
  'goal/search progress is NOT exhaustion.'

const RETREAT_INSTRUCTIONS =
  'Should the bot retreat immediately for safety based on the current observed threats, health, and grounded escape actions?'

const DANGER_INSTRUCTIONS =
  'Rate immediate physical danger in the current observed state from safe to lethal. This is a safety estimate, not a plan choice.'

type Questions = Partial<Record<QuestionName, Experimental_EvaluationQuestion>>

function candidateCriteria(candidate: Candidate): string {
  const tags: string[] = []
  const optionSkill = candidate.meta.optionSkill
  const prerequisiteRole = candidate.meta.prerequisiteRole
  const missingCapability = candidate.meta.missingCapability
  if (typeof optionSkill === 'string') tags.push(`optionSkill=${optionSkill}`)
  if (typeof prerequisiteRole === 'string') tags.push(`prerequisiteRole=${prerequisiteRole}`)
  if (typeof missingCapability === 'string') tags.push(`missingCapability=${missingCapability}`)
  if (candidate.meta.capabilityAcquisition === true) tags.push('capabilityAcquisition=true')
  return tags.length === 0 ? candidate.label : `${candidate.label} [${tags.join(' ')}]`
}

export interface AuthorityDecisionMeta {
  /** Canonical semantic Option instance Jev beta voted on; null before an Option exists. */
  optionInstanceId: string | null
  /** Stable semantic template id of that Option. */
  optionTemplateId: string | null
  /** Threshold owned by that exact Option contract. */
  betaThreshold: number
  /** Raw P(abandon=true), never thresholded away. */
  betaProbability: number | null
  /** Derived event-boundary decision recorded for replay. */
  betaAdopt: boolean
}

export type AuthorityTaggedJevResult = JevResult & { authorityDecision: AuthorityDecisionMeta }

export function buildAuthorityQuestions(
  candidates: readonly Candidate[],
  names: readonly QuestionName[] = QUESTION_NAMES,
): Questions {
  const requested = new Set(names)
  const out: Questions = {}
  if (requested.has('action')) {
    const criteria: Record<string, string> = {}
    for (const candidate of candidates) criteria[candidate.id] = candidateCriteria(candidate)
    out.action = { type: 'choice', instructions: AUTHORITY_PRIMARY_INSTRUCTIONS, criteria }
  }
  if (requested.has('abandon_option')) {
    out.abandon_option = {
      type: 'boolean',
      instructions: BETA_INSTRUCTIONS,
      criteria: { true: 'end the current Option', false: 'continue the current Option' },
    }
  }
  if (requested.has('danger')) {
    out.danger = { type: 'score', instructions: DANGER_INSTRUCTIONS, criteria: [...DANGER_LEVELS] }
  }
  if (requested.has('should_retreat')) {
    out.should_retreat = {
      type: 'boolean',
      instructions: RETREAT_INSTRUCTIONS,
      criteria: { true: 'retreat now', false: 'no immediate retreat required' },
    }
  }
  return out
}

function member(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined
  return (source as Record<string, unknown>)[key]
}

function numberRecord(source: unknown, key: string): Record<string, number> | null {
  const raw = member(source, key)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const out: Record<string, number> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[name] = value
  }
  return out
}

function calibratedConfidence(metadata: unknown, name: string): number | null {
  const typesafe = member(metadata, 'typesafe')
  const confidence = member(member(typesafe, 'confidence'), name)
  return typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : null
}

function mapAnswer(name: QuestionName, raw: unknown, metadata: unknown): JevAnswer {
  const confidence = calibratedConfidence(metadata, name)
  if (name === 'action') {
    const choice = member(raw, 'choice')
    if (typeof choice !== 'string') throw new Error(`malformed Jev action choice: ${JSON.stringify(raw)}`)
    const probabilities = numberRecord(raw, 'probabilities') ?? {}
    return {
      name,
      type: 'choice',
      value: choice,
      probability: probabilities[choice] ?? null,
      confidence,
      probabilities,
      legend: null,
      note: 'model-authoritative-pi',
    }
  }
  if (name === 'danger') {
    const score = member(raw, 'score')
    if (typeof score !== 'number' || !Number.isFinite(score)) throw new Error(`malformed Jev danger score: ${JSON.stringify(raw)}`)
    return {
      name,
      type: 'score',
      value: score,
      probability: null,
      confidence,
      probabilities: numberRecord(raw, 'probabilities'),
      legend: [...DANGER_LEVELS],
      note: 'model-safety-estimate',
    }
  }
  const probability = member(raw, 'probability')
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error(`malformed Jev boolean ${name}: ${JSON.stringify(raw)}`)
  }
  return {
    name,
    type: 'boolean',
    value: probability,
    probability,
    confidence,
    probabilities: { true: probability, false: 1 - probability },
    legend: null,
    note: name === 'abandon_option' ? 'model-authoritative-beta' : 'model-safety-estimate',
  }
}

function readUsage(raw: unknown): JevUsage {
  const input = member(raw, 'inputTokens')
  const output = member(raw, 'outputTokens')
  const total = member(raw, 'totalTokens')
  return {
    inputTokens: typeof input === 'number' ? input : null,
    outputTokens: typeof output === 'number' ? output : null,
    totalTokens: typeof total === 'number' ? total : null,
  }
}

function validThreshold(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/**
 * The exact beta contract for this call. The threshold comes from the exact
 * current Option instance whenever one exists; the global 0.5 is only the
 * bootstrap/rollback fallback for states without first-class Option metadata.
 */
export function authorityDecisionMeta(request: JevRequest, answers: Readonly<Record<string, JevAnswer>>): AuthorityDecisionMeta {
  const option = request.state.currentOption ?? null
  const threshold = validThreshold(option?.abortThreshold) ? option.abortThreshold : ABANDON_THRESHOLD_DEFAULT
  const probability = answers.abandon_option?.probability
  const betaProbability = typeof probability === 'number' && Number.isFinite(probability) ? probability : null
  return {
    optionInstanceId: option?.semanticInstanceId ?? option?.instanceId ?? null,
    optionTemplateId: option?.templateId ?? null,
    betaThreshold: threshold,
    betaProbability,
    betaAdopt: betaProbability !== null && betaProbability >= threshold,
  }
}

/**
 * The exact grounded state handed to the model for one evaluate() call. Exported
 * so the authority evidence a head actually sees (including the #360
 * `strategicNonProgress` block) is behaviourally testable, not only log-inspectable.
 */
export function authorityState(request: JevRequest): Record<string, unknown> {
  const state = request.state
  return {
    tick: state.tick,
    self: {
      position: state.self.position,
      health: state.self.health,
      food: state.self.food,
    },
    inventory: state.inventory.counts,
    goal: state.goal,
    goalQueue: {
      depth: state.goalQueue.depth,
      empty: state.goalQueue.empty,
      current: state.goalQueue.current,
    },
    currentOption: state.currentOption ?? null,
    recentOutcomes: (state.recentOutcomes ?? []).slice(-8),
    candidates: request.candidates.map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      label: candidate.label,
      target: candidate.target,
      targetName: candidate.targetName,
      meta: candidate.meta,
    })),
    nearestBlocks: state.blocks.slice(0, 16),
    nearestEntities: state.entities.slice(0, 12),
    signals: {
      failedCandidates: state.signals.failedCandidates,
      consecutiveFailures: state.signals.consecutiveFailures,
      lastFailureCode: state.signals.lastFailureCode,
      lastPathStatus: state.signals.lastPathStatus,
      escalationRecommended: state.signals.escalationRecommended,
      knownResources: (state.signals.knownResources ?? []).slice(0, 24),
      // #360: without this block beta only ever saw verified body outcomes and an
      // empty failure history, so a 48-minute state-recurring MOVE loop looked
      // like a healthy agent (max beta 0.36 < 0.5 over 2148 votes).
      strategicNonProgress: state.signals.strategicNonProgress ?? null,
      oscillationsDetected: state.signals.oscillationsDetected ?? 0,
    },
    recentEvents: state.recentEvents.slice(-16),
  }
}

function isRateLimit(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== 'object' || error === null) return false
  const row = error as Record<string, unknown>
  if (row.statusCode === 429) return true
  if (typeof row.name === 'string' && row.name.includes('RateLimit')) return true
  if (isRateLimit(row.cause, depth + 1) || isRateLimit(row.lastError, depth + 1)) return true
  return Array.isArray(row.errors) && row.errors.some((entry) => isRateLimit(entry, depth + 1))
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  try { return JSON.stringify(error) } catch { return '<unserialisable>' }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class AuthorityJevPolicy implements JevPolicy {
  readonly kind = 'typesafe' as const
  readonly model: string
  readonly keyOrigin: string

  private readonly options: JevPolicyOptions

  constructor(options: JevPolicyOptions, key: KeyResolution) {
    this.options = options
    this.keyOrigin = key.origin
    this.model = options.model ?? process.env.AI_GATEWAY_MODEL ?? DEFAULT_JEV_MODEL
    process.env.AI_GATEWAY_API_KEY = key.key
  }

  async decide(request: JevRequest, signal?: AbortSignal): Promise<JevResult> {
    const callId = randomUUID()
    const requested = request.questionNames ?? QUESTION_NAMES
    const questions = buildAuthorityQuestions(request.candidates, requested)
    const modelState = authorityState(request) as Parameters<typeof evaluate>[0]['state']
    const maxGeneralAttempts = Math.max(1, this.options.maxRetries + 1)
    let generalAttempt = 0
    let rateAttempt = 0
    let rateWaitMs = 0

    for (;;) {
      if (signal?.aborted === true) throw new FatalModelError('jev-authority', generalAttempt, 'aborted before model call')
      generalAttempt += 1
      const started = Date.now()
      const timeout = AbortSignal.timeout(this.options.timeoutMs)
      const abortSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      try {
        const response = await evaluate({
          model: this.model,
          state: modelState,
          questions,
          maxRetries: 0,
          abortSignal,
        })
        const answers: Record<string, JevAnswer> = {}
        for (const name of requested) answers[name] = mapAnswer(name, response.answers[name], response.providerMetadata)

        const action = answers.action
        if (action !== undefined) {
          const grounded = request.candidates.some((candidate) => candidate.id === action.value)
          if (!grounded) throw new Error(`Jev invented non-grounded action id ${JSON.stringify(action.value)}`)
        }

        const authorityDecision = authorityDecisionMeta(request, answers)
        const usage = readUsage(response.usage)
        const latencyMs = Date.now() - started
        this.options.writer.write({
          record: 'jev-call',
          callId,
          ts: new Date().toISOString(),
          policy: this.kind,
          model: this.model,
          stage: request.stage,
          latencyMs,
          rateLimitRetries: rateAttempt,
          rateLimitWaitMs: rateWaitMs,
          // IMPORTANT: this is the exact state supplied to evaluate(), making
          // authority/replay evidence inspectable rather than logging a different snapshot.
          state: modelState,
          questions,
          response: { model: this.model, usage, answers },
          error: null,
          authority: {
            pi: 'model',
            beta: 'model',
            code: 'grounding+safety+truth',
            decision: authorityDecision,
          },
        })
        const result = {
          callId,
          policy: this.kind,
          source: 'jev' as const,
          model: this.model,
          latencyMs,
          usage,
          answers,
          authorityDecision,
        }
        return result
      } catch (error) {
        const message = describe(error)
        if (isRateLimit(error) && rateAttempt < this.options.rateLimitRetries) {
          rateAttempt += 1
          generalAttempt -= 1
          const delayMs = this.options.rateLimitBaseDelayMs * rateAttempt
          rateWaitMs += delayMs
          this.options.writer.write({
            record: 'jev-retry', callId, ts: new Date().toISOString(), attempt: rateAttempt,
            delayMs, totalWaitMs: rateWaitMs, error: message,
          })
          await sleep(delayMs)
          continue
        }
        if (generalAttempt < maxGeneralAttempts) {
          this.options.writer.write({
            record: 'jev-retry', callId, ts: new Date().toISOString(), attempt: generalAttempt,
            delayMs: 0, totalWaitMs: rateWaitMs, error: message,
          })
          continue
        }
        this.options.writer.write({
          record: 'jev-call', callId, ts: new Date().toISOString(), policy: this.kind,
          model: this.model, stage: request.stage, latencyMs: Date.now() - started,
          rateLimitRetries: rateAttempt, rateLimitWaitMs: rateWaitMs, state: modelState,
          questions, response: null, error: message,
          authority: { pi: 'model', beta: 'model', failure: 'fatal-no-fallback' },
        })
        throw new FatalModelError('jev-authority', generalAttempt, message)
      }
    }
  }
}
