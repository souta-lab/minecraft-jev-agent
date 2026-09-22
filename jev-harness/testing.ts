// jev-harness/testing.ts - provider-free test doubles for the harness boundary.
//
// These are shipped (not test-only) on purpose: the migration lanes (Phase C/D/E)
// and the #423/#363 ablation tools need the same scripted transport and request
// builders, and duplicating them would create a second, drifting harness.

import type {
  BetaRequest,
  CandidateFactValue,
  GroundedSemanticCandidate,
  JevHeadRequest,
  PiRequest,
  RequestIdentity,
  ScoreRequest,
  SemanticProjection,
} from './contract.ts'
import type { ArtifactSink, RunIdentity } from './artifacts.ts'
import { MemoryArtifactSink } from './artifacts.ts'
import { StaticIdentitySource, staticIdentitySource } from './identity.ts'
import type {
  JevProviderAdapter,
  ProviderDispatchRequest,
  ProviderDispatchResponse,
  ProviderQuestion,
} from './provider.ts'
import { ProviderFailure } from './provider.ts'

export const TEST_RUN: RunIdentity = {
  runId: 'run-test',
  sourceSha: 'test-sha',
  dirtyTree: true,
}

export function testRun(overrides: Partial<RunIdentity> = {}): RunIdentity {
  return { ...TEST_RUN, ...overrides }
}

export function baseIdentity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    decisionEpoch: 481,
    optionInstanceId: 'option:test:1',
    worldKey: 'server|overworld',
    worldEpoch: 3,
    generationId: 'gen-1',
    ...overrides,
  }
}

export function testIdentitySource(identity: RequestIdentity = baseIdentity()): StaticIdentitySource {
  return staticIdentitySource({
    decisionEpoch: identity.decisionEpoch,
    optionInstanceId: identity.optionInstanceId,
    worldKey: identity.worldKey,
    worldEpoch: identity.worldEpoch,
    generationId: identity.generationId,
  })
}

export function testProjection(
  payload: Readonly<Record<string, unknown>> = { tick: 1, meaningful: 'stable' },
  projectionId = 'authority_state_v1',
  version = 1,
): SemanticProjection {
  return { projectionId, version, payload }
}

export function candidate(
  id: string,
  overrides: {
    skillKind?: string
    target?: GroundedSemanticCandidate['target']
    postcondition?: string | null
    facts?: Readonly<Record<string, CandidateFactValue>>
    description?: string
  } = {},
): GroundedSemanticCandidate {
  return {
    id,
    skillKind: overrides.skillKind ?? 'MOVE',
    target: overrides.target ?? null,
    postcondition: overrides.postcondition ?? null,
    facts: overrides.facts ?? {},
    ...(overrides.description === undefined ? {} : { description: overrides.description }),
  }
}

export function piRequest(overrides: Partial<PiRequest> = {}): PiRequest {
  return {
    headId: 'pi_action_v3',
    identity: baseIdentity(),
    projection: testProjection(),
    candidates: [candidate('walk:portal-entry-1'), candidate('kill:e183'), candidate('clear:block-26-68-11')],
    ...overrides,
  }
}

export function betaRequest(overrides: Partial<BetaRequest> = {}): BetaRequest {
  return {
    headId: 'beta_terminate_v2',
    identity: baseIdentity(),
    projection: testProjection(),
    option: {
      optionInstanceId: 'option:test:1',
      templateId: 'template:test',
      intent: 'obtain diamonds',
      preconditions: [],
      successFacts: [],
      abortThreshold: null,
      allowedSkills: [],
    },
    ...overrides,
  }
}

export function scoreRequest(overrides: Partial<ScoreRequest> = {}): ScoreRequest {
  return {
    headId: 'danger_v1',
    identity: baseIdentity(),
    projection: testProjection(),
    ...overrides,
  }
}

/** A queued transport behaviour. */
export type ScriptedStep =
  | { readonly kind: 'answer'; readonly answers: Readonly<Record<string, unknown>>; readonly confidence?: Readonly<Record<string, number>> }
  | { readonly kind: 'fail'; readonly failure: 'timeout' | 'provider_unavailable' | 'aborted'; readonly retryable?: boolean }
  | { readonly kind: 'run'; readonly fn: (request: ProviderDispatchRequest) => void }

export interface ScriptedProviderOptions {
  readonly steps: readonly ScriptedStep[]
  readonly providerId?: string
  readonly modelId?: string
  /** Repeats the final step forever once the script is exhausted. */
  readonly repeatLast?: boolean
}

export class ScriptedProvider implements JevProviderAdapter {
  readonly providerId: string
  readonly modelId: string
  readonly dispatches: ProviderDispatchRequest[] = []
  private index = 0

  constructor(private readonly options: ScriptedProviderOptions) {
    this.providerId = options.providerId ?? 'scripted-provider'
    this.modelId = options.modelId ?? 'scripted-model'
  }

  dispatch(request: ProviderDispatchRequest): Promise<ProviderDispatchResponse> {
    this.dispatches.push(request)
    const step = this.step()
    if (step.kind === 'run') {
      step.fn(request)
      return Promise.resolve(this.response({}))
    }
    if (step.kind === 'fail') {
      throw new ProviderFailure(step.failure, step.retryable ?? true, `scripted ${step.failure}`)
    }
    return Promise.resolve(this.response(step.answers, step.confidence))
  }

  private step(): ScriptedStep {
    const steps = this.options.steps
    const step = steps[Math.min(this.index, steps.length - 1)]
    this.index += 1
    if (step === undefined) throw new Error('ScriptedProvider: no steps configured')
    return step
  }

  private response(
    answers: Readonly<Record<string, unknown>>,
    confidence?: Readonly<Record<string, number>>,
  ): ProviderDispatchResponse {
    const out: Record<string, { questionId: string; raw: unknown }> = {}
    for (const [questionId, raw] of Object.entries(answers)) out[questionId] = { questionId, raw }
    return {
      provider: this.providerId,
      model: this.modelId,
      answers: out,
      providerMetadata: confidence === undefined ? null : { typesafe: { confidence } },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }
  }
}

export function scriptedProvider(...steps: readonly ScriptedStep[]): ScriptedProvider {
  return new ScriptedProvider({ steps })
}

/** Provider that always fails, for fail-closed tests. */
export function failingProvider(failure: 'timeout' | 'provider_unavailable' | 'aborted' = 'provider_unavailable'): ScriptedProvider {
  return new ScriptedProvider({ steps: [{ kind: 'fail', failure, retryable: failure !== 'aborted' }] })
}

export function testSink(): MemoryArtifactSink {
  return new MemoryArtifactSink()
}

export function choiceAnswer(candidateId: string, probabilities?: Readonly<Record<string, number>>): Record<string, unknown> {
  return probabilities === undefined ? { type: 'choice', choice: candidateId } : { type: 'choice', choice: candidateId, probabilities }
}

export function booleanAnswer(probability: number): Record<string, unknown> {
  return { type: 'boolean', probability }
}

export function scoreAnswer(score: number, probabilities?: Readonly<Record<string, number>>): Record<string, unknown> {
  return probabilities === undefined ? { type: 'score', score } : { type: 'score', score, probabilities }
}

export function answers(...entries: readonly (readonly [string, unknown])[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [headId, raw] of entries) out[headId] = raw
  return out
}

export function artifactSinkOf(sink: ArtifactSink): MemoryArtifactSink {
  if (!(sink instanceof MemoryArtifactSink)) throw new Error('expected a MemoryArtifactSink')
  return sink
}

export type { JevHeadRequest, ProviderQuestion }
