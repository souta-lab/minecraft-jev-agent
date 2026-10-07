// test-ledger-restore.mts - ledger restore must not revive stale furnace acquisition goals,
// and a restored `done` goal whose live rung predicate is unmet must be reopened before any
// later-milestone goal can become active.
// Pure: no Bot, no network, no live host.
import { emptyWorldMemory } from './resident-types.ts'
import { GoalQueue } from '../jev-agent/src/goalQueue.ts'
import type { GoalKind, GoalQueueSnapshot, GoalStatus, QueuedGoal } from '../jev-agent/src/goalQueue.ts'
import {
  evaluateLedgerRestoreBasis,
  evaluateSystem2LedgerRestoreBasis,
  ledgerBasisForLiveFrontier,
  ledgerIsConsistent,
  selectLedgerSnapshot,
  selectSystem2LedgerSnapshot,
  system2FrontierOpportunity,
  SYSTEM2_MISSION_PLAN_IDENTITY,
} from './generation-entry.ts'
import { createRecipeIndex, planNextCraftStep } from '../jev-agent/src/crafting.ts'
import type { LedgerBasis } from '../jev-agent/src/goalQueue.ts'
import { buildLadder, isMandatoryRung, RUNGS } from './planner.ts'
import type { DurableLadderProgress } from './planner.ts'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const recipes = createRecipeIndex(require('minecraft-data')('1.21.11') as unknown)

interface Case {
  name: string
  expected: boolean
  observed: boolean
  detail?: string
}

function worldWithKnownFurnaces() {
  const world = emptyWorldMemory()
  world.furnaces.push({ x: 1, y: 64, z: 1 }, { x: 3, y: 64, z: 1 })
  return world
}

function snapshot(kind: GoalKind, targetItem: string, status: GoalStatus = 'active'): GoalQueueSnapshot {
  return {
    counter: 1,
    goals: [
      {
        id: `g1:${kind}:${targetItem}`,
        kind,
        description: `${kind} 1 x ${targetItem}`,
        targetItem,
        requiredCount: 1,
        targetY: null,
        dimension: null,
        startCount: 0,
        haveCount: 0,
        status,
        origin: 'llm',
        createdAt: 1,
        updatedAt: 1,
        detail: null,
      },
    ],
  }
}

/** A full queued goal with defaults, for the live-reconciliation cases. */
function queued(overrides: Partial<QueuedGoal> & Pick<QueuedGoal, 'id' | 'kind' | 'description' | 'targetItem'>): QueuedGoal {
  return {
    requiredCount: 1,
    targetY: null,
    dimension: null,
    startCount: 0,
    haveCount: 0,
    status: 'pending',
    origin: 'llm',
    createdAt: 1,
    updatedAt: 1,
    detail: null,
    ...overrides,
  }
}

function ledgerOf(goals: QueuedGoal[]): GoalQueueSnapshot {
  return { counter: goals.length + 10, goals }
}

/** The active goal the controller would run after restoring the selected snapshot. */
function restoredHead(host: GoalQueueSnapshot, counts: Record<string, number>): QueuedGoal | null {
  const chosen = selectLedgerSnapshot(host, null, counts, emptyWorldMemory())
  if (chosen === null) return null
  const queue = new GoalQueue()
  queue.restore(chosen.snapshot)
  return queue.current
}

/** A specific restored goal after the live-predicate reconciliation. */
function restoredGoal(host: GoalQueueSnapshot, counts: Record<string, number>, id: string): QueuedGoal | null {
  const chosen = selectLedgerSnapshot(host, null, counts, emptyWorldMemory())
  return chosen?.snapshot.goals.find((goal) => goal.id === id) ?? null
}

// The measured run-mu8ncid0-vwhn state: the ledger records the M2 smelt as done
// with haveCount=3, while the live bot holds only 2 iron ingots and the M3
// LLM-derived obsidian goal waits behind it.
const BUG_LEDGER = ledgerOf([
  queued({
    id: 'g2:smelt:iron_ingot',
    kind: 'smelt',
    description: 'smelt 3 x iron_ingot',
    targetItem: 'iron_ingot',
    requiredCount: 3,
    haveCount: 3,
    status: 'done',
  }),
  queued({
    id: 'g18:collect:obsidian',
    kind: 'collect',
    description: 'collect 1 x obsidian',
    targetItem: 'obsidian',
    requiredCount: 1,
    status: 'pending',
    origin: 'llm',
  }),
])

const cases: Case[] = [
  {
    name: 'restored optional model head gets one System2 reconsideration when the mandatory frontier has an inventory-ready first craft step',
    expected: true,
    observed: (() => {
      const basis: LedgerBasis = {
        worldKey: '127.0.0.1:26615|minecraft:overworld|1',
        frontierRungId: 'iron_pickaxe',
        frontierRungIndex: 9,
      }
      const stale = queued({
        id: 'g5:explore',
        kind: 'explore',
        description: 'explore surface terrain',
        targetItem: null,
        status: 'active',
        optionInstanceId: 'explore:surface',
        optionTemplateId: 'explore:surface',
        planIdentity: { ...SYSTEM2_MISSION_PLAN_IDENTITY },
      })
      const food = queued({
        id: 'g6:collect:food',
        kind: 'collect',
        description: 'collect food',
        targetItem: 'food',
        status: 'pending',
        planIdentity: { ...SYSTEM2_MISSION_PLAN_IDENTITY },
      })
      const saved: GoalQueueSnapshot = { counter: 6, goals: [stale, food], basis, planIdentity: { ...SYSTEM2_MISSION_PLAN_IDENTITY } }
      const counts = {
        iron_ingot: 4,
        stick: 4,
        spruce_planks: 3,
        spruce_log: 1,
        furnace: 1,
        cobblestone: 112,
        coal: 7,
      }
      // The frozen p27 scene has verified crafting tables in world memory. The
      // durable iron_ingot floor is only usable while that world-outcome rung is
      // still live; an empty-world fixture would correctly fall back to the
      // crafting_table rung and would not represent this restore boundary.
      const liveWorld = emptyWorldMemory()
      liveWorld.craftingTables.push({ x: 7197, y: 1, z: 1278, status: 'verified' })
      const ladder = buildLadder(counts, liveWorld, undefined, { resumeRungIndex: 9 })
      const frontierRung = RUNGS.find((rung) => rung.id === ladder.rungId)
      const frontierGoal = frontierRung !== undefined && isMandatoryRung(frontierRung) ? ladder.goals[0] ?? null : null
      const durableProgress: DurableLadderProgress = {
        rungId: 'iron_ingot',
        rungIndex: 8,
        sources: ['ledger-basis'],
        evidence: ['basis:frontier=iron_pickaxe@9'],
      }
      const opportunity = system2FrontierOpportunity(
        frontierGoal,
        { rungId: ladder.rungId, rungIndex: ladder.rungIndex },
        counts,
        liveWorld,
        durableProgress,
        recipes,
      )
      const staleOpportunity = system2FrontierOpportunity(
        frontierGoal,
        { rungId: 'wood', rungIndex: 0 },
        counts,
        liveWorld,
        durableProgress,
        recipes,
      )
      const readyFrontier = opportunity === null
        ? null
        : {
            item: opportunity.targetItem,
            description: opportunity.description,
            firstCan: opportunity.firstStep.type === 'place'
              ? 'PLACE:crafting_table'
              : `CRAFT:${opportunity.firstStep.item}x${opportunity.firstStep.count}`,
          }
      const afterPlanks = { ...counts, spruce_log: 0, spruce_planks: counts.spruce_planks + 4 }
      const tableCraft = planNextCraftStep(recipes, 'iron_pickaxe', afterPlanks, false, 1).op
      const afterTableCraft = { ...afterPlanks, spruce_planks: 3, crafting_table: 1 }
      const tablePlace = planNextCraftStep(recipes, 'iron_pickaxe', afterTableCraft, false, 1).op
      const afterTablePlace = { ...afterTableCraft, crafting_table: 0 }
      const ironPickaxeCraft = planNextCraftStep(recipes, 'iron_pickaxe', afterTablePlace, true, 1).op
      const unchanged = selectSystem2LedgerSnapshot(saved, null, counts, emptyWorldMemory())
      const reconsidered = selectSystem2LedgerSnapshot(saved, null, counts, emptyWorldMemory(), readyFrontier)
      const restoredBasis = reconsidered === null
        ? { accept: false, reasons: ['snapshot_unavailable'] }
        : evaluateSystem2LedgerRestoreBasis(reconsidered.snapshot, basis)
      const protectedSnapshot: GoalQueueSnapshot = {
        ...saved,
        goals: [{ ...stale, protected: true }, food],
      }
      const protectedSelection = selectSystem2LedgerSnapshot(protectedSnapshot, null, counts, emptyWorldMemory(), readyFrontier)
      const queue = new GoalQueue()
      if (reconsidered !== null) queue.restore(reconsidered.snapshot)
      return (
        readyFrontier?.firstCan === 'CRAFT:spruce_planksx4' &&
        ladder.rungId === 'iron_pickaxe' &&
        frontierGoal?.targetItem === 'iron_pickaxe' &&
        opportunity?.targetItem === 'iron_pickaxe' &&
        opportunity.firstStep.type === 'craft' &&
        opportunity.firstStep.item === 'spruce_planks' && opportunity.firstStep.count === 4 &&
        staleOpportunity === null &&
        tableCraft?.type === 'craft' && tableCraft.item === 'crafting_table' &&
        tablePlace?.type === 'place' && tablePlace.item === 'crafting_table' &&
        ironPickaxeCraft?.type === 'craft' && ironPickaxeCraft.item === 'iron_pickaxe' && ironPickaxeCraft.requiresTable &&
        unchanged?.reconsidered.length === 0 &&
        unchanged?.snapshot.goals.find((goal) => goal.id === 'g5:explore')?.status === 'active' &&
        restoredBasis.accept &&
        reconsidered?.reconsidered.map((goal) => goal.id).join(',') === 'g5:explore,g6:collect:food' &&
        reconsidered?.snapshot.goals.find((goal) => goal.id === 'g5:explore')?.status === 'impossible' &&
        reconsidered?.snapshot.goals.find((goal) => goal.id === 'g6:collect:food')?.status === 'impossible' &&
        protectedSelection?.snapshot.goals.find((goal) => goal.id === 'g5:explore')?.status === 'active' &&
        queue.current === null
      )
    })(),
  },
  {
    name: 'System2 restore recognizes a legacy surface recovery template nested only in optionSpec',
    expected: true,
    observed: (() => {
      const basis: LedgerBasis = {
        worldKey: '127.0.0.1:26615|minecraft:overworld|1',
        frontierRungId: 'iron_pickaxe',
        frontierRungIndex: 9,
      }
      const legacySurface = queued({
        id: 'g5:explore',
        kind: 'explore',
        description: 'explore surface terrain',
        targetItem: null,
        status: 'active',
        // Older queue snapshots may have the stable template only inside the
        // persisted OptionSpec. GoalQueue.restore normalizes it to top-level
        // ids later, but System2 restore selection runs before that normalization.
        optionSpec: {
          id: 'explore:surface',
          intent: 'explore surface terrain',
          kind: 'explore',
          target: { count: 1 },
          preconditions: [],
          success: [],
          skills: ['EXPLORE_FRONTIER'],
          abortThreshold: 0.5,
        },
        planIdentity: { ...SYSTEM2_MISSION_PLAN_IDENTITY },
      })
      const saved: GoalQueueSnapshot = {
        counter: 5,
        goals: [legacySurface],
        basis,
        planIdentity: { ...SYSTEM2_MISSION_PLAN_IDENTITY },
      }
      const selected = selectSystem2LedgerSnapshot(
        saved,
        null,
        { iron_ingot: 4, stick: 4, spruce_planks: 3, spruce_log: 1 },
        emptyWorldMemory(),
        { item: 'iron_pickaxe', description: 'craft 1 x iron_pickaxe', firstCan: 'CRAFT:spruce_planksx4' },
      )
      const queue = new GoalQueue()
      if (selected !== null) queue.restore(selected.snapshot)
      return (
        selected?.reconsidered.map((goal) => goal.id).join(',') === 'g5:explore' &&
        selected.snapshot.goals[0]?.status === 'impossible' &&
        queue.current === null
      )
    })(),
  },
  {
    name: 'a held crafting table makes the iron-pickaxe frontier startable before restoring optional surface recovery',
    expected: true,
    observed: (() => {
      const basis: LedgerBasis = {
        worldKey: '127.0.0.1:26615|minecraft:overworld|1',
        frontierRungId: 'iron_pickaxe',
        frontierRungIndex: 9,
      }
      const expectedFrontier = { rungId: basis.frontierRungId, rungIndex: basis.frontierRungIndex }
      const stale = queued({
        id: 'g5:explore',
        kind: 'explore',
        description: 'explore surface terrain',
        targetItem: null,
        status: 'active',
        optionInstanceId: 'explore:surface',
        optionTemplateId: 'explore:surface',
        planIdentity: { ...SYSTEM2_MISSION_PLAN_IDENTITY },
      })
      const food = queued({
        id: 'g6:collect:food',
        kind: 'collect',
        description: 'collect food',
        targetItem: 'food',
        status: 'pending',
        planIdentity: { ...SYSTEM2_MISSION_PLAN_IDENTITY },
      })
      const saved: GoalQueueSnapshot = {
        counter: 6,
        goals: [stale, food],
        basis,
        planIdentity: { ...SYSTEM2_MISSION_PLAN_IDENTITY },
      }
      const counts = {
        iron_ingot: 4,
        stick: 4,
        spruce_planks: 3,
        crafting_table: 1,
        coal: 7,
        cobblestone: 112,
        furnace: 1,
      }
      const liveWorld = emptyWorldMemory()
      const mandatory = {
        kind: 'craft' as const,
        targetItem: 'iron_pickaxe',
        requiredCount: 1,
        description: 'craft 1 x iron_pickaxe',
      }
      const durableProgress: DurableLadderProgress = {
        rungId: 'iron_ingot',
        rungIndex: 8,
        sources: ['ledger-basis'],
        evidence: ['basis:frontier=iron_pickaxe@9'],
      }
      const opportunity = system2FrontierOpportunity(
        mandatory,
        expectedFrontier,
        counts,
        liveWorld,
        durableProgress,
        recipes,
      )
      const noTableOpportunity = system2FrontierOpportunity(
        mandatory,
        expectedFrontier,
        { ...counts, crafting_table: 0 },
        liveWorld,
        durableProgress,
        recipes,
      )
      const readyFrontier = opportunity === null
        ? null
        : {
            item: opportunity.targetItem,
            description: opportunity.description,
            firstCan: opportunity.firstStep.type === 'place'
              ? 'PLACE:crafting_table'
              : `CRAFT:${opportunity.firstStep.item}x${opportunity.firstStep.count}`,
          }
      const selected = selectSystem2LedgerSnapshot(saved, null, counts, liveWorld, readyFrontier)
      const untouched = selectSystem2LedgerSnapshot(saved, null, counts, liveWorld)
      const afterPlacement = planNextCraftStep(
        recipes,
        'iron_pickaxe',
        { iron_ingot: 4, stick: 4, spruce_planks: 3 },
        true,
        1,
      ).op
      const queue = new GoalQueue()
      if (selected !== null) queue.restore(selected.snapshot)
      return (
        opportunity?.firstStep.type === 'place' &&
        opportunity.firstStep.item === 'crafting_table' &&
        readyFrontier?.firstCan === 'PLACE:crafting_table' &&
        noTableOpportunity === null &&
        evaluateSystem2LedgerRestoreBasis(saved, basis).accept &&
        selected?.reconsidered.map((goal) => goal.id).join(',') === 'g5:explore,g6:collect:food' &&
        selected.snapshot.goals.every((goal) => goal.status === 'impossible') &&
        untouched?.snapshot.goals.find((goal) => goal.id === 'g5:explore')?.status === 'active' &&
        afterPlacement?.type === 'craft' && afterPlacement.item === 'iron_pickaxe' && afterPlacement.requiresTable &&
        queue.current === null
      )
    })(),
  },
  {
    name: 'ready mandatory frontier retires a legacy-core surface recovery without changing System2 authority',
    expected: true,
    observed: (() => {
      const basis: LedgerBasis = {
        worldKey: '127.0.0.1:26615|minecraft:overworld|1',
        frontierRungId: 'iron_pickaxe',
        frontierRungIndex: 9,
      }
      const stale = queued({
        id: 'g5:explore',
        kind: 'explore',
        description: 'explore surface terrain',
        targetItem: null,
        status: 'active',
        core: true,
        optionInstanceId: 'explore:surface',
        planIdentity: { ...SYSTEM2_MISSION_PLAN_IDENTITY },
      })
      const saved: GoalQueueSnapshot = {
        counter: 5,
        goals: [stale],
        basis,
        planIdentity: { ...SYSTEM2_MISSION_PLAN_IDENTITY },
      }
      const counts = {
        iron_ingot: 4,
        stick: 4,
        spruce_planks: 3,
        spruce_log: 1,
        crafting_table: 0,
        furnace: 1,
      }
      const liveWorld = emptyWorldMemory()
      liveWorld.craftingTables.push({ x: 7197, y: 1, z: 1278, status: 'verified' })
      liveWorld.furnaces.push({ x: 7202, y: 3, z: 1280, status: 'verified' })
      const mandatory = {
        kind: 'craft' as const,
        targetItem: 'iron_pickaxe',
        requiredCount: 1,
        description: 'craft 1 x iron_pickaxe',
      }
      const durableProgress: DurableLadderProgress = {
        rungId: 'iron_ingot',
        rungIndex: 8,
        sources: ['ledger-basis'],
        evidence: ['basis:frontier=iron_pickaxe@9'],
      }
      const opportunity = system2FrontierOpportunity(
        mandatory,
        { rungId: basis.frontierRungId, rungIndex: basis.frontierRungIndex },
        counts,
        liveWorld,
        durableProgress,
        recipes,
      )
      const readyFrontier = opportunity === null
        ? null
        : {
            item: opportunity.targetItem,
            description: opportunity.description,
            firstCan: opportunity.firstStep.type === 'place'
              ? 'PLACE:crafting_table'
              : `CRAFT:${opportunity.firstStep.item}x${opportunity.firstStep.count}`,
          }
      const selected = selectSystem2LedgerSnapshot(saved, null, counts, liveWorld, readyFrontier)
      const unchangedWithoutOpportunity = selectSystem2LedgerSnapshot(saved, null, counts, liveWorld)
      const queue = new GoalQueue()
      if (selected !== null) queue.restore(selected.snapshot)
      return (
        opportunity?.targetItem === 'iron_pickaxe' &&
        readyFrontier?.firstCan === 'CRAFT:spruce_planksx4' &&
        evaluateSystem2LedgerRestoreBasis(saved, basis).accept &&
        selected?.reconsidered.map((goal) => goal.id).join(',') === 'g5:explore' &&
        selected.snapshot.goals.find((goal) => goal.id === 'g5:explore')?.status === 'impossible' &&
        unchangedWithoutOpportunity?.reconsidered.length === 0 &&
        unchangedWithoutOpportunity?.snapshot.goals.find((goal) => goal.id === 'g5:explore')?.status === 'active' &&
        queue.current === null
      )
    })(),
  },
  {
    name: 'legacy unfinished ledger is not authoritative without a live frontier basis',
    expected: false,
    observed: evaluateLedgerRestoreBasis(snapshot('collect', 'log'), {
      worldKey: '127.0.0.1:25565|minecraft:overworld|1',
      frontierRungId: 'nether_portal',
      frontierRungIndex: 12,
    }).accept,
  },
  {
    name: 'model-authored surface recovery is reconsidered when its saved mandatory frontier is stale',
    expected: true,
    observed: (() => {
      const liveBasis: LedgerBasis = {
        worldKey: '127.0.0.1:26615|minecraft:overworld|1',
        frontierRungId: 'iron_pickaxe',
        frontierRungIndex: 9,
      }
      const stale: GoalQueueSnapshot = {
        counter: 5,
        goals: [queued({
          id: 'g5:explore',
          kind: 'explore',
          description: 'explore surface terrain',
          targetItem: null,
          status: 'active',
          optionInstanceId: 'explore:surface',
          optionTemplateId: 'explore:surface',
          planIdentity: { ...SYSTEM2_MISSION_PLAN_IDENTITY },
        })],
        basis: {
          worldKey: liveBasis.worldKey,
          frontierRungId: 'wood',
          frontierRungIndex: 0,
        },
        planIdentity: { ...SYSTEM2_MISSION_PLAN_IDENTITY },
      }
      const counts = { iron_ingot: 4, stick: 4, spruce_planks: 3, spruce_log: 1 }
      const selected = selectSystem2LedgerSnapshot(
        stale,
        null,
        counts,
        emptyWorldMemory(),
        { item: 'iron_pickaxe', description: 'craft 1 x iron_pickaxe', firstCan: 'CRAFT:spruce_planksx4' },
      )
      const decision = selected === null
        ? { accept: false, reasons: ['snapshot_unavailable'] }
        : evaluateSystem2LedgerRestoreBasis(selected.snapshot, liveBasis)
      const restored = new GoalQueue()
      if (decision.accept && selected !== null) restored.restore(selected.snapshot)
      return (
        selected?.reconsidered.map((goal) => goal.id).join(',') === 'g5:explore' &&
        decision.accept === false &&
        decision.reasons.includes('frontier_index_changed') &&
        decision.reasons.includes('frontier_id_changed') &&
        restored.current === null
      )
    })(),
  },
  {
    name: 'done-only Nether snapshot cannot erase the fresh Overworld respawn queue',
    expected: false,
    observed: evaluateLedgerRestoreBasis(
      {
        ...snapshot('collect', 'blaze_rod', 'done'),
        basis: {
          worldKey: '127.0.0.1:25565|minecraft:the_nether|1',
          frontierRungId: 'blaze_rods',
          frontierRungIndex: 15,
        },
      },
      {
        worldKey: '127.0.0.1:25565|minecraft:overworld|1',
        frontierRungId: 'enter_nether',
        frontierRungIndex: 14,
      },
    ).accept,
  },
  {
    name: 'done-only snapshot with the same scoped basis remains restorable',
    expected: true,
    observed: (() => {
      const basis: LedgerBasis = {
        worldKey: '127.0.0.1:25565|minecraft:overworld|1',
        frontierRungId: 'enter_nether',
        frontierRungIndex: 14,
      }
      return evaluateLedgerRestoreBasis({ ...snapshot('collect', 'log', 'done'), basis }, basis).accept
    })(),
  },
  {
    name: 'same world and frontier preserve an unfinished semantic ledger',
    expected: true,
    observed: (() => {
      const basis: LedgerBasis = {
        worldKey: '127.0.0.1:25565|minecraft:overworld|1',
        frontierRungId: 'charcoal',
        frontierRungIndex: 6,
      }
      return evaluateLedgerRestoreBasis({ ...snapshot('smelt', 'charcoal'), basis }, basis).accept
    })(),
  },
  {
    name: 'frontier advancement invalidates the unfinished old semantic ledger',
    expected: false,
    observed: evaluateLedgerRestoreBasis(
      {
        ...snapshot('smelt', 'charcoal'),
        basis: {
          worldKey: '127.0.0.1:25565|minecraft:overworld|1',
          frontierRungId: 'charcoal',
          frontierRungIndex: 6,
        },
      },
      {
        worldKey: '127.0.0.1:25565|minecraft:overworld|1',
        frontierRungId: 'nether_portal',
        frontierRungIndex: 12,
      },
    ).accept,
  },

  {
    name: 'restore basis follows the current ladder frontier, not inventory resume',
    expected: true,
    observed: (() => {
      const snapshotBasis: LedgerBasis = {
        worldKey: '127.0.0.1:25565|minecraft:overworld|1',
        frontierRungId: 'nether_portal',
        frontierRungIndex: 13,
      }
      const liveBasis = ledgerBasisForLiveFrontier('127.0.0.1:25565|minecraft:overworld|1', {
        rungId: 'enter_nether',
        rungIndex: 14,
      })
      return (
        liveBasis.frontierRungId === 'enter_nether' &&
        liveBasis.frontierRungIndex === 14 &&
        !evaluateLedgerRestoreBasis({ ...snapshot('collect', 'obsidian'), basis: snapshotBasis }, liveBasis).accept
      )
    })(),
  },
  {
    name: 'active craft:furnace is stale when raw iron and two known furnaces are present',
    expected: false,
    observed: ledgerIsConsistent(
      { counter: 299, goals: [{ kind: 'craft', status: 'active', targetItem: 'furnace' }] },
      { raw_iron: 8 },
      worldWithKnownFurnaces(),
    ),
  },
  {
    name: 'pending place:furnace is stale when a furnace is held',
    expected: false,
    observed: ledgerIsConsistent(
      { counter: 300, goals: [{ kind: 'place', status: 'pending', targetItem: 'furnace' }] },
      { furnace: 1 },
      emptyWorldMemory(),
    ),
  },
  {
    name: 'active smelt:iron_ingot remains consistent with two known furnaces',
    expected: true,
    observed: ledgerIsConsistent(
      { counter: 301, goals: [{ kind: 'smelt', status: 'active', targetItem: 'iron_ingot' }] },
      { raw_iron: 8 },
      worldWithKnownFurnaces(),
    ),
  },
  {
    name: 'done furnace remains stale when no furnace is present',
    expected: false,
    observed: ledgerIsConsistent(
      { counter: 302, goals: [{ kind: 'craft', status: 'done', targetItem: 'furnace' }] },
      {},
      emptyWorldMemory(),
    ),
  },
  {
    name: 'host snapshot wins over a valid derived snapshot',
    expected: true,
    observed: selectLedgerSnapshot(snapshot('smelt', 'iron_ingot'), snapshot('collect', 'diamond'), { raw_iron: 8 }, worldWithKnownFurnaces())?.source === 'host-snapshot',
  },
  {
    name: 'stale host snapshot blocks a valid derived snapshot',
    expected: true,
    observed: selectLedgerSnapshot(snapshot('craft', 'furnace'), snapshot('smelt', 'iron_ingot'), { raw_iron: 8 }, worldWithKnownFurnaces()) === null,
  },
  {
    name: 'derived snapshot is used when host snapshot is absent',
    expected: true,
    observed: selectLedgerSnapshot(null, snapshot('smelt', 'iron_ingot'), { raw_iron: 8 }, worldWithKnownFurnaces())?.source === 'derived-file',
  },
  {
    name: 'BUG run-mu8ncid0-vwhn: live iron_ingot=2 reopens the restored done smelt before the M3 obsidian goal',
    expected: true,
    observed: (() => {
      const current = restoredHead(BUG_LEDGER, { iron_ingot: 2 })
      return current?.id === 'g2:smelt:iron_ingot' && current.status === 'active'
    })(),
    detail: `current=${restoredHead(BUG_LEDGER, { iron_ingot: 2 })?.id ?? 'none'} live iron_ingot=2`,
  },
  {
    name: 'positive control: live iron_ingot=3 keeps the restored smelt done (no spurious reopen)',
    expected: true,
    observed: (() => {
      const goal = restoredGoal(BUG_LEDGER, { iron_ingot: 3 }, 'g2:smelt:iron_ingot')
      return goal?.status === 'done' && goal.haveCount === 3
    })(),
    detail: `status=${restoredGoal(BUG_LEDGER, { iron_ingot: 3 }, 'g2:smelt:iron_ingot')?.status ?? 'none'} live iron_ingot=3`,
  },
  {
    name: 'generalized rung: done collect:raw_iron stays done when live iron_ingot=5 satisfies the raw_iron rung',
    expected: true,
    observed: (() => {
      const host = ledgerOf([
        queued({
          id: 'g1:collect:raw_iron',
          kind: 'collect',
          description: 'collect 3 x raw_iron',
          targetItem: 'raw_iron',
          requiredCount: 3,
          haveCount: 3,
          status: 'done',
        }),
      ])
      return restoredGoal(host, { iron_ingot: 5 }, 'g1:collect:raw_iron')?.status === 'done'
    })(),
  },
  {
    name: 'generalized rung: done collect:raw_iron reopens when live raw_iron=0 and iron_ingot=2 (<3)',
    expected: true,
    observed: (() => {
      const host = ledgerOf([
        queued({
          id: 'g1:collect:raw_iron',
          kind: 'collect',
          description: 'collect 3 x raw_iron',
          targetItem: 'raw_iron',
          requiredCount: 3,
          haveCount: 3,
          status: 'done',
        }),
      ])
      const goal = restoredGoal(host, { raw_iron: 0, iron_ingot: 2 }, 'g1:collect:raw_iron')
      return goal !== null && goal.status !== 'done' && goal.haveCount === 0
    })(),
  },
  {
    name: 'generalized rung: done craft:wooden_pickaxe stays done when a stone_pickaxe is held',
    expected: true,
    observed: (() => {
      const host = ledgerOf([
        queued({
          id: 'g1:craft:wooden_pickaxe',
          kind: 'craft',
          description: 'craft 1 x wooden_pickaxe',
          targetItem: 'wooden_pickaxe',
          requiredCount: 1,
          haveCount: 1,
          status: 'done',
        }),
      ])
      return restoredGoal(host, { stone_pickaxe: 1 }, 'g1:craft:wooden_pickaxe')?.status === 'done'
    })(),
  },
  {
    name: 'generalized rung: done craft:wooden_pickaxe is not left trusted when no pickaxe is held',
    expected: true,
    observed: (() => {
      const host = ledgerOf([
        queued({
          id: 'g1:craft:wooden_pickaxe',
          kind: 'craft',
          description: 'craft 1 x wooden_pickaxe',
          targetItem: 'wooden_pickaxe',
          requiredCount: 1,
          haveCount: 1,
          status: 'done',
        }),
      ])
      const chosen = selectLedgerSnapshot(host, null, {}, emptyWorldMemory())
      const goal = chosen?.snapshot.goals.find((candidate) => candidate.id === 'g1:craft:wooden_pickaxe') ?? null
      return chosen === null || goal?.status !== 'done'
    })(),
  },
  {
    name: 'generalized rung: done collect:diamond reopens when live diamond=0',
    expected: true,
    observed: (() => {
      const host = ledgerOf([
        queued({
          id: 'g1:collect:diamond',
          kind: 'collect',
          description: 'collect 1 x diamond',
          targetItem: 'diamond',
          requiredCount: 1,
          haveCount: 1,
          status: 'done',
        }),
      ])
      return restoredGoal(host, {}, 'g1:collect:diamond')?.status !== 'done'
    })(),
  },
  {
    name: 'generalized rung: done craft:iron_pickaxe stays done when a diamond_pickaxe is held',
    expected: true,
    observed: (() => {
      const host = ledgerOf([
        queued({
          id: 'g1:craft:iron_pickaxe',
          kind: 'craft',
          description: 'craft 1 x iron_pickaxe',
          targetItem: 'iron_pickaxe',
          requiredCount: 1,
          haveCount: 1,
          status: 'done',
        }),
      ])
      return restoredGoal(host, { diamond_pickaxe: 1 }, 'g1:craft:iron_pickaxe')?.status === 'done'
    })(),
  },
  {
    name: 'generalized rung: done smelt:charcoal reopens when live charcoal=0 (M2 charcoal gate)',
    expected: true,
    observed: (() => {
      const host = ledgerOf([
        queued({
          id: 'g1:smelt:charcoal',
          kind: 'smelt',
          description: 'smelt 1 x charcoal',
          targetItem: 'charcoal',
          requiredCount: 1,
          haveCount: 1,
          status: 'done',
        }),
      ])
      return restoredGoal(host, {}, 'g1:smelt:charcoal')?.status !== 'done'
    })(),
  },
]

let failures = 0
process.stdout.write('Ledger restore furnace consistency\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const pass = testCase.observed === testCase.expected
  if (!pass) failures += 1
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      expected=${String(testCase.expected)} observed=${String(testCase.observed)}${testCase.detail === undefined ? '' : ` ${testCase.detail}`}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} ledger-restore cases passed\n`)
if (failures > 0) process.exit(1)
