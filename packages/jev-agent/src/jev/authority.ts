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
import type { Candidate } from '../candidates.ts'
import { FatalModelError } from '../modelFailure.ts'
// §437 §1/§10: the model-visible half of the semantic projection (no raw telemetry,
// and the exact top-level keys the projection hash covers).
import { projectionModelView } from './semantic-projection.ts'
import type { JevSemanticProjection } from './semantic-projection.ts'
import type {
  JevAnswer,
  JevPolicy,
  JevPolicyOptions,
  JevRequest,
  JevResult,
  JevUsage,
  KeyResolution,
  QuestionName,
} from './client.ts'
import { ABANDON_THRESHOLD_DEFAULT, ACTION_DECLINE_LABEL, DEFAULT_JEV_MODEL, DANGER_LEVELS, QUESTION_NAMES, resolveAbandonThreshold } from './client.ts'

export const AUTHORITY_PRIMARY_INSTRUCTIONS =
  'You are the pi head of the Typed Decision Plane for an autonomous Minecraft agent. Choose exactly ONE id from ' +
  'candidates: the action that best advances the current Option (option.intent/success/preconditions). Answer with ' +
  'the id verbatim and never invent one. Candidates are grounded and safety-checked by deterministic code; their ' +
  'labels, criteria tags, inReach, and failureBand are evidence to weigh, not fixed ranking rules. Judge the whole ' +
  'canonical state: goal/option contract, progress facts, safety/combat facts, candidates, and recentOutcomes. A ' +
  'candidate tagged optionSkill=PREREQUISITE is a required dependency route for this Option, not a detour and not a ' +
  'reason to WAIT; SAFETY and CONTROL candidates stay live under threat. When an ATTACK candidate exists, ATTACK ' +
  'versus MOVE, RETREAT, or WAIT is your pi decision: weigh the combat block (target, distance buckets, weapons, ' +
  'armor condition, danger) and what each escape buys (separation, cover, reach). Do not attack merely because a ' +
  'mob exists - attack only when it serves the Option or survival; code grounds and bounds the choice and must not ' +
  'choose attack for you. If a DECLINE label is offered (a singleton offer), it means refusing the only grounded ' +
  'action; choose it only when this Option cannot proceed as offered.'

const BETA_INSTRUCTIONS =
  'You are the beta head: does the CURRENT Option end now? Judge option.success/preconditions against progress ' +
  'facts, recentOutcomes, and the grounded alternatives: true means end/abandon this Option and ask System 2 for WHAT ' +
  'comes next; false means keep it. WAIT and ESCALATE are control-plane outcomes, not productive goal progress; ' +
  'body/search progress is real progress even when the goal item is unchanged. A local path failure is recovery ' +
  'evidence, not semantic exhaustion - do not end a viable Option over one failed action. The code-owned ' +
  'progress.stall block is grounded evidence about the WHOLE recent trajectory, not one action: exhausted=true means ' +
  'a full window (windowSize >= horizon) of verified body-only decisions returned to the same few states ' +
  '(distinctStates <= maxDistinctStates) with zero goal/search progress - the local recovery is reiterating one ' +
  'pocket however successful each MOVE was, which IS exhaustion evidence: end this Option. Sustained ' +
  'progress.oscillationsDetected against zero goal/search progress is the same fact. A single productive action, ' +
  'one failure, or a window with real goal/search progress is NOT exhaustion.'

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
  actionInstructions = AUTHORITY_PRIMARY_INSTRUCTIONS,
): Questions {
  const requested = new Set(names)
  const out: Questions = {}
  if (requested.has('action')) {
    const criteria: Record<string, string> = {}
    for (const candidate of candidates) criteria[candidate.id] = candidateCriteria(candidate)
    // §18 Gate F: the System One wire requires a Choice to offer >=2 labels.
    // On a singleton grounded offer the real judgment is "the sole action, or
    // the Option cannot proceed" - DECLINE is that second leg, never a control.
    if (candidates.length === 1) {
      criteria[ACTION_DECLINE_LABEL] =
        'decline the only grounded action: this Option cannot proceed as offered'
    }
    out.action = { type: 'choice', instructions: actionInstructions, criteria }
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

/**
 * Per-question confidence exactly as the serving backend reported it: the
 * gateway dialect reports under `typesafe`, the direct System One dialect
 * under `systemone`. Its calibration is a declared, model-specific property of
 * the backend profile; nothing here rescales it.
 */
function calibratedConfidence(metadata: unknown, name: string): number | null {
  for (const namespace of ['typesafe', 'systemone']) {
    const confidence = member(member(member(metadata, namespace), 'confidence'), name)
    if (typeof confidence === 'number' && Number.isFinite(confidence)) return confidence
  }
  return null
}

/** Provider request id reported by the direct System One dialect (bounded provenance). */
function reportedRequestId(metadata: unknown): string | null {
  const requestId = member(member(metadata, 'systemone'), 'requestId')
  return typeof requestId === 'string' ? requestId : null
}

function mapAnswer(name: QuestionName, raw: unknown, metadata: unknown, routeFrame = false): JevAnswer {
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
      note: routeFrame ? 'jev-reach-route-policy-input' : 'model-authoritative-pi',
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

/**
 * Describe the authority that participated in this evaluate() call. Legacy
 * callers retain their historical pi/beta record; a VTR route frame is a
 * bounded Jev policy input and must not be journaled as universal pi/beta.
 */
function authorityJournal(
  request: JevRequest,
  fields: { decision?: AuthorityDecisionMeta; failure?: string } = {},
): Record<string, unknown> {
  if (request.decisionFrame?.kind === 'vtr-reach-route') {
    const requested = request.questionNames ?? QUESTION_NAMES
    return {
      decisionFrame: {
        kind: request.decisionFrame.kind,
        policy: 'jev',
        questionAuthorities: Object.fromEntries(requested.map((name) => [name, 'jev-policy-input'])),
      },
      code: 'grounding+safety+truth',
      decisionReason: request.decisionReason ?? null,
      ...fields,
    }
  }
  return {
    pi: 'model',
    beta: 'model',
    code: 'grounding+safety+truth',
    // §7.1: which semantic boundary authorized this provider call (null on
    // callers that do not classify - e.g. tests and non-decision frames).
    decisionReason: request.decisionReason ?? null,
    ...fields,
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
export function authorityDecisionMeta(request: JevRequest, answers: Readonly<Record<string, JevAnswer>>, thresholdFallback?: number): AuthorityDecisionMeta {
  const option = request.state.currentOption ?? null
  const threshold = validThreshold(option?.abortThreshold)
    ? option.abortThreshold
    : resolveAbandonThreshold(thresholdFallback ?? ABANDON_THRESHOLD_DEFAULT)
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
 * recurrence block, now `progress.stall`) is behaviourally testable, not only
 * log-inspectable.
 *
 * Issue #437 + §18 Gate B: when the caller supplies the versioned semantic
 * projection, that projection IS the whole canonical DecisionState - the
 * primitive churn (`tick`, raw float position, the per-tick `recentEvents`
 * trace) AND the duplicated outer blocks (`self`, `signals`, `nearest*`,
 * outer `candidates`/`recentOutcomes`/`goalQueue`/`currentOption`/`goal`/
 * `inventory`) all stay out of inference. Each semantic fact the heads judge is
 * compiled once inside the projection: banded body/threat facts in `safety`,
 * the Option contract in `option`, the #360 recurrence block in
 * `progress.stall`, the queue head in `queue`. Unprojected callers (VTR route
 * frames, legacy fixtures) keep the historical raw shape.
 */
export function authorityState(request: JevRequest): Record<string, unknown> {
  const projection = request.semanticProjection ?? null
  if (projection !== null && typeof projection === 'object') {
    // §18 Gate B: the versioned semantic projection IS the canonical compact
    // DecisionState - the ONLY model-facing state. Every field the heads judge
    // (Option contract, stall evidence, queue head, banded body facts,
    // grounded candidate identities) lives exactly once inside it; raw
    // self/signals/nearest*/outer-candidate blocks stay in the jev-call
    // journal as audit telemetry and are never duplicated into inference.
    const modelView = projectionModelView(projection as JevSemanticProjection)
    return { ...modelView, projectionHash: request.projectionHash ?? null }
  }
  const state = request.state
  const reachRouteFrame = request.decisionFrame?.kind === 'vtr-reach-route' ? request.decisionFrame : null
  const self = {
    position: state.self.position,
    health: state.self.health,
    food: state.self.food,
    // Worn armor is read from the player's armor window slots, not carried
    // inventory. Preserve exact observed slot/name/durability evidence on the
    // raw model path; the semantic projection carries stable condition bands.
    armor: state.self.armor ?? null,
    offhand: {
      observed: state.self.offhand !== undefined,
      item: state.self.offhand ?? null,
    },
    // P1 durability: a falling health number is not enough to answer "am I
    // being attacked, and by what?". The recorded damage event makes the
    // threat explicit so Jev can choose fight/flee instead of WAIT.
    lastDamage: state.signals.lastDamage ?? null,
  }
  const signals = {
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
    // SAFE: the bounded danger state (see `threat.ts`): whether the body is in
    // a fight, how long it has been answering it, and how far the nearest
    // hostile is. Candidate labels already carry the weapon and the separation
    // each destination buys; this is the STATE those options belong to, so Jev
    // can choose to keep answering the mob instead of resuming work between two
    // hits (the measured per-tick failure).
    threat: state.signals.threat ?? null,
  }
  const shared = {
    inventory: state.inventory.counts,
    goal: reachRouteFrame === null ? state.goal : { authority: 'vtr-reach-route', context: reachRouteFrame.context },
    goalQueue: reachRouteFrame === null
      ? { depth: state.goalQueue.depth, empty: state.goalQueue.empty, current: state.goalQueue.current }
      : { depth: 0, empty: true, current: null },
    currentOption: reachRouteFrame === null ? state.currentOption ?? null : null,
    ...(reachRouteFrame === null ? {} : { decisionFrame: reachRouteFrame }),
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
    signals,
  }
  return { tick: state.tick, self, ...shared, recentEvents: state.recentEvents.slice(-16) }
}

function isRateLimit(error: unknown, depth = 0): boolean {
  if (depth > 5 || typeof error !== 'object' || error === null) return false
  const row = error as Record<string, unknown>
  if ([row.statusCode, row.status, row.httpStatus].some(
    (value) => typeof value === 'number' && Number.isFinite(value) && value === 429,
  )) return true
  if (typeof row.name === 'string' && /ratelimit/i.test(row.name)) return true
  if (
    isRateLimit(row.cause, depth + 1) ||
    isRateLimit(row.lastError, depth + 1) ||
    isRateLimit(row.response, depth + 1)
  ) return true
  return Array.isArray(row.errors) && row.errors.some((entry) => isRateLimit(entry, depth + 1))
}

/** Transient provider failures retry within this decision; exhaustion requests host recovery. */
export function isTransientProviderFailure(error: unknown, depth = 0): boolean {
  if (typeof error === 'string') {
    return /503|service temporarily unavailable|service unavailable|upstream unavailable|connection reset|ECONN(?:RESET|REFUSED|ABORTED)|EPIPE|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|timed? ?out/i.test(error)
  }
  if (depth > 5 || typeof error !== 'object' || error === null) return false
  const row = error as Record<string, unknown>
  // A typed decision-transport failure carries its own transience verdict;
  // trust it over the raw provider error it wraps (a credit failure a provider
  // served as a 5xx is decisive, not a transient outage).
  if (row.name === 'DecisionUnavailableError' && typeof row.retryable === 'boolean') return row.retryable
  const code = typeof row.code === 'string' ? row.code : ''
  if (/^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENETUNREACH)$/.test(code)) return true
  const status = [row.statusCode, row.status, row.httpStatus].find(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  )
  if (status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500 && status <= 599)) return true
  const name = typeof row.name === 'string' ? row.name : ''
  const message = typeof row.message === 'string' ? row.message : ''
  if (/GatewayInternalServerError|ServiceUnavailable|Timeout|NetworkError/i.test(name)) return true
  if (/503|service temporarily unavailable|service unavailable|upstream unavailable|connection reset|ECONN(?:RESET|REFUSED|ABORTED)|EPIPE|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|timed? ?out/i.test(message)) return true
  if (
    isTransientProviderFailure(row.cause, depth + 1) ||
    isTransientProviderFailure(row.lastError, depth + 1) ||
    isTransientProviderFailure(row.response, depth + 1)
  ) return true
  return Array.isArray(row.errors) && row.errors.some((entry) => isTransientProviderFailure(entry, depth + 1))
}

/**
 * The availability class of a typed decision-transport failure that retrying
 * the same request cannot fix (credentials, credit, entitlement, request or
 * model identity), or null. Duck-typed: the policy does not import a transport.
 */
function decisiveDecisionFailure(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const row = error as Record<string, unknown>
  return row.name === 'DecisionUnavailableError' && row.decisive === true && typeof row.availability === 'string'
    ? row.availability
    : null
}

/** Bounded, secret-safe diagnostics copied from known AI SDK error fields only. */
export interface ProviderErrorDiagnostics {
  httpStatus?: number
  providerErrorCode?: string
  providerErrorType?: string
  errorName?: string
  retryAfterMs?: number
  requestId?: string
  requestIdHeader?: string
}

const PROVIDER_ERROR_CODE_KEYS = ['providerCode', 'provider_code', 'errorCode', 'error_code', 'code'] as const
const PROVIDER_ERROR_TYPE_KEYS = ['providerErrorType', 'provider_error_type', 'errorType', 'error_type', 'type'] as const
const HTTP_STATUS_KEYS = ['statusCode', 'status_code', 'httpStatus', 'status'] as const
const REQUEST_ID_HEADERS = [
  'x-vercel-id',
  'x-vercel-request-id',
  'x-request-id',
  'request-id',
  'x-typesafe-request-id',
] as const
const ERROR_CHILD_KEYS = ['cause', 'lastError', 'response', 'error', 'data', 'body', 'responseBody', 'errors'] as const
const MAX_ERROR_NODES = 32
const MAX_ERROR_DEPTH = 5
const MAX_PROVIDER_CODE_LENGTH = 80
const MAX_REQUEST_ID_LENGTH = 160
const MAX_ERROR_MESSAGE_LENGTH = 512
const TRANSIENT_RETRY_BASE_DELAY_MS = 250
const TRANSIENT_RETRY_MAX_BACKOFF_MS = 4_000
const TRANSIENT_RETRY_MAX_DELAY_MS = 15_000

type UnknownRecord = Record<string, unknown>

function errorRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function readErrorField(record: UnknownRecord, key: string): unknown {
  try {
    return record[key]
  } catch {
    return undefined
  }
}

function firstSafeCode(record: UnknownRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const code = safeCode(readErrorField(record, key))
    if (code !== null) return code
  }
  return undefined
}

function firstHttpStatus(record: UnknownRecord): number | undefined {
  for (const key of HTTP_STATUS_KEYS) {
    const status = readErrorField(record, key)
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) return status
  }
  return undefined
}

function safeCode(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 && value <= 9999 ? String(value) : null
  }
  if (typeof value !== 'string') return null
  const code = value.trim()
  if (
    code.length === 0 ||
    code.length > MAX_PROVIDER_CODE_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(code) ||
    /(?:bearer|secret|password|authorization)/i.test(code) ||
    /^(?:sk|pk|rk|sess|gh[pousr])[-_]/i.test(code) ||
    /^[A-Fa-f0-9]{32,}$/.test(code) ||
    /^[A-Za-z0-9_-]{48,}$/.test(code)
  ) return null
  return code
}

function safeRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const requestId = value.trim()
  if (
    requestId.length === 0 ||
    requestId.length > MAX_REQUEST_ID_LENGTH ||
    !/^[A-Za-z0-9._:-]+$/.test(requestId) ||
    /(?:bearer|token|secret|password|authorization|api.?key)/i.test(requestId) ||
    /^(?:sk|pk|rk|sess|gh[pousr])[-_]/i.test(requestId) ||
    /^[A-Fa-f0-9]{32,}$/.test(requestId)
  ) return null
  return requestId
}

function requestIdFromHeaders(value: unknown): Array<{ header: string; value: string }> {
  const candidates: Array<{ header: string; value: string }> = []
  if (typeof value !== 'object' || value === null) return candidates

  let get: unknown
  try {
    get = (value as { get?: unknown }).get
  } catch {
    return candidates
  }
  if (typeof get === 'function') {
    for (const header of REQUEST_ID_HEADERS) {
      try {
        const id = safeRequestId(get.call(value, header))
        if (id !== null) candidates.push({ header, value: id })
      } catch {
        // A malformed provider error object should never affect policy handling.
      }
    }
    return candidates
  }

  let keys: string[]
  try {
    keys = Object.keys(value).slice(0, 64)
  } catch {
    return candidates
  }
  for (const header of REQUEST_ID_HEADERS) {
    const actual = keys.find((key) => key.toLowerCase() === header)
    if (actual === undefined) continue
    const id = safeRequestId(readErrorField(value as UnknownRecord, actual))
    if (id !== null) candidates.push({ header, value: id })
  }
  return candidates
}

function retryAfterHeader(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  let get: unknown
  try {
    get = (value as { get?: unknown }).get
  } catch {
    return null
  }
  if (typeof get === 'function') {
    try {
      const result = get.call(value, 'retry-after')
      return typeof result === 'string' ? result : null
    } catch {
      return null
    }
  }
  let keys: string[]
  try {
    keys = Object.keys(value).slice(0, 64)
  } catch {
    return null
  }
  const actual = keys.find((key) => key.toLowerCase() === 'retry-after')
  if (actual === undefined) return null
  let result: unknown
  try {
    result = (value as UnknownRecord)[actual]
  } catch {
    return null
  }
  return typeof result === 'string' ? result : null
}

function parseRetryAfterMs(value: string, nowMs = Date.now()): number | null {
  const header = value.trim()
  if (header.length === 0 || header.length > 128) return null
  let delayMs: number
  if (/^\d+(?:\.\d+)?$/.test(header)) {
    delayMs = Number(header) * 1_000
  } else {
    const dateMs = Date.parse(header)
    if (!Number.isFinite(dateMs)) return null
    delayMs = dateMs - nowMs
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) return null
  return Math.min(delayMs, TRANSIENT_RETRY_MAX_DELAY_MS)
}

function isCancellationFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const row = error as Record<string, unknown>
  return row.name === 'AbortError' || row.code === 'ABORT_ERR'
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function transientRetryDelayMs(attempt: number, retryAfterMs: number | undefined, random: () => number): number {
  const exponent = Math.min(30, Math.max(0, attempt - 1))
  const base = Math.min(TRANSIENT_RETRY_MAX_BACKOFF_MS, TRANSIENT_RETRY_BASE_DELAY_MS * 2 ** exponent)
  const randomValue = random()
  const boundedRandom = Number.isFinite(randomValue) ? Math.min(0.999_999, Math.max(0, randomValue)) : 0.5
  const jitteredBackoff = Math.round(base * (0.5 + boundedRandom))
  return Math.min(TRANSIENT_RETRY_MAX_DELAY_MS, Math.max(jitteredBackoff, retryAfterMs ?? 0))
}

function parseErrorBody(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

/**
 * Extract only bounded, allowlisted metadata from AI SDK and TypeSafe SDK errors.
 * Never serializes response bodies or headers wholesale: callers may attach an
 * authorization value, prompt, URL, or other secret to those objects.
 */
export function extractProviderErrorDiagnostics(error: unknown): ProviderErrorDiagnostics | null {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }]
  const seen = new Set<object>()
  const requestIds: Array<{ header: string; value: string }> = []
  let httpStatus: number | undefined
  let retryAfterMs: number | undefined
  let providerErrorCode: string | undefined
  let providerErrorType: string | undefined
  let errorName: string | undefined
  let visited = 0

  while (queue.length > 0 && visited < MAX_ERROR_NODES) {
    const next = queue.shift()
    if (next === undefined || next.depth > MAX_ERROR_DEPTH) continue
    const row = errorRecord(next.value)
    if (row === null || seen.has(row)) continue
    seen.add(row)
    visited += 1

    if (httpStatus === undefined) {
      httpStatus = firstHttpStatus(row)
    }
    if (providerErrorCode === undefined) {
      providerErrorCode = firstSafeCode(row, PROVIDER_ERROR_CODE_KEYS)
    }
    if (providerErrorType === undefined) {
      providerErrorType = firstSafeCode(row, PROVIDER_ERROR_TYPE_KEYS)
    }
    if (errorName === undefined) {
      const name = safeCode(readErrorField(row, 'name'))
      if (name !== null) errorName = name
    }

    for (const headerKey of ['responseHeaders', 'headers'] as const) {
      const headers = readErrorField(row, headerKey)
      requestIds.push(...requestIdFromHeaders(headers))
      if (retryAfterMs === undefined) {
        const retryAfter = retryAfterHeader(headers)
        if (retryAfter !== null) retryAfterMs = parseRetryAfterMs(retryAfter) ?? undefined
      }
    }
    const directId = safeRequestId(readErrorField(row, 'requestId'))
    if (directId !== null) requestIds.push({ header: 'requestId', value: directId })

    if (next.depth === MAX_ERROR_DEPTH) continue
    for (const key of ERROR_CHILD_KEYS) {
      const child = readErrorField(row, key)
      const parsedBody = key === 'responseBody' ? parseErrorBody(child) : null
      if (parsedBody !== null) queue.push({ value: parsedBody, depth: next.depth + 1 })
      else if (typeof child === 'object' && child !== null) {
        if (Array.isArray(child)) {
          for (const entry of child.slice(0, 8)) queue.push({ value: entry, depth: next.depth + 1 })
        } else {
          queue.push({ value: child, depth: next.depth + 1 })
        }
      }
    }
  }

  // Vercel's edge request id is most useful for tracing; otherwise retain the
  // most specific allowlisted request-id header encountered in the error chain.
  const selectedRequestId = REQUEST_ID_HEADERS
    .map((header) => requestIds.find((candidate) => candidate.header === header))
    .find((candidate) => candidate !== undefined)
    ?? requestIds.find((candidate) => candidate.header === 'requestId')
  const diagnostics: ProviderErrorDiagnostics = {}
  if (httpStatus !== undefined) diagnostics.httpStatus = httpStatus
  if (providerErrorCode !== undefined) diagnostics.providerErrorCode = providerErrorCode
  if (providerErrorType !== undefined) diagnostics.providerErrorType = providerErrorType
  if (errorName !== undefined) diagnostics.errorName = errorName
  if (retryAfterMs !== undefined) diagnostics.retryAfterMs = retryAfterMs
  if (selectedRequestId !== undefined) {
    diagnostics.requestId = selectedRequestId.value
    diagnostics.requestIdHeader = selectedRequestId.header
  }
  return Object.keys(diagnostics).length > 0 ? diagnostics : null
}

function redactErrorText(text: string): string {
  return text
    .replace(
      /\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*(?:bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[REDACTED]',
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|pk|rk|sess|gh[pousr])[-_][A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .slice(0, MAX_ERROR_MESSAGE_LENGTH)
}

/** Error message kept in evidence; never serializes arbitrary SDK error fields. */
export function describeProviderError(error: unknown): string {
  let text: string
  if (error instanceof Error) {
    const name = safeCode(error.name)
    text = `${name ?? 'ProviderError'}: ${error.message}`
  } else if (typeof error === 'string') {
    text = error
  } else {
    const row = errorRecord(error)
    if (row === null) return '<provider failure>'
    const name = safeCode(readErrorField(row, 'name'))
    const message = readErrorField(row, 'message')
    if (typeof message === 'string') text = `${name ?? 'ProviderError'}: ${message}`
    else text = name ?? '<provider failure object>'
  }
  return redactErrorText(text)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sleepWithSignal(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return sleep(ms)
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      cleanup()
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

/** Non-secret identity of the backend profile serving the Typed Decision Plane. */
export interface AuthorityBackendIdentity {
  readonly profileId: string
  readonly providerId: string
}

/** Historical default: TypeSafe Jev through the AI Gateway evaluate primitive. */
export const GATEWAY_BACKEND_IDENTITY: AuthorityBackendIdentity = {
  profileId: 'typesafe-gateway-jev',
  providerId: 'typesafe-ai',
}

export interface AuthorityJevPolicyDependencies {
  /**
   * Transport seam: deterministic retry regressions and the direct System One
   * backend profiles. An injected transport owns its own credential.
   */
  evaluate?: typeof evaluate
  /** Serving backend provenance; defaults to the historical gateway profile. */
  backend?: AuthorityBackendIdentity
  /** Internal wait seam; production waits remain abortable. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
}

export class AuthorityJevPolicy implements JevPolicy {
  readonly kind = 'typesafe' as const
  readonly model: string
  readonly keyOrigin: string
  readonly provider: string
  readonly profileId: string

  private readonly options: JevPolicyOptions
  private readonly requestEvaluation: typeof evaluate
  private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly random: () => number
  /** Non-secret serving-backend provenance stamped on every jev-call record. */
  private readonly backendJournal: Readonly<Record<string, string>>

  constructor(options: JevPolicyOptions, key: KeyResolution, dependencies: AuthorityJevPolicyDependencies = {}) {
    this.options = options
    this.keyOrigin = key.origin
    this.model = options.model ?? process.env.AI_GATEWAY_MODEL ?? DEFAULT_JEV_MODEL
    const backend = dependencies.backend ?? GATEWAY_BACKEND_IDENTITY
    this.provider = backend.providerId
    this.profileId = backend.profileId
    this.backendJournal = { profileId: backend.profileId, provider: backend.providerId, model: this.model, keyOrigin: key.origin }
    this.requestEvaluation = dependencies.evaluate ?? evaluate
    this.wait = dependencies.sleep ?? sleepWithSignal
    this.random = dependencies.random ?? Math.random
    // Only the gateway primitive reads its credential from the environment. An
    // injected transport owns its credential; installing it here would hand one
    // provider's key to every other gateway caller in the process (System2).
    if (dependencies.evaluate === undefined) process.env.AI_GATEWAY_API_KEY = key.key
  }

  async decide(request: JevRequest, signal?: AbortSignal): Promise<JevResult> {
    const callId = randomUUID()
    const requested = request.questionNames ?? QUESTION_NAMES
    const questions = buildAuthorityQuestions(
      request.candidates,
      requested,
      request.decisionFrame?.instructions ?? AUTHORITY_PRIMARY_INSTRUCTIONS,
    )
    const modelState = authorityState(request) as Parameters<typeof evaluate>[0]['state']
    const maxGeneralAttempts = Math.max(1, this.options.maxRetries + 1)
    let generalAttempt = 0
    let providerAttempts = 0
    let rateAttempt = 0
    let rateWaitMs = 0
    let transientRetryCount = 0
    let transientWaitMs = 0

    for (;;) {
      if (signal?.aborted === true) throw new FatalModelError('jev-authority', generalAttempt, 'aborted before model call')
      generalAttempt += 1
      const started = Date.now()
      const timeout = AbortSignal.timeout(this.options.timeoutMs)
      const abortSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      try {
        providerAttempts += 1
        try {
          request.onProviderAttempt?.()
        } catch {
          // Telemetry must not prevent the provider call whose attempt it measures.
        }
        const response = await this.requestEvaluation({
          model: this.model,
          state: modelState,
          questions,
          maxRetries: 0,
          abortSignal,
        })
        const answers: Record<string, JevAnswer> = {}
        const isReachRouteFrame = request.decisionFrame?.kind === 'vtr-reach-route'
        for (const name of requested) {
          answers[name] = mapAnswer(name, response.answers[name], response.providerMetadata, isReachRouteFrame)
        }

        const action = answers.action
        if (action !== undefined) {
          const grounded =
            request.candidates.some((candidate) => candidate.id === action.value) ||
            // DECLINE is a legal label only when the offer was a singleton.
            (action.value === ACTION_DECLINE_LABEL && request.candidates.length === 1)
          if (!grounded) throw new Error(`Jev invented non-grounded action id ${JSON.stringify(action.value)}`)
        }

        // Reach route frames are scoped policy inputs owned by VTR. They do not
        // participate in the legacy Option/β authority contract, so neither the
        // journal nor the returned Jev result may carry Option identity or β
        // threshold/adoption metadata for this call.
        const authorityDecision = isReachRouteFrame ? undefined : authorityDecisionMeta(request, answers, this.options.abandonThreshold)
        const usage = readUsage(response.usage)
        const latencyMs = Date.now() - started
        const decisionJournal = authorityDecision === undefined ? {} : { decision: authorityDecision }
        this.options.writer.write({
          record: 'jev-call', backend: this.backendJournal,
          callId,
          ts: new Date().toISOString(),
          policy: this.kind,
          model: this.model,
          stage: request.stage,
          providerAttempts,
          latencyMs,
          rateLimitRetries: rateAttempt,
          rateLimitWaitMs: rateWaitMs,
          transientRetries: transientRetryCount,
          transientWaitMs,
          // IMPORTANT: this is the exact state supplied to evaluate(), making
          // authority/replay evidence inspectable rather than logging a different snapshot.
          state: modelState,
          questions,
          response: {
            model: this.model,
            usage,
            answers,
            requestId: reportedRequestId(response.providerMetadata),
          },
          error: null,
          authority: authorityJournal(request, decisionJournal),
        })
        const result = {
          callId,
          policy: this.kind,
          source: 'jev' as const,
          model: this.model,
          provider: this.provider,
          profileId: this.profileId,
          latencyMs,
          usage,
          answers,
          providerAttempts,
          ...(authorityDecision === undefined ? {} : { authorityDecision }),
        }
        return result
      } catch (error) {
        const message = describeProviderError(error)
        const providerDiagnostics = extractProviderErrorDiagnostics(error)
        const providerDiagnosticsField = providerDiagnostics === null ? {} : { providerDiagnostics }
        const callerCancelled = isSignalAborted(signal)
        const callTimedOut = timeout.aborted
        if (callerCancelled || (isCancellationFailure(error) && !callTimedOut)) {
          this.options.writer.write({
            record: 'jev-call', backend: this.backendJournal, callId, ts: new Date().toISOString(), policy: this.kind,
            model: this.model, stage: request.stage, latencyMs: Date.now() - started,
            rateLimitRetries: rateAttempt, rateLimitWaitMs: rateWaitMs,
            transientRetries: transientRetryCount, transientWaitMs,
            state: modelState, questions, response: null, error: message, providerAttempts,
            authority: authorityJournal(request, { failure: 'cancelled' }),
            ...providerDiagnosticsField,
          })
          throw new FatalModelError('jev-authority', generalAttempt, message)
        }
        const decisive = decisiveDecisionFailure(error)
        if (decisive !== null) {
          // Credentials, credit, entitlement or request/model identity: retrying
          // the same request cannot help, and a host retry would only rediscover
          // the same outage as fresh generations (INFRA_CHURN).
          this.options.writer.write({
            record: 'jev-call', backend: this.backendJournal, callId, ts: new Date().toISOString(), policy: this.kind,
            model: this.model, stage: request.stage, latencyMs: Date.now() - started,
            rateLimitRetries: rateAttempt, rateLimitWaitMs: rateWaitMs,
            transientRetries: transientRetryCount, transientWaitMs,
            state: modelState, questions, response: null, error: message, providerAttempts,
            authority: authorityJournal(request, { failure: `provider-unavailable-decisive:${decisive}` }),
            retryable: false,
            ...providerDiagnosticsField,
          })
          throw new FatalModelError('jev-authority', generalAttempt, message, false)
        }
        if (isRateLimit(error) && rateAttempt < this.options.rateLimitRetries) {
          rateAttempt += 1
          generalAttempt -= 1
          const configuredDelayMs = this.options.rateLimitBaseDelayMs * rateAttempt
          const delayMs = Math.min(
            TRANSIENT_RETRY_MAX_DELAY_MS,
            Math.max(configuredDelayMs, providerDiagnostics?.retryAfterMs ?? 0),
          )
          rateWaitMs += delayMs
          this.options.writer.write({
            record: 'jev-retry', callId, ts: new Date().toISOString(), attempt: rateAttempt,
            delayMs, totalWaitMs: rateWaitMs, error: message,
            providerAttempts,
            ...providerDiagnosticsField,
          })
          try {
            await this.wait(delayMs, signal)
          } catch (waitError) {
            if (isSignalAborted(signal) || isCancellationFailure(waitError)) {
              throw new FatalModelError('jev-authority', Math.max(1, generalAttempt), 'aborted during rate-limit retry wait')
            }
            throw waitError
          }
          continue
        }
        if ((callTimedOut && isCancellationFailure(error)) || isTransientProviderFailure(error)) {
          const retryableStatus = !isRateLimit(error) && generalAttempt < maxGeneralAttempts
          if (retryableStatus) {
            const retryDelayMs = transientRetryDelayMs(
              transientRetryCount + 1,
              providerDiagnostics?.retryAfterMs,
              this.random,
            )
            transientRetryCount += 1
            transientWaitMs += retryDelayMs
            this.options.writer.write({
              record: 'jev-call', backend: this.backendJournal, callId, ts: new Date().toISOString(), policy: this.kind,
              model: this.model, stage: request.stage, latencyMs: Date.now() - started,
              rateLimitRetries: rateAttempt, rateLimitWaitMs: rateWaitMs,
              transientRetries: transientRetryCount, transientWaitMs,
              state: modelState, questions, response: null, error: message, providerAttempts,
              authority: authorityJournal(request, { failure: 'transient-provider-retry' }),
              retryScheduled: true,
              ...providerDiagnosticsField,
            })
            this.options.writer.write({
              record: 'jev-retry', callId, ts: new Date().toISOString(),
              attempt: generalAttempt, delayMs: retryDelayMs, totalWaitMs: rateWaitMs + transientWaitMs,
              retryClass: 'transient-provider', error: message, providerAttempts,
              ...providerDiagnosticsField,
            })
            try {
              await this.wait(retryDelayMs, signal)
            } catch (waitError) {
              if (isSignalAborted(signal) || isCancellationFailure(waitError)) {
                throw new FatalModelError('jev-authority', generalAttempt, 'aborted during transient retry wait')
              }
              throw waitError
            }
            if (isSignalAborted(signal)) {
              throw new FatalModelError('jev-authority', generalAttempt, 'aborted during transient retry wait')
            }
            continue
          }
          this.options.writer.write({
            record: 'jev-call', backend: this.backendJournal, callId, ts: new Date().toISOString(), policy: this.kind,
            model: this.model, stage: request.stage, latencyMs: Date.now() - started,
            rateLimitRetries: rateAttempt, rateLimitWaitMs: rateWaitMs,
            transientRetries: transientRetryCount, transientWaitMs, state: modelState, providerAttempts,
            questions, response: null, error: message,
            authority: authorityJournal(request, { failure: 'transient-provider-unavailable' }),
            retryable: true,
            ...providerDiagnosticsField,
          })
          throw new FatalModelError('jev-authority', generalAttempt, message, true)
        }
        if (generalAttempt < maxGeneralAttempts) {
          this.options.writer.write({
            record: 'jev-retry', callId, ts: new Date().toISOString(), attempt: generalAttempt,
            delayMs: 0, totalWaitMs: rateWaitMs, error: message,
            providerAttempts,
            ...providerDiagnosticsField,
          })
          continue
        }
        this.options.writer.write({
          record: 'jev-call', backend: this.backendJournal, callId, ts: new Date().toISOString(), policy: this.kind,
          model: this.model, stage: request.stage, latencyMs: Date.now() - started,
          rateLimitRetries: rateAttempt, rateLimitWaitMs: rateWaitMs,
          transientRetries: transientRetryCount, transientWaitMs, state: modelState, providerAttempts,
          questions, response: null, error: message,
          authority: authorityJournal(request, { failure: 'fatal-no-fallback' }),
          ...providerDiagnosticsField,
        })
        throw new FatalModelError('jev-authority', generalAttempt, message)
      }
    }
  }
}
