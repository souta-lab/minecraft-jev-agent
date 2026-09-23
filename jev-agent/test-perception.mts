// test-perception.mts - station-perception truth suite.
//
// The measured defect: Jev's perceived state reported craftingTables=0 and
// furnaces=0 while durable, host-validated station memory held 14 tables and 3
// furnaces. `state.ts` only scanned stations at max(16, reach+8) with count 8,
// while station validation uses a 48-block radius, so every known station was
// invisible to the policy and candidate generation starved to WAIT.
//
// This suite locks the four fixes:
//   1. durable stations inside the validation radius are merged into the
//      perceived state as `source: 'remembered'`; sensed stations are
//      `source: 'sensed'` and stay authoritative;
//   2. in-reach-only predicates still refuse a remembered-but-not-sensed
//      station (a remembered coordinate never satisfies proximity);
//   3. a candidate set with zero productive candidates emits the
//      CANDIDATE_STARVATION marker (mirrored);
//   4. the jev-calls.jsonl perception snapshot is size-bounded.
//
// Run: bun test-perception.mts
import { readFileSync } from 'node:fs'
import { isHostileEntityName } from './src/state.ts'
import { createRequire } from 'node:module'
import {
  candidateStarvationLine,
  candidateStarvationMissing,
  formatCandidateStarvation,
  goalPreconditionCause,
  goalStarvationBlockedBy,
  MIRRORED_MARKERS,
} from './src/controller.ts'
import { defaultCandidateOptions, generateCandidates } from './src/candidates.ts'
import type { CandidateReachability } from './src/candidates.ts'
import { createRecipeIndex } from './src/crafting.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { PlannedGoal, QueuedGoal } from './src/goalQueue.ts'
import { makeOptionSnapshot } from './src/optionSpec.ts'
import { boundedStateSnapshot, JEV_SNAPSHOT_LIMITS } from './src/jev.ts'
import { buildWorldState, defaultSensorOptions, makeGoal } from './src/state.ts'
import type { AgentSignals, KnownResource, StationEntry, Vec3Json, WorldState } from './src/state.ts'

const require = createRequire(import.meta.url)
const Vec3 = require('vec3')

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

/** The station validation radius the host uses in buddy-driver/generation-entry.ts. */
const STATION_VALIDATION_RADIUS = 48

type Bot = Parameters<typeof buildWorldState>[0]

/** Live-sensor double: `sensed` maps block name -> block positions the scan can see. */
function fakeBot(sensed: Record<string, Vec3Json[]>): Bot {
  const position = new Vec3(29.12, 47.75, 34.19)
  const findBlocks = (options: {
    matching: (block: { name: string }) => boolean
    maxDistance: number
    count: number
  }): unknown[] => {
    const origin = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))
    const out: unknown[] = []
    for (const [name, positions] of Object.entries(sensed)) {
      if (!options.matching({ name })) continue
      for (const p of positions) {
        const block = new Vec3(p.x, p.y, p.z)
        if (block.distanceTo(origin) <= options.maxDistance) out.push(block)
      }
    }
    return out.slice(0, options.count)
  }
  return {
    username: 'AI_PERC',
    entity: { id: 1, position, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 20,
    food: 20,
    game: { gameMode: 'survival', dimension: 'overworld', minY: -64, height: 384 },
    time: { isDay: true },
    registry: null,
    entities: {},
    inventory: { items: () => [] },
    blockAt: () => null,
    canSeeBlock: () => true,
    findBlocks,
  } as never
}

/** Sensor double for the mechanical prerequisite scan. */
function fakeStonePrerequisiteBot(): Bot {
  const position = new Vec3(29.12, 47.75, 34.19)
  const blocks = new Map<string, { name: string; boundingBox: string; diggable: boolean }>([
    ['31,47,34', { name: 'stone', boundingBox: 'block', diggable: true }],
    ['30,46,34', { name: 'stone', boundingBox: 'block', diggable: true }],
    // This producer is in the same column below a buried stone cell. The
    // capability scan must retain it even though the exposed-column scan stops
    // at the buried cell.
    ['30,47,35', { name: 'andesite', boundingBox: 'block', diggable: true }],
  ])
  const key = (p: { x: number; y: number; z: number }): string => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
  const blockAt = (p: { x: number; y: number; z: number }) =>
    blocks.get(key(p)) ?? { name: 'air', boundingBox: 'empty', diggable: false }
  const findBlocks = (options: {
    matching: (block: { name: string }) => boolean
    maxDistance: number
    count: number
  }): unknown[] => {
    const origin = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))
    return [...blocks.entries()]
      .filter(([, block]) => options.matching(block))
      .map(([cell]) => {
        const [x, y, z] = cell.split(',').map(Number)
        return new Vec3(x, y, z)
      })
      .filter((block) => block.distanceTo(origin) <= options.maxDistance)
      .slice(0, options.count)
  }
  return {
    username: 'AI_PERC_STONE',
    entity: { id: 2, position, yaw: 0, pitch: 0, onGround: true },
    heldItem: null,
    health: 20,
    food: 20,
    game: { gameMode: 'survival', dimension: 'overworld', minY: -64, height: 384 },
    time: { isDay: true },
    registry: require('minecraft-data')('1.21.11'),
    entities: {},
    inventory: {
      items: () => [{ name: 'diamond_pickaxe', count: 1, slot: 0 }],
    },
    blockAt,
    canSeeBlock: () => true,
    findBlocks,
  } as never
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
    ...overrides,
  }
}

function craftGoal(item: string): QueuedGoal {
  return {
    id: `g-craft-${item}`,
    kind: 'craft',
    description: `craft 1 x ${item}`,
    targetItem: item,
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

const recipeIndex = createRecipeIndex(require('minecraft-data')('1.21.11'))
const craftOptions = { ...defaultCandidateOptions, recipes: recipeIndex }

function perceive(remembered: KnownResource[], sensed: Record<string, Vec3Json[]>): WorldState {
  return buildWorldState(
    fakeBot(sensed),
    {
      tick: 1,
      goal: makeGoal('furnace', 1),
      goalQueue: emptyGoalQueueState(),
      focusItem: 'furnace',
      recentEvents: [],
      signals: signals(),
      rememberedStations: remembered,
    },
    defaultSensorOptions,
  )
}

function withInventory(state: WorldState, counts: Record<string, number>): WorldState {
  return {
    ...state,
    inventory: {
      slots: Object.entries(counts).map(([name, count], slot) => ({ name, count, slot })),
      counts,
      totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0),
    },
  }
}

// --- (1) remembered stations are perceived; sensed stays authoritative ---------

addCase('(1) a validated remembered station inside the 48-block radius appears with source=remembered', () => {
  const remembered: KnownResource[] = [
    { name: 'crafting_table', kind: 'station', position: { x: 31, y: 63, z: 37 } },
    { name: 'furnace', kind: 'station', position: { x: 29, y: 61, z: 35 } },
  ]
  const state = perceive(remembered, { crafting_table: [], furnace: [] })
  const table = state.craftingTables.find((entry) => entry.x === 31 && entry.y === 63 && entry.z === 37)
  const furnace = (state.furnaces ?? []).find((entry) => entry.x === 29 && entry.y === 61 && entry.z === 35)
  const distance = Math.hypot(31 - 29.12, 63 - 47.75, 37 - 34.19)
  const pass =
    table?.source === 'remembered' &&
    furnace?.source === 'remembered' &&
    distance <= STATION_VALIDATION_RADIUS &&
    state.craftingTables.length === 1 &&
    (state.furnaces ?? []).length === 1
  return { pass, detail: `distance=${distance.toFixed(1)} tables=${JSON.stringify(state.craftingTables)} furnaces=${JSON.stringify(state.furnaces)}` }
})

addCase('(1) a sensed station within reach appears with source=sensed and beats the remembered duplicate', () => {
  const remembered: KnownResource[] = [
    { name: 'crafting_table', kind: 'station', position: { x: 30, y: 48, z: 34 } },
    { name: 'crafting_table', kind: 'station', position: { x: 31, y: 63, z: 37 } },
  ]
  const state = perceive(remembered, { crafting_table: [{ x: 30, y: 48, z: 34 }], furnace: [] })
  const sensed = state.craftingTables.find((entry) => entry.x === 30 && entry.y === 48 && entry.z === 34)
  const far = state.craftingTables.find((entry) => entry.x === 31 && entry.y === 63 && entry.z === 37)
  const duplicates = state.craftingTables.filter((entry) => entry.x === 30 && entry.y === 48 && entry.z === 34).length
  const eyeDistance = Math.hypot(30 - 29.12, 48 - 49.37, 34 - 34.19)
  const pass =
    sensed?.source === 'sensed' &&
    far?.source === 'remembered' &&
    duplicates === 1 &&
    state.craftingTables[0]?.source === 'sensed' &&
    eyeDistance <= defaultSensorOptions.reach
  return { pass, detail: `eyeDistance=${eyeDistance.toFixed(2)} tables=${JSON.stringify(state.craftingTables)}` }
})

addCase('(1) omitting rememberedStations falls back to signals.knownResources', () => {
  const remembered: KnownResource = { name: 'crafting_table', kind: 'station', position: { x: 31, y: 63, z: 37 } }
  const state = buildWorldState(
    fakeBot({ crafting_table: [], furnace: [] }),
    {
      tick: 1,
      goal: makeGoal('furnace', 1),
      goalQueue: emptyGoalQueueState(),
      focusItem: 'furnace',
      recentEvents: [],
      signals: signals({ knownResources: [remembered] }),
    },
    defaultSensorOptions,
  )
  const pass = state.craftingTables.some((entry) => entry.source === 'remembered' && entry.x === 31)
  return { pass, detail: JSON.stringify(state.craftingTables) }
})

addCase('(1) a missing placeable capability keeps a grounded stone producer in perception', () => {
  const state = buildWorldState(
    fakeStonePrerequisiteBot(),
    {
      tick: 1,
      goal: makeGoal('log', 1),
      goalQueue: emptyGoalQueueState(),
      focusItem: 'log',
      recentEvents: [],
      signals: signals(),
    },
    defaultSensorOptions,
  )
  const stones = state.blocks.filter((block) => block.kind === 'stone' && block.yield === 'cobblestone')
  const pass = stones.some((stone) => stone.position.x === 31 && stone.position.y === 47 && stone.position.z === 34)
  return { pass, detail: `stones=${JSON.stringify(stones)} blocks=${state.blocks.length}` }
})

addCase('(1) a near placeable producer below a buried column cell remains sensed', () => {
  const state = buildWorldState(
    fakeStonePrerequisiteBot(),
    {
      tick: 1,
      goal: makeGoal('log', 1),
      goalQueue: emptyGoalQueueState(),
      focusItem: 'log',
      recentEvents: [],
      signals: signals(),
    },
    defaultSensorOptions,
  )
  const producer = state.blocks.find(
    (block) => block.kind === 'stone' && block.name === 'andesite' && block.position.x === 30 && block.position.y === 47 && block.position.z === 35,
  )
  const pass = producer !== undefined && producer.inReach
  return { pass, detail: `producer=${JSON.stringify(producer ?? null)}` }
})

// --- (2) remembered coordinates never satisfy an in-reach predicate ------------

const rememberedInReach: StationEntry = { x: 29, y: 48, z: 34, source: 'remembered' }

addCase('(2) an in-reach remembered table never produces an in-place CRAFT candidate', () => {
  const base = perceive([], { crafting_table: [], furnace: [] })
  const state = withInventory(
    { ...base, goalQueue: { ...emptyGoalQueueState(), current: craftGoal('furnace') }, craftingTables: [rememberedInReach] },
    { cobblestone: 42 },
  )
  const candidates = generateCandidates(state, craftOptions)
  const crafts = candidates.filter((candidate) => candidate.kind === 'CRAFT')
  const retrieve = candidates.find((candidate) => candidate.id.startsWith('RETRIEVE:known:station:crafting_table'))
  const eyeDistance = Math.hypot(rememberedInReach.x - state.self.eyePosition.x, rememberedInReach.y - state.self.eyePosition.y, rememberedInReach.z - state.self.eyePosition.z)
  // OPERATOR RULE (station-use-before-craft): a remembered station the world model
  // holds is WALKED TO - it is never satisfied in place and never answered with a
  // duplicate craft, even when the projection is the only place it exists.
  const pass =
    eyeDistance <= defaultSensorOptions.reach &&
    crafts.length === 0 &&
    retrieve !== undefined &&
    retrieve.meta.tableSource === 'remembered'
  return { pass, detail: `eyeDistance=${eyeDistance.toFixed(2)} candidates=[${candidates.map((candidate) => candidate.id).join(',')}]` }
})

addCase('(2) the same remembered table routes to a RETRIEVE walk, never an in-place craft', () => {
  const remembered: KnownResource = { name: 'crafting_table', kind: 'station', position: { ...rememberedInReach } }
  const base = perceive([], { crafting_table: [], furnace: [] })
  const state = withInventory(
    {
      ...base,
      goalQueue: { ...emptyGoalQueueState(), current: craftGoal('furnace') },
      craftingTables: [rememberedInReach],
      signals: signals({ knownResources: [remembered] }),
    },
    { cobblestone: 42 },
  )
  const candidates = generateCandidates(state, craftOptions)
  const retrieve = candidates.find((candidate) => candidate.id.startsWith('RETRIEVE:known:station:crafting_table'))
  const crafts = candidates.filter((candidate) => candidate.kind === 'CRAFT')
  const pass =
    retrieve !== undefined &&
    retrieve.meta.tableSource === 'remembered' &&
    retrieve.target?.x === rememberedInReach.x &&
    retrieve.target.y === rememberedInReach.y &&
    retrieve.target.z === rememberedInReach.z &&
    crafts.length === 0
  return { pass, detail: `candidates=[${candidates.map((candidate) => candidate.id).join(',')}]` }
})

// --- (3) starvation is loud ----------------------------------------------------

addCase('(3) a 1-element candidate set emits the mirrored CANDIDATE_STARVATION marker', () => {
  const base = perceive([], { crafting_table: [], furnace: [] })
  const state = withInventory(
    { ...base, goalQueue: { ...emptyGoalQueueState(), current: craftGoal('furnace') } },
    { cobblestone: 42 },
  )
  const candidates = generateCandidates(state, craftOptions)
  const goal = 'craft:furnace:1'
  const blockedBy = goalStarvationBlockedBy(null, { kind: 'craft', targetItem: 'furnace' }, [])
  const line = candidateStarvationLine(candidates, goal, false, blockedBy)
  const expected = 'CANDIDATE_STARVATION presented=1 productive=0 goal="craft:furnace:1" blockedBy=no_productive_action'
  const pass =
    candidates.length === 1 &&
    candidates[0]?.kind === 'WAIT' &&
    line === expected &&
    formatCandidateStarvation(1, goal, blockedBy) === expected &&
    MIRRORED_MARKERS.has('CANDIDATE_STARVATION')
  return { pass, detail: `line="${line ?? 'none'}" mirrored=${MIRRORED_MARKERS.has('CANDIDATE_STARVATION')}` }
})

addCase('(3) a productive candidate set emits no starvation marker', () => {
  const base = perceive([], { crafting_table: [{ x: 30, y: 48, z: 34 }], furnace: [] })
  const state = withInventory(
    { ...base, goalQueue: { ...emptyGoalQueueState(), current: craftGoal('furnace') } },
    { cobblestone: 42 },
  )
  const candidates = generateCandidates(state, craftOptions)
  const line = candidateStarvationLine(candidates, 'craft:furnace:1', false, 'no_productive_candidate')
  const productive = candidates.some((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')
  const pass = productive && line === null
  return { pass, detail: `productive=${productive} line=${line ?? 'none'}` }
})

addCase('(3) missing=[...] tags every withheld capability with its candidate id', () => {
  const withheld: CandidateReachability[] = [
    {
      candidate: {
        id: 'RETRIEVE:known:station:furnace:b29_61_35',
        kind: 'RETRIEVE',
        label: 'x',
        targetName: 'furnace',
        target: { x: 29, y: 61, z: 35 },
        targetEntityId: null,
        itemName: null,
        requiresTool: false,
        toolName: null,
        inReach: false,
        hasStandableAdjacent: true,
        meta: {},
      },
      result: {
        reachable: false,
        reason: 'needs_ascend',
        missingCapabilities: [{ kind: 'ascend_plan' }, { kind: 'placeable_block' }],
      },
      fingerprint: 'fp',
      targetSignature: 'fp',
      withheld: true,
      suppressed: false,
    },
  ]
  const blockedBy = goalStarvationBlockedBy(null, { kind: 'craft', targetItem: 'furnace' }, withheld)
  const missing = candidateStarvationMissing(withheld)
  const line = formatCandidateStarvation(2, 'craft:furnace:1', blockedBy, missing)
  const pass =
    blockedBy === 'no_productive_action' &&
    missing.join(',') ===
      'RETRIEVE:known:station:furnace:b29_61_35:ascend_plan,RETRIEVE:known:station:furnace:b29_61_35:placeable_block' &&
    line ===
      'CANDIDATE_STARVATION presented=2 productive=0 goal="craft:furnace:1" blockedBy=no_productive_action missing=["RETRIEVE:known:station:furnace:b29_61_35:ascend_plan","RETRIEVE:known:station:furnace:b29_61_35:placeable_block"]'
  return { pass, detail: `blockedBy=${blockedBy} missing=[${missing.join(',')}] line="${line}"` }
})

addCase('(3) a withheld sibling reason never leaks into blockedBy', () => {
  const withheld: CandidateReachability[] = [
    {
      candidate: {
        id: 'RETRIEVE:known:station:crafting_table:b40_29_35',
        kind: 'RETRIEVE',
        label: 'x',
        targetName: 'crafting_table',
        target: { x: 40, y: 29, z: 35 },
        targetEntityId: null,
        itemName: null,
        requiresTool: false,
        toolName: null,
        inReach: false,
        hasStandableAdjacent: true,
        meta: { knownName: 'crafting_table' },
      },
      result: {
        reachable: false,
        reason: 'needs_descend',
        missingCapabilities: [{ kind: 'tool', tool: 'pickaxe', tier: 0 }],
      },
      fingerprint: 'fp',
      targetSignature: 'fp',
      withheld: true,
      suppressed: false,
    },
  ]
  const goal = { kind: 'craft' as const, targetItem: 'wooden_pickaxe' }
  const blockedBy = goalStarvationBlockedBy(null, goal, withheld)
  const missing = candidateStarvationMissing(withheld)
  const line = formatCandidateStarvation(2, 'craft:wooden_pickaxe:1', blockedBy, missing)
  const pass =
    blockedBy === 'no_productive_action' &&
    missing.join(',') === 'RETRIEVE:known:station:crafting_table:b40_29_35:tool:pickaxe@0' &&
    line ===
      'CANDIDATE_STARVATION presented=2 productive=0 goal="craft:wooden_pickaxe:1" blockedBy=no_productive_action missing=["RETRIEVE:known:station:crafting_table:b40_29_35:tool:pickaxe@0"]'
  return { pass, detail: `blockedBy=${blockedBy} missing=[${missing.join(',')}] line="${line}"` }
})

addCase('(3) a collect goal names its own withheld route reason', () => {
  const withheld: CandidateReachability[] = [
    {
      candidate: {
        id: 'RETRIEVE:known:oak_log:b0_110_0',
        kind: 'RETRIEVE',
        label: 'x',
        targetName: 'oak_log',
        target: { x: 0, y: 110, z: 0 },
        targetEntityId: null,
        itemName: null,
        requiresTool: false,
        toolName: null,
        inReach: false,
        hasStandableAdjacent: true,
        meta: { knownName: 'oak_log' },
      },
      result: { reachable: false, reason: 'needs_ascend', missingCapabilities: [] },
      fingerprint: 'fp',
      targetSignature: 'fp',
      withheld: true,
      suppressed: false,
    },
  ]
  const blockedBy = goalStarvationBlockedBy(null, { kind: 'collect', targetItem: 'oak_log' }, withheld)
  const missing = candidateStarvationMissing(withheld)
  const pass = blockedBy === 'needs_ascend' && missing.join(',') === 'RETRIEVE:known:oak_log:b0_110_0:needs_ascend'
  return { pass, detail: `blockedBy=${blockedBy} missing=[${missing.join(',')}]` }
})

addCase('(3) an unmet deterministic precondition is reported as blockedBy=precondition:pickaxe', () => {
  const rawIron: PlannedGoal = { kind: 'collect', description: 'collect 3 x raw_iron', targetItem: 'raw_iron', requiredCount: 3 }
  const noPickaxe = makeOptionSnapshot({ inventory: { cobblestone: 42, stick: 2 }, toolRank: 0 })
  const withPickaxe = makeOptionSnapshot({ inventory: { cobblestone: 42, stick: 2, stone_pickaxe: 1 }, toolRank: 2 })
  const cause = goalPreconditionCause(rawIron, noPickaxe)
  const line = formatCandidateStarvation(2, 'collect:raw_iron:3', cause ?? 'verify_failed', [])
  const cleared = goalPreconditionCause(rawIron, withPickaxe)
  const pass =
    cause === 'precondition:pickaxe' &&
    line === 'CANDIDATE_STARVATION presented=2 productive=0 goal="collect:raw_iron:3" blockedBy=precondition:pickaxe' &&
    cleared === null
  return { pass, detail: `cause=${cause} line="${line}" cleared=${String(cleared)}` }
})

// --- (4) the persisted perception snapshot is bounded --------------------------
addCase('(4) a pathological state snapshots under the byte bound with true totals in bounds', () => {
  const base = perceive([], { crafting_table: [], furnace: [] })
  const long = 'x'.repeat(200)
  const state: WorldState = {
    ...base,
    blocks: Array.from({ length: 500 }, (_, i) => ({
      kind: 'ore' as const,
      name: 'iron_ore',
      position: { x: i, y: 40, z: i },
      distance: i,
      diggable: true,
      inReach: false,
      hasAdjacentStandable: false,
      adjacentStandable: null,
      yield: 'raw_iron',
      harvestTool: 'pickaxe' as const,
      harvestTier: 1,
    })),
    craftingTables: Array.from({ length: 300 }, (_, i) => ({ x: i, y: 63, z: i, source: 'remembered' as const })),
    furnaces: Array.from({ length: 120 }, (_, i) => ({ x: i, y: 64, z: i, source: 'remembered' as const })),
    recentEvents: Array.from({ length: 100 }, (_, i) => `event ${i} ${long}`),
    signals: signals({
      knownResources: Array.from({ length: 500 }, (_, i) => ({
        name: 'iron_ore',
        kind: 'ore' as const,
        position: { x: i, y: 40, z: i },
      })),
      failedCandidates: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`CANDIDATE_${i}`, 1])),
    }),
  }
  const snapshot = boundedStateSnapshot(state)
  const bytes = Buffer.byteLength(JSON.stringify(snapshot))
  const record = snapshot as {
    bounds: Record<string, number>
    blocks: unknown[]
    craftingTables: StationEntry[]
    signals: { knownResources: unknown[]; failedCandidates: Record<string, number> }
  }
  const pass =
    bytes <= JEV_SNAPSHOT_LIMITS.maxBytes &&
    record.bounds.blocks === 500 &&
    record.bounds.craftingTables === 300 &&
    record.bounds.knownResources === 500 &&
    record.blocks.length === JEV_SNAPSHOT_LIMITS.blocks &&
    record.craftingTables.length === JEV_SNAPSHOT_LIMITS.stations &&
    record.craftingTables.every((entry) => entry.source === 'remembered') &&
    record.signals.knownResources.length === JEV_SNAPSHOT_LIMITS.knownResources &&
    Object.keys(record.signals.failedCandidates).length === JEV_SNAPSHOT_LIMITS.failedCandidates
  return { pass, detail: `bytes=${bytes}/${JEV_SNAPSHOT_LIMITS.maxBytes} bounds=${JSON.stringify(record.bounds)}` }
})

addCase('(4) a normal state keeps its decision-critical perception fields', () => {
  const remembered: KnownResource = { name: 'crafting_table', kind: 'station', position: { x: 31, y: 63, z: 37 } }
  const state = perceive([remembered], { crafting_table: [], furnace: [] })
  const snapshot = boundedStateSnapshot(state) as {
    tick: number
    craftingTables: StationEntry[]
    goal: { targetItem: string }
    bounds: { craftingTables: number }
  }
  const pass =
    snapshot.tick === 1 &&
    snapshot.craftingTables[0]?.source === 'remembered' &&
    snapshot.craftingTables[0]?.x === 31 &&
    snapshot.goal.targetItem === 'furnace' &&
    snapshot.bounds.craftingTables === 1
  return { pass, detail: JSON.stringify(snapshot.craftingTables) }
})

addCase('(5) the SMELT_INPUT_PREREQ marker is mirrored and emitted from the tick', () => {
  const source = `${readFileSync(new URL('./src/controller.ts', import.meta.url), 'utf8')}\n${readFileSync(new URL('./src/controller-legacy.ts', import.meta.url), 'utf8')}`
  const mirrored = MIRRORED_MARKERS.has('SMELT_INPUT_PREREQ')
  const wired = source.includes('this.logSmeltInputPrereq(state, groundingOptions)')
  const formatter = source.includes('formatSmeltInputPrereq')
  return { pass: mirrored && wired && formatter, detail: `mirrored=${mirrored} wired=${wired} formatter=${formatter}` }
})

addCase('(6) the CRAFT_INGREDIENT_PREREQ marker is mirrored and emitted from the tick', () => {
  const source = `${readFileSync(new URL('./src/controller.ts', import.meta.url), 'utf8')}\n${readFileSync(new URL('./src/controller-legacy.ts', import.meta.url), 'utf8')}`
  const mirrored = MIRRORED_MARKERS.has('CRAFT_INGREDIENT_PREREQ')
  const wired = source.includes('this.logCraftIngredientPrereq(state, groundingOptions)')
  const formatter = source.includes('formatCraftIngredientPrereq')
  return { pass: mirrored && wired && formatter, detail: `mirrored=${mirrored} wired=${wired} formatter=${formatter}` }
})

let failures = 0
process.stdout.write('station perception truth (remembered vs sensed)\n')
addCase('(4) a mob that damaged the body is a threat whatever its type (zombie_villager live case)', () => {
  // Live: a summoned `zombie_villager` damaged the body (`CRITICAL_DAMAGE ... source=zombie_villager`,
  // `DEATH_CAUSE killer=zombie_villager`) while no threat was ever sensed, so no ATTACK/RETREAT was
  // offered and the body never fought back. `zombie_villager` matches neither `zombie` nor the
  // `_zombie`/`_skeleton` suffix rule, so it was invisible to the safety layer.
  const vanilla = [
    'zombie_villager',
    'zombie',
    'skeleton',
    'blaze',
    'wither',
    'ender_dragon',
    'silverfish',
    'evoker',
  ].every((name) => isHostileEntityName(name, 'hostile'))
  // No over-reach: a genuinely passive mob is still not a threat a priori (the
  // observed-aggression rule in `buildEntities` covers the provoked case instead).
  const passive = ['pig', 'cow', 'villager', 'sheep', 'chicken'].every(
    (name) => isHostileEntityName(name, 'passive') === false,
  )
  // The general rule lives where the damage source is already in hand.
  const text = readFileSync(new URL('./src/state.ts', import.meta.url), 'utf8')
  const observed = text.includes('attackerId !== null && entity.id === attackerId')
  return {
    pass: vanilla && passive && observed,
    detail: `vanillaHostiles=${vanilla} passiveStayPassive=${passive} observedAggressionRule=${observed}`,
  }
})

process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} perception cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
