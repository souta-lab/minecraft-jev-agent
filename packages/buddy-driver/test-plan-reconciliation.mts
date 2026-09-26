// test-plan-reconciliation.mts - the durable queue reconciles the plan/objective
// identity it was AUTHORED under against the live one.
//
// Live defect (m3-live, `run-mucpugqn-20evo`, boot source 213eb96): the durable
// queue head was
//
//   g1:descend:raw_iron kind=descend description="explore"
//     dim=minecraft:overworld success=levelAtMost y32 status=ACTIVE
//
// while the body was in the NETHER at y63 and the mission had moved to
// `blaze_rods` (M3). The row's own success predicate was genuinely unsatisfied
// there, so predicate retirement correctly left it alone, and the queue was never
// compared with the objective: the only identity on a durable queue was
// `GoalQueueSnapshot.basis` (worldKey + frontier rung), which is RE-STAMPED with
// the live frontier at every commit and therefore can never answer "does this
// queue still belong to the live plan?". Measured consequence: the body climbed
// to y102 in the Nether chasing an overworld y32 target, `CANDIDATE_STARVATION
// presented=1 productive=0` repeated, `WAIT_STREAK count=1..2 limit=6` reset on
// every alternating MOVE, and no System2 request was ever made.
//
// Fixtures:
//   (i)   the measured shape: the head belongs to a superseded plan while the
//         objective has moved -> reconciliation fires: the row is retired with
//         typed evidence when the code-owned proof holds, KEPT when it does not,
//         a re-plan request naming both identities is produced either way, and
//         the queue head becomes relevant again;
//   (ii)  a row whose predicate is merely unsatisfied but whose plan is CURRENT
//         -> untouched, byte for byte (the boundary the predicate lane pinned);
//   (iii) an empty queue -> `queue_empty` re-plan unchanged (reconciliation
//         produces no request and does not touch it);
//   (iv)  a healthy queue making progress -> byte-identical behaviour, and the
//         obsolescence proof is never even consulted;
//   (v)   ledger round-trip: the reconciliation survives save/restore and does
//         not resurrect the obsolete rows;
//   (vi)  the measured cross-dimension head: not executable HERE and NOW ->
//         bounded deferral behind a row that is, else a typed System2 request;
//   (vii) every new marker is registered as MIRRORED (unmirrored markers never
//         reach buddy.log), and the controller call sites are wired.
//
// Run: bun ./test-plan-reconciliation.mts   (also valid under `bun test`)
import {
  GoalQueue,
  PLAN_IDENTITY_CHANGED,
  PLAN_HEAD_REPLACED,
  PLAN_ROW_RETIRED,
  ROW_DEFERRED_NOT_EXECUTABLE_HERE,
  ROW_NOT_EXECUTABLE_HERE,
  formatPlanIdentity,
  formatPlanIdentityChanged,
  evaluateStarvedHeadBound,
  notExecutableReplanRequest,
  planIdentityId,
  planReplanRequest,
  setPrereqAuditSink,
} from '../jev-agent/src/goalQueue.ts'
import type { GoalQueueSnapshot, PlanIdentity, QueuedGoal } from '../jev-agent/src/goalQueue.ts'
import { MIRRORED_MARKERS, mirroredEventToken } from '../jev-agent/src/controller-legacy.ts'
import { planIdentityFor, supersededPlanObsoleteProof } from './generation-entry.ts'
import { goalQueueSnapshotFromState } from './state-snapshot.ts'
import { emptyWorldMemory } from './resident-types.ts'
import type { ResidentWorldMemory } from './resident-types.ts'
import { deriveResumeRung, rungIndexById } from './planner.ts'
import {
  NOT_EXECUTABLE_HERE_WITHHELD_KINDS,
  restrictCandidatesNotExecutableHere,
  safetyEnvelopeActive,
} from '../jev-agent/src/candidates.ts'
import type { Candidate, CandidateKind, NotExecutableHereBinding } from '../jev-agent/src/candidates.ts'
import type { AgentSignals, InventoryState, SelfState, Vec3Json, WorldState } from '../jev-agent/src/state.ts'
import type { GoalQueueState } from '../jev-agent/src/goalQueue.ts'
import { PORTAL_ENTERED_PREDICATE, netherPortalEntryGoal } from '../jev-agent/src/netherPortalPlan.ts'
import { isDimensionTransferGoal } from '../jev-agent/src/goalQueue.ts'
import { OVERWORLD } from '../jev-agent/src/netherPortalPlan.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const NETHER = 'minecraft:the_nether'

/**
 * The measured live inventory (control-socket INVENTORY after the gate was lit):
 * the iron rungs are behind the run, the frontier is the M3 blaze road.
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

const NETHER_WORLD: ResidentWorldMemory = { ...emptyWorldMemory(), dimension: NETHER }

/** The live identity the generation projects for that inventory in the Nether. */
function liveIdentity(): PlanIdentity {
  const frontier = deriveResumeRung(LIVE_COUNTS, NETHER_WORLD)
  return planIdentityFor(frontier, { goalItem: 'blaze_rod', goalCount: 7 })
}

/** The identity an M2-era exploration plan was authored under. */
function staleIdentity(): PlanIdentity {
  return {
    rungId: 'raw_iron',
    rungIndex: rungIndexById('raw_iron'),
    objectiveItem: 'iron_ingot',
    objectiveCount: 3,
  }
}

function row(partial: Partial<QueuedGoal> & Pick<QueuedGoal, 'id' | 'kind' | 'targetItem' | 'requiredCount' | 'status'>): QueuedGoal {
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

/** The measured stale row: an overworld y32 descent authored by the M2 plan. */
function staleDescendRow(): QueuedGoal {
  return row({
    id: 'g1:descend:raw_iron',
    kind: 'descend',
    description: 'explore',
    targetItem: 'raw_iron',
    requiredCount: 1,
    targetY: 32,
    dimension: OVERWORLD,
    status: 'active',
    planIdentity: staleIdentity(),
  })
}

/** The live plan's own row (the M3 blaze road). */
function blazeRow(): QueuedGoal {
  return row({
    id: 'g2:collect:blaze_rod',
    kind: 'collect',
    targetItem: 'blaze_rod',
    requiredCount: 7,
    dimension: NETHER,
    status: 'pending',
    planIdentity: liveIdentity(),
  })
}

function capturedLines(run: () => void): string[] {
  const lines: string[] = []
  setPrereqAuditSink((line) => lines.push(line))
  try {
    run()
  } finally {
    setPrereqAuditSink(null)
  }
  return lines
}

// ---------------------------------------------------------------------------
// (i) the measured shape: a superseded head, the objective has moved
// ---------------------------------------------------------------------------
addCase('(i) the code-owned proof retires the stale plan row with typed evidence', () => {
  const live = liveIdentity()
  const proof = supersededPlanObsoleteProof(staleDescendRow(), live, LIVE_COUNTS, NETHER_WORLD)
  const pass =
    proof !== null &&
    proof.reason === 'authoring_frontier_behind_current' &&
    proof.evidence.some((token) => token.startsWith('authored=raw_iron@')) &&
    proof.evidence.some((token) => token.startsWith(`current=${live.rungId}@`)) &&
    proof.evidence.includes('item=raw_iron') &&
    proof.evidence.includes('live_owners=0')
  return { pass, detail: `proof=${JSON.stringify(proof)} live=${formatPlanIdentity(live)}` }
})

addCase('(i) reconciliation fires: the row retires, the marker names both identities, the head is relevant again', () => {
  const live = liveIdentity()
  const queue = new GoalQueue()
  queue.restore({
    counter: 2,
    goals: [staleDescendRow(), blazeRow()],
    revision: 2,
    planIdentity: staleIdentity(),
  })
  const headBefore = queue.current?.id ?? 'none'
  const lines: string[] = []
  const result = queue.reconcilePlanIdentity({
    current: live,
    isObsolete: (goal) => supersededPlanObsoleteProof(goal, live, LIVE_COUNTS, NETHER_WORLD),
    onSuperseded: (line) => lines.push(line),
  })
  const retired = queue.state.goals.find((goal) => goal.id === 'g1:descend:raw_iron')
  const marker = lines.find((line) => line.startsWith(PLAN_ROW_RETIRED))
  const request = planReplanRequest(result)
  const pass =
    headBefore === 'g1:descend:raw_iron' &&
    result.changed === true &&
    result.superseded === 1 &&
    result.headSuperseded === true &&
    result.retired.length === 1 &&
    result.retired[0]?.id === 'g1:descend:raw_iron' &&
    retired?.status === 'impossible' &&
    retired?.detail?.includes('retired superseded plan: authoring_frontier_behind_current') === true &&
    retired?.detail?.includes('item=raw_iron') === true &&
    marker !== undefined &&
    marker.includes('reason=authoring_frontier_behind_current') &&
    marker.includes('current=') &&
    queue.current?.id === 'g2:collect:blaze_rod' &&
    queue.current?.status === 'active' &&
    request !== null &&
    request.reason === 'no_progress' &&
    request.detail.includes('PLAN_IDENTITY_CHANGED') &&
    request.detail.includes('retired_ids=g1:descend:raw_iron') &&
    request.detail.includes('head_superseded=true')
  return {
    pass,
    detail: `head=${headBefore}->${queue.current?.id ?? 'none'} retired=${retired?.status} request=${request?.detail ?? 'none'} marker=${marker ?? 'none'}`,
  }
})

addCase('(i) a superseded row the current plan still wants is KEPT and only re-planned (no preference)', () => {
  const live = liveIdentity()
  // The same superseded identity, but the row's item IS the live objective.
  const wanted = row({
    id: 'g7:collect:blaze_rod',
    kind: 'collect',
    targetItem: 'blaze_rod',
    requiredCount: 7,
    dimension: NETHER,
    status: 'active',
    planIdentity: staleIdentity(),
  })
  const proof = supersededPlanObsoleteProof(wanted, live, LIVE_COUNTS, NETHER_WORLD)
  const queue = new GoalQueue()
  queue.restore({ counter: 7, goals: [wanted], revision: 7, planIdentity: staleIdentity() })
  const result = queue.reconcilePlanIdentity({
    current: live,
    isObsolete: (goal) => supersededPlanObsoleteProof(goal, live, LIVE_COUNTS, NETHER_WORLD),
  })
  const request = planReplanRequest(result)
  const pass =
    proof === null &&
    result.retired.length === 0 &&
    result.kept.length === 1 &&
    result.superseded === 1 &&
    result.headSuperseded === true &&
    queue.current?.id === 'g7:collect:blaze_rod' &&
    queue.current?.status === 'active' &&
    request !== null &&
    request.detail.includes('kept_ids=g7:collect:blaze_rod') &&
    request.detail.includes('retired_ids=none')
  return { pass, detail: `proof=${JSON.stringify(proof)} kept=${result.kept.length} request=${request?.detail ?? 'none'}` }
})

addCase('(i) a row authored by the CURRENT plan is never a supersession candidate', () => {
  const live = liveIdentity()
  const current = row({
    id: 'g9:descend:raw_iron',
    kind: 'descend',
    targetItem: 'raw_iron',
    requiredCount: 1,
    targetY: 32,
    dimension: OVERWORLD,
    status: 'active',
    planIdentity: live,
  })
  const proof = supersededPlanObsoleteProof(current, live, LIVE_COUNTS, NETHER_WORLD)
  const pass = proof === null && planIdentityId(live) === planIdentityId(live)
  return { pass, detail: `proof=${JSON.stringify(proof)}` }
})

// ---------------------------------------------------------------------------
// (ii) unsatisfied predicate + CURRENT plan -> untouched (pinned boundary)
// ---------------------------------------------------------------------------
addCase('(ii) a merely-unsatisfied row whose plan is CURRENT is untouched, byte for byte', () => {
  const live = liveIdentity()
  const current = row({
    id: 'g9:descend:raw_iron',
    kind: 'descend',
    description: 'explore',
    targetItem: 'raw_iron',
    requiredCount: 1,
    targetY: 32,
    dimension: OVERWORLD,
    status: 'active',
    planIdentity: live,
  })
  const queue = new GoalQueue()
  queue.restore({ counter: 9, goals: [current], revision: 9, planIdentity: live })
  const before = JSON.stringify(queue.snapshot())
  let proofCalls = 0
  const result = queue.reconcilePlanIdentity({
    current: live,
    isObsolete: (goal) => {
      proofCalls += 1
      return supersededPlanObsoleteProof(goal, live, LIVE_COUNTS, NETHER_WORLD)
    },
  })
  const after = JSON.stringify(queue.snapshot())
  const pass =
    result.changed === false &&
    result.superseded === 0 &&
    result.retired.length === 0 &&
    result.kept.length === 0 &&
    planReplanRequest(result) === null &&
    before === after &&
    proofCalls === 0 &&
    queue.current?.id === 'g9:descend:raw_iron' &&
    queue.current?.status === 'active'
  return { pass, detail: `changed=${result.changed} superseded=${result.superseded} identical=${before === after} proofCalls=${proofCalls}` }
})

// ---------------------------------------------------------------------------
// (iii) empty queue -> queue_empty re-plan unchanged
// ---------------------------------------------------------------------------
addCase('(iii) an empty queue stays empty: reconciliation neither requests nor blocks anything', () => {
  const live = liveIdentity()
  const queue = new GoalQueue()
  queue.restore({ counter: 4, goals: [], revision: 4 })
  const result = queue.reconcilePlanIdentity({
    current: live,
    isObsolete: () => {
      throw new Error('the proof must never be consulted for an empty queue')
    },
  })
  const pass =
    queue.isEmpty === true &&
    queue.current === null &&
    result.superseded === 0 &&
    result.retired.length === 0 &&
    planReplanRequest(result) === null &&
    queue.authoredPlanIdentity !== null &&
    planIdentityId(queue.authoredPlanIdentity) === planIdentityId(live)
  return { pass, detail: `empty=${queue.isEmpty} superseded=${result.superseded} identity=${formatPlanIdentity(queue.authoredPlanIdentity)}` }
})

// ---------------------------------------------------------------------------
// (iv) healthy queue making progress -> byte-identical
// ---------------------------------------------------------------------------
addCase('(iv) a healthy current-plan queue is byte-identical across repeated reconciliation', () => {
  const live = liveIdentity()
  const queue = new GoalQueue()
  queue.restore({ counter: 12, goals: [blazeRow()], revision: 12, planIdentity: live })
  queue.applyPlan(
    [
      { kind: 'collect', description: 'collect 12 x ender_pearl', targetItem: 'ender_pearl', requiredCount: 12, dimension: NETHER },
      { kind: 'craft', description: 'craft 12 x ender_eye', targetItem: 'ender_eye', requiredCount: 12 },
    ],
    'llm',
    'replace',
    { reason: 'healthy' },
  )
  const before = JSON.stringify(queue.snapshot())
  let proofCalls = 0
  const results = [] as Array<ReturnType<GoalQueue['reconcilePlanIdentity']>>
  for (let i = 0; i < 5; i += 1) {
    results.push(
      queue.reconcilePlanIdentity({
        current: live,
        isObsolete: (goal) => {
          proofCalls += 1
          return supersededPlanObsoleteProof(goal, live, LIVE_COUNTS, NETHER_WORLD)
        },
      }),
    )
  }
  const after = JSON.stringify(queue.snapshot())
  const rowsStamped = queue.state.goals.every(
    (goal) => goal.planIdentity !== undefined && planIdentityId(goal.planIdentity) === planIdentityId(live),
  )
  const pass =
    before === after &&
    proofCalls === 0 &&
    rowsStamped &&
    results.every((result) => result.superseded === 0 && result.retired.length === 0 && result.changed === false)
  return {
    pass,
    detail: `identical=${before === after} proofCalls=${proofCalls} rows=${queue.state.goals.length} stamped=${rowsStamped}`,
  }
})

// ---------------------------------------------------------------------------
// (v) ledger round-trip
// ---------------------------------------------------------------------------
addCase('(v) save/restore keeps the retirement and never resurrects the obsolete row', () => {
  const live = liveIdentity()
  const queue = new GoalQueue()
  queue.restore({ counter: 2, goals: [staleDescendRow(), blazeRow()], revision: 2, planIdentity: staleIdentity() })
  queue.reconcilePlanIdentity({
    current: live,
    isObsolete: (goal) => supersededPlanObsoleteProof(goal, live, LIVE_COUNTS, NETHER_WORLD),
  })
  const saved = JSON.parse(JSON.stringify(queue.snapshot())) as GoalQueueSnapshot
  const restored = new GoalQueue()
  restored.restore(saved)
  const restoredStale = restored.state.goals.find((goal) => goal.id === 'g1:descend:raw_iron')
  const roundTripResult = restored.reconcilePlanIdentity({
    current: live,
    isObsolete: (goal) => supersededPlanObsoleteProof(goal, live, LIVE_COUNTS, NETHER_WORLD),
  })
  const depth = restored.state.depth
  const head = restored.current?.id ?? 'none'
  const pass =
    restoredStale?.status === 'impossible' &&
    restoredStale.detail?.includes('retired superseded plan') === true &&
    roundTripResult.superseded === 0 &&
    roundTripResult.retired.length === 0 &&
    depth === 1 &&
    head === 'g2:collect:blaze_rod' &&
    saved.planIdentity !== undefined &&
    planIdentityId(saved.planIdentity) === planIdentityId(live)
  return { pass, detail: `stale=${restoredStale?.status} head=${head} depth=${depth} superseded=${roundTripResult.superseded}` }
})

addCase('(v) a LEGACY snapshot (no identity) adopts the live one instead of mass-retiring', () => {
  const live = liveIdentity()
  const legacy: GoalQueueSnapshot = {
    counter: 2,
    revision: 2,
    basis: {
      worldKey: `127.0.0.1:25565|${OVERWORLD}|3`,
      frontierRungId: 'raw_iron',
      frontierRungIndex: rungIndexById('raw_iron'),
    },
    goals: [
      row({ id: 'g1:descend:raw_iron', kind: 'descend', targetItem: 'raw_iron', requiredCount: 1, targetY: 32, dimension: OVERWORLD, status: 'active' }),
      row({ id: 'g2:collect:log', kind: 'collect', targetItem: 'log', requiredCount: 3, status: 'pending' }),
    ],
  }
  const queue = new GoalQueue()
  queue.restore(legacy)
  const authored = queue.authoredPlanIdentity
  const stampedFromBasis =
    authored !== null && authored.rungId === 'raw_iron' && authored.rungIndex === rungIndexById('raw_iron')
  const rowsStamped = queue.state.goals.every((goal) => goal.planIdentity !== undefined)
  const pass = stampedFromBasis && rowsStamped && queue.current?.id === 'g1:descend:raw_iron'
  return { pass, detail: `authored=${formatPlanIdentity(authored)} rowsStamped=${rowsStamped} head=${queue.current?.id ?? 'none'}` }
})

addCase('(v) the superseded row stays retired even after the objective moves again', () => {
  const live = liveIdentity()
  const queue = new GoalQueue()
  queue.restore({ counter: 2, goals: [staleDescendRow(), blazeRow()], revision: 2, planIdentity: staleIdentity() })
  queue.reconcilePlanIdentity({
    current: live,
    isObsolete: (goal) => supersededPlanObsoleteProof(goal, live, LIVE_COUNTS, NETHER_WORLD),
  })
  const retiredDetail = queue.state.goals.find((goal) => goal.id === 'g1:descend:raw_iron')?.detail ?? null
  // The objective moves on again (blaze rods held -> the frontier is the pearl
  // road). The already-retired stale row must not come back, and no transition may
  // reopen it.
  const laterCounts = { ...LIVE_COUNTS, blaze_rod: 7 }
  const nextFrontier = deriveResumeRung(laterCounts, NETHER_WORLD)
  const next = planIdentityFor(nextFrontier, { goalItem: 'ender_pearl', goalCount: 12 })
  const result = queue.reconcilePlanIdentity({
    current: next,
    isObsolete: (goal) => supersededPlanObsoleteProof(goal, next, laterCounts, NETHER_WORLD),
  })
  const stale = queue.state.goals.find((goal) => goal.id === 'g1:descend:raw_iron')
  const pass =
    next.rungId === 'ender_pearls' &&
    stale?.status === 'impossible' &&
    stale.detail === retiredDetail &&
    result.retired.every((entry) => entry.id !== 'g1:descend:raw_iron') &&
    result.adoptedLegacy === 0
  return {
    pass,
    detail: `next=${formatPlanIdentity(next)} stale=${stale?.status} retired_later=[${result.retired.map((r) => r.id).join(',')}]`,
  }
})

// ---------------------------------------------------------------------------
// (vi) the measured cross-dimension head
// ---------------------------------------------------------------------------
function netherRow(): QueuedGoal {
  return row({
    id: 'g2:place:nether_portal',
    kind: 'place',
    description: 'enter the nether portal',
    targetItem: 'nether_portal',
    requiredCount: 1,
    targetPredicate: 'portal_entered',
    dimension: NETHER,
    status: 'pending',
    planIdentity: liveIdentity(),
  })
}

/** A second overworld-declared row, so no alternative is executable in the Nether. */
function overworldRow(id: string, item: string): QueuedGoal {
  return row({
    id,
    kind: 'collect',
    targetItem: item,
    requiredCount: 7,
    dimension: OVERWORLD,
    status: 'pending',
    planIdentity: liveIdentity(),
  })
}

addCase('(v) a basis-stamped legacy ledger at the SAME frontier is not a supersession (no reload noise)', () => {
  const live = liveIdentity()
  const legacy: GoalQueueSnapshot = {
    counter: 2,
    revision: 2,
    basis: {
      worldKey: `127.0.0.1:25565|${NETHER}|3`,
      frontierRungId: live.rungId,
      frontierRungIndex: live.rungIndex,
    },
    goals: [
      row({ id: 'g1:collect:blaze_rod', kind: 'collect', targetItem: 'blaze_rod', requiredCount: 7, dimension: NETHER, status: 'active' }),
    ],
  }
  const queue = new GoalQueue()
  queue.restore(legacy)
  const rowsBefore = JSON.stringify(queue.state.goals)
  const result = queue.reconcilePlanIdentity({
    current: live,
    isObsolete: (goal) => supersededPlanObsoleteProof(goal, live, LIVE_COUNTS, NETHER_WORLD),
  })
  const authored = queue.authoredPlanIdentity
  const pass =
    result.changed === false &&
    result.superseded === 0 &&
    planReplanRequest(result) === null &&
    // Not one row is touched (no retirement, no re-stamp): the only difference is
    // the queue-level identity gaining its objective evidence fields.
    JSON.stringify(queue.state.goals) === rowsBefore &&
    authored !== null &&
    planIdentityId(authored) === planIdentityId(live)
  return {
    pass,
    detail: `changed=${result.changed} superseded=${result.superseded} rowsIdentical=${JSON.stringify(queue.state.goals) === rowsBefore} authored=${formatPlanIdentity(authored)}`,
  }
})

addCase('(vi) the measured shape: an overworld head in the Nether defers behind the nether row', () => {
  const queue = new GoalQueue()
  queue.restore({ counter: 2, goals: [staleDescendRow(), netherRow()], revision: 2, planIdentity: staleIdentity() })
  const headBefore = queue.current?.id ?? 'none'
  const result = queue.reconcileNotExecutableHead({ liveDimension: NETHER })
  const stale = queue.state.goals.find((goal) => goal.id === 'g1:descend:raw_iron')
  const pass =
    headBefore === 'g1:descend:raw_iron' &&
    result.action === 'defer' &&
    result.reason === 'deferred' &&
    result.declaredDimension === 'overworld' &&
    result.liveDimension === 'the_nether' &&
    result.nextGoalId === 'g2:place:nether_portal' &&
    queue.current?.id === 'g2:place:nether_portal' &&
    stale?.status === 'pending' &&
    stale?.deferCount === 1 &&
    notExecutableReplanRequest(result) === null
  return { pass, detail: `head=${headBefore}->${queue.current?.id ?? 'none'} action=${result.action}/${result.reason} defers=${stale?.deferCount ?? 0}` }
})

addCase('(vi) no executable alternative -> typed System2 request, and the row is NOT killed', () => {
  const queue = new GoalQueue()
  queue.restore({
    counter: 2,
    goals: [staleDescendRow(), overworldRow('g2:collect:blaze_rod', 'blaze_rod')],
    revision: 2,
    planIdentity: staleIdentity(),
  })
  const result = queue.reconcileNotExecutableHead({ liveDimension: NETHER })
  const stale = queue.state.goals.find((goal) => goal.id === 'g1:descend:raw_iron')
  const request = notExecutableReplanRequest(result)
  const pass =
    result.action === 'escalate' &&
    result.reason === 'no_executable_alternative' &&
    stale?.status === 'active' &&
    queue.current?.id === 'g1:descend:raw_iron' &&
    request !== null &&
    request.reason === 'action_impossible' &&
    request.detail.includes('declared=overworld') &&
    request.detail.includes('live=the_nether')
  return { pass, detail: `action=${result.action}/${result.reason} stale=${stale?.status} request=${request?.detail ?? 'none'}` }
})

addCase('(vi) the deferral bound is durable: the budget runs out into the typed request', () => {
  const queue = new GoalQueue()
  queue.restore({ counter: 2, goals: [staleDescendRow(), netherRow()], revision: 2, planIdentity: staleIdentity() })
  const first = queue.reconcileNotExecutableHead({ liveDimension: NETHER, limit: 1 })
  // The nether row completes, so the stale row heads the plan again: with its
  // budget spent the outcome is the typed request, not another silent demotion.
  queue.markDone()
  const second = queue.reconcileNotExecutableHead({ liveDimension: NETHER, limit: 1 })
  const saved = JSON.parse(JSON.stringify(queue.snapshot())) as GoalQueueSnapshot
  const restored = new GoalQueue()
  // A later System2 patch supplies the next nether step, so the deferral budget -
  // not the lack of an alternative - is what the restored queue runs out of.
  restored.restore({
    ...saved,
    counter: saved.counter + 1,
    goals: [...saved.goals, netherRow()],
  })
  const stale = restored.state.goals.find((goal) => goal.id === 'g1:descend:raw_iron')
  const third = restored.reconcileNotExecutableHead({ liveDimension: NETHER, limit: 2 })
  const pass =
    first.action === 'defer' &&
    first.defers === 1 &&
    second.action === 'escalate' &&
    second.reason === 'defer_budget_exhausted' &&
    stale?.deferCount === 1 &&
    third.action === 'defer' &&
    third.defers === 2
  return {
    pass,
    detail: `first=${first.action}/${first.defers} second=${second.action}/${second.reason} restoredDefers=${stale?.deferCount} third=${third.action}/${third.defers}`,
  }
})

addCase('(vi) a same-dimension head and an undeclared-dimension head are untouched', () => {
  const sameDimension = new GoalQueue()
  const netherDescend = row({
    id: 'g5:descend:blaze',
    kind: 'descend',
    targetItem: 'blaze_rod',
    requiredCount: 1,
    targetY: 40,
    dimension: NETHER,
    status: 'active',
    planIdentity: liveIdentity(),
  })
  sameDimension.restore({ counter: 5, goals: [netherDescend, netherRow()], revision: 5, planIdentity: liveIdentity() })
  const before = JSON.stringify(sameDimension.snapshot())
  const sameResult = sameDimension.reconcileNotExecutableHead({ liveDimension: NETHER })
  const undeclaredRow = row({
    id: 'g6:collect:blaze_rod',
    kind: 'collect',
    targetItem: 'blaze_rod',
    requiredCount: 7,
    dimension: null,
    status: 'active',
    planIdentity: liveIdentity(),
  })
  const undeclared = new GoalQueue()
  undeclared.restore({ counter: 6, goals: [undeclaredRow, netherRow()], revision: 6, planIdentity: liveIdentity() })
  const undeclaredResult = undeclared.reconcileNotExecutableHead({ liveDimension: NETHER })
  const unknownLive = new GoalQueue()
  unknownLive.restore({ counter: 5, goals: [staleDescendRow(), netherRow()], revision: 5, planIdentity: staleIdentity() })
  const unknownResult = unknownLive.reconcileNotExecutableHead({ liveDimension: null })
  const pass =
    sameResult.action === 'hold' &&
    sameResult.reason === 'executable_here' &&
    JSON.stringify(sameDimension.snapshot()) === before &&
    sameDimension.current?.id === 'g5:descend:blaze' &&
    undeclaredResult.action === 'hold' &&
    undeclaredResult.reason === 'unknown_dimension' &&
    undeclared.current?.id === 'g6:collect:blaze_rod' &&
    unknownResult.action === 'hold' &&
    unknownResult.reason === 'unknown_dimension' &&
    unknownLive.current?.id === 'g1:descend:raw_iron'
  return {
    pass,
    detail: `same=${sameResult.reason} undeclared=${undeclaredResult.reason} unknownLive=${unknownResult.reason}`,
  }
})

addCase('(vi) the measured no-progress ascent loop cannot restart: the overworld row never heads the nether plan', () => {
  const queue = new GoalQueue()
  queue.restore({ counter: 2, goals: [staleDescendRow(), netherRow()], revision: 2, planIdentity: staleIdentity() })
  const seen: string[] = []
  for (let i = 0; i < 4; i += 1) {
    const result = queue.reconcileNotExecutableHead({ liveDimension: NETHER, limit: 2 })
    seen.push(`${result.action}/${result.reason}:${queue.current?.id ?? 'none'}`)
    if (result.action === 'defer') {
      // The nether step completes and System2 patches the next one, so the
      // cross-dimension row heads the plan again - the live shape where the body
      // kept climbing.
      queue.markDone()
      queue.applyPlan(
        [
          {
            kind: 'place',
            description: 'enter the nether portal',
            targetItem: 'nether_portal',
            requiredCount: 1,
            targetPredicate: 'portal_entered',
            dimension: NETHER,
          },
        ],
        'llm',
        'patch',
        { reason: 'replenish nether step' },
      )
    }
  }
  const stale = queue.state.goals.find((goal) => goal.id === 'g1:descend:raw_iron')
  const pass =
    seen[0] === 'defer/deferred:g2:place:nether_portal' &&
    /^defer\/deferred:g\d+:place:nether_portal$/.test(seen[1] ?? '') &&
    seen.slice(2).every((entry) => entry.startsWith('escalate/defer_budget_exhausted:')) &&
    stale?.status === 'active' &&
    stale?.deferCount === 2
  return { pass, detail: `seen=[${seen.join(' ')}] defers=${stale?.deferCount ?? 0}` }
})

// ---------------------------------------------------------------------------
// (vii) evidence: typed, mirrored, and wired
// ---------------------------------------------------------------------------
addCase('(vii) every new marker is MIRRORED, so it reaches buddy.log', () => {
  const markers = [
    PLAN_IDENTITY_CHANGED,
    PLAN_ROW_RETIRED,
    PLAN_HEAD_REPLACED,
    'PLAN_HEAD_REPLACEMENT_APPLIED',
    'PLAN_IDENTITY_ADOPTED',
    'PLAN_IDENTITY_UNAVAILABLE',
    ROW_NOT_EXECUTABLE_HERE,
    ROW_DEFERRED_NOT_EXECUTABLE_HERE,
    'NO_PRODUCTIVE_HEAD_BOUND',
    'NO_PRODUCTIVE_HEAD_WINDOW',
    'ROW_NOT_EXECUTABLE_HERE_REPEATS',
    'ROW_NOT_EXECUTABLE_HERE_BINDING',
    'ROW_NOT_EXECUTABLE_HERE_BINDING_SKIPPED',
    'ROW_NOT_EXECUTABLE_HERE_INTERRUPT',
  ]
  const missing = markers.filter((token) => !MIRRORED_MARKERS.has(token))
  const tokens = markers.map((token) => mirroredEventToken(`${token} detail=1`))
  const pass = missing.length === 0 && tokens.every((token, index) => token === markers[index])
  return { pass, detail: `missing=[${missing.join(',')}] tokens=[${tokens.join(',')}]` }
})

addCase('(vii) the identity-change line names both identities and both row sets', () => {
  const live = liveIdentity()
  const queue = new GoalQueue()
  queue.restore({ counter: 2, goals: [staleDescendRow(), blazeRow()], revision: 2, planIdentity: staleIdentity() })
  const result = queue.reconcilePlanIdentity({
    current: live,
    isObsolete: (goal) => supersededPlanObsoleteProof(goal, live, LIVE_COUNTS, NETHER_WORLD),
  })
  const line = formatPlanIdentityChanged(result)
  const pass =
    line.startsWith(PLAN_IDENTITY_CHANGED) &&
    line.includes('from=raw_iron@') &&
    line.includes(`to=${live.rungId}@`) &&
    line.includes('superseded=1') &&
    line.includes('retired=1') &&
    line.includes('kept=0') &&
    line.includes('head_superseded=true')
  return { pass, detail: line }
})

addCase('(vii) the controller wires both reconciliations and the queue_empty gate is unchanged', async () => {
  const source = await Bun.file(new URL('./../jev-agent/src/controller-legacy.ts', import.meta.url)).text()
  const gates = [
    'this.reconcilePlanIdentity()',
    'this.reconcileHeadDimension()',
    "this.summonLlm('queue_empty', 'goal queue is empty; no long-horizon goal to consume')",
    'NO_PRODUCTIVE_HEAD_BOUND',
  ]
  const missing = gates.filter((needle) => !source.includes(needle))
  const pass = missing.length === 0
  return { pass, detail: `missing=[${missing.join(' | ')}]` }
})

// ---------------------------------------------------------------------------
// (viii) the measured starvation bound: SAME head, MOVE/WAIT churn, reload
// ---------------------------------------------------------------------------
// Live (`run-mucqgrdo-21plr`): the stale row alternated MOVE/WAIT, so a
// NON-starved tick sat between every starved one, and `NO_PRODUCTIVE_HEAD_WINDOW`
// reported `count=1 limit=3` on all seven occurrences while
// `NO_PRODUCTIVE_HEAD_BOUND` never fired. The count is now a field of the durable
// ROW (`starvedDecisions`), closed only by semantic progress, by firing, or by the
// head changing - never by body motion or a reload.
addCase('(viii) the bound counts starved decisions for the SAME head across a reload', () => {
  const queue = new GoalQueue()
  queue.restore({ counter: 1, goals: [staleDescendRow()], revision: 1, planIdentity: staleIdentity() })
  const first = queue.noteStarvedHead()
  const firstBound = evaluateStarvedHeadBound({ count: first, limit: 3 })
  // The interleaved productive tick (the MOVE the live run alternated with WAIT):
  // nothing is recorded, and the window must stay open.
  const afterMoveTick = queue.starvedHeadCount
  // Reload: snapshot -> JSON -> restore, exactly what a resident reload does.
  const restored = new GoalQueue()
  restored.restore(JSON.parse(JSON.stringify(queue.snapshot())) as GoalQueueSnapshot)
  const afterReload = restored.starvedHeadCount
  const second = restored.noteStarvedHead()
  const secondBound = evaluateStarvedHeadBound({ count: second, limit: 3 })
  const third = restored.noteStarvedHead()
  const thirdBound = evaluateStarvedHeadBound({ count: third, limit: 3 })
  restored.resetStarvedHead()
  const afterFire = restored.starvedHeadCount
  const fourth = restored.noteStarvedHead()
  const pass =
    first === 1 &&
    firstBound.action === 'window' &&
    afterMoveTick === 1 &&
    afterReload === 1 &&
    second === 2 &&
    secondBound.action === 'hold' &&
    third === 3 &&
    thirdBound.action === 'wake' &&
    thirdBound.reason === 'no_productive_candidate_bound' &&
    afterFire === 0 &&
    fourth === 1
  return {
    pass,
    detail: `first=${first}/${firstBound.action} afterMove=${afterMoveTick} afterReload=${afterReload} second=${second}/${secondBound.action} third=${third}/${thirdBound.action} afterFire=${afterFire} next=${fourth}`,
  }
})

addCase('(viii) body motion cannot launder the bound, but real progress clears it', () => {
  const queue = new GoalQueue()
  queue.restore({ counter: 1, goals: [staleDescendRow()], revision: 1, planIdentity: staleIdentity() })
  queue.noteStarvedHead()
  queue.noteStarvedHead()
  // `body` progress (a successful MOVE/ASCEND) is NOT semantic progress.
  queue.noteSemanticProgress(['body'])
  const countAfterBody = queue.starvedHeadCount
  // `goal`/`search` progress is, and closes the window.
  queue.noteSemanticProgress(['goal'])
  const countAfterGoal = queue.starvedHeadCount
  queue.noteStarvedHead()
  const reopened = queue.starvedHeadCount
  const pass = countAfterBody === 2 && countAfterGoal === 0 && reopened === 1
  return { pass, detail: `afterBody=${countAfterBody} afterGoal=${countAfterGoal} reopened=${reopened}` }
})

addCase('(viii) the count is row-scoped: a different head starts its own window', () => {
  const queue = new GoalQueue()
  queue.restore({
    counter: 2,
    goals: [staleDescendRow(), netherRow()],
    revision: 2,
    planIdentity: staleIdentity(),
  })
  queue.noteStarvedHead()
  queue.noteStarvedHead()
  const staleCount = queue.starvedHeadCount
  // The head moves on (the row completes); the next row has no history of its own.
  queue.markDone()
  const nextHead = queue.current?.id ?? 'none'
  const nextCount = queue.starvedHeadCount
  const pass = staleCount === 2 && nextHead === 'g2:place:nether_portal' && nextCount === 0
  return { pass, detail: `stale=${staleCount} nextHead=${nextHead} nextCount=${nextCount}` }
})

addCase('(viii) the durable field survives the host snapshot path and the JSON round-trip', () => {
  const queue = new GoalQueue()
  queue.restore({ counter: 1, goals: [staleDescendRow()], revision: 1, planIdentity: staleIdentity() })
  queue.noteStarvedHead()
  const viaHost = goalQueueSnapshotFromState(queue.state)
  const viaJson = JSON.parse(JSON.stringify(queue.snapshot())) as GoalQueueSnapshot
  const hostRow = viaHost.goals.find((goal) => goal.id === 'g1:descend:raw_iron')
  const jsonRow = viaJson.goals.find((goal) => goal.id === 'g1:descend:raw_iron')
  const pass = hostRow?.starvedDecisions === 1 && jsonRow?.starvedDecisions === 1
  return { pass, detail: `host=${hostRow?.starvedDecisions ?? 'none'} json=${jsonRow?.starvedDecisions ?? 'none'}` }
})

addCase('(viii) the controller uses the durable row bound and never resets it on a productive tick', async () => {
  const source = await Bun.file(new URL('./../jev-agent/src/controller-legacy.ts', import.meta.url)).text()
  const required = [
    'this.queue.noteStarvedHead()',
    'evaluateStarvedHeadBound({ count, limit: this.options.waitLimit })',
    'this.queue.resetStarvedHead()',
  ]
  const forbidden = ['noProductiveHeadCount', 'noProductiveHeadKey']
  const missing = required.filter((needle) => !source.includes(needle))
  const leftover = forbidden.filter((needle) => source.includes(needle))
  const pass = missing.length === 0 && leftover.length === 0
  return { pass, detail: `missing=[${missing.join(' | ')}] leftover=[${leftover.join(' | ')}]` }
})

// ---------------------------------------------------------------------------
// (ix) the measured end-to-end shape: the bound fires, System2 answers the head
//      it was asked about, and the answer replaces that head
// ---------------------------------------------------------------------------
// Live (`run-mucqgrdo-21plr`, main 5397bd8): the bound fired, System2 was summoned
// with reason=action_impossible and DID author a Nether/blaze plan, but its op was
// `patch` - which deliberately keeps the active row - so
// `queue: g2:collect:log done | g3:collect:raw_iron done | g1:descend:raw_iron ACTIVE`
// was unchanged and the starved row survived the escalation that was about it.
function measuredLedger(): GoalQueueSnapshot {
  return {
    counter: 3,
    revision: 3,
    planIdentity: staleIdentity(),
    goals: [
      row({ id: 'g2:collect:log', kind: 'collect', targetItem: 'log', requiredCount: 3, status: 'done', haveCount: 3 }),
      row({ id: 'g3:collect:raw_iron', kind: 'collect', targetItem: 'raw_iron', requiredCount: 3, status: 'done', haveCount: 3 }),
      staleDescendRow(),
    ],
  }
}

/** The measured System2 answer: a Nether plan for the same objective, op=patch. */
function system2NetherAnswer() {
  return {
    op: 'patch' as const,
    note: 'Explore Nether caves for blaze rods since overworld raw_iron is unreachable',
    goals: [
      {
        kind: 'collect' as const,
        description: 'collect 7 x blaze_rod',
        targetItem: 'blaze_rod',
        requiredCount: 7,
        dimension: NETHER,
      },
    ],
  }
}

addCase('(ix) the bound fires, System2 answers, and the answered head is replaced by the new plan', () => {
  const queue = new GoalQueue()
  queue.restore(measuredLedger())
  const headBefore = queue.current?.id ?? 'none'
  // 1) the durable bound reaches its limit on this row
  for (let i = 0; i < 3; i += 1) queue.noteStarvedHead()
  const bound = evaluateStarvedHeadBound({ count: queue.starvedHeadCount, limit: 3 })
  // 2) the answer arrives (op=patch, with goals) and the warrant replaces THAT row
  const answer = system2NetherAnswer()
  const lines: string[] = []
  const replaced = queue.replaceAnsweredHead({
    headId: 'g1:descend:raw_iron',
    requestId: 'req-measured-1',
    reason: 'action_impossible',
    note: answer.note,
    onReplaced: (line) => lines.push(line),
  })
  queue.resetStarvedHead()
  const added = queue.applyPlan(answer.goals, 'llm', answer.op, { reason: answer.note })
  const headAfter = queue.current?.id ?? 'none'
  const stale = queue.state.goals.find((goal) => goal.id === 'g1:descend:raw_iron')
  const marker = lines.find((line) => line.startsWith(PLAN_HEAD_REPLACED))
  const pass =
    headBefore === 'g1:descend:raw_iron' &&
    bound.action === 'wake' &&
    replaced?.id === 'g1:descend:raw_iron' &&
    replaced.status === 'impossible' &&
    replaced.detail?.includes('replaced by System2 answer') === true &&
    replaced.detail?.includes('reason=action_impossible') === true &&
    replaced.detail?.includes('requestId=req-measured-1') === true &&
    marker !== undefined &&
    marker.includes('id=g1:descend:raw_iron') &&
    marker.includes('requestId=req-measured-1') &&
    stale?.status === 'impossible' &&
    // the replaced row is kept as durable audit history, not erased
    queue.state.goals.some((goal) => goal.id === 'g1:descend:raw_iron') &&
    added.length === 1 &&
    headAfter === 'g4:collect:blaze_rod' &&
    queue.current?.kind === 'collect' &&
    queue.current?.targetItem === 'blaze_rod' &&
    queue.starvedHeadCount === 0
  return {
    pass,
    detail: `bound=${bound.action} replaced=${replaced?.status} head=${headBefore}->${headAfter} marker=${marker ?? 'none'}`,
  }
})

addCase('(ix) a reload after the answer does not resurrect the replaced head', () => {
  const queue = new GoalQueue()
  queue.restore(measuredLedger())
  const answer = system2NetherAnswer()
  queue.replaceAnsweredHead({
    headId: 'g1:descend:raw_iron',
    requestId: 'req-measured-2',
    reason: 'action_impossible',
    note: answer.note,
  })
  queue.applyPlan(answer.goals, 'llm', answer.op, { reason: answer.note })
  const snapshotBefore = queue.snapshot()
  // Reload: the host round-trip + JSON + restore, as the resident does.
  const hostPath = goalQueueSnapshotFromState(queue.state)
  const restored = new GoalQueue()
  restored.restore(JSON.parse(JSON.stringify(hostPath)) as GoalQueueSnapshot)
  const stale = restored.state.goals.find((goal) => goal.id === 'g1:descend:raw_iron')
  const reference = new GoalQueue()
  reference.restore(JSON.parse(JSON.stringify(snapshotBefore)) as GoalQueueSnapshot)
  const referenceStale = reference.state.goals.find((goal) => goal.id === 'g1:descend:raw_iron')
  const pass =
    stale?.status === 'impossible' &&
    stale.detail?.includes('replaced by System2 answer') === true &&
    referenceStale?.status === 'impossible' &&
    restored.current?.id === 'g4:collect:blaze_rod' &&
    restored.starvedHeadCount === 0 &&
    restored.state.depth === 1
  return {
    pass,
    detail: `hostPath=${stale?.status ?? 'missing'} snapshot=${referenceStale?.status ?? 'missing'} head=${restored.current?.id ?? 'none'} depth=${restored.state.depth}`,
  }
})

addCase('(ix) the warrant is bounded: a different head, a human head, or a valueless answer replaces nothing', () => {
  // (a) a stale answer whose headId is no longer the head
  const moved = new GoalQueue()
  moved.restore(measuredLedger())
  const staleAnswer = moved.replaceAnsweredHead({
    headId: 'g0:collect:log',
    requestId: 'req-stale',
    reason: 'action_impossible',
  })
  const movedHead = moved.current?.id ?? 'none'
  // (b) human intent owns WHAT until it is cleared
  const human = new GoalQueue()
  human.restore({
    counter: 1,
    revision: 1,
    goals: [
      row({
        id: 'g1:descend:raw_iron',
        kind: 'descend',
        targetItem: 'raw_iron',
        requiredCount: 1,
        targetY: 32,
        dimension: OVERWORLD,
        status: 'active',
        origin: 'human',
        planIdentity: staleIdentity(),
      }),
    ],
  })
  const humanAnswer = human.replaceAnsweredHead({
    headId: 'g1:descend:raw_iron',
    requestId: 'req-human',
    reason: 'action_impossible',
  })
  // (c) the row the model was NOT asked about keeps the conservative rule: an
  //     unrelated unfinished row stays pending through the same patch
  const tail = new GoalQueue()
  tail.restore({
    counter: 5,
    revision: 5,
    planIdentity: staleIdentity(),
    goals: [
      staleDescendRow(),
      row({
        id: 'g5:collect:obsidian',
        kind: 'collect',
        targetItem: 'obsidian',
        requiredCount: 10,
        dimension: OVERWORLD,
        status: 'pending',
        planIdentity: staleIdentity(),
      }),
    ],
  })
  tail.replaceAnsweredHead({ headId: 'g1:descend:raw_iron', requestId: 'req-tail', reason: 'action_impossible' })
  // The answered row was retired; the row the model was NOT asked about keeps the
  // conservative rule - it stays live work (`active`, no retirement detail) and
  // simply becomes the head.
  const untouched = tail.state.goals.find((goal) => goal.id === 'g5:collect:obsidian')
  const pass =
    staleAnswer === null &&
    movedHead === 'g1:descend:raw_iron' &&
    humanAnswer === null &&
    human.current?.id === 'g1:descend:raw_iron' &&
    human.current?.status === 'active' &&
    untouched?.status === 'active' &&
    untouched?.detail === null
  return {
    pass,
    detail: `stale=${staleAnswer === null ? 'noop' : 'REPLACED'} movedHead=${movedHead} human=${human.current?.status ?? 'none'} tail=${untouched?.status ?? 'missing'}`,
  }
})

addCase('(ix) the controller arms the warrant only for a head-about summon and applies it only to a real plan', async () => {
  const source =
    (await Bun.file(new URL('./../jev-agent/src/controller-legacy.ts', import.meta.url)).text()) +
    (await Bun.file(new URL('./../jev-agent/src/system2-plane.ts', import.meta.url)).text()).replace(/\bhost\./g, 'this.')
  const required = [
    "reason === 'action_impossible' || reason === 'no_progress'",
    'this.queue.replaceAnsweredHead({',
    'plan.goals.length > 0',
    "plan.op === 'patch' || plan.op === 'replace'",
    'const humanOwnsWhat = this.queue.state.goals.some(',
    'PLAN_HEAD_REPLACEMENT_APPLIED',
  ]
  const missing = required.filter((needle) => !source.includes(needle))
  const pass = missing.length === 0
  return { pass, detail: `missing=[${missing.join(' | ')}]` }
})

// ---------------------------------------------------------------------------
// (x) the proof binds the OFFER: an unexecutable head must not drive the body
// ---------------------------------------------------------------------------
// Measured live (`run-muctsqt6-27ocr`, main 3002d84): the head was
// `g14:descend:raw_iron` declaring minecraft:overworld (success `levelAtMost y32`)
// while the body stood in the NETHER at y37, hp 10 - and the body kept DESCENDING
// toward y32, i.e. toward lava, while the escalation that replaces the row was in
// flight. The queue had already proven the row cannot run here; the OFFER had not.
function liveBinding(): NotExecutableHereBinding {
  return {
    goalId: 'g14:descend:raw_iron',
    goalKey: 'descend:raw_iron:1',
    declaredDimension: 'overworld',
    liveDimension: 'the_nether',
    reason: 'no_executable_alternative',
  }
}

function offerCandidate(id: string, kind: CandidateKind, target: Vec3Json | null = null): Candidate {
  return {
    id,
    kind,
    label: `${kind} ${id}`,
    targetName: null,
    target,
    itemName: kind === 'DESCEND' ? 'raw_iron' : null,
    cost: 1,
    risk: 0,
    meta: {},
  } as unknown as Candidate
}

/** The measured offer: the row's own descent plus the control/self-care options. */
function measuredOffer(): Candidate[] {
  return [
    offerCandidate('DESCEND:level:N:b16_37_-9', 'DESCEND', { x: 16, y: 36, z: -9 }),
    offerCandidate('MOVE:p16_37_-9', 'MOVE', { x: 16, y: 37, z: -9 }),
    offerCandidate('STEP:down:E:b16_36_-9', 'STEP', { x: 16, y: 36, z: -9 }),
    offerCandidate('RETREAT:p16_38_-9', 'RETREAT', { x: 16, y: 38, z: -9 }),
    offerCandidate('WAIT', 'WAIT'),
    offerCandidate('ESCALATE', 'ESCALATE'),
  ]
}

function offerWorld(overrides: Partial<SelfState> = {}, signals: Partial<AgentSignals> = {}): WorldState {
  const feet: Vec3Json = { x: 16, y: 37, z: -9 }
  const counts: Record<string, number> = { cobblestone: 4 }
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  const inventory: InventoryState = { slots, counts, totalItems: 4 }
  const self: SelfState = {
    username: 'AI_REC',
    position: feet,
    eyePosition: { x: feet.x, y: feet.y + 1.62, z: feet.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 10,
    food: 18,
    gameMode: 'survival',
    dimension: NETHER,
    isDay: true,
    heldItem: null,
    ...overrides,
  }
  const baseSignals: AgentSignals = {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastPathStatus: 'idle',
    stalledMs: 0,
    lastPolicyConfidence: null,
    maxConcurrentActions: 0,
    escalationRecommended: false,
    failedCandidates: {},
    knownResources: [],
    ...signals,
  }
  const goalQueue: GoalQueueState = {
    depth: 1,
    current: staleDescendRow(),
    empty: false,
    hasImpossible: false,
    done: 3,
    goals: [staleDescendRow()],
  }
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_790_000_000_000,
    self,
    inventory,
    entities: [],
    blocks: [],
    terrain: { standable: [feet] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    portalFrameSites: [],
    descent: [],
    stepCuts: [],
    headroomCuts: [],
    goal: {
      id: 'g',
      description: 'explore',
      targetItem: 'raw_iron',
      requiredCount: 1,
      startCount: 0,
      haveCount: 0,
      progress: 0,
      complete: false,
      startedAtMs: 0,
    },
    goalQueue,
    recentEvents: [],
    signals: baseSignals,
  }
}

addCase('(x) the measured shape: the unexecutable head no longer offers its own descent', () => {
  const state = offerWorld()
  const offer = measuredOffer()
  const restriction = restrictCandidatesNotExecutableHere(state, offer, liveBinding(), offer)
  const keptKinds = restriction.candidates.map((candidate) => candidate.kind)
  const withheldIds = restriction.withheld.map((candidate) => candidate.id)
  const pass =
    restriction.bound === true &&
    restriction.reason === 'bound' &&
    withheldIds.includes('DESCEND:level:N:b16_37_-9') &&
    withheldIds.includes('MOVE:p16_37_-9') &&
    withheldIds.includes('STEP:down:E:b16_36_-9') &&
    // ONLY body motion is withheld: no candidate that walks or descends toward the
    // unreachable y32 predicate survives
    restriction.withheld.every((candidate) => NOT_EXECUTABLE_HERE_WITHHELD_KINDS.has(candidate.kind)) &&
    // the body can still hold, hand off and self-care
    keptKinds.includes('WAIT') &&
    keptKinds.includes('ESCALATE') &&
    keptKinds.includes('RETREAT')
  return { pass, detail: `bound=${restriction.bound} kept=[${keptKinds.join(',')}] withheld=[${withheldIds.join(',')}]` }
})

addCase('(x) the same-dimension head executes exactly as now (no binding)', () => {
  const state = offerWorld()
  const offer = measuredOffer()
  const unbound = restrictCandidatesNotExecutableHere(state, offer, null, offer)
  const sameDimensionHead = restrictCandidatesNotExecutableHere(
    state,
    offer,
    { ...liveBinding(), declaredDimension: 'the_nether', reason: 'never' },
    offer,
  )
  // A binding whose row DOES declare the live dimension is not a proof; the
  // controller only creates one from the queue's escalate result, and the control
  // here pins that the pure filter is driven by the fact, not by the row's kind.
  const pass =
    unbound.bound === false &&
    unbound.reason === 'no_binding' &&
    unbound.candidates.length === offer.length &&
    sameDimensionHead.bound === true &&
    unbound.withheld.length === 0
  return { pass, detail: `unbound=${unbound.reason} candidates=${unbound.candidates.length}/${offer.length}` }
})

addCase('(x) a safety envelope always outranks the binding (escape routes are never withdrawn)', () => {
  const offer = measuredOffer()
  // lava at the body's own cell
  const hazardState = offerWorld({
    envHazard: {
      active: true,
      inFire: false,
      inLava: true,
      onFire: false,
      drowning: false,
      headInWater: false,
      airAbove: true,
      adjacentLava: true,
      inWaterWhileBurning: false,
      kinds: ['in_lava'],
      cell: { x: 16, y: 37, z: -9 },
      block: 'lava',
      leavesCell: true,
      immediateDamage: true,
      escapeRequired: true,
      detail: 'lava at the body cell',
    },
  } as unknown as Partial<SelfState>)
  const hazard = restrictCandidatesNotExecutableHere(hazardState, offer, liveBinding(), offer)
  // out of air: the submersion envelope owns the escape
  const drowningState = offerWorld({ air: 2, feetInWater: true, eyesInWater: true })
  const drowning = restrictCandidatesNotExecutableHere(drowningState, offer, liveBinding(), offer)
  // critical damage still landing
  const damageState = offerWorld(
    {},
    { criticalDamage: { active: true, since: 1, health: 4, damageTaken: 3, sources: [] } } as unknown as Partial<AgentSignals>,
  )
  const damage = restrictCandidatesNotExecutableHere(damageState, offer, liveBinding(), offer)
  const pass =
    safetyEnvelopeActive(hazardState, offer) === true &&
    hazard.bound === false &&
    hazard.reason === 'safety_envelope_active' &&
    hazard.candidates.length === offer.length &&
    drowning.bound === false &&
    drowning.reason === 'safety_envelope_active' &&
    damage.bound === false &&
    damage.reason === 'safety_envelope_active' &&
    // a healthy, dry body is NOT in an envelope, so the binding applies
    safetyEnvelopeActive(offerWorld(), offer) === false
  return {
    pass,
    detail: `hazard=${hazard.reason}/${hazard.candidates.length} drowning=${drowning.reason} damage=${damage.reason} healthyEnvelope=${safetyEnvelopeActive(offerWorld(), offer)}`,
  }
})

addCase('(x) the binding never empties the offer and never touches a row that can run here', () => {
  const state = offerWorld()
  const noControl = [offerCandidate('DESCEND:level:N:b16_37_-9', 'DESCEND', { x: 16, y: 36, z: -9 })]
  const empty = restrictCandidatesNotExecutableHere(state, noControl, liveBinding(), noControl)
  const controlOnly = [offerCandidate('WAIT', 'WAIT'), offerCandidate('ESCALATE', 'ESCALATE')]
  const notNarrowing = restrictCandidatesNotExecutableHere(state, controlOnly, liveBinding(), controlOnly)
  const pass =
    empty.bound === false &&
    empty.reason === 'no_kept_candidates' &&
    empty.candidates.length === noControl.length &&
    notNarrowing.bound === false &&
    notNarrowing.reason === 'not_narrowing' &&
    notNarrowing.candidates.length === 2
  return { pass, detail: `empty=${empty.reason} controlOnly=${notNarrowing.reason}` }
})

addCase('(x) the controller binds the offer, remembers the fact, and interrupts an in-flight work action', async () => {
  const source =
    (await Bun.file(new URL('./../jev-agent/src/controller-legacy.ts', import.meta.url)).text()) +
    (await Bun.file(new URL('./../jev-agent/src/goal-queue-plane.ts', import.meta.url)).text()).replace(/\bhost\./g, 'this.')
  const required = [
    'restrictCandidatesNotExecutableHere(',
    'this.notExecutableHereBinding =',
    "result.action === 'escalate' && result.goalId !== null",
    'const rawOfferBeforeSafety = candidates',
    'isNotExecutableHereWithheldKind(running.kind)',
    'this.executor.cancelCurrent(`row not executable here:',
    'formatNotExecutableHereInterrupt(binding, running.id, running.kind)',
  ]
  const missing = required.filter((needle) => !source.includes(needle))
  const pass = missing.length === 0
  return { pass, detail: `missing=[${missing.join(' | ')}]` }
})

// ---------------------------------------------------------------------------
// (xi) a dimension-TRANSFER row is not "not executable here", and the binding is
//      narrowed to body motion (the measured one-hour deadlock)
// ---------------------------------------------------------------------------
// Live (main 06c5976, the floated-portal trial): `g99:place:nether_portal
// targetPredicate=portal_entered dimension=the_nether` was classified
// not-executable-here while the body stood in the OVERWORLD, and the binding
// withheld every work kind - including the entry's own climb legs and a needed
// pickaxe craft - for 1370 firings / one hour with the body frozen at
// (26.3,64.0,6.3). A transfer row's declared dimension is its DESTINATION.
addCase('(xi) the measured transfer row is NOT classified: its dimension is the destination', () => {
  const planned = netherPortalEntryGoal(NETHER)
  const transfer = row({
    id: 'g99:place:nether_portal',
    kind: planned.kind,
    description: planned.description,
    targetItem: planned.targetItem ?? null,
    requiredCount: planned.requiredCount ?? 1,
    targetPredicate: planned.targetPredicate ?? null,
    dimension: planned.dimension ?? NETHER,
    status: 'active',
    planIdentity: staleIdentity(),
  })
  const queue = new GoalQueue()
  queue.restore({ counter: 99, goals: [transfer], revision: 99, planIdentity: staleIdentity() })
  // body on the OTHER side (overworld) - exactly the measured state
  const result = queue.reconcileNotExecutableHead({ liveDimension: OVERWORLD })
  const pass =
    planned.targetPredicate === PORTAL_ENTERED_PREDICATE &&
    result.action === 'hold' &&
    result.reason === 'dimension_transfer_goal' &&
    result.declaredDimension === 'the_nether' &&
    result.liveDimension === 'overworld' &&
    queue.current?.id === 'g99:place:nether_portal' &&
    queue.current?.status === 'active' &&
    queue.current?.deferCount === undefined
  return { pass, detail: `action=${result.action}/${result.reason} head=${queue.current?.id ?? 'none'}/${queue.current?.status ?? 'none'} defers=${queue.current?.deferCount ?? 0}` }
})

addCase('(xi) with the transfer row exempt there is no binding, so the climb offer survives', () => {
  const planned = netherPortalEntryGoal(NETHER)
  const transfer = row({
    id: 'g99:place:nether_portal',
    kind: planned.kind,
    description: planned.description,
    targetItem: planned.targetItem ?? null,
    requiredCount: planned.requiredCount ?? 1,
    targetPredicate: planned.targetPredicate ?? null,
    dimension: planned.dimension ?? NETHER,
    status: 'active',
    planIdentity: staleIdentity(),
  })
  const queue = new GoalQueue()
  queue.restore({ counter: 99, goals: [transfer], revision: 99, planIdentity: staleIdentity() })
  const result = queue.reconcileNotExecutableHead({ liveDimension: OVERWORLD })
  // The controller binds ONLY on an escalate result, so a hold leaves binding null.
  const binding = result.action === 'escalate' && result.goalId !== null ? liveBinding() : null
  const offer = [
    offerCandidate('MOVE:p26_64_6', 'MOVE', { x: 26, y: 64, z: 6 }),
    offerCandidate('STEP:up:N:b26_65_6', 'STEP', { x: 26, y: 65, z: 6 }),
    offerCandidate('DESCEND:level:N:b26_63_6', 'DESCEND', { x: 26, y: 63, z: 6 }),
    offerCandidate('ENTER:26,67,9', 'ENTER_PORTAL', { x: 26, y: 67, z: 9 }),
    offerCandidate('CRAFT:wooden_pickaxe', 'CRAFT'),
    offerCandidate('WAIT', 'WAIT'),
  ]
  const restriction = restrictCandidatesNotExecutableHere(offerWorld(), offer, binding, offer)
  const pass =
    binding === null &&
    restriction.bound === false &&
    restriction.reason === 'no_binding' &&
    restriction.candidates.length === offer.length &&
    restriction.candidates.some((candidate) => candidate.kind === 'ENTER_PORTAL') &&
    restriction.candidates.some((candidate) => candidate.kind === 'MOVE') &&
    restriction.candidates.some((candidate) => candidate.kind === 'DESCEND')
  return { pass, detail: `queue=${result.reason} binding=${binding === null ? 'none' : 'set'} offer=${restriction.candidates.length}/${offer.length} kinds=[${restriction.candidates.map((c) => c.kind).join(',')}]` }
})

addCase('(xi) the narrowed binding still stops the descent but never stops the work (no deadlock)', () => {
  const workOffer = [
    offerCandidate('DESCEND:level:N:b16_37_-9', 'DESCEND', { x: 16, y: 36, z: -9 }),
    offerCandidate('MOVE:p16_37_-9', 'MOVE', { x: 16, y: 37, z: -9 }),
    offerCandidate('STEP:down:E:b16_36_-9', 'STEP', { x: 16, y: 36, z: -9 }),
    offerCandidate('CRAFT:pickaxe', 'CRAFT'),
    offerCandidate('SMELT:iron_ingot', 'SMELT'),
    offerCandidate('RETRIEVE:known:iron_ore', 'RETRIEVE'),
    offerCandidate('MINE:stone', 'MINE'),
    offerCandidate('EAT:bread', 'EAT'),
    offerCandidate('WAIT', 'WAIT'),
  ]
  const restriction = restrictCandidatesNotExecutableHere(offerWorld(), workOffer, liveBinding(), workOffer)
  const kinds = restriction.candidates.map((candidate) => candidate.kind)
  const withheld = restriction.withheld.map((candidate) => candidate.kind)
  const pass =
    restriction.bound === true &&
    withheld.join(',') === 'DESCEND,MOVE,STEP' &&
    kinds.includes('CRAFT') &&
    kinds.includes('SMELT') &&
    kinds.includes('RETRIEVE') &&
    kinds.includes('MINE') &&
    kinds.includes('EAT') &&
    kinds.includes('WAIT')
  return { pass, detail: `withheld=[${withheld.join(',')}] kept=[${kinds.join(',')}]` }
})

addCase('(xi) goto keeps its own dimension guard and is never read as a transfer row', () => {
  const goto = {
    kind: 'goto' as const,
    targetPredicate: PORTAL_ENTERED_PREDICATE,
    optionTemplateId: 'enter_portal',
    semanticOptionTemplateId: 'enter_portal',
  }
  const descend = { kind: 'collect' as const, targetPredicate: 'levelAtMost', optionTemplateId: 'explore:cave' }
  const pass = isDimensionTransferGoal(goto) === false && isDimensionTransferGoal(descend) === false
  return { pass, detail: `goto=${isDimensionTransferGoal(goto)} descend=${isDimensionTransferGoal(descend)}` }
})

addCase('(xi) the controller only binds on escalate and cancels only body motion', async () => {
  const source =
    (await Bun.file(new URL('./../jev-agent/src/controller-legacy.ts', import.meta.url)).text()) +
    (await Bun.file(new URL('./../jev-agent/src/goal-queue-plane.ts', import.meta.url)).text()).replace(/\bhost\./g, 'this.')
  const required = [
    "result.action === 'escalate' && result.goalId !== null",
    'isNotExecutableHereWithheldKind(running.kind)',
  ]
  const forbidden = ['isNotExecutableHereKeepKind']
  const missing = required.filter((needle) => !source.includes(needle))
  const leftover = forbidden.filter((needle) => source.includes(needle))
  const pass = missing.length === 0 && leftover.length === 0
  return { pass, detail: `missing=[${missing.join(' | ')}] leftover=[${leftover.join(' | ')}]` }
})

// ---------------------------------------------------------------------------
let failures = 0
process.stdout.write('plan/objective reconciliation of the durable queue\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
setPrereqAuditSink(null)
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} plan-reconciliation cases passed\n`)

if (failures > 0) process.exit(1)
