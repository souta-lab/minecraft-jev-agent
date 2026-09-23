// I2 - every production call references a registered, versioned head (#438 section 4/22).
//
// Also the executable migration map: each head points at the production symbol
// that asks the question today, and the registry must cover exactly the five
// Phase A call sites. A prompt/line change cannot silently break this test
// (symbols, not line numbers, are the anchors).

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  JEV_HEADS,
  HEAD_REGISTRY_VERSION,
  activeHeads,
  headsInBatchGroup,
  lookupHead,
  registeredHeadIds,
  validateHeadRegistry,
} from '../heads.ts'
import { FIREWALL_DEBT } from '../tools/firewall.ts'
import { HarnessConfigurationError } from '../harness.ts'
import { createJevHarness } from '../harness.ts'
import { counterIds, fixture, piRequestFor } from './support.ts'
import { scriptedProvider, choiceAnswer, testProjection, baseIdentity } from '../testing.ts'
import { staticIdentitySource } from '../identity.ts'
import { MemoryArtifactSink } from '../artifacts.ts'
import { toCausalIdentity } from '../identity.ts'

const ROOT = resolve(import.meta.dir, '..', '..')

describe('#438 section 4 - versioned head registry', () => {
  test('the shipped registry is structurally valid', () => {
    expect(() => validateHeadRegistry(JEV_HEADS)).not.toThrow()
    expect(HEAD_REGISTRY_VERSION).toBeGreaterThanOrEqual(1)
  })

  test('head ids are unique and versioned', () => {
    const ids = registeredHeadIds()
    expect(new Set(ids).size).toBe(ids.length)
    for (const head of JEV_HEADS) {
      expect(head.version).toBeGreaterThanOrEqual(1)
      expect(head.id.length).toBeGreaterThan(0)
    }
  })

  test('every head documents its result contract; live heads also document consumers', () => {
    for (const head of JEV_HEADS) {
      expect(head.semanticQuestion.length).toBeGreaterThan(10)
      expect(head.stateProjection.length).toBeGreaterThan(0)
      expect(head.resultSchema.length).toBeGreaterThan(0)
      expect(head.calibration.transformId.length).toBeGreaterThan(0)
      expect(head.calibration.transformVersion).toBeGreaterThanOrEqual(1)
      expect(['production', 'shadow', 'diagnostic']).toContain(head.status)
      if (!head.deprecated) expect(head.allowedConsumers.length).toBeGreaterThan(0)
      expect(typeof head.deprecated).toBe('boolean')
    }
  })

  test('the registry covers exactly the Phase A call sites (no head nobody asks for)', () => {
    const files = new Set(JEV_HEADS.flatMap((head) => head.sourceRefs.map((ref) => ref.file)))
    expect([...files].sort()).toEqual([...FIREWALL_DEBT.map((entry) => entry.file)].sort())
  })

  test('every source ref points at a real file that still contains the owning symbol', () => {
    for (const head of JEV_HEADS) {
      for (const ref of [...head.sourceRefs, ...(head.legacyPromptRef === undefined ? [] : [head.legacyPromptRef])]) {
        const path = resolve(ROOT, ref.file)
        expect(existsSync(path)).toBe(true)
        const source = readFileSync(path, 'utf8')
        expect(source).toContain(ref.symbol)
      }
    }
  })

  test('retired heads without a current caller remain resolvable but cannot appear active', () => {
    const retired = lookupHead('system2_horizon_v2')
    expect(retired?.deprecated).toBe(true)
    expect(retired?.sourceRefs).toEqual([])
    expect(retired?.allowedConsumers).toEqual([])
    expect(retired?.legacyPromptRef).toBeUndefined()
    expect(activeHeads().some((head) => head.id === 'system2_horizon_v2')).toBe(false)
  })

  test('the batched jev-authority call is describable as one batch group with per-head primitives', () => {
    const group = headsInBatchGroup('jev_authority')
    expect(group.map((head) => head.id).sort()).toEqual(['beta_terminate_v2', 'danger_v1', 'pi_action_v3', 'retreat_v1'])
    expect(group.map((head) => head.primitive).sort()).toEqual(['boolean', 'boolean', 'choice', 'score'])
  })

  test('the legacy planner batch group is describable too', () => {
    expect(headsInBatchGroup('system2_legacy').map((head) => head.id).sort()).toEqual([
      'system2_horizon_v1',
      'system2_plan_fit_v1',
      'system2_strategy_change_v1',
    ])
  })

  test('advisor strategies are a declared closed set (no invention possible)', () => {
    const advisor = lookupHead('advisor_strategy_v1')
    expect(advisor?.candidateSource).toBe('declared')
    expect(advisor?.declaredCandidates?.map((entry) => entry.id)).toEqual([
      'descend_to_y16',
      'explore_cave',
      'branch_mine',
      'return_to_known_ore',
      'smelt_and_craft',
    ])
  })

  test('score heads declare an ordered scale whose max is levels.length - 1', () => {
    for (const head of JEV_HEADS.filter((entry) => entry.primitive === 'score')) {
      expect(head.scale).toBeDefined()
      expect(head.scale?.max).toBe((head.scale?.levels.length ?? 0) - 1)
    }
  })

  test('deprecated legacy heads stay registered so old artifacts still resolve', () => {
    const deprecated = JEV_HEADS.filter((head) => head.deprecated).map((head) => head.id)
    expect(deprecated).toContain('pi_action_legacy_v1')
    expect(deprecated).toContain('system2_horizon_v1')
    expect(activeHeads().some((head) => head.id === 'pi_action_v3')).toBe(true)
  })
})

describe('#438 section 22 I2 - unregistered head cannot execute', () => {
  test('an unregistered head fails closed with a typed failure and never calls the provider', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: {} })
    const f = fixture({ provider })
    const result = await f.harness.choose(piRequestFor({ headId: 'pi_action_v99' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('unregistered_head')
    expect(result.modelAnswerPresent).toBe(false)
    expect(provider.dispatches.length).toBe(0)
    expect(f.sink.artifacts().length).toBe(1)
    expect(f.sink.artifacts()[0]?.result.ok).toBe(false)
  })

  test('a request whose head primitive does not match the entry point is rejected', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: {} })
    const f = fixture({ provider })
    const result = await f.harness.choose(piRequestFor({ headId: 'beta_terminate_v2' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('invalid_request')
    expect(provider.dispatches.length).toBe(0)
  })

  test('a request using the wrong projection version is rejected (per-head projection contract)', async () => {
    const provider = scriptedProvider({ kind: 'answer', answers: {} })
    const f = fixture({ provider })
    const result = await f.harness.choose(
      piRequestFor({ projection: testProjection({ tick: 1 }, 'some_other_projection_v1', 1) }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('invalid_request')
    expect(provider.dispatches.length).toBe(0)
  })

  test('the harness refuses a registry whose head references an experimental calibration transform', () => {
    const heads = JEV_HEADS.map((head) =>
      head.id === 'beta_terminate_v2'
        ? { ...head, calibration: { transformId: 'beta_threshold_v2', transformVersion: 2 } }
        : head,
    )
    expect(() =>
      createJevHarness({
        provider: scriptedProvider({ kind: 'answer', answers: {} }),
        identity: staticIdentitySource(toCausalIdentity(baseIdentity())),
        run: { runId: 'r', sourceSha: 's', dirtyTree: false },
        artifacts: new MemoryArtifactSink(),
        heads,
        idFactory: counterIds(),
      }),
    ).toThrow(HarnessConfigurationError)
  })
})
