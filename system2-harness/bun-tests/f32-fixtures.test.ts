// system2-harness/bun-tests/f32-fixtures.test.ts - the #439 section 32
// regression fixtures (all 25) run through the REAL harness.
//
// Each fixture states the failure mode it locks down. Nothing here inspects
// harness internals: a fixture that can only pass by calling the compiler
// directly would not prove that production cannot bypass the fence.

import { describe, expect, test } from 'bun:test'
import { canonicalJson, epistemicEntry, projectionHash } from '../canonical.ts'
import type { CompiledOption, OptionGraph, System2Proposal } from '../contract.ts'
import { PREDICATE_KINDS } from '../contract.ts'
import { known, notObserved, requireKnown, UnknownFactError } from '../epistemic.ts'
import { emptyWorldIndex } from '../grounding.ts'
import { createSystem2Harness } from '../harness.ts'
import { MemorySystem2ArtifactSink } from '../artifacts.ts'
import { deriveExecutionQueue, originsOf, restoreOptionGraph, serializeOptionGraph } from '../optionGraph.ts'
import { ReplayProviderAdapter, replayEntriesFromArtifacts } from '../replayAdapter.ts'
import { decodeRawProviderResponse } from '../schema.ts'
import { buildSystem2Projection } from '../stateProjection.ts'
import { evaluateWakePolicy, wakeFromEvent, SYSTEM2_WAKE_REASONS } from '../wakeReasons.ts'
import { createAiGatewayProvider, aiGatewayProviderIdentity } from '../providers/aiGateway.ts'
import {
  acquireProposal,
  enterPortalProposal,
  fixture,
  mustFail,
  mustOk,
  portalRef,
  projectionInput,
  TEST_PROVIDER,
  TEST_RUN_ID,
  TEST_SOURCE_SHA,
  truthWithFurnace,
  worldWithPortals,
} from './support.ts'

const ENTER_PORTAL: System2Proposal = enterPortalProposal()

// ---------------------------------------------------------------------------
// 1. verified portal + a frontier -> enter the portal through generic predicates
// ---------------------------------------------------------------------------
describe('fixture 1: verified portal is entered, not rebuilt', () => {
  test('the generic vocabulary can express "enter the existing portal"', async () => {
    const f = fixture({ outcomes: [{ kind: 'object', object: ENTER_PORTAL }], index: worldWithPortals(['P17']) })
    const result = mustOk(await f.harness.propose(f.request()))
    expect(result.commit.status).toBe('committed')

    const graph = f.authority.snapshot()
    expect(graph.revision).toBe(1)
    const option = graph.options[0]?.option
    expect(option).toBeDefined()
    // The compiled predicate is generic: interact(enter) bound to a grounded site.
    expect(option?.desiredPredicates.map((spec) => spec.kind)).toEqual(['interact'])
    expect(option?.target?.kind).toBe('grounded')
    // No benchmark strategy name and no rebuild prerequisite was required by the schema.
    const text = canonicalJson(option as unknown as Record<string, unknown>)
    for (const benchmark of ['descend_to_y16', 'branch_mine', 'diamond_road', 'rebuild_portal', 'next_rung']) {
      expect(text.includes(benchmark)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. verified -> unknown must change the projection and the cache key
// ---------------------------------------------------------------------------
describe('fixture 2: an epistemic change changes projection/cache identity', () => {
  const facts = (state: 'known' | 'not_observed') => [
    {
      id: 'portal:P17',
      subject: 'portal_site:P17',
      value: state === 'known' ? known('verified') : notObserved<string>(),
      evidence: 'world memory portal verification',
    },
  ]

  test('unknown != false and the hash changes', () => {
    const verified = buildSystem2Projection(projectionInput({ world: { facts: facts('known') } }))
    const unobserved = buildSystem2Projection(projectionInput({ world: { facts: facts('not_observed') } }))
    expect(projectionHash(verified)).not.toBe(projectionHash(unobserved))

    expect(epistemicEntry(known('verified'))).toEqual({ state: 'known', value: 'verified' })
    expect(epistemicEntry(notObserved())).toEqual({ state: 'not_observed' })
    // The unobserved fact never serializes as a fabricated `false`.
    const json = canonicalJson(unobserved.payload as unknown as Record<string, unknown>)
    expect(json.includes('"not_observed"')).toBe(true)
    expect(json.includes('portal:P17')).toBe(true)
    expect(() => requireKnown(notObserved<string>(), 'portal')).toThrow(UnknownFactError)
  })

  test('the cache key follows the projection', async () => {
    const scenario = (state: 'known' | 'not_observed') =>
      fixture({
        outcomes: [{ kind: 'object', object: ENTER_PORTAL }],
        index: worldWithPortals(['P17']),
        projection: { world: { facts: facts(state) } },
      })
    const verified = scenario('known')
    const unobserved = scenario('not_observed')
    const a = mustOk(await verified.harness.propose(verified.request()))
    const b = mustOk(await unobserved.harness.propose(unobserved.request()))
    expect(a.proposal.projectionHash).not.toBe(b.proposal.projectionHash)
    expect(verified.sink.decisions()[0]?.cacheKey).not.toBe(unobserved.sink.decisions()[0]?.cacheKey)
  })
})

// ---------------------------------------------------------------------------
// 3. invented coordinate / unknown ref -> fail closed
// ---------------------------------------------------------------------------
describe('fixture 3: invented targets fail closed', () => {
  test('an unknown grounded id is ungroundable', async () => {
    const f = fixture({ outcomes: [{ kind: 'object', object: enterPortalProposal(portalRef('P99')) }], index: worldWithPortals(['P17']) })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('ungroundable_intent')
    expect(failure.diagnostics?.intentDiagnostics[0]?.kind).toBe('unknown_grounded_ref')
    expect(f.authority.snapshot().revision).toBe(0)
    expect(f.authority.snapshot().options).toHaveLength(0)
  })

  test('a coordinate argument cannot even be decoded', async () => {
    const coordinateProposal: System2Proposal = {
      operation: 'append',
      intents: [
        {
          intentText: 'go to the diamonds',
          desiredPredicates: [{ kind: 'reach', args: { target: { x: 137, y: -54, z: -412 } as unknown as import('../contract.ts').GroundedRef } }],
          completionSemantics: 'all',
        },
      ],
    }
    const f = fixture({ outcomes: [{ kind: 'object', object: coordinateProposal }] })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('invalid_response')
    expect(f.authority.snapshot().revision).toBe(0)
  })

  test('a positional argument name is a typed compile rejection', async () => {
    const positional: System2Proposal = {
      operation: 'append',
      intents: [
        { intentText: 'descend', desiredPredicates: [{ kind: 'reach', args: { x: 137 } }], completionSemantics: 'all' },
      ],
    }
    const f = fixture({ outcomes: [{ kind: 'object', object: positional }] })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('compile_rejected')
    expect(failure.diagnostics?.intentDiagnostics[0]?.kind).toBe('invalid_predicate_arguments')
  })
})

// ---------------------------------------------------------------------------
// 4. several grounded portals -> expose the choice, never pick the nearest
// ---------------------------------------------------------------------------
describe('fixture 4: ambiguity is exposed, not resolved by code', () => {
  test('two verified portals become an explicit Jev choice', async () => {
    const f = fixture({ outcomes: [{ kind: 'object', object: ENTER_PORTAL }], index: worldWithPortals(['P17', 'P42']) })
    const result = mustOk(await f.harness.propose(f.request()))
    const option = f.authority.snapshot().options[0]?.option
    expect(result.commit.status).toBe('committed')
    expect(option?.target).toEqual({
      kind: 'choice',
      candidates: [portalRef('P17'), portalRef('P42')],
      selectionAuthority: 'jev_pi',
    })
  })

  test('an explicit model choice is honoured', async () => {
    const f = fixture({
      outcomes: [{ kind: 'object', object: enterPortalProposal(portalRef('P42')) }],
      index: worldWithPortals(['P17', 'P42']),
    })
    mustOk(await f.harness.propose(f.request()))
    expect(f.authority.snapshot().options[0]?.option.target).toMatchObject({ kind: 'grounded', ref: portalRef('P42') })
  })
})

// ---------------------------------------------------------------------------
// 5/6/7. stale fences
// ---------------------------------------------------------------------------
describe('fixtures 5/6/7: stale results are discarded, never rebased', () => {
  test('5: world epoch change while the model is thinking', async () => {
    const f = fixture({
      outcomes: [{ kind: 'object', object: ENTER_PORTAL }],
      index: worldWithPortals(['P17']),
      hooks: {
        beforeDispatch: (request) => {
          void request
          f.identitySource.set({ ...f.live(), worldEpoch: 9 })
        },
      },
    })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('stale')
    expect(f.authority.snapshot().revision).toBe(0)
    expect(f.sink.staleDrops()).toHaveLength(1)
    expect(f.sink.staleDrops()[0]?.reason).toBe('world_epoch_changed')
    expect(f.sink.decisions()[0]?.staleCheck.current).toBe(false)
  })

  test('5b: a world key change outranks a world epoch change', async () => {
    const f = fixture({
      outcomes: [{ kind: 'object', object: ENTER_PORTAL }],
      index: worldWithPortals(['P17']),
      hooks: { beforeDispatch: () => f.identitySource.setWorld('local:nether', 9) },
    })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('stale')
    expect(f.sink.staleDrops()[0]?.reason).toBe('world_key_changed')
  })

  test('5c: a generation change invalidates world-dependent WHAT', async () => {
    const f = fixture({
      outcomes: [{ kind: 'object', object: ENTER_PORTAL }],
      index: worldWithPortals(['P17']),
      hooks: { beforeDispatch: () => f.identitySource.setGeneration('gen-2') },
    })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('stale')
    expect(f.sink.staleDrops()[0]?.reason).toBe('generation_changed')
  })

  test('6: a newer System2 epoch subsumes the answer', async () => {
    const f = fixture({
      outcomes: [{ kind: 'object', object: ENTER_PORTAL }],
      index: worldWithPortals(['P17']),
      hooks: { beforeDispatch: () => f.identitySource.advanceEpoch() },
    })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('stale')
    expect(f.sink.staleDrops()[0]?.reason).toBe('system2_epoch_advanced')
    expect(f.authority.snapshot().revision).toBe(0)
  })

  test('7: protected human intent appearing mid-flight wins', async () => {
    const f = fixture({
      outcomes: [{ kind: 'object', object: ENTER_PORTAL }],
      index: worldWithPortals(['P17']),
      hooks: { beforeDispatch: () => f.identitySource.setHumanIntentRevision(1) },
    })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('stale')
    expect(f.sink.staleDrops()[0]?.reason).toBe('human_intent_changed')
  })

  test('7b: a non-expandable protected intent is not replaceable in the first place', async () => {
    const f = fixture({
      outcomes: [{ kind: 'object', object: ENTER_PORTAL }],
      index: worldWithPortals(['P17']),
      protectedIntent: { intentRevision: 1, intentText: 'stop and hold position', expandable: false },
    })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('compile_rejected')
    expect(failure.diagnostics?.intentDiagnostics[0]?.kind).toBe('protected_intent_violation')
  })
})

// ---------------------------------------------------------------------------
// 8/9. malformed output and provider failure change nothing
// ---------------------------------------------------------------------------
describe('fixtures 8/9: failure is typed and inert', () => {
  test('8: a malformed structured response is invalid_response with no mutation', async () => {
    for (const object of [{ operation: 'replace' }, { operation: 'replace', intents: [] }, { operation: 'nope', intents: [] }]) {
      const f = fixture({ outcomes: [{ kind: 'object', object }] })
      const failure = mustFail(await f.harness.propose(f.request()))
      expect(failure.kind).toBe('invalid_response')
      expect(f.authority.snapshot().revision).toBe(0)
      expect(f.sink.decisions()[0]?.finalPatch).toBeNull()
    }
  })

  test('8b: prose is never salvaged into a goal', async () => {
    const prose = 'probably dig down and look for diamonds near y=-54, then maybe branch mine'
    const decoded = decodeRawProviderResponse({ object: null, text: prose, finishReason: 'stop' })
    expect(decoded.ok).toBe(false)

    const f = fixture({ outcomes: [{ kind: 'text', text: prose }] })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('invalid_response')
    expect(f.authority.snapshot().revision).toBe(0)
  })

  test('9: a timeout is a typed failure and never a deterministic ladder', async () => {
    const f = fixture({ outcomes: [{ kind: 'timeout' }, { kind: 'timeout' }] })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('timeout')
    expect(failure.modelAnswerPresent).toBe(false)
    expect(failure.fallbackAuthority).toBe('none')
    expect(failure.diagnostics).toBeNull()
    expect(f.authority.snapshot().revision).toBe(0)
    expect(f.authority.snapshot().options).toHaveLength(0)
    // The harness has no code path that emits a code fallback; Phase F owns that record.
    expect(f.sink.fallbacks()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 10/11. cache identity
// ---------------------------------------------------------------------------
describe('fixtures 10/11: cache identity covers model-visible WHAT state', () => {
  const rejected: System2Proposal = {
    operation: 'append',
    intents: [{ intentText: 'unsupported', desiredPredicates: [{ kind: 'teleport', args: {} }], completionSemantics: 'all' }],
  }

  test('10: an identical request hits the cache', async () => {
    const f = fixture({ outcomes: [{ kind: 'object', object: rejected }, { kind: 'object', object: rejected }] })
    const first = mustFail(await f.harness.propose(f.request()))
    expect(first.kind).toBe('compile_rejected')
    const second = mustFail(await f.harness.propose(f.request()))
    expect(second.kind).toBe('compile_rejected')
    expect(f.provider.dispatchCount).toBe(1)
    expect(f.sink.decisions()[1]?.cacheHit).toBe(true)
    expect(f.sink.decisions()[1]?.cacheSource).toBe('cache')
    expect(f.sink.decisions()[1]?.cachedArtifactId).toBe(f.sink.decisions()[0]?.artifactId)
  })

  test('10b: a changed wake detail is a different cache identity', async () => {
    const shared = fixture({ outcomes: [{ kind: 'object', object: rejected }, { kind: 'object', object: rejected }] })
    const baseWake = wakeFromEvent({ kind: 'plan_repair_required', optionInstanceId: 'oi_1', repairCause: 'a', evidence: ['e1'] })
    const otherWake = wakeFromEvent({ kind: 'plan_repair_required', optionInstanceId: 'oi_1', repairCause: 'b', evidence: ['e1'] })
    const request = shared.request({ projection: { wake: baseWake } })
    const other = shared.request({ projection: { wake: otherWake } })
    mustFail(await shared.harness.propose(request))
    mustFail(await shared.harness.propose(other))
    expect(shared.provider.dispatchCount).toBe(2)
    const decisions = shared.sink.decisions()
    expect(decisions[0]?.cacheHit).toBe(false)
    expect(decisions[1]?.cacheHit).toBe(false)
    expect(decisions[0]?.cacheKey).not.toBe(decisions[1]?.cacheKey)
    expect(decisions[0]?.wakeDetail).not.toEqual(decisions[1]?.wakeDetail)
  })

  test('11: changed recent failure evidence changes cache identity', async () => {
    const f = fixture({ outcomes: [{ kind: 'object', object: rejected }, { kind: 'object', object: rejected }] })
    const without = f.request()
    const with_ = f.request({
      projection: {
        failureEvidence: [{ failureClass: 'path_no_path', optionInstanceId: 'oi_1', count: 2, lastDetail: 'no path to P17' }],
      },
    })
    mustFail(await f.harness.propose(without))
    mustFail(await f.harness.propose(with_))
    expect(f.provider.dispatchCount).toBe(2)
    const decisions = f.sink.decisions()
    expect(decisions[0]?.projectionHash).not.toBe(decisions[1]?.projectionHash)
    expect(decisions[1]?.cacheHit).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 12. rationale has zero authority
// ---------------------------------------------------------------------------
describe('fixture 12: executable prose has zero authority', () => {
  test('coordinates in the rationale never reach the authoritative patch', async () => {
    const proposal: System2Proposal = {
      operation: 'append',
      rationale: 'Dig straight down to Y=-54 around 137,-412 and then walk north 30 blocks. Pillar 12 blocks up.',
      intents: [
        {
          intentText: 'have at least 3 diamond',
          desiredPredicates: [{ kind: 'acquire', args: { item: 'diamond', count: 3 } }],
          completionSemantics: 'all',
        },
      ],
    }
    const f = fixture({ outcomes: [{ kind: 'object', object: proposal }] })
    const result = mustOk(await f.harness.propose(f.request()))
    const patchText = canonicalJson(result.proposal.patch as unknown as Record<string, unknown>)
    expect(patchText.includes('-54')).toBe(false)
    expect(patchText.includes('137')).toBe(false)
    expect(patchText.includes('walk north')).toBe(false)
    const artifact = f.sink.decisions()[0]
    expect(artifact?.rationaleText).toContain('Dig straight down')
    expect(artifact?.rationaleExecutionDirectives.length).toBeGreaterThan(0)
  })

  test('prose-only output cannot become an intent at all', async () => {
    const proseOnly: System2Proposal = {
      operation: 'append',
      rationale: 'mine diamonds',
      intents: [{ intentText: 'probably dig down and look for diamonds', desiredPredicates: [], completionSemantics: 'all' }],
    }
    const f = fixture({ outcomes: [{ kind: 'object', object: proseOnly }] })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('compile_rejected')
    expect(failure.diagnostics?.intentDiagnostics[0]?.kind).toBe('prose_only_intent')
  })
})

// ---------------------------------------------------------------------------
// 13/14/15. compiler boundaries
// ---------------------------------------------------------------------------
describe('fixtures 13/14/15: the compiler rejects, it does not rewrite', () => {
  test('13: an unsupported predicate kind is a typed rejection with diagnostics', async () => {
    const f = fixture({
      outcomes: [
        {
          kind: 'object',
          object: {
            operation: 'append',
            intents: [{ intentText: 'descend to y16', desiredPredicates: [{ kind: 'descend_to_y16', args: {} }], completionSemantics: 'all' }],
          },
        },
      ],
    })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('compile_rejected')
    const diagnostic = failure.diagnostics?.intentDiagnostics[0]
    expect(diagnostic?.kind).toBe('unsupported_predicate_kind')
    expect(diagnostic?.stage).toBe('predicate_kinds')
    expect(String(diagnostic?.detail)).toContain('descend_to_y16')
    expect(f.sink.decisions()[0]?.rejectedIntentIndexes).toEqual([0])
  })

  test('14: an impossible dependency is rejected and nothing is substituted', async () => {
    const proposal: System2Proposal = {
      operation: 'append',
      rationale: 'blaze rods need a fortress, which needs the portal',
      intents: [
        {
          intentText: 'have at least 6 blaze_rod',
          desiredPredicates: [{ kind: 'acquire', args: { item: 'blaze_rod', count: 6 } }],
          dependencies: [{ kind: 'interact', args: { operation: 'enter', target: portalRef('P1') } }],
          completionSemantics: 'all',
        },
      ],
    }
    const index = { ...emptyWorldIndex(), portalSites: [{ refId: 'P1', verified: false, dimension: 'overworld' }] }
    const f = fixture({ outcomes: [{ kind: 'object', object: proposal }], index })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('compile_rejected')
    expect(failure.diagnostics?.intentDiagnostics[0]?.kind).toBe('dependency_unsatisfiable')
    // No replacement strategy was invented and no Option was created.
    const added = (failure.diagnostics?.enrichments ?? []).filter((entry) => entry.effect === 'added_dependency')
    expect(added).toHaveLength(0)
    expect(f.authority.snapshot().options).toHaveLength(0)
  })

  test('15: one invalid intent rejects the whole patch (no partial acceptance)', async () => {
    const proposal: System2Proposal = {
      operation: 'append',
      intents: [
        { intentText: 'have 3 diamond', desiredPredicates: [{ kind: 'acquire', args: { item: 'diamond', count: 3 } }], completionSemantics: 'all' },
        { intentText: 'teleport home', desiredPredicates: [{ kind: 'teleport', args: {} }], completionSemantics: 'all' },
      ],
    }
    const f = fixture({ outcomes: [{ kind: 'object', object: proposal }] })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('compile_rejected')
    expect(failure.diagnostics?.partialAcceptance).toBe('unsupported')
    expect(failure.diagnostics?.intentDiagnostics[0]?.intentIndex).toBe(1)
    expect(f.authority.snapshot().revision).toBe(0)
    expect(f.authority.snapshot().options).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 16/17. lifecycle durability
// ---------------------------------------------------------------------------
describe('fixtures 16/17: committed WHAT survives the queue lifecycle and reload', () => {
  test('16: an empty derived queue does not resurrect a ladder', async () => {
    const f = fixture({
      outcomes: [{ kind: 'object', object: acquireProposal('diamond', 3) }, { kind: 'object', object: null }],
      index: worldWithPortals(['P17']),
    })
    mustOk(await f.harness.propose(f.request()))
    const afterCommit = f.authority.snapshot()
    expect(deriveExecutionQueue(afterCommit)).toHaveLength(1)

    // A suspend operation is the only thing that empties the execution queue, and
    // it must leave the semantic Option in the graph rather than replacing it.
    const committed = afterCommit.options[0]
    expect(committed).toBeDefined()
    const instanceId = committed?.option.optionInstanceId ?? ''
    const index = {
      ...worldWithPortals(['P17']),
      optionRefs: [{ refId: instanceId, optionInstanceId: instanceId }],
    }
    const suspendRequest: System2Proposal = {
      operation: 'suspend',
      rationale: 'superseded',
      intents: [
        {
          intentText: 'suspend the diamond option',
          desiredPredicates: [],
          targetRef: { kind: 'grounded', refKind: 'option', refId: instanceId },
          completionSemantics: 'all',
        },
      ],
    }
    const g = fixture({
      outcomes: [{ kind: 'object', object: suspendRequest }],
      index,
    })
    // Re-create the same committed state in the second fixture so the suspend has a target.
    g.authority.commit({
      baseRevision: 0,
      operation: 'append',
      entries: [{ op: 'add', option: committed?.option as CompiledOption }],
      artifactId: 'art_seed',
      decisionId: 'dec_seed',
      diagnostics: {
        stages: [],
        intentDiagnostics: [],
        enrichments: [],
        partialAcceptance: 'unsupported',
        horizon: { intentCount: 1, maxDependencyDepth: 0, serializedBytes: 0 },
      },
    })
    g.syncRevision()
    mustOk(await g.harness.propose(g.request()))
    const afterSuspend = g.authority.snapshot()
    expect(deriveExecutionQueue(afterSuspend)).toHaveLength(0)
    expect(afterSuspend.options).toHaveLength(1)
    expect(afterSuspend.options[0]?.status).toBe('suspended')
    expect(afterSuspend.options[0]?.option.origin.kind).toBe('system2')

    // The derived queue is read-only: deriving twice changes nothing.
    const before = canonicalJson(afterSuspend as unknown as Record<string, unknown>)
    deriveExecutionQueue(afterSuspend)
    expect(canonicalJson(afterSuspend as unknown as Record<string, unknown>)).toBe(before)
  })

  test('17: serialize/restore preserves Option identity and origin', async () => {
    const f = fixture({ outcomes: [{ kind: 'object', object: ENTER_PORTAL }], index: worldWithPortals(['P17']) })
    const result = mustOk(await f.harness.propose(f.request()))
    const graph = f.authority.snapshot()
    const restored = restoreOptionGraph(serializeOptionGraph(graph))
    expect(canonicalJson(restored as unknown as Record<string, unknown>)).toBe(
      canonicalJson(graph as unknown as Record<string, unknown>),
    )
    const option = restored.options[0]?.option
    expect(option?.origin).toEqual({
      kind: 'system2',
      artifactId: result.artifactId,
      decisionId: f.sink.decisions()[0]?.decisionId ?? '',
      system2Epoch: f.requestIdentity.system2Epoch,
      baseRevision: 0,
      intentIndex: 0,
    })
    expect([...originsOf(restored).keys()]).toEqual([option?.optionInstanceId ?? ''])
  })
})

// ---------------------------------------------------------------------------
// 18/19. benchmark independence + generalization
// ---------------------------------------------------------------------------
describe('fixtures 18/19: no benchmark order or strategy enum is required', () => {
  test('18: changing rung labels/order changes nothing', async () => {
    const a = buildSystem2Projection(projectionInput({ benchmarkOrder: ['diamond', 'obsidian', 'blaze_rod'] }))
    const b = buildSystem2Projection(projectionInput({ benchmarkOrder: ['blaze_rod', 'diamond', 'obsidian'] }))
    expect(projectionHash(a)).toBe(projectionHash(b))

    const first = fixture({
      outcomes: [{ kind: 'object', object: ENTER_PORTAL }],
      index: worldWithPortals(['P17']),
      projection: { benchmarkOrder: ['diamond', 'obsidian'] },
    })
    const second = fixture({
      outcomes: [{ kind: 'object', object: ENTER_PORTAL }],
      index: worldWithPortals(['P17']),
      projection: { benchmarkOrder: ['obsidian', 'diamond'] },
    })
    const resultA = mustOk(await first.harness.propose(first.request()))
    const resultB = mustOk(await second.harness.propose(second.request()))
    expect(canonicalJson(resultA.proposal.patch as unknown as Record<string, unknown>)).toBe(
      canonicalJson(resultB.proposal.patch as unknown as Record<string, unknown>),
    )
  })

  test('19: a non-M2 objective needs no new vocabulary', async () => {
    const endgame: System2Proposal = {
      operation: 'append',
      rationale: 'The dragon is the mission; locate and reach it without a benchmark route.',
      intents: [
        {
          intentText: 'find an ender dragon',
          desiredPredicates: [{ kind: 'find', args: { domain: 'entity', key: 'ender_dragon' } }],
          completionSemantics: 'all',
        },
        {
          intentText: 'reach the end',
          desiredPredicates: [{ kind: 'reach', args: { target: { kind: 'symbolic', description: 'the end dimension' } } }],
          completionSemantics: 'all',
        },
      ],
    }
    const f = fixture({ outcomes: [{ kind: 'object', object: endgame }] })
    mustOk(await f.harness.propose(f.request()))
    expect(f.authority.snapshot().options).toHaveLength(2)
    expect(PREDICATE_KINDS).toEqual(['acquire', 'ensure', 'reach', 'find', 'establish', 'interact', 'preserve', 'recover'])
  })
})

// ---------------------------------------------------------------------------
// 20/21. provider swap + offline replay
// ---------------------------------------------------------------------------
describe('fixtures 20/21: provider neutrality and provider-free replay', () => {
  test('20: swapping provider/model is configuration only', async () => {
    const scenario = (providerId: string, modelId: string) =>
      fixture({
        outcomes: [{ kind: 'object', object: ENTER_PORTAL }],
        index: worldWithPortals(['P17']),
        providerIdentity: { providerId, modelId, transport: 'tool-call' },
      })
    const a = scenario('ai-gateway', 'provider/model-a')
    const b = scenario('local-openai-compatible', 'local/model-b')
    const resultA = mustOk(await a.harness.propose(a.request()))
    const resultB = mustOk(await b.harness.propose(b.request()))

    const semantics = (graph: OptionGraph) =>
      canonicalJson(graph.options.map((entry) => entry.option) as unknown as Record<string, unknown>)
    expect(semantics(a.authority.snapshot())).toBe(semantics(b.authority.snapshot()))
    // Provider identity is part of cache identity, and of the artifact record.
    expect(a.sink.decisions()[0]?.cacheKey).not.toBe(b.sink.decisions()[0]?.cacheKey)
    expect(resultA.proposal.patch?.diagnostics.partialAcceptance).toBe(resultB.proposal.patch?.diagnostics.partialAcceptance)

    const gatewayA = createAiGatewayProvider({ modelId: 'provider/model-a' })
    const gatewayB = createAiGatewayProvider({ modelId: 'local/model-b', providerId: 'local' })
    expect(typeof gatewayA.dispatch).toBe('function')
    expect(typeof gatewayB.dispatch).toBe('function')
    expect(gatewayA.identity.modelId).not.toBe(gatewayB.identity.modelId)
    expect(aiGatewayProviderIdentity({ modelId: 'meta/muse-spark-1.3-contributor' }).transport).toBe('json-text')
  })

  test('21: an exact historical proposal replays offline', async () => {
    const live = fixture({ outcomes: [{ kind: 'object', object: ENTER_PORTAL }], index: worldWithPortals(['P17']) })
    mustOk(await live.harness.propose(live.request()))
    const artifact = live.sink.decisions()[0]
    expect(artifact).toBeDefined()
    if (artifact === undefined) return

    // The replay adapter implements the SAME seam, so the replayed request runs
    // the identical decode/compile/ground/commit pipeline provider-free.
    const replayProvider = new ReplayProviderAdapter({
      identity: TEST_PROVIDER,
      entries: replayEntriesFromArtifacts([artifact]),
      mode: 'exact',
    })
    const target = fixture({ outcomes: [], index: worldWithPortals(['P17']) })
    const replaySink = new MemorySystem2ArtifactSink()
    const harness = createSystem2Harness({
      provider: replayProvider,
      authority: target.authority,
      identity: target.identitySource,
      artifacts: replaySink,
      runId: TEST_RUN_ID,
      sourceSha: TEST_SOURCE_SHA,
      index: target.index,
    })
    const result = mustOk(await harness.propose(target.request()))
    expect(result.commit.status).toBe('committed')
    expect(replayProvider.matchedArtifactIds).toEqual([artifact.artifactId])
    // A replayed answer is distinguishable from a live one in the artifact.
    expect(replaySink.decisions()[0]?.cacheSource).toBe('replay')
    // …and it produced the same authoritative graph as the live run.
    expect(canonicalJson(target.authority.snapshot() as unknown as Record<string, unknown>)).toBe(
      canonicalJson(live.authority.snapshot() as unknown as Record<string, unknown>),
    )
  })

  test('21b: an incompatible semantic contract refuses to replay', () => {
    const artifact = {
      artifactId: 'art_x',
      projectionHash: 'h',
      wakeReason: 'MISSION_START',
      system2Epoch: 1,
      projectionVersion: 1,
      provider: TEST_PROVIDER,
      rawResponse: null,
      versions: { harness: 1, stateProjection: 1, proposalSchema: 1, predicateRegistry: 1, compiler: 1, prompt: 99 },
    }
    expect(() =>
      new ReplayProviderAdapter({
        identity: TEST_PROVIDER,
        entries: replayEntriesFromArtifacts([artifact as never]),
        requireCurrentSemanticContract: true,
      }),
    ).toThrow(/SEMANTIC_CONTRACT_CHANGED/)
  })
})

// ---------------------------------------------------------------------------
// 22. raw rationale vs normalized proposal
// ---------------------------------------------------------------------------
describe('fixture 22: raw model text and the normalized proposal are separately observable', () => {
  test('both are recorded, and only the typed one has authority', async () => {
    const f = fixture({
      outcomes: [
        {
          kind: 'object',
          object: {
            operation: 'append',
            rationale: 'The portal is verified. Dig down at 12,-30 to find more obsidian.',
            intents: [
              { intentText: 'have 10 obsidian', desiredPredicates: [{ kind: 'acquire', args: { item: 'obsidian', count: 10 } }], completionSemantics: 'all' },
            ],
          },
        },
      ],
    })
    mustOk(await f.harness.propose(f.request()))
    const artifact = f.sink.decisions()[0]
    expect(artifact?.rationaleText).toContain('Dig down at 12,-30')
    expect(artifact?.normalizedProposal?.intents[0]?.desiredPredicates[0]?.kind).toBe('acquire')
    expect(artifact?.rationaleExecutionDirectives).toContain('coordinate_pair')
    expect(artifact?.finalPatch).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 23/24. wake gating
// ---------------------------------------------------------------------------
describe('fixtures 23/24: local noise is suppressed, semantic exhaustion wakes', () => {
  test('23: one failed path / one refused PLACE / one low-confidence Jev / two WAITs do not wake', () => {
    const decision = evaluateWakePolicy({
      pathFailures: 1,
      placeRefusals: 1,
      lowConfidenceJev: 1,
      consecutiveWaits: 2,
      exhaustedAlternatives: 0,
      optionTerminalVerified: false,
      optionHardInvalid: false,
      noFrontier: false,
      failureClasses: ['path_no_path'],
    })
    expect(decision.wake).toBe(false)
    if (decision.wake) return
    const events = decision.suppressed.map((entry) => entry.event)
    expect(events).toContain('place_refused')
    expect(events).toContain('path_failed')
    expect(events).toContain('wait')
    expect(events).toContain('jev_low_confidence')
  })

  test('24: typed exhaustion wakes with the exact causal evidence', () => {
    const stall = evaluateWakePolicy({
      pathFailures: 3,
      placeRefusals: 0,
      lowConfidenceJev: 0,
      consecutiveWaits: 0,
      exhaustedAlternatives: 2,
      optionTerminalVerified: false,
      optionHardInvalid: false,
      noFrontier: false,
      failureClasses: ['path_no_path', 'place_refused'],
    })
    expect(stall).toEqual({ wake: true, wakeReason: 'SEMANTIC_STALL', cause: 'option_exhausted_with_corroboration' })

    const frontier = evaluateWakePolicy({
      pathFailures: 0,
      placeRefusals: 0,
      lowConfidenceJev: 0,
      consecutiveWaits: 3,
      exhaustedAlternatives: 0,
      optionTerminalVerified: false,
      optionHardInvalid: false,
      noFrontier: true,
      failureClasses: [],
    })
    expect(frontier).toEqual({ wake: true, wakeReason: 'NO_SEMANTIC_FRONTIER', cause: 'no_frontier_after_waits' })

    const done = evaluateWakePolicy({
      pathFailures: 0,
      placeRefusals: 0,
      lowConfidenceJev: 0,
      consecutiveWaits: 0,
      exhaustedAlternatives: 0,
      optionTerminalVerified: true,
      optionHardInvalid: false,
      noFrontier: false,
      failureClasses: [],
    })
    expect(done).toEqual({ wake: true, wakeReason: 'OPTION_TERMINATED', cause: 'verified_terminal' })

    const invalid = evaluateWakePolicy({
      pathFailures: 0,
      placeRefusals: 0,
      lowConfidenceJev: 0,
      consecutiveWaits: 0,
      exhaustedAlternatives: 0,
      optionTerminalVerified: false,
      optionHardInvalid: true,
      noFrontier: false,
      failureClasses: [],
    })
    expect(invalid).toEqual({ wake: true, wakeReason: 'OPTION_HARD_INVALID', cause: 'hard_invalidity' })
  })

  test('the taxonomy is exactly the 10 versioned reasons', () => {
    expect([...SYSTEM2_WAKE_REASONS]).toEqual([
      'MISSION_START',
      'OPTION_TERMINATED',
      'OPTION_HARD_INVALID',
      'DEPENDENCY_UNSATISFIED',
      'NO_SEMANTIC_FRONTIER',
      'SEMANTIC_STALL',
      'WORLD_TRANSITION',
      'MAJOR_RESOURCE_REGRESSION',
      'HUMAN_INTENT_CHANGE',
      'PLAN_REPAIR_REQUIRED',
    ])
  })
})

// ---------------------------------------------------------------------------
// 25. provenance
// ---------------------------------------------------------------------------
describe('fixture 25: every accepted revision links to its artifact', () => {
  test('the revision, the options and the link records all agree', async () => {
    const f = fixture({ outcomes: [{ kind: 'object', object: ENTER_PORTAL }], index: worldWithPortals(['P17']) })
    const result = mustOk(await f.harness.propose(f.request()))
    const graph = f.authority.snapshot()
    const artifact = f.sink.decisions()[0]
    expect(graph.committedArtifactId).toBe(result.artifactId)
    const origins = originsOf(graph)
    for (const origin of origins.values()) {
      expect(origin.kind).toBe('system2')
      if (origin.kind !== 'system2') return
      expect(origin.artifactId).toBe(result.artifactId)
      expect(origin.decisionId).toBe(artifact?.decisionId ?? '')
    }
    const links = f.sink.links()
    expect(links).toHaveLength(graph.options.length)
    expect(links[0]?.artifactId).toBe(result.artifactId)
    expect(links[0]?.optionInstanceId).toBe(graph.options[0]?.option.optionInstanceId ?? '')
  })

  test('a truth-enriched option records which truth facts were added', async () => {
    const f = fixture({
      outcomes: [{ kind: 'object', object: acquireProposal('iron_ingot', 1) }],
      truth: truthWithFurnace(),
    })
    mustOk(await f.harness.propose(f.request()))
    const option = f.authority.snapshot().options[0]?.option
    expect(option?.desiredPredicates).toHaveLength(1)
    expect(option?.dependencies.some((spec) => spec.kind === 'establish' && spec.args.station === 'furnace')).toBe(true)
    expect(option?.dependencies.every((spec) => spec.enrichedBy.length > 0)).toBe(true)
  })
})
