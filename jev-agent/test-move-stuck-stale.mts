// test-move-stuck-stale.mts - live MOVE-stuck + stale/unreachable-target regression.
//
// Two independent live defects (run-mu87g5zq-r2fv, 2026-09-19):
//
//   A. A ~1-block MOVE at (29,58,35) never escaped. The stock pathfinder reported
//      `outcome=stuck`, control-walk refused (no jump headroom in the pocket) and
//      the packet stepper wrote a transient client pose (28.9,58,35.96) that the
//      server snapped back to (28.7,59,36.11). The loose `after <= 1.0` arrival
//      check plus the anchor-null recovery (`after <= 1.5`) reported
//      `verified=true status=done`, the controller reset the move-failure memory,
//      and the exact same MOVE retried forever.
//
//   B. A remembered log at y=68 cannot be reached from y=59 with canDig=false.
//      It is PRESENT, so the durable staleness proof (absent/replaced cells) never
//      retires it; the retrieval-stall timer resets on every candidate id change,
//      so the collect-log plan loops through the same unreachable list.
//
//   npm run move-stuck-stale-test
import type { Candidate } from './src/candidates.ts'
import { defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import { filterKnownResources, shouldRetireKnownRetrieve } from './src/controller.ts'
import { classifyMoveArrival } from './src/executor.ts'
import type { MoveArrivalInput } from './src/executor.ts'
import { filterBlacklistedMoves, MoveFailMemory } from './src/moveFailMemory.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { AgentSignals, GoalState, InventoryState, KnownResource, SelfState, Vec3Json, WorldState } from './src/state.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const OVERWORLD = 'overworld'

/** Live bot pose and MOVE target from the stall (10:06:41Z). */
const LIVE_START: Vec3Json = { x: 28.69810244577201, y: 59, z: 36.1106814812498 }
const LIVE_END: Vec3Json = { x: 28.89699481552186, y: 58, z: 35.95921589025538 }
const LIVE_TARGET: Vec3Json = { x: 29, y: 58, z: 35 }

/**
 * The pre-fix arrival formula, reproduced verbatim from `runMove`. It is kept
 * here so the regression documents exactly which decision was wrong.
 */
function legacyMoveVerified(input: MoveArrivalInput): boolean {
  const after = input.anchorDistance
  const anchorNowInReach = input.anchor === null ? after <= 1.5 : after <= input.reach
  const anchorWasInReach = input.anchorBefore !== null && input.anchorBefore <= input.reach
  const atTarget = !input.pinned && after <= 1.0 && Math.abs(input.end.y - input.target.y) <= 0.75
  return atTarget || (anchorNowInReach && !anchorWasInReach)
}

function liveArrival(): MoveArrivalInput {
  const after = Math.hypot(LIVE_END.x - LIVE_TARGET.x, LIVE_END.y - LIVE_TARGET.y, LIVE_END.z - LIVE_TARGET.z)
  return {
    end: LIVE_END,
    target: LIVE_TARGET,
    anchor: null,
    anchorBefore: null,
    anchorDistance: after,
    reach: 5,
    pinned: false,
  }
}

addCase('a transient client pose next to a stuck MOVE is NOT a verified arrival', () => {
  const input = liveArrival()
  const legacy = legacyMoveVerified(input)
  const fixed = classifyMoveArrival(input)
  const pass = legacy === true && fixed.verified === false && fixed.atTarget === false && fixed.anchorNowInReach === false
  return {
    pass,
    detail: `legacyVerified=${legacy} fixedVerified=${fixed.verified} atTarget=${fixed.atTarget} anchorNowInReach=${fixed.anchorNowInReach} end=(${LIVE_END.x.toFixed(2)},${LIVE_END.y},${LIVE_END.z.toFixed(2)}) target=(${LIVE_TARGET.x},${LIVE_TARGET.y},${LIVE_TARGET.z})`,
  }
})

addCase('a MOVE whose feet occupy the target cell verifies', () => {
  const result = classifyMoveArrival({
    end: { x: 29.3, y: 58, z: 35.4 },
    target: LIVE_TARGET,
    anchor: null,
    anchorBefore: null,
    anchorDistance: 0.5,
    reach: 5,
    pinned: false,
  })
  return { pass: result.verified && result.atTarget, detail: `verified=${result.verified} atTarget=${result.atTarget}` }
})

addCase('an anchored block crossing from out-of-reach into reach still verifies', () => {
  const result = classifyMoveArrival({
    end: { x: 28.4, y: 58, z: 36.4 },
    target: LIVE_TARGET,
    anchor: { x: 29, y: 68, z: 35 },
    anchorBefore: 12,
    anchorDistance: 4,
    reach: 5,
    pinned: false,
  })
  const already = classifyMoveArrival({
    end: { x: 28.4, y: 58, z: 36.4 },
    target: LIVE_TARGET,
    anchor: { x: 29, y: 68, z: 35 },
    anchorBefore: 3,
    anchorDistance: 2.5,
    reach: 5,
    pinned: false,
  })
  return {
    pass: result.verified && result.anchorNowInReach && !already.verified,
    detail: `crossed=${result.verified} alreadyInReach=${already.verified}`,
  }
})

addCase('a pinned stuck MOVE is never an arrival even inside the target cell', () => {
  const result = classifyMoveArrival({
    end: { x: 29.2, y: 58, z: 35.2 },
    target: LIVE_TARGET,
    anchor: null,
    anchorBefore: null,
    anchorDistance: 0.3,
    reach: 5,
    pinned: true,
  })
  return { pass: !result.verified, detail: `verified=${result.verified} atTarget=${result.atTarget}` }
})

addCase('the live stuck MOVE coordinate is retired after MOVE_FAILMEM_LIMIT failures', () => {
  let clock = 1_000
  const memory = new MoveFailMemory({ failureLimit: 3, cooldownMs: 30_000, maxEntries: 16, now: () => clock })
  const candidate: Candidate = {
    id: 'MOVE:p29_58_35',
    kind: 'MOVE',
    label: 'stuck short move',
    targetName: null,
    target: LIVE_TARGET,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 1 },
  }
  let blacklistedOnCycle = -1
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    // The fixed executor reports no arrival, so the controller charges the memory.
    const verified = classifyMoveArrival(liveArrival()).verified
    if (verified) memory.reset(OVERWORLD, LIVE_TARGET)
    else memory.record(OVERWORLD, LIVE_TARGET, 'stuck')
    if (blacklistedOnCycle < 0 && memory.check(OVERWORLD, LIVE_TARGET).blacklisted) blacklistedOnCycle = cycle
  }
  const filtered = filterBlacklistedMoves([candidate], memory, OVERWORLD)
  const check = memory.check(OVERWORLD, LIVE_TARGET)
  const pass =
    blacklistedOnCycle === 3 &&
    check.blacklisted &&
    filtered.kept.length === 0 &&
    filtered.skipped.length === 1
  return {
    pass,
    detail: `blacklistedOn=${blacklistedOnCycle} attempts=${check.attempts} kept=${filtered.kept.length} skipped=${filtered.skipped.length}`,
  }
})

addCase('a verified arrival resets the failure counter so the coordinate stays selectable', () => {
  const memory = new MoveFailMemory({ failureLimit: 3, cooldownMs: 30_000, maxEntries: 16, now: () => 1_000 })
  memory.record(OVERWORLD, LIVE_TARGET, 'stuck')
  memory.record(OVERWORLD, LIVE_TARGET, 'stuck')
  const beforeReset = memory.check(OVERWORLD, LIVE_TARGET)
  memory.reset(OVERWORLD, LIVE_TARGET)
  const afterReset = memory.check(OVERWORLD, LIVE_TARGET)
  return { pass: beforeReset.attempts === 2 && !afterReset.known, detail: `attempts=${beforeReset.attempts} afterResetKnown=${afterReset.known}` }
})

addCase('a present-but-unreachable known resource is retired after a bounded number of zero-progress retrieves', () => {
  const base = { retrieval: 'known', target: { x: 26, y: 68, z: 26 }, verified: false }
  const first = shouldRetireKnownRetrieve({ ...base, attempts: 1 })
  const second = shouldRetireKnownRetrieve({ ...base, attempts: 2 })
  const verified = shouldRetireKnownRetrieve({ ...base, verified: true, attempts: 5 })
  const surface = shouldRetireKnownRetrieve({ ...base, retrieval: 'surface', attempts: 5 })
  const noTarget = shouldRetireKnownRetrieve({ ...base, target: null, attempts: 5 })
  return {
    pass: !first && second && !verified && !surface && !noTarget,
    detail: `attempt1=${first} attempt2=${second} verified=${verified} surface=${surface} noTarget=${noTarget}`,
  }
})

// --- (b) end-to-end: retiring the resource advances the collect-log plan -----
function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_TEST',
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

function inventory(): InventoryState {
  return { slots: [], counts: {}, totalItems: 0 }
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

function goal(): GoalState {
  return {
    id: 'collect:oak_log',
    description: 'collect 1 x oak_log',
    targetItem: 'oak_log',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(): QueuedGoal {
  return {
    id: 'g1:collect:oak_log',
    kind: 'collect',
    description: 'collect 1 x oak_log',
    targetItem: 'oak_log',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function queueWith(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

const KNOWN_LOG: KnownResource = { name: 'birch_log', kind: 'log', position: { x: 26, y: 68, z: 26 } }
/** A second remembered log at the bot's own level, so the plan CAN advance to it. */
const REACHABLE_LOG: KnownResource = { name: 'oak_log', kind: 'log', position: { x: 45, y: 59, z: 36 } }
const UNREACHABLE_ID = 'RETRIEVE:known:oak_log:b26_68_26'
const REACHABLE_ID = 'RETRIEVE:known:oak_log:b45_59_36'

function unreachableLogWorld(known: KnownResource[]): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(LIVE_START),
    inventory: inventory(),
    entities: [],
    blocks: [],
    terrain: { standable: [{ x: 28, y: 59, z: 36 }] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goal(),
    goalQueue: queueWith(queuedGoal()),
    recentEvents: [],
    signals: signals({ knownResources: known }),
  }
}

function offeredKnownRetrieveIds(known: KnownResource[]): { offered: string[]; withheld: string[]; reachability: string[] } {
  const grounded = generateGroundedCandidates(unreachableLogWorld(known), defaultCandidateOptions)
  const knownOnly = (ids: readonly string[]): string[] => ids.filter((id) => id.startsWith('RETRIEVE:known:'))
  return {
    offered: knownOnly(grounded.candidates.map((candidate) => candidate.id)),
    withheld: knownOnly(grounded.withheld.map((entry) => entry.candidate.id)),
    reachability: knownOnly(grounded.reachability.map((entry) => entry.candidate.id)),
  }
}

addCase('retiring an unreachable known resource removes its RETRIEVE and advances the plan', () => {
  const before = offeredKnownRetrieveIds([KNOWN_LOG, REACHABLE_LOG])
  const beforeHasUnreachable =
    before.offered.includes(UNREACHABLE_ID) ||
    before.withheld.includes(UNREACHABLE_ID) ||
    before.reachability.includes(UNREACHABLE_ID)
  const retiredKey = `${KNOWN_LOG.name}@${KNOWN_LOG.position.x},${KNOWN_LOG.position.y},${KNOWN_LOG.position.z}`
  const afterResources = filterKnownResources([KNOWN_LOG, REACHABLE_LOG], new Set([retiredKey]))
  const after = offeredKnownRetrieveIds(afterResources)
  const afterHasUnreachable =
    after.offered.includes(UNREACHABLE_ID) ||
    after.withheld.includes(UNREACHABLE_ID) ||
    after.reachability.includes(UNREACHABLE_ID)
  const afterOffersReachable = after.offered.includes(REACHABLE_ID)
  const pass = beforeHasUnreachable && afterResources.length === 1 && !afterHasUnreachable && afterOffersReachable
  return {
    pass,
    detail: `beforeOffered=[${before.offered.join(',')}] beforeWithheld=[${before.withheld.join(',')}] afterOffered=[${after.offered.join(',')}] afterResources=${afterResources.length} unreachableAfter=${afterHasUnreachable}`,
  }
})

let failures = 0
process.stdout.write('MOVE-stuck + stale/unreachable known-resource retirement\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} move-stuck-stale cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
