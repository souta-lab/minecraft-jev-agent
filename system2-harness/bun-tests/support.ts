// system2-harness/bun-tests/support.ts - shared fixture builders for the
// #439 section 31 (S1-S15) invariants and the section 32 regression fixtures.
//
// Everything here is plain data plus the harness's own factories: there is no
// test-only shortcut into the compiler, cache or authority. If a fixture can
// bypass a fence, the fence is not real, so the helpers deliberately go through
// `createSystem2Harness` / `System2Harness.propose` like production does.

import type {
  GroundedRef,
  ProtectedIntent,
  System2HarnessResult,
  System2Ok,
  System2Proposal,
  System2Request,
  System2RequestIdentity,
} from '../contract.ts'
import type { System2HarnessInternal, System2HarnessOptions } from '../harness.ts'
import { createSystem2Harness } from '../harness.ts'
import type { GroundedWorldIndex } from '../grounding.ts'
import { emptyWorldIndex } from '../grounding.ts'
import { StaticSystem2IdentitySource } from '../epochs.ts'
import type { System2LiveIdentity } from '../epochs.ts'
import type { OptionGraphAuthority } from '../optionGraph.ts'
import { InMemoryOptionGraphAuthority } from '../optionGraph.ts'
import type { ScriptedOutcome, ScriptedProviderHooks } from '../provider.ts'
import { ScriptedSystem2Provider } from '../provider.ts'
import { MemorySystem2ArtifactSink } from '../artifacts.ts'
import { System2ProposalCache } from '../cache.ts'
import type { System2ProjectionInput } from '../stateProjection.ts'
import { buildSystem2Projection } from '../stateProjection.ts'
import type { TruthIndex } from '../predicateRegistry.ts'
import { EMPTY_TRUTH_INDEX, createTruthIndex } from '../predicateRegistry.ts'
import type { ProviderIdentity } from '../versions.ts'
import type { SemanticWakeEvent } from '../wakeReasons.ts'
import { wakeFromEvent } from '../wakeReasons.ts'

export const TEST_RUN_ID = 'run_2026_09_22_system2'
export const TEST_SOURCE_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
export const TEST_PROVIDER: ProviderIdentity = Object.freeze({
  providerId: 'scripted',
  modelId: 'test/model-a',
  transport: 'tool-call',
})

export function identity(overrides: Partial<System2RequestIdentity> = {}): System2RequestIdentity {
  return {
    system2Epoch: 7,
    missionId: 'm2-nether-gate',
    optionGraphRevision: 0,
    activeOptionInstanceId: null,
    worldKey: 'local:overworld',
    worldEpoch: 3,
    generationId: 'gen-1',
    humanIntentRevision: 0,
    ...overrides,
  }
}

export function liveIdentity(id: System2RequestIdentity, projectionHash: string | null = null): System2LiveIdentity {
  return { ...id, projectionHash }
}

export function missionStartWake(missionId = 'm2-nether-gate'): ReturnType<typeof wakeFromEvent> {
  return wakeFromEvent({ kind: 'mission_start', missionId, missionText: 'build and enter a nether portal' })
}

export interface ProjectionOverrides {
  readonly mission?: Partial<System2ProjectionInput['mission']>
  readonly world?: Partial<System2ProjectionInput['world']>
  readonly wake?: SemanticWakeEvent | ReturnType<typeof wakeFromEvent>
  readonly optionGraph?: System2ProjectionInput['optionGraph']
  readonly currentOptionInstanceId?: string | null
  readonly verifiedPredicates?: System2ProjectionInput['verifiedPredicates']
  readonly unmetDependencies?: System2ProjectionInput['unmetDependencies']
  readonly knownCapabilities?: System2ProjectionInput['knownCapabilities']
  readonly resources?: System2ProjectionInput['resources']
  readonly recentSemanticOutcomes?: System2ProjectionInput['recentSemanticOutcomes']
  readonly failureEvidence?: System2ProjectionInput['failureEvidence']
  readonly progress?: Partial<System2ProjectionInput['progress']>
  readonly benchmarkOrder?: readonly string[]
  readonly notes?: readonly string[]
}

export function projectionInput(overrides: ProjectionOverrides = {}): System2ProjectionInput {
  const wakeInput = overrides.wake ?? missionStartWake()
  const wake = 'detail' in wakeInput && 'reason' in wakeInput ? wakeInput : wakeFromEvent(wakeInput as SemanticWakeEvent)
  return {
    mission: {
      missionId: 'm2-nether-gate',
      missionText: 'build and enter a nether portal',
      humanIntentRevision: 0,
      protectedIntent: null,
      ...(overrides.mission ?? {}),
    },
    optionGraph: overrides.optionGraph ?? { revision: 0, options: [], committedArtifactId: null },
    currentOptionInstanceId: overrides.currentOptionInstanceId ?? null,
    verifiedPredicates: overrides.verifiedPredicates ?? [],
    unmetDependencies: overrides.unmetDependencies ?? [],
    knownCapabilities: overrides.knownCapabilities ?? [],
    world: {
      worldKey: 'local:overworld',
      dimension: 'overworld',
      epoch: 3,
      facts: [],
      ...(overrides.world ?? {}),
    },
    resources: overrides.resources ?? [],
    recentSemanticOutcomes: overrides.recentSemanticOutcomes ?? [],
    failureEvidence: overrides.failureEvidence ?? [],
    progress: {
      missionProgress: 'partial',
      currentOptionProgress: 'unknown',
      verifiedPredicateCount: 0,
      unmetDependencyCount: 0,
      ...(overrides.progress ?? {}),
    },
    wake,
    ...(overrides.benchmarkOrder !== undefined ? { benchmarkOrder: overrides.benchmarkOrder } : {}),
    ...(overrides.notes !== undefined ? { notes: overrides.notes } : {}),
  }
}

export interface FixtureOptions {
  readonly outcomes: readonly ScriptedOutcome[]
  readonly index?: GroundedWorldIndex
  readonly truth?: TruthIndex
  readonly requestIdentity?: Partial<System2RequestIdentity>
  readonly projection?: ProjectionOverrides
  readonly protectedIntent?: ProtectedIntent | null
  readonly knownDeficits?: readonly string[]
  readonly knownCapabilities?: readonly string[]
  readonly maxTransportAttempts?: number
  readonly cache?: System2ProposalCache | null
  readonly providerIdentity?: ProviderIdentity
  readonly hooks?: ScriptedProviderHooks
  /** Swap the HOST-owned commit boundary (used by the S13 compare-and-swap test). */
  readonly authority?: OptionGraphAuthority
}

export interface RequestOverrides {
  readonly identity?: Partial<System2RequestIdentity>
  readonly projection?: ProjectionOverrides
  readonly protectedIntent?: ProtectedIntent | null
  readonly stage?: string
}

export interface Fixture {
  readonly provider: ScriptedSystem2Provider
  readonly authority: OptionGraphAuthority
  readonly identitySource: StaticSystem2IdentitySource
  readonly sink: MemorySystem2ArtifactSink
  readonly cache: System2ProposalCache | null
  readonly harness: System2HarnessInternal
  readonly index: GroundedWorldIndex
  readonly requestIdentity: System2RequestIdentity
  request(overrides?: RequestOverrides): System2Request
  /** The live identity a request is currently bound to (read from the source). */
  live(): System2LiveIdentity
  /**
   * Re-align the live identity with the authority's revision. Needed only when a
   * test seeds the graph out of band (a real HOST bumps its own epoch when it
   * commits, so the generation and the authority never disagree).
   */
  syncRevision(): void
}

export function fixture(options: FixtureOptions): Fixture {
  const authority: OptionGraphAuthority = options.authority ?? new InMemoryOptionGraphAuthority()
  const baseIdentity = identity({ ...(options.requestIdentity ?? {}), optionGraphRevision: authority.snapshot().revision })
  const identitySource = new StaticSystem2IdentitySource(liveIdentity(baseIdentity))
  const provider = new ScriptedSystem2Provider(options.providerIdentity ?? TEST_PROVIDER, options.outcomes, options.hooks ?? {})
  const sink = new MemorySystem2ArtifactSink()
  const cache = options.cache === undefined ? new System2ProposalCache() : options.cache
  const index = options.index ?? emptyWorldIndex(baseIdentity.worldKey, 'overworld', baseIdentity.worldEpoch)
  const harnessOptions: System2HarnessOptions = {
    provider,
    authority,
    identity: identitySource,
    artifacts: sink,
    runId: TEST_RUN_ID,
    sourceSha: TEST_SOURCE_SHA,
    dirtyTree: false,
    index,
    truth: options.truth ?? EMPTY_TRUTH_INDEX,
    ...(options.knownDeficits !== undefined ? { knownDeficits: options.knownDeficits } : {}),
    ...(options.knownCapabilities !== undefined ? { knownCapabilities: options.knownCapabilities } : {}),
    cache,
    ...(options.maxTransportAttempts !== undefined ? { maxTransportAttempts: options.maxTransportAttempts } : {}),
    now: () => '2026-09-22T00:00:00.000Z',
  }
  const harness = createSystem2Harness(harnessOptions)

  const request = (overrides: RequestOverrides = {}): System2Request => {
    const requestIdentity: System2RequestIdentity = {
      ...identitySource.current(),
      optionGraphRevision: authority.snapshot().revision,
      ...(overrides.identity ?? {}),
    }
    const projection = buildSystem2Projection(
      projectionInput({
        ...(options.projection ?? {}),
        ...(overrides.projection ?? {}),
        optionGraph: (overrides.projection?.optionGraph ?? options.projection?.optionGraph) ?? authority.snapshot(),
        mission: {
          missionId: requestIdentity.missionId,
          humanIntentRevision: requestIdentity.humanIntentRevision,
          ...((options.projection?.mission ?? {}) as object),
          ...((overrides.projection?.mission ?? {}) as object),
        },
      }),
    )
    const protectedIntent = overrides.protectedIntent ?? options.protectedIntent ?? null
    return {
      identity: requestIdentity,
      projection,
      ...(protectedIntent !== null ? { protectedIntent } : {}),
      ...(overrides.stage !== undefined ? { stage: overrides.stage } : {}),
    }
  }

  return {
    provider,
    authority,
    identitySource,
    sink,
    cache,
    harness,
    index,
    requestIdentity: baseIdentity,
    request,
    live: () => identitySource.current(),
    syncRevision: () => identitySource.setOptionGraphRevision(authority.snapshot().revision),
  }
}

// ---------------------------------------------------------------------------
// result helpers
// ---------------------------------------------------------------------------

export function mustOk(result: System2HarnessResult): System2Ok {
  if (!result.ok) {
    throw new Error(`expected ok result, got ${result.kind}: ${String(result.detail)}`)
  }
  return result
}

export function mustFail(result: System2HarnessResult): Extract<System2HarnessResult, { ok: false }> {
  if (result.ok) {
    throw new Error(`expected a typed failure, got ok with artifact ${result.artifactId}`)
  }
  return result
}

// ---------------------------------------------------------------------------
// proposal builders (generic vocabulary only: no benchmark strategy names)
// ---------------------------------------------------------------------------

/** The generic form of "go through the portal that already exists". */
export function enterPortalProposal(targetRef?: GroundedRef): System2Proposal {
  return {
    operation: 'replace',
    rationale: 'The verified portal already exists; the next objective is to enter it rather than rebuild it.',
    intents: [
      {
        intentText: 'enter the verified nether portal',
        desiredPredicates: [
          {
            kind: 'interact',
            args: { operation: 'enter', ...(targetRef !== undefined ? { target: targetRef } : {}) },
          },
        ],
        ...(targetRef !== undefined ? { targetRef } : {}),
        completionSemantics: 'all',
      },
    ],
  }
}

export function acquireProposal(item: string, count: number, operation: System2Proposal['operation'] = 'append'): System2Proposal {
  return {
    operation,
    rationale: `acquire ${count} ${item}`,
    intents: [
      {
        intentText: `have at least ${count} ${item}`,
        desiredPredicates: [{ kind: 'acquire', args: { item, count } }],
        completionSemantics: 'all',
      },
    ],
  }
}

/** A portal ref that exists in world memory and is code-verified. */
export function portalRef(refId: string): GroundedRef {
  return { kind: 'grounded', refKind: 'portal_site', refId }
}

/** A world index containing verified portal sites (ids are code-owned). */
export function worldWithPortals(
  refIds: readonly string[],
  overrides: Partial<GroundedWorldIndex> = {},
): GroundedWorldIndex {
  return {
    ...emptyWorldIndex(),
    ...overrides,
    portalSites: refIds.map((refId) => ({ refId, verified: true, dimension: 'overworld', frameBlocks: 10 })),
  }
}

export function truthWithFurnace(): TruthIndex {
  return createTruthIndex({
    knownItems: ['iron_ingot', 'raw_iron', 'furnace', 'diamond', 'ender_pearl', 'blaze_rod', 'ender_eye'],
    itemTruth: [
      { item: 'iron_ingot', requiresStation: 'furnace', components: [{ item: 'raw_iron', count: 1 }] },
      { item: 'ender_eye', components: [{ item: 'ender_pearl', count: 1 }, { item: 'blaze_rod', count: 1 }] },
    ],
  })
}
