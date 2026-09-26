// test-descend-domination.mts - an iron-source row of ANY kind retires when the
// iron rung is already satisfied, and the frontier's enter-portal candidate comes
// back.
//
// Live defect (run-mubhn83u, source 0ffa709): the M2 gate was built, lit and
// verified, the ladder frontier was `blaze_rods`/`enter_nether`, and the bot held
// `diamond_pickaxe=1` + `flint_and_steel=1` (so the `iron_ingot` rung's own
// `satisfied` predicate was already true) - yet the resident kept descending:
//
//   milestone query: goalItem=iron_ingot goalCount=3
//   active ledger row: g24:descend:raw_iron kind=descend item=raw_iron 0/1
//                      opt=explore:cave
//   actions: DESCEND:down:W:b24_64_10 ...
//
// `dominatedPrerequisiteReason` (buddy-driver/planner-ladder.ts) rejected every
// row whose kind was not `collect`/`craft`/`smelt`, so the proof that already
// retired `collect`/`smelt` iron rows never even ran for the measured
// `descend:raw_iron` row - the same item, the same satisfied consumer, the same
// held substitutes. Mercury compiles its `explore:cave` plan goal to exactly this
// shape (`mercury-system2.ts`: kind 'descend', targetItem 'raw_iron'), so the
// retirement route was dead on the live path.
//
// Fixtures: (a) the exact live shape retires with the typed marker and a
// milestone report that no longer names iron_ingot; (b) without the substitutes
// the descend row stays; (c) a genuinely needed `descend:<ore>` row is untouched;
// (d) the existing collect/craft/smelt domination semantics are unchanged; plus
// (e) the enter-portal candidate for the lit frame at 25..28,z9 is offered once
// the dominated row is gone, and was NOT offered while it held the plan slot.
//
// Run: bun ./test-descend-domination.mts
import { buildLadder, deriveResumeRung, dominatedPrerequisiteReason } from './planner.ts'
import { compatibilityRootGoal, reconcileLedgerGoals } from './generation-entry.ts'
import { emptyWorldMemory } from './resident-types.ts'
import type { ResidentWorldMemory } from './resident-types.ts'
import { milestoneReport } from './milestone-report.ts'
import { GoalQueue, PREREQ_DOMINATED, PREREQ_RETIRED, setPrereqAuditSink } from '../jev-agent/src/goalQueue.ts'
import type { GoalQueueSnapshot, GoalStatus, PlannedGoal, QueuedGoal } from '../jev-agent/src/goalQueue.ts'
import {
  NETHER,
  NETHER_PORTAL,
  OVERWORLD,
  PORTAL_ENTERED_PREDICATE,
  netherPortalEntryGoal,
  planPortalEntry,
  portalFrameLayout,
} from '../jev-agent/src/netherPortalPlan.ts'
import type { PortalEntryPlan, PortalFrameSite } from '../jev-agent/src/netherPortalPlan.ts'
import { defaultCandidateOptions, generateGroundedCandidates } from '../jev-agent/src/candidates.ts'
import type { CandidateOptions } from '../jev-agent/src/candidates.ts'
import type { AgentSignals, InventoryState, SelfState, Vec3Json, WorldState } from '../jev-agent/src/state.ts'
import type { GoalQueueState } from '../jev-agent/src/goalQueue.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

/**
 * The measured live inventory (control-socket INVENTORY after the gate was lit):
 * the `iron_ingot` rung's `satisfied` predicate is already true through
 * `ironPurposesFulfilled` = an iron-or-better pickaxe AND flint_and_steel.
 */
const LIVE_COUNTS: Record<string, number> = {
  diamond: 3,
  diamond_pickaxe: 1,
  flint_and_steel: 1,
  iron_ingot: 2,
  raw_iron: 1,
  cobblestone: 22,
  charcoal: 1,
  furnace: 1,
  crafting_table: 1,
  stick: 4,
}
/** The M2 materials case: no pickaxe at all - iron IS genuinely needed. */
const NO_SUBSTITUTE_COUNTS: Record<string, number> = {
  iron_ingot: 2,
  cobblestone: 22,
  charcoal: 1,
  furnace: 1,
  crafting_table: 1,
  stick: 4,
}

/** Overworld with the gate built + lit + verified (frontier = enter_nether). */
const PORTAL_LIT_WORLD: ResidentWorldMemory = { ...emptyWorldMemory(), portalVerified: true }
/** Body already in the Nether (frontier = blaze_rods). */
const NETHER_WORLD: ResidentWorldMemory = { ...emptyWorldMemory(), dimension: 'minecraft:the_nether' }

function row(
  partial: Partial<QueuedGoal> & {
    id: string
    kind: QueuedGoal['kind']
    targetItem: string | null
    requiredCount: number
    status: GoalStatus
  },
): QueuedGoal {
  return {
    description: `${partial.kind} ${partial.requiredCount} x ${partial.targetItem ?? 'none'}`,
    targetY: null,
    dimension: null,
    startCount: 0,
    haveCount: 0,
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
    ...partial,
  }
}

/** The exact live durable ledger rows around the defect (ids from the ledger mirror). */
function liveLedger(): GoalQueueSnapshot {
  return {
    counter: 24,
    goals: [
      row({ id: 'g10:place:obsidian', kind: 'place', targetItem: 'obsidian', requiredCount: 10, status: 'done', haveCount: 10, core: true }),
      row({
        id: 'g11:place:nether_portal',
        kind: 'place',
        description: 'light the portal with flint_and_steel',
        targetItem: NETHER_PORTAL,
        requiredCount: 1,
        targetPredicate: 'portal_lit',
        dimension: OVERWORLD,
        status: 'done',
        haveCount: 1,
        core: true,
      }),
      descendsForRawIron(),
    ],
    revision: 24,
  }
}

/** The measured active row: `g24:descend:raw_iron kind=descend item=raw_iron 0/1 opt=explore:cave`. */
function descendsForRawIron(): QueuedGoal {
  return row({
    id: 'g24:descend:raw_iron',
    kind: 'descend',
    description: 'explore',
    targetItem: 'raw_iron',
    requiredCount: 1,
    targetY: 32,
    dimension: OVERWORLD,
    status: 'active',
  })
}

function marker(lines: readonly string[], prefix: string): string[] {
  return lines.filter((line) => line.startsWith(prefix))
}

function liveFrontier(counts: Record<string, number>, world: ResidentWorldMemory): { rungId: string; rungIndex: number; goals: PlannedGoal[] } {
  const resume = deriveResumeRung(counts, world)
  const ladder = buildLadder(counts, world, undefined, { resumeRungIndex: resume.rungIndex })
  return { rungId: ladder.rungId, rungIndex: ladder.rungIndex, goals: ladder.goals }
}

// ---------------------------------------------------------------------------
// (a) the exact live shape: frontier blaze_rods, substitutes held, active
//     descend:raw_iron row -> dominated with the typed proof
// ---------------------------------------------------------------------------
addCase('(a) the live descend:raw_iron row is dominated by the held substitutes', () => {
  const overworld = dominatedPrerequisiteReason({ kind: 'descend', targetItem: 'raw_iron', requiredCount: 1 }, LIVE_COUNTS, PORTAL_LIT_WORLD)
  const nether = dominatedPrerequisiteReason({ kind: 'descend', targetItem: 'raw_iron', requiredCount: 1 }, LIVE_COUNTS, NETHER_WORLD)
  const expected = overworld?.item === 'raw_iron' &&
    overworld.held.join(',') === 'diamond_pickaxe,flint_and_steel' &&
    overworld.reason === 'all_consumers_satisfied'
  const pass = expected && nether?.reason === 'all_consumers_satisfied'
  return { pass, detail: `overworld=${JSON.stringify(overworld)} nether=${JSON.stringify(nether)}` }
})

addCase('(a) the frontier the live run measured: blaze_rods, and the iron rung satisfied', () => {
  const nether = liveFrontier(LIVE_COUNTS, NETHER_WORLD)
  const entry = liveFrontier(LIVE_COUNTS, PORTAL_LIT_WORLD)
  // The rung's own predicate must already be true, or the fixture proves nothing.
  const ironFrontier = liveFrontier({ ...LIVE_COUNTS, diamond_pickaxe: 0, flint_and_steel: 0 }, PORTAL_LIT_WORLD)
  const pass =
    nether.rungId === 'blaze_rods' &&
    entry.rungId === 'enter_nether' &&
    // the Nether frontier is past the dimension-transfer rung
    nether.rungIndex > entry.rungIndex &&
    ironFrontier.rungId !== 'blaze_rods' &&
    ironFrontier.rungId !== 'enter_nether'
  return { pass, detail: `nether=${nether.rungId}@${nether.rungIndex} entry=${entry.rungId}@${entry.rungIndex} withoutSubstitutes=${ironFrontier.rungId}` }
})

addCase('(a) the runtime GoalQueue retires the live row with PREREQ_DOMINATED', () => {
  const lines: string[] = []
  setPrereqAuditSink((line) => lines.push(line))
  const queue = new GoalQueue()
  queue.setDominatedPrerequisiteReason((goal) => dominatedPrerequisiteReason(goal, LIVE_COUNTS, NETHER_WORLD))
  queue.restore(liveLedger())
  const retired = queue.state.goals.find((goal) => goal.id === 'g24:descend:raw_iron')
  const dominated = marker(lines, PREREQ_DOMINATED)
  const line = dominated.find((entry) => entry.includes('id=g24:descend:raw_iron'))
  const pass =
    retired?.status === 'impossible' &&
    retired.detail?.includes('item=raw_iron') === true &&
    retired.detail?.includes('reason=all_consumers_satisfied') === true &&
    line?.includes('held=diamond_pickaxe,flint_and_steel') === true &&
    queue.current === null &&
    queue.isEmpty &&
    marker(lines, PREREQ_RETIRED).length === 0
  return { pass, detail: `row=${retired?.status} current=${queue.current?.id ?? 'none'} lines=[${dominated.join(' | ')}]` }
})

addCase('(a) the restore reconciliation retires the live row too', () => {
  const { snapshot, dominated } = reconcileLedgerGoals(liveLedger(), LIVE_COUNTS, NETHER_WORLD)
  const retired = snapshot.goals.find((goal) => goal.id === 'g24:descend:raw_iron')
  const proof = dominated.find((entry) => entry.item === 'raw_iron')
  const pass =
    retired?.status === 'impossible' &&
    retired.detail?.includes('reason=all_consumers_satisfied') === true &&
    proof?.held.join(',') === 'diamond_pickaxe,flint_and_steel' &&
    snapshot.goals.every((goal) => goal.status !== 'active' && goal.status !== 'pending')
  return { pass, detail: `row=${retired?.status} dominated=[${dominated.map((d) => `${d.item}:${d.held.join('+')}:${d.reason}`).join(' | ')}]` }
})

addCase('(a) the milestone report stops advertising iron_ingot', () => {
  const staticDefault = { goalItem: 'iron_ingot', goalCount: 3 }
  /** The pre-fix host reply, reproduced verbatim from `agent-runner.mts` (`goalItem: GOAL_ITEM`). */
  const legacyMilestoneReply = (): { goalItem: string; goalCount: number } => ({ goalItem: 'iron_ingot', goalCount: 3 })
  const nether = liveFrontier(LIVE_COUNTS, NETHER_WORLD)
  const entry = liveFrontier(LIVE_COUNTS, PORTAL_LIT_WORLD)
  // The frontier the live run is on right now (gate unverified again at y=30):
  // the projection is the obsidian frame work, never the iron seed.
  const portal = liveFrontier(LIVE_COUNTS, emptyWorldMemory())
  const portalRoot = compatibilityRootGoal(portal.goals, staticDefault)
  const netherRoot = compatibilityRootGoal(nether.goals, staticDefault)
  const entryRoot = compatibilityRootGoal(entry.goals, staticDefault)
  // The HOST reply: served from the generation's live status, exactly as
  // `agent-runner.mts` does. Before the fix this payload was the static
  // `GOAL_ITEM`/`GOAL_COUNT` pair regardless of the frontier.
  const liveStatus = { goalItem: netherRoot.goalItem, goalCount: netherRoot.goalCount }
  const reply = milestoneReport({ milestone: 'blaze_rods', milestoneIndex: 14, ledgerMirror: liveLedger(), status: liveStatus, fallback: staticDefault })
  const entryReply = milestoneReport({
    milestone: 'blaze_rods',
    milestoneIndex: 14,
    ledgerMirror: null,
    status: { goalItem: entryRoot.goalItem, goalCount: entryRoot.goalCount },
    fallback: staticDefault,
  })
  // No generation status yet (fresh host boot): the static seed is the only
  // truthful fallback, and that is the ONE case it may still appear.
  const coldReply = milestoneReport({ milestone: null, milestoneIndex: -1, ledgerMirror: null, status: null, fallback: staticDefault })
  // Widened on purpose: the assertion is that the served item is NOT the static
  // iron seed, which literal narrowing would erase.
  const replyItem: string = reply.goalItem
  const entryItem: string = entryReply.goalItem
  const replyNamesIron = replyItem === 'iron_ingot'
  const entryNamesIron = entryItem === 'iron_ingot'
  const pass =
    legacyMilestoneReply().goalItem === 'iron_ingot' &&
    netherRoot.goalItem === 'blaze_rod' &&
    netherRoot.goalCount === 7 &&
    entryRoot.goalItem === NETHER_PORTAL &&
    portalRoot.goalItem === 'obsidian' &&
    portalRoot.goalCount === 10 &&
    replyItem === 'blaze_rod' &&
    reply.goalCount === 7 &&
    entryItem === NETHER_PORTAL &&
    !replyNamesIron &&
    !entryNamesIron &&
    reply.milestone === 'blaze_rods' &&
    coldReply.goalItem === 'iron_ingot'
  return {
    pass,
    detail: `nether=${reply.goalItem}:${reply.goalCount} entry=${entryReply.goalItem}:${entryReply.goalCount} portal=${portalRoot.goalItem}:${portalRoot.goalCount} coldBoot=${coldReply.goalItem}`,
  }
})

// ---------------------------------------------------------------------------
// (b) same shape WITHOUT the substitutes: the descend row is still real work
// ---------------------------------------------------------------------------
addCase('(b) without the substitutes the descend:raw_iron row stays', () => {
  const proof = dominatedPrerequisiteReason({ kind: 'descend', targetItem: 'raw_iron', requiredCount: 1 }, NO_SUBSTITUTE_COUNTS, NETHER_WORLD)
  const lines: string[] = []
  setPrereqAuditSink((line) => lines.push(line))
  const queue = new GoalQueue()
  queue.setDominatedPrerequisiteReason((goal) => dominatedPrerequisiteReason(goal, NO_SUBSTITUTE_COUNTS, NETHER_WORLD))
  queue.restore(liveLedger())
  const pass =
    proof === null &&
    queue.current?.id === 'g24:descend:raw_iron' &&
    queue.current?.status === 'active' &&
    marker(lines, PREREQ_DOMINATED).length === 0
  return { pass, detail: `proof=${JSON.stringify(proof)} current=${queue.current?.id ?? 'none'}` }
})

// ---------------------------------------------------------------------------
// (c) a genuinely needed descend:<ore> row is untouched
// ---------------------------------------------------------------------------
addCase('(c) a needed descend:diamond row is not dominated', () => {
  // The diamond rung is satisfied by a HELD diamond, but its only consumer (the
  // diamond_pickaxe craft) names no held substitute, so nothing is proven.
  const diamond = dominatedPrerequisiteReason(
    { kind: 'descend', targetItem: 'diamond', requiredCount: 1 },
    { ...LIVE_COUNTS, diamond_pickaxe: 0 },
    NETHER_WORLD,
  )
  const rawOreNeeded = dominatedPrerequisiteReason({ kind: 'descend', targetItem: 'raw_iron', requiredCount: 1 }, NO_SUBSTITUTE_COUNTS, PORTAL_LIT_WORLD)
  const lines: string[] = []
  setPrereqAuditSink((line) => lines.push(line))
  const queue = new GoalQueue()
  queue.setDominatedPrerequisiteReason(() => diamond)
  queue.restore({ counter: 1, goals: [row({ id: 'g5:descend', kind: 'descend', description: 'descend_to:Y=-59', targetItem: 'diamond', requiredCount: 1, targetY: -59, dimension: OVERWORLD, status: 'active' })], revision: 1 })
  const pass = diamond === null && rawOreNeeded === null && queue.current?.id === 'g5:descend' && marker(lines, PREREQ_DOMINATED).length === 0
  return { pass, detail: `diamond=${JSON.stringify(diamond)} rawNeeded=${JSON.stringify(rawOreNeeded)} current=${queue.current?.id ?? 'none'}` }
})

addCase('(c) the frame/portal and movement rows are never dominated', () => {
  // The lit frame's `place:obsidian` row must not be retired by an inventory
  // closure, and the M3 terminal `recover:ender_dragon` / `goto` rows are not
  // acquisition rows at all.
  const place = dominatedPrerequisiteReason({ kind: 'place', targetItem: 'obsidian', requiredCount: 10 }, LIVE_COUNTS, PORTAL_LIT_WORLD)
  const dragon = dominatedPrerequisiteReason({ kind: 'recover', targetItem: 'ender_dragon', requiredCount: 1 }, LIVE_COUNTS, NETHER_WORLD)
  const goto = dominatedPrerequisiteReason({ kind: 'goto', targetItem: 'raw_iron', requiredCount: 1 }, LIVE_COUNTS, NETHER_WORLD)
  const surface = dominatedPrerequisiteReason({ kind: 'surface', targetItem: 'raw_iron', requiredCount: 1 }, LIVE_COUNTS, NETHER_WORLD)
  const pass = place === null && dragon === null && goto === null && surface === null
  return { pass, detail: `place=${JSON.stringify(place)} dragon=${JSON.stringify(dragon)} goto=${JSON.stringify(goto)} surface=${JSON.stringify(surface)}` }
})

// ---------------------------------------------------------------------------
// (d) the existing domination semantics are unchanged
// ---------------------------------------------------------------------------
addCase('(d) collect/smelt domination is unchanged by the widened kind filter', () => {
  const collectNoRaw = dominatedPrerequisiteReason({ kind: 'collect', targetItem: 'raw_iron', requiredCount: 1 }, { ...LIVE_COUNTS, raw_iron: 0 }, NETHER_WORLD)
  const smelt = dominatedPrerequisiteReason({ kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 3 }, LIVE_COUNTS, NETHER_WORLD)
  const keptNoPickaxe = dominatedPrerequisiteReason({ kind: 'smelt', targetItem: 'iron_ingot', requiredCount: 3 }, NO_SUBSTITUTE_COUNTS, NETHER_WORLD)
  const pass =
    collectNoRaw?.reason === 'all_consumers_satisfied' &&
    collectNoRaw.held.join(',') === 'diamond_pickaxe,flint_and_steel' &&
    smelt?.reason === 'producer_rung_satisfied' &&
    keptNoPickaxe === null
  return { pass, detail: `collect=${JSON.stringify(collectNoRaw)} smelt=${JSON.stringify(smelt)} noPickaxe=${JSON.stringify(keptNoPickaxe)}` }
})

// ---------------------------------------------------------------------------
// (e) follow-through: the retired row frees the plan slot and the lit portal's
//     ENTER candidate is offered again for the interior cell at 26,67,9
// ---------------------------------------------------------------------------
const SITE: PortalFrameSite = {
  origin: { x: 25, y: 66, z: 9 },
  widthAxis: 'x',
  safe: true,
  reachable: true,
  existingFrame: portalFrameLayout({ x: 25, y: 66, z: 9 }, 'x').frame,
}
const ENTER_CELL: Vec3Json = portalFrameLayout(SITE.origin, SITE.widthAxis).lightPosition
const APPROACH: Vec3Json = { x: ENTER_CELL.x, y: ENTER_CELL.y, z: ENTER_CELL.z - 2 }
const cellKey = (p: Vec3Json): string => `${p.x},${p.y},${p.z}`

function litBlockAt(site: PortalFrameSite, lit: boolean): (cell: Vec3Json) => string | null {
  const interior = new Set(portalFrameLayout(site.origin, site.widthAxis).interior.map(cellKey))
  return (cell: Vec3Json): string | null => (lit && interior.has(cellKey(cell)) ? NETHER_PORTAL : 'air')
}

function entryPlan(): PortalEntryPlan {
  const plan = planPortalEntry({
    site: SITE,
    self: APPROACH,
    blockAt: litBlockAt(SITE, true),
    isStandable: () => true,
    fromDimension: OVERWORLD,
    dimension: NETHER,
  })
  if (!plan.ok) throw new Error(`fixture: expected a grounded entry plan (${plan.line})`)
  return plan
}

function queuedEnterGoal(): QueuedGoal {
  const planned = netherPortalEntryGoal()
  return row({
    id: 'g25:place:nether_portal',
    kind: planned.kind,
    description: planned.description,
    targetItem: planned.targetItem ?? null,
    requiredCount: planned.requiredCount ?? 1,
    targetPredicate: planned.targetPredicate ?? null,
    dimension: planned.dimension ?? NETHER,
    status: 'active',
    core: true,
  })
}

function inventory(counts: Record<string, number>): InventoryState {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0) }
}

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_DOM',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: OVERWORLD,
    isDay: true,
    heldItem: null,
  }
}

function signals(): AgentSignals {
  return {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastPathStatus: 'idle',
    stalledMs: 0,
    lastPolicyConfidence: null,
    maxConcurrentActions: 0,
    escalationRecommended: false,
    failedCandidates: {},
    knownResources: [],
  }
}

function queueWith(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

/** The measured live body: standing in front of the lit gate at z9. */
function portalWorld(goalQueue: GoalQueueState): WorldState {
  const feet: Vec3Json = { x: APPROACH.x, y: APPROACH.y, z: APPROACH.z }
  return {
    schemaVersion: 1,
    tick: 11,
    timestampMs: 1_790_000_000_000,
    self: self(feet),
    inventory: inventory({ ...LIVE_COUNTS }),
    entities: [],
    blocks: [],
    terrain: { standable: [feet] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    portalFrameSites: [SITE],
    descent: [],
    stepCuts: [],
    headroomCuts: [],
    goal: {
      id: 'g',
      description: netherPortalEntryGoal().description,
      targetItem: NETHER_PORTAL,
      requiredCount: 1,
      startCount: 0,
      haveCount: 0,
      progress: 0,
      complete: false,
      startedAtMs: 0,
    },
    goalQueue,
    recentEvents: [],
    signals: signals(),
  }
}

function enterCandidatesFor(goalQueue: GoalQueueState): string[] {
  const options: CandidateOptions = { ...defaultCandidateOptions, reach: 4.5, portalEntry: entryPlan() }
  const grounded = generateGroundedCandidates(portalWorld(goalQueue), options)
  return grounded.candidates.filter((candidate) => candidate.kind === 'ENTER_PORTAL').map((candidate) => candidate.id)
}

addCase('(e) the lit gate at 26,67,9 grounds an ENTER_PORTAL candidate for the entry goal', () => {
  const enter = enterCandidatesFor(queueWith(queuedEnterGoal()))
  const pass = enter.includes(`ENTER:${cellKey(ENTER_CELL)}`) && cellKey(ENTER_CELL) === '26,67,9'
  return { pass, detail: `candidates=[${enter.join(',')}] expected=ENTER:${cellKey(ENTER_CELL)}` }
})

addCase('(e) while the descend row holds the plan slot no ENTER candidate is offered', () => {
  const blocked = enterCandidatesFor(queueWith(descendsForRawIron()))
  const enter = enterCandidatesFor(queueWith(queuedEnterGoal()))
  const pass = blocked.length === 0 && enter.length === 1
  return { pass, detail: `withDescend=[${blocked.join(',')}] withEntryGoal=[${enter.join(',')}]` }
})

addCase('(e) the dominated retirement is what frees the slot for the frontier plan', () => {
  const lines: string[] = []
  setPrereqAuditSink((line) => lines.push(line))
  const queue = new GoalQueue()
  queue.setDominatedPrerequisiteReason((goal) => dominatedPrerequisiteReason(goal, LIVE_COUNTS, PORTAL_LIT_WORLD))
  queue.restore(liveLedger())
  const before = enterCandidatesFor(queueWith(queue.current ?? descendsForRawIron()))
  // After the retirement the queue has no unfinished iron row left, so the
  // generation's next frontier plan (the `enter_nether` rung's entry goal) is the
  // row that owns the plan slot.
  const after = enterCandidatesFor(queueWith(queuedEnterGoal()))
  const dominated = marker(lines, PREREQ_DOMINATED)
  const pass =
    queue.current === null &&
    queue.isEmpty &&
    before.length === 0 &&
    after.includes(`ENTER:${cellKey(ENTER_CELL)}`) &&
    dominated.some((line) => line.includes('id=g24:descend:raw_iron'))
  return { pass, detail: `before=[${before.join(',')}] after=[${after.join(',')}] retired=${dominated.length}` }
})

let failures = 0
process.stdout.write('dominated iron-source rows (#prereq-dominated / descend)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
setPrereqAuditSink(null)
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} descend-domination cases passed\n`)

if (failures > 0) process.exit(1)
