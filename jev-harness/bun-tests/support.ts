// Shared fixtures for the jev-harness invariant suite.
//
// These tests exercise the HARNESS contract only: no Minecraft runtime, no
// provider, no network. Every provider is scripted, so the suite is fast and
// deterministic (the suite time budget matters - several lanes share CI).

import type { JevHarness, PiRequest, RequestIdentity } from '../contract.ts'
import type { JevHead } from '../heads.ts'
import type { MemoryArtifactSink, RunIdentity } from '../artifacts.ts'
import type { HarnessCache } from '../cache.ts'
import type { JevProviderAdapter, ProviderDispatchRequest, ProviderDispatchResponse } from '../provider.ts'
import type { StaticIdentitySource } from '../identity.ts'
import { createJevHarness } from '../harness.ts'
import type { JevHarnessOptions } from '../harness.ts'
import { toCausalIdentity, staticIdentitySource } from '../identity.ts'
import { MemoryArtifactSink as Sink } from '../artifacts.ts'
import { baseIdentity, testProjection, testRun } from '../testing.ts'

// Re-exported so invariant files can take every fixture from one module.
export { baseIdentity, testRun } from '../testing.ts'

export interface HarnessFixture {
  readonly harness: JevHarness
  readonly sink: MemoryArtifactSink
  readonly identity: StaticIdentitySource
  readonly provider: JevProviderAdapter
  readonly run: RunIdentity
}

export function fixture(options: {
  provider: JevProviderAdapter
  identity?: RequestIdentity
  cache?: HarnessCache | null
  heads?: readonly JevHead[]
  ordering?: JevHarnessOptions['ordering']
  transport?: JevHarnessOptions['transport']
  parameters?: JevHarnessOptions['parameters']
  run?: RunIdentity
  allowExperimentalCalibration?: boolean
}): HarnessFixture {
  const identity = staticIdentitySource(toCausalIdentity(options.identity ?? baseIdentity()))
  const sink = new Sink()
  const run = options.run ?? testRun()
  const harness = createJevHarness({
    provider: options.provider,
    identity,
    run,
    artifacts: sink,
    cache: options.cache ?? null,
    heads: options.heads,
    ordering: options.ordering,
    transport: options.transport ?? { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => undefined },
    parameters: options.parameters,
    now: () => new Date('2026-09-22T00:00:00.000Z'),
    idFactory: counterIds(),
    clock: monotonicClock(),
    allowExperimentalCalibration: options.allowExperimentalCalibration ?? false,
  })
  return { harness, sink, identity, provider: options.provider, run }
}

/** Deterministic decision ids, so artifact ids are stable in assertions. */
export function counterIds(prefix = 'dec_test_'): () => string {
  let index = 0
  return () => `${prefix}${String((index += 1)).padStart(3, '0')}`
}

/** Deterministic clock; each read advances 5ms so latency math is assertable. */
export function monotonicClock(start = 1_000, step = 5): () => number {
  let value = start - step
  return () => {
    value += step
    return value
  }
}

/** A provider that mutates the live identity mid-flight (stale-completion tests). */
export function mutatingProvider(options: {
  readonly answers: Readonly<Record<string, unknown>>
  readonly mutate: () => void
  readonly providerId?: string
  readonly modelId?: string
}): JevProviderAdapter & { readonly calls: number } {
  let calls = 0
  const provider = {
    providerId: options.providerId ?? 'mutating-provider',
    modelId: options.modelId ?? 'mutating-model',
    get calls() {
      return calls
    },
    dispatch(_request: ProviderDispatchRequest): Promise<ProviderDispatchResponse> {
      calls += 1
      options.mutate()
      const answers: Record<string, { questionId: string; raw: unknown }> = {}
      for (const [questionId, raw] of Object.entries(options.answers)) answers[questionId] = { questionId, raw }
      return Promise.resolve({
        provider: provider.providerId,
        model: provider.modelId,
        answers,
        providerMetadata: null,
        usage: null,
      })
    },
  }
  return provider
}

/** A provider that fails N times before answering; counts every dispatch. */
export function flakyProvider(options: {
  readonly failures: number
  readonly kind: 'timeout' | 'provider_unavailable'
  readonly answers: Readonly<Record<string, unknown>>
  readonly onFailure?: () => void
}): JevProviderAdapter & { readonly calls: number } {
  let calls = 0
  const provider = {
    providerId: 'flaky-provider',
    modelId: 'flaky-model',
    get calls() {
      return calls
    },
    async dispatch(_request: ProviderDispatchRequest): Promise<ProviderDispatchResponse> {
      calls += 1
      if (calls <= options.failures) {
        options.onFailure?.()
        const { ProviderFailure } = await import('../provider.ts')
        throw new ProviderFailure(options.kind, true, `flaky ${options.kind} #${calls}`)
      }
      const answers: Record<string, { questionId: string; raw: unknown }> = {}
      for (const [questionId, raw] of Object.entries(options.answers)) answers[questionId] = { questionId, raw }
      return { provider: provider.providerId, model: provider.modelId, answers, providerMetadata: null, usage: null }
    },
  }
  return provider
}

export function piRequestFor(overrides: Partial<PiRequest> = {}): PiRequest {
  return {
    headId: 'pi_action_v3',
    identity: baseIdentity(),
    projection: testProjection(),
    candidates: [
      { id: 'clear:block-26-68-11', skillKind: 'CLEAR_HEADROOM', target: null, postcondition: null, facts: {} },
      { id: 'kill:e183', skillKind: 'KILL', target: { kind: 'entity', identity: 'e183' }, postcondition: 'target_dead', facts: {} },
      { id: 'walk:portal-entry-1', skillKind: 'WALK_TO', target: { kind: 'region', identity: 'portal_entry#1' }, postcondition: 'arrived', facts: {} },
    ],
    ...overrides,
  }
}
