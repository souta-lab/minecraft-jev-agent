// test-blocked-affordance-ledger.mts - portal-p17.1: repeated typed blockers
// must reach System2 as accumulated CAN-refusal history, not one transient
// string per summon.
//
// THE MEASURED DEFECT this suite pins. On portal-p14/p16/p17 the same typed
// blocker (`column_descent:no_safe_step`, `dig_route:*`, unreachable stations)
// exhausted the bounded local-recovery window under DIFFERENT goals
// (explore<->descend_to<->collect): each System2 re-plan recompiled to the
// identical unavailable affordance because the request only ever saw the
// CURRENT blockedBy string (portal-p17 x325). Causal history is deterministic
// CAN evidence, so the controller records each exhausted bounded window in a
// bounded ledger keyed by typed-reason|rounded-cell and projects it back into
// `missing` + the semantic fact channel. System2 still owns the replacement
// WHAT; nothing here chooses a goal.
//
// Cases:
//   (a) an empty ledger contributes no `repeated:` facts and no tokens;
//   (b) ledger entries surface as `repeated:<reason>` blocked facts carrying
//       the repeat count and the goal identities already defeated;
//   (c) the entry matching the CURRENT blocker is not double-reported;
//   (d) the fact list stays bounded at 16 under an oversized ledger;
//   (e) goal identities in the detail line are bounded to three;
//   (f) the controller records the ledger at the starvation boundary, keys on
//       the TYPED missing token rather than the generic blockedBy, never lets
//       its own projected `blocked_affordance:` token re-key an entry, and
//       appends ledger tokens only into capacity the live tick left unused.
//
// Run: bun test-blocked-affordance-ledger.mts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'bun:test'
import { semanticFacts } from './src/system2-plane.ts'
import type { System2PlaneHost } from './src/system2-plane.ts'
import { blockedAffordanceResolvedByInventory } from './src/candidate-diagnostics.ts'
import type { WorldState } from './src/state.ts'

const controller = readFileSync(new URL('./src/controller.ts', import.meta.url), 'utf8')

const state = (): WorldState =>
  ({
    signals: { knownResources: [] },
    portalFrameSites: [],
    portalFrame: null,
    goalQueue: { current: null },
  }) as unknown as WorldState

const host = (over: {
  starvationContext?: { blockedBy: string; missing: string[] } | null
  ledger?: readonly { reason: string; goals: readonly string[]; count: number }[]
} = {}): System2PlaneHost =>
  ({
    activeRetrieval: null,
    capabilityGapActive: false,
    capabilityGapSignature: null,
    starvationContext: over.starvationContext ?? null,
    repeatedBlockerFacts: () => over.ledger ?? [],
  }) as unknown as System2PlaneHost

describe('blocked-affordance ledger -> semantic negative constraints', () => {
  it('(a) an empty ledger contributes no repeated facts', () => {
    const facts = semanticFacts(host(), state())
    assert.equal(facts.filter((f) => f.key.startsWith('repeated:')).length, 0)
  })

  it('(b) ledger entries surface as repeated blocked facts with count and goals', () => {
    const facts = semanticFacts(
      host({
        ledger: [{
          reason: 'column_descent:no_safe_step',
          goals: ['explore:1', 'descend_to:y64', 'collect:cobblestone:8'],
          count: 5,
        }],
      }),
      state(),
    )
    const fact = facts.find((f) => f.key === 'repeated:column_descent:no_safe_step')
    assert.ok(fact, `expected repeated fact, got ${JSON.stringify(facts.map((f) => f.key))}`)
    assert.equal(fact.kind, 'blocked')
    assert.match(fact.detail, /5x/)
    assert.match(fact.detail, /explore:1\/descend_to:y64\/collect:cobblestone:8/)
  })

  it('(c) the entry matching the current blocker is not double-reported', () => {
    const facts = semanticFacts(
      host({
        starvationContext: { blockedBy: 'column_descent:no_safe_step', missing: [] },
        ledger: [
          { reason: 'column_descent:no_safe_step', goals: ['explore:1'], count: 4 },
          { reason: 'dig_route:no_support', goals: ['descend_to:y64'], count: 2 },
        ],
      }),
      state(),
    )
    assert.ok(facts.some((f) => f.key === 'column_descent:no_safe_step'))
    assert.equal(facts.filter((f) => f.key === 'repeated:column_descent:no_safe_step').length, 0)
    assert.equal(facts.filter((f) => f.key === 'repeated:dig_route:no_support').length, 1)
  })

  it('(d) the fact list stays bounded under an oversized ledger', () => {
    const ledger = Array.from({ length: 32 }, (_, i) => ({
      reason: `dig_route:reason_${i}`,
      goals: [`goal_${i}`],
      count: i + 1,
    }))
    const facts = semanticFacts(host({ ledger }), state())
    assert.ok(facts.length <= 16, `facts=${facts.length}`)
  })

  it('(e) goal identities in the detail line are bounded to three', () => {
    const facts = semanticFacts(
      host({
        ledger: [{
          reason: 'column_descent:no_safe_step',
          goals: ['g1', 'g2', 'g3', 'g4', 'g5'],
          count: 2,
        }],
      }),
      state(),
    )
    const fact = facts.find((f) => f.key === 'repeated:column_descent:no_safe_step')
    assert.ok(fact)
    assert.match(fact.detail, /g1\/g2\/g3/)
    assert.doesNotMatch(fact.detail, /g4/)
  })
})

describe('blocked-affordance revalidation by held inventory', () => {
  // portal-p24, run-muvw7u6j: a `placeable_block` refusal recorded with `inv={}`
  // kept reaching System2 as proven CAN-refusal evidence while the body held
  // `dirt:48` - an acquired capability asserting "route around this" while the
  // route was open. Held-item capability reasons are revalidated at every read;
  // mechanical refusals (world geometry) stay durable.
  it('(g) a placeable_block reason resolves once any pillar block is held', () => {
    assert.equal(
      blockedAffordanceResolvedByInventory('MOVE:b23_102_-15:placeable_block', { dirt: 48 }),
      true,
    )
    assert.equal(
      blockedAffordanceResolvedByInventory('MOVE:b23_102_-15:placeable_block', { spruce_log: 3 }),
      true,
    )
    assert.equal(
      blockedAffordanceResolvedByInventory('MOVE:b23_102_-15:placeable_block', {}),
      false,
    )
    // A held non-placeable does not resolve the refusal.
    assert.equal(
      blockedAffordanceResolvedByInventory('MOVE:b23_102_-15:placeable_block', { snow_block: 9, stick: 2 }),
      false,
    )
  })

  it('(h) a tool-tail reason resolves on a held tool at the required tier', () => {
    // `tool:pickaxe@1` embedded behind a candidate id.
    assert.equal(
      blockedAffordanceResolvedByInventory('MINE:b24_95_-11:tool:pickaxe@1', { stone_pickaxe: 1 }),
      true,
    )
    // Same tail carried by a safe_column:no_tool key.
    assert.equal(
      blockedAffordanceResolvedByInventory('DIG:x:safe_column:no_tool@29,90,-16:pickaxe@0', { wooden_pickaxe: 1 }),
      true,
    )
    // Tier too low stays blocked: stone (rank 2) below an iron requirement.
    assert.equal(
      blockedAffordanceResolvedByInventory('MINE:b1_2_3:tool:pickaxe@3', { stone_pickaxe: 1 }),
      false,
    )
    // Wrong family entirely stays blocked.
    assert.equal(
      blockedAffordanceResolvedByInventory('MINE:b1_2_3:tool:pickaxe@1', { dirt: 40 }),
      false,
    )
  })

  it('(i) mechanical refusals never resolve via inventory', () => {
    const full = { dirt: 48, iron_pickaxe: 1, crafting_table: 1 }
    for (const reason of [
      'column_descent:descent_budget_exhausted',
      'food_source:no_source_sensed',
      'MOVE:b23_102_-15:open_path',
      'RETREAT:p20_91_0:no_path',
      'MOVE:b10_96_-33:standable_approach',
      'ASCEND:p31_92_-16:headroom@31,93,-16',
      'portal_frame_material:obsidian:0/4',
    ]) {
      assert.equal(blockedAffordanceResolvedByInventory(reason, full), false, reason)
    }
  })
})

describe('controller ledger wiring', () => {
  it('(f) records at the starvation boundary keyed by the typed token', () => {
    assert.match(controller, /noProductiveRepeats >= this\.options\.waitLimit[\s\S]{0,1200}blockedAffordanceLedger/)
    // The ledger reason must be the typed missing token (e.g.
    // `column_descent:no_safe_step`), never the generic no_productive_action
    // wrapper when a typed token exists, and never the ledger's own token.
    assert.match(controller, /missing\.find\(\(token\) => token\.includes\(':'\)/)
    assert.match(controller, /!token\.startsWith\('blocked_affordance:'\)/)
    assert.match(controller, /`\$\{ledgerReason\}\|\$\{ledgerCell\}`/)
    // Bounded with oldest-entry eviction.
    assert.match(controller, /BLOCKED_AFFORDANCE_LEDGER_LIMIT = 16/)
    assert.match(controller, /blockedAffordanceLedger\.delete\(oldestKey\)/)
    // Goals accumulate on the existing entry; count increments.
    assert.match(controller, /ledgerEntry\.goals\.add\(this\.currentGoalKey\(\)\)/)
    assert.match(controller, /ledgerEntry\.count \+= 1/)
    // Ledger tokens are projected into `missing` AFTER all live per-tick
    // tokens and capped by MAX_STARVATION_MISSING.
    const projection = controller.indexOf('blocked_affordance:${entry.reason}@${entry.cell}:x${entry.count}')
    const starvationSet = controller.indexOf('this.starvationContext = { blockedBy, missing }')
    const columnToken = controller.indexOf('`column_descent:${this.columnDescentRefusalThisTick.reason}`')
    assert.ok(columnToken > 0 && projection > columnToken && projection < starvationSet)
    assert.match(controller, /missing\.length >= MAX_STARVATION_MISSING\) break/)
    // Code carries the CAN-fact only: no goal selection appears near the write.
    const boundary = controller.slice(controller.indexOf('noProductiveRepeats >= this.options.waitLimit'), starvationSet)
    assert.doesNotMatch(boundary, /queue\.(push|install|replace)|chooseGoal|selectGoal/)
  })

  it('(j) both ledger read sites revalidate held-item refusals before projecting', () => {
    // The System2 fact channel and the starvation `missing` channel both prune
    // inventory-resolved entries first - a refusal that acquisition dissolved
    // must never be re-asserted as a live blocker.
    const repeated = controller.indexOf('private repeatedBlockerFacts()')
    const factsBody = controller.slice(repeated, repeated + 400)
    assert.match(factsBody, /this\.pruneResolvedBlockedAffordances\(\)/)
    const append = controller.indexOf('blocked_affordance:${entry.reason}@${entry.cell}:x${entry.count}')
    const appendRegion = controller.slice(append - 800, append)
    assert.match(appendRegion, /this\.pruneResolvedBlockedAffordances\(\)/)
    // The prune is inventory-grounded and logs the resolution for provenance.
    assert.match(controller, /pruneResolvedBlockedAffordances[\s\S]{0,600}blockedAffordanceResolvedByInventory\(entry\.reason/)
    assert.match(controller, /BLOCKED_AFFORDANCE_RESOLVED reason=/)
    // Mechanical refusals are untouched: no capability tail parse runs inside
    // the ledger write path itself (write stays a pure history record).
    const write = controller.slice(controller.indexOf('const ledgerReason'), controller.indexOf('const ledgerReason') + 1600)
    assert.doesNotMatch(write, /resolvedByInventory/)
  })
})
