// test-armour-route.mts - the armour PRODUCER route: craft what you can afford,
// then wear it (owner report, lane task/armour-route).
//
// MEASURED STATE THIS FIXTURE PINS (source 38cbb22, the revision the lane
// started from). Armour could be WORN but nothing in the agent ever PRODUCED it:
//
//   * `gearPlan.ts#armorEquipOffers` (115) + `candidates.ts#armorEquipCandidates`
//     (3482) offer `EQUIP:<slot>:<piece>` for every carried piece that is
//     strictly better than what is worn - always, independent of the goal;
//   * the only prerequisite enumeration for a required kill is
//     `candidates.ts#combatKitPrerequisiteCandidates` (3381), which iterates
//     `CRAFTABLE_SWORDS` (gearPlan.ts:448) - SWORDS ONLY; the sole armour
//     "prerequisite" was an already-carried EQUIP (candidates.ts:3460-3462);
//   * no goal, want, OptionSpec or queue row in the agent ever names an armour
//     item (`optionSpec*.ts` / `goalQueue.ts`: zero hits);
//   * so the measured Nether arrival kit produced exactly
//     `COMBAT_KIT_GAP focus=blaze_rod target=blaze distance=3m held=diamond_sword
//      swingDamage=7 armor=0/4 missing=[armor] regenerating=true prerequisite=none`
//     - the gap stated, the route missing, and no reason given.
//
// THE CAPABILITY UNDER TEST is a CLASS, not an iron special case:
// "craft the armour you can afford from what you carry, and wear it". The piece
// set is whatever the live data version can produce (`RecipeIndex.resultItems`),
// the material is whatever the recipe consumes, and the affordability is decided
// by the SAME `planNextCraftStep` every other craft route uses. Leather from cow
// drops, gold from nether gold ore, diamond, turtle scutes, one piece or four,
// all travel this one path.
//
// Cases:
//   (m) the measured state, before/after: the same fatal-window shape now either
//       names the armour craft as the prerequisite or names the exact shortfall;
//   (i) enough material -> the craft is grounded, Jev can choose it, and the
//       armour is WORN (executed end to end through the real Executor);
//   (ii) not enough material -> a typed refusal naming WHICH material and count,
//       and NO attempt (no candidate);
//   (iii) generality: leather / gold / diamond / turtle, one piece, upgrades,
//       no downgrades, copper (unprovable tier) refused, nothing held -> silence;
//   (iv) byte-identical control for the WEAPON-ARMING lane: the same fixture run
//       against pristine 38cbb22 differs in the candidate id set ONLY by the
//       added armour crafts (the `EQUIP:hand:*` bytes hash the same);
//   (v) evidence: typed + MIRRORED, so a post-mortem can tell "not craftable"
//       from "never offered".
//
// Run: bun ./test-armour-route.mts
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import type { ActuationPort } from './src/actuationPort.ts'
import { EventLogger, JsonlWriter } from './src/jev.ts'
import { Executor, defaultExecutorOptions } from './src/index.ts'
import { combatKitGap, defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import type { Candidate, CandidateOptions, GroundedCandidatesResult } from './src/candidates.ts'
import { createRecipeIndex } from './src/crafting.ts'
import { mirroredEventToken, MIRRORED_MARKERS } from './src/controller.ts'
import {
  ARMOR_CRAFT,
  ARMOR_CRAFT_REFUSED,
  armorCraftTargets,
  formatArmorCraft,
  formatArmorCraftRefusal,
  formatCombatKitGap,
} from './src/gearPlan.ts'
import { ARMOR_SLOT_INDEX } from './src/gearPlan.ts'
import type { ArmorSlot } from './src/gearPlan.ts'
import type { BlockState, EntityState, GoalState, InventoryState, SelfState, Vec3Json, WorldState } from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { fixtureClaim } from './test-claim-context.mts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')
const RECIPES = createRecipeIndex(registry as unknown)

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const SELF: Vec3Json = { x: 0.5, y: 61, z: 0.5 }
const TABLE: Vec3Json = { x: 2, y: 61, z: 0 }

function selfState(held: string | null, armor: Record<string, { name: string; count: number }> = {}): SelfState {
  return {
    username: 'AI_ARMOUR',
    position: SELF,
    eyePosition: { x: SELF.x, y: SELF.y + 1.62, z: SELF.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'minecraft:the_nether',
    isDay: true,
    heldItem: held === null ? null : { name: held, count: 1, slot: 36 },
    armor,
  } as unknown as SelfState
}

function goalState(targetItem: string): GoalState {
  return {
    id: `collect:${targetItem}`,
    description: `collect 1 x ${targetItem}`,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queue(targetItem: string): GoalQueueState {
  const goal: QueuedGoal = {
    id: `g-armour:collect:${targetItem}`,
    kind: 'collect',
    description: `collect 1 x ${targetItem}`,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
  return { depth: 1, current: goal, empty: false, hasImpossible: false, done: 0, goals: [goal] }
}

function hostile(id: number, name: string, distance: number): EntityState {
  return {
    id,
    name,
    kind: name,
    username: null,
    position: { x: SELF.x + distance, y: SELF.y, z: SELF.z },
    distance,
    hostile: true,
    lineOfSight: true,
    heldItem: null,
    health: 16,
    attackedSelf: true,
  } as unknown as EntityState
}

function tableBlock(): BlockState {
  return {
    kind: 'station',
    name: 'crafting_table',
    position: TABLE,
    distance: 1.5,
    diggable: true,
    inReach: true,
    hasAdjacentStandable: true,
    adjacentStandable: { x: TABLE.x, y: TABLE.y - 1, z: TABLE.z },
    yield: 'crafting_table',
    harvestTool: null,
    harvestTier: null,
    visible: true,
  } as unknown as BlockState
}

function build(input: {
  target?: string
  held?: string | null
  counts?: Record<string, number>
  armor?: Record<string, { name: string; count: number }>
  entities?: EntityState[]
  table?: boolean
}): WorldState {
  const counts: Record<string, number> = { ...(input.counts ?? {}) }
  if (input.held !== undefined && input.held !== null) counts[input.held] = (counts[input.held] ?? 0) + 1
  const inventory: InventoryState = {
    slots: [],
    counts,
    totalItems: Object.values(counts).reduce((sum, count) => sum + count, 0),
  }
  const target = input.target ?? 'blaze_rod'
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: selfState(input.held ?? null, input.armor ?? {}),
    inventory,
    entities: input.entities ?? [],
    blocks: [],
    terrain: {
      standable: [SELF, { x: 3, y: 61, z: 0 }, { x: 0, y: 61, z: 3 }],
      escapeCells: [
        { x: -6, y: 61, z: 0 },
        { x: -6, y: 61, z: -5 },
        { x: 0, y: 61, z: -6 },
      ],
    },
    craftingTables: input.table === true ? [{ ...TABLE, name: 'crafting_table', source: 'sensed' }] : [],
    furnaces: [],
    placementSpots: [],
    goal: goalState(target),
    goalQueue: queue(target),
    recentEvents: [],
    signals: {
      consecutiveFailures: 0,
      lastFailureCode: null,
      lastPathStatus: 'idle',
      stalledMs: 0,
      lastPolicyConfidence: null,
      maxConcurrentActions: 0,
      escalationRecommended: false,
      failedCandidates: {},
      knownResources: [],
      lastDamage: null,
    },
  } as unknown as WorldState
}

const OPTIONS: CandidateOptions = {
  ...defaultCandidateOptions,
  recipes: RECIPES,
  reachability: { memory: null, pathProbe: () => 'reachable' as const },
}

function groundedFor(state: WorldState): GroundedCandidatesResult {
  return generateGroundedCandidates(state, OPTIONS)
}

const ids = (candidates: readonly Candidate[]): string[] => candidates.map((candidate) => candidate.id).sort()

/** The four armour item-name suffixes, for the data-driven target count. */
const ARMOR_SUFFIXES: readonly string[] = ['_helmet', '_chestplate', '_leggings', '_boots']
const armorCrafts = (result: GroundedCandidatesResult): Candidate[] =>
  result.candidates.filter((candidate) => candidate.meta.armorCraft === true)
const craftIds = (result: GroundedCandidatesResult): string[] => armorCrafts(result).map((candidate) => candidate.id).sort()
const kitGapLine = (result: GroundedCandidatesResult): string | null =>
  result.combatKitGap === null
    ? null
    : formatCombatKitGap({
        focus: result.combatKitGap.focus,
        target: result.combatKitGap.target,
        distance: result.combatKitGap.distance,
        assessment: result.combatKitGap.assessment,
        heldItem: result.combatKitGap.heldItem,
        prerequisite: result.combatKitGap.prerequisite,
      })

// ---------------------------------------------------------------------------
// (m) the measured state, before/after
// ---------------------------------------------------------------------------

/**
 * The measured fatal-window shape: a `collect blaze_rod` goal, a blaze inside
 * melee reach, no armour worn, whatever the body carries. `armor=0/4` held for a
 * whole run and `COMBAT_KIT_GAP ... missing=[armor] prerequisite=none` stated the
 * gap with no route and no reason.
 */
function fatalWindow(counts: Record<string, number>, table: boolean): GroundedCandidatesResult {
  return groundedFor(
    build({
      target: 'blaze_rod',
      held: 'stone_pickaxe',
      counts,
      entities: [hostile(900, 'blaze', 3)],
      table,
    }),
  )
}

addCase('(m1) BEFORE/AFTER: the armour half of the gap now names the grounded CRAFT route', () => {
  // A sword is CARRIED, so the `sword` half of the assessment is already closed
  // and the marker must speak about armour: it named `prerequisite=none` at
  // 38cbb22 (the only armour prerequisite was an already-carried EQUIP), and now
  // it names the craft that produces the piece. WHICH piece is the deterministic
  // first of the offered armour crafts in slot order (head -> torso -> legs ->
  // feet) - code enumerates, it does not rank.
  const state = build({
    target: 'blaze_rod',
    held: 'diamond_sword',
    counts: { iron_ingot: 8 },
    entities: [hostile(900, 'blaze', 3)],
    table: true,
  })
  const result = groundedFor(state)
  const line = kitGapLine(result)
  const gap = result.combatKitGap
  const offeredCrafts = armorCrafts(result)
  const firstOffered = offeredCrafts[0]?.id ?? 'none'
  return {
    pass:
      gap !== null &&
      gap.assessment.missing.join(',') === 'armor' &&
      gap.assessment.wornArmorCount === 0 &&
      // the marker names a craft that is ACTUALLY on offer, deterministically the
      // first in the generator's slot order (head -> torso -> legs -> feet)
      gap.prerequisite === firstOffered &&
      firstOffered === 'CRAFT:iron_helmet' &&
      line !== null &&
      line.includes('missing=[armor]') &&
      line.includes(`prerequisite=${firstOffered}`),
    detail: `prerequisite=${gap?.prerequisite ?? 'none'} offered=[${offeredCrafts.map((c) => c.id).join(' ')}] line=${line ?? 'none'}`,
  }
})

addCase('(m2) BEFORE/AFTER: when no armour is affordable the shortfall is TYPED, not silent', () => {
  // The measured live kit: 3 iron ingots and no armour. At 38cbb22 the tick said
  // `missing=[armor] prerequisite=none` and nothing anywhere named what was
  // short; now each piece names its material and count.
  const measured = build({
    target: 'blaze_rod',
    held: 'stone_pickaxe',
    counts: { iron_ingot: 3, oak_log: 2 },
    entities: [hostile(900, 'blaze', 3)],
  })
  const result = groundedFor(measured)
  const chest = result.armorCraftRefusals.find((refusal) => refusal.itemName === 'iron_chestplate')
  return {
    pass:
      craftIds(result).length === 0 &&
      result.combatKitGap !== null &&
      result.combatKitGap.assessment.missing.join(',') === 'sword,armor' &&
      chest !== undefined &&
      chest.material === 'iron_ingot' &&
      chest.need === 8 &&
      chest.have === 3 &&
      chest.shortfall === 5 &&
      chest.reason === 'insufficient_material' &&
      chest.worn === null,
    detail:
      `crafts=${JSON.stringify(craftIds(result))} chest=${chest === undefined ? 'none' : formatArmorCraftRefusal(chest)} ` +
      `kit=${kitGapLine(result) ?? 'none'}`,
  }
})

addCase('(m3) the measured window keeps the ATTACK offered and, with iron x8 + a table, adds the crafts', () => {
  const before = fatalWindow({ iron_ingot: 3, oak_log: 2 }, false)
  const after = fatalWindow({ iron_ingot: 8, oak_log: 2 }, true)
  const attackStill = (result: GroundedCandidatesResult): boolean =>
    result.candidates.some((candidate) => candidate.id === 'ATTACK:e900')
  return {
    pass:
      attackStill(before) &&
      attackStill(after) &&
      craftIds(before).length === 0 &&
      craftIds(after).includes('CRAFT:iron_chestplate') &&
      before.armorCraftRefusals.length > 0 &&
      after.armorCraftOffers.some((offer) => offer.itemName === 'iron_chestplate'),
    detail: `before=${JSON.stringify(craftIds(before))} after=${JSON.stringify(craftIds(after))} attacks=${attackStill(after)}`,
  }
})

// ---------------------------------------------------------------------------
// (i) enough iron for a chestplate -> grounded, choosable, WORN
// ---------------------------------------------------------------------------

addCase('(i1) enough iron for a chestplate grounds `CRAFT:iron_chestplate` at the sensed table', () => {
  const result = groundedFor(build({ held: 'stone_pickaxe', counts: { iron_ingot: 8 }, table: true }))
  const chest = armorCrafts(result).find((candidate) => candidate.id === 'CRAFT:iron_chestplate')
  return {
    pass:
      chest !== undefined &&
      chest.kind === 'CRAFT' &&
      chest.itemName === 'iron_chestplate' &&
      chest.requiresTool === false &&
      chest.toolName === null &&
      chest.inReach === true &&
      chest.meta.armorSlot === 'torso' &&
      chest.meta.armorMaterial === 'iron_ingot' &&
      chest.meta.armorNeed === 8 &&
      chest.meta.armorHave === 8 &&
      chest.meta.armorWorn === 'none' &&
      chest.target?.x === TABLE.x &&
      chest.target?.y === TABLE.y &&
      chest.target?.z === TABLE.z &&
      // the executor's craft lease resolves the item through the connected
      // version, so the candidate is only grounded while the version knows it
      registry.itemsByName.iron_chestplate !== undefined,
    detail: `chest=${chest === undefined ? 'none' : JSON.stringify({ id: chest.id, target: chest.target, meta: chest.meta })}`,
  }
})

addCase('(i2) the ARMOR_CRAFT evidence names the piece, the material, the count and the candidate', () => {
  const result = groundedFor(build({ held: 'stone_pickaxe', counts: { iron_ingot: 8 }, table: true }))
  const offer = result.armorCraftOffers.find((entry) => entry.itemName === 'iron_chestplate')
  const line = offer === undefined ? null : formatArmorCraft(offer)
  return {
    pass:
      line !== null &&
      line.startsWith(
        'ARMOR_CRAFT slot=torso item=iron_chestplate material=iron_ingot need=8 have=8 candidate=CRAFT:iron_chestplate worn=none',
      ) &&
      offer?.slot === 'torso',
    detail: line ?? 'none',
  }
})

addCase('(i3) after the craft the piece is carried and the EQUIP affordance wears it (end to end)', async () => {
  // Tick 1: the craft is grounded and offered (Jev chooses it).
  const before = groundedFor(build({ held: 'stone_pickaxe', counts: { iron_ingot: 8 }, table: true }))
  const craft = armorCrafts(before).find((candidate) => candidate.id === 'CRAFT:iron_chestplate')
  if (craft === undefined) return { pass: false, detail: 'no craft offered' }
  // Tick 2: the craft consumed the 8 ingots and produced the piece, so the
  // ordinary armour EQUIP affordance now has something to wear.
  const afterCraft = groundedFor(
    build({ held: 'stone_pickaxe', counts: { iron_ingot: 0, iron_chestplate: 1 }, table: true }),
  )
  const equip = afterCraft.candidates.find((candidate) => candidate.id === 'EQUIP:torso:iron_chestplate')
  if (equip === undefined) return { pass: false, detail: `no equip after craft: ${JSON.stringify(ids(afterCraft.candidates))}` }
  // Tick 3: the real Executor executes that equip and the live armour slot names
  // the piece (EQUIP_ARMOR).
  const fixture = makeFixture({ counts: { iron_chestplate: 1 }, held: 'stone_pickaxe' })
  const { result, messages } = await runAction(fixture, equip)
  const marker = messages.find((message) => message.startsWith('EQUIP_ARMOR'))
  return {
    pass:
      result.status === 'done' &&
      result.verified === true &&
      fixture.armorName('torso') === 'iron_chestplate' &&
      fixture.equipCalls.length === 1 &&
      fixture.equipCalls[0]?.name === 'iron_chestplate' &&
      fixture.equipCalls[0]?.destination === 'torso' &&
      marker === 'EQUIP_ARMOR slot=torso item=iron_chestplate from=inventory replaced=none',
    detail:
      `craft=${craft.id} equip=${equip.id} status=${result.status} verified=${result.verified} ` +
      `worn=${fixture.armorName('torso') ?? 'none'} calls=${JSON.stringify(fixture.equipCalls)} marker=${marker ?? 'none'}`,
  }
})

addCase('(i4) the crafted piece stops being offered once it is worn (the route is self-limiting)', () => {
  const result = groundedFor(
    build({
      held: 'stone_pickaxe',
      counts: { iron_ingot: 8 },
      table: true,
      armor: { torso: { name: 'iron_chestplate', count: 1 } },
    }),
  )
  return {
    pass: !craftIds(result).includes('CRAFT:iron_chestplate'),
    detail: `crafts=${JSON.stringify(craftIds(result))}`,
  }
})

// ---------------------------------------------------------------------------
// (ii) not enough material -> typed refusal, no attempt
// ---------------------------------------------------------------------------

addCase('(ii1) two iron ingots afford NO armour craft at all (no attempt)', () => {
  const result = groundedFor(build({ held: 'stone_pickaxe', counts: { iron_ingot: 2 } }))
  return {
    pass: craftIds(result).length === 0 && result.armorCraftOffers.length === 0,
    detail: `crafts=${JSON.stringify(craftIds(result))} offered=${JSON.stringify(result.armorCraftOffers)}`,
  }
})

addCase('(ii2) the refusal names WHICH material and the exact count, per piece', () => {
  const result = groundedFor(build({ held: 'stone_pickaxe', counts: { iron_ingot: 2 } }))
  const bySlot = new Map(result.armorCraftRefusals.map((refusal) => [refusal.slot, refusal]))
  const chest = bySlot.get('torso')
  const line = chest === undefined ? null : formatArmorCraftRefusal(chest)
  return {
    pass:
      result.armorCraftRefusals.length === 4 &&
      bySlot.get('head')?.need === 5 &&
      bySlot.get('torso')?.need === 8 &&
      bySlot.get('legs')?.need === 7 &&
      bySlot.get('feet')?.need === 4 &&
      chest?.material === 'iron_ingot' &&
      chest?.have === 2 &&
      chest?.shortfall === 6 &&
      line !== null &&
      line.startsWith(
        'ARMOR_CRAFT_REFUSED slot=torso item=iron_chestplate material=iron_ingot need=8 have=2 shortfall=6 reason=insufficient_material worn=none',
      ),
    detail: result.armorCraftRefusals.map(formatArmorCraftRefusal).join(' | ') || 'no refusals',
  }
})

addCase('(ii3) a partial kit offers what it can afford and refuses the rest by name', () => {
  const result = groundedFor(build({ held: 'stone_pickaxe', counts: { iron_ingot: 5 }, table: true }))
  const refused = result.armorCraftRefusals.map((entry) => entry.itemName).sort()
  return {
    pass:
      craftIds(result).join(',') === 'CRAFT:iron_boots,CRAFT:iron_helmet' &&
      refused.join(',') === 'iron_chestplate,iron_leggings' &&
      result.armorCraftRefusals.every((entry) => entry.material === 'iron_ingot' && entry.have === 5),
    detail: `crafts=${JSON.stringify(craftIds(result))} refused=${JSON.stringify(refused)}`,
  }
})

addCase('(ii4) the material is held in full but no station is reachable -> `reason=no_station`', () => {
  const result = groundedFor(build({ held: 'stone_pickaxe', counts: { iron_ingot: 8 } }))
  return {
    pass:
      craftIds(result).length === 0 &&
      result.armorCraftRefusals.length === 4 &&
      result.armorCraftRefusals.every((entry) => entry.reason === 'no_station' && entry.material === null),
    detail: result.armorCraftRefusals.map(formatArmorCraftRefusal).join(' | ') || 'no refusals',
  }
})

addCase('(ii5) a body carrying no armour material at all invents no refusal (nothing to be short OF)', () => {
  const result = groundedFor(build({ held: 'stone_pickaxe', counts: { cobblestone: 3, oak_log: 2 } }))
  return {
    pass:
      result.armorCraftRefusals.length === 0 &&
      result.armorCraftOffers.length === 0 &&
      craftIds(result).length === 0,
    detail: `refusals=${result.armorCraftRefusals.length} crafts=${JSON.stringify(craftIds(result))}`,
  }
})

// ---------------------------------------------------------------------------
// (iii) generality: any material the data version defines, any single piece
// ---------------------------------------------------------------------------

addCase('(iii1) leather from cow drops, gold, diamond and turtle scutes all travel the SAME path', () => {
  const probe = (counts: Record<string, number>): string[] =>
    craftIds(groundedFor(build({ counts, table: true })))
  const leather = probe({ leather: 8 })
  const gold = probe({ gold_ingot: 20 })
  const diamond = probe({ diamond: 4 })
  const turtle = probe({ turtle_scute: 5 })
  return {
    pass:
      leather.join(',') === 'CRAFT:leather_boots,CRAFT:leather_chestplate,CRAFT:leather_helmet,CRAFT:leather_leggings' &&
      gold.join(',') === 'CRAFT:golden_boots,CRAFT:golden_chestplate,CRAFT:golden_helmet,CRAFT:golden_leggings' &&
      // ONE affordable piece is offered exactly like a full set.
      diamond.join(',') === 'CRAFT:diamond_boots' &&
      turtle.join(',') === 'CRAFT:turtle_helmet',
    detail: `leather=${JSON.stringify(leather)} gold=${JSON.stringify(gold)} diamond=${JSON.stringify(diamond)} turtle=${JSON.stringify(turtle)}`,
  }
})

addCase('(iii2) the material named is the recipe INGREDIENT, not a guess from the item name', () => {
  // `turtle_helmet` is not `<material>_helmet`: its material is `turtle_scute`.
  const result = groundedFor(build({ counts: { turtle_scute: 5 }, table: true }))
  const offer = result.armorCraftOffers[0]
  return {
    pass: offer !== undefined && offer.material === 'turtle_scute' && offer.need === 5 && offer.have === 5,
    detail: offer === undefined ? 'none' : formatArmorCraft(offer),
  }
})

addCase('(iii3) an unprovable material (copper) is refused, never guessed at', () => {
  const result = groundedFor(build({ counts: { copper_ingot: 24 }, table: true }))
  return {
    pass:
      craftIds(result).length === 0 &&
      result.armorCraftOffers.length === 0 &&
      result.armorCraftRefusals.length === 0 &&
      RECIPES.resultItems?.().includes('copper_chestplate') === true,
    detail: `crafts=${JSON.stringify(craftIds(result))} refusals=${result.armorCraftRefusals.length} copperRecipe=true`,
  }
})

addCase('(iii4) a worse-but-carried material never crafts a downgrade, and a better one is an upgrade', () => {
  const worse = groundedFor(
    build({
      counts: { leather: 8 },
      table: true,
      armor: { torso: { name: 'diamond_chestplate', count: 1 } },
    }),
  )
  const upgrade = groundedFor(
    build({
      counts: { iron_ingot: 8 },
      table: true,
      armor: { torso: { name: 'leather_chestplate', count: 1 } },
    }),
  )
  const ironChest = upgrade.armorCraftOffers.find((offer) => offer.itemName === 'iron_chestplate')
  return {
    pass:
      !craftIds(worse).includes('CRAFT:leather_chestplate') &&
      craftIds(worse).join(',') === 'CRAFT:leather_boots,CRAFT:leather_helmet,CRAFT:leather_leggings' &&
      craftIds(upgrade).includes('CRAFT:iron_chestplate') &&
      ironChest?.worn === 'leather_chestplate',
    detail: `worse=${JSON.stringify(craftIds(worse))} upgrade=${JSON.stringify(craftIds(upgrade))} worn=${ironChest?.worn ?? 'none'}`,
  }
})

addCase('(iii5) a fully armoured body is offered no armour craft and no refusal', () => {
  const result = groundedFor(
    build({
      counts: { iron_ingot: 8 },
      table: true,
      armor: {
        head: { name: 'diamond_helmet', count: 1 },
        torso: { name: 'diamond_chestplate', count: 1 },
        legs: { name: 'diamond_leggings', count: 1 },
        feet: { name: 'diamond_boots', count: 1 },
      },
    }),
  )
  return {
    pass: craftIds(result).length === 0 && result.armorCraftRefusals.length === 0,
    detail: `crafts=${JSON.stringify(craftIds(result))} refusals=${result.armorCraftRefusals.length}`,
  }
})

addCase('(iii6) the armour TARGET truth is data-driven: every slot of every provable material', () => {
  const producible = RECIPES.resultItems?.() ?? []
  const targets = armorCraftTargets({ worn: {}, producible })
  const kinds = new Set(targets.map((target) => target.itemName.replace(/^[a-z]+_/, '')))
  const armorNames = producible.filter((name) => ARMOR_SUFFIXES.some((suffix) => name.endsWith(suffix)))
  return {
    // 1.21.11 produces 21 armour items (4 copper + 4 leather + 4 golden + 4 iron +
    // 4 diamond + turtle_helmet). Copper has no provable tier, so it is correctly
    // not a target; the other 17 are. Nothing here is a hand-written item list:
    // the set comes from the index and the tiers from the armour truth.
    pass:
      armorNames.length === 21 &&
      targets.length === 17 &&
      kinds.has('helmet') &&
      kinds.has('chestplate') &&
      kinds.has('leggings') &&
      kinds.has('boots') &&
      targets.every((target) => target.worn === null) &&
      !targets.some((target) => target.itemName.startsWith('copper_')) &&
      targets.some((target) => target.itemName === 'turtle_helmet'),
    detail: `producibleArmor=${armorNames.length} targets=${targets.length} kinds=${[...kinds].sort().join(',')}`,
  }
})

// ---------------------------------------------------------------------------
// (iv) byte-identical control for the WEAPON-ARMING lane
// ---------------------------------------------------------------------------

/**
 * The exact bytes the weapon-arming lane's candidate had at the pristine
 * baseline (`38cbb22`, `git worktree add ... --detach 38cbb22`), captured with an
 * UNCHANGED probe run in both trees. The lane's own suite
 * (`test-nether-survival-gear.mts` 21/21) covers its behaviour; this pins that
 * the armour route did not touch a single byte of it.
 */
const BASELINE_WEAPON_ARM_BYTES =
  '{"id":"EQUIP:hand:diamond_sword","kind":"EQUIP","label":"hold diamond_sword (7 damage) instead of stone_pickaxe (sword: a fight is on the table)","itemName":"diamond_sword","requiresTool":false,"toolName":null,"inReach":true,"hasStandableAdjacent":true,"meta":{"tick":7,"slot":"hand","itemName":"diamond_sword","replaced":"stone_pickaxe","weaponDamage":7,"weaponClass":"sword","heldDamage":0,"weaponArm":true}}'

/** The measured fight shape both the weapon lane and this lane run against. */
function measuredFight(): WorldState {
  return build({
    target: 'blaze_rod',
    held: 'stone_pickaxe',
    counts: { diamond_sword: 1, iron_ingot: 8 },
    table: true,
    entities: [hostile(45891, 'magma_cube', 2)],
  })
}

addCase('(iv1) the weapon-arm candidate is byte-identical to the 38cbb22 baseline', () => {
  const result = groundedFor(measuredFight())
  const arm = result.candidates.filter((candidate) => candidate.id.startsWith('EQUIP:hand:'))
  const bytes = arm.map((candidate) =>
    JSON.stringify({
      id: candidate.id,
      kind: candidate.kind,
      label: candidate.label,
      itemName: candidate.itemName,
      requiresTool: candidate.requiresTool,
      toolName: candidate.toolName,
      inReach: candidate.inReach,
      hasStandableAdjacent: candidate.hasStandableAdjacent,
      meta: candidate.meta,
    }),
  )
  return {
    pass: bytes.length === 1 && bytes[0] === BASELINE_WEAPON_ARM_BYTES,
    detail: `bytes=${bytes.length} identical=${bytes[0] === BASELINE_WEAPON_ARM_BYTES}`,
  }
})

addCase('(iv2) the armour crafts ADD to the offer: no pre-existing candidate is displaced', () => {
  const result = groundedFor(measuredFight())
  // The pristine 38cbb22 id set for this exact fixture. The only difference is
  // the four armour crafts (verified by diffing an unchanged probe across a
  // pristine worktree); every other id, kind and label is untouched.
  const baselineIds =
    'ATTACK:e45891 EQUIP:hand:diamond_sword MOVE:p0_61_3 MOVE:p3_61_0 RETREAT:p-6_61_-5 RETREAT:p-6_61_0 RETREAT:p0_61_-6 WAIT'
  const added = new Set(['CRAFT:iron_boots', 'CRAFT:iron_chestplate', 'CRAFT:iron_helmet', 'CRAFT:iron_leggings'])
  const all = ids(result.candidates)
  const withoutArmor = all.filter((id) => !added.has(id))
  return {
    pass: withoutArmor.join(' ') === baselineIds && all.length === baselineIds.split(' ').length + 4,
    detail: `withoutArmor=[${withoutArmor.join(' ')}] all=[${all.join(' ')}]`,
  }
})

addCase('(iv3) the armour craft never withdraws the focus\'s own producer-search route', () => {
  // Measured regression found while landing this: the armour craft counted as an
  // "advancing route" for the ACTIVE focus, so `hasAdvancingGoalRoute` flipped and
  // the goal's own `meta.producerSearch` MOVEs disappeared - the self-care
  // affordance crowded out the goal. It must add, never replace. (The search arm
  // fires on the measured shape where the sensed hostile is NOT the focus's
  // producer, so the ATTACK is not itself a route to `blaze_rod`.)
  const shape = (iron: number): WorldState =>
    build({
      target: 'blaze_rod',
      held: 'stone_pickaxe',
      counts: { diamond_sword: 1, ...(iron > 0 ? { iron_ingot: iron } : {}) },
      table: true,
      entities: [hostile(45891, 'magma_cube', 2)],
    })
  const withIron = groundedFor(shape(8))
  const withoutIron = groundedFor(shape(0))
  const search = (result: GroundedCandidatesResult): string[] =>
    ids(result.candidates).filter((id) =>
      result.candidates.some((candidate) => candidate.id === id && candidate.meta.producerSearch === true),
    )
  return {
    pass:
      craftIds(withIron).length === 4 &&
      search(withIron).length > 0 &&
      search(withIron).join(',') === search(withoutIron).join(','),
    detail: `search(withIron)=${JSON.stringify(search(withIron))} search(without)=${JSON.stringify(search(withoutIron))} crafts=${JSON.stringify(craftIds(withIron))}`,
  }
})

// ---------------------------------------------------------------------------
// (v) evidence: typed + mirrored
// ---------------------------------------------------------------------------

addCase('(v1) both new markers are MIRRORED, so they reach buddy.log as well as run.jsonl', () => {
  const tokens = [ARMOR_CRAFT, ARMOR_CRAFT_REFUSED]
  const missing = tokens.filter((token) => !MIRRORED_MARKERS.has(token))
  const resolved = tokens.map((token) => mirroredEventToken(`${token} slot=torso item=iron_chestplate`))
  return {
    pass: missing.length === 0 && resolved[0] === ARMOR_CRAFT && resolved[1] === ARMOR_CRAFT_REFUSED,
    detail: `missing=[${missing.join(',')}] tokens=[${resolved.join(',')}]`,
  }
})

addCase('(v2) the formatters are stable prefixes and the refusal always carries material + count', () => {
  const offer = groundedFor(build({ counts: { iron_ingot: 8 }, table: true })).armorCraftOffers.find(
    (entry) => entry.itemName === 'iron_chestplate',
  )
  const refusal = groundedFor(build({ counts: { iron_ingot: 2 } })).armorCraftRefusals.find(
    (entry) => entry.itemName === 'iron_chestplate',
  )
  const offerLine = offer === undefined ? '' : formatArmorCraft(offer)
  const refusalLine = refusal === undefined ? '' : formatArmorCraftRefusal(refusal)
  return {
    pass:
      offerLine.startsWith(`${ARMOR_CRAFT} `) &&
      offerLine.includes('material=iron_ingot need=8 have=8') &&
      offerLine.includes('candidate=CRAFT:iron_chestplate') &&
      refusalLine.startsWith(`${ARMOR_CRAFT_REFUSED} `) &&
      refusalLine.includes('material=iron_ingot need=8 have=2 shortfall=6') &&
      refusalLine.includes('reason=insufficient_material'),
    detail: `${offerLine} || ${refusalLine}`,
  }
})

addCase('(v3) the armour gap is either ROUTED or EXPLAINED: never silent', () => {
  // The rule the two markers implement: whenever the required kill reports
  // `missing=[armor]` and no EQUIP is on offer, the tick must carry either a
  // grounded armour craft, or a typed refusal, or the body holds no armour
  // material at all (nothing to be short of).
  const shapes: Array<{ label: string; state: WorldState }> = [
    { label: '8 iron + table', state: build({ counts: { iron_ingot: 8 }, table: true, entities: [hostile(900, 'blaze', 3)] }) },
    { label: '8 iron no table', state: build({ counts: { iron_ingot: 8 }, entities: [hostile(900, 'blaze', 3)] }) },
    { label: '3 iron', state: build({ counts: { iron_ingot: 3 }, entities: [hostile(900, 'blaze', 3)] }) },
    { label: 'leather x3', state: build({ counts: { leather: 3 }, table: true, entities: [hostile(900, 'blaze', 3)] }) },
    { label: 'nothing carried', state: build({ entities: [hostile(900, 'blaze', 3)] }) },
  ]
  const verdicts = shapes.map(({ label, state }) => {
    const result = groundedFor(state)
    if (result.combatKitGap === null) return `${label}:no-gap`
    const missingArmor = result.combatKitGap.assessment.missing.includes('armor')
    const routed = craftIds(result).length > 0 || result.candidates.some((c) => c.kind === 'EQUIP' && c.meta.slot !== 'hand')
    const explained = result.armorCraftRefusals.length > 0
    const holdsNothing = result.armorCraftOffers.length === 0 && result.armorCraftRefusals.length === 0
    const ok = !missingArmor || routed || explained || holdsNothing
    return `${label}:${ok ? 'ok' : 'SILENT'}${routed ? '/routed' : ''}${explained ? '/explained' : ''}${holdsNothing ? '/nothing-held' : ''}`
  })
  return {
    pass: verdicts.every((verdict) => !verdict.includes('SILENT')),
    detail: verdicts.join(' '),
  }
})

// ---------------------------------------------------------------------------
// executor fixture: recording actuation port + a mutable armor model
// ---------------------------------------------------------------------------

interface Fixture {
  bot: Bot
  port: ActuationPort
  equipCalls: Array<{ name: string; destination: string }>
  armorName: (slot: ArmorSlot) => string | null
}

function makeFixture(opts: { counts?: Record<string, number>; held?: string | null }): Fixture {
  const feet = new Vec3(SELF.x, SELF.y, SELF.z)
  const counts = { ...(opts.counts ?? {}) }
  const slots: Array<{ name: string; count: number; slot: number; type: number } | null> = new Array(46).fill(null)
  const carried: Array<{ name: string; count: number; slot: number; type: number }> = []
  let nextSlot = 9
  let nextType = 100
  for (const [name, count] of Object.entries(counts)) {
    if (count <= 0) continue
    const item = { name, count, slot: nextSlot, type: nextType++ }
    slots[nextSlot] = item
    carried.push(item)
    nextSlot += 1
  }
  const equipCalls: Array<{ name: string; destination: string }> = []
  const emitter = new EventEmitter()
  const applyEquip = (item: { name: string }, destination: string): void => {
    if (destination === 'hand') {
      bot.heldItem = { name: item.name, count: 1, slot: 36 } as Bot['heldItem']
      return
    }
    if (destination in ARMOR_SLOT_INDEX) {
      const index = ARMOR_SLOT_INDEX[destination as ArmorSlot]
      slots[index] = { name: item.name, count: 1, slot: index, type: 1 }
    }
  }
  const bot = {
    registry,
    entity: {
      id: 1,
      position: feet,
      yaw: 0,
      pitch: 0,
      onGround: true,
      width: 0.6,
      height: 1.8,
      offset: (x: number, y: number, z: number) => feet.offset(x, y, z),
      clone: () => feet.clone(),
      distanceTo: (other: { x: number; y: number; z: number }) => feet.distanceTo(new Vec3(other.x, other.y, other.z)),
    },
    _client: { write: () => true },
    physicsEnabled: true,
    health: 20,
    food: 20,
    time: { isDay: true },
    game: { gameMode: 'survival', dimension: 'overworld' },
    entities: {} as Record<number, unknown>,
    inventory: {
      slots,
      items: () => carried.filter((item) => (counts[item.name] ?? 0) > 0),
      count: () => 0,
    },
    heldItem: null as { name: string; count: number; slot: number } | null,
    blockAt: () => null,
    on: (event: string, handler: (...args: unknown[]) => void) => {
      emitter.on(event, handler)
      return bot
    },
    removeListener: (event: string, handler: (...args: unknown[]) => void) => {
      emitter.removeListener(event, handler)
      return bot
    },
    setControlState: () => undefined,
    lookAt: async () => undefined,
    equip: async (item: { name: string }, destination: string) => {
      equipCalls.push({ name: item.name, destination })
      applyEquip(item, destination)
    },
    canDigBlock: () => true,
    dig: async () => undefined,
    stopDigging: () => undefined,
    attack: () => undefined,
    pathfinder: {
      movements: null as unknown,
      setMovements: (movements: unknown) => {
        bot.pathfinder.movements = movements
      },
      setGoal: () => undefined,
      stop: () => undefined,
      getPathTo: () => ({ status: 'noPath', path: [] }),
    },
  }
  if (opts.held !== undefined && opts.held !== null) {
    bot.heldItem = { name: opts.held, count: 1, slot: 36 }
  }
  const port: ActuationPort = {
    generationId: 'gen-armour-test',
    assertLease: () => undefined,
    pathTo: () => undefined,
    stopPath: () => undefined,
    setControls: () => undefined,
    clearControls: () => undefined,
    lookAt: async () => undefined,
    dig: async () => undefined,
    placeBlock: async () => undefined,
    activateItem: async () => undefined,
    activateBlock: async () => undefined,
    equip: async (item, destination) => {
      const dest = Array.isArray(destination) ? String(destination[0]) : String(destination ?? 'hand')
      equipCalls.push({ name: item.name, destination: dest })
      applyEquip(item, dest)
    },
    collect: async () => undefined,
    craft: async () => undefined,
    openContainer: async () => undefined,
    withdrawFromContainer: async () => undefined,
    writeMovementPacket: () => undefined,
    setPose: () => undefined,
  }
  return {
    bot: bot as unknown as Bot,
    port,
    equipCalls,
    armorName: (slot) => slots[ARMOR_SLOT_INDEX[slot]]?.name ?? null,
  }
}

async function runAction(
  fixture: Fixture,
  candidate: Candidate,
): Promise<{ result: Awaited<ReturnType<Executor['claim']>['completion']>; messages: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'armour-'))
  const logPath = join(dir, 'run.jsonl')
  const executor = new Executor(fixture.bot, new EventLogger(new JsonlWriter(logPath), false), {
    ...defaultExecutorOptions,
    actuation: 'pathfinder',
    actuationPort: fixture.port,
  })
  const result = await fixtureClaim(executor, candidate).completion
  const messages = readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { message: string }).message)
  return { result, messages }
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

let total = 0
let failures = 0
for (const testCase of cases) {
  const outcome = await testCase.run()
  total += 1
  if (!outcome.pass) failures += 1
  process.stdout.write(`${outcome.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${outcome.detail}\n`)
}
process.stdout.write(`\n${total - failures}/${total} armour-route cases passed\n`)
if (failures > 0) process.exit(1)
