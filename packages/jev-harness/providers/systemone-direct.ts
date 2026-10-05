// jev-harness/providers/systemone-direct.ts - direct System One wire adapter
// for Typed Decision Plane backend profiles.
//
// Alongside providers/typesafe.ts this is the only place allowed to import a
// decision-model provider SDK (#438 section 1/22 I1). It speaks TypeSafe's
// `POST /v1/systemone` wire dialect through the official SDK, pointed at the
// PROFILE's API root with the PROFILE's own credential, and returns the same
// evaluate()-shaped reply the authority policy already consumes, so nothing
// above this file branches on provider or model names.
//
// Owns: the credential (held in-process only: never env, argv, logs or
// journals), wire mapping (repo `boolean` <-> wire `noul`), strict fail-closed
// answer validation, model identity, typed availability classification.
// Does not own: retries (the SDK retry loop is disabled; the policy above
// owns one bounded budget), thresholds, candidates, or any Minecraft semantics.

import { readFileSync } from 'node:fs'
import type { experimental_evaluate } from 'ai'
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
  TypeSafeError,
} from '@typesafe-ai/sdk'
import type { Fetch, Questions } from '@typesafe-ai/sdk'

export type DecisionWireDialect = 'ai-gateway-evaluate' | 'typesafe-systemone/v1'

export interface DecisionBackendProfile {
  readonly profileId: string
  readonly providerId: string
  readonly modelId: string
  readonly wireDialect: DecisionWireDialect
  /**
   * API root before `/v1/systemone` (path prefixes are kept); null for the
   * gateway dialect, which routes by model id. Liquid's root was settled by live
   * discovery 2026-10-05: `/decisions/v1/models` lists d1 + d1:free, while the
   * bare host serves the console web app (404 HTML).
   */
  readonly baseURL: string | null
  /** Credential file. Its PATH is non-secret provenance; null = the dialect's own resolver. */
  readonly secretFile: string | null
  /** Declared meaning of reported confidence. Thresholds never transfer between models by default. */
  readonly confidence: 'provider-calibrated' | 'provider-reported-unmeasured'
}

/**
 * Explicit, provenance-visible backend profiles. Selecting one is a
 * configuration act; no code path substitutes another profile or model when a
 * call fails. `d1:free` is a distinct model with its own explicit profile; a
 * `liquid-direct-d1` failure never reaches it.
 */
export const DECISION_PROFILES: Readonly<Record<string, DecisionBackendProfile>> = {
  'typesafe-gateway-jev': {
    profileId: 'typesafe-gateway-jev',
    providerId: 'typesafe-ai',
    modelId: 'typesafe-ai/jev',
    wireDialect: 'ai-gateway-evaluate',
    baseURL: null,
    secretFile: null,
    confidence: 'provider-calibrated',
  },
  'liquid-direct-d1': {
    profileId: 'liquid-direct-d1',
    providerId: 'liquid',
    modelId: 'd1',
    wireDialect: 'typesafe-systemone/v1',
    baseURL: 'https://api.liquid.ai/decisions',
    secretFile: '/home/s0u7a/.config/mc-ai-secrets/liquid-api.key',
    confidence: 'provider-reported-unmeasured',
  },
  'liquid-direct-d1-free': {
    profileId: 'liquid-direct-d1-free',
    providerId: 'liquid',
    modelId: 'd1:free',
    wireDialect: 'typesafe-systemone/v1',
    baseURL: 'https://api.liquid.ai/decisions',
    secretFile: '/home/s0u7a/.config/mc-ai-secrets/liquid-api.key',
    confidence: 'provider-reported-unmeasured',
  },
}

/** Operator-selected primary Typed Decision Plane backend (2026-10-05). */
export const DEFAULT_DECISION_PROFILE_ID = 'liquid-direct-d1'

export interface DecisionCredential {
  readonly key: string
  /** Where the key came from; never the key. */
  readonly origin: string
}

/** Read a profile's credential file; null when absent/empty. The value is never logged. */
export function resolveProfileCredential(profile: DecisionBackendProfile): DecisionCredential | null {
  if (profile.secretFile === null) return null
  try {
    const key = readFileSync(profile.secretFile, 'utf8').trim()
    return key.length > 0 ? { key, origin: `file:${profile.secretFile}` } : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// typed availability
// ---------------------------------------------------------------------------

export type DecisionAvailability =
  | 'auth'
  | 'credit'
  | 'entitlement'
  | 'bad_request'
  | 'model_identity'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'timeout'
  | 'malformed'

/** Retrying the same request cannot fix these: credentials, credit, entitlement, request/model identity. */
const DECISIVE = new Set<DecisionAvailability>(['auth', 'credit', 'entitlement', 'bad_request', 'model_identity'])
const TRANSIENT = new Set<DecisionAvailability>(['rate_limited', 'server', 'network', 'timeout'])

/**
 * A typed transport failure. `status` mirrors the HTTP status so the policy's
 * status classifiers (429 / 5xx) keep working; the SDK error is kept as
 * `cause` for allowlisted diagnostics (status, retry-after, request id) only.
 */
export class DecisionUnavailableError extends Error {
  readonly availability: DecisionAvailability
  readonly decisive: boolean
  readonly retryable: boolean
  readonly status: number | undefined

  constructor(availability: DecisionAvailability, message: string, detail: { status?: number; cause?: unknown } = {}) {
    super(`${availability}: ${message}`, detail.cause === undefined ? undefined : { cause: detail.cause })
    this.name = 'DecisionUnavailableError'
    this.availability = availability
    this.decisive = DECISIVE.has(availability)
    this.retryable = TRANSIENT.has(availability)
    this.status = detail.status
  }
}

/** Credit/billing exhaustion is decisive whatever status carries it (402, 403, 429 or a 5xx). */
const CREDIT_TEXT = /credit|balance|billing|payment required|top[ -]?up|insufficient[ _](?:funds|quota)/i

function scrub(text: string, key: string): string {
  const cleaned = key.length > 0 ? text.split(key).join('[REDACTED]') : text
  return cleaned.replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 300)
}

/** SDK error -> typed failure. Caller/policy aborts surface as a plain AbortError. */
export function classifyDecisionError(error: unknown, key: string): unknown {
  if (error instanceof DecisionUnavailableError) return error
  if (error instanceof APIUserAbortError) return new DOMException('decision request aborted', 'AbortError')
  if (error instanceof APITimeoutError) return new DecisionUnavailableError('timeout', scrub(error.message, key), { cause: error })
  if (error instanceof APIConnectionError) return new DecisionUnavailableError('network', scrub(error.message, key), { cause: error })
  if (error instanceof APIError) {
    const status = error.status
    const message = scrub(error.message, key)
    const detail = { status, cause: error }
    if (status === 402 || CREDIT_TEXT.test(message)) return new DecisionUnavailableError('credit', message, detail)
    if (status === 401) return new DecisionUnavailableError('auth', message, detail)
    if (status === 403) return new DecisionUnavailableError('entitlement', message, detail)
    if (status === 429) return new DecisionUnavailableError('rate_limited', message, detail)
    if (status === 408) return new DecisionUnavailableError('timeout', message, detail)
    if (status >= 500) return new DecisionUnavailableError('server', message, detail)
    return new DecisionUnavailableError('bad_request', message, detail)
  }
  if (error instanceof TypeSafeError) return new DecisionUnavailableError('bad_request', scrub(error.message, key), { cause: error })
  return error
}

// ---------------------------------------------------------------------------
// request mapping + strict reply validation
// ---------------------------------------------------------------------------

type RepoQuestion = { readonly type: string; readonly instructions?: unknown; readonly criteria?: unknown }

export interface OfferedQuestion {
  readonly wire: 'choice' | 'score' | 'noul'
  /** choice: exact labels; score: ordered rubric levels. */
  readonly labels: readonly string[]
}

function malformed(message: string): DecisionUnavailableError {
  return new DecisionUnavailableError('malformed', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

export function toSystemOneQuestions(
  questions: Readonly<Record<string, RepoQuestion>>,
): { wire: Questions; offered: Map<string, OfferedQuestion> } {
  const wire: Record<string, Questions[string]> = {}
  const offered = new Map<string, OfferedQuestion>()
  for (const [name, question] of Object.entries(questions)) {
    const instructions = typeof question.instructions === 'string' ? question.instructions : null
    const criteria = question.criteria
    if (question.type === 'choice') {
      if (!isRecord(criteria) || Object.keys(criteria).length === 0) throw new DecisionUnavailableError('bad_request', `choice ${name} has no labels`)
      const described: Record<string, string> = {}
      for (const [label, text] of Object.entries(criteria)) described[label] = String(text)
      wire[name] = { type: 'choice', instructions, criteria: described }
      offered.set(name, { wire: 'choice', labels: Object.keys(described) })
    } else if (question.type === 'score') {
      if (!Array.isArray(criteria) || criteria.length < 2) throw new DecisionUnavailableError('bad_request', `score ${name} needs >= 2 rubric levels`)
      const levels = criteria.map((level) => String(level))
      wire[name] = { type: 'score', instructions, criteria: levels as unknown as readonly [string, string, ...string[]] }
      offered.set(name, { wire: 'score', labels: levels })
    } else if (question.type === 'boolean') {
      const outcomes = isRecord(criteria) ? criteria : {}
      wire[name] = {
        type: 'noul',
        instructions,
        criteria: {
          ...(outcomes.true === undefined ? {} : { true: String(outcomes.true) }),
          ...(outcomes.false === undefined ? {} : { false: String(outcomes.false) }),
        },
      }
      offered.set(name, { wire: 'noul', labels: [] })
    } else {
      throw new DecisionUnavailableError('bad_request', `question ${name} has unsupported type ${JSON.stringify(question.type)}`)
    }
  }
  return { wire: wire as Questions, offered }
}

/** A distribution over exactly `labels`, each in [0,1], summing to ~1 (providers round). */
function distribution(name: string, raw: unknown, labels: readonly string[]): Record<string, number> {
  if (!isRecord(raw)) throw malformed(`${name}: probabilities missing`)
  const keys = Object.keys(raw)
  const expected = new Set(labels)
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw malformed(`${name}: probability keys ${JSON.stringify(keys.slice(0, 8))} differ from the offered labels`)
  }
  const out: Record<string, number> = {}
  let sum = 0
  for (const label of labels) {
    const value = raw[label]
    if (!unitInterval(value)) throw malformed(`${name}: probability for ${JSON.stringify(label)} is not in [0,1]`)
    out[label] = value
    sum += value
  }
  if (Math.abs(sum - 1) > Math.max(0.02, 0.005 * labels.length)) throw malformed(`${name}: probabilities sum to ${sum}`)
  return out
}

function reportedConfidence(name: string, answer: Record<string, unknown>): number | null {
  if (answer.confidence === undefined || answer.confidence === null) return null
  if (!unitInterval(answer.confidence)) throw malformed(`${name}: confidence is not in [0,1]`)
  return answer.confidence
}

export interface NormalizedSystemOneReply {
  readonly answers: Record<string, unknown>
  readonly confidence: Record<string, number>
  readonly usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } | null
}

/** Validate every requested answer against what was offered; anything else fails closed. */
export function normalizeSystemOneReply(
  data: unknown,
  offered: ReadonlyMap<string, OfferedQuestion>,
  modelId: string,
): NormalizedSystemOneReply {
  if (!isRecord(data)) throw malformed('reply body is not an object')
  if (data.model !== modelId) {
    throw new DecisionUnavailableError('model_identity', `requested ${modelId} but provider reported ${JSON.stringify(data.model ?? null)}`)
  }
  const answers = data.answers
  if (!isRecord(answers)) throw malformed('reply carries no answers object')
  const out: Record<string, unknown> = {}
  const confidence: Record<string, number> = {}
  for (const [name, question] of offered) {
    const answer = answers[name]
    if (!isRecord(answer)) throw malformed(`${name}: answer missing`)
    if (answer.type !== question.wire) throw malformed(`${name}: answer type ${JSON.stringify(answer.type)} != ${question.wire}`)
    const reported = reportedConfidence(name, answer)
    if (reported !== null) confidence[name] = reported
    if (question.wire === 'choice') {
      if (typeof answer.choice !== 'string' || !question.labels.includes(answer.choice)) {
        throw malformed(`${name}: choice ${JSON.stringify(answer.choice)} is not an offered label`)
      }
      out[name] = { type: 'choice', choice: answer.choice, probabilities: distribution(name, answer.probabilities, question.labels) }
    } else if (question.wire === 'score') {
      const levels = question.labels
      const score = answer.score
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > levels.length - 1) {
        throw malformed(`${name}: score ${JSON.stringify(score)} is outside the rubric`)
      }
      if (answer.legend !== undefined) {
        const legend = answer.legend
        if (!isRecord(legend) || Object.keys(legend).length !== levels.length || levels.some((level, index) => legend[String(index)] !== level)) {
          throw malformed(`${name}: legend does not preserve the rubric order`)
        }
      }
      const indices = levels.map((_, index) => String(index))
      out[name] = { type: 'score', score, probabilities: distribution(name, answer.probabilities, indices) }
    } else {
      if (!unitInterval(answer.noul)) throw malformed(`${name}: noul is not a probability in [0,1]`)
      out[name] = { type: 'boolean', probability: answer.noul }
    }
  }
  const usage = isRecord(data.usage) ? data.usage : null
  const input = typeof usage?.input_tokens === 'number' ? usage.input_tokens : null
  const output = typeof usage?.output_tokens === 'number' ? usage.output_tokens : null
  return {
    answers: out,
    confidence,
    usage: usage === null ? null : { inputTokens: input, outputTokens: output, totalTokens: input === null || output === null ? null : input + output },
  }
}

const REQUEST_ID_HEADERS = ['x-typesafe-request-id', 'x-request-id', 'request-id'] as const

function safeRequestId(headers: Headers, sdkRequestId: string | undefined): string | null {
  for (const candidate of [sdkRequestId, ...REQUEST_ID_HEADERS.map((name) => headers.get(name) ?? undefined)]) {
    if (typeof candidate === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(candidate)) return candidate
  }
  return null
}

// ---------------------------------------------------------------------------
// backend
// ---------------------------------------------------------------------------

export interface DirectDecisionBackend {
  readonly profile: DecisionBackendProfile
  readonly keyOrigin: string
  /** evaluate()-shaped call for the authority policy's existing transport seam. */
  readonly evaluate: typeof experimental_evaluate
  /** Account model discovery (acceptance probe; not used per decision). */
  listModels(signal?: AbortSignal): Promise<string[]>
}

export interface DirectDecisionBackendOptions {
  /** Per-attempt SDK timeout; the policy's own abort signal normally fires first. */
  readonly timeoutMs: number
  /** Transport seam for deterministic tests. */
  readonly fetch?: Fetch
}

export function createDirectDecisionBackend(
  profile: DecisionBackendProfile,
  credential: DecisionCredential,
  options: DirectDecisionBackendOptions,
): DirectDecisionBackend {
  if (profile.wireDialect !== 'typesafe-systemone/v1' || profile.baseURL === null) {
    throw new DecisionUnavailableError('bad_request', `profile ${profile.profileId} is not a direct System One profile`)
  }
  // Explicit options only: TYPESAFE_* environment variables can never redirect
  // this profile to another root, model or credential.
  const client = new TypeSafeClient({
    apiKey: credential.key,
    baseURL: profile.baseURL,
    defaultModel: profile.modelId,
    logLevel: 'off',
    retry: { maxRetries: 0 },
    timeout: options.timeoutMs,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
  const key = credential.key

  const evaluate = async (args: { model: unknown; state: unknown; questions: unknown; abortSignal?: AbortSignal }) => {
    if (args.model !== profile.modelId) {
      throw new DecisionUnavailableError('model_identity', `policy requested ${JSON.stringify(args.model)} from profile ${profile.profileId} (${profile.modelId})`)
    }
    const { wire, offered } = toSystemOneQuestions(args.questions as Readonly<Record<string, RepoQuestion>>)
    try {
      const { data, response, requestId } = await client
        .systemOne(
          { model: profile.modelId, state: args.state as never, questions: wire },
          { ...(args.abortSignal === undefined ? {} : { signal: args.abortSignal }), retry: { maxRetries: 0 } },
        )
        .withResponse()
      const reply = normalizeSystemOneReply(data, offered, profile.modelId)
      return {
        answers: reply.answers,
        usage: reply.usage,
        providerMetadata: {
          systemone: {
            confidence: reply.confidence,
            reportedModel: profile.modelId,
            requestId: safeRequestId(response.headers, requestId),
            profileId: profile.profileId,
            providerId: profile.providerId,
          },
        },
      }
    } catch (error) {
      throw classifyDecisionError(error, key)
    }
  }

  return {
    profile,
    keyOrigin: credential.origin,
    evaluate: evaluate as unknown as typeof experimental_evaluate,
    async listModels(signal?: AbortSignal): Promise<string[]> {
      try {
        const cards = await client.models.list({ ...(signal === undefined ? {} : { signal }), retry: { maxRetries: 0 } })
        return Array.isArray(cards) ? cards.map((card) => String(card?.name)) : []
      } catch (error) {
        throw classifyDecisionError(error, key)
      }
    },
  }
}
