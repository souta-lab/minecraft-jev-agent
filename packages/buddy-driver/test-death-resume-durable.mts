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
import { readFileSync } from 'node:fs'
import { emptyWorldMemory } from './resident-types.ts'
import type { ResidentWorldMemory } from './resident-types.ts'
import {
  achievedRungFloor,
  buildLadder,
  computeFrontier,
  deriveResumeRung,
  rungIndexById,
  worldOutcomeRungFloor,
} from './planner.ts'
import {
  durableLadderProgressFromLedger,
  durableProgressForGeneration,
  evaluateLedgerRestoreBasis,
  selectLedgerSnapshot,
  syncKnownPortalSites,
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

// --- (g) MEASURED LIVE (run-muc30dps-181tp): the world half is DIRECT evidence ---
//
// The archived memory at generation start (2026-09-22T02:55:31Z) held this run's
// verified portal site and NO station at all:
//
//   WORLDMEMORY worldKey=127.0.0.1:25565|minecraft:overworld|1 craftingTables=0
//               furnaces=0 ... removedStations=50
//   LADDER_DURABLE_BASIS rungId=nether_portal rungIndex=13
//               sources=["ledger-basis","world-outcome"]
//               evidence=["basis:frontier=charcoal@6","world:nether_portal@13"]
//   LADDER_RESUME rung=crafting_table rungIndex=1 reason=inventory-resume
//               invEmpty=false resumeBasis=durable achievedRungId=wood achievedRungIndex=0
//   live queue head: collect 12 x cobblestone   (the whole stone stage re-planned)
//
// The memory/record ORDER was already correct: the generation composes `world`
// from the archived memory (generation-entry.ts:1622), filters it with
// `syncPortalSiteMemory('generation-start')` (:1859) and only then composes the
// durable record (:2087) used by `deriveResumeRung` (:2098). The record DID carry
// the world half (13). The floor was destroyed afterwards, by the revocation cap in
// `achievedRungFloor` (planner-legacy.ts, pre-fix lines 1371-1391; the cap is the
// `chainRungIndex` half of the fix): its chain loop breaks at index 1
// (`crafting_table`, `worldOutcome`, no held table and 0 remembered tables), so the
// independently proven rung 13 was dropped and the run re-entered the
// stone/cobblestone/furnace stage.
//
// The world half is a DIRECT proof of its own rungs (probed with an empty
// inventory, planner-legacy.ts:1342), never a chain claim, so the cap may not go
// below it. These cases pin the measured shape.

/** The archived memory at 02:55:31Z: the portal survived, every station was purged. */
const PORTAL_ONLY_WORLD = world({
  knownPortalSites: [
    { x: 25, y: 66, z: 9, widthAxis: 'x', dimension: 'minecraft:overworld', worldEpoch: 1, lastVerifiedAt: 1790012131000 },
  ],
})

/** The measured kit at 02:55:31.642Z (LADDER_RESUME inventory). */
const MEASURED_PORTAL_KIT: Record<string, number> = {
  apple: 1,
  red_mushroom: 1,
  oak_sapling: 7,
  oak_log: 76,
  leaf_litter: 34,
  raw_iron: 2,
  iron_ingot: 3,
  charcoal: 1,
  stick: 12,
  birch_log: 38,
  birch_sapling: 4,
  raw_copper: 11,
}

/** A NEW run in this world: the ledger basis proves nothing above wood. */
const FRESH_LEDGER: GoalQueueSnapshot = { counter: 0, goals: [], basis: { worldKey: WORLD_KEY, frontierRungId: 'wood', frontierRungIndex: 1 } }

/** The measured ledger basis at the same moment: charcoal/6, no done row owns a rung. */
const MEASURED_PORTAL_LEDGER: GoalQueueSnapshot = {
  ...MEASURED_LEDGER,
  basis: { worldKey: WORLD_KEY, frontierRungId: 'charcoal', frontierRungIndex: 6 },
}

const PORTAL_RUNG_INDEX = rungIndexById('nether_portal')
const ENTER_NETHER_RUNG_INDEX = rungIndexById('enter_nether')

addCase('(g) wiring: generation init loads the archived memory BEFORE composing the durable record', () => {
  // Hypothesis (a) for this gap - "the record is composed before the archived world
  // memory is available" - is FALSE (measured: WORLDMEMORY reported the 1 portal
  // site and LADDER_DURABLE_BASIS already carried `world:nether_portal@13`). This
  // guard pins the source order that makes that so, so a future reorder cannot
  // silently re-zero the world half.
  const source = readFileSync(new URL('./generation-entry.ts', import.meta.url), 'utf8')
  const at = (needle: string): number => source.indexOf(needle)
  const worldSeed = at('const world: ResidentWorldMemory = {')
  const portalSync = at("syncPortalSiteMemory('generation-start')")
  const compose = at('durableLadderProgressFromLedger(ctx.ledgerSnapshot')
  const resume = at('const resume = deriveResumeRung(counts, world')
  return {
    pass: worldSeed >= 0 && worldSeed < portalSync && portalSync < compose && compose < resume,
    detail: `worldSeed@${worldSeed} portalSync@${portalSync} compose@${compose} resume@${resume}`,
  }
})

addCase('(g) THE MEASURED LIVE GAP: a new run inheriting a standing portal resumes at the Nether stage', () => {
  logSink.length = 0
  const progress = durableLadderProgressFromLedger(FRESH_LEDGER, WORLD_KEY, MEASURED_PORTAL_KIT, PORTAL_ONLY_WORLD)
  const worldFloor = worldOutcomeRungFloor(PORTAL_ONLY_WORLD)
  const achieved = achievedRungFloor(MEASURED_PORTAL_KIT, PORTAL_ONLY_WORLD, progress)
  const resume = deriveResumeRung(MEASURED_PORTAL_KIT, PORTAL_ONLY_WORLD, emit, progress)
  const ladder = buildLadder(MEASURED_PORTAL_KIT, PORTAL_ONLY_WORLD, emit, {
    resumeRungIndex: resume.rungIndex,
    portalFrameBlocks: 10, // a known site is a complete 10-block frame (generation-entry.ts:2121)
    knownFurnaces: PORTAL_ONLY_WORLD.furnaces.length,
    placedFurnacesNear: 0,
  })
  const stoneStage = ladder.goals.filter((goal) => goal.targetItem === 'cobblestone' || goal.targetItem === 'furnace')
  const entry = ladder.goals.some((goal) => goal.description.includes('enter the lit nether portal'))
  const marker = logSink.find((line) => line.event === 'LADDER_DURABLE_WORLD_FLOOR')
  // The frontier projection must share the same floor (one source of truth).
  const frontier = computeFrontier(MEASURED_PORTAL_KIT, PORTAL_ONLY_WORLD, progress)
  return {
    pass:
      worldFloor === PORTAL_RUNG_INDEX &&
      progress?.rungId === 'nether_portal' &&
      progress?.rungIndex === PORTAL_RUNG_INDEX &&
      progress?.sources.includes('world-outcome') === true &&
      achieved.rungIndex === PORTAL_RUNG_INDEX &&
      // `chainRungIndex` IS the pre-fix result (the measured achievedRungIndex=0):
      // the cap alone still stops at wood because the crafting_table rung is revoked.
      achieved.chainRungIndex === 0 &&
      achieved.worldRungIndex === PORTAL_RUNG_INDEX &&
      resume.rungId === 'enter_nether' &&
      resume.rungIndex === ENTER_NETHER_RUNG_INDEX &&
      resume.achievedRungId === 'nether_portal' &&
      resume.achievedRungIndex === PORTAL_RUNG_INDEX &&
      resume.resumeBasis === 'durable' &&
      resume.fallbackFrom === null &&
      frontier.rungId === resume.rungId &&
      frontier.rungIndex === resume.rungIndex &&
      ladder.rungId === 'enter_nether' &&
      entry &&
      stoneStage.length === 0 &&
      marker?.detail?.rungId === 'nether_portal' &&
      marker.detail?.rungIndex === PORTAL_RUNG_INDEX &&
      marker.detail?.chainRungId === 'wood' &&
      marker.detail?.chainRungIndex === 0 &&
      marker.detail?.worldRungIndex === PORTAL_RUNG_INDEX &&
      Array.isArray(marker.detail?.sources) &&
      marker.detail.sources.includes('world-outcome') === true,
    detail: `worldFloor=${worldFloor} progress=${progress?.rungId}@${progress?.rungIndex} sources=${progress?.sources.join('+')} achieved=${achieved.rungIndex} chain(preFix)=${achieved.chainRungIndex} world=${achieved.worldRungIndex} resume=${resume.rungId}@${resume.rungIndex} basis=${resume.resumeBasis} entry=${entry} stoneStage=[${stoneStage.map((goal) => goal.description).join(' | ')}]`,
  }
})

addCase('(g) the measured ledger shape reproduces it: charcoal/6 basis + purged stations + standing portal', () => {
  const progress = durableLadderProgressFromLedger(MEASURED_PORTAL_LEDGER, WORLD_KEY, MEASURED_PORTAL_KIT, PORTAL_ONLY_WORLD)
  const achieved = achievedRungFloor(MEASURED_PORTAL_KIT, PORTAL_ONLY_WORLD, progress)
  const resume = deriveResumeRung(MEASURED_PORTAL_KIT, PORTAL_ONLY_WORLD, undefined, progress)
  return {
    pass:
      progress?.rungId === 'nether_portal' &&
      progress?.rungIndex === PORTAL_RUNG_INDEX &&
      progress?.sources.join('+') === 'ledger-basis+world-outcome' &&
      progress?.evidence.includes('world:nether_portal@13') === true &&
      achieved.chainRungIndex === 0 &&
      achieved.rungIndex === PORTAL_RUNG_INDEX &&
      resume.rungId === 'enter_nether' &&
      resume.rungIndex === ENTER_NETHER_RUNG_INDEX,
    detail: `progress=${progress?.rungId}@${progress?.rungIndex} sources=${progress?.sources.join('+')} evidence=[${progress?.evidence.join(',')}] chain=${achieved.chainRungIndex} achieved=${achieved.rungIndex} resume=${resume.rungId}@${resume.rungIndex}`,
  }
})

addCase('(g) the same portal with the station memory intact is unchanged (control)', () => {
  logSink.length = 0
  const durable = durableLadderProgressFromLedger(FRESH_LEDGER, WORLD_KEY, MEASURED_PORTAL_KIT, LIVE_WORLD)
  const achieved = achievedRungFloor(MEASURED_PORTAL_KIT, LIVE_WORLD, durable)
  const resume = deriveResumeRung(MEASURED_PORTAL_KIT, LIVE_WORLD, emit, durable)
  // The chain already carries the floor here, so the world-rescue marker must NOT fire.
  const marker = logSink.find((line) => line.event === 'LADDER_DURABLE_WORLD_FLOOR')
  return {
    pass:
      achieved.chainRungIndex === PORTAL_RUNG_INDEX &&
      achieved.worldRungIndex === PORTAL_RUNG_INDEX &&
      achieved.rungIndex === PORTAL_RUNG_INDEX &&
      resume.rungId === 'enter_nether' &&
      resume.achievedRungIndex === PORTAL_RUNG_INDEX &&
      marker === undefined,
    detail: `chain=${achieved.chainRungIndex} world=${achieved.worldRungIndex} achieved=${achieved.rungIndex} resume=${resume.rungId}@${resume.rungIndex} marker=${marker === undefined ? 'none' : 'fired'}`,
  }
})

addCase('(g) revoked portal: the world half cannot rescue it, the floor caps and the obsidian route returns', () => {
  // The ledger still claims enter_nether (so the portal once stood), the archived
  // station memory is intact, and live world truth has NO portal site.
  const stationsOnly = world({ craftingTables: [{ x: 24, y: 64, z: 8 }], furnaces: [{ x: 24, y: 64, z: 9 }] })
  const progress = durableLadderProgressFromLedger(
    ledger('enter_nether', rungIndexById('enter_nether') + 1),
    WORLD_KEY,
    MEASURED_PORTAL_KIT,
    stationsOnly,
  )
  const achieved = achievedRungFloor(MEASURED_PORTAL_KIT, stationsOnly, progress)
  const resume = deriveResumeRung(MEASURED_PORTAL_KIT, stationsOnly, undefined, progress)
  const ladder = buildLadder(MEASURED_PORTAL_KIT, stationsOnly, undefined, { resumeRungIndex: resume.rungIndex })
  const mining = ladder.goals.some((goal) => goal.targetItem === 'obsidian')
  return {
    pass:
      worldOutcomeRungFloor(stationsOnly) === rungIndexById('furnace') &&
      achieved.worldRungIndex === rungIndexById('furnace') &&
      achieved.rungIndex === rungIndexById('diamond_pickaxe') &&
      resume.rungId === 'nether_portal' &&
      resume.rungIndex === PORTAL_RUNG_INDEX &&
      mining,
    detail: `worldFloor=${worldOutcomeRungFloor(stationsOnly)} chain=${achieved.chainRungIndex} world=${achieved.worldRungIndex} achieved=${achieved.rungIndex} resume=${resume.rungId}@${resume.rungIndex} mining=${mining}`,
  }
})

addCase('(g) station-only world truth proves exactly the rung its own predicate justifies', () => {
  const stationsOnly = world({ craftingTables: [{ x: 24, y: 64, z: 8 }], furnaces: [{ x: 24, y: 64, z: 9 }] })
  const progress = durableLadderProgressFromLedger(FRESH_LEDGER, WORLD_KEY, MEASURED_PORTAL_KIT, stationsOnly)
  const achieved = achievedRungFloor(MEASURED_PORTAL_KIT, stationsOnly, progress)
  const resume = deriveResumeRung(MEASURED_PORTAL_KIT, stationsOnly, undefined, progress)
  const ladder = buildLadder(MEASURED_PORTAL_KIT, stationsOnly, undefined, { resumeRungIndex: resume.rungIndex })
  const woodGoal = ladder.goals.some((goal) => goal.targetItem === 'log')
  return {
    pass:
      worldOutcomeRungFloor(stationsOnly) === rungIndexById('furnace') &&
      progress?.rungId === 'furnace' &&
      progress?.rungIndex === rungIndexById('furnace') &&
      progress?.sources.includes('world-outcome') === true &&
      achieved.rungIndex === rungIndexById('furnace') &&
      achieved.chainRungIndex === rungIndexById('furnace') &&
      achieved.worldRungIndex === rungIndexById('furnace') &&
      resume.achievedRungId === 'furnace' &&
      resume.rungIndex > rungIndexById('furnace') &&
      !woodGoal,
    detail: `worldFloor=${worldOutcomeRungFloor(stationsOnly)} progress=${progress?.rungId}@${progress?.rungIndex} sources=${progress?.sources.join('+')} achieved=${achieved.rungIndex} resume=${resume.rungId}@${resume.rungIndex} woodGoal=${woodGoal}`,
  }
})

addCase('(g) a total loss still resets to wood and discards the record even with a standing portal', () => {
  const progress = durableLadderProgressFromLedger(MEASURED_PORTAL_LEDGER, WORLD_KEY, {}, PORTAL_ONLY_WORLD)
  const resume = deriveResumeRung({}, PORTAL_ONLY_WORLD, emit, progress)
  const latched = durableProgressForGeneration(resume, progress)
  const ladder = buildLadder({}, PORTAL_ONLY_WORLD, undefined, { resumeRungIndex: resume.rungIndex })
  return {
    pass:
      progress?.rungId === 'nether_portal' &&
      resume.rungId === 'wood' &&
      resume.rungIndex === 0 &&
      resume.invEmpty === true &&
      resume.resumeBasis === 'inventory' &&
      resume.achievedRungIndex === -1 &&
      latched === null &&
      ladder.rungId === 'wood',
    detail: `durable=${progress?.rungId}@${progress?.rungIndex} resume=${resume.rungId}@${resume.rungIndex} invEmpty=${resume.invEmpty} basis=${resume.resumeBasis} latched=${latched === null ? 'null' : 'kept'} ladder=${ladder.rungId}`,
  }
})

addCase('(g) worldKey/epoch scoping: a foreign record cannot raise this floor, a stale-epoch site is dropped', () => {
  // RECORDED ANSWER (task requirement 3): the composed `basis.worldKey` gate can
  // NOT silently disable the world half. It guards the LEDGER half only
  // (generation-entry.ts:1405); `worldOutcomeRungFloor(world)` (:1425) never reads
  // `liveWorldKey`. After an epoch change the world half is legitimately EMPTY, not
  // disabled: the host slices world memory by `serverId|dimension|worldEpoch`
  // (agent-runner.mts:185-192) and `worldreset` mints a fresh slice for the new key
  // (:2104-2116), while `syncKnownPortalSites` (generation-entry.ts:531-540, run at
  // :1859 BEFORE the composer at :2087) drops any site whose epoch/dimension
  // disagrees with the live key. Residual asymmetry recorded, not changed here:
  // `verifiedPortalSiteInWorld` (planner-legacy.ts:445-464) checks dimension but not
  // `site.worldEpoch`, so a hand-planted foreign-epoch site WOULD satisfy the rung;
  // no current caller can produce one (host keying + the start-of-init sync).
  //
  // A ledger committed in another world epoch does not contribute; this world's
  // own portal site still does.
  const foreign: GoalQueueSnapshot = {
    ...MEASURED_PORTAL_LEDGER,
    basis: { worldKey: '127.0.0.1:25565|minecraft:overworld|2', frontierRungId: 'enter_nether', frontierRungIndex: 15 },
  }
  const foreignProgress = durableLadderProgressFromLedger(foreign, WORLD_KEY, MEASURED_PORTAL_KIT, PORTAL_ONLY_WORLD)
  // The same archive read under the LIVE epoch must not leak: the generation runs
  // `syncKnownPortalSites` first (generation-entry.ts:1859), which drops the site.
  const staleSynced = syncKnownPortalSites({
    known: [{ x: 25, y: 66, z: 9, widthAxis: 'x', dimension: 'minecraft:overworld', worldEpoch: 2, lastVerifiedAt: 1 }],
    liveVerified: [],
    worldKey: { dimension: 'minecraft:overworld', worldEpoch: 1 },
    position: { x: 28.7, y: 62, z: 9.7 },
    probe: () => 'nether_portal',
    now: 1790013000000,
  })
  const staleWorld = world({ knownPortalSites: staleSynced.known })
  const staleProgress = durableLadderProgressFromLedger(MEASURED_PORTAL_LEDGER, WORLD_KEY, MEASURED_PORTAL_KIT, staleWorld)
  const liveSynced = syncKnownPortalSites({
    known: [{ x: 25, y: 66, z: 9, widthAxis: 'x', dimension: 'minecraft:overworld', worldEpoch: 1, lastVerifiedAt: 1 }],
    liveVerified: [],
    worldKey: { dimension: 'minecraft:overworld', worldEpoch: 1 },
    position: { x: 28.7, y: 62, z: 9.7 },
    probe: () => 'nether_portal',
    now: 1790013000000,
  })
  return {
    pass:
      foreignProgress?.sources.join('+') === 'world-outcome' &&
      foreignProgress?.rungIndex === PORTAL_RUNG_INDEX &&
      staleSynced.removed.length === 1 &&
      staleSynced.removalReasons[0]?.reason === 'world_epoch' &&
      staleWorld.knownPortalSites.length === 0 &&
      worldOutcomeRungFloor(staleWorld) === -1 &&
      staleProgress?.rungIndex === 5 &&
      staleProgress?.sources.join('+') === 'ledger-basis' &&
      liveSynced.removed.length === 0 &&
      worldOutcomeRungFloor(world({ knownPortalSites: liveSynced.known })) === PORTAL_RUNG_INDEX,
    detail: `foreign=${foreignProgress?.rungId}@${foreignProgress?.rungIndex}/${foreignProgress?.sources.join('+')} staleRemoval=${staleSynced.removalReasons.map((entry) => entry.reason).join(',')} staleFloor=${worldOutcomeRungFloor(staleWorld)} stale=${staleProgress?.rungId}@${staleProgress?.rungIndex}/${staleProgress?.sources.join('+')} liveRemoved=${liveSynced.removed.length}`,
  }
})

addCase('(g) a run with no archived durable state behaves exactly as before', () => {
  const none = durableLadderProgressFromLedger(null, WORLD_KEY, MEASURED_PORTAL_KIT, world())
  const withRecord = deriveResumeRung(MEASURED_PORTAL_KIT, world(), emit, none)
  const withoutRecord = deriveResumeRung(MEASURED_PORTAL_KIT, world())
  return {
    pass:
      none === null &&
      withRecord.rungId === withoutRecord.rungId &&
      withRecord.rungIndex === withoutRecord.rungIndex &&
      withRecord.resumeBasis === 'inventory' &&
      withRecord.achievedRungIndex === -1 &&
      achievedRungFloor(MEASURED_PORTAL_KIT, world(), null).rungIndex === -1,
    detail: `record=${none === null ? 'null' : 'value'} with=${withRecord.rungId}@${withRecord.rungIndex}/${withRecord.resumeBasis} without=${withoutRecord.rungId}@${withoutRecord.rungIndex}/${withoutRecord.resumeBasis}`,
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
