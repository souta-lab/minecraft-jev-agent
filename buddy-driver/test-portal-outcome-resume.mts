// test-portal-outcome-resume.mts - M3_CRITICAL regression: an inventory-shaped
// resume and the durable-ledger restore must not un-satisfy a run-scoped world
// outcome the run already PROVED.
//
// MEASURED LIVE (run-mubhx20x-pie2, m3-live worktree):
//   17:25:44.614 PORTAL_FRAME_READY at=26,66,9 blocks=10 shape=ok
//   17:25:47.448 PORTAL_VERIFIED  actionId=IGNITE:26,67,9 dimension=minecraft:overworld verified=true
//   17:32:56.140 LADDER_RESUME rung=nether_portal rungIndex=13 reason=inventory-resume
//                inventory={... no obsidian ...}          <- the 9 obsidian went into the frame
//   17:32:56.153 LEDGER_RESTORED source=host-snapshot done=1 total=6 current=collect obsidian reopened=5
//   17:32:56.153 LEDGER_GOAL_REOPENED goals=[g1..g3 collect:obsidian 0/9, g10 place:obsidian 0/10,
//                                            g11 place:nether_portal 0/1]
//   17:34:42.903 LADDER_RESUME rung=nether_portal rungIndex=13 reason=inventory-resume   (next reload)
//   body then: 28.7,62,9.7 (below the gate, queue=collect obsidian)   PORTAL_FRAME_PROGRESS blocks=0
//
// The gate was standing and lit the whole time (world truth from the save file:
// obsidian=10 nether_portal=6 in the z=9 plane). Two general defects:
//
//   (1) `deriveResumeRung` -> `rungBehindInventory` -> `RUNGS[nether_portal].satisfied`
//       read the live projection only (`world.portalVerified`, computed from a
//       search window around the BODY: dy -4..+4). A body at y=62 cannot see a
//       frame at y=66..70, so every reload re-derived `nether_portal` and
//       re-queued its own construction rows.
//   (2) `reconcileLedgerGoals` reopened the finished construction rows with zero
//       counts because it asks the SAME rung predicate; and
//       `evaluateLedgerRestoreBasis` accepted the stale ledger because the
//       (wrong) live frontier still matched its recorded basis - a circular
//       confirmation of the wrong answer.
//
// Run: bun test-portal-outcome-resume.mts
import {
  RUNGS,
  buildLadder,
  buildPlanOptions,
  computeFrontier,
  deriveResumeRung,
  verifiedPortalSiteInWorld,
} from './planner.ts'
import {
  PORTAL_SITE_PROOF_DISTANCE,
  evaluateLedgerRestoreBasis,
  reconcileLedgerGoals,
  selectLedgerSnapshot,
  syncKnownPortalSites,
} from './generation-entry.ts'
import type { LedgerBasis } from '../jev-agent/src/goalQueue.ts'
import { emptyWorldMemory } from './resident-types.ts'
import type { GoalQueueSnapshot, QueuedGoal } from '../jev-agent/src/goalQueue.ts'
import type { KnownPortalSiteJson, ResidentWorldMemory } from './resident-types.ts'
import { portalFrameLayout, PORTAL_OBSIDIAN_REQUIRED } from '../jev-agent/src/netherPortalPlan.ts'
import type { Counts } from './planner.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

// ---------------------------------------------------------------------------
// the exact live shape
// ---------------------------------------------------------------------------

/** The verified gate at 25,66,9 in its measured geometry (10 edges, 6 interior cells). */
const PORTAL_ORIGIN = { x: 25, y: 66, z: 9 }
const PORTAL_LAYOUT = portalFrameLayout(PORTAL_ORIGIN, 'x')
const PORTAL_SITE: KnownPortalSiteJson = {
  x: PORTAL_ORIGIN.x,
  y: PORTAL_ORIGIN.y,
  z: PORTAL_ORIGIN.z,
  widthAxis: 'x',
  dimension: 'minecraft:overworld',
  worldEpoch: 1,
  lastVerifiedAt: 1790012099289,
  frame: PORTAL_LAYOUT.frame.map((cell) => ({ ...cell })),
  interior: PORTAL_LAYOUT.interior.map((cell) => ({ ...cell })),
}

const WORLD_KEY = { dimension: 'minecraft:overworld', worldEpoch: 1 }
const WORLD_KEY_STRING = '127.0.0.1:25565|minecraft:overworld|1'
/** The measured body: BELOW the gate (frame y=66..70, body y=62), sensor sees nothing. */
const BODY_BELOW = { x: 28.7, y: 62, z: 9.7 }

/** The live inventory at 17:32:56Z: the 9 obsidian were consumed into the frame. */
const LIVE_INVENTORY: Counts = {
  dirt: 73,
  cobblestone: 560,
  diamond: 3,
  soul_sand: 13,
  stick: 5,
  furnace: 1,
  oak_log: 4,
  iron_ingot: 2,
  raw_copper: 5,
  gravel: 13,
  bone: 1,
  soul_soil: 1,
  birch_sapling: 2,
  oak_sapling: 4,
  leaf_litter: 31,
  diamond_sword: 1,
  andesite: 18,
  coal: 3,
  raw_iron: 18,
  flint_and_steel: 1,
  diamond_pickaxe: 1,
}

const liveWorld = (over: Partial<ResidentWorldMemory> = {}): ResidentWorldMemory => ({
  ...emptyWorldMemory(),
  dimension: 'minecraft:overworld',
  ...over,
})

/** The 6 ledger rows the host-snapshot held at 17:32:56Z, with the 5 construction rows done. */
function constructionLedger(): GoalQueueSnapshot {
  const row = (
    id: string,
    kind: QueuedGoal['kind'],
    description: string,
    targetItem: string,
    requiredCount: number,
    status: QueuedGoal['status'],
  ): QueuedGoal => ({
    id,
    kind,
    description,
    targetItem,
    requiredCount,
    startCount: 0,
    haveCount: status === 'done' ? requiredCount : 0,
    status,
    origin: 'ladder',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  })
  return {
    counter: 30,
    revision: 8790,
    goals: [
      row('g1:collect:obsidian', 'collect', 'collect obsidian', 'obsidian', 9, 'done'),
      row('g2:collect:obsidian', 'collect', 'collect obsidian', 'obsidian', 9, 'done'),
      row('g3:collect:obsidian', 'collect', 'collect obsidian', 'obsidian', 9, 'done'),
      row('g10:place:obsidian', 'place', 'build the 4x5 obsidian portal frame (10 blocks)', 'obsidian', 10, 'done'),
      row('g11:place:nether_portal', 'place', 'light the portal with flint_and_steel', 'nether_portal', 1, 'done'),
      row('g24:descend:raw_iron', 'descend', 'explore', 'raw_iron', 1, 'done'),
    ],
    basis: { worldKey: WORLD_KEY_STRING, frontierRungId: 'nether_portal', frontierRungIndex: 13 },
  }
}

const mentionsObsidianConstruction = (description: string): boolean =>
  description.includes('obsidian') &&
  (description.startsWith('collect') || description.startsWith('mine') || description.includes('portal frame') || description.includes('build'))

// (a) THE LIVE SHAPE: a run-verified portal + no obsidian + an inventory-shaped
// resume. The construction rows must not come back.
addCase('(a) live shape: a run-verified portal dominates the inventory-shaped resume', () => {
  const world = liveWorld({ knownPortalSites: [{ ...PORTAL_SITE }] })
  const resume = deriveResumeRung(LIVE_INVENTORY, world)
  const ladder = buildLadder(LIVE_INVENTORY, world, undefined, {
    dimension: WORLD_KEY.dimension,
    resumeRungIndex: resume.rungIndex,
    portalFrameBlocks: 0, // the body-relative sensor is blind from below
  })
  const construction = ladder.goals.filter((goal) => mentionsObsidianConstruction(goal.description))
  const entry = ladder.goals.some((goal) => goal.description.includes('enter the lit nether portal'))
  const pass =
    verifiedPortalSiteInWorld(world) !== null &&
    resume.rungId === 'enter_nether' &&
    resume.rungIndex === 14 &&
    construction.length === 0 &&
    entry
  return {
    pass,
    detail: `resume=${resume.rungId}@${resume.rungIndex} construction=[${construction.map((g) => g.description).join(' | ')}] entry=${entry} goals=[${ladder.goals.map((g) => g.description).join(' | ')}]`,
  }
})

// (a2) The rung predicate itself (not the resume cursor): with NO resume cursor the
// satisfied rung must still emit no construction rows.
addCase('(a2) the rung predicate alone never re-plans the finished gate', () => {
  const world = liveWorld({ knownPortalSites: [{ ...PORTAL_SITE }] })
  const rung = RUNGS.find((candidate) => candidate.id === 'nether_portal')
  const ladder = buildLadder(LIVE_INVENTORY, world)
  const construction = ladder.goals.filter((goal) => mentionsObsidianConstruction(goal.description))
  const frontier = computeFrontier(LIVE_INVENTORY, world)
  const pass =
    rung?.satisfied(LIVE_INVENTORY, world) === true &&
    construction.length === 0 &&
    frontier.rungIndex > 13 &&
    (ladder.goals.some((goal) => goal.description.includes('enter the lit nether portal')) ||
      ladder.goals.some((goal) => goal.description.includes('blaze_rod')))
  return {
    pass,
    detail: `satisfied=${rung?.satisfied(LIVE_INVENTORY, world)} plannerFrontier=${frontier.rungId}@${frontier.rungIndex} goals=[${ladder.goals.map((g) => g.description).join(' | ')}]`,
  }
})

// (a3) The plan must OFFER the entry route, not just omit the construction rows.
addCase('(a3) the entry route is offered as a grounded option (front_enter_nether)', () => {
  const world = liveWorld({ knownPortalSites: [{ ...PORTAL_SITE }] })
  const resume = deriveResumeRung(LIVE_INVENTORY, world)
  const options = buildPlanOptions(LIVE_INVENTORY, world, { resumeRungIndex: resume.rungIndex })
  const entry = options.find((option) => option.id === 'front_enter_nether')
  const pass =
    entry !== undefined &&
    entry.goals.some((goal) => goal.description.includes('enter the lit nether portal')) &&
    options.every((option) => option.goals.every((goal) => !mentionsObsidianConstruction(goal.description)))
  return {
    pass,
    detail: `options=[${options.map((option) => option.id).join(',')}] entryGoals=[${entry?.goals.map((g) => g.description).join(' | ') ?? 'none'}]`,
  }
})

// (a4) The durable ledger restore: the same snapshot the host held at
// 17:32:56Z (5 finished construction rows) must stay `done` through
// `reconcileLedgerGoals` and the pure restore selection.
addCase('(a4) restore: finished construction rows are not reopened for a satisfied outcome', () => {
  const world = liveWorld({ knownPortalSites: [{ ...PORTAL_SITE }] })
  const snapshot = constructionLedger()
  const reconciled = reconcileLedgerGoals(snapshot, LIVE_INVENTORY, world)
  const selected = selectLedgerSnapshot(snapshot, null, LIVE_INVENTORY, world)
  const stillDone = reconciled.snapshot.goals.filter((goal) => goal.status === 'done').length
  const reopenedIds = reconciled.snapshot.goals
    .filter((goal) => goal.status === 'pending' || goal.status === 'active')
    .map((goal) => goal.id)
  const pass =
    reconciled.reopened.length === 0 &&
    stillDone === snapshot.goals.length &&
    reopenedIds.length === 0 &&
    selected !== null &&
    selected.reopened.length === 0 &&
    selected.snapshot.goals.every((goal) => goal.status === 'done')
  return {
    pass,
    detail: `reopened=${reconciled.reopened.length} stillDone=${stillDone}/${snapshot.goals.length} reopenedIds=[${reopenedIds.join(',')}]`,
  }
})

// (a5) A ledger that still carries UNFINISHED work committed against the portal
// frontier must be discarded (not restored) once the corrected frontier is past
// it: that is the existing basis vehicle, and it is why the stale construction
// rows g1/g2/g3/g10/g11 cannot come back through a later restore either.
addCase('(a5) restore basis: unfinished rows from the portal frontier are discarded, not revived', () => {
  const snapshot = constructionLedger()
  const pendingRow: QueuedGoal = {
    ...snapshot.goals[0]!,
    id: 'g30:collect:obsidian',
    status: 'pending',
    haveCount: 0,
  }
  const unfinished: GoalQueueSnapshot = { ...snapshot, goals: [...snapshot.goals, pendingRow] }
  const liveBasis: LedgerBasis = { worldKey: WORLD_KEY_STRING, frontierRungId: 'enter_nether', frontierRungIndex: 14 }
  const decision = evaluateLedgerRestoreBasis(unfinished, liveBasis)
  const pass =
    decision.accept === false &&
    decision.reasons.includes('frontier_index_changed') &&
    decision.reasons.includes('frontier_id_changed')
  return { pass, detail: `accept=${decision.accept} reasons=[${decision.reasons.join(',')}]` }
})

// (c) THE MEASURED MOMENT: the body is 8+ blocks below the gate, the live sensor
// window sees nothing, and the run's own durable record still yields the verified
// outcome through a coordinate-anchored recheck of the recorded cells.
addCase('(c) blind-from-below: the durable record survives and still yields the outcome', () => {
  const probe = (cell: { x: number; y: number; z: number }): string | null =>
    PORTAL_LAYOUT.interior.some((entry) => entry.x === cell.x && entry.y === cell.y && entry.z === cell.z)
      ? 'nether_portal'
      : 'obsidian'
  const synced = syncKnownPortalSites({
    known: [{ ...PORTAL_SITE }],
    liveVerified: [], // body at y=62, frame at y=66..70: the body window sees nothing
    worldKey: WORLD_KEY,
    position: BODY_BELOW,
    probe,
    now: 1790013000000,
  })
  const world = liveWorld({ knownPortalSites: synced.known })
  const resume = deriveResumeRung(LIVE_INVENTORY, world)
  const ladder = buildLadder(LIVE_INVENTORY, world, undefined, { resumeRungIndex: resume.rungIndex })
  const construction = ladder.goals.filter((goal) => mentionsObsidianConstruction(goal.description))
  const distance = Math.hypot(
    PORTAL_SITE.x - BODY_BELOW.x,
    PORTAL_SITE.y - BODY_BELOW.y,
    PORTAL_SITE.z - BODY_BELOW.z,
  )
  const pass =
    distance < PORTAL_SITE_PROOF_DISTANCE + 1 &&
    synced.removed.length === 0 &&
    synced.confirmed.length === 1 &&
    verifiedPortalSiteInWorld(world) !== null &&
    resume.rungId === 'enter_nether' &&
    construction.length === 0
  return {
    pass,
    detail: `distance=${distance.toFixed(1)} removed=${synced.removed.length} confirmed=${synced.confirmed.length} resume=${resume.rungId}@${resume.rungIndex} construction=${construction.length}`,
  }
})

// (b) THE M2 BUILD CASE MUST NOT BREAK: no verified outcome -> the construction
// rows legitimately return.
addCase('(b) no verified outcome: the M2 construction plan legitimately returns', () => {
  const world = liveWorld()
  const resume = deriveResumeRung(LIVE_INVENTORY, world)
  const ladder = buildLadder(LIVE_INVENTORY, world, undefined, { resumeRungIndex: resume.rungIndex })
  const mining = ladder.goals.some((goal) => goal.description.startsWith('mine 10 x obsidian'))
  const build = ladder.goals.some((goal) => goal.description.includes('portal frame'))
  const light = ladder.goals.some((goal) => goal.description.includes('light the portal'))
  const reconciled = reconcileLedgerGoals(constructionLedger(), LIVE_INVENTORY, world)
  const pass =
    resume.rungId === 'nether_portal' &&
    resume.rungIndex === 13 &&
    mining &&
    build &&
    light &&
    reconciled.reopened.length === 5
  return {
    pass,
    detail: `resume=${resume.rungId}@${resume.rungIndex} mine=${mining} build=${build} light=${light} reopened=${reconciled.reopened.length}`,
  }
})

// (d1) GENUINELY ABSENT: the recorded cells are read back as air. The record is
// revoked and the plan returns to construction (never an infinite
// "the outcome exists" claim for a gate that is gone).
addCase('(d1) genuinely absent: a read-back-absent frame revokes the record and re-plans', () => {
  const synced = syncKnownPortalSites({
    known: [{ ...PORTAL_SITE }],
    liveVerified: [],
    worldKey: WORLD_KEY,
    position: BODY_BELOW,
    probe: () => 'air',
    now: 1790013000000,
  })
  const world = liveWorld({ knownPortalSites: synced.known })
  const resume = deriveResumeRung(LIVE_INVENTORY, world)
  const ladder = buildLadder(LIVE_INVENTORY, world, undefined, { resumeRungIndex: resume.rungIndex })
  const mining = ladder.goals.some((goal) => goal.description.startsWith(`mine ${PORTAL_OBSIDIAN_REQUIRED} x obsidian`))
  const pass =
    synced.removed.length === 1 &&
    synced.removalReasons[0]?.reason === 'frame_broken' &&
    verifiedPortalSiteInWorld(world) === null &&
    resume.rungId === 'nether_portal' &&
    resume.rungIndex === 13 &&
    mining
  return {
    pass,
    detail: `removed=${synced.removalReasons.map((entry) => entry.reason).join(',')} resume=${resume.rungId}@${resume.rungIndex} mining=${mining}`,
  }
})

// (d2) GENUINELY UNLIT with the frame still standing: the outcome is gone, so the
// rung re-opens - and with the frame sensed there is NO obsidian mining: the plan
// lights the surviving frame instead of sourcing materials it does not need.
addCase('(d2) genuinely unlit: an intact frame re-opens the rung for LIGHT, not for mining', () => {
  const probe = (cell: { x: number; y: number; z: number }): string | null =>
    PORTAL_LAYOUT.frame.some((entry) => entry.x === cell.x && entry.y === cell.y && entry.z === cell.z)
      ? 'obsidian'
      : 'air'
  const synced = syncKnownPortalSites({
    known: [{ ...PORTAL_SITE }],
    liveVerified: [],
    worldKey: WORLD_KEY,
    position: BODY_BELOW,
    probe,
    now: 1790013000000,
  })
  const world = liveWorld({ knownPortalSites: synced.known })
  const resume = deriveResumeRung(LIVE_INVENTORY, world)
  const ladder = buildLadder(LIVE_INVENTORY, world, undefined, {
    resumeRungIndex: resume.rungIndex,
    // the sensed frame is intact, so the required edges already exist
    portalFrameBlocks: PORTAL_LAYOUT.frame.length,
  })
  const mining = ladder.goals.some((goal) => goal.description.startsWith('mine '))
  const light = ladder.goals.some((goal) => goal.description.includes('light the portal'))
  const pass =
    synced.removed.length === 1 &&
    synced.removalReasons[0]?.reason === 'observed_unlit' &&
    resume.rungId === 'nether_portal' &&
    !mining &&
    light
  return {
    pass,
    detail: `removed=${synced.removalReasons.map((entry) => entry.reason).join(',')} resume=${resume.rungId}@${resume.rungIndex} mining=${mining} light=${light} goals=[${ladder.goals.map((g) => g.description).join(' | ')}]`,
  }
})

// (d3) NO EVIDENCE AT ALL: the fresh M2 build case (world memory never saw a
// portal). Construction returns, exactly as before this change.
addCase('(d3) no evidence at all: the fresh M2 build plan is unchanged', () => {
  const world = liveWorld()
  const resume = deriveResumeRung(LIVE_INVENTORY, world)
  const ladder = buildLadder(LIVE_INVENTORY, world, undefined, { resumeRungIndex: resume.rungIndex })
  const descriptions = ladder.goals.map((goal) => goal.description)
  const pass =
    resume.rungId === 'nether_portal' &&
    descriptions.some((line) => line.startsWith('mine 10 x obsidian')) &&
    descriptions.some((line) => line.includes('portal frame')) &&
    descriptions.some((line) => line.includes('light the portal')) &&
    descriptions.some((line) => line.includes('verify the lit nether_portal'))
  return { pass, detail: `goals=[${descriptions.join(' | ')}]` }
})

// (d4) A world-epoch / dimension mismatch is never a satisfaction fact: a record
// from another world must not silence this world's construction plan.
addCase('(d4) a foreign-world record never satisfies this world rung', () => {
  const rung = RUNGS.find((candidate) => candidate.id === 'nether_portal')
  // Recorded in the Nether while the body is in the overworld: not a fact here.
  const crossDimension = liveWorld({
    knownPortalSites: [{ ...PORTAL_SITE, dimension: 'minecraft:the_nether' }],
  })
  // Verified under another world epoch: the durability layer drops it outright
  // (its coordinate no longer means anything), so the rung re-opens.
  const synced = syncKnownPortalSites({
    known: [{ ...PORTAL_SITE, worldEpoch: WORLD_KEY.worldEpoch }],
    liveVerified: [],
    worldKey: { ...WORLD_KEY, worldEpoch: WORLD_KEY.worldEpoch + 1 },
    position: BODY_BELOW,
    probe: () => 'air',
    now: 1790013000000,
  })
  const epochDropped = synced.removed.length === 1 && synced.removalReasons[0]?.reason === 'world_epoch'
  const epochWorld = liveWorld({ knownPortalSites: synced.known })
  const pass =
    verifiedPortalSiteInWorld(crossDimension) === null &&
    rung?.satisfied(LIVE_INVENTORY, crossDimension) === false &&
    epochDropped &&
    verifiedPortalSiteInWorld(epochWorld) === null &&
    deriveResumeRung(LIVE_INVENTORY, crossDimension).rungId === 'nether_portal' &&
    deriveResumeRung(LIVE_INVENTORY, epochWorld).rungId === 'nether_portal'
  return {
    pass,
    detail: `crossDimensionSatisfied=${rung?.satisfied(LIVE_INVENTORY, crossDimension)} epochRemoval=${synced.removalReasons.map((entry) => entry.reason).join(',')} crossResume=${deriveResumeRung(LIVE_INVENTORY, crossDimension).rungId} epochResume=${deriveResumeRung(LIVE_INVENTORY, epochWorld).rungId}`,
  }
})

let failures = 0
process.stdout.write('portal outcome dominates an inventory-shaped resume (M3_CRITICAL)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} portal-outcome resume cases passed\n`)
if (failures > 0) process.exit(1)
