// system2-harness/providers/aiGateway.ts - the AI-SDK gateway provider adapter
// (#439 sections 1/15/16/22).
//
// This is the ONLY production module in the repository that calls `generateText`.
// `buddy-driver/mercury-system2.ts` is the legacy adapter being replaced by this
// one (see the Phase C-E mapping in README.md); until that migration lands, both
// exist, and the S1 ratchet test in bun-tests pins the legacy import set so no NEW
// direct provider call can appear.
//
// Boundaries this adapter respects:
//   * it returns RAW provider output (`RawProviderResponse`); it never decides what
//     the model meant. `harness.ts` owns strict decoding (#439 section 6/7);
//   * `maxRetries: 0`: the harness owns retry currency. An adapter that retried on
//     its own would repeat a request whose epoch may already have moved
//     (#439 section 16);
//   * it never sees a bot, planner, controller or OptionGraph: dispatch takes a
//     rendered prompt and plain identity data only;
//   * failure classification is delegated to `classifyProviderError`, so the
//     adapter classifies and the harness decides (#439 section 15).

import { generateText, jsonSchema, tool } from 'ai'
import type { LanguageModel } from 'ai'
import type { System2ProviderDispatchRequest, System2ProviderDispatchResponse, System2ProviderAdapter } from '../provider.ts'
import { classifyProviderError } from '../provider.ts'
import type { RawProviderResponse } from '../schema.ts'
import type { ProviderIdentity } from '../versions.ts'

export type AiGatewayTransportMode = 'tool-call' | 'json-text'

/**
 * Models that reject a NAMED `tool_choice` on the gateway
 * (`GatewayInternalServerError: only "auto" is supported for tool_choice`).
 * They get the json-text transport, where the model answers in text and the
 * harness's strict decoder decides whether that text is a valid proposal.
 * This is configuration, not game logic: `transport` can force either mode.
 */
export const KNOWN_JSON_TEXT_MODELS: readonly string[] = ['muse-spark-1.3-contributor']

/** Legacy-compatible model quirk resolution, kept as an overridable default. */
export function defaultTransportForModel(modelId: string): AiGatewayTransportMode {
  const id = modelId.trim().toLowerCase()
  for (const quirk of KNOWN_JSON_TEXT_MODELS) {
    if (id === quirk || id.endsWith(`/${quirk}`)) return 'json-text'
  }
  return 'tool-call'
}

export interface AiGatewayProviderOptions {
  /** Role-level provider id recorded in artifacts/cache identity. */
  readonly providerId?: string
  /**
   * Concrete model id as configuration (e.g. `meta/muse-spark-1.3-contributor`).
   * Swapping it requires no gameplay/controller change (#439 S15).
   */
  readonly modelId: string
  /** `auto` follows `defaultTransportForModel`. */
  readonly transport?: AiGatewayTransportMode | 'auto'
  /**
   * Extra system preamble. The prompt itself already states the contract; this is
   * for transport-level instructions such as "answer only through the tool".
   */
  readonly systemSuffix?: string
  readonly maxOutputTokens?: number
  /** Override the model-quirk resolution (tests / new providers). */
  readonly transportFromModel?: (modelId: string) => AiGatewayTransportMode
  /**
   * Resolved SDK model. Defaults to resolving `modelId` through the configured
   * provider (the AI Gateway). A composition-root seam, and the only way to run
   * this adapter's real `generateText` path without network access — see
   * `bun-tests/ai-gateway-transport.test.ts`.
   */
  readonly model?: LanguageModel
}

export const SYSTEM2_JSON_TEXT_INSTRUCTIONS =
  'Answer with ONE JSON object and nothing else. No prose, no markdown fence, no commentary before or after. ' +
  'A response that is not exactly one JSON object matching the schema is rejected by a deterministic decoder.'

const TOOL_CALL_INSTRUCTIONS = 'Return ONLY via the emitSystem2Proposal tool. Do not answer in response text.'

/**
 * The tool schema is a HINT to the provider. It is intentionally plain JSON Schema
 * (no runtime validation library) so the harness's own strict decoder stays the one
 * authority: a tool call that passes the provider's schema still has to survive
 * `decodeSystem2Proposal` unchanged.
 */
const SYSTEM2_PROPOSAL_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['operation', 'intents'],
  properties: {
    operation: { type: 'string', enum: ['replace', 'append', 'suspend', 'resume', 'repair'] },
    rationale: { type: 'string', description: 'diagnostic only; never authority' },
    intents: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['intentText', 'desiredPredicates'],
        properties: {
          intentText: { type: 'string' },
          completionSemantics: { type: 'string', enum: ['all', 'any'] },
          desiredPredicates: { type: 'array', items: { $ref: '#/properties/intents/items/properties/predicate' } },
          dependencies: { type: 'array', items: { $ref: '#/properties/intents/items/properties/predicate' } },
          targetRef: {
            type: 'object',
            description: 'a grounded id from the state, or a symbolic description; never a coordinate',
          },
          predicate: {
            type: 'object',
            required: ['kind'],
            properties: {
              kind: {
                type: 'string',
                enum: ['acquire', 'ensure', 'reach', 'find', 'establish', 'interact', 'preserve', 'recover'],
              },
              args: { type: 'object' },
            },
          },
        },
      },
    },
  },
} as const

export function aiGatewayProviderIdentity(options: AiGatewayProviderOptions): ProviderIdentity {
  const transport =
    options.transport === undefined || options.transport === 'auto'
      ? (options.transportFromModel ?? defaultTransportForModel)(options.modelId)
      : options.transport
  return {
    providerId: options.providerId ?? 'ai-gateway',
    modelId: options.modelId,
    transport,
  }
}

function combineSignals(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (signal === undefined) return timeout
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([timeout, signal])
  return timeout
}

/**
 * Build the gateway adapter. Returns the SAME seam the replay adapter implements,
 * so a scenario can be replayed provider-free without touching the harness
 * (#439 sections 22/23).
 */
export function createAiGatewayProvider(options: AiGatewayProviderOptions): System2ProviderAdapter {
  const identity = aiGatewayProviderIdentity(options)
  const maxOutputTokens = options.maxOutputTokens ?? 2048
  // Resolving `modelId` through the gateway is the production path; an explicit
  // model object is the composition/test seam.
  const model: LanguageModel = options.model ?? identity.modelId
  const systemSuffix = options.systemSuffix ?? (identity.transport === 'json-text' ? SYSTEM2_JSON_TEXT_INSTRUCTIONS : TOOL_CALL_INSTRUCTIONS)

  const dispatch = async (
    request: System2ProviderDispatchRequest,
    signal?: AbortSignal,
  ): Promise<System2ProviderDispatchResponse> => {
    const abortSignal = combineSignals(request.timeoutMs, signal)
    try {
      if (identity.transport === 'json-text') {
        const result = await generateText({
          model,
          system: systemSuffix,
          prompt: request.prompt,
          maxOutputTokens,
          // The harness owns retry currency: a transport-level retry would repeat
          // a request whose epoch/projection may already have moved.
          maxRetries: 0,
          abortSignal,
        })
        // Text is NOT interpreted here. `decodeRawProviderResponse` decides
        // whether it is exactly one JSON object; prose is an invalid_response.
        const raw: RawProviderResponse = { object: null, text: result.text, finishReason: result.finishReason ?? null }
        return {
          provider: identity,
          raw,
          providerMetadata: { mode: 'json-text', modelId: identity.modelId },
          usage: usageOf(result.usage),
        }
      }
      const result = await generateText({
        model,
        system: systemSuffix,
        prompt: request.prompt,
        tools: {
          emitSystem2Proposal: tool({
            description: 'Emit the bounded System2 WHAT proposal: generic intents/predicates only, never primitive actions',
            inputSchema: jsonSchema<unknown>(SYSTEM2_PROPOSAL_JSON_SCHEMA),
          }),
        },
        toolChoice: { type: 'tool', toolName: 'emitSystem2Proposal' },
        maxOutputTokens,
        maxRetries: 0,
        abortSignal,
      })
      const call = result.toolCalls?.[0]
      const raw: RawProviderResponse = {
        object: call?.input ?? null,
        text: result.text ?? null,
        finishReason: result.finishReason ?? null,
      }
      return {
        provider: identity,
        raw,
        providerMetadata: { mode: 'tool-call', modelId: identity.modelId, toolCalls: result.toolCalls?.length ?? 0 },
        usage: usageOf(result.usage),
      }
    } catch (error) {
      // Classified, never swallowed: the harness turns this into a typed
      // System2Failure and decides whether a retry is still semantically valid.
      throw classifyProviderError(error)
    }
  }

  return { identity, dispatch }
}

function usageOf(usage: unknown): System2ProviderDispatchResponse['usage'] {
  if (usage === null || typeof usage !== 'object') return null
  const record = usage as Record<string, unknown>
  const number = (value: unknown): number | null => (typeof value === 'number' ? value : null)
  return {
    inputTokens: number(record.inputTokens),
    outputTokens: number(record.outputTokens),
    totalTokens: number(record.totalTokens),
  }
}
