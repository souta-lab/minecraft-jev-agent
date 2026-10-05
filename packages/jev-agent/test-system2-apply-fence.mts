import assert from 'node:assert/strict'
import { describe, it } from 'bun:test'
import { evaluateSystem2Apply } from './src/system2/authority.ts'
import type { PlanWorldFactsBasis, System2ApplyState, System2RequestContext } from './src/system2/authority.ts'
import { planWorldFactsBasis } from './src/system2-plane.ts'
import { MIRRORED_MARKERS, mirroredEventToken } from './src/controller.ts'
import type { PlannedGoal } from './src/goalQueue.ts'

function resource(name: string, x = 0, y = 0, z = 0) {
  return { kind: 'ore', name, at: [x, y, z], dimension: 'minecraft:overworld', worldEpoch: 3 }
}

function worldFacts(
  resources: ReadonlyArray<ReturnType<typeof resource>>,
  stations: ReadonlyArray<readonly number[]> = [],
  furnaces: ReadonlyArray<readonly number[]> = [],
): string {
  return JSON.stringify({ resources, stations, furnaces })
}

function requestContext(worldFactsFingerprint: string): System2RequestContext {
  return {
    requestId: 'req-1',
    queueRevision: 7,
    optionInstanceId: null,
    optionTemplateId: null,
    worldEpoch: 3,
    stateFingerprint: 'fp',
    worldFactsFingerprint,
    authorityEpoch: 11,
  }
}

function applyState(overrides: Partial<System2ApplyState> = {}): System2ApplyState {
  return {
    queueRevision: 7,
    optionInstanceId: null,
    optionTemplateId: null,
    worldEpoch: 3,
    stateFingerprint: 'fp',
    worldFactsFingerprint: overrides.worldFactsFingerprint ?? '',
    authorityEpoch: 11,
    actionInFlight: false,
    ...overrides,
  }
}

function goal(kind: PlannedGoal['kind'], targetItem: string | null): PlannedGoal {
  return { kind, description: `${kind}:${targetItem ?? 'none'}`, targetItem }
}

describe('System2 apply fence — plan-scoped world-facts basis', () => {
  it('computes the plan basis: collect names item + scanned sources; smelt names the furnace only', () => {
    const collect = planWorldFactsBasis([goal('collect', 'coal')])
    assert.equal(collect.logLike, false)
    assert.ok(collect.names.has('coal'))
    assert.ok(collect.names.has('coal_ore'))
    assert.ok(collect.names.has('deepslate_coal_ore'))

    const smelt = planWorldFactsBasis([goal('smelt', 'iron_ingot')])
    assert.equal(smelt.logLike, false)
    assert.ok(smelt.names.has('iron_ingot'))
    assert.ok(smelt.names.has('furnace'))
    // Fuel is held-supply (inventory-fenced), not a world-facts reference: a
    // smelt plan must survive the body mining remembered coal cells.
    assert.equal(smelt.names.has('coal_ore'), false)

    const craft = planWorldFactsBasis([goal('craft', 'furnace')])
    assert.equal(craft.logLike, false)
    assert.ok(craft.names.has('crafting_table'))

    const explore = planWorldFactsBasis([goal('explore', null)])
    assert.equal(explore.names.size, 0)
    assert.equal(explore.logLike, false)
  })

  it('applies when only unreferenced resources churn (over-harvest of unnamed cells)', () => {
    // The live p24 loop: smelt/furnace goals while `opt=none` digs falsify
    // remembered stone/gravel/coal cells the plan never named - the smelt
    // fuel premise is held coal (inventory-fenced), not remembered coal_ore.
    const request = worldFacts([resource('coal_ore', 10, 70, -26), resource('stone', 11, 70, -26), resource('gravel', 12, 70, -26)])
    const current = worldFacts([resource('coal_ore', 10, 70, -26)])
    const basis = planWorldFactsBasis([goal('smelt', 'iron_ingot'), goal('place', 'furnace')])
    const decision = evaluateSystem2Apply(requestContext(request), applyState({ worldFactsFingerprint: current }), basis)
    assert.ok(decision.apply, `expected apply, got reasons=${decision.reasons}`)

    // And the same verdict when the harvested seam itself is gone: the smelt
    // plan named the furnace, not the coal cells.
    const depleted = evaluateSystem2Apply(requestContext(request), applyState({ worldFactsFingerprint: worldFacts([]) }), basis)
    assert.ok(depleted.apply, `expected apply, got reasons=${depleted.reasons}`)
  })

  it('discards when a referenced resource is lost (collect:coal loses its coal_ore)', () => {
    const request = worldFacts([resource('coal_ore', 10, 70, -26), resource('stone', 11, 70, -26)])
    const current = worldFacts([resource('stone', 11, 70, -26)])
    const basis = planWorldFactsBasis([goal('collect', 'coal')])
    const decision = evaluateSystem2Apply(requestContext(request), applyState({ worldFactsFingerprint: current }), basis)
    assert.equal(decision.apply, false)
    assert.ok(decision.reasons.includes('world_facts_changed'))
  })

  it('does not discard on newly-remembered resources (added supply cannot break a premise)', () => {
    const request = worldFacts([resource('coal_ore', 10, 70, -26)])
    const current = worldFacts([resource('coal_ore', 10, 70, -26), resource('iron_ore', 30, 12, 5)])
    const basis = planWorldFactsBasis([goal('collect', 'iron_ingot')])
    const decision = evaluateSystem2Apply(requestContext(request), applyState({ worldFactsFingerprint: current }), basis)
    assert.ok(decision.apply, `expected apply, got reasons=${decision.reasons}`)
  })

  it('discards a referenced station loss: craft needs crafting_table, smelt needs furnace', () => {
    const request = worldFacts([], [[5, 80, -21]], [[19, 60, -21]])
    const craftBasis = planWorldFactsBasis([goal('craft', 'stone_pickaxe')])
    const craftDecision = evaluateSystem2Apply(
      requestContext(request),
      applyState({ worldFactsFingerprint: worldFacts([], [], [[19, 60, -21]]) }),
      craftBasis,
    )
    assert.equal(craftDecision.apply, false)
    assert.ok(craftDecision.reasons.includes('world_facts_changed'))

    const smeltBasis = planWorldFactsBasis([goal('smelt', 'iron_ingot')])
    const smeltDecision = evaluateSystem2Apply(
      requestContext(request),
      applyState({ worldFactsFingerprint: worldFacts([], [[5, 80, -21]], []) }),
      smeltBasis,
    )
    assert.equal(smeltDecision.apply, false)
    assert.ok(smeltDecision.reasons.includes('world_facts_changed'))
  })

  it('ignores an unreferenced station loss (smelt plan does not name crafting_table)', () => {
    const request = worldFacts([resource('coal_ore', 10, 70, -26)], [[5, 80, -21]], [[19, 60, -21]])
    const current = worldFacts([resource('coal_ore', 10, 70, -26)], [], [[19, 60, -21]])
    const basis = planWorldFactsBasis([goal('smelt', 'iron_ingot')])
    const decision = evaluateSystem2Apply(requestContext(request), applyState({ worldFactsFingerprint: current }), basis)
    assert.ok(decision.apply, `expected apply, got reasons=${decision.reasons}`)
  })

  it('treats the *_log family as a named source for log-kind collect/goto goals only', () => {
    const request = worldFacts([resource('spruce_log', 3, 90, 8)])
    const collectLog = planWorldFactsBasis([goal('collect', 'log')])
    const discarded = evaluateSystem2Apply(
      requestContext(request),
      applyState({ worldFactsFingerprint: worldFacts([]) }),
      collectLog,
    )
    assert.equal(discarded.apply, false)
    assert.ok(discarded.reasons.includes('world_facts_changed'))

    const stoneCraft = planWorldFactsBasis([goal('craft', 'cobblestone')])
    const applied = evaluateSystem2Apply(
      requestContext(request),
      applyState({ worldFactsFingerprint: worldFacts([]) }),
      stoneCraft,
    )
    assert.ok(applied.apply, `expected apply, got reasons=${applied.reasons}`)
  })

  it('keeps the strict legacy verdict when no plan basis is supplied', () => {
    const request = worldFacts([resource('coal_ore', 10, 70, -26)])
    const current = worldFacts([resource('coal_ore', 10, 70, -26), resource('dirt', 9, 70, -26)])
    const decision = evaluateSystem2Apply(requestContext(request), applyState({ worldFactsFingerprint: current }))
    assert.equal(decision.apply, false)
    assert.ok(decision.reasons.includes('world_facts_changed'))
  })

  it('falls back to the conservative verdict on an unparsable current fingerprint', () => {
    const request = worldFacts([resource('coal_ore', 10, 70, -26)])
    const basis: PlanWorldFactsBasis = { names: new Set(['coal_ore']), logLike: false }
    const decision = evaluateSystem2Apply(requestContext(request), applyState({ worldFactsFingerprint: '{broken' }), basis)
    assert.equal(decision.apply, false)
    assert.ok(decision.reasons.includes('world_facts_changed'))
  })
})

describe('System2 apply fence — evidence-plane parity', () => {
  // A fenced-out answer mutates no queue row: without the discard markers in the
  // mirrored set, buddy.log shows `DECISION -> <nothing>` and a correct
  // fail-closed discard is indistinguishable from a dropped apply (measured
  // 2026-10-05, requestIds 594df569/cb949dbb discarded on inventory/objective
  // churn while run.jsonl alone carried the reasons).
  const REFUSED_MARKERS = [
    'SYSTEM2_PLAN_DISCARDED',
    'SYSTEM2_STALE_DISCARD',
    'SYSTEM2_REQUEST_CANCELLED',
  ] as const

  it('every apply-fence refusal marker is mirrored into the live plane', () => {
    for (const marker of REFUSED_MARKERS) {
      assert.ok(MIRRORED_MARKERS.has(marker), `${marker} is not in MIRRORED_MARKERS`)
    }
  })

  it('refusal markers resolve from their emitted line prefixes', () => {
    assert.equal(
      mirroredEventToken('SYSTEM2_PLAN_DISCARDED request=req-1 reasons=inventory_changed,action_in_flight'),
      'SYSTEM2_PLAN_DISCARDED',
    )
    assert.equal(
      mirroredEventToken('SYSTEM2_STALE_DISCARD reason=controller_stopped'),
      'SYSTEM2_STALE_DISCARD',
    )
    assert.equal(mirroredEventToken('SYSTEM2_REQUEST_CANCELLED'), 'SYSTEM2_REQUEST_CANCELLED')
  })
})
