// system2-harness/bun-tests/ai-gateway-transport.test.ts - the REAL
// `generateText` transport path, driven offline through `ai/test`'s mock model.
//
// The rest of the suite exercises the harness through `ScriptedSystem2Provider`
// and `ReplayProviderAdapter`, which implement the same seam but skip the SDK. That
// leaves one untested claim: that `providers/aiGateway.ts` forwards the
// harness-rendered prompt unchanged, uses `maxRetries: 0`, and hands the raw
// response back WITHOUT interpreting it. A mock model proves exactly that, with no
// network and no key.

import { describe, expect, test } from 'bun:test'
import { MockLanguageModelV3 } from 'ai/test'
import type { System2Proposal } from '../contract.ts'
import { createSystem2Harness } from '../harness.ts'
import { MemorySystem2ArtifactSink } from '../artifacts.ts'
import { createAiGatewayProvider } from '../providers/aiGateway.ts'
import { enterPortalProposal, fixture, mustFail, mustOk, worldWithPortals } from './support.ts'

const MODEL_ID = 'mock/provider-model'

type V3Result = ConstructorParameters<typeof MockLanguageModelV3>[0] extends { doGenerate?: infer D }
  ? D extends readonly (infer R)[]
    ? R
    : D
  : never

function toolCallModel(input: unknown, text: string | null = null): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: 'mock',
    modelId: MODEL_ID,
    doGenerate: {
      content: [
        ...(text === null ? [] : [{ type: 'text' as const, text }]),
        { type: 'tool-call' as const, toolCallId: 'call_1', toolName: 'emitSystem2Proposal', input: JSON.stringify(input) },
      ],
      finishReason: 'tool-calls' as const,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      warnings: [],
    } as unknown as V3Result,
  })
}

function textModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    provider: 'mock',
    modelId: MODEL_ID,
    doGenerate: {
      content: [{ type: 'text' as const, text }],
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      warnings: [],
    } as unknown as V3Result,
  })
}

function harnessWith(model: MockLanguageModelV3, transport: 'tool-call' | 'json-text', seed: ReturnType<typeof fixture>) {
  const sink = new MemorySystem2ArtifactSink()
  const harness = createSystem2Harness({
    provider: createAiGatewayProvider({ modelId: MODEL_ID, transport, model }),
    authority: seed.authority,
    identity: seed.identitySource,
    artifacts: sink,
    runId: 'run_gateway',
    sourceSha: 'cafebabecafebabecafebabecafebabecafebabe',
    index: seed.index,
  })
  return { harness, sink }
}

describe('aiGateway transport (mock model, no network)', () => {
  test('tool-call transport: the tool input becomes the raw object', async () => {
    const seed = fixture({ outcomes: [], index: worldWithPortals(['P17']) })
    const proposal: System2Proposal = enterPortalProposal()
    const model = toolCallModel(proposal, 'the portal already exists')
    const { harness, sink } = harnessWith(model, 'tool-call', seed)
    const result = mustOk(await harness.propose(seed.request()))
    expect(result.commit.status).toBe('committed')

    const artifact = sink.decisions()[0]
    expect(artifact?.provider.transport).toBe('tool-call')
    expect(artifact?.attempts).toBe(1)
    // The adapter forwarded the tool input it received, unchanged: the SDK parses
    // the JSON string, and nothing re-serializes or re-interprets it afterwards.
    expect(artifact?.rawResponse?.object).toEqual(proposal)
    expect(artifact?.rawResponse?.text).toBe('the portal already exists')
    expect(artifact?.rationaleText).toContain('verified portal')
    expect(artifact?.normalizedProposal?.intents[0]?.desiredPredicates[0]?.kind).toBe('interact')

    // The adapter forwarded the harness prompt verbatim and offered the typed tool.
    const call = model.doGenerateCalls[0]
    expect(call?.prompt[0]).toMatchObject({ role: 'system' })
    const promptText = JSON.stringify(call?.prompt)
    expect(promptText).toContain('system2.state')
    expect(String(call?.responseFormat?.type ?? '')).not.toBe('json')
    const tools = call?.tools ?? []
    expect(tools.map((entry) => entry.name)).toEqual(['emitSystem2Proposal'])
  })

  test('json-text transport: strict JSON commits, prose is refused (no salvage through the SDK)', async () => {
    const good = fixture({ outcomes: [], index: worldWithPortals(['P17']) })
    const goodHarness = harnessWith(textModel(JSON.stringify(enterPortalProposal())), 'json-text', good)
    mustOk(await goodHarness.harness.propose(good.request()))
    expect(goodHarness.sink.decisions()[0]?.provider.transport).toBe('json-text')

    const bad = fixture({ outcomes: [], index: worldWithPortals(['P17']) })
    const badHarness = harnessWith(textModel('probably dig down at 12,-30 and look for diamonds'), 'json-text', bad)
    const failure = mustFail(await badHarness.harness.propose(bad.request()))
    expect(failure.kind).toBe('invalid_response')
    expect(bad.authority.snapshot().revision).toBe(0)
    expect(badHarness.sink.decisions()[0]?.rationaleExecutionDirectives).toContain('coordinate_pair')
  })

  test('an SDK error is classified, never swallowed, and injection attempts fail closed', async () => {
    const seed = fixture({ outcomes: [], index: worldWithPortals(['P17']) })
    const model = new MockLanguageModelV3({
      provider: 'mock',
      modelId: MODEL_ID,
      doGenerate: () => {
        throw new Error('GatewayInternalServerError: upstream unavailable')
      },
    })
    const { harness, sink } = harnessWith(model, 'tool-call', seed)
    const failure = mustFail(await harness.propose(seed.request()))
    expect(failure.kind).toBe('provider_unavailable')
    expect(failure.modelAnswerPresent).toBe(false)
    expect(failure.fallbackAuthority).toBe('none')
    expect(seed.authority.snapshot().revision).toBe(0)
    expect(sink.fallbacks()).toHaveLength(0)

    // A tool call carrying a coordinate/primitive sequence still has to survive the
    // harness's own strict decoder: the adapter does not vet it.
    const hostile = fixture({ outcomes: [], index: worldWithPortals(['P17']) })
    const hostileModel = toolCallModel({
      operation: 'append',
      intents: [{ intentText: 'dig', desiredPredicates: [{ kind: 'reach', args: { target: { x: 12, y: -54, z: -30 } } }], completionSemantics: 'all' }],
    })
    const hostileHarness = harnessWith(hostileModel, 'tool-call', hostile)
    const hostileFailure = mustFail(await hostileHarness.harness.propose(hostile.request()))
    expect(hostileFailure.kind).toBe('invalid_response')
    expect(hostile.authority.snapshot().revision).toBe(0)
  })

  test('the json-text transport instruction forbids prose, and tool-call forbids text answers', async () => {
    const seed = fixture({ outcomes: [], index: worldWithPortals(['P17']) })
    const model = textModel(JSON.stringify(enterPortalProposal()))
    const sink = new MemorySystem2ArtifactSink()
    const harness = createSystem2Harness({
      provider: createAiGatewayProvider({ modelId: 'meta/muse-spark-1.3-contributor', model }),
      authority: seed.authority,
      identity: seed.identitySource,
      artifacts: sink,
      runId: 'run_gateway',
      sourceSha: 'cafebabecafebabecafebabecafebabecafebabe',
      index: seed.index,
    })
    mustOk(await harness.propose(seed.request()))
    // The model-quirk resolution selected json-text without any gameplay change.
    expect(sink.decisions()[0]?.provider).toEqual({
      providerId: 'ai-gateway',
      modelId: 'meta/muse-spark-1.3-contributor',
      transport: 'json-text',
    })
    const call = model.doGenerateCalls[0]
    expect(JSON.stringify(call?.prompt)).toContain('ONE JSON object and nothing else')
    expect(call?.tools ?? []).toHaveLength(0)
  })
})

describe('transport identity', () => {
  test('the model-quirk default and an explicit override both resolve to one seam', () => {
    const a = createAiGatewayProvider({ modelId: 'a', model: textModel('{}') })
    const b = createAiGatewayProvider({ modelId: 'b', model: textModel('{}'), transport: 'json-text' })
    // 'a' is not a known json-text quirk, so it takes the tool-call transport.
    expect(a.identity.transport).toBe('tool-call')
    expect(b.identity.transport).toBe('json-text')
    expect(a.identity.modelId).not.toBe(b.identity.modelId)
    expect(typeof a.dispatch).toBe('function')
    expect(typeof b.dispatch).toBe('function')
  })
})
