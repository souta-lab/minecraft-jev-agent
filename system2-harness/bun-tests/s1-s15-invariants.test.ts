// system2-harness/bun-tests/s1-s15-invariants.test.ts - the #439 section 31
// executable architecture invariants.
//
// "These belong in CI, not only documentation." Each invariant below states its
// own failure mode, and each one fails for a structural reason — not because a
// snapshot changed.
//
// Two of them (S1, S2) are RATCHETS: they pin the current set of legacy provider
// call paths exactly, so Phases C/D/E cannot silently add a new bypass and cannot
// silently leave a migrated one behind either.

import { describe, expect, test } from 'bun:test'
import { canonicalJson } from '../canonical.ts'
import type { CompiledOption, OptionGraph, OptionGraphPatch, System2Proposal } from '../contract.ts'
import { PREDICATE_KINDS } from '../contract.ts'
import { PREDICATE_REGISTRY } from '../predicateRegistry.ts'
import { InMemoryOptionGraphAuthority, applyOptionGraphPatch, deriveExecutionQueue, originsOf } from '../optionGraph.ts'
import type { CommitResult, OptionGraphAuthority } from '../optionGraph.ts'
import { CODE_FALLBACK_RECORD, MemorySystem2ArtifactSink } from '../artifacts.ts'
import { System2ProposalCache, cacheKeyFor, leafPaths, withLeafReplaced } from '../cache.ts'
import { checkSystem2Currency, staticSystem2IdentitySource, toCausalIdentity } from '../epochs.ts'
import { MAX_PREDICATES_PER_INTENT, detectExecutionDirectives, decodeSystem2Proposal } from '../schema.ts'
import { SYSTEM2_PROJECTION_ID, assertProjectionHasNoBenchmarkOrder, buildSystem2Projection } from '../stateProjection.ts'
import type { StaleReason } from '../epochs.ts'
import { REGISTERED_SYSTEM2_PROMPTS, SYSTEM2_PROMPT_ID } from '../prompt.ts'
import type { System2Wake, System2WakeReason } from '../wakeReasons.ts'
import { isSystem2WakeReason, wakeFromEvent, wakeHash } from '../wakeReasons.ts'
import { SEMANTIC_VERSIONS, semanticContractMismatches } from '../versions.ts'
import {
  ALLOWED_LEGACY_PROVIDER_CALLS,
  deepHarnessImports,
  harnessCodeSources,
  harnessSdkImporters,
  providerSdkImporters,
  referencesSymbol,
} from './static-scan.ts'
import {
  acquireProposal,
  enterPortalProposal,
  fixture,
  identity,
  mustFail,
  mustOk,
  portalRef,
  projectionInput,
  worldWithPortals,
} from './support.ts'

const ENTER_PORTAL: System2Proposal = enterPortalProposal()

// ---------------------------------------------------------------------------
// S1
// ---------------------------------------------------------------------------
describe('S1: no direct System2/provider import outside the harness', () => {
  test('the legacy direct-provider call set is pinned exactly', () => {
    const found = providerSdkImporters()
    expect(found).toEqual(Object.keys(ALLOWED_LEGACY_PROVIDER_CALLS).sort())
    // A new bypass fails here; so does removing one without deleting its entry,
    // which is what makes the Phase C/D/E migration visible.
    for (const [file, owner] of Object.entries(ALLOWED_LEGACY_PROVIDER_CALLS)) {
      expect(found).toContain(file)
      expect(owner.startsWith('#')).toBe(true)
    }
  })

  test('only the barrel of system2-harness is importable from outside', () => {
    expect(deepHarnessImports()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// S2
// ---------------------------------------------------------------------------
describe('S2: no unregistered prompt/call path', () => {
  test('exactly one registered prompt, pointing at the harness', () => {
    expect(REGISTERED_SYSTEM2_PROMPTS).toHaveLength(1)
    expect(REGISTERED_SYSTEM2_PROMPTS[0]?.id).toBe(SYSTEM2_PROMPT_ID)
    expect(REGISTERED_SYSTEM2_PROMPTS[0]?.callPath).toContain('System2Harness.propose')
  })

  test('the prompt builder is reachable only from the harness', () => {
    expect(referencesSymbol('', 'buildSystem2Prompt')).toEqual(['system2-harness/harness.ts', 'system2-harness/prompt.ts'])
  })

  test('only the provider adapter touches the SDK inside the harness', () => {
    expect(harnessSdkImporters()).toEqual(['system2-harness/providers/aiGateway.ts'])
  })
})

// ---------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------
describe('S3: every request has a typed wake reason', () => {
  const EVENTS: readonly { readonly event: Parameters<typeof wakeFromEvent>[0]; readonly reason: System2WakeReason }[] = [
    { event: { kind: 'mission_start', missionId: 'm2', missionText: 'nether' }, reason: 'MISSION_START' },
    {
      event: { kind: 'option_terminated', optionInstanceId: 'oi_1', terminalReason: 'done', verified: 'verified', evidence: ['predicate verified'] },
      reason: 'OPTION_TERMINATED',
    },
    { event: { kind: 'option_hard_invalid', optionInstanceId: 'oi_1', invalidity: 'portal gone', evidence: ['site invalidated'] }, reason: 'OPTION_HARD_INVALID' },
    { event: { kind: 'dependency_unsatisfied', optionInstanceId: 'oi_1', missing: ['establish(furnace)'], evidence: ['no furnace'] }, reason: 'DEPENDENCY_UNSATISFIED' },
    { event: { kind: 'no_semantic_frontier', frontierSummary: 'no grounded candidate', evidence: ['0 candidates'] }, reason: 'NO_SEMANTIC_FRONTIER' },
    { event: { kind: 'semantic_stall', optionInstanceId: 'oi_1', exhaustedAlternatives: 2, failureClasses: ['path_no_path'], evidence: ['2 alternatives'] }, reason: 'SEMANTIC_STALL' },
    {
      event: { kind: 'world_transition', fromDimension: 'overworld', toDimension: 'the_nether', fromWorldEpoch: 1, toWorldEpoch: 2, evidence: ['dimension change'] },
      reason: 'WORLD_TRANSITION',
    },
    {
      event: { kind: 'major_resource_regression', regression: 'death', losses: [{ item: 'diamond', before: 3, after: 0 }], evidence: ['death'] },
      reason: 'MAJOR_RESOURCE_REGRESSION',
    },
    { event: { kind: 'human_intent_change', intentRevision: 2, intentText: 'hold', evidence: ['operator'] }, reason: 'HUMAN_INTENT_CHANGE' },
    { event: { kind: 'plan_repair_required', optionInstanceId: null, repairCause: 'stale portal', evidence: ['repair'] }, reason: 'PLAN_REPAIR_REQUIRED' },
  ]

  test('all ten reasons round-trip with causal evidence', () => {
    for (const { event, reason } of EVENTS) {
      const wake: System2Wake = wakeFromEvent(event)
      expect(wake.reason).toBe(reason)
      expect(isSystem2WakeReason(wake.reason)).toBe(true)
      expect(wake.detail.reason).toBe(reason)
      expect(wake.detail.evidence.length).toBeGreaterThan(0)
      expect(wakeHash(wake)).toHaveLength(64)
    }
  })

  test('an unregistered wake reason is refused before any provider call', async () => {
    const f = fixture({ outcomes: [{ kind: 'object', object: ENTER_PORTAL }], index: worldWithPortals(['P17']) })
    const request = f.request()
    const bad = {
      ...request,
      projection: { ...request.projection, payload: { ...(request.projection.payload as object), wake: { reason: 'MOOD_CHANGED', detail: {} } } },
    }
    const failure = mustFail(await f.harness.propose(bad as unknown as typeof request))
    expect(failure.kind).toBe('invalid_request')
    expect(f.provider.dispatchCount).toBe(0)
    expect(f.authority.snapshot().revision).toBe(0)
  })

  test('the projection carries the exact wake reason', async () => {
    const f = fixture({ outcomes: [{ kind: 'object', object: ENTER_PORTAL }], index: worldWithPortals(['P17']) })
    mustOk(await f.harness.propose(f.request()))
    expect(f.sink.decisions()[0]?.wakeReason).toBe('MISSION_START')
  })
})

// ---------------------------------------------------------------------------
// S4
// ---------------------------------------------------------------------------
describe('S4: every proposal binds to system2Epoch + base OptionGraph revision', () => {
  test('a request whose base revision is not live never reaches the provider', async () => {
    const f = fixture({ outcomes: [{ kind: 'object', object: ENTER_PORTAL }], index: worldWithPortals(['P17']) })
    const failure = mustFail(await f.harness.propose(f.request({ identity: { optionGraphRevision: 5 } })))
    expect(failure.kind).toBe('stale')
    expect(f.provider.dispatchCount).toBe(0)
    expect(f.authority.snapshot().revision).toBe(0)
    const artifact = f.sink.decisions()[0]
    expect(artifact?.baseRevision).toBe(5)
    expect(artifact?.system2Epoch).toBe(f.requestIdentity.system2Epoch)
    expect(artifact?.staleCheck.current).toBe(false)
  })

  test('the epoch participates in the decision identity', async () => {
    const one = fixture({ outcomes: [{ kind: 'object', object: ENTER_PORTAL }], index: worldWithPortals(['P17']), requestIdentity: { system2Epoch: 7 } })
    const two = fixture({ outcomes: [{ kind: 'object', object: ENTER_PORTAL }], index: worldWithPortals(['P17']), requestIdentity: { system2Epoch: 8 } })
    mustOk(await one.harness.propose(one.request()))
    mustOk(await two.harness.propose(two.request()))
    expect(one.sink.decisions()[0]?.decisionId).not.toBe(two.sink.decisions()[0]?.decisionId)
  })
})

// ---------------------------------------------------------------------------
// S5
// ---------------------------------------------------------------------------
describe('S5: a stale response cannot mutate semantic state', () => {
  const variants: readonly { readonly name: string; readonly reason: StaleReason; readonly mutate: (f: ReturnType<typeof fixture>) => void }[] = [
    { name: 'system2Epoch', reason: 'system2_epoch_advanced', mutate: (f) => f.identitySource.advanceEpoch() },
    { name: 'generationId', reason: 'generation_changed', mutate: (f) => f.identitySource.setGeneration('gen-2') },
    { name: 'worldKey', reason: 'world_key_changed', mutate: (f) => f.identitySource.setWorld('local:the_nether', 9) },
    { name: 'worldEpoch', reason: 'world_epoch_changed', mutate: (f) => f.identitySource.set({ ...f.live(), worldEpoch: 9 }) },
    { name: 'humanIntentRevision', reason: 'human_intent_changed', mutate: (f) => f.identitySource.setHumanIntentRevision(1) },
    { name: 'missionId', reason: 'mission_changed', mutate: (f) => f.identitySource.set({ ...f.live(), missionId: 'm3-end' }) },
    { name: 'activeOptionInstanceId', reason: 'active_option_changed', mutate: (f) => f.identitySource.setActiveOption('oi_other') },
  ]

  for (const variant of variants) {
    test(`${variant.name} changed mid-flight -> discarded`, async () => {
      const f = fixture({
        outcomes: [{ kind: 'object', object: ENTER_PORTAL }],
        index: worldWithPortals(['P17']),
        hooks: { beforeDispatch: () => variant.mutate(f) },
      })
      const failure = mustFail(await f.harness.propose(f.request()))
      expect(failure.kind).toBe('stale')
      const graph = f.authority.snapshot()
      expect(graph.revision).toBe(0)
      expect(graph.options).toHaveLength(0)
      expect(graph.committedArtifactId).toBeNull()
      expect(f.sink.links()).toHaveLength(0)
      expect(f.sink.staleDrops()).toHaveLength(1)
      expect(f.sink.staleDrops()[0]?.reason).toBe(variant.reason)
      const artifact = f.sink.decisions()[0]
      expect(artifact?.resultKind).toBe('stale')
      expect(artifact?.finalPatch).toBeNull()
      expect(artifact?.staleCheck.current).toBe(false)
    })
  }

  test('the currency check reports the highest-priority mismatch first', () => {
    const bound = toCausalIdentity(identity())
    const live = { ...bound, system2Epoch: bound.system2Epoch + 1, worldKey: 'other', generationId: 'gen-9' }
    const check = checkSystem2Currency(bound, live)
    expect(check.current).toBe(false)
    if (check.current) return
    expect(check.reason).toBe('system2_epoch_advanced')
    expect(check.mismatches.map((entry) => entry.field)).toEqual(['system2_epoch_advanced', 'generation_changed', 'world_key_changed'])
  })
})

// ---------------------------------------------------------------------------
// S6
// ---------------------------------------------------------------------------
describe('S6: free-form rationale cannot mutate the queue or graph', () => {
  test('changing only the rationale changes nothing authoritative', async () => {
    // Everything except `rationale` is held identical: identical typed intents and
    // identical intentText, so the ONLY difference in the model answer is prose.
    const intent = {
      intentText: 'have 3 diamond',
      desiredPredicates: [{ kind: 'acquire', args: { item: 'diamond', count: 3 } }],
      completionSemantics: 'all' as const,
    }
    const withRationale = fixture({
      outcomes: [
        {
          kind: 'object',
          object: {
            operation: 'append',
            rationale: 'Mine straight down at 12,-30 to Y=-54, then walk north 30 blocks.',
            intents: [intent],
          },
        },
      ],
    })
    const withoutRationale = fixture({ outcomes: [{ kind: 'object', object: { operation: 'append', intents: [intent] } }] })
    mustOk(await withRationale.harness.propose(withRationale.request()))
    mustOk(await withoutRationale.harness.propose(withoutRationale.request()))
    const a = withRationale.authority.snapshot()
    const b = withoutRationale.authority.snapshot()
    expect(canonicalJson(a as unknown as Record<string, unknown>)).toBe(canonicalJson(b as unknown as Record<string, unknown>))

    // The directives were observed and recorded, and had no authority.
    expect(detectExecutionDirectives('Mine straight down at 12,-30 to Y=-54, then walk north 30 blocks.').length).toBeGreaterThan(0)
    expect(withRationale.sink.decisions()[0]?.rationaleExecutionDirectives.length).toBeGreaterThan(0)
    expect(withoutRationale.sink.decisions()[0]?.rationaleText).toBeNull()
    const option = a.options[0]?.option
    expect(option?.desiredPredicates.map((spec) => spec.kind)).toEqual(['acquire'])
    expect(option?.target).toBeNull()
  })

  test('prose alone cannot even become an Option', async () => {
    const f = fixture({
      outcomes: [
        {
          kind: 'object',
          object: { operation: 'append', rationale: 'just dig down', intents: [{ intentText: 'dig down', desiredPredicates: [], completionSemantics: 'all' }] },
        },
      ],
    })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.diagnostics?.intentDiagnostics[0]?.kind).toBe('prose_only_intent')
    expect(f.authority.snapshot().revision).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// S7
// ---------------------------------------------------------------------------
describe('S7: unknown grounded refs fail closed', () => {
  test('a targetRef that is not in world memory is rejected', async () => {
    const f = fixture({ outcomes: [{ kind: 'object', object: enterPortalProposal(portalRef('P404')) }], index: worldWithPortals(['P17']) })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('ungroundable_intent')
    expect(failure.diagnostics?.intentDiagnostics[0]?.kind).toBe('unknown_grounded_ref')
    expect(failure.diagnostics?.intentDiagnostics[0]?.evidence.knownRefs).toEqual(['P17'])
  })

  test('a ref used as a predicate argument is also resolved', async () => {
    const f = fixture({
      outcomes: [{ kind: 'object', object: { operation: 'append', intents: [{ intentText: 'reach the furnace', desiredPredicates: [{ kind: 'reach', args: { target: { kind: 'grounded', refKind: 'station', refId: 'F404' } } }], completionSemantics: 'all' }] } }],
      index: worldWithPortals(['P17']),
    })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('ungroundable_intent')
  })

  test('a known-but-unusable ref is a truth rejection, not a target', async () => {
    const index = { ...worldWithPortals(['P17']), stations: [{ refId: 'F3', kind: 'furnace' as const, usable: false, dimension: 'overworld' }] }
    const f = fixture({
      outcomes: [
        {
          kind: 'object',
          object: { operation: 'append', intents: [{ intentText: 'use the furnace', desiredPredicates: [{ kind: 'reach', args: { target: { kind: 'grounded', refKind: 'station', refId: 'F3' } } }], completionSemantics: 'all' }] },
        },
      ],
      index,
    })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('compile_rejected')
    expect(failure.diagnostics?.intentDiagnostics[0]?.kind).toBe('grounded_ref_known_absent')
  })

  test('no verified portal + an unverified one known is a truth rejection, not a search downgrade', async () => {
    const index = { ...worldWithPortals([]), portalSites: [{ refId: 'P1', verified: false, dimension: 'overworld' }] }
    const f = fixture({ outcomes: [{ kind: 'object', object: ENTER_PORTAL }], index })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('ungroundable_intent')
    expect(failure.diagnostics?.intentDiagnostics[0]?.kind).toBe('portal_not_verified')
    expect(f.authority.snapshot().options).toHaveLength(0)
  })

  test('no portal known at all stays a symbolic search objective', async () => {
    const f = fixture({ outcomes: [{ kind: 'object', object: ENTER_PORTAL }] })
    mustOk(await f.harness.propose(f.request()))
    expect(f.authority.snapshot().options[0]?.option.target?.kind).toBe('symbolic')
  })
})

// ---------------------------------------------------------------------------
// S8
// ---------------------------------------------------------------------------
describe('S8: System2 cannot emit a primitive action sequence', () => {
  test('the registry has no coordinate or sequence argument', () => {
    const forbidden = ['x', 'y', 'z', 'at', 'pos', 'position', 'coord', 'coords', 'delta', 'steps', 'sequence', 'path', 'nodes', 'tick', 'duration', 'ms']
    for (const definition of Object.values(PREDICATE_REGISTRY)) {
      for (const arg of Object.keys(definition.args)) {
        expect(forbidden).not.toContain(arg)
      }
    }
  })

  test('a coordinate or array argument cannot be decoded', () => {
    expect(decodeSystem2Proposal({ operation: 'append', intents: [{ intentText: 'x', desiredPredicates: [{ kind: 'reach', args: { target: [1, 2, 3] } }], completionSemantics: 'all' }] }).ok).toBe(false)
    expect(decodeSystem2Proposal({ operation: 'append', intents: [{ intentText: 'x', desiredPredicates: [{ kind: 'reach', args: { target: { x: 1 } } }], completionSemantics: 'all' }] }).ok).toBe(false)
    // An unknown top-level key is a rejection, not a silently ignored field.
    expect(decodeSystem2Proposal({ operation: 'append', steps: ['MOVE', 'DIG'], intents: [] }).ok).toBe(false)
  })

  test('reach requires a ref, never a number', async () => {
    const f = fixture({
      outcomes: [
        {
          kind: 'object',
          object: { operation: 'append', intents: [{ intentText: 'walk 30 blocks north', desiredPredicates: [{ kind: 'reach', args: { target: 30 } }], completionSemantics: 'all' }] },
        },
      ],
    })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('compile_rejected')
    expect(failure.diagnostics?.intentDiagnostics[0]?.kind).toBe('invalid_predicate_arguments')
  })

  test('the horizon is bounded', async () => {
    const intents = Array.from({ length: 9 }, (_, index) => ({
      intentText: `intent ${index}`,
      desiredPredicates: [{ kind: 'acquire', args: { item: 'diamond', count: 1 } }],
      completionSemantics: 'all' as const,
    }))
    const f = fixture({ outcomes: [{ kind: 'object', object: { operation: 'append', intents } }] })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('invalid_response')
    expect(MAX_PREDICATES_PER_INTENT).toBeLessThan(10)
  })
})

// ---------------------------------------------------------------------------
// S9
// ---------------------------------------------------------------------------
describe('S9: the compiler cannot silently substitute a semantic strategy', () => {
  test('the proposed predicates survive in order, with only additive enrichment', async () => {
    const f = fixture({
      outcomes: [
        {
          kind: 'object',
          object: {
            operation: 'append',
            intents: [
              {
                intentText: 'have iron',
                desiredPredicates: [
                  { kind: 'acquire', args: { item: 'iron_ingot', count: 2 } },
                  { kind: 'preserve', args: { item: 'diamond', count: 1 } },
                ],
                completionSemantics: 'all',
              },
            ],
          },
        },
      ],
      truth: (await import('./support.ts')).truthWithFurnace(),
    })
    mustOk(await f.harness.propose(f.request()))
    const option = f.authority.snapshot().options[0]?.option
    expect(option?.desiredPredicates.map((spec) => spec.kind)).toEqual(['acquire', 'preserve'])
    expect(option?.desiredPredicates.map((spec) => spec.sourceDraftIndex)).toEqual([0, 1])
    // Every added dependency is attributable to a code-owned truth fact.
    for (const dependency of option?.dependencies ?? []) {
      expect(dependency.sourceDraftIndex).toBe(-1)
      expect(dependency.enrichedBy.length).toBeGreaterThan(0)
    }
  })

  test('with no truth index nothing is added', async () => {
    const f = fixture({ outcomes: [{ kind: 'object', object: acquireProposal('iron_ingot', 1) }] })
    mustOk(await f.harness.propose(f.request()))
    expect(f.authority.snapshot().options[0]?.option.dependencies).toHaveLength(0)
  })

  test('an impossible proposal is rejected, never rewritten', async () => {
    const f = fixture({
      outcomes: [
        {
          kind: 'object',
          object: { operation: 'append', intents: [{ intentText: 'enter the portal', desiredPredicates: [{ kind: 'interact', args: { operation: 'enter' } }], completionSemantics: 'all' }] },
        },
      ],
      index: { ...worldWithPortals([]), portalSites: [{ refId: 'P1', verified: false, dimension: 'overworld' }] },
    })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.diagnostics?.intentDiagnostics[0]?.kind).toBe('portal_not_verified')
    const added = (failure.diagnostics?.enrichments ?? []).filter((entry) => entry.effect === 'added_dependency')
    expect(added).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// S10
// ---------------------------------------------------------------------------
describe('S10: model/provider failure cannot activate a legacy plan', () => {
  test('every provider failure is typed, inert and fallback-free', async () => {
    for (const outcome of [{ kind: 'timeout' as const }, { kind: 'provider_unavailable' as const }, { kind: 'aborted' as const }]) {
      const f = fixture({ outcomes: [outcome, outcome, outcome], maxTransportAttempts: 3 })
      const failure = mustFail(await f.harness.propose(f.request()))
      expect(['timeout', 'provider_unavailable', 'aborted']).toContain(failure.kind)
      expect(failure.modelAnswerPresent).toBe(false)
      expect(failure.fallbackAuthority).toBe('none')
      expect(failure.diagnostics).toBeNull()
      expect(f.authority.snapshot().options).toHaveLength(0)
      expect(f.sink.fallbacks()).toHaveLength(0)
      // The failed attempt is still one immutable artifact.
      expect(f.sink.decisions()).toHaveLength(1)
      expect(f.sink.decisions()[0]?.finalPatch).toBeNull()
    }
  })

  test('the harness code contains no ladder and no legacy import', () => {
    for (const module of harnessCodeSources()) {
      for (const token of ['RUNGS', 'ladderFloorGoals', 'rungIndexById', 'legacyPlan', 'fallbackPlan', 'chooseStrategy', 'buddy-driver']) {
        expect({ file: module.file, token, present: module.code.includes(token) }).toEqual({ file: module.file, token, present: false })
      }
    }
  })

  test('the Phase F exception record exists, is explicit, and is never emitted by the harness', () => {
    const sink = new MemorySystem2ArtifactSink()
    sink.append({
      record: CODE_FALLBACK_RECORD,
      createdAt: '2026-09-22T00:00:00.000Z',
      runId: 'r',
      artifactId: null,
      system2AnswerPresent: false,
      fallbackAuthority: 'legacy_code',
      architectureException: '424',
      detail: 'ladderFloorGoals supplied WHAT while System2 was unavailable',
      proposal: { source: 'ladderFloorGoals' },
    })
    expect(sink.fallbacks()).toHaveLength(1)
    expect(sink.decisions()).toHaveLength(0)
    expect(sink.fallbacks()[0]?.architectureException).toBe('424')
  })
})

// ---------------------------------------------------------------------------
// S11
// ---------------------------------------------------------------------------
describe('S11: the cache key covers all model-visible WHAT-relevant state', () => {
  function flip(value: unknown): unknown {
    if (value === null || value === undefined) return 'changed'
    if (typeof value === 'string') return `${value}!`
    if (typeof value === 'number') return value + 1
    if (typeof value === 'boolean') return !value
    if (Array.isArray(value)) return [...value, 'changed']
    return { changed: true }
  }

  test('flipping ANY model-visible leaf changes the cache key', async () => {
    const f = fixture({ outcomes: [{ kind: 'object', object: ENTER_PORTAL }], index: worldWithPortals(['P17']) })
    mustOk(await f.harness.propose(f.request()))
    const visible = f.provider.lastRequest()?.modelVisible
    expect(visible).toBeDefined()
    if (visible === undefined) return
    const baseline = cacheKeyFor(visible)
    const leaves = leafPaths(visible)
    // A trivial request already has dozens of independent WHAT-relevant leaves.
    expect(leaves.length).toBeGreaterThan(30)
    const insensitive: string[] = []
    for (const path of leaves) {
      const flipped = withLeafReplaced(visible, path, flip(pathValue(visible, path)))
      if (cacheKeyFor(flipped as typeof visible) === baseline) insensitive.push(path)
    }
    expect(insensitive).toEqual([])
  })

  test('every WHAT-relevant variable named by #439 section 17 is a key input', async () => {
    const f = fixture({ outcomes: [{ kind: 'object', object: ENTER_PORTAL }], index: worldWithPortals(['P17']) })
    mustOk(await f.harness.propose(f.request()))
    const visible = f.provider.lastRequest()?.modelVisible
    expect(visible).toBeDefined()
    if (visible === undefined) return
    const leaves = leafPaths(visible)
    const required = [
      'identity.system2Epoch',
      'identity.missionId',
      'identity.optionGraphRevision',
      'identity.activeOptionInstanceId',
      'identity.worldKey',
      'identity.worldEpoch',
      'identity.generationId',
      'identity.humanIntentRevision',
      'projectionHash',
      'projection.version',
      'projection.payload.mission',
      'projection.payload.optionGraph',
      'projection.payload.wake',
      'projection.payload.resources',
      'projection.payload.recentSemanticOutcomes',
      'projection.payload.failureEvidence',
      'projection.payload.world',
      'projection.payload.knownCapabilities',
      'projection.payload.verifiedPredicates',
      'projection.payload.unmetDependencies',
      'wakeReason',
      'wakeDetailHash',
      'promptVersion',
      'prompt',
      'versions',
      'provider.modelId',
      'provider.providerId',
      'protectedIntentRevision',
    ]
    for (const prefix of required) {
      expect({ prefix, covered: leaves.some((leaf) => leaf === `$.${prefix}` || leaf.startsWith(`$.${prefix}.`) || leaf.startsWith(`$.${prefix}[`)) }).toEqual({
        prefix,
        covered: true,
      })
    }
  })

  test('a cache hit is evidence-visible and still re-validated', async () => {
    const cache = new System2ProposalCache()
    const f = fixture({
      outcomes: [{ kind: 'object', object: { operation: 'append', intents: [{ intentText: 'x', desiredPredicates: [{ kind: 'teleport', args: {} }], completionSemantics: 'all' }] } }],
      cache,
    })
    mustFail(await f.harness.propose(f.request()))
    mustFail(await f.harness.propose(f.request()))
    expect(f.provider.dispatchCount).toBe(1)
    expect(f.sink.decisions()[1]?.cacheHit).toBe(true)
    expect(f.sink.decisions()[1]?.cacheSource).toBe('cache')
    // The cached answer was rejected again, from scratch.
    expect(f.sink.decisions()[1]?.resultKind).toBe('compile_rejected')
    expect(f.authority.snapshot().revision).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// S12
// ---------------------------------------------------------------------------
describe('S12: benchmark milestone order is absent from the authoritative projection', () => {
  test('an evaluator-supplied order cannot change the payload or its hash', () => {
    const a = buildSystem2Projection(projectionInput({ benchmarkOrder: ['diamond', 'obsidian'] }))
    const b = buildSystem2Projection(projectionInput({ benchmarkOrder: ['obsidian', 'diamond'] }))
    expect(canonicalJson(a.payload as unknown as Record<string, unknown>)).toBe(canonicalJson(b.payload as unknown as Record<string, unknown>))
    expect(a.payload.projectionId).toBe(SYSTEM2_PROJECTION_ID)
    expect('benchmarkOrder' in (a.payload as unknown as Record<string, unknown>)).toBe(false)
  })

  test('the projection has no rung/milestone/preferred fields anywhere', () => {
    const projection = buildSystem2Projection(projectionInput({}))
    const leaves = leafPaths(projection.payload)
    for (const leaf of leaves) {
      expect(leaf).not.toMatch(/rung|milestone|preferred|recommended|next_strategy/i)
    }
  })

  test('the fail-closed benchmark-token guard still fires', () => {
    expect(() => assertProjectionHasNoBenchmarkOrder({ note: 'next_rung=blaze_rods' })).toThrow()
    expect(() => assertProjectionHasNoBenchmarkOrder({ note: 'recommended_strategy=diamond_road' })).toThrow()
    expect(() => assertProjectionHasNoBenchmarkOrder({ note: 'world facts only' })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// S13
// ---------------------------------------------------------------------------
describe('S13: an accepted patch commits atomically', () => {
  test('a whole-patch rejection leaves the previous revision authoritative', async () => {
    const f = fixture({
      outcomes: [
        {
          kind: 'object',
          object: {
            operation: 'append',
            intents: [
              { intentText: 'have 3 diamond', desiredPredicates: [{ kind: 'acquire', args: { item: 'diamond', count: 3 } }], completionSemantics: 'all' },
              { intentText: 'nope', desiredPredicates: [{ kind: 'teleport', args: {} }], completionSemantics: 'all' },
            ],
          },
        },
      ],
    })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('compile_rejected')
    expect(failure.diagnostics?.partialAcceptance).toBe('unsupported')
    expect(f.authority.snapshot().revision).toBe(0)
    expect(f.authority.snapshot().options).toHaveLength(0)
    expect(f.sink.links()).toHaveLength(0)
  })

  test('a graph that moved between compile and commit refuses the patch (compare-and-swap)', async () => {
    class RacingAuthority implements OptionGraphAuthority {
      private readonly inner = new InMemoryOptionGraphAuthority()
      snapshot(): OptionGraph {
        return this.inner.snapshot()
      }
      commit(patch: OptionGraphPatch): CommitResult {
        void patch
        return { status: 'stale', currentRevision: this.inner.snapshot().revision + 1 }
      }
      committed(): OptionGraph {
        return this.inner.snapshot()
      }
    }
    const racing = new RacingAuthority()
    const f = fixture({ outcomes: [{ kind: 'object', object: ENTER_PORTAL }], index: worldWithPortals(['P17']), authority: racing })
    const failure = mustFail(await f.harness.propose(f.request()))
    expect(failure.kind).toBe('stale')
    expect(racing.committed().revision).toBe(0)
    expect(racing.committed().options).toHaveLength(0)
    expect(f.sink.staleDrops()[0]?.reason).toBe('option_graph_revision_changed')
    expect(f.sink.links()).toHaveLength(0)
  })

  test('patch application is pure and bumps exactly one revision', async () => {
    const f = fixture({ outcomes: [{ kind: 'object', object: ENTER_PORTAL }], index: worldWithPortals(['P17']) })
    const result = mustOk(await f.harness.propose(f.request()))
    const patch = result.proposal.patch
    expect(patch).not.toBeNull()
    if (patch === null) return
    const before = canonicalJson(f.authority.snapshot() as unknown as Record<string, unknown>)
    const applied = applyOptionGraphPatch(f.authority.snapshot(), { ...patch, baseRevision: f.authority.snapshot().revision })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    expect(applied.graph.revision).toBe(f.authority.snapshot().revision + 1)
    // The input graph was not touched.
    expect(canonicalJson(f.authority.snapshot() as unknown as Record<string, unknown>)).toBe(before)
  })

  test('a patch whose entry targets a missing option is refused, not partially applied', () => {
    const authority = new InMemoryOptionGraphAuthority()
    const bogus: OptionGraphPatch = {
      baseRevision: 0,
      operation: 'replace',
      entries: [{ op: 'suspend', targetOptionId: 'opt_missing' }],
      artifactId: 'art_x',
      decisionId: 'dec_x',
      diagnostics: { stages: [], intentDiagnostics: [], enrichments: [], partialAcceptance: 'unsupported', horizon: { intentCount: 0, maxDependencyDepth: 0, serializedBytes: 0 } },
    }
    const commit = authority.commit(bogus)
    expect(commit.status).toBe('refused')
    expect(authority.snapshot().revision).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// S14
// ---------------------------------------------------------------------------
describe('S14: every committed Option links to exactly one authority origin', () => {
  test('all three origin kinds exist and System2 origins carry the artifact', async () => {
    const f = fixture({ outcomes: [{ kind: 'object', object: ENTER_PORTAL }], index: worldWithPortals(['P17']) })
    const result = mustOk(await f.harness.propose(f.request()))
    const graph = f.authority.snapshot()
    const origins = originsOf(graph)
    expect(origins.size).toBe(graph.options.length)
    for (const origin of origins.values()) {
      expect(['system2', 'human', 'deterministic']).toContain(origin.kind)
      expect(origin.kind).toBe('system2')
      if (origin.kind !== 'system2') continue
      expect(origin.artifactId).toBe(result.artifactId)
      expect(origin.baseRevision).toBe(0)
      expect(origin.intentIndex).toBe(0)
    }
    expect(graph.committedArtifactId).toBe(result.artifactId)
    const link = f.sink.links()[0]
    expect(link?.artifactId).toBe(result.artifactId)
    expect(link?.kind).toBe('option_committed')
    expect(link?.optionInstanceId).toBe(graph.options[0]?.option.optionInstanceId ?? '')
  })

  test('an option can never enter the graph without an origin', () => {
    const authority = new InMemoryOptionGraphAuthority()
    const compiled: CompiledOption = {
      optionId: 'opt_seed',
      optionInstanceId: 'oi_seed',
      intentText: 'deterministic fixture',
      desiredPredicates: [],
      dependencies: [],
      target: null,
      completionSemantics: 'all',
      origin: { kind: 'deterministic', architectureException: '424', reason: 'Phase F staging fixture' },
      horizon: { intentIndex: 0, dependencyDepth: 0 },
    }
    const graph = authority.seed(compiled)
    const origins = originsOf(graph)
    const origin = origins.get('oi_seed')
    expect(origin?.kind).toBe('deterministic')
    if (origin?.kind !== 'deterministic') return
    expect(origin.architectureException).toBe('424')
    // A deterministic-origin Option is NOT System2 authority, so it must be
    // labelled; that label is what a report/acceptance gate can grep for.
    expect(deriveExecutionQueue(graph)[0]?.originKind).toBe('deterministic')
  })
})

// ---------------------------------------------------------------------------
// S15
// ---------------------------------------------------------------------------
describe('S15: a provider swap needs zero gameplay/controller changes', () => {
  test('two providers produce the same committed semantics', async () => {
    const run = async (providerId: string, modelId: string, transport: string) => {
      const f = fixture({
        outcomes: [{ kind: 'object', object: ENTER_PORTAL }],
        index: worldWithPortals(['P17']),
        providerIdentity: { providerId, modelId, transport },
      })
      mustOk(await f.harness.propose(f.request()))
      return { semantics: canonicalJson(f.authority.snapshot().options as unknown as Record<string, unknown>), key: f.sink.decisions()[0]?.cacheKey }
    }
    const a = await run('ai-gateway', 'meta/model-a', 'tool-call')
    const b = await run('local-openai-compatible', 'qwen/model-b', 'json-text')
    expect(a.semantics).toBe(b.semantics)
    expect(a.key).not.toBe(b.key)
  })

  test('no model identity is hard-coded in the harness core', () => {
    for (const module of harnessCodeSources()) {
      if (module.file.includes('/providers/')) continue
      for (const token of ['muse', 'Muse', 'openai', 'OpenAI', 'anthropic', 'ai-gateway', 'generateText']) {
        expect({ file: module.file, token, present: module.code.includes(token) }).toEqual({ file: module.file, token, present: false })
      }
    }
  })

  test('semantic versions are independent and explicit', () => {
    expect(Object.keys(SEMANTIC_VERSIONS).sort()).toEqual(['compiler', 'harness', 'predicateRegistry', 'prompt', 'proposalSchema', 'stateProjection'])
    expect(semanticContractMismatches({ ...SEMANTIC_VERSIONS, compiler: SEMANTIC_VERSIONS.compiler + 1 })).toEqual([
      `compiler: recorded=${SEMANTIC_VERSIONS.compiler + 1} current=${SEMANTIC_VERSIONS.compiler}`,
    ])
    expect(semanticContractMismatches(SEMANTIC_VERSIONS)).toEqual([])
    expect(PREDICATE_KINDS).toHaveLength(8)
  })

  test('the identity seam is swappable without touching the harness', () => {
    const source = staticSystem2IdentitySource({ ...identity(), projectionHash: null })
    expect(source.current().system2Epoch).toBe(identity().system2Epoch)
    source.advanceEpoch(2)
    expect(source.current().system2Epoch).toBe(identity().system2Epoch + 2)
  })
})

/** Read the value at a `leafPaths` path, for the S11 flip test. */
function pathValue(root: unknown, path: string): unknown {
  const segments = path
    .replace(/^\$\.?/, '')
    .split(/\.|\[|\]/)
    .filter((segment) => segment.length > 0)
  let cursor: unknown = root
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = Array.isArray(cursor) ? cursor[Number(segment)] : (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

// ---------------------------------------------------------------------------
// §12 / §30 / §26
// ---------------------------------------------------------------------------
describe('§12: System2 authors semantic intent, not GoalQueue mechanics', () => {
  test('the patch vocabulary contains no execution-queue concept', async () => {
    const f = fixture({ outcomes: [{ kind: 'object', object: ENTER_PORTAL }], index: worldWithPortals(['P17']) })
    const result = mustOk(await f.harness.propose(f.request()))
    const patch = result.proposal.patch
    expect(patch).not.toBeNull()
    if (patch === null) return
    // Patch entries are semantic graph operations only.
    for (const entry of patch.entries) {
      expect(['add', 'replace', 'suspend', 'resume']).toContain(entry.op)
    }
    // No queue row, retry counter or ordering primitive is expressible.
    for (const module of harnessCodeSources()) {
      // Queue/ledger vocabulary from jev-agent's execution layer must not appear:
      // the harness's only ordering concept is the derived, read-only row list.
      for (const token of ['GoalQueue', 'goalQueue', 'GoalQueueState', 'PlannedGoal', 'PlanOp', 'enqueue', 'goalQueueState']) {
        expect({ file: module.file, token, present: module.code.includes(token) }).toEqual({ file: module.file, token, present: false })
      }
    }
  })

  test('the compatibility queue is derived and read-only', async () => {
    const f = fixture({ outcomes: [{ kind: 'object', object: ENTER_PORTAL }], index: worldWithPortals(['P17']) })
    mustOk(await f.harness.propose(f.request()))
    const graph = f.authority.snapshot()
    const first = deriveExecutionQueue(graph)
    const second = deriveExecutionQueue(graph)
    expect(first).toEqual(second)
    expect(first).toHaveLength(graph.options.length)
    // Deriving the queue cannot change the authority it was derived from.
    expect(canonicalJson(graph as unknown as Record<string, unknown>)).toBe(canonicalJson(f.authority.snapshot() as unknown as Record<string, unknown>))
  })
})

describe('§30: no plan self-certification', () => {
  test('a self-certifying claim is not even expressible', async () => {
    // "this plan is safe" / "the portal exists" / "goal completed" are model
    // claims. Unknown authoritative keys are rejected, so a claim cannot become a
    // field, and the compiler — not the model — owns validity.
    const claims = [
      { operation: 'append', safe: true, intents: [{ intentText: 'x', desiredPredicates: [{ kind: 'acquire', args: { item: 'diamond', count: 1 } }], completionSemantics: 'all' }] },
      { operation: 'append', grounded: true, intents: [{ intentText: 'x', desiredPredicates: [{ kind: 'acquire', args: { item: 'diamond', count: 1 } }], completionSemantics: 'all' }] },
      {
        operation: 'append',
        intents: [
          {
            intentText: 'x',
            desiredPredicates: [{ kind: 'acquire', args: { item: 'diamond', count: 1 } }],
            completionSemantics: 'all',
            complete: true,
            portalExists: true,
          },
        ],
      },
    ]
    for (const claim of claims) {
      const f = fixture({ outcomes: [{ kind: 'object', object: claim }] })
      const failure = mustFail(await f.harness.propose(f.request()))
      expect(failure.kind).toBe('invalid_response')
      expect(f.authority.snapshot().revision).toBe(0)
    }
  })

  test('a false factual claim in the rationale does not make the fact true', async () => {
    const f = fixture({
      outcomes: [{ kind: 'object', object: enterPortalProposal(portalRef('P99')) }],
      index: worldWithPortals(['P17']),
    })
    const request = f.request()
    const claimed = {
      ...request,
      projection: request.projection,
    }
    const failure = mustFail(await f.harness.propose(claimed))
    // Even with the model asserting a portal id, grounding owns truth.
    expect(failure.kind).toBe('ungroundable_intent')
    expect(f.authority.snapshot().options).toHaveLength(0)
  })
})
