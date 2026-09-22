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
import { defaultCandidateOptions, descendPrimaryCell, generateCandidates, generateGroundedCandidates } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { AgentSignals, DescentOption, GoalState, InventoryState, KnownResource, SelfState, Vec3Json, WorldState } from './src/state.ts'
import {
  cellKey,
  clearZeroProgressStand,
  clearZeroProgressTarget,
  formatActionZeroProgress,
  formatApproachLeg,
  formatDescendRetired,
  formatRetrieveRetired,
  isZeroProgressRouteRepeat,
  observeZeroProgressRoute,
  routeSignature,
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
  const primary = descendPrimaryCell(east)
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

// --- controller wiring (the markers must be reachable from the live loop) ---------

addCase('the live controller records the verdict and emits the typed markers', () => {
  const source = readFileSync(new URL('./src/controller-legacy.ts', import.meta.url), 'utf8')
  const candidatesSource = readFileSync(new URL('./src/candidates.ts', import.meta.url), 'utf8')
  const checks: Array<[string, boolean]> = [
    ['recordZeroProgressOutcome call', /this\.recordZeroProgressOutcome\(result, candidate, truth\)/.test(source)],
    ['zero-progress verdict', /if \(!isZeroProgressOutcome\(result\)\) return/.test(source)],
    ['ACTION_ZERO_PROGRESS', /formatActionZeroProgress\(\{/.test(source)],
    ['DESCEND_RETIRED', /formatDescendRetired\('zero_progress_exhausted'/.test(source)],
    ['RETRIEVE_RETIRED', /formatRetrieveRetired\('zero_progress_budget'/.test(source)],
    ['RETRIEVE_ROUTE_BLOCKED', /formatRetrieveRouteBlocked\('zero_progress_route_unchanged'/.test(source)],
    ['APPROACH_LEG', /formatApproachLeg\(reason, target\)/.test(source)],
    ['publishes the ledger', /this\.signals\.zeroProgressRoutes = this\.zeroProgressRoutes/.test(source)],
    ['descend family gate', /standFamilyExhausted\(state\.signals\.zeroProgressRoutes, 'DESCEND'/.test(candidatesSource)],
    ['retrieve repeat gate', /isZeroProgressRouteRepeat\(state\.signals\.zeroProgressRoutes/.test(candidatesSource)],
  ]
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name)
  return { pass: failed.length === 0, detail: failed.length === 0 ? 'all markers wired' : `missing: ${failed.join(', ')}` }
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
