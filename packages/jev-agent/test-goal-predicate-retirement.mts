// test-goal-predicate-retirement.mts - #predicate-retire: a queued row whose OWN
// success predicate ALREADY HOLDS in world truth retires as DONE, without
// executing its action sequence.
//
// THE MEASURED DEFECT (run-muchajde-1qhat, main f252804; and the restore window
// of run-mubhx20x-pie2 before it):
//
//   goal=place:nether_portal:1 actionable=1 count=2 limit=6      <- the head
//   m3_predicate portal_verified: PASS  source=host-observe:rung:nether_portal
//   SYSTEM2_PLAN_REQUEST_REASON reason=queue_empty               <- re-summoned behind it
//
// The gate stood built, lit and verified and the ladder already recorded the
// `nether_portal` rung as achieved (an INHERITED portal; M2 PASS on the
// durable/standard basis), yet restored/planned M2 rows kept the head. Every
// existing completion path needs THIS generation to have run the action
// sequence (the five `markDone()` sites in controller.ts `syncQueue`,
// plus the per-tick spatial `predicateForGoal` path), so none of them can fire
// when the world truth is already true.
//
// This fixture proves, offline:
//   (i)   the measured case: a restored queue whose rows are the portal build,
//         with a verified portal in world truth -> the rows retire with the
//         evidence marker and the queue advances to the M3 work.
//   (ii)  the same rows with NO portal -> unchanged (they stay and their normal
//         path runs). Includes the measured run's ACTUAL head row: a
//         `portal_entered` row in the overworld, whose own predicate is
//         genuinely false there and which therefore must NOT be retired.
//   (iii) a predicate that cannot be evaluated (unloaded/unknown world, missing
//         record, throwing probe) -> NOT retired.
//   (iv)  ordinary item/spatial goals unaffected: with a probe installed and no
//         predicate holding, the durable queue is byte-identical to the same
//         queue with no probe at all.
//   (v)   restore round-trip: a retired row survives the ledger save/load cycle
//         and does not come back.
//   (vi)  the mechanism is not portal-specific: a non-portal `place` row with
//         placement geometry retires through the same family, and a future
//         block record uses the same durable half.
//   (vii) the retirement marker is on the MIRRORED event path (an unmirrored
//         marker never reaches buddy.log) and the controller still wires the
//         probe at both queue-construction sites.
//
// Run: bun jev-agent/test-goal-predicate-retirement.mts
import { readFileSync } from 'node:fs'
import { GoalQueue, setPrereqAuditSink } from './src/goalQueue.ts'
import type { GoalQueueSnapshot, PlannedGoal, QueuedGoal } from './src/goalQueue.ts'
import {
  GOAL_RETIRED_PREDICATE,
  GOAL_SUCCESS_PROBE_ERROR,
  evaluateGoalSuccess,
  goalSuccessPredicateFor,
  recordedPortalSitesFromKnownResources,
  verifiedBlockRecordsFromKnownResources,
} from './src/goalSuccess.ts'
import type { GoalSuccessCell, GoalSuccessWorldProbe } from './src/goalSuccess.ts'
import { mirroredEventToken } from './src/controller.ts'
import {
  NETHER,
  NETHER_PORTAL,
  OBSIDIAN,
  OVERWORLD,
  PORTAL_ENTERED_PREDICATE,
  PORTAL_LIT_PREDICATE,
  portalFrameLayout,
} from './src/netherPortalPlan.ts'

let failures = 0
function check(name: string, pass: boolean, detail: string): void {
  if (!pass) failures += 1
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}\n`)
  process.stdout.write(`      ${detail}\n`)
}

// ---------------------------------------------------------------------------
// the exact live geometry (run-mubhx20x-pie2 / run-muchajde-1qhat): the verified
// gate at 25,66,9 - 10 obsidian edges, 6 nether_portal interior cells in z=9
// ---------------------------------------------------------------------------
const PORTAL_ORIGIN: GoalSuccessCell = { x: 25, y: 66, z: 9 }
const LAYOUT = portalFrameLayout(PORTAL_ORIGIN, 'x')

const key = (cell: GoalSuccessCell): string => `${cell.x},${cell.y},${cell.z}`

/** The known-resource envelope entry `portalSiteKnownResources` mints. */
function portalResource(siteDimension: string | null = OVERWORLD) {
  return {
    name: NETHER_PORTAL,
    kind: 'portal' as const,
    position: { ...PORTAL_ORIGIN },
    widthAxis: 'x' as const,
    ...(siteDimension === null ? {} : { dimension: siteDimension }),
    worldEpoch: 1,
    frameCells: LAYOUT.frame.map((cell) => ({ ...cell })),
  }
}

/** The live world: every frame edge obsidian, every interior cell nether_portal. */
function portalBlocks(): Map<string, string> {
  const blocks = new Map<string, string>()
  for (const cell of LAYOUT.frame) blocks.set(key(cell), OBSIDIAN)
  for (const cell of LAYOUT.interior) blocks.set(key(cell), NETHER_PORTAL)
  return blocks
}

interface ProbeInput {
  dimension?: string | null
  blocks?: Map<string, string>
  /** cells whose read fails (unloaded chunk / no body) */
  unreadable?: readonly GoalSuccessCell[]
  /** the durable known-resource envelope */
  resources?: readonly ReturnType<typeof portalResource>[]
}

/** Build the probe exactly as the controller does (real envelope readers). */
function probe(input: ProbeInput = {}): GoalSuccessWorldProbe {
  const blocks = input.blocks ?? new Map<string, string>()
  const unreadable = new Set((input.unreadable ?? []).map(key))
  const resources = input.resources ?? []
  return {
    dimension: input.dimension === undefined ? OVERWORLD : input.dimension,
    blockAt: (cell) => (unreadable.has(key(cell)) ? null : blocks.get(key(cell)) ?? 'air'),
    recordedPortalSites: recordedPortalSitesFromKnownResources(resources),
    verifiedBlockRecords: verifiedBlockRecordsFromKnownResources(resources),
  }
}

// ---------------------------------------------------------------------------
// rows: the measured durable ledger shape
// ---------------------------------------------------------------------------
function row(partial: Partial<QueuedGoal> & Pick<QueuedGoal, 'id' | 'kind' | 'description' | 'targetItem' | 'requiredCount'>): QueuedGoal {
  return {
    startCount: 0,
    haveCount: 0,
    status: 'pending',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
    ...partial,
  }
}

const collectObsidianRow = (): QueuedGoal =>
  row({ id: 'g4:collect:obsidian', kind: 'collect', description: 'mine 10 x obsidian with diamond_pickaxe', targetItem: OBSIDIAN, requiredCount: 10 })

const frameRow = (): QueuedGoal =>
  row({
    id: 'g5:place:obsidian',
    kind: 'place',
    description: 'build the 4x5 obsidian portal frame (10 blocks)',
    targetItem: OBSIDIAN,
    requiredCount: LAYOUT.frame.length,
    placementCells: LAYOUT.frame.map((cell) => ({ ...cell })),
    dimension: OVERWORLD,
    core: true,
  })

const lightRow = (): QueuedGoal =>
  row({
    id: 'g6:place:nether_portal',
    kind: 'place',
    description: 'light the portal with flint_and_steel',
    targetItem: NETHER_PORTAL,
    requiredCount: 1,
    targetPredicate: PORTAL_LIT_PREDICATE,
    dimension: OVERWORLD,
    core: true,
  })

const entryRow = (status: QueuedGoal['status'] = 'pending'): QueuedGoal =>
  row({
    id: 'g7:place:nether_portal',
    kind: 'place',
    description: 'enter the lit nether portal and transfer to minecraft:the_nether',
    targetItem: NETHER_PORTAL,
    requiredCount: 1,
    targetPredicate: PORTAL_ENTERED_PREDICATE,
    dimension: NETHER,
    core: true,
    status,
  })

const blazeRow = (): QueuedGoal =>
  row({ id: 'g8:collect:blaze_rod', kind: 'collect', description: 'collect 7 x blaze_rod', targetItem: 'blaze_rod', requiredCount: 7 })

function ledger(goals: QueuedGoal[]): GoalQueueSnapshot {
  return {
    counter: 30,
    revision: 9000,
    goals,
    basis: { worldKey: '127.0.0.1:25565|minecraft:overworld|1', frontierRungId: 'enter_nether', frontierRungIndex: 14 },
  }
}

interface Harness {
  queue: GoalQueue
  markers: string[]
  details: Record<string, unknown>[]
}

function restoreHarness(goals: QueuedGoal[], worldProbe: GoalSuccessWorldProbe | null, prereqLines: string[] = []): Harness {
  const markers: string[] = []
  const details: Record<string, unknown>[] = []
  const queue = new GoalQueue()
  if (worldProbe !== null) {
    queue.setGoalSuccessProbe(
      (goal) => evaluateGoalSuccess(goal, worldProbe),
      (line, detail) => {
        markers.push(line)
        details.push(detail)
      },
    )
  }
  setPrereqAuditSink((line) => prereqLines.push(line))
  queue.restore(ledger(goals))
  setPrereqAuditSink(null)
  return { queue, markers, details }
}

const statusOf = (queue: GoalQueue, id: string): string =>
  queue.state.goals.find((goal) => goal.id === id)?.status ?? 'missing'

const retiredMarkers = (markers: readonly string[]): string[] =>
  markers.filter((line) => line.startsWith(GOAL_RETIRED_PREDICATE))

// ---------------------------------------------------------------------------
// (i) THE MEASURED CASE
// ---------------------------------------------------------------------------

// (i-0) BEFORE/AFTER: the pre-fix behaviour is exactly "no probe installed" - the
// same ledger against the same world truth keeps the M2 rows at the head. This is
// the permanent goal the rest of this fixture removes, and it also proves the
// change is additive (an uninstalled probe changes nothing).
{
  const stale = [frameRow(), lightRow(), blazeRow()]
  const world = probe({ dimension: OVERWORLD, blocks: portalBlocks(), resources: [portalResource()] })
  const bare = restoreHarness(stale, null)
  const withProbe = restoreHarness(stale, world)
  check(
    '(i-0) BEFORE: with no probe the same world truth retires nothing (the permanent goal)',
    bare.queue.current?.id === 'g5:place:obsidian' &&
      statusOf(bare.queue, 'g5:place:obsidian') === 'active' &&
      statusOf(bare.queue, 'g6:place:nether_portal') === 'pending' &&
      bare.markers.length === 0,
    `head=${bare.queue.current?.id ?? 'none'} frame=${statusOf(bare.queue, 'g5:place:obsidian')} light=${statusOf(bare.queue, 'g6:place:nether_portal')}`,
  )
  check(
    '(i-0) AFTER: the identical ledger with the probe retires both rows and the queue advances',
    withProbe.queue.current?.id === 'g8:collect:blaze_rod' && retiredMarkers(withProbe.markers).length === 2,
    `head=${withProbe.queue.current?.id ?? 'none'} markers=${retiredMarkers(withProbe.markers).length}`,
  )
}

// (i-a) the body stands in the overworld: the recorded frame's own interior
// cells read back as nether_portal - the strongest, live half.
{
  // The parent's fixture shape: the restored CURRENT goal IS the portal build.
  const stale = [frameRow(), lightRow(), blazeRow()]
  const world = probe({ dimension: OVERWORLD, blocks: portalBlocks(), resources: [portalResource()] })
  const { queue, markers, details } = restoreHarness(stale, world)
  const lines = retiredMarkers(markers)
  const light = lines.find((line) => line.includes('id=g6:place:nether_portal')) ?? ''
  const frame = lines.find((line) => line.includes('id=g5:place:obsidian')) ?? ''
  check(
    '(i-a) measured restore: built+lit+verified gate -> the M2 rows retire and the M3 work takes the head',
    statusOf(queue, 'g5:place:obsidian') === 'done' &&
      statusOf(queue, 'g6:place:nether_portal') === 'done' &&
      queue.current?.id === 'g8:collect:blaze_rod' &&
      queue.current?.status === 'active',
    `frame=${statusOf(queue, 'g5:place:obsidian')} light=${statusOf(queue, 'g6:place:nether_portal')} head=${queue.current?.id ?? 'none'}`,
  )
  check(
    '(i-a) the retirement marker names the goal, the predicate and the observed world fact',
    light.includes(`predicate=${PORTAL_LIT_PREDICATE}`) &&
      light.includes('source=live-block-read') &&
      light.includes(`interior=${NETHER_PORTAL}x${LAYOUT.interior.length}`) &&
      light.includes('origin=25,66,9') &&
      frame.includes('predicate=placement_cells') &&
      frame.includes(`cells=${LAYOUT.frame.length}/${LAYOUT.frame.length}`),
    `light=[${light}] frame=[${frame}]`,
  )
  const detail = details.find((entry) => entry.id === 'g6:place:nether_portal')
  check(
    '(i-a) the structured mirror detail carries the same evidence',
    detail?.predicate === PORTAL_LIT_PREDICATE && detail?.source === 'live-block-read',
    `detail=${JSON.stringify(detail ?? null)}`,
  )
  check(
    '(i-a) the retired row records WHY in its durable detail',
    (queue.state.goals.find((goal) => goal.id === 'g6:place:nether_portal')?.detail ?? '').includes(
      `success predicate '${PORTAL_LIT_PREDICATE}' already holds`,
    ),
    `detail=${queue.state.goals.find((goal) => goal.id === 'g6:place:nether_portal')?.detail ?? 'none'}`,
  )
}

// (i-b) the measured CROSS-DIMENSION case: the body is in the Nether, so the
// overworld chunks cannot be read at all. The run's own verified record is the
// same truth the ladder rung and the M3 `portal_verified` gate read.
{
  const stale = [frameRow(), lightRow(), blazeRow()]
  const world = probe({ dimension: NETHER, unreadable: [...LAYOUT.frame, ...LAYOUT.interior], resources: [portalResource()] })
  const { queue, markers } = restoreHarness(stale, world)
  const lines = retiredMarkers(markers)
  const light = lines.find((line) => line.includes('id=g6:place:nether_portal')) ?? ''
  const frame = lines.find((line) => line.includes('id=g5:place:obsidian')) ?? ''
  check(
    '(i-b) body in the Nether: the durable verified record retires the M2 rows the live read cannot reach',
    statusOf(queue, 'g5:place:obsidian') === 'done' &&
      statusOf(queue, 'g6:place:nether_portal') === 'done' &&
      queue.current?.id === 'g8:collect:blaze_rod',
    `frame=${statusOf(queue, 'g5:place:obsidian')} light=${statusOf(queue, 'g6:place:nether_portal')} head=${queue.current?.id ?? 'none'}`,
  )
  check(
    '(i-b) the evidence names the durable source, never a live read it did not make',
    light.includes('source=durable-verified-record') &&
      light.includes('origin=25,66,9') &&
      frame.includes('source=durable-verified-record'),
    `light=[${light}] frame=[${frame}]`,
  )
}

// (i-c) ACTIVATION, not only restore: a plan applied while the gate already
// stands retires its own stale row before the executor ever runs.
{
  const markers: string[] = []
  const queue = new GoalQueue()
  const world = probe({ dimension: OVERWORLD, blocks: portalBlocks(), resources: [portalResource()] })
  queue.setGoalSuccessProbe(
    (goal) => evaluateGoalSuccess(goal, world),
    (line) => markers.push(line),
  )
  const planned: PlannedGoal = {
    kind: 'place',
    description: 'light the portal with flint_and_steel',
    targetItem: NETHER_PORTAL,
    requiredCount: 1,
    targetPredicate: PORTAL_LIT_PREDICATE,
    dimension: OVERWORLD,
  }
  queue.applyPlan([planned], 'llm', 'replace')
  check(
    '(i-c) plan apply: the satisfied row retires at ACTIVATION and the queue is empty again',
    queue.current === null && retiredMarkers(markers).length === 1,
    `current=${queue.current?.id ?? 'none'} markers=${retiredMarkers(markers).length}`,
  )
}

// (i-d) BOUNDARY (recorded on purpose): the historical ledger put a plain
// `collect obsidian` row in FRONT of the two world-outcome rows. That row's own
// success predicate is an INVENTORY count that genuinely does not hold, so this
// path must NOT touch it: "is this prerequisite still wanted?" is the
// prerequisite-orphan question (`retireOrphanedPrerequisites` /
// `orphanedPrerequisiteDecision`, whose exact-edge model has no `place` consumer
// edge), not a success-predicate question. The two outcome rows still retire.
{
  const stale = [collectObsidianRow(), frameRow(), lightRow(), blazeRow()]
  const world = probe({ dimension: NETHER, unreadable: [...LAYOUT.frame, ...LAYOUT.interior], resources: [portalResource()] })
  const { queue, markers } = restoreHarness(stale, world)
  const ids = retiredMarkers(markers).map((line) => line.split(' ')[1])
  check(
    '(i-d) boundary: the stale inventory prerequisite is NOT retired here, only the world-outcome rows',
    statusOf(queue, 'g4:collect:obsidian') === 'active' &&
      statusOf(queue, 'g5:place:obsidian') === 'done' &&
      statusOf(queue, 'g6:place:nether_portal') === 'done' &&
      ids.join(',') === 'id=g5:place:obsidian,id=g6:place:nether_portal',
    `collect=${statusOf(queue, 'g4:collect:obsidian')} frame=${statusOf(queue, 'g5:place:obsidian')} light=${statusOf(queue, 'g6:place:nether_portal')} retired=[${ids.join(',')}]`,
  )
}

// ---------------------------------------------------------------------------
// (ii) NO PORTAL -> unchanged
// ---------------------------------------------------------------------------

// (ii-a) a genuinely fresh build: nothing recorded, everything readable and air.
{
  const stale = [collectObsidianRow(), frameRow(), lightRow(), blazeRow()]
  const world = probe({ dimension: OVERWORLD, blocks: new Map(), resources: [] })
  const { queue, markers } = restoreHarness(stale, world)
  check(
    '(ii-a) no portal: the M2 rows stay and keep the head, and nothing is retired',
    statusOf(queue, 'g5:place:obsidian') === 'pending' &&
      statusOf(queue, 'g6:place:nether_portal') === 'pending' &&
      queue.current?.id === 'g4:collect:obsidian' &&
      retiredMarkers(markers).length === 0,
    `frame=${statusOf(queue, 'g5:place:obsidian')} light=${statusOf(queue, 'g6:place:nether_portal')} head=${queue.current?.id ?? 'none'} markers=${markers.length}`,
  )
}

// (ii-b) an intact frame that is NOT lit, with no verified record: both rows
// stay. (`light_portal` is still real work.)
{
  const blocks = new Map<string, string>()
  for (const cell of LAYOUT.frame) blocks.set(key(cell), OBSIDIAN)
  const world = probe({ dimension: OVERWORLD, blocks, resources: [] })
  const { queue, markers } = restoreHarness([frameRow(), lightRow(), blazeRow()], world)
  check(
    '(ii-b) intact but unlit frame: the light row stays live',
    statusOf(queue, 'g5:place:obsidian') === 'done' &&
      statusOf(queue, 'g6:place:nether_portal') === 'active' &&
      queue.current?.id === 'g6:place:nether_portal' &&
      retiredMarkers(markers).length === 1,
    `frame=${statusOf(queue, 'g5:place:obsidian')} light=${statusOf(queue, 'g6:place:nether_portal')} head=${queue.current?.id ?? 'none'}`,
  )
}

// (ii-c) a half-built frame stays live work.
{
  const blocks = new Map<string, string>()
  for (const [index, cell] of LAYOUT.frame.entries()) blocks.set(key(cell), index === 0 ? 'air' : OBSIDIAN)
  const world = probe({ dimension: OVERWORLD, blocks, resources: [] })
  const { queue, markers } = restoreHarness([frameRow(), lightRow()], world)
  check(
    '(ii-c) half-built frame: the frame row stays and its normal path runs',
    statusOf(queue, 'g5:place:obsidian') === 'active' && queue.current?.id === 'g5:place:obsidian' && retiredMarkers(markers).length === 0,
    `frame=${statusOf(queue, 'g5:place:obsidian')} head=${queue.current?.id ?? 'none'}`,
  )
}

// (ii-d) THE MEASURED RUN'S ACTUAL HEAD ROW. `planId=g1:place:nether_portal`
// with `semanticOptionInstanceId=enter_portal:goal#dminecraft_the_nether~pportal_entered`
// (CAUSAL, run-muchajde-1qhat 10:14-10:21) is the dimension-transfer row, not the
// light row: its own predicate is "the body is in the Nether", which is FALSE
// while it is in the overworld. It must never be retired for a verified portal -
// retiring it would strand the body in the overworld with M3 queued.
{
  const world = probe({ dimension: OVERWORLD, blocks: portalBlocks(), resources: [portalResource()] })
  const { queue, markers } = restoreHarness([entryRow(), blazeRow()], world)
  check(
    '(ii-d) the measured entry row in the overworld is NOT retired by a verified portal',
    statusOf(queue, 'g7:place:nether_portal') === 'active' &&
      queue.current?.id === 'g7:place:nether_portal' &&
      retiredMarkers(markers).length === 0,
    `entry=${statusOf(queue, 'g7:place:nether_portal')} head=${queue.current?.id ?? 'none'} markers=${markers.length}`,
  )
}

// (ii-e) ...and the same row DOES retire the moment its own predicate holds.
{
  const world = probe({ dimension: NETHER, blocks: portalBlocks(), resources: [portalResource(NETHER)] })
  const { queue, markers } = restoreHarness([entryRow(), blazeRow()], world)
  check(
    '(ii-e) the entry row retires when the body is in its target dimension',
    statusOf(queue, 'g7:place:nether_portal') === 'done' &&
      queue.current?.id === 'g8:collect:blaze_rod' &&
      retiredMarkers(markers).some((line) => line.includes('predicate=portal_entered') && line.includes('source=live-dimension')),
    `entry=${statusOf(queue, 'g7:place:nether_portal')} head=${queue.current?.id ?? 'none'} markers=[${retiredMarkers(markers).join(' | ')}]`,
  )
}

// ---------------------------------------------------------------------------
// (iii) UNKNOWN IS NOT SATISFACTION
// ---------------------------------------------------------------------------

// (iii-a) no body / no world at all and NOTHING recorded: dimension unknown,
// every read unreadable, no durable record - the predicate cannot be evaluated,
// so both rows stay. Unloaded is not absence.
{
  const world = probe({ dimension: null, unreadable: [...LAYOUT.frame, ...LAYOUT.interior], resources: [] })
  const { queue, markers } = restoreHarness([frameRow(), lightRow()], world)
  const lightEvidence = evaluateGoalSuccess(lightRow(), world)
  check(
    '(iii-a) unobservable world + no record: nothing is retired',
    statusOf(queue, 'g5:place:obsidian') === 'active' &&
      statusOf(queue, 'g6:place:nether_portal') === 'pending' &&
      lightEvidence?.status === 'unknown' &&
      retiredMarkers(markers).length === 0,
    `frame=${statusOf(queue, 'g5:place:obsidian')} light=${statusOf(queue, 'g6:place:nether_portal')} evidence=${JSON.stringify(lightEvidence)} markers=${markers.length}`,
  )
}

// (iii-a2) the same unobservable world WITH the run's durable verified record:
// now the predicate IS evaluable (the record is the run's own proof) and both
// rows retire with the durable source named - the record is never presented as a
// live read it did not make.
{
  const world = probe({ dimension: null, unreadable: [...LAYOUT.frame, ...LAYOUT.interior], resources: [portalResource()] })
  const { queue, markers } = restoreHarness([frameRow(), lightRow(), blazeRow()], world)
  const lines = retiredMarkers(markers)
  check(
    '(iii-a2) unobservable world + verified record: the durable half retires both rows, named as durable',
    lines.length === 2 && lines.every((line) => line.includes('source=durable-verified-record')) && queue.current?.id === 'g8:collect:blaze_rod',
    `markers=[${lines.join(' | ')}] head=${queue.current?.id ?? 'none'}`,
  )
}

// (iii-b) no record and nothing readable: UNKNOWN, both stay.
{
  const world = probe({ dimension: null, unreadable: [...LAYOUT.frame, ...LAYOUT.interior], resources: [] })
  const { queue, markers } = restoreHarness([frameRow(), lightRow()], world)
  const lightEvidence = evaluateGoalSuccess(lightRow(), world)
  const frameEvidence = evaluateGoalSuccess(frameRow(), world)
  check(
    '(iii-b) no record + unreadable cells: both rows stay and the evidence says unknown',
    statusOf(queue, 'g5:place:obsidian') === 'active' &&
      statusOf(queue, 'g6:place:nether_portal') === 'pending' &&
      lightEvidence?.status === 'unknown' &&
      frameEvidence?.status === 'unknown' &&
      retiredMarkers(markers).length === 0,
    `frame=${statusOf(queue, 'g5:place:obsidian')} light=${statusOf(queue, 'g6:place:nether_portal')} lightEvidence=${JSON.stringify(lightEvidence)} frameEvidence=${JSON.stringify(frameEvidence)}`,
  )
}

// (iii-c) a partial record never upgrades a partial frame.
{
  const partial = { ...portalResource(), frameCells: LAYOUT.frame.slice(0, 3).map((cell) => ({ ...cell })) }
  const world = probe({ dimension: NETHER, unreadable: [...LAYOUT.frame], resources: [partial] })
  const { queue, markers } = restoreHarness([frameRow(), blazeRow()], world)
  check(
    '(iii-c) an incomplete verified record does not claim the whole frame',
    statusOf(queue, 'g5:place:obsidian') === 'active' && queue.current?.id === 'g5:place:obsidian' && retiredMarkers(markers).length === 0,
    `frame=${statusOf(queue, 'g5:place:obsidian')} head=${queue.current?.id ?? 'none'}`,
  )
}

// (iii-c2) a record the LIVE world contradicts is never upgraded to the durable
// half: the gate's interior reads back as air, so "the portal exists" is
// disproved here and the row keeps its normal path (the world-memory sync owns
// the record's revocation, not this module).
{
  const blocks = new Map<string, string>()
  for (const cell of LAYOUT.frame) blocks.set(key(cell), OBSIDIAN)
  for (const cell of LAYOUT.interior) blocks.set(key(cell), 'air')
  const world = probe({ dimension: OVERWORLD, blocks, resources: [portalResource()] })
  const evidence = evaluateGoalSuccess(lightRow(), world)
  const { queue, markers } = restoreHarness([lightRow(), blazeRow()], world)
  check(
    '(iii-c2) a live-contradicted record does not satisfy the light row',
    evidence?.status === 'unsatisfied' &&
      evidence.source === 'live-block-read' &&
      statusOf(queue, 'g6:place:nether_portal') === 'active' &&
      retiredMarkers(markers).length === 0,
    `evidence=${JSON.stringify(evidence)} light=${statusOf(queue, 'g6:place:nether_portal')} markers=${markers.length}`,
  )
}

// (iii-d) the entry row with an unreadable dimension is UNKNOWN, never DONE.
{
  const world = probe({ dimension: null, resources: [] })
  const { queue, markers } = restoreHarness([entryRow(), blazeRow()], world)
  check(
    '(iii-d) entry row with no observable dimension: not retired',
    statusOf(queue, 'g7:place:nether_portal') === 'active' && retiredMarkers(markers).length === 0,
    `entry=${statusOf(queue, 'g7:place:nether_portal')} markers=${markers.length}`,
  )
}

// (iii-e) a THROWING probe is a bug, not a verdict: reported, row untouched.
{
  const markers: string[] = []
  const queue = new GoalQueue()
  queue.setGoalSuccessProbe(
    () => {
      throw new Error('probe exploded')
    },
    (line) => markers.push(line),
  )
  queue.restore(ledger([frameRow(), blazeRow()]))
  const errors = markers.filter((line) => line.startsWith(GOAL_SUCCESS_PROBE_ERROR))
  check(
    '(iii-e) a throwing probe leaves the row alone and reports the failure',
    queue.current?.id === 'g5:place:obsidian' && errors.length >= 1 && errors.every((line) => line.includes('action=not_retired')),
    `head=${queue.current?.id ?? 'none'} errors=[${errors.join(' | ')}]`,
  )
}

// ---------------------------------------------------------------------------
// (iv) ORDINARY GOALS ARE UNTOUCHED
// ---------------------------------------------------------------------------
{
  const ordinary = [
    row({ id: 'g1:collect:log', kind: 'collect', description: 'collect 3 x log', targetItem: 'log', requiredCount: 3 }),
    row({ id: 'g2:craft:crafting_table', kind: 'craft', description: 'craft 1 x crafting_table', targetItem: 'crafting_table', requiredCount: 1 }),
    row({ id: 'g3:descend:raw_iron', kind: 'descend', description: 'descend to the iron band', targetItem: 'raw_iron', requiredCount: 1, targetY: 32, dimension: OVERWORLD }),
    row({ id: 'g9:goto:waypoint', kind: 'goto', description: 'walk to the remembered waypoint', targetItem: null, requiredCount: 1, targetPosition: { x: 1, y: 64, z: 1 }, dimension: OVERWORLD }),
  ]
  const prereqLines: string[] = []
  const withoutProbe = restoreHarness(ordinary, null, prereqLines)
  const withProbe = restoreHarness(
    ordinary,
    probe({ dimension: OVERWORLD, blocks: portalBlocks(), resources: [portalResource()] }),
    prereqLines,
  )
  const before = JSON.stringify(withoutProbe.queue.snapshot())
  const after = JSON.stringify(withProbe.queue.snapshot())
  check(
    '(iv) no checkable predicate: the durable queue is byte-identical with and without the probe',
    before === after && retiredMarkers(withProbe.markers).length === 0 && withoutProbe.queue.current?.id === 'g1:collect:log',
    `identical=${before === after} head=${withProbe.queue.current?.id ?? 'none'} markers=${withProbe.markers.length}`,
  )
  check(
    '(iv) item goals carry no predicate family and are never probed',
    goalSuccessPredicateFor(ordinary[0]!) === null &&
      goalSuccessPredicateFor(ordinary[1]!) === null &&
      goalSuccessPredicateFor(ordinary[2]!) === null &&
      goalSuccessPredicateFor(ordinary[3]!) === null,
    `collect=${goalSuccessPredicateFor(ordinary[0]!)} craft=${goalSuccessPredicateFor(ordinary[1]!)} descend=${goalSuccessPredicateFor(ordinary[2]!)} goto=${goalSuccessPredicateFor(ordinary[3]!)}`,
  )
}

// ---------------------------------------------------------------------------
// (v) RESTORE ROUND-TRIP: the retirement survives the ledger save/load cycle
// ---------------------------------------------------------------------------
{
  const stale = [frameRow(), lightRow(), blazeRow()]
  const world = probe({ dimension: NETHER, unreadable: [...LAYOUT.frame, ...LAYOUT.interior], resources: [portalResource()] })
  const first = restoreHarness(stale, world)
  const saved = JSON.parse(JSON.stringify(first.queue.snapshot())) as GoalQueueSnapshot

  // (v-1) the reload has NO probe installed: the retired rows must not come back.
  const reloaded = new GoalQueue()
  reloaded.restore(saved)
  check(
    '(v-1) ledger round-trip without a probe: retired rows stay done and the M3 row keeps the head',
    statusOf(reloaded, 'g5:place:obsidian') === 'done' &&
      statusOf(reloaded, 'g6:place:nether_portal') === 'done' &&
      reloaded.current?.id === 'g8:collect:blaze_rod' &&
      reloaded.state.depth === 1,
    `frame=${statusOf(reloaded, 'g5:place:obsidian')} light=${statusOf(reloaded, 'g6:place:nether_portal')} head=${reloaded.current?.id ?? 'none'} depth=${reloaded.state.depth}`,
  )
  check(
    '(v-2) the persisted row keeps the reason it was retired',
    (reloaded.state.goals.find((goal) => goal.id === 'g6:place:nether_portal')?.detail ?? '').includes('already holds'),
    `detail=${reloaded.state.goals.find((goal) => goal.id === 'g6:place:nether_portal')?.detail ?? 'none'}`,
  )

  // (v-3) a reload with the probe re-armed against the same world truth is
  // stable: nothing new is retired and no row is re-opened.
  const second = restoreHarness(saved.goals, world)
  check(
    '(v-3) reload with the probe re-armed: no double retirement, no resurrection',
    retiredMarkers(second.markers).length === 0 && second.queue.current?.id === 'g8:collect:blaze_rod',
    `markers=${retiredMarkers(second.markers).length} head=${second.queue.current?.id ?? 'none'}`,
  )
}

// ---------------------------------------------------------------------------
// (vi) THE MECHANISM IS NOT PORTAL-SPECIFIC
// ---------------------------------------------------------------------------
{
  const cell: GoalSuccessCell = { x: 4, y: 64, z: 4 }
  const tableRow = row({
    id: 'g10:place:crafting_table',
    kind: 'place',
    description: 'place 1 x crafting_table',
    targetItem: 'crafting_table',
    requiredCount: 1,
    placementCells: [cell],
    dimension: OVERWORLD,
  })
  const blocks = new Map<string, string>([[key(cell), 'crafting_table']])
  const world = probe({ dimension: OVERWORLD, blocks, resources: [] })
  const evidence = evaluateGoalSuccess(tableRow, world)
  const { queue, markers } = restoreHarness([tableRow, blazeRow()], world)
  check(
    '(vi-a) a non-portal place row retires through the same family',
    evidence?.status === 'satisfied' &&
      evidence.predicate === 'placement_cells' &&
      evidence.source === 'live-block-read' &&
      statusOf(queue, 'g10:place:crafting_table') === 'done' &&
      queue.current?.id === 'g8:collect:blaze_rod',
    `evidence=${JSON.stringify(evidence)} status=${statusOf(queue, 'g10:place:crafting_table')} head=${queue.current?.id ?? 'none'} markers=[${retiredMarkers(markers).join(' | ')}]`,
  )
  // (vi-b) the durable half is block-generic too: any verified block record uses
  // the same shape, with no portal involved at all.
  const recordWorld: GoalSuccessWorldProbe = {
    ...probe({ dimension: NETHER, unreadable: [cell], resources: [] }),
    verifiedBlockRecords: [{ block: 'crafting_table', dimension: OVERWORLD, cells: [cell] }],
  }
  const recordEvidence = evaluateGoalSuccess(tableRow, recordWorld)
  check(
    '(vi-b) a verified block record drives the same durable half',
    recordEvidence?.status === 'satisfied' && recordEvidence.source === 'durable-verified-record',
    `evidence=${JSON.stringify(recordEvidence)}`,
  )
}

// ---------------------------------------------------------------------------
// (vii) EVIDENCE VISIBILITY: mirrored token + controller wiring
// ---------------------------------------------------------------------------
{
  const marker = `${GOAL_RETIRED_PREDICATE} id=g6:place:nether_portal kind=place item=nether_portal predicate=portal_lit source=durable-verified-record detail="x"`
  check(
    '(vii-a) the retirement marker rides the MIRRORED event path',
    mirroredEventToken(marker) === GOAL_RETIRED_PREDICATE &&
      mirroredEventToken(`${GOAL_SUCCESS_PROBE_ERROR} id=g1 message="x" action=not_retired`) === GOAL_SUCCESS_PROBE_ERROR,
    `retire=${mirroredEventToken(marker)} error=${mirroredEventToken(`${GOAL_SUCCESS_PROBE_ERROR} id=g1 message="x" action=not_retired`)}`,
  )
  const source = readFileSync(new URL('./src/controller.ts', import.meta.url), 'utf8')
  const planeSource = readFileSync(new URL('./src/goal-queue-plane.ts', import.meta.url), 'utf8')
  const installs = source.match(/this\.installGoalSuccessProbe\(\)/g)?.length ?? 0
  check(
    '(vii-b) the controller wires the probe at both queue-construction sites (constructor + setOptions)',
    installs >= 2 && planeSource.includes('evaluateGoalSuccess(goal, host.goalWorldProbe())'),
    `installs=${installs}`,
  )
}


// ---------------------------------------------------------------------------
// The durable half may not overrule a live read. With TWO recorded sites - one
// readable whose interior is NOT lit, one merely unreadable - the readable one has
// spoken and the goal must be `unsatisfied`. Before the fix the unreadable site's
// durable record retired the goal that the readable site had just disproved, while
// evaluatePlacementCells already returned `unsatisfied` in the same situation.
// ---------------------------------------------------------------------------

{
  const SHIFT = 48
  const shifted = (cell: GoalSuccessCell): GoalSuccessCell => ({ x: cell.x + SHIFT, y: cell.y, z: cell.z })
  const siteA = portalResource(OVERWORLD) // readable: its interior reads `air` below
  const siteB = {
    ...portalResource(OVERWORLD),
    position: { ...siteA.position, x: siteA.position.x + SHIFT },
    frameCells: siteA.frameCells.map(shifted),
  }
  const world = probe({
    // no portal blocks anywhere: site A's interior is readable and positively unlit
    blocks: new Map<string, string>(),
    // site B is unobservable: every interior cell fails to read
    unreadable: LAYOUT.interior.map(shifted),
    resources: [siteA, siteB],
  })
  const evidence = evaluateGoalSuccess(lightRow(), world)
  check(
    'a live read that disproves one site is not overruled by another site durable record',
    evidence !== null && evidence.status === 'unsatisfied',
    evidence === null
      ? 'no evidence returned'
      : `status=${evidence.status} source=${evidence.source} detail=${String(evidence.detail).slice(0, 90)}`,
  )
}

process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
if (failures > 0) process.exit(1)
