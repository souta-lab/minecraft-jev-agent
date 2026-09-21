// test-death-resume-settle.mts - M3_CRITICAL regression: a death/respawn reset
// must decide the ladder rung from the SETTLED post-respawn inventory, never
// from a single momentary observation. A momentary EMPTY read must not retire
// the frontier; a momentary NON-EMPTY read (the retained pre-death window) must
// not resume a rung the emptied body cannot execute; a genuinely empty settled
// inventory must still reset to wood.
import {
  sameInventoryCounts,
  settledInventoryBasis,
  settleInventoryAfterRespawn,
  shouldSettleRespawnInventory,
  type InventoryCounts,
} from './inventory-settle.ts'
import { buildLadder, computeFrontier, deriveResumeRung } from './planner.ts'
import { emptyWorldMemory } from './resident-types.ts'
import type { ResidentWorldMemory } from './resident-types.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const world = (over: Partial<ResidentWorldMemory> = {}): ResidentWorldMemory => ({ ...emptyWorldMemory(), ...over })

// The inventory held at the measured 19:05:35 death (pre-loss telemetry). Under
// keepInventory this is what the settled post-respawn read must reproduce.
const KIT: InventoryCounts = {
  dirt: 102,
  flint_and_steel: 1,
  diamond: 3,
  soul_sand: 13,
  stick: 5,
  furnace: 1,
  oak_log: 4,
  iron_ingot: 2,
  raw_copper: 10,
  gravel: 13,
  bone: 1,
  soul_soil: 2,
  birch_sapling: 2,
  oak_sapling: 4,
  leaf_litter: 35,
  cobblestone: 598,
  diamond_pickaxe: 1,
  andesite: 25,
  coal: 3,
  raw_iron: 21,
  diorite: 8,
  granite: 35,
  diamond_sword: 1,
}

const woodRungGoal = (goals: ReadonlyArray<{ targetItem?: string | null; requiredCount?: number | null }>): boolean =>
  goals.some((goal) => goal.targetItem === 'log' && (goal.requiredCount ?? 1) >= 3)

// --- (a) death + keep_inventory with a transient empty read ---------------
addCase('(a) a transient empty read settles to the kept kit and preserves the frontier', () => {
  const settled = settledInventoryBasis([{}, KIT], 600)
  const resume = deriveResumeRung(settled.counts, world({ portalVerified: false, dimension: 'minecraft:the_nether' }))
  const ladder = buildLadder(settled.counts, world({ portalVerified: false, dimension: 'minecraft:the_nether' }), undefined, {
    resumeRungIndex: resume.rungIndex,
  })
  const frontier = computeFrontier(settled.counts, world({ portalVerified: false, dimension: 'minecraft:the_nether' }))
  const noWoodPickaxe = !ladder.goals.some((goal) => goal.targetItem === 'wooden_pickaxe')
  return {
    pass:
      sameInventoryCounts(settled.counts, KIT) &&
      settled.observedChange === true &&
      settled.empty === false &&
      resume.rungId === 'blaze_rods' &&
      resume.rungIndex === 15 &&
      resume.invEmpty === false &&
      ladder.rungId === 'blaze_rods' &&
      frontier.rungId === 'blaze_rods' &&
      !woodRungGoal(ladder.goals) &&
      noWoodPickaxe,
    detail: `settled=${settled.readings}reads changed=${settled.observedChange} resume=${resume.rungId}@${resume.rungIndex} ladder=${ladder.rungId} frontier=${frontier.rungId} woodGoal=${woodRungGoal(ladder.goals)} woodPickaxe=${!noWoodPickaxe}`,
  }
})

addCase('(a) a kept kit respawning in the overworld resumes above wood, never the wood prerequisite chain', () => {
  const settled = settledInventoryBasis([{}, KIT, KIT], 600)
  const live = world({ portalVerified: true, dimension: 'minecraft:overworld' })
  const resume = deriveResumeRung(settled.counts, live)
  const ladder = buildLadder(settled.counts, live, undefined, { resumeRungIndex: resume.rungIndex })
  return {
    pass:
      resume.rungId !== 'wood' &&
      resume.rungIndex >= 14 &&
      resume.invEmpty === false &&
      ladder.rungId === resume.rungId &&
      !woodRungGoal(ladder.goals) &&
      !ladder.goals.some((goal) => goal.targetItem === 'wooden_pickaxe'),
    detail: `resume=${resume.rungId}@${resume.rungIndex} ladder=${ladder.rungId} goals=[${ladder.goals.map((g) => g.targetItem).join(',')}]`,
  }
})

// --- (b) genuinely empty post-death inventory (no keepInventory) -----------
addCase('(b) a genuinely empty settled post-death inventory still resets to wood', () => {
  const settled = settledInventoryBasis([{}, {}, {}, {}], 600)
  const resume = deriveResumeRung(settled.counts, world())
  const ladder = buildLadder(settled.counts, world(), undefined, { resumeRungIndex: resume.rungIndex })
  return {
    pass:
      settled.empty === true &&
      settled.observedChange === false &&
      resume.rungId === 'wood' &&
      resume.rungIndex === 0 &&
      resume.invEmpty === true &&
      ladder.rungId === 'wood' &&
      woodRungGoal(ladder.goals),
    detail: `empty=${settled.empty} changed=${settled.observedChange} resume=${resume.rungId}@${resume.rungIndex} invEmpty=${resume.invEmpty} woodGoal=${woodRungGoal(ladder.goals)}`,
  }
})

// --- (c) two contradictory reads in quick succession -----------------------
addCase('(c) contradictory reads [empty, kit] settle on the kit', () => {
  const settled = settledInventoryBasis([{}, KIT], 600)
  return {
    pass: sameInventoryCounts(settled.counts, KIT) && settled.observedChange === true && settled.empty === false,
    detail: `settled=${JSON.stringify(settled.counts)} changed=${settled.observedChange}`,
  }
})

addCase('(c) contradictory reads [kit, empty] settle on empty, not on the retained window', () => {
  const settled = settledInventoryBasis([KIT, {}], 600)
  const resume = deriveResumeRung(settled.counts, world())
  return {
    pass:
      settled.empty === true &&
      settled.observedChange === true &&
      Object.keys(settled.counts).length === 0 &&
      resume.rungId === 'wood' &&
      resume.invEmpty === true,
    detail: `settledKeys=${Object.keys(settled.counts).length} changed=${settled.observedChange} resume=${resume.rungId}`,
  }
})

addCase('(c) three contradictory reads settle on the last observation only', () => {
  const settled = settledInventoryBasis([{}, KIT, {}], 600)
  return {
    pass: settled.empty === true && settled.observedChange === true && settled.readings === 3,
    detail: `empty=${settled.empty} changed=${settled.observedChange} readings=${settled.readings}`,
  }
})

addCase('(c) the async settle runs the full window and returns the last reading', async () => {
  const scripted: InventoryCounts[] = [{}, KIT, KIT, KIT, KIT, KIT, KIT]
  let index = 0
  let clock = 0
  const settled = await settleInventoryAfterRespawn(
    () => scripted[Math.min(index++, scripted.length - 1)] ?? {},
    {
      settleWindowMs: 600,
      pollIntervalMs: 100,
      now: () => clock,
      sleep: (ms) => {
        clock += ms
        return Promise.resolve()
      },
    },
  )
  return {
    pass:
      sameInventoryCounts(settled.counts, KIT) &&
      settled.observedChange === true &&
      settled.readings === 7 &&
      settled.waitedMs === 600,
    detail: `reads=${settled.readings} waitedMs=${settled.waitedMs} changed=${settled.observedChange} settledKeys=${Object.keys(settled.counts).length}`,
  }
})

// --- (d) a normal (non-death) read is unchanged ----------------------------
addCase('(d) only the death reset settles; ordinary and inventory-resume reads are untouched', () => {
  const normal = settledInventoryBasis([KIT])
  const gatedDeath = shouldSettleRespawnInventory('death')
  const gatedNull = shouldSettleRespawnInventory(null)
  const gatedResume = shouldSettleRespawnInventory('inventory-resume')
  const resume = deriveResumeRung(KIT, world({ portalVerified: false, dimension: 'minecraft:the_nether' }))
  return {
    pass:
      gatedDeath === true &&
      gatedNull === false &&
      gatedResume === false &&
      normal.readings === 1 &&
      normal.observedChange === false &&
      sameInventoryCounts(normal.counts, KIT) &&
      resume.rungId === 'blaze_rods',
    detail: `death=${gatedDeath} null=${gatedNull} resume=${gatedResume} normalReads=${normal.readings} rung=${resume.rungId}`,
  }
})

let failures = 0
process.stdout.write('death/respawn settled-inventory regression (M3_CRITICAL)\n')
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n      ${observed.detail}\n`)
}
process.stdout.write(`${cases.length - failures}/${cases.length} death-resume-settle cases passed\n`)
if (failures > 0) process.exit(1)
