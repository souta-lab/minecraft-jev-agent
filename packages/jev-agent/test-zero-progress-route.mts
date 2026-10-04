// test-zero-progress-route.mts - the zero-observable-change "what happens NEXT"
// rule.
//
// Measured live (run-muc3qbug-18vg3, source 376e176): 82 causal chains in ten
// minutes carried `observable=false execution=failure`, 75 of them
// `DESCEND:down:<dir>:b...` steps whose dig removed nothing
// (`PATH_CALLBACK phase=failed ... outcome=noPath|stuck`), plus 5
// `RETRIEVE:known:raw_iron:*` attempts whose vertical plan could not make the
// remembered ore observable. Every failed sample had a FRESH candidate id but the
// SAME body cell, so the per-id failure memory never saw one failure - the run
// re-issued "the same action with unchanged preconditions" until a stall timer
// retired it.
//
// The postcondition layer still owns the verdict: a zero-progress action IS a
// failure (`isZeroProgressOutcome`). This fixture proves the NEXT-attempt rule:
//
//   (a) a remembered ore above the body whose pillar plan cannot execute is not
//       re-issued unchanged: a grounded approach leg is offered, or the target is
//       retired with a typed reason after the bounded budget;
//   (b) a target that becomes reachable after one approach leg is offered again
//       (no premature retirement), and a completion clears the memory;
//   (c) a descend step that breaks nothing yields a DIFFERENT step or a typed
//       bounded family retirement - never the same step again;
//   (d) genuinely successful actions keep behaving exactly as today (an
//       unchanged offer with no memory at all).
//
// No bot, no network.
//
// Run: bun test-zero-progress-route.mts
import { readFileSync } from 'node:fs'
import { defaultCandidateOptions, entryCandidates, generateCandidates, generateGroundedCandidates } from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { descentPrimaryCell } from './src/state.ts'
import type { AgentSignals, DescentOption, GoalState, InventoryState, KnownResource, SelfState, Vec3Json, WorldState } from './src/state.ts'
import { NETHER, NETHER_PORTAL, PORTAL_ENTERED_PREDICATE } from './src/netherPortalPlan.ts'
import {
  cellKey,
  clearZeroProgressStand,
  clearZeroProgressTarget,
  formatActionZeroProgress,
  formatApproachLeg,
  formatDescendRetired,
  formatRetrieveRetired,
  formatRouteEscalate,
  formatRouteSpent,
  formatRouteStageFailed,
  goalSpentRouteCount,
  isZeroProgressRouteRepeat,
  observeZeroProgressRoute,
  routeFailureStage,
  routePlanSignature,
  routeSignature,
  ROUTE_ALL_SPENT_REASON,
  standFamilyExhausted,
  standFamilyRouteCount,
  ZERO_PROGRESS_STAND_ROUTE_LIMIT,
  ZERO_PROGRESS_TTL_MS,
} from './src/zeroProgressRoute.ts'
import type { ZeroProgressRoutes } from './src/zeroProgressRoute.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const NOW = 1_700_000_000_000

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_ZP',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'overworld',
    isDay: true,
    heldItem: null,
  }
}

function inventory(counts: Record<string, number>): InventoryState {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0) }
}

function goal(): GoalState {
  return {
    id: 'descend:raw_iron',
    description: 'collect raw_iron',
    targetItem: 'raw_iron',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(overrides: Partial<QueuedGoal> = {}): QueuedGoal {
  return {
    id: 'g15',
    kind: 'descend',
    description: 'descend toward ore levels',
    targetItem: 'raw_iron',
    requiredCount: 1,
    targetY: -54,
    dimension: 'minecraft:overworld',
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
    ...overrides,
  }
}

function queueWith(current: QueuedGoal): GoalQueueState {
  return { ...emptyGoalQueueState(), depth: 1, current, empty: false, goals: [current] }
}

function signals(overrides: Partial<AgentSignals> = {}): AgentSignals {
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
    ...overrides,
  }
}

function downStep(dir: DescentOption['dir'], dx: number, dz: number, feet: Vec3Json): DescentOption {
  return {
    dir,
    mode: 'down',
    dx,
    dz,
    step: { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz },
    wall: { x: feet.x + dx, y: feet.y, z: feet.z + dz },
    head: { x: feet.x + dx, y: feet.y + 1, z: feet.z + dz },
    floor: { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz },
    wallSolid: false,
    headSolid: false,
    floorSolid: true,
    safe: true,
    reason: 'safe',
    digName: 'stone',
    digHarvestTool: 'pickaxe',
    digHarvestTier: 1,
    diggable: true,
  }
}

function levelStep(dir: DescentOption['dir'], dx: number, dz: number, feet: Vec3Json): DescentOption {
  return {
    dir,
    mode: 'level',
    dx,
    dz,
    step: { x: feet.x + dx, y: feet.y, z: feet.z + dz },
    wall: { x: feet.x + dx, y: feet.y, z: feet.z + dz },
    head: { x: feet.x + dx, y: feet.y + 1, z: feet.z + dz },
    floor: { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz },
    wallSolid: true,
    headSolid: false,
    floorSolid: true,
    safe: true,
    reason: 'safe',
    digName: 'stone',
    digHarvestTool: 'pickaxe',
    digHarvestTier: 1,
    diggable: true,
  }
}

function worldState(overrides: {
  position: Vec3Json
  goalQueue?: GoalQueueState
  signals?: AgentSignals
  descent?: DescentOption[]
  standable?: Vec3Json[]
  known?: KnownResource[]
  counts?: Record<string, number>
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: NOW,
    self: self(overrides.position),
    inventory: inventory(overrides.counts ?? { stone_pickaxe: 1, cobblestone: 16 }),
    entities: [],
    blocks: [],
    terrain: { standable: overrides.standable ?? [{ x: Math.floor(overrides.position.x), y: Math.floor(overrides.position.y), z: Math.floor(overrides.position.z) }] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goal(),
    goalQueue: overrides.goalQueue ?? queueWith(queuedGoal()),
    recentEvents: [],
    descent: overrides.descent,
    stepCuts: [],
    headroomCuts: [],
    signals: overrides.signals ?? signals({ knownResources: overrides.known ?? [] }),
  }
}

/** The exact ledger entry the controller writes for a settled zero-progress try. */
function ledgerFor(kind: string, target: Vec3Json, stand: Vec3Json, routeSig: string): ZeroProgressRoutes {
  const decision = observeZeroProgressRoute(undefined, {
    kind,
    targetKey: cellKey(target),
    standKey: cellKey(stand),
    routeSig,
    reason: 'stuck',
    nowMs: NOW,
  })
  return decision.routes
}

// --- the measured travel/enter shape (run-muc620xb-1d312, gen-muc8zwpv-ddlzrh) ----
//
// The body stood at 10,54,25 (13 blocks below and ~16 blocks away from the lit
// gate at 26,67,9) inside the `enter_portal` goal. Every tick the offer was
// `[ENTER:26,67,9, ASCEND:habitat:p10_65_25, WAIT]`, the entry settled
// `PATH_CALLBACK phase=failed outcome=noPath|stuck`, and the identical entry was
// re-offered 669 times. Nothing below hard-codes the portal: it is a route-shaped
// locomotion candidate whose path stage keeps failing, exactly like a remembered
// ore behind blocked terrain.

const PORTAL_ENTER_CELL: Vec3Json = { x: 26, y: 67, z: 9 }
const PORTAL_BODY: Vec3Json = { x: 10, y: 54, z: 25 }

function portalQueuedGoal(): QueuedGoal {
  return queuedGoal({
    id: 'g-portal-entered',
    kind: 'place',
    description: 'portal_entered nether_portal',
    targetItem: NETHER_PORTAL,
    targetPredicate: PORTAL_ENTERED_PREDICATE,
    dimension: NETHER,
  })
}

/** The gate's grounded entry route as the controller supplies it (no world plan needed here). */
function portalEntryOptions(enterCell: Vec3Json = PORTAL_ENTER_CELL): CandidateOptions {
  return {
    ...defaultCandidateOptions,
    portalEntry: {
      ok: true,
      candidate: {
        id: `ENTER:${enterCell.x},${enterCell.y},${enterCell.z}`,
        portalCells: [enterCell],
        enterCell,
        dimension: NETHER,
        line: `PORTAL_ENTRY site=${enterCell.x},${enterCell.y},${enterCell.z}`,
      },
    },
  }
}

function portalWorld(overrides: {
  position: Vec3Json
  standable: Vec3Json[]
  routes?: ZeroProgressRoutes
}): WorldState {
  return worldState({
    position: overrides.position,
    standable: overrides.standable,
    goalQueue: queueWith(portalQueuedGoal()),
    signals: signals({ zeroProgressRoutes: overrides.routes }),
  })
}

/** The route identity the controller records for a settled entry attempt. */
function enterRouteSig(candidate: Candidate): string {
  return routeSignature({ kind: candidate.kind, id: candidate.id, meta: candidate.meta })
}

function withRoutes(state: WorldState, routes: ZeroProgressRoutes): WorldState {
  return { ...state, signals: { ...state.signals, zeroProgressRoutes: routes } }
}

// --- pure rule -------------------------------------------------------------------

addCase('a repeat of the same route from the same stand cell is blocked; a changed route or stand is not', () => {
  const target = { x: 11, y: 20, z: 20 }
  const routes = ledgerFor('DESCEND', target, { x: 10, y: 21, z: 20 }, 'DESCEND:down:E:dig=11,20,20:step=11,20,20')
  const same = isZeroProgressRouteRepeat(routes, {
    kind: 'DESCEND',
    targetKey: cellKey(target),
    standKey: cellKey({ x: 10, y: 21, z: 20 }),
    routeSig: 'DESCEND:down:E:dig=11,20,20:step=11,20,20',
    nowMs: NOW,
  })
  const changedRoute = isZeroProgressRouteRepeat(routes, {
    kind: 'DESCEND',
    targetKey: cellKey(target),
    standKey: cellKey({ x: 10, y: 21, z: 20 }),
    routeSig: 'DESCEND:level:E:dig=11,21,20:step=11,21,20',
    nowMs: NOW,
  })
  const changedStand = isZeroProgressRouteRepeat(routes, {
    kind: 'DESCEND',
    targetKey: cellKey(target),
    standKey: cellKey({ x: 30, y: 21, z: 20 }),
    routeSig: 'DESCEND:down:E:dig=11,20,20:step=11,20,20',
    nowMs: NOW,
  })
  return {
    pass: same && !changedRoute && !changedStand,
    detail: `same=${same} changedRoute=${changedRoute} changedStand=${changedStand}`,
  }
})

addCase('the memory forgets an attempt older than the TTL so a transient blockage is not permanent', () => {
  const target = { x: 11, y: 20, z: 20 }
  const routes = ledgerFor('DESCEND', target, { x: 10, y: 21, z: 20 }, 'sig')
  const repeatNow = isZeroProgressRouteRepeat(routes, {
    kind: 'DESCEND',
    targetKey: cellKey(target),
    standKey: cellKey({ x: 10, y: 21, z: 20 }),
    routeSig: 'sig',
    nowMs: NOW + ZERO_PROGRESS_TTL_MS + 1,
  })
  return { pass: !repeatNow, detail: `repeatAfterTtl=${repeatNow}` }
})

addCase('a second DISTINCT zero-progress route at the same stand cell exhausts the family there', () => {
  const stand = { x: 10, y: 21, z: 20 }
  const first = observeZeroProgressRoute(undefined, {
    kind: 'DESCEND',
    targetKey: '11_20_20',
    standKey: cellKey(stand),
    routeSig: 'DESCEND:down:E:dig=11,20,20:step=11,20,20',
    reason: 'stuck',
    nowMs: NOW,
  })
  const second = observeZeroProgressRoute(first.routes, {
    kind: 'DESCEND',
    targetKey: '10_20_21',
    standKey: cellKey(stand),
    routeSig: 'DESCEND:down:S:dig=10,20,21:step=10,20,21',
    reason: 'noPath',
    nowMs: NOW + 10,
  })
  const exhausted = standFamilyExhausted(second.routes, 'DESCEND', cellKey(stand), { nowMs: NOW + 11 })
  const routes = standFamilyRouteCount(second.routes, 'DESCEND', cellKey(stand), { nowMs: NOW + 11 })
  return {
    pass: second.familyAttempts === 2 && second.familyExhausted && exhausted && routes === 2,
    detail: `familyAttempts=${second.familyAttempts} exhausted=${second.familyExhausted} routes=${routes} limit=${ZERO_PROGRESS_STAND_ROUTE_LIMIT}`,
  }
})

addCase('route_changed reports whether the attempt differed from the previous one for the same target', () => {
  const target = '11_20_20'
  const first = observeZeroProgressRoute(undefined, {
    kind: 'DESCEND',
    targetKey: target,
    standKey: '10_21_20',
    routeSig: 'routeA',
    reason: 'stuck',
    nowMs: NOW,
  })
  const same = observeZeroProgressRoute(first.routes, {
    kind: 'DESCEND',
    targetKey: target,
    standKey: '10_21_20',
    routeSig: 'routeA',
    reason: 'stuck',
    nowMs: NOW + 1,
  })
  const changed = observeZeroProgressRoute(same.routes, {
    kind: 'DESCEND',
    targetKey: target,
    standKey: '10_22_20',
    routeSig: 'routeB',
    reason: 'stuck',
    nowMs: NOW + 2,
  })
  return {
    pass: first.routeChanged === false && same.routeChanged === false && changed.routeChanged === true,
    detail: `first=${first.routeChanged} same=${same.routeChanged} changed=${changed.routeChanged}`,
  }
})

addCase('observable completion clears the stand cell and the target memory', () => {
  const routes = observeZeroProgressRoute(undefined, {
    kind: 'RETRIEVE',
    targetKey: '24_22_11',
    standKey: '10_21_20',
    routeSig: 'routeA',
    reason: 'stuck',
    nowMs: NOW,
  }).routes
  const clearedStand = clearZeroProgressStand(routes, 'RETRIEVE', '10_21_20')
  const clearedTarget = clearZeroProgressTarget(routes, 'RETRIEVE', '24_22_11')
  return {
    pass: Object.keys(clearedStand).length === 0 && Object.keys(clearedTarget).length === 0,
    detail: `stand=${Object.keys(clearedStand).length} target=${Object.keys(clearedTarget).length}`,
  }
})

addCase('the typed marker lines are stable and greppable', () => {
  const zero = formatActionZeroProgress({
    action: 'DESCEND:down:E:b10_18_20',
    target: { x: 10, y: 18, z: 20 },
    kind: 'DESCEND',
    retry: 1,
    routeChanged: false,
    stand: { x: 10.4, y: 21, z: 20.5 },
  })
  const retired = formatRetrieveRetired('zero_progress_budget', { x: 24, y: 22, z: 11 }, 2)
  const descend = formatDescendRetired('zero_progress_exhausted', { x: 10, y: 21, z: 20 }, 2)
  const leg = formatApproachLeg('target_not_observable', { x: 24, y: 22, z: 11 })
  return {
    pass:
      zero ===
        'ACTION_ZERO_PROGRESS action=DESCEND:down:E:b10_18_20 target=10,18,20 kind=DESCEND retry=1 route_changed=false stand=10,21,20' &&
      retired === 'RETRIEVE_RETIRED reason=zero_progress_budget target=24,22,11 attempts=2' &&
      descend === 'DESCEND_RETIRED reason=zero_progress_exhausted stand=10,21,20 routes=2' &&
      leg === 'APPROACH_LEG reason=target_not_observable target=24,22,11',
    detail: `${zero} | ${retired} | ${descend} | ${leg}`,
  }
})

// --- (c) descend: a step that breaks nothing is not re-issued ---------------------

addCase('(c) a descend step whose dig removed nothing is not offered again from the same stand cell', () => {
  const feet = { x: 10, y: 21, z: 20 }
  const east = downStep('E', 1, 0, feet)
  const south = downStep('S', 0, 1, feet)
  const descent = [east, south]
  // The exact controller path: whatever candidate the generator chose is the one
  // whose settled outcome is recorded, signature and all.
  const chosen = generateCandidates(worldState({ position: feet, descent, signals: signals() })).find(
    (candidate) => candidate.kind === 'DESCEND',
  )
  if (chosen === undefined) return { pass: false, detail: 'no descend candidate to record' }
  const routes = ledgerFor(
    'DESCEND',
    chosen.target ?? feet,
    feet,
    routeSignature({ kind: chosen.kind, id: chosen.id, meta: chosen.meta }),
  )
  const ids = generateCandidates(worldState({ position: feet, descent, signals: signals({ zeroProgressRoutes: routes }) })).map(
    (candidate) => candidate.id,
  )
  return {
    pass: !ids.includes(chosen.id) && ids.length > 0,
    detail: `recorded=${chosen.id} offered=${JSON.stringify(ids)}`,
  }
})

addCase('(c) once the family is spent at this stand cell no down step is offered there (a level step is)', () => {
  const feet = { x: 10, y: 21, z: 20 }
  const east = downStep('E', 1, 0, feet)
  const south = downStep('S', 0, 1, feet)
  const eastLevel = levelStep('E', 1, 0, feet)
  const descent = [east, south, eastLevel]
  let routes: ZeroProgressRoutes = {}
  const recorded: string[] = []
  // Two real generator ticks, each recording whatever it chose as a zero-progress
  // outcome - the measured live loop (`DESCEND:down:...` failing with no dug
  // block), then the third tick must not offer a down step at this cell.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const chosen = generateCandidates(
      worldState({ position: feet, descent, signals: signals({ zeroProgressRoutes: routes }) }),
    ).find((candidate) => candidate.kind === 'DESCEND' && candidate.id.startsWith('DESCEND:down:'))
    if (chosen === undefined) break
    recorded.push(chosen.id)
    routes = observeZeroProgressRoute(routes, {
      kind: 'DESCEND',
      targetKey: cellKey(chosen.target ?? feet),
      standKey: cellKey(feet),
      routeSig: routeSignature({ kind: chosen.kind, id: chosen.id, meta: chosen.meta }),
      reason: 'noPath',
      nowMs: NOW + attempt,
    }).routes
  }
  const ids = generateCandidates(worldState({ position: feet, descent, signals: signals({ zeroProgressRoutes: routes }) })).map(
    (candidate) => candidate.id,
  )
  const downOffered = ids.filter((id) => id.startsWith('DESCEND:down:'))
  const levelOffered = ids.filter((id) => id.startsWith('DESCEND:level:'))
  return {
    pass: recorded.length === 2 && downOffered.length === 0 && levelOffered.length === 1,
    detail: `recorded=${JSON.stringify(recorded)} down=${JSON.stringify(downOffered)} level=${JSON.stringify(levelOffered)}`,
  }
})

// --- (d) successes unchanged -----------------------------------------------------

addCase('(d) with no zero-progress memory the descend offer is byte-identical to today', () => {
  const feet = { x: 10, y: 21, z: 20 }
  const east = downStep('E', 1, 0, feet)
  const south = downStep('S', 0, 1, feet)
  const state = worldState({ position: feet, descent: [east, south], signals: signals() })
  const offered = generateCandidates(state)
  const primary = descentPrimaryCell(east)
  const first = offered.find((candidate) => candidate.id.startsWith('DESCEND:'))
  return {
    pass:
      first !== undefined &&
      first.id === `DESCEND:down:E:b${primary.x}_${primary.y}_${primary.z}` &&
      first.kind === 'DESCEND' &&
      first.target?.x === primary.x &&
      first.target?.y === primary.y &&
      first.target?.z === primary.z &&
      first.meta.mode === 'down' &&
      first.meta.dir === 'E',
    detail: `id=${first?.id ?? 'none'} target=${JSON.stringify(first?.target ?? null)}`,
  }
})

// --- (a) remembered ore above with an unexecutable pillar plan --------------------

const ORE_ABOVE: KnownResource = {
  name: 'iron_ore',
  kind: 'ore',
  position: { x: 24, y: 22, z: 11 },
  dimension: 'minecraft:overworld',
}

addCase('(a) a remembered ore above the body gets the pillar plan, and its unchanged repeat is replaced by an approach leg', () => {
  const feet = { x: 10, y: 21, z: 20 }
  const standable = [
    { x: 10, y: 21, z: 20 },
    { x: 12, y: 21, z: 20 },
  ]
  const base = worldState({
    position: feet,
    standable,
    signals: signals({ knownResources: [ORE_ABOVE] }),
  })
  const offered = generateGroundedCandidates(base)
  const retrieve = offered.candidates.find((candidate) => candidate.id === 'RETRIEVE:known:raw_iron:b24_22_11')
  const pillarPlan = retrieve?.meta.vertical === 'pillar'

  // The settled attempt proved it changed nothing: the same route from the same
  // stand cell must not be re-issued. A grounded approach leg is offered instead.
  const routes = ledgerFor(
    'RETRIEVE',
    ORE_ABOVE.position,
    feet,
    retrieve === undefined
      ? 'RETRIEVE:none'
      : routeSignature({ kind: retrieve.kind, id: retrieve.id, meta: retrieve.meta }),
  )
  const after = worldState({
    position: feet,
    standable,
    signals: signals({ knownResources: [ORE_ABOVE], zeroProgressRoutes: routes }),
  })
  const offeredAfter = generateGroundedCandidates(after)
  const withheld = !offeredAfter.candidates.some((candidate) => candidate.id === 'RETRIEVE:known:raw_iron:b24_22_11')
  const leg = offeredAfter.candidates.find((candidate) => candidate.meta.approachLeg === 'target_not_observable')
  const legLabel = leg === undefined ? null : formatApproachLeg('target_not_observable', leg.target ?? ORE_ABOVE.position)
  return {
    pass:
      pillarPlan &&
      withheld &&
      leg !== undefined &&
      leg.kind === 'MOVE' &&
      leg.target !== null &&
      leg.target.x === 12 &&
      legLabel === 'APPROACH_LEG reason=target_not_observable target=12,21,20',
    detail: `pillar=${pillarPlan} withheld=${withheld} leg=${leg?.id ?? 'none'} marker=${legLabel ?? 'none'}`,
  }
})

addCase('(a) the retirement budget line names the reason, target and attempts', () => {
  const line = formatRetrieveRetired('zero_progress_budget', ORE_ABOVE.position, 2)
  return {
    pass: line === 'RETRIEVE_RETIRED reason=zero_progress_budget target=24,22,11 attempts=2',
    detail: line,
  }
})

// --- (b) an approach leg re-opens the retrieval ----------------------------------

addCase('(b) after one approach leg the retrieval is offered again (no premature retirement)', () => {
  const feet = { x: 10, y: 21, z: 20 }
  const standable = [
    { x: 10, y: 21, z: 20 },
    { x: 14, y: 21, z: 20 },
  ]
  const first = worldState({ position: feet, standable, signals: signals({ knownResources: [ORE_ABOVE] }) })
  const initial = generateGroundedCandidates(first).candidates.find(
    (candidate) => candidate.id === 'RETRIEVE:known:raw_iron:b24_22_11',
  )
  const routes = ledgerFor(
    'RETRIEVE',
    ORE_ABOVE.position,
    feet,
    initial === undefined ? 'RETRIEVE:none' : routeSignature({ kind: initial.kind, id: initial.id, meta: initial.meta }),
  )
  // The approach leg moved the body: a NEW stand cell, same route signature. The
  // retrieval must be offered again, with a fresh attempt budget.
  const moved = worldState({
    position: { x: 14, y: 21, z: 20 },
    standable,
    signals: signals({ knownResources: [ORE_ABOVE], zeroProgressRoutes: routes }),
  })
  const offered = generateGroundedCandidates(moved).candidates
  const retrieve = offered.find((candidate) => candidate.id === 'RETRIEVE:known:raw_iron:b24_22_11')
  const blocked = isZeroProgressRouteRepeat(routes, {
    kind: 'RETRIEVE',
    targetKey: cellKey(ORE_ABOVE.position),
    standKey: cellKey(moved.self.position),
    routeSig: retrieve === undefined ? 'none' : routeSignature({ kind: retrieve.kind, id: retrieve.id, meta: retrieve.meta }),
    nowMs: NOW,
  })
  return {
    pass: retrieve !== undefined && !blocked,
    detail: `offered=${retrieve?.id ?? 'none'} blockedAtNewStand=${blocked}`,
  }
})

// --- (e) cross-stand retirement: the resource-scoped bound ---------------------
// Live p23 (run-mutsv43u): `RETRIEVE:known:log:b-14_76_26` committed 13x for 12
// typed route failures ~4min apart - each commit from a NEW stand cell, so the
// (target, stand) ledger never reached its limit, the 120s route TTL expired
// between failures, and the 30s failure-count decay erased each charge. The
// generation-scoped `retiredKnownRetrieveTargets` set is the arm-level bound:
// the remembered cell stays a dig-route bearing while the long-range RETRIEVE
// retry dies.

const ORE_ABOVE_2: KnownResource = {
  name: 'iron_ore',
  kind: 'ore',
  position: { x: 40, y: 30, z: 11 },
  dimension: 'minecraft:overworld',
}

addCase("(e) a retired remembered cell suppresses its RETRIEVE arm while a sibling cell still offers", () => {
  const feet = { x: 10, y: 21, z: 20 }
  const standable = [
    { x: 10, y: 21, z: 20 },
    { x: 12, y: 21, z: 20 },
  ]
  const retired = new Set(['iron_ore@24,22,11'])
  const offered = generateGroundedCandidates(
    worldState({
      position: feet,
      standable,
      signals: signals({ knownResources: [ORE_ABOVE, ORE_ABOVE_2], retiredKnownRetrieveTargets: retired }),
    }),
  )
  const ids = offered.candidates.map((candidate) => candidate.id)
  return {
    pass:
      !ids.includes('RETRIEVE:known:raw_iron:b24_22_11') &&
      ids.includes('RETRIEVE:known:raw_iron:b40_30_11'),
    detail: `offered=${JSON.stringify(ids.filter((id) => id.startsWith('RETRIEVE')))}`,
  }
})

addCase('(e) the retired set only gates the RETRIEVE arm: the remembered cell stays in knownResources', () => {
  const sigs = signals({ knownResources: [ORE_ABOVE], retiredKnownRetrieveTargets: new Set(['iron_ore@24,22,11']) })
  const stillKnown = (sigs.knownResources ?? []).some(
    (resource) => resource.position.x === ORE_ABOVE.position.x && resource.position.y === ORE_ABOVE.position.y,
  )
  return { pass: stillKnown, detail: `knownResources=${(sigs.knownResources ?? []).length}` }
})

addCase("(a') a path-stage failure spends the ENTER route: the identical candidate is not re-offered and the goal escalates typed", () => {
  const state = portalWorld({ position: PORTAL_BODY, standable: [PORTAL_BODY] })
  const options = portalEntryOptions()
  const first = entryCandidates(state, options)
  const entry = first.candidates[0]
  if (entry === undefined) return { pass: false, detail: 'the fresh state offered no entry route' }
  // The controller's verdict for `PATH_CALLBACK phase=failed outcome=noPath`.
  const stage = routeFailureStage('path_no_path')
  const decision = observeZeroProgressRoute(undefined, {
    kind: 'ENTER_PORTAL',
    targetKey: cellKey(PORTAL_ENTER_CELL),
    standKey: cellKey(PORTAL_BODY),
    routeSig: enterRouteSig(entry),
    reason: 'path_no_path',
    nowMs: NOW,
  })
  const after = entryCandidates(withRoutes(state, decision.routes), options)
  const line = formatRouteEscalate('g-portal-entered', ROUTE_ALL_SPENT_REASON, 1)
  return {
    pass:
      stage === 'path' &&
      decision.routeSpentNow &&
      first.candidates.length === 1 &&
      first.refusal === null &&
      after.candidates.length === 0 &&
      after.refusal?.reason === ROUTE_ALL_SPENT_REASON &&
      after.refusal.line === line &&
      line === 'ROUTE_ESCALATE goal=g-portal-entered reason=all_routes_spent routes=1',
    detail: `stage=${stage} spentNow=${decision.routeSpentNow} fresh=[${first.candidates.map((candidate) => candidate.id).join(',')}] after=[${after.candidates.map((candidate) => candidate.id).join(',')}] refusal=${after.refusal?.line ?? 'none'}`,
  }
})

addCase("(a2') a pillar place refusal is a move-stage failure, never a path-stage failure", () => {
  const stage = routeFailureStage('place_refused')
  return { pass: stage === 'move', detail: `stage=${stage}` }
})

addCase("(a') the spent route travels as the goal-level budget: routes=n grows with each distinct stand/plan identity", () => {
  const first = observeZeroProgressRoute(undefined, {
    kind: 'ENTER_PORTAL',
    targetKey: cellKey(PORTAL_ENTER_CELL),
    standKey: cellKey(PORTAL_BODY),
    routeSig: 'ENTER_PORTAL:staircase-up:W:54->67:dig=9,55,24:step=9,55,24:pillar=0:fallback=none',
    reason: 'path_no_path',
    nowMs: NOW,
  })
  const second = observeZeroProgressRoute(first.routes, {
    kind: 'ENTER_PORTAL',
    targetKey: cellKey(PORTAL_ENTER_CELL),
    standKey: cellKey({ x: 11, y: 55, z: 25 }),
    routeSig: 'ENTER_PORTAL:pillar:unknown:55->67:dig=none:step=none:pillar=12:fallback=none',
    reason: 'path_stuck',
    nowMs: NOW + 1,
  })
  const count = goalSpentRouteCount(second.routes, {
    kind: 'ENTER_PORTAL',
    targetKey: cellKey(PORTAL_ENTER_CELL),
    nowMs: NOW + 2,
  })
  return {
    pass: goalSpentRouteCount(first.routes, { kind: 'ENTER_PORTAL', targetKey: cellKey(PORTAL_ENTER_CELL), nowMs: NOW }) === 1 && count === 2,
    detail: `first=${goalSpentRouteCount(first.routes, { kind: 'ENTER_PORTAL', targetKey: cellKey(PORTAL_ENTER_CELL), nowMs: NOW })} afterSecondStand=${count}`,
  }
})

// --- (b') a grounded route change re-opens the entry ------------------------------

addCase("(b') a spent ENTER route offers the approach leg, and the entry returns once the body stands somewhere new", () => {
  const closer: Vec3Json = { x: 12, y: 54, z: 25 }
  const state = portalWorld({ position: PORTAL_BODY, standable: [PORTAL_BODY, closer] })
  const options = portalEntryOptions()
  const entry = entryCandidates(state, options).candidates[0]
  if (entry === undefined) return { pass: false, detail: 'the fresh state offered no entry route' }
  const routes = ledgerFor('ENTER_PORTAL', PORTAL_ENTER_CELL, PORTAL_BODY, enterRouteSig(entry))
  const afterSpent = entryCandidates(withRoutes(state, routes), options)
  const leg = afterSpent.candidates.find((candidate) => candidate.meta.approachLeg === 'route_spent')
  if (leg === undefined || leg.target === null) {
    return { pass: false, detail: `no approach leg: [${afterSpent.candidates.map((candidate) => candidate.id).join(',')}]` }
  }
  // The leg target is a DIFFERENT stand cell (never the body's own cell), so the
  // body that walks it meets a new mechanical situation.
  const legIsNewCell = cellKey(leg.target) !== cellKey(PORTAL_BODY)
  const movedOffer = entryCandidates(
    portalWorld({ position: leg.target, standable: [PORTAL_BODY, closer], routes }),
    options,
  )
  const reoffered = movedOffer.candidates.find((candidate) => candidate.kind === 'ENTER_PORTAL')
  const blockedAtNewStand =
    reoffered === undefined ||
    isZeroProgressRouteRepeat(routes, {
      kind: 'ENTER_PORTAL',
      targetKey: cellKey(PORTAL_ENTER_CELL),
      standKey: cellKey(leg.target),
      routeSig: enterRouteSig(reoffered),
      nowMs: NOW,
    })
  return {
    pass:
      afterSpent.candidates.every((candidate) => candidate.kind !== 'ENTER_PORTAL') &&
      afterSpent.refusal === null &&
      legIsNewCell &&
      leg?.kind === 'MOVE' &&
      leg.target.x === closer.x &&
      reoffered !== undefined &&
      !blockedAtNewStand,
    detail: `afterSpent=[${afterSpent.candidates.map((candidate) => candidate.id).join(',')}] legIsNewCell=${legIsNewCell} reoffered=${reoffered?.id ?? 'none'} blockedAtNewStand=${blockedAtNewStand}`,
  }
})

addCase("(b') a DIFFERENT grounded plan from the same stand cell is a route change, not a repeat (no over-suppression)", () => {
  const sig = 'ENTER_PORTAL:staircase-up:W:54->67:dig=9,55,24:step=9,55,24:pillar=0:fallback=none'
  const routes = ledgerFor('ENTER_PORTAL', PORTAL_ENTER_CELL, PORTAL_BODY, sig)
  const identical = isZeroProgressRouteRepeat(routes, {
    kind: 'ENTER_PORTAL',
    targetKey: cellKey(PORTAL_ENTER_CELL),
    standKey: cellKey(PORTAL_BODY),
    routeSig: sig,
    nowMs: NOW,
  })
  const samePlanDifferentSignature = routePlanSignature({
    kind: 'ENTER_PORTAL',
    id: 'ENTER:26,67,9',
    meta: { vertical: 'staircase-up', upDir: 'W', upDigX: 9, upDigY: 55, upDigZ: 24, upStepX: 9, upStepY: 55, upStepZ: 24, verticalFromY: 54, verticalToY: 67 },
  })
  const differentPlan = isZeroProgressRouteRepeat(routes, {
    kind: 'ENTER_PORTAL',
    targetKey: cellKey(PORTAL_ENTER_CELL),
    standKey: cellKey(PORTAL_BODY),
    routeSig: routePlanSignature({
      kind: 'ENTER_PORTAL',
      id: 'ENTER:26,67,9',
      meta: { vertical: 'pillar', verticalFromY: 54, verticalToY: 67, pillarSteps: 13 },
    }),
    nowMs: NOW,
  })
  const idOnlySignature = routeSignature({ kind: 'ENTER_PORTAL', id: 'ENTER:26,67,9', meta: {} })
  return {
    pass:
      identical &&
      !differentPlan &&
      samePlanDifferentSignature === sig &&
      samePlanDifferentSignature !== idOnlySignature,
    detail: `identical=${identical} differentPlan=${differentPlan} planSig=${samePlanDifferentSignature} idOnly=${idOnlySignature}`,
  }
})

// --- (c') a genuinely reachable entry is untouched --------------------------------

addCase("(c') with no memory the entry offer is unchanged, and a memory from another stand cell never suppresses it", () => {
  const state = portalWorld({ position: PORTAL_BODY, standable: [PORTAL_BODY] })
  const options = portalEntryOptions()
  const fresh = entryCandidates(state, options)
  const elsewhere = ledgerFor('ENTER_PORTAL', PORTAL_ENTER_CELL, { x: 11, y: 55, z: 25 }, 'ENTER_PORTAL:other')
  const stillOffered = entryCandidates(withRoutes(state, elsewhere), options)
  return {
    pass:
      fresh.candidates.length === 1 &&
      fresh.candidates[0]?.kind === 'ENTER_PORTAL' &&
      fresh.candidates[0]?.id === 'ENTER:26,67,9' &&
      fresh.candidates[0]?.target?.x === PORTAL_ENTER_CELL.x &&
      fresh.refusal === null &&
      stillOffered.candidates.length === 1 &&
      stillOffered.candidates[0]?.kind === 'ENTER_PORTAL' &&
      stillOffered.refusal === null,
    detail: `fresh=[${fresh.candidates.map((candidate) => candidate.id).join(',')}] otherStand=[${stillOffered.candidates.map((candidate) => candidate.id).join(',')}]`,
  }
})

// --- (d') the same bounded rule for a non-portal route kind -----------------------

addCase("(d') a RETRIEVE with a path-stage failure obeys the identical rule (no portal knowledge)", () => {
  const feet = { x: 10, y: 21, z: 20 }
  const standable = [{ x: 10, y: 21, z: 20 }, { x: 12, y: 21, z: 20 }]
  const base = worldState({ position: feet, standable, signals: signals({ knownResources: [ORE_ABOVE] }) })
  const retrieve = generateGroundedCandidates(base).candidates.find(
    (candidate) => candidate.id === 'RETRIEVE:known:raw_iron:b24_22_11',
  )
  if (retrieve === undefined) return { pass: false, detail: 'no retrieval candidate' }
  const stage = routeFailureStage('path_stuck')
  const decision = observeZeroProgressRoute(undefined, {
    kind: 'RETRIEVE',
    targetKey: cellKey(ORE_ABOVE.position),
    standKey: cellKey(feet),
    routeSig: routeSignature({ kind: retrieve.kind, id: retrieve.id, meta: retrieve.meta }),
    reason: 'path_stuck',
    nowMs: NOW,
  })
  const afterSpent = generateGroundedCandidates(
    worldState({ position: feet, standable, signals: signals({ knownResources: [ORE_ABOVE], zeroProgressRoutes: decision.routes }) }),
  )
  const stillOffered = afterSpent.candidates.some((candidate) => candidate.id === retrieve.id)
  const leg = afterSpent.candidates.find((candidate) => candidate.meta.approachLeg === 'target_not_observable')
  return {
    pass: stage === 'path' && decision.routeSpentNow && !stillOffered && leg !== undefined && leg.kind === 'MOVE',
    detail: `stage=${stage} spentNow=${decision.routeSpentNow} stillOffered=${stillOffered} leg=${leg?.id ?? 'none'}`,
  }
})

// --- controller wiring (the markers must be reachable from the live loop) ---------

addCase('the live controller records the verdict and emits the typed markers', () => {
  const source =
    readFileSync(new URL('./src/controller.ts', import.meta.url), 'utf8') +
    readFileSync(new URL('./src/outcome-accounting.ts', import.meta.url), 'utf8') +
    readFileSync(new URL('./src/outcome-ledgers.ts', import.meta.url), 'utf8') +
    readFileSync(new URL('./src/escalation.ts', import.meta.url), 'utf8') +
    readFileSync(new URL('./src/candidate-diagnostics.ts', import.meta.url), 'utf8')
  const diagSource = readFileSync(new URL('./src/candidate-diagnostics.ts', import.meta.url), 'utf8')
  const portalSource = readFileSync(new URL('./src/portal-evidence.ts', import.meta.url), 'utf8')
  const candidatesSource = readFileSync(new URL('./src/candidates.ts', import.meta.url), 'utf8')
  const facade = readFileSync(new URL('./src/controller.ts', import.meta.url), 'utf8')
  const routeSource = readFileSync(new URL('./src/zeroProgressRoute.ts', import.meta.url), 'utf8')
  const checks: Array<[string, boolean]> = [
    ['recordZeroProgressOutcome call', /host\.recordZeroProgressOutcome\(result, candidate, truth\)/.test(source)],
    ['zero-progress verdict', /if \(!isZeroProgressOutcome\(result\)\) return/.test(source)],
    ['path-stage verdict', /routeFailureStage\(result\.failure\)/.test(source)],
    ['ACTION_ZERO_PROGRESS', /formatActionZeroProgress\(\{/.test(source)],
    ['DESCEND_RETIRED', /formatDescendRetired\('zero_progress_exhausted'/.test(source)],
    ['RETRIEVE_RETIRED', /formatRetrieveRetired\('zero_progress_budget'/.test(source)],
    ['RETRIEVE_ROUTE_BLOCKED', /formatRetrieveRouteBlocked\('zero_progress_route_unchanged'/.test(source)],
    ['APPROACH_LEG', /formatApproachLeg\(reason, target\)/.test(diagSource)],
    ['ROUTE_STAGE_FAILED marker', /formatRouteStageFailed\(\{/.test(source)],
    ['ROUTE_SPENT marker', /formatRouteSpent\(result\.kind/.test(source)],
    ['ROUTE_ESCALATE handling', /this\.noteRouteExhaustion\(grounded\.entryRefusal\)/.test(source)],
    ['route_exhausted escalation', /host\.escalate\('route_exhausted', refusal\.line\)/.test(portalSource)],
    ['typed escalation reason', /route_exhausted: 'action_impossible'/.test(source)],
    // The route markers must be MIRRORED, or the resident log shows an unchanged
    // failing route and zero spent-route evidence (the run-muc620xb measurement).
    ['ROUTE_STAGE_FAILED mirrored', /const MIRRORED_MARKERS[\s\S]*?'ROUTE_STAGE_FAILED'/.test(source)],
    ['ROUTE_SPENT mirrored', /const MIRRORED_MARKERS[\s\S]*?'ROUTE_SPENT'/.test(source)],
    ['ROUTE_ESCALATE mirrored', /const MIRRORED_MARKERS[\s\S]*?'ROUTE_ESCALATE'/.test(source)],
    ['ACTION_ZERO_PROGRESS mirrored', /const MIRRORED_MARKERS[\s\S]*?'ACTION_ZERO_PROGRESS'/.test(source)],
    ['publishes the ledger', /this\.signals\.zeroProgressRoutes = this\.zeroProgressRoutes/.test(source)],
    ['publishes the retire set', /this\.signals\.retiredKnownRetrieveTargets = this\.retiredKnownRetrieveTargets/.test(source)],
    ['cross-stand retrieve counter', /knownRetrieveFailures\?\.set\(retireKey/.test(source)],
    ['retrieve retire gate', /retiredKnownRetrieveTargets\?\.has\(/.test(candidatesSource)],
    ['descend family gate', /standFamilyExhausted\(state\.signals\.zeroProgressRoutes, 'DESCEND'/.test(candidatesSource)],
    ['retrieve repeat gate', /isZeroProgressRouteRepeat\(state\.signals\.zeroProgressRoutes/.test(candidatesSource)],
    ['entry repeat gate', /kind: 'ENTER_PORTAL',\s*\n\s*targetKey,\s*\n\s*standKey,/.test(candidatesSource)],
    ['step repeat gate', /kind: 'STEP',\s*\n\s*targetKey: cellKey\(cut\.cut\),/.test(candidatesSource)],
    ['grounded plan signature', /return routePlanSignature\(candidate\)/.test(routeSource)],
    // A STRUCTURAL route boundary must reach System2 with real Jev: it may not be
    // silently swallowed by the #11 facade's local policy-signal quarantine.
    ['route_exhausted is structural', !/LOCAL_POLICY_ESCALATIONS = new Set\(\[[\s\S]*?'route_exhausted'/.test(facade)],
  ]
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name)
  return { pass: failed.length === 0, detail: failed.length === 0 ? 'all markers wired' : `missing: ${failed.join(', ')}` }
})

addCase('the typed route markers are stable and greppable', () => {
  const stage = formatRouteStageFailed({
    kind: 'ENTER_PORTAL',
    target: { x: 26, y: 67, z: 9 },
    stand: { x: 10.6, y: 54, z: 25.4 },
    stage: 'path',
    failure: 'path_no_path',
  })
  const spent = formatRouteSpent('ENTER_PORTAL', { x: 26, y: 67, z: 9 }, 1)
  const escalate = formatRouteEscalate('g-portal-entered', ROUTE_ALL_SPENT_REASON, 2)
  return {
    pass:
      stage === 'ROUTE_STAGE_FAILED kind=ENTER_PORTAL target=26,67,9 stand=10,54,25 stage=path failure=path_no_path' &&
      spent === 'ROUTE_SPENT kind=ENTER_PORTAL target=26,67,9 attempts=1' &&
      escalate === 'ROUTE_ESCALATE goal=g-portal-entered reason=all_routes_spent routes=2',
    detail: `${stage} | ${spent} | ${escalate}`,
  }
})

// --- runner ----------------------------------------------------------------------

let failed = 0
for (const testCase of cases) {
  let result: { pass: boolean; detail: string }
  try {
    result = testCase.run()
  } catch (error) {
    result = { pass: false, detail: `threw: ${String(error)}` }
  }
  if (!result.pass) failed += 1
  console.log(`${result.pass ? 'ok  ' : 'FAIL'} ${testCase.name}${result.pass ? '' : ` :: ${result.detail}`}`)
}
console.log('------------------------------------------------------------------------')
console.log(`${cases.length - failed}/${cases.length} zero-progress-route cases passed`)
if (failed > 0) process.exit(1)
