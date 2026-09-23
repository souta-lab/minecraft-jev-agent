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
// §437 §1/§10: the model-visible half of the semantic projection (no raw telemetry,
// and the exact top-level keys the projection hash covers).
import { projectionModelView } from './jevSemanticProjection.ts'
import type { JevSemanticProjection } from './jevSemanticProjection.ts'
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
 *
 * Issue #437: when the caller supplies the versioned semantic projection, that
 * projection IS the semantic state - the primitive churn (`tick`, the raw float
 * body position, the per-tick `recentEvents` trace) is replaced by the bounded
 * semantic plane. Every count-bounded evidence block the prompts refer to by
 * name (`signals.strategicNonProgress`, `signals.threat`, `failedCandidates`,
 * `nearestEntities`, ...) is preserved unchanged, because the beta contract
 * reads them by name.
 */
export function authorityState(request: JevRequest): Record<string, unknown> {
  const state = request.state
  const projection = request.semanticProjection ?? null
  const self = {
    position: state.self.position,
    health: state.self.health,
    food: state.self.food,
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
    signals,
  }
  if (projection === null || typeof projection !== 'object') {
    return { tick: state.tick, self, ...shared, recentEvents: state.recentEvents.slice(-16) }
  }
  // §437: the semantic plane replaces the primitive trace. The body's exact float
  // position is mechanical detail (candidate distance/reach facts carry what the
  // decision needs), and the per-tick event trace is replaced by the projection's
  // bounded meaningful event kinds plus its previous-decision/outcome block.
  //
  // §1/§10: `projectionModelView` is the projection minus its evidence-only
  // `counts` block, so the payload's top-level keys are exactly the keys the
  // projection hash covers. Shipping the raw object instead would put the
  // compressed `rawSkillSteps`/`rawEvents` telemetry into policy input and let the
  // payload drift from its own cache key.
  const modelView = projectionModelView(projection as JevSemanticProjection)
  return {
    projectionVersion: modelView.version,
    projectionHash: request.projectionHash ?? null,
    semantic: modelView,
    self: {
      ...self,
      position: {
        x: Math.floor(state.self.position.x),
        y: Math.floor(state.self.position.y),
        z: Math.floor(state.self.position.z),
      },
      dimension: state.self.dimension,
    },
    ...shared,
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

/** Retryable transport/provider failures require a fresh decision epoch. */
export function isTransientProviderFailure(error: unknown, depth = 0): boolean {
  if (typeof error === 'string') {
    return /503|service temporarily unavailable|service unavailable|upstream unavailable|connection reset|ECONN(?:RESET|REFUSED|ABORTED)|EPIPE|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|timed? ?out/i.test(error)
  }
  if (depth > 5 || typeof error !== 'object' || error === null) return false
  const row = error as Record<string, unknown>
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

/** Bounded, secret-safe diagnostics copied from known AI SDK error fields only. */
export interface ProviderErrorDiagnostics {
  httpStatus?: number
  providerErrorCode?: string
  providerErrorType?: string
  errorName?: string
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
      requestIds.push(...requestIdFromHeaders(readErrorField(row, headerKey)))
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
        const message = describeProviderError(error)
        const providerDiagnostics = extractProviderErrorDiagnostics(error)
        const providerDiagnosticsField = providerDiagnostics === null ? {} : { providerDiagnostics }
        if (isRateLimit(error) && rateAttempt < this.options.rateLimitRetries) {
          rateAttempt += 1
          generalAttempt -= 1
          const delayMs = this.options.rateLimitBaseDelayMs * rateAttempt
          rateWaitMs += delayMs
          this.options.writer.write({
            record: 'jev-retry', callId, ts: new Date().toISOString(), attempt: rateAttempt,
            delayMs, totalWaitMs: rateWaitMs, error: message,
            ...providerDiagnosticsField,
          })
          await sleep(delayMs)
          continue
        }
        if (isTransientProviderFailure(error)) {
          this.options.writer.write({
            record: 'jev-call', callId, ts: new Date().toISOString(), policy: this.kind,
            model: this.model, stage: request.stage, latencyMs: Date.now() - started,
            rateLimitRetries: rateAttempt, rateLimitWaitMs: rateWaitMs, state: modelState,
            questions, response: null, error: message,
            authority: { pi: 'model', beta: 'model', failure: 'transient-provider-unavailable' },
            retryable: true,
            ...providerDiagnosticsField,
          })
          throw new FatalModelError('jev-authority', generalAttempt, message, true)
        }
        if (generalAttempt < maxGeneralAttempts) {
          this.options.writer.write({
            record: 'jev-retry', callId, ts: new Date().toISOString(), attempt: generalAttempt,
            delayMs: 0, totalWaitMs: rateWaitMs, error: message,
            ...providerDiagnosticsField,
          })
          continue
        }
        this.options.writer.write({
          record: 'jev-call', callId, ts: new Date().toISOString(), policy: this.kind,
          model: this.model, stage: request.stage, latencyMs: Date.now() - started,
          rateLimitRetries: rateAttempt, rateLimitWaitMs: rateWaitMs, state: modelState,
          questions, response: null, error: message,
          authority: { pi: 'model', beta: 'model', failure: 'fatal-no-fallback' },
          ...providerDiagnosticsField,
        })
        throw new FatalModelError('jev-authority', generalAttempt, message)
      }
    }
  }
}
