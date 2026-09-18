// test-known-resource.mts - issue #14: known-resource coordinates must drive
// behaviour (retention -> candidate generation -> staleness), with no bot/net.
import type { Bot } from 'mineflayer'
import { defaultCandidateOptions, generateCandidates, staleKnownResources } from '../jev-agent/src/candidates.ts'
import type { Candidate } from '../jev-agent/src/candidates.ts'
import type { BlockState, GoalState, InventoryState, KnownResource, SelfState, Vec3Json, WorldState } from '../jev-agent/src/state.ts'
import { emptyGoalQueueState } from '../jev-agent/src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from '../jev-agent/src/goalQueue.ts'
import {
  evictStaleKnownResources,
  mergeKnownResources,
  resourceStillPresent,
} from './generation-entry.ts'
import { emptyWorldMemory, normalizeWorldMemory } from './resident-types.ts'
import type { KnownResourceJson } from './resident-types.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

interface LogEntry {
  event: string
  detail: Record<string, unknown> | undefined
}

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_M1O14',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'minecraft:overworld',
    isDay: true,
    heldItem: null,
  }
}

function inventory(counts: Record<string, number>): InventoryState {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0) }
}

function goal(overrides: Partial<GoalState>): GoalState {
  return {
    id: 'collect:raw_iron',
    description: 'collect 3 x raw_iron',
    targetItem: 'raw_iron',
    requiredCount: 3,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
    ...overrides,
  }
}

function queuedGoal(overrides: Partial<QueuedGoal>): QueuedGoal {
  return {
    id: 'g1',
    kind: 'collect',
    description: 'collect 3 x raw_iron',
    targetItem: 'raw_iron',
    requiredCount: 3,
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

function queueWith(...queued: QueuedGoal[]): GoalQueueState {
  return { ...emptyGoalQueueState(), depth: queued.length, current: queued[0] ?? null, empty: queued.length === 0, goals: queued }
}

function oreBlock(position: Vec3Json, name = 'iron_ore', drop = 'raw_iron'): BlockState {
  return {
    kind: 'ore',
    name,
    position,
    distance: 2,
    diggable: true,
    inReach: true,
    hasAdjacentStandable: true,
    adjacentStandable: { x: position.x, y: position.y + 1, z: position.z },
    yield: drop,
    harvestTool: 'pickaxe',
    harvestTier: 2,
  }
}

function stoneBlock(position: Vec3Json): BlockState {
  return {
    kind: 'stone',
    name: 'stone',
    position,
    distance: 2,
    diggable: true,
    inReach: true,
    hasAdjacentStandable: true,
    adjacentStandable: { x: position.x, y: position.y + 1, z: position.z },
    yield: 'cobblestone',
    harvestTool: 'pickaxe',
    harvestTier: 1,
  }
}

function worldState(overrides: {
  position: Vec3Json
  goalQueue: GoalQueueState
  goal?: GoalState
  blocks?: BlockState[]
  knownResources?: KnownResource[]
  inventory?: InventoryState
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position),
    inventory: overrides.inventory ?? inventory({ stone_pickaxe: 1 }),
    entities: [],
    blocks: overrides.blocks ?? [],
    terrain: { standable: [overrides.position] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: overrides.goal ?? goal({}),
    goalQueue: overrides.goalQueue,
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
      knownResources: overrides.knownResources ?? [],
    },
  }
}

// --- coordinate retention (#14) -------------------------------------------------

addCase('mergeKnownResources stores item, coordinate, dimension and worldEpoch', () => {
  const target: KnownResourceJson[] = []
  const log: LogEntry[] = []
  const added = mergeKnownResources(
    target,
    [{ name: 'iron_ore', kind: 'ore', x: 12.4, y: 15.6, z: -31.2, dimension: 'minecraft:overworld', worldEpoch: 4 }],
    (event, detail) => log.push({ event, detail }),
    4,
  )
  const entry = target[0]
  const pass =
    added === 1 &&
    entry?.name === 'iron_ore' &&
    entry?.x === 12 &&
    entry?.y === 16 &&
    entry?.z === -31 &&
    entry?.dimension === 'minecraft:overworld' &&
    entry?.worldEpoch === 4 &&
    log[0]?.event === 'KNOWN_RESOURCE' &&
    log[0]?.detail?.at === '12,16,-31'
  return { pass, detail: `added=${added} entry=${JSON.stringify(entry)} log=${JSON.stringify(log[0]?.detail)}` }
})

addCase('coordinate retention survives normalizeWorldMemory round-trip and dedups by cell', () => {
  const memory = normalizeWorldMemory({
    ...emptyWorldMemory(),
    knownResources: [
      { name: 'iron_ore', kind: 'ore', x: 1, y: 59, z: -3, dimension: 'minecraft:overworld', worldEpoch: 2, lastSeenAt: 111 },
    ],
  })
  const added = mergeKnownResources(memory.knownResources, [
    { name: 'iron_ore', kind: 'ore', x: 1.2, y: 59.4, z: -3.1, dimension: 'minecraft:overworld', worldEpoch: 2 },
  ])
  const entry = memory.knownResources[0]
  const pass =
    memory.knownResources.length === 1 &&
    added === 0 &&
    entry?.dimension === 'minecraft:overworld' &&
    entry?.worldEpoch === 2 &&
    entry?.lastSeenAt === 111
  return { pass, detail: `len=${memory.knownResources.length} added=${added} entry=${JSON.stringify(entry)}` }
})

// --- retrieval-candidate generation (#14) --------------------------------------

addCase('a current raw_iron need with a remembered ore and no visible ore emits RETRIEVE', () => {
  const state = worldState({
    position: { x: 0, y: 60, z: 0 },
    goalQueue: queueWith(queuedGoal({})),
    knownResources: [{ name: 'iron_ore', kind: 'ore', position: { x: 40, y: 59, z: -12 }, dimension: 'minecraft:overworld', worldEpoch: 2 }],
  })
  const retrieve = generateCandidates(state, defaultCandidateOptions).find((candidate: Candidate) => candidate.kind === 'RETRIEVE')
  const pass =
    retrieve !== undefined &&
    retrieve.meta.retrieval === 'known' &&
    retrieve.meta.resource === 'raw_iron' &&
    retrieve.target?.x === 40 &&
    retrieve.target?.y === 59
  return { pass, detail: retrieve === undefined ? 'no RETRIEVE' : `${retrieve.id} ${JSON.stringify(retrieve.meta)}` }
})

addCase('cobblestone descent proxy with queued raw_iron still emits a raw_iron RETRIEVE (the #14 gap)', () => {
  const state = worldState({
    position: { x: 0, y: 60, z: 0 },
    goal: goal({ id: 'collect:cobblestone', targetItem: 'cobblestone', description: 'collect 41 x cobblestone (descend toward ore levels)' }),
    goalQueue: queueWith(
      queuedGoal({ id: 'g-cobble', targetItem: 'cobblestone', description: 'collect 41 x cobblestone (descend toward ore levels)' }),
      queuedGoal({ id: 'g-iron', targetItem: 'raw_iron', description: 'collect 3 x raw_iron' }),
    ),
    // dy=-3 stays inside the walkable band; a deeper drop without a descent plan
    // is withheld as needs_descend by the affordance gate.
    knownResources: [{ name: 'iron_ore', kind: 'ore', position: { x: 31, y: 57, z: 34 }, dimension: 'minecraft:overworld', worldEpoch: 2 }],
  })
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const retrieve = candidates.find((candidate: Candidate) => candidate.kind === 'RETRIEVE')
  const actionable = candidates.filter((candidate: Candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')
  const pass =
    retrieve !== undefined &&
    retrieve.meta.resource === 'raw_iron' &&
    retrieve.target?.x === 31 &&
    retrieve.target?.y === 57 &&
    retrieve.target?.z === 34 &&
    actionable.length === 1 &&
    actionable[0]?.kind === 'RETRIEVE'
  return { pass, detail: candidates.map((candidate) => candidate.id).join(',') }
})

addCase('an active smelt does not retrieve a future ore before its own prerequisites (#73)', () => {
  const current = queuedGoal({
    id: 'g-charcoal',
    kind: 'smelt',
    description: 'smelt 1 x charcoal',
    targetItem: 'charcoal',
    requiredCount: 1,
  })
  const state = worldState({
    position: { x: 30, y: 46, z: 37 },
    goal: goal({ id: 'smelt:charcoal', description: 'smelt 1 x charcoal', targetItem: 'charcoal', requiredCount: 1 }),
    goalQueue: queueWith(
      current,
      queuedGoal({ id: 'g-iron', targetItem: 'raw_iron', description: 'collect 3 x raw_iron' }),
      queuedGoal({ id: 'g-diamond', targetItem: 'diamond', description: 'collect 1 x diamond' }),
    ),
    knownResources: [
      { name: 'iron_ore', kind: 'ore', position: { x: 36, y: 56, z: 41 } },
      { name: 'deepslate_diamond_ore', kind: 'ore', position: { x: 42, y: -2, z: 25 } },
    ],
    inventory: inventory({ cobblestone: 60, stone_pickaxe: 1 }),
  })

  const retrievals = generateCandidates(state, defaultCandidateOptions).filter((candidate) => candidate.kind === 'RETRIEVE')
  const future = retrievals.find((candidate) => candidate.meta.resource === 'raw_iron' || candidate.meta.resource === 'diamond')
  const pass = future === undefined
  return { pass, detail: `retrievals=[${retrievals.map((candidate) => String(candidate.meta.resource)).join(',')}]` }
})

addCase('retrieval is offered alongside a dig candidate but a visible matching ore suppresses it', () => {
  const known: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 40, y: 59, z: -12 } }
  const proxy = worldState({
    position: { x: 0, y: 60, z: 0 },
    goal: goal({ id: 'collect:cobblestone', targetItem: 'cobblestone', description: 'collect 41 x cobblestone (descend toward ore levels)' }),
    goalQueue: queueWith(
      queuedGoal({ id: 'g-cobble', targetItem: 'cobblestone' }),
      queuedGoal({ id: 'g-iron', targetItem: 'raw_iron' }),
    ),
    blocks: [stoneBlock({ x: 1, y: 59, z: 0 })],
    knownResources: [known],
  })
  const alongside = generateCandidates(proxy, defaultCandidateOptions)
  const hasMine = alongside.some((candidate: Candidate) => candidate.kind === 'MINE')
  const hasRetrieve = alongside.some((candidate: Candidate) => candidate.kind === 'RETRIEVE')
  const visible = worldState({
    position: { x: 0, y: 60, z: 0 },
    goalQueue: queueWith(queuedGoal({})),
    blocks: [oreBlock({ x: 1, y: 60, z: 0 })],
    knownResources: [known],
  })
  const suppressed = generateCandidates(visible, defaultCandidateOptions)
  const stillRetrieve = suppressed.some((candidate: Candidate) => candidate.kind === 'RETRIEVE')
  const stillMine = suppressed.some((candidate: Candidate) => candidate.kind === 'MINE')
  return { pass: hasMine && hasRetrieve && !stillRetrieve && stillMine, detail: `alongside=${hasMine}/${hasRetrieve} visible=${stillMine}/${stillRetrieve}` }
})

addCase('a remembered log beyond proof distance grounds a charcoal RETRIEVE', () => {
  const state = worldState({
    position: { x: 0, y: 60, z: 0 },
    goal: goal({ id: 'smelt:charcoal', targetItem: 'charcoal', description: 'smelt 1 x charcoal' }),
    goalQueue: queueWith(queuedGoal({ kind: 'smelt', targetItem: 'charcoal' })),
    knownResources: [{ name: 'oak_log', kind: 'log', position: { x: 6, y: 68, z: 0 } }],
    // the 8-block climb needs a placeable block for the pillar plan, else the
    // affordance gate withholds the retrieval (needs_ascend).
    inventory: inventory({ stone_pickaxe: 1, cobblestone: 4 }),
  })
  const retrieve = generateCandidates(state, defaultCandidateOptions).find((candidate: Candidate) => candidate.kind === 'RETRIEVE')
  return {
    pass: retrieve !== undefined && retrieve.meta.retrieval === 'known' && retrieve.meta.resource === 'charcoal' && retrieve.target?.y === 68,
    detail: retrieve === undefined ? 'no RETRIEVE' : `${retrieve.id} ${JSON.stringify(retrieve.meta)}`,
  }
})

// --- staleness (#14) ------------------------------------------------------------

addCase('resourceStillPresent classifies unknown / present / replaced / stale', () => {
  const observed = [
    resourceStillPresent('iron_ore', null),
    resourceStillPresent('iron_ore', 'iron_ore'),
    resourceStillPresent('iron_ore', 'deepslate_iron_ore'),
    resourceStillPresent('iron_ore', 'stone'),
    resourceStillPresent('oak_log', 'air'),
  ]
  return { pass: observed.join(',') === 'unknown,present,replaced,stale,stale', detail: observed.join(',') }
})

addCase('staleKnownResources reports a near remembered ore absent from the sensor blocks', () => {
  const nearGone: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 3, y: 60, z: 0 } }
  const nearPresent: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 2, y: 59, z: 0 } }
  const farGone: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 40, y: 40, z: 0 } }
  const state = worldState({
    position: { x: 0, y: 60, z: 0 },
    goalQueue: queueWith(queuedGoal({})),
    blocks: [oreBlock({ x: 2, y: 59, z: 0 })],
    knownResources: [nearGone, nearPresent, farGone],
  })
  const stale = staleKnownResources(state)
  const pass = stale.length === 1 && stale[0]?.position.x === 3 && stale[0]?.position.y === 60
  return { pass, detail: stale.map((resource) => `${resource.name}@${resource.position.x},${resource.position.y},${resource.position.z}`).join(' ') }
})

addCase('evictStaleKnownResources drops a gone cell, logs KNOWN_RESOURCE_STALE and keeps a live one', () => {
  const known: KnownResourceJson[] = [
    { name: 'iron_ore', kind: 'ore', x: 3, y: 60, z: 0, dimension: 'minecraft:overworld', worldEpoch: 2 },
    { name: 'iron_ore', kind: 'ore', x: 2, y: 59, z: 0, dimension: 'minecraft:overworld', worldEpoch: 2 },
  ]
  const live = new Map<string, string>([
    ['3,60,0', 'air'],
    ['2,59,0', 'iron_ore'],
  ])
  const bot = {
    entity: { position: { x: 0, y: 60, z: 0 } },
    blockAt: (position: { x: number; y: number; z: number }) => {
      const name = live.get(`${position.x},${position.y},${position.z}`)
      return name === undefined ? null : { name }
    },
  } as unknown as Bot
  const log: LogEntry[] = []
  const evicted = evictStaleKnownResources(bot, known, { dimension: 'minecraft:overworld', worldEpoch: 2 }, (event, detail) =>
    log.push({ event, detail }),
  )
  const pass =
    evicted.length === 1 &&
    evicted[0]?.x === 3 &&
    known.length === 1 &&
    known[0]?.x === 2 &&
    known[0]?.lastSeenAt !== undefined &&
    log[0]?.event === 'KNOWN_RESOURCE_STALE' &&
    log[0]?.detail?.item === 'iron_ore' &&
    log[0]?.detail?.at === '3,60,0'
  return { pass, detail: `evicted=${JSON.stringify(evicted)} kept=${JSON.stringify(known)} log=${JSON.stringify(log)}` }
})

addCase('evictStaleKnownResources evicts a cell from a previous worldEpoch', () => {
  const known: KnownResourceJson[] = [{ name: 'iron_ore', kind: 'ore', x: 9, y: 60, z: 0, worldEpoch: 1 }]
  const bot = { entity: { position: { x: 0, y: 60, z: 0 } }, blockAt: () => ({ name: 'iron_ore' }) } as unknown as Bot
  const log: LogEntry[] = []
  const evicted = evictStaleKnownResources(bot, known, { dimension: 'minecraft:overworld', worldEpoch: 2 }, (event, detail) =>
    log.push({ event, detail }),
  )
  const pass = evicted.length === 1 && known.length === 0 && log[0]?.detail?.reason === 'worldEpoch'
  return { pass, detail: `evicted=${evicted.length} left=${known.length} reason=${String(log[0]?.detail?.reason)}` }
})

let failures = 0
process.stdout.write('known-resource retention + retrieval + staleness (#14)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} known-resource cases passed\n`)
if (failures > 0) process.exit(1)
