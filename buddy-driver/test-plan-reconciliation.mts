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
  PLAN_ROW_RETIRED,
  ROW_DEFERRED_NOT_EXECUTABLE_HERE,
  ROW_NOT_EXECUTABLE_HERE,
  formatPlanIdentity,
  formatPlanIdentityChanged,
  notExecutableReplanRequest,
  planIdentityId,
  planReplanRequest,
  setPrereqAuditSink,
} from '../jev-agent/src/goalQueue.ts'
import type { GoalQueueSnapshot, PlanIdentity, QueuedGoal } from '../jev-agent/src/goalQueue.ts'
import { MIRRORED_MARKERS, mirroredEventToken } from '../jev-agent/src/controller-legacy.ts'
import { planIdentityFor, supersededPlanObsoleteProof } from './generation-entry.ts'
import { emptyWorldMemory } from './resident-types.ts'
import type { ResidentWorldMemory } from './resident-types.ts'
import { deriveResumeRung, rungIndexById } from './planner.ts'
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
    ROW_NOT_EXECUTABLE_HERE,
    ROW_DEFERRED_NOT_EXECUTABLE_HERE,
    'NO_PRODUCTIVE_HEAD_BOUND',
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
