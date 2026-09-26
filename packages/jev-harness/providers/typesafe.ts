// jev-harness/providers/typesafe.ts - the TypeSafe / AI-Gateway Jev adapter.
//
// THIS IS THE ONLY FILE IN THE REPOSITORY ALLOWED TO IMPORT THE JEV PROVIDER
// PRIMITIVE (#438 section 1/22 I1). Everything above it speaks repo terms.
//
// The adapter maps the repo's typed questions onto the provider's
// `experimental_evaluate` primitives and returns provider-shaped answers plus
// metadata. It does not decode, threshold, retry-by-policy, or know what a
// Minecraft action is.
//
// `createTypesafeAdapter({ evaluate })` accepts an injected evaluate function so
// the mapping is unit-testable without a live gateway; production wiring uses the
// real `experimental_evaluate` import below.

import { experimental_evaluate } from 'ai'
import type { Experimental_EvaluationQuestion } from 'ai'
import type {
  JevProviderAdapter,
  ProviderDispatchRequest,
  ProviderDispatchResponse,
  ProviderQuestion,
  ProviderRawAnswer,
  ProviderUsage,
} from '../provider.ts'
import { classifyProviderError, describeError, providerAborted } from '../provider.ts'

type EvaluateFn = typeof experimental_evaluate
type EvaluateState = Parameters<EvaluateFn>[0]['state']
type EvaluateQuestions = Parameters<EvaluateFn>[0]['questions']

export interface TypesafeAdapterOptions {
  /** Production default: the real AI SDK primitive. */
  readonly evaluate?: EvaluateFn
  /** Gateway model id, e.g. `typesafe-ai/jev`. */
  readonly model: string
  /**
   * Gateway key. Authentication belongs to the adapter (#438 section 16). The
   * wiring layer resolves the key exactly as it does today; the adapter only
   * installs it for the provider's request-time read.
   */
  readonly apiKey?: string | null
  readonly providerId?: string
  /** Test seam for "the provider never answers". */
  readonly timeoutMs?: number
}

export class TypesafeJevAdapter implements JevProviderAdapter {
  readonly providerId: string

  constructor(private readonly options: TypesafeAdapterOptions) {
    this.providerId = options.providerId ?? 'typesafe-ai'
  }

  get modelId(): string {
    return this.options.model
  }

  async dispatch(request: ProviderDispatchRequest, signal?: AbortSignal): Promise<ProviderDispatchResponse> {
    if (signal?.aborted === true) throw providerAborted('aborted before the provider call')
    if (this.options.apiKey !== undefined && this.options.apiKey !== null) {
      // The gateway provider reads this at request time; the value is never logged.
      process.env.AI_GATEWAY_API_KEY = this.options.apiKey
    }
    const evaluate = this.options.evaluate ?? experimental_evaluate
    const questions = buildProviderQuestions(request.questions) as EvaluateQuestions
    const timeoutMs = this.options.timeoutMs ?? request.timeoutMs
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const abortSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
    try {
      const response = await evaluate({
        model: this.options.model,
        state: request.projection as EvaluateState,
        questions,
        // Transport retry policy is the HARNESS's job (#438 section 8); the SDK
        // must not silently retry a semantic request.
        maxRetries: 0,
        abortSignal,
      })
      const rawAnswers = response.answers as Record<string, unknown>
      const answers: Record<string, ProviderRawAnswer> = {}
      for (const questionId of request.questionIds) {
        answers[questionId] = { questionId, raw: rawAnswers[questionId] }
      }
      return {
        provider: this.providerId,
        model: this.options.model,
        answers,
        providerMetadata: response.providerMetadata,
        usage: readUsage(response.usage),
      }
    } catch (error) {
      throw classifyProviderError(error, signal)
    }
  }
}

export function createTypesafeAdapter(options: TypesafeAdapterOptions): TypesafeJevAdapter {
  return new TypesafeJevAdapter(options)
}

/**
 * Repo question -> provider question. This mapping (and the provider's
 * `criteria` shapes) is the ONLY provider-specific knowledge in the harness.
 */
export function buildProviderQuestions(questions: readonly ProviderQuestion[]): Record<string, Experimental_EvaluationQuestion> {
  const out: Record<string, Experimental_EvaluationQuestion> = {}
  for (const question of questions) {
    switch (question.primitive) {
      case 'choice':
        out[question.id] = {
          type: 'choice',
          instructions: question.instructions,
          criteria: normalizeCriteriaRecord(question.id, question.criteria),
        }
        break
      case 'score':
        out[question.id] = {
          type: 'score',
          instructions: question.instructions,
          criteria: normalizeCriteriaLevels(question.id, question.criteria),
        }
        break
      case 'boolean':
        out[question.id] = {
          type: 'boolean',
          instructions: question.instructions,
          criteria: normalizeCriteriaRecord(question.id, question.criteria),
        }
        break
    }
  }
  return out
}

function normalizeCriteriaRecord(
  questionId: string,
  criteria: Readonly<Record<string, string>> | readonly string[],
): Record<string, string> {
  if (Array.isArray(criteria)) {
    const record: Record<string, string> = {}
    criteria.forEach((entry, index) => {
      record[String(index)] = entry
    })
    return record
  }
  const record: Record<string, string> = {}
  for (const [key, value] of Object.entries(criteria as Record<string, string>)) record[key] = value
  if (Object.keys(record).length === 0) throw new Error(`provider question ${questionId} has no criteria`)
  return record
}

function normalizeCriteriaLevels(
  questionId: string,
  criteria: Readonly<Record<string, string>> | readonly string[],
): readonly string[] {
  if (Array.isArray(criteria)) {
    if (criteria.length === 0) throw new Error(`provider score question ${questionId} has no scale levels`)
    return [...criteria]
  }
  const values = Object.values(criteria as Record<string, string>)
  if (values.length === 0) throw new Error(`provider score question ${questionId} has no scale levels`)
  return values
}

function readUsage(usage: unknown): ProviderUsage | null {
  if (typeof usage !== 'object' || usage === null) return null
  const row = usage as Record<string, unknown>
  return {
    inputTokens: readNumber(row, 'inputTokens'),
    outputTokens: readNumber(row, 'outputTokens'),
    totalTokens: readNumber(row, 'totalTokens'),
  }
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Diagnostic helper used by the firewall test to name the exact module. */
export const TYPESAFE_ADAPTER_MODULE = new URL(import.meta.url).pathname

export { describeError }
