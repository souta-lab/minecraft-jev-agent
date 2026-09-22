// test-death-resume-durable.mts - NON-LOSSY death resume regression.
//
// MEASURED DEFECT (run-mubobiq6-12onv, source 220b9db): per-world
// `keep_inventory=true` preserved the kit across every death (`itemsLost=136`
// then `138`, `LADDER_RESUME ... reason=death invEmpty=false` with `iron_ingot 3`
// still held), yet the ladder re-entered at `charcoal` (rungIndex=6) every time
// and re-did work the same run had already completed - while the durable world
// record still held a lit+verified portal (`portal_verified=true` in the run
// artifact) and the run's own committed frontier had once reached
// blaze_rods/15. The reset itself is a HOST lifecycle action; the loss was that
// the fresh generation re-derived its rung from the retained inventory ALONE
// (`deriveResumeRung`) and then wrote that shrunken rung back into the durable
// ledger basis (`proposeLedger`).
//
// Fixed semantics under test:
//   - the resume scan starts above the run's DURABLE floor: the archived ledger's
//     committed record (scoped by worldKey) merged with durable world outcomes;
//   - a genuine total loss (empty usable kit) still resets to wood, and that
//     generation discards the durable record for its whole lifetime so the erased
//     position cannot be written back;
//   - a candidate whose own prerequisite no longer holds still falls back to the
//     rung the retained kit supports, with the existing fallbackFrom/fallbackNeed
//     telemetry;
//   - the soft (`simdeath`) rehearsal path is unchanged: it restores the durable
//     record, so the rehearsal does not cost the ladder; the hard rehearsal tosses
//     the kit and therefore resets like a genuine loss.
import type { GoalQueueSnapshot, GoalStatus, QueuedGoal } from '../jev-agent/src/goalQueue.ts'
import { emptyWorldMemory } from './resident-types.ts'
import type { ResidentWorldMemory } from './resident-types.ts'
import { buildLadder, computeFrontier, deriveResumeRung, rungIndexById } from './planner.ts'
import {
  durableLadderProgressFromLedger,
  durableProgressForGeneration,
  evaluateLedgerRestoreBasis,
  selectLedgerSnapshot,
} from './generation-entry.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const WORLD_KEY = '127.0.0.1:25565|minecraft:overworld|1'

const world = (over: Partial<ResidentWorldMemory> = {}): ResidentWorldMemory => ({ ...emptyWorldMemory(), ...over })

/** The measured durable world memory of run-mubobiq6-12onv (overworld key). */
const LIVE_WORLD = world({
  craftingTables: [{ x: 24, y: 64, z: 8 }],
  furnaces: [{ x: 24, y: 64, z: 9 }],
  knownPortalSites: [
    { x: 25, y: 66, z: 9, widthAxis: 'x', dimension: 'minecraft:overworld', worldEpoch: 1, lastVerifiedAt: 1 },
  ],
  discoveredOres: ['coal_ore', 'copper_ore', 'iron_ore'],
})

/**
 * The measured post-respawn kit (LADDER_RESUME, 2026-09-21T22:24:02.717Z). The
 * tool the run had been using is gone, but the materials it needs are retained.
 */
const MEASURED_KIT: Record<string, number> = {
  oak_log: 1,
  oak_planks: 5,
  stick: 4,
  leaf_litter: 19,
  raw_iron: 2,
  dirt: 33,
  cobblestone: 60,
  iron_ingot: 3,
  raw_copper: 11,
}

function goal(
  id: string,
  kind: QueuedGoal['kind'],
  targetItem: string | null,
  status: GoalStatus,
  requiredCount = 1,
): QueuedGoal {
  return {
    id,
    kind,
    description: `${kind} ${targetItem ?? ''}`.trim(),
    targetItem,
    requiredCount,
    startCount: 0,
    haveCount: status === 'done' ? requiredCount : 0,
    status,
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

/** The measured class-A ledger at death: basis charcoal/6, three unfinished rows. */
const MEASURED_LEDGER: GoalQueueSnapshot = {
  counter: 128,
  goals: [
    goal('g4:smelt:charcoal', 'smelt', 'charcoal', 'active'),
    goal('g127:craft:furnace', 'craft', 'furnace', 'impossible'),
    goal('g128:place:furnace', 'place', 'furnace', 'impossible'),
  ],
  basis: { worldKey: WORLD_KEY, frontierRungId: 'charcoal', frontierRungIndex: 6 },
}

function ledger(frontierRungId: string, frontierRungIndex: number, goals: QueuedGoal[] = []): GoalQueueSnapshot {
  return { counter: goals.length, goals, basis: { worldKey: WORLD_KEY, frontierRungId, frontierRungIndex } }
}

const logSink: Array<{ event: string; detail: Record<string, unknown> | undefined }> = []
const emit = (event: string, detail?: Record<string, unknown>): void => {
  logSink.push({ event, detail })
}

// --- (a) non-lossy death resumes the durable rung ---------------------------

addCase('(a) the measured non-lossy death resumes the durable rung, not the inventory-implied charcoal rung', () => {
  logSink.length = 0
  const progress = durableLadderProgressFromLedger(MEASURED_LEDGER, WORLD_KEY, MEASURED_KIT, LIVE_WORLD)
  const resume = deriveResumeRung(MEASURED_KIT, LIVE_WORLD, emit, progress)
  const ladder = buildLadder(MEASURED_KIT, LIVE_WORLD, emit, {
    resumeRungIndex: resume.rungIndex,
    portalFrameBlocks: 10,
    knownFurnaces: LIVE_WORLD.furnaces.length,
    placedFurnacesNear: 0,
  })
  // The pre-fix behaviour for the same kit/world pair: inventory-only derivation.
  const inventoryOnly = deriveResumeRung(MEASURED_KIT, LIVE_WORLD)
  const reDoneItems = new Set(['charcoal', 'raw_iron', 'iron_ingot', 'iron_pickaxe', 'wooden_pickaxe', 'diamond', 'obsidian'])
  const reDone = ladder.goals.filter((goal) => typeof goal.targetItem === 'string' && reDoneItems.has(goal.targetItem))
  const firstGoal = ladder.goals[0]?.description ?? ''
  const grid = logSink.find((entry) => entry.event === 'LADDER_RESUME_FALLBACK')
  return {
    pass:
      progress?.rungId === 'nether_portal' &&
      progress?.rungIndex === rungIndexById('nether_portal') &&
      progress?.sources.includes('ledger-basis') === true &&
      progress?.sources.includes('world-outcome') === true &&
      resume.invEmpty === false &&
      resume.resumeBasis === 'durable' &&
      resume.rungId === 'enter_nether' &&
      resume.rungIndex === rungIndexById('enter_nether') &&
      resume.achievedRungId === 'nether_portal' &&
      resume.achievedRungIndex === rungIndexById('nether_portal') &&
      resume.fallbackFrom === null &&
      ladder.rungId === resume.rungId &&
      ladder.goals.length > 0 &&
      reDone.length === 0 &&
      firstGoal.includes('enter the lit nether portal') &&
      grid === undefined &&
      inventoryOnly.rungId === 'charcoal' &&
      inventoryOnly.rungIndex === 6 &&
      durableProgressForGeneration(resume, progress) !== null,
    detail: `progress=${progress?.rungId}@${progress?.rungIndex} sources=${progress?.sources.join('+')} resume=${resume.rungId}@${resume.rungIndex} basis=${resume.resumeBasis} achieved=${resume.achievedRungId} inventoryOnly=${inventoryOnly.rungId}@${inventoryOnly.rungIndex} reDone=[${reDone.map((g) => g.targetItem).join(',')}] goals=[${ladder.goals.map((g) => g.targetItem).join(',')}]`,
  }
})

addCase('(a) a mid-ladder kit resumes the ledger frontier above the inventory-implied rung', () => {
  logSink.length = 0
  const kit = { iron_ingot: 3, iron_pickaxe: 1, diamond: 3, cobblestone: 60, crafting_table: 1, furnace: 1 }
  const stations = world({ craftingTables: [{ x: 1, y: 64, z: 1 }], furnaces: [{ x: 1, y: 64, z: 2 }] })
  // The ledger was committed from frontier=diamond_pickaxe: this run had already
  // collected the diamond, and the diamond pickaxe is the work that was pending.
  const progress = durableLadderProgressFromLedger(
    ledger('diamond_pickaxe', rungIndexById('diamond_pickaxe')),
    WORLD_KEY,
    kit,
    stations,
  )
  const resume = deriveResumeRung(kit, stations, emit, progress)
  const ladder = buildLadder(kit, stations, emit, { resumeRungIndex: resume.rungIndex })
  const inventoryOnly = deriveResumeRung(kit, stations)
  const historical = ladder.goals.filter(
    (goal) => typeof goal.targetItem === 'string' && ['charcoal', 'raw_iron', 'iron_ingot', 'iron_pickaxe'].includes(goal.targetItem),
  )
  return {
    pass:
      progress?.sources.join('+') === 'ledger-basis' &&
      resume.rungId === 'diamond_pickaxe' &&
      resume.rungIndex === rungIndexById('diamond_pickaxe') &&
      resume.resumeBasis === 'durable' &&
      resume.achievedRungId === 'diamond' &&
      ladder.rungId === 'diamond_pickaxe' &&
      ladder.goals[0]?.targetItem === 'diamond_pickaxe' &&
      historical.length === 0 &&
      inventoryOnly.rungId === 'charcoal',
    detail: `resume=${resume.rungId}@${resume.rungIndex} basis=${resume.resumeBasis} achieved=${resume.achievedRungId} inventoryOnly=${inventoryOnly.rungId}@${inventoryOnly.rungIndex} head=${ladder.goals[0]?.targetItem} historical=[${historical.map((g) => g.targetItem).join(',')}]`,
  }
})

// --- (b) genuine loss still resets ------------------------------------------

addCase('(b) a genuinely empty kit still resets to wood and the durable record is discarded', () => {
  logSink.length = 0
  const durable = durableLadderProgressFromLedger(MEASURED_LEDGER, WORLD_KEY, {}, LIVE_WORLD)
  const resume = deriveResumeRung({}, LIVE_WORLD, emit, durable)
  const ladder = buildLadder({}, LIVE_WORLD, emit, { resumeRungIndex: resume.rungIndex })
  const woodGoal = ladder.goals.some((goal) => goal.targetItem === 'log' && (goal.requiredCount ?? 1) >= 3)
  const latched = durableProgressForGeneration(resume, durable)
  // With the latch the re-climb is inventory-shaped again: the erased position is
  // not written back into the ledger basis by proposeLedger/status.
  const afterLatch = deriveResumeRung({ oak_log: 3 }, LIVE_WORLD, emit, latched)
  return {
    pass:
      durable !== null &&
      resume.rungId === 'wood' &&
      resume.rungIndex === 0 &&
      resume.invEmpty === true &&
      resume.resumeBasis === 'inventory' &&
      resume.achievedRungIndex === -1 &&
      resume.achievedRungId === null &&
      resume.achievedSources.length === 0 &&
      ladder.rungId === 'wood' &&
      woodGoal &&
      latched === null &&
      afterLatch.invEmpty === false &&
      afterLatch.resumeBasis === 'inventory' &&
      afterLatch.achievedRungIndex === -1,
    detail: `durable=${durable?.rungId}@${durable?.rungIndex} resume=${resume.rungId}@${resume.rungIndex} invEmpty=${resume.invEmpty} basis=${resume.resumeBasis} ladder=${ladder.rungId} woodGoal=${woodGoal} latched=${latched === null ? 'null' : 'kept'} afterLatch=${afterLatch.rungId}@${afterLatch.rungIndex}/${afterLatch.resumeBasis}`,
  }
})

addCase('(b) an unusable-only kit is still a genuine loss, and a foreign worldKey never raises the floor', () => {
  const unusable = deriveResumeRung({ dirt: 5, gravel: 3 }, LIVE_WORLD, undefined, durableLadderProgressFromLedger(MEASURED_LEDGER, WORLD_KEY, {}, LIVE_WORLD))
  const otherWorld = durableLadderProgressFromLedger(MEASURED_LEDGER, '127.0.0.1:25565|minecraft:the_nether|1', MEASURED_KIT, world())
  const otherEpoch = durableLadderProgressFromLedger(
    { ...MEASURED_LEDGER, basis: { worldKey: '127.0.0.1:25565|minecraft:overworld|2', frontierRungId: 'charcoal', frontierRungIndex: 6 } },
    WORLD_KEY,
    MEASURED_KIT,
    world(),
  )
  return {
    pass:
      unusable.invEmpty === true &&
      unusable.rungId === 'wood' &&
      unusable.achievedRungIndex === -1 &&
      otherWorld === null &&
      otherEpoch === null,
    detail: `unusable=${unusable.rungId}/${unusable.invEmpty} otherDimension=${otherWorld === null ? 'null' : 'floor'} otherEpoch=${otherEpoch === null ? 'null' : 'floor'}`,
  }
})

// --- (c) a candidate whose prerequisite does not hold falls back ------------

addCase('(c) a lost tool falls back to the rung the retained kit supports, with typed fallback telemetry', () => {
  logSink.length = 0
  const kit = { iron_ingot: 3, cobblestone: 60, raw_iron: 2, crafting_table: 1, furnace: 1 }
  const stations = world({ craftingTables: [{ x: 1, y: 64, z: 1 }], furnaces: [{ x: 1, y: 64, z: 2 }] })
  // The run reached (and used) an iron pickaxe; the retained kit no longer has one.
  const durable = durableLadderProgressFromLedger(
    ledger('iron_pickaxe', rungIndexById('iron_pickaxe') + 1),
    WORLD_KEY,
    kit,
    stations,
  )
  const resume = deriveResumeRung(kit, stations, emit, durable)
  const fallback = logSink.find((entry) => entry.event === 'LADDER_RESUME_FALLBACK')
  const ladder = buildLadder(kit, stations, emit, { resumeRungIndex: resume.rungIndex })
  return {
    pass:
      durable?.rungId === 'iron_pickaxe' &&
      resume.rungId === 'iron_pickaxe' &&
      resume.rungIndex === rungIndexById('iron_pickaxe') &&
      resume.fallbackFrom === 'diamond' &&
      resume.fallbackNeed === 'iron_pickaxe' &&
      resume.resumeBasis === 'durable' &&
      fallback?.detail?.from === 'diamond' &&
      fallback?.detail?.need === 'iron_pickaxe' &&
      fallback?.detail?.to === 'iron_pickaxe' &&
      ladder.rungId === 'iron_pickaxe' &&
      ladder.goals[0]?.targetItem === 'iron_pickaxe',
    detail: `resume=${resume.rungId}@${resume.rungIndex} fallbackFrom=${resume.fallbackFrom} need=${resume.fallbackNeed} log=${JSON.stringify(fallback?.detail ?? null)} head=${ladder.goals[0]?.targetItem}`,
  }
})

addCase('(c) a revoked world outcome caps the durable claim: the ladder re-plans the lost structure', () => {
  // The ledger says this run reached enter_nether (so the portal stood), but the
  // durable world record no longer has a portal site: live world truth revoked it.
  const kit = { diamond: 3, diamond_pickaxe: 1, flint_and_steel: 1, cobblestone: 60, crafting_table: 1, furnace: 1 }
  const revoked = world({ craftingTables: [{ x: 1, y: 64, z: 1 }], furnaces: [{ x: 1, y: 64, z: 2 }] })
  const durable = durableLadderProgressFromLedger(
    ledger('enter_nether', rungIndexById('enter_nether') + 1),
    WORLD_KEY,
    kit,
    revoked,
  )
  const resume = deriveResumeRung(kit, revoked, undefined, durable)
  const ladder = buildLadder(kit, revoked, undefined, { resumeRungIndex: resume.rungIndex })
  const rebuildsPortal = ladder.goals.some((goal) => goal.targetItem === 'obsidian')
  return {
    pass:
      durable?.rungId === 'enter_nether' &&
      resume.rungId === 'nether_portal' &&
      resume.rungIndex === rungIndexById('nether_portal') &&
      resume.achievedRungIndex === rungIndexById('diamond_pickaxe') &&
      rebuildsPortal,
    detail: `durable=${durable?.rungId}@${durable?.rungIndex} resume=${resume.rungId}@${resume.rungIndex} achieved=${resume.achievedRungId}@${resume.achievedRungIndex} rebuildsPortal=${rebuildsPortal}`,
  }
})

// --- (d) the rehearsal (simdeath) path keeps its semantics ------------------

addCase('(d) a soft rehearsal restores the durable record: the rehearsal never costs the ladder', () => {
  // The HOST snapshots the ledger + milestone before a soft rehearsal and restores
  // them after it (agent-runner.mts snapshotRehearsalState/restoreRehearsalState),
  // so the next generation reads the SAME pre-rehearsal ledger. This layer must
  // therefore derive the same resume rung from it.
  const before = durableLadderProgressFromLedger(MEASURED_LEDGER, WORLD_KEY, MEASURED_KIT, LIVE_WORLD)
  const restored = JSON.parse(JSON.stringify(MEASURED_LEDGER)) as GoalQueueSnapshot
  const after = durableLadderProgressFromLedger(restored, WORLD_KEY, MEASURED_KIT, LIVE_WORLD)
  const resumeBefore = deriveResumeRung(MEASURED_KIT, LIVE_WORLD, undefined, before)
  const resumeAfter = deriveResumeRung(MEASURED_KIT, LIVE_WORLD, undefined, after)
  return {
    pass:
      JSON.stringify(before) === JSON.stringify(after) &&
      resumeBefore.rungId === resumeAfter.rungId &&
      resumeBefore.rungIndex === resumeAfter.rungIndex &&
      resumeAfter.invEmpty === false &&
      resumeAfter.rungIndex > 0 &&
      resumeAfter.resumeBasis === 'durable',
    detail: `before=${resumeBefore.rungId}@${resumeBefore.rungIndex} after=${resumeAfter.rungId}@${resumeAfter.rungIndex} sources=${after?.sources.join('+')}`,
  }
})

addCase('(d) a hard rehearsal tosses the kit, so it resets exactly like a genuine loss', () => {
  const durable = durableLadderProgressFromLedger(MEASURED_LEDGER, WORLD_KEY, MEASURED_KIT, LIVE_WORLD)
  // A hard rehearsal (`simdeath --hard`) drops every item and does NOT snapshot the
  // durable record, so the settled post-rehearsal inventory is empty.
  const resume = deriveResumeRung({}, LIVE_WORLD, undefined, durable)
  const latched = durableProgressForGeneration(resume, durable)
  const ladder = buildLadder({}, LIVE_WORLD, undefined, { resumeRungIndex: resume.rungIndex })
  return {
    pass:
      resume.rungId === 'wood' &&
      resume.rungIndex === 0 &&
      resume.invEmpty === true &&
      resume.resumeBasis === 'inventory' &&
      latched === null &&
      ladder.rungId === 'wood',
    detail: `resume=${resume.rungId}@${resume.rungIndex} invEmpty=${resume.invEmpty} latched=${latched === null ? 'null' : 'kept'} ladder=${ladder.rungId}`,
  }
})

addCase('(e) the collapsed queue behind a stale basis is refused, so its re-do rows cannot be restored', () => {
  // The live ledger was written from the inventory-shaped frontier (charcoal/6)
  // while its queue still held the reset plan. With the durable resume the live
  // basis is enter_nether/14, so the ledger restore is refused by its OWN basis
  // rule: the stale queue is discarded and the ladder supplies the durable plan.
  const durable = durableLadderProgressFromLedger(MEASURED_LEDGER, WORLD_KEY, MEASURED_KIT, LIVE_WORLD)
  const resume = deriveResumeRung(MEASURED_KIT, LIVE_WORLD, undefined, durable)
  const selection = selectLedgerSnapshot(MEASURED_LEDGER, null, MEASURED_KIT, LIVE_WORLD)
  const decision = evaluateLedgerRestoreBasis(MEASURED_LEDGER, {
    worldKey: WORLD_KEY,
    frontierRungId: resume.rungId,
    frontierRungIndex: resume.rungIndex,
  })
  const ledgerWithoutDurable = evaluateLedgerRestoreBasis(MEASURED_LEDGER, {
    worldKey: WORLD_KEY,
    frontierRungId: 'charcoal',
    frontierRungIndex: 6,
  })
  return {
    pass:
      decision.accept === false &&
      decision.reasons.includes('frontier_index_changed') &&
      selection !== null &&
      selection.source === 'host-snapshot' &&
      ledgerWithoutDurable.accept === true,
    detail: `accept=${decision.accept} reasons=[${decision.reasons.join(',')}] basisMatchedBeforeFix=${ledgerWithoutDurable.accept}`,
  }
})

// --- (f) the frontier projection shares the durable floor -------------------

addCase('(f) computeFrontier reports the same durable rung as the resume (one source of truth)', () => {
  const durable = durableLadderProgressFromLedger(MEASURED_LEDGER, WORLD_KEY, MEASURED_KIT, LIVE_WORLD)
  const resume = deriveResumeRung(MEASURED_KIT, LIVE_WORLD, undefined, durable)
  const frontier = computeFrontier(MEASURED_KIT, LIVE_WORLD, durable)
  const frontierWithout = computeFrontier(MEASURED_KIT, LIVE_WORLD)
  return {
    pass:
      frontier.rungId === resume.rungId &&
      frontier.rungIndex === resume.rungIndex &&
      frontier.rungIndex > resume.achievedRungIndex &&
      frontierWithout.rungId === 'charcoal',
    detail: `frontier=${frontier.rungId}@${frontier.rungIndex} resume=${resume.rungId}@${resume.rungIndex} withoutDurable=${frontierWithout.rungId}@${frontierWithout.rungIndex}`,
  }
})

let failures = 0
process.stdout.write('non-lossy death resume (durable ladder record)\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n      ${observed.detail}\n`)
}
process.stdout.write(`${cases.length - failures}/${cases.length} durable death-resume cases passed\n`)
if (failures > 0) process.exit(1)
