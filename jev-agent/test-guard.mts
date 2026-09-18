// test-guard.mts - unit-style proof that the deterministic guard rejects
// mechanically-bad candidates without any Jev call and without a live bot.
//
// Run: npm run guard-test
import type { Candidate } from './src/candidates.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import { guardCandidate, guardDecision } from './src/policy.ts'
import type { GuardCode, GuardContext } from './src/policy.ts'
import type { BlockState, InventoryState, SelfState, Vec3Json, WorldState } from './src/state.ts'

const IN_REACH_LOG: Vec3Json = { x: 1, y: 64, z: 0 }
const FAR_LOG: Vec3Json = { x: 1, y: 64, z: 40 }

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_Bot',
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

function emptyInventory(): InventoryState {
  return { slots: [], counts: {}, totalItems: 0 }
}

function logBlock(position: Vec3Json, distance: number, inReach: boolean, hasAdjacentStandable: boolean): BlockState {
  return {
    kind: 'log',
    name: 'oak_log',
    position,
    distance,
    diggable: true,
    inReach,
    hasAdjacentStandable,
    adjacentStandable: hasAdjacentStandable ? { x: position.x + 1, y: position.y, z: position.z } : null,
    yield: 'oak_log',
    harvestTool: 'axe',
  }
}

function state(overrides: {
  self: Vec3Json
  blocks: BlockState[]
  inventory?: InventoryState
  tick?: number
  standable?: Vec3Json[]
}): WorldState {
  return {
    schemaVersion: 1,
    tick: overrides.tick ?? 5,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.self),
    inventory: overrides.inventory ?? emptyInventory(),
    entities: [],
    blocks: overrides.blocks,
    terrain: { standable: overrides.standable ?? [{ x: overrides.self.x, y: overrides.self.y, z: overrides.self.z }] },
    craftingTables: [],
    placementSpots: [],
    goal: {
      id: 'chop:oak_log',
      description: 'collect 1 x oak_log',
      targetItem: 'oak_log',
      requiredCount: 1,
      startCount: 0,
      haveCount: 0,
      progress: 0,
      complete: false,
      startedAtMs: 0,
    },
    goalQueue: emptyGoalQueueState(),
    recentEvents: [],
    signals: {
      consecutiveFailures: 0,
      lastFailureCode: null,
      lastPathStatus: 'idle',
      stalledMs: 0,
      lastPolicyConfidence: null,
      maxConcurrentActions: 0,
      escalationRecommended: false,
      failedCandidates: {},
    },
  }
}

function candidate(overrides: Partial<Candidate> & { id: string; kind: Candidate['kind'] }): Candidate {
  return {
    label: 'test candidate',
    targetName: null,
    target: null,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: false,
    meta: { tick: 5 },
    ...overrides,
  }
}

function context(overrides: Partial<GuardContext> = {}): GuardContext {
  return {
    phase: 'decision',
    candidateIds: new Set<string>(),
    inFlight: null,
    reach: 4.5,
    maxCandidateAgeTicks: 10,
    ...overrides,
  }
}

interface Case {
  name: string
  run: () => { code: GuardCode | null; reason: string }
}

const cases: Case[] = []

function addCase(name: string, run: Case['run']): void {
  cases.push({ name, run })
}

// --- POSITIVE: a log within reach, walkable access, empty hand but no tool required
addCase('accepts an in-reach oak_log', () => {
  const fixture = state({ self: { x: 0, y: 64, z: 0 }, blocks: [logBlock(IN_REACH_LOG, 1.9, true, true)] })
  const chunk = candidate({
    id: 'MINE:b1_64_0',
    kind: 'MINE',
    targetName: 'oak_log',
    target: IN_REACH_LOG,
    inReach: true,
    hasStandableAdjacent: true,
  })
  const result = guardCandidate(chunk, fixture, context({ candidateIds: new Set([chunk.id]) }))
  return result.ok ? { code: null, reason: 'accepted' } : { code: result.code, reason: result.reason }
})

// --- OUT_OF_REACH: same block, but the bot stands 40 blocks away at dig time
addCase('rejects OUT_OF_REACH at dig time', () => {
  const fixture = state({
    self: { x: 0, y: 64, z: 0 },
    blocks: [logBlock(FAR_LOG, 40, false, true)],
    standable: [
      { x: 0, y: 64, z: 0 },
      { x: 2, y: 64, z: 40 },
    ],
  })
  const chunk = candidate({
    id: 'MINE:b1_64_40',
    kind: 'MINE',
    targetName: 'oak_log',
    target: FAR_LOG,
    inReach: false,
    hasStandableAdjacent: true,
  })
  const result = guardCandidate(
    chunk,
    fixture,
    context({ phase: 'dig', candidateIds: new Set([chunk.id]), reach: 4.5 }),
  )
  return result.ok ? { code: null, reason: 'accepted' } : { code: result.code, reason: result.reason }
})

// --- EMPTY_HAND: a block that needs a pickaxe while the inventory is empty
addCase('rejects EMPTY_HAND when the tool is missing', () => {
  const stone: Vec3Json = { x: 1, y: 64, z: 0 }
  const fixture = state({
    self: { x: 0, y: 64, z: 0 },
    blocks: [{ ...logBlock(IN_REACH_LOG, 1.9, true, true), name: 'stone' }],
  })
  const chunk = candidate({
    id: 'MINE:b1_64_0',
    kind: 'MINE',
    targetName: 'stone',
    target: stone,
    inReach: true,
    hasStandableAdjacent: true,
    requiresTool: true,
    toolName: 'pickaxe',
  })
  const result = guardCandidate(chunk, fixture, context({ candidateIds: new Set([chunk.id]) }))
  return result.ok ? { code: null, reason: 'accepted' } : { code: result.code, reason: result.reason }
})

// --- UNKNOWN_CANDIDATE: the model invented an id that was never generated
addCase('rejects UNKNOWN_CANDIDATE (hallucinated id)', () => {
  const fixture = state({ self: { x: 0, y: 64, z: 0 }, blocks: [logBlock(IN_REACH_LOG, 1.9, true, true)] })
  const chunk = candidate({
    id: 'MINE:b1_64_0',
    kind: 'MINE',
    targetName: 'oak_log',
    target: IN_REACH_LOG,
    inReach: true,
    hasStandableAdjacent: true,
  })
  const result = guardDecision('MINE:b999_64_9', [chunk], fixture, context({ candidateIds: new Set([chunk.id]) }))
  return result.ok ? { code: null, reason: 'accepted' } : { code: result.code, reason: result.reason }
})

// --- TARGET_GONE: the block vanished from the world state between ticks
addCase('rejects TARGET_GONE when the block is no longer in the state', () => {
  const fixture = state({ self: { x: 0, y: 64, z: 0 }, blocks: [] })
  const chunk = candidate({
    id: 'MINE:b1_64_0',
    kind: 'MINE',
    targetName: 'oak_log',
    target: IN_REACH_LOG,
    inReach: true,
    hasStandableAdjacent: true,
  })
  const result = guardCandidate(chunk, fixture, context({ candidateIds: new Set([chunk.id]) }))
  return result.ok ? { code: null, reason: 'accepted' } : { code: result.code, reason: result.reason }
})

// --- STALE_COORDS: the candidate was generated many ticks ago
addCase('rejects STALE_COORDS for an old candidate', () => {
  const fixture = state({ self: { x: 0, y: 64, z: 0 }, blocks: [logBlock(IN_REACH_LOG, 1.9, true, true)], tick: 90 })
  const chunk = candidate({
    id: 'MINE:b1_64_0',
    kind: 'MINE',
    targetName: 'oak_log',
    target: IN_REACH_LOG,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 5 },
  })
  const result = guardCandidate(chunk, fixture, context({ candidateIds: new Set([chunk.id]), maxCandidateAgeTicks: 10 }))
  return result.ok ? { code: null, reason: 'accepted' } : { code: result.code, reason: result.reason }
})

// --- NO_SUPPORT: reachable in principle, but no walkable spot and canDig=false
addCase('rejects NO_SUPPORT when there is no walk-up access', () => {
  const fixture = state({
    self: { x: 0, y: 64, z: 0 },
    blocks: [logBlock(FAR_LOG, 40, false, false)],
  })
  const chunk = candidate({
    id: 'MINE:b1_64_40',
    kind: 'MINE',
    targetName: 'oak_log',
    target: FAR_LOG,
    inReach: false,
    hasStandableAdjacent: false,
  })
  const result = guardCandidate(chunk, fixture, context({ candidateIds: new Set([chunk.id]) }))
  return result.ok ? { code: null, reason: 'accepted' } : { code: result.code, reason: result.reason }
})

// --- LAVA_RISK: the target block touches lava
addCase('rejects LAVA_RISK when lava is adjacent', () => {
  const fixture = state({
    self: { x: 0, y: 64, z: 0 },
    blocks: [
      logBlock(IN_REACH_LOG, 1.9, true, true),
      {
        kind: 'hazard',
        name: 'lava',
        position: { x: 2, y: 64, z: 0 },
        distance: 2,
        diggable: false,
        inReach: false,
        hasAdjacentStandable: false,
        adjacentStandable: null,
        yield: null,
        harvestTool: null,
      },
    ],
  })
  const chunk = candidate({
    id: 'MINE:b1_64_0',
    kind: 'MINE',
    targetName: 'oak_log',
    target: IN_REACH_LOG,
    inReach: true,
    hasStandableAdjacent: true,
  })
  const result = guardCandidate(chunk, fixture, context({ candidateIds: new Set([chunk.id]) }))
  return result.ok ? { code: null, reason: 'accepted' } : { code: result.code, reason: result.reason }
})

// --- CONFLICT_IN_FLIGHT: a second dig while one is already owned
addCase('rejects CONFLICT_IN_FLIGHT while another mine is running', () => {
  const fixture = state({ self: { x: 0, y: 64, z: 0 }, blocks: [logBlock(IN_REACH_LOG, 1.9, true, true)] })
  const chunk = candidate({
    id: 'MINE:b1_64_0',
    kind: 'MINE',
    targetName: 'oak_log',
    target: IN_REACH_LOG,
    inReach: true,
    hasStandableAdjacent: true,
  })
  const result = guardCandidate(
    chunk,
    fixture,
    context({
      candidateIds: new Set([chunk.id]),
      inFlight: { id: 'MINE:b-1_64_0', kind: 'MINE' },
    }),
  )
  return result.ok ? { code: null, reason: 'accepted' } : { code: result.code, reason: result.reason }
})

// --- MOVE to an out-of-reach log: accepted when the log and its walk-up spot exist
addCase('accepts a log-anchored MOVE to its walk-up spot', () => {
  const fixture = state({ self: { x: 0, y: 64, z: 0 }, blocks: [logBlock(FAR_LOG, 40, false, true)] })
  const chunk = candidate({
    id: 'MOVE:b1_64_40',
    kind: 'MOVE',
    targetName: 'oak_log',
    target: { x: 2, y: 64, z: 40 },
    inReach: false,
    hasStandableAdjacent: true,
    meta: { tick: 5, targetBlockX: 1, targetBlockY: 64, targetBlockZ: 40, targetBlockName: 'oak_log' },
  })
  const result = guardCandidate(chunk, fixture, context({ candidateIds: new Set([chunk.id]) }))
  return result.ok ? { code: null, reason: 'accepted' } : { code: result.code, reason: result.reason }
})

// A vertical-plan MOVE deliberately reaches its walk-up spot through the
// guarded pillar/staircase leg; a horizontal canDig=false path probe is not its
// complete execution contract and must not reject it before Executor.runMove.
addCase('accepts a vertical-plan MOVE when the horizontal path probe refuses', () => {
  const fixture = state({ self: { x: 0, y: 52, z: 0 }, blocks: [logBlock(FAR_LOG, 40, false, true)] })
  const chunk = candidate({
    id: 'MOVE:b1_64_40',
    kind: 'MOVE',
    targetName: 'oak_log',
    target: { x: 2, y: 64, z: 40 },
    inReach: false,
    hasStandableAdjacent: true,
    meta: {
      tick: 5,
      targetBlockX: 1,
      targetBlockY: 64,
      targetBlockZ: 40,
      targetBlockName: 'oak_log',
      vertical: 'pillar',
      pillarToY: 64,
      pillarSteps: 12,
      pillarPlaceName: 'cobblestone',
    },
  })
  const result = guardCandidate(
    chunk,
    fixture,
    context({ candidateIds: new Set([chunk.id]), canComputePath: () => false }),
  )
  return result.ok ? { code: null, reason: 'accepted vertical plan' } : { code: result.code, reason: result.reason }
})

// --- MOVE to a vanished log is rejected, so the executor never walks into nothing
addCase('rejects a log-anchored MOVE when the log is gone', () => {
  const fixture = state({ self: { x: 0, y: 64, z: 0 }, blocks: [] })
  const chunk = candidate({
    id: 'MOVE:b1_64_40',
    kind: 'MOVE',
    targetName: 'oak_log',
    target: { x: 2, y: 64, z: 40 },
    inReach: false,
    hasStandableAdjacent: true,
    meta: { tick: 5, targetBlockX: 1, targetBlockY: 64, targetBlockZ: 40, targetBlockName: 'oak_log' },
  })
  const result = guardCandidate(chunk, fixture, context({ candidateIds: new Set([chunk.id]) }))
  return result.ok ? { code: null, reason: 'accepted' } : { code: result.code, reason: result.reason }
})

// --- EAT with the item missing
addCase('rejects EAT when the food left the inventory', () => {
  const fixture = state({ self: { x: 0, y: 64, z: 0 }, blocks: [] })
  const chunk = candidate({ id: 'EAT:bread', kind: 'EAT', itemName: 'bread' })
  const result = guardCandidate(chunk, fixture, context({ candidateIds: new Set([chunk.id]) }))
  return result.ok ? { code: null, reason: 'accepted' } : { code: result.code, reason: result.reason }
})

const expected: Record<string, GuardCode | null> = {
  'accepts an in-reach oak_log': null,
  'rejects OUT_OF_REACH at dig time': 'OUT_OF_REACH',
  'rejects EMPTY_HAND when the tool is missing': 'EMPTY_HAND',
  'rejects UNKNOWN_CANDIDATE (hallucinated id)': 'UNKNOWN_CANDIDATE',
  'rejects TARGET_GONE when the block is no longer in the state': 'TARGET_GONE',
  'rejects STALE_COORDS for an old candidate': 'STALE_COORDS',
  'rejects NO_SUPPORT when there is no walk-up access': 'NO_SUPPORT',
  'rejects LAVA_RISK when lava is adjacent': 'LAVA_RISK',
  'rejects CONFLICT_IN_FLIGHT while another mine is running': 'CONFLICT_IN_FLIGHT',
  'accepts a log-anchored MOVE to its walk-up spot': null,
  'accepts a vertical-plan MOVE when the horizontal path probe refuses': null,
  'rejects a log-anchored MOVE when the log is gone': 'TARGET_GONE',
  'rejects EAT when the food left the inventory': 'EMPTY_HAND',
}

let failures = 0
process.stdout.write('deterministic guard - mechanical rejections\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  const want = expected[testCase.name] ?? null
  const pass = observed.code === want
  if (!pass) failures += 1
  const status = pass ? 'PASS' : 'FAIL'
  const code = observed.code ?? 'ACCEPTED'
  process.stdout.write(`${status}  ${testCase.name}\n`)
  process.stdout.write(`      expected=${want ?? 'ACCEPTED'} observed=${code}\n`)
  process.stdout.write(`      reason: ${observed.reason}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} guard cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
