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
// Run: npx tsx test-perception.mts
import { createRequire } from 'node:module'
import {
  candidateStarvationBlockedBy,
  candidateStarvationLine,
  candidateStarvationMissing,
  formatCandidateStarvation,
  goalPreconditionCause,
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

// --- (2) remembered coordinates never satisfy an in-reach predicate ------------

const rememberedInReach: StationEntry = { x: 29, y: 48, z: 34, source: 'remembered' }

addCase('(2) an in-reach remembered table does not produce an in-place CRAFT candidate', () => {
  const base = perceive([], { crafting_table: [], furnace: [] })
  const state = withInventory(
    { ...base, goalQueue: { ...emptyGoalQueueState(), current: craftGoal('furnace') }, craftingTables: [rememberedInReach] },
    { cobblestone: 42 },
  )
  const candidates = generateCandidates(state, craftOptions)
  const crafts = candidates.filter((candidate) => candidate.kind === 'CRAFT')
  const eyeDistance = Math.hypot(rememberedInReach.x - state.self.eyePosition.x, rememberedInReach.y - state.self.eyePosition.y, rememberedInReach.z - state.self.eyePosition.z)
  const pass = eyeDistance <= defaultSensorOptions.reach && crafts.length === 0 && candidates.every((candidate) => candidate.kind === 'WAIT')
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
    { ...base, goalQueue: { ...emptyGoalQueueState(), current: craftGoal('furnace') }, craftingTables: [rememberedInReach] },
    { cobblestone: 42 },
  )
  const candidates = generateCandidates(state, craftOptions)
  const goal = 'craft:furnace:1'
  const blockedBy = candidateStarvationBlockedBy([], null)
  const line = candidateStarvationLine(candidates, goal, false, blockedBy)
  const expected = 'CANDIDATE_STARVATION presented=1 productive=0 goal="craft:furnace:1" blockedBy=no_productive_candidate'
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

addCase('(3) blockedBy is the primary withheld capability; missing=[all] stays ordered', () => {
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
      withheld: true,
      suppressed: false,
    },
  ]
  const blockedBy = candidateStarvationBlockedBy(withheld, null)
  const missing = candidateStarvationMissing(withheld)

  const line = formatCandidateStarvation(2, 'craft:furnace:1', blockedBy, missing)
  const pass =
    blockedBy === 'ascend_plan' &&
    missing.join(',') === 'ascend_plan,placeable_block' &&
    line ===
      'CANDIDATE_STARVATION presented=2 productive=0 goal="craft:furnace:1" blockedBy=ascend_plan missing=[ascend_plan,placeable_block]'
  return { pass, detail: `blockedBy=${blockedBy} missing=[${missing.join(',')}] line="${line}"` }
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

let failures = 0
process.stdout.write('station perception truth (remembered vs sensed)\n')
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
