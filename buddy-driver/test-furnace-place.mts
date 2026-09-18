// test-furnace-place.mts - M2 blocker #46 regression suite.
//
// Run: node ../jev-agent/node_modules/.bin/tsx test-furnace-place.mts
//
// Covers the three acceptance behaviours:
//   (a) the furnace option is not abandoned while it is the prerequisite of the
//       preferred smelt;
//   (b) a failed placement retries at a nearby spot up to the bound;
//   (c) the abandon reason is logged in one line.
// Plus a fixture that drives held-furnace -> PLACE -> SMELT -> SMELT_DONE.
import { createRequire } from 'node:module'
import { defaultCandidateOptions, furnacePrereqInputFromState, generateCandidates } from '../jev-agent/src/candidates.ts'
import type { Candidate, CandidateOptions } from '../jev-agent/src/candidates.ts'
import {
  candidateStarvationLine,
  candidateStarvationMissing,
  formatStationRegisteredPlaced,
  goalStarvationBlockedBy,
  MIRRORED_MARKERS,
  PLACED_STATION_ITEMS,
  registerPlacedStation,
} from '../jev-agent/src/controller.ts'
import { createRecipeIndex } from '../jev-agent/src/crafting.ts'
import type { QueuedGoal } from '../jev-agent/src/goalQueue.ts'
import { executeFurnaceSmelt, formatSmeltLog, placedStationReadyLine } from '../jev-agent/src/executor.ts'
import type { SmeltFurnaceWindow } from '../jev-agent/src/executor.ts'
import { formatPrereqRankShadow, knownStationKey, planPrereqOptions, selectPrereqPath } from '../jev-agent/src/prereqOption.ts'
import type { PrereqPath } from '../jev-agent/src/prereqOption.ts'
import { MoveFailMemory } from '../jev-agent/src/moveFailMemory.ts'
import type { KnownResource } from '../jev-agent/src/state.ts'
import { stationRegisteredPlacedDetail } from './generation-entry.ts'
import {
  classifyAbandonReason,
  evaluatePlaceRetry,
  formatAbandonReason,
  PLACE_RETRY_LIMIT,
  prerequisiteProtection,
  shouldAdoptAbandon,
} from '../jev-agent/src/placementGuard.ts'
import type { AgentSignals, BlockState, DescentOption, GoalState, InventoryState, SelfState, StationEntry, Vec3Json, WorldState } from '../jev-agent/src/state.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_M2PL',
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

function smeltGoal(): GoalState {
  return {
    id: 'smelt:iron_ingot',
    description: 'smelt 3 x iron_ingot',
    targetItem: 'iron_ingot',
    requiredCount: 3,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function worldState(overrides: {
  inventory?: InventoryState
  signals?: AgentSignals
  furnaces?: StationEntry[]
  placementSpots?: Vec3Json[]
  position?: Vec3Json
  craftingTables?: StationEntry[]
  descent?: DescentOption[]
  /**
   * M2 craft-table regression: override the active subgoal so the same fixture
   * drives a `craft` goal instead of the default smelt.
   */
  current?: QueuedGoal
}): WorldState {
  const smelt: QueuedGoal = {
    id: 'g6',
    kind: 'smelt',
    description: 'smelt 3 x iron_ingot',
    targetItem: 'iron_ingot',
    requiredCount: 3,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position ?? { x: 29, y: 61, z: 35 }),
    inventory: overrides.inventory ?? inventory({}),
    entities: [],
    blocks: [] as BlockState[],
    terrain: { standable: [overrides.position ?? { x: 29, y: 61, z: 35 }] },
    craftingTables: overrides.craftingTables ?? [],
    furnaces: overrides.furnaces ?? [],
    placementSpots: overrides.placementSpots ?? [],
    descent: overrides.descent ?? [],
    goal: smeltGoal(),
    goalQueue: {
      depth: 2,
      current: overrides.current ?? smelt,
      empty: false,
      hasImpossible: false,
      done: 0,
      goals: [],
    },
    recentEvents: [],
    signals: overrides.signals ?? signals(),
  }
}

const heldFurnaceInventory = inventory({ furnace: 1, raw_iron: 8, coal: 7, cobblestone: 112 })

// --- M2 craft-table deadlock: a `craft` goal must acquire a usable table -----
//
// Live shape (measured): `craft 1 x furnace` with cobblestone=119, no sensed
// table, and every remembered table 21+ blocks away collapsed to WAIT because
// craftCandidates() required a station inside the sensor radius. The smelt
// prerequisite ladder already knew how to reach a remembered station; the craft
// goal now reuses that ladder for its table.

const recipeIndex = createRecipeIndex(createRequire(import.meta.url)('minecraft-data')('1.21.11'))

function craftCurrent(item: string): QueuedGoal {
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

const craftOptions: CandidateOptions = { ...defaultCandidateOptions, recipes: recipeIndex }

// --- (a) required precondition is protected ---------------------------------

addCase('(a) PLACE:furnace is protected while it is the prerequisite of the preferred smelt', () => {
  const decision = shouldAdoptAbandon({
    actionId: 'PLACE:furnace:p29_61_35',
    goals: [{ kind: 'smelt', targetItem: 'iron_ingot' }],
    placedFurnaceCount: 0,
    abandonRequested: true,
  })
  const expected = 'PRECONDITION_PROTECTED option=PLACE:furnace because=prerequisite_of smelt_iron_ingot'
  const pass =
    decision.adopt === false &&
    decision.protection.protect === true &&
    decision.protection.line === expected
  return { pass, detail: `adopt=${decision.adopt} line="${decision.protection.line}"` }
})

addCase('(a) protection releases once a furnace is placed (abandon allowed)', () => {
  const decision = shouldAdoptAbandon({
    actionId: 'PLACE:furnace:p29_61_35',
    goals: [{ kind: 'smelt', targetItem: 'iron_ingot' }],
    placedFurnaceCount: 1,
    abandonRequested: true,
  })
  return { pass: decision.adopt === true && decision.protection.protect === false, detail: `adopt=${decision.adopt}` }
})

addCase('(a) protection does not apply to an unrelated goal', () => {
  const decision = shouldAdoptAbandon({
    actionId: 'PLACE:furnace:p29_61_35',
    goals: [{ kind: 'collect', targetItem: 'diamond' }],
    placedFurnaceCount: 0,
    abandonRequested: true,
  })
  return { pass: decision.adopt === true, detail: `adopt=${decision.adopt}` }
})

addCase('(a) the craft/retrieve furnace prerequisites are protected too', () => {
  const craft = prerequisiteProtection({ actionId: 'CRAFT:furnace', goals: [{ kind: 'smelt', targetItem: 'iron_ingot' }], placedFurnaceCount: 0 })
  const retrieve = prerequisiteProtection({
    actionId: 'RETRIEVE:known:station:furnace:b29_61_35',
    goals: [{ kind: 'smelt', targetItem: 'iron_ingot' }],
    placedFurnaceCount: 0,
  })
  return { pass: craft.protect && retrieve.protect, detail: `craft=${craft.protect} retrieve=${retrieve.protect}` }
})

addCase('(a) the measured live shape is protected: place:furnace head with smelt:iron_ingot queued behind', () => {
  const goals = [
    { kind: 'place', targetItem: 'furnace' },
    { kind: 'collect', targetItem: 'log' },
    { kind: 'smelt', targetItem: 'charcoal' },
    { kind: 'collect', targetItem: 'raw_iron' },
    { kind: 'smelt', targetItem: 'iron_ingot' },
  ]
  const decision = shouldAdoptAbandon({
    actionId: 'PLACE:furnace:p29_61_35',
    goals,
    placedFurnaceCount: 0,
    abandonRequested: true,
  })
  const expected = 'PRECONDITION_PROTECTED option=PLACE:furnace because=prerequisite_of smelt_iron_ingot'
  return { pass: decision.adopt === false && decision.protection.line === expected, detail: `adopt=${decision.adopt} line="${decision.protection.line}"` }
})

addCase('(a) an unrelated plan with no smelt is not protected', () => {
  const decision = shouldAdoptAbandon({
    actionId: 'PLACE:furnace:p29_61_35',
    goals: [{ kind: 'place', targetItem: 'furnace' }, { kind: 'collect', targetItem: 'diamond' }],
    placedFurnaceCount: 0,
    abandonRequested: true,
  })
  return { pass: decision.adopt === true, detail: `adopt=${decision.adopt}` }
})

// --- #58: cheapest feasible path is chosen and logged ------------------------

addCase('(#58) held furnace + far known station logs PREREQ_OPTION chosen=place_held', () => {
  const known: KnownResource = { name: 'furnace', kind: 'station', position: { x: 22, y: 66, z: 29 } }
  const state = worldState({
    inventory: heldFurnaceInventory,
    signals: signals({ knownResources: [known] }),
    placementSpots: [{ x: 30, y: 61, z: 35 }],
  })
  const decision = planPrereqOptions(furnacePrereqInputFromState(state, defaultCandidateOptions))
  const expected = 'PREREQ_OPTION chosen=place_held over=[use_known_station,craft_and_place] reason=place_held cost=2'
  const candidate = generateCandidates(state, defaultCandidateOptions).find((entry) => entry.meta.prereqPath !== undefined)
  const pass =
    decision.chosen === 'place_held' &&
    decision.line === expected &&
    candidate !== undefined &&
    candidate.kind === 'PLACE' &&
    candidate.id.startsWith('PLACE:furnace') &&
    candidate.meta.prereqPath === 'place_held'
  return { pass, detail: `${decision.line} first=${candidate?.id ?? 'none'} path=${String(candidate?.meta.prereqPath)}` }
})

// --- (live M2 blocker) a blacklisted station must not collapse the ladder to WAIT

/** Reproduce the controller's blacklist: move-failure memory rows -> station keys. */
function blacklistFromMemory(memory: MoveFailMemory, state: WorldState): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const resource of state.signals.knownResources ?? []) {
    if (resource.kind !== 'station') continue
    if (!memory.isBlacklisted(state.self.dimension, resource.position)) continue
    keys.add(knownStationKey({ name: resource.name, position: resource.position }))
  }
  return keys
}

addCase('(live) blacklisted remembered furnace + held table chooses craft_and_place, never only WAIT', () => {
  const knownFurnace: KnownResource = { name: 'furnace', kind: 'station', position: { x: 22, y: 66, z: 29 } }
  const state = worldState({
    position: { x: 39, y: 10, z: 34 },
    inventory: inventory({ raw_iron: 8, coal: 7, cobblestone: 119, crafting_table: 1 }),
    signals: signals({ knownResources: [knownFurnace] }),
    placementSpots: [{ x: 38, y: 10, z: 34 }],
  })
  const memory = new MoveFailMemory({ failureLimit: 1 })
  memory.record(state.self.dimension, knownFurnace.position, 'unreachable')
  const options: CandidateOptions = {
    ...defaultCandidateOptions,
    unreachableStations: blacklistFromMemory(memory, state),
  }

  const decision = planPrereqOptions(furnacePrereqInputFromState(state, options))
  const known = decision.options.find((option) => option.path === 'use_known_station')
  const candidates = generateCandidates(state, options)
  const productive = candidates.filter((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')
  const place = productive.find((candidate) => candidate.id.startsWith('PLACE:crafting_table'))
  const retrieve = candidates.find((candidate) => candidate.id.includes('station:furnace'))
  const pass =
    decision.chosen === 'craft_and_place' &&
    known?.feasible === false &&
    known.reason === 'known_station_unreachable' &&
    place !== undefined &&
    place.meta.prereqPath === 'craft_and_place' &&
    retrieve === undefined &&
    productive.length > 0
  return {
    pass,
    detail: `${decision.line} | candidates=[${candidates.map((candidate) => candidate.id).join(',')}]`,
  }
})

addCase('(live) blacklisted furnace + a reachable remembered table walks to it under craft_and_place', () => {
  const knownFurnace: KnownResource = { name: 'furnace', kind: 'station', position: { x: 22, y: 66, z: 29 } }
  const knownTable: KnownResource = { name: 'crafting_table', kind: 'station', position: { x: 39, y: 10, z: 40 } }
  const state = worldState({
    position: { x: 39, y: 10, z: 34 },
    inventory: inventory({ raw_iron: 8, coal: 7, cobblestone: 119 }),
    signals: signals({ knownResources: [knownFurnace, knownTable] }),
    placementSpots: [{ x: 38, y: 10, z: 34 }],
  })
  const memory = new MoveFailMemory({ failureLimit: 1 })
  memory.record(state.self.dimension, knownFurnace.position, 'unreachable')
  const options: CandidateOptions = {
    ...defaultCandidateOptions,
    unreachableStations: blacklistFromMemory(memory, state),
  }

  const decision = planPrereqOptions(furnacePrereqInputFromState(state, options))
  const candidates = generateCandidates(state, options)
  const retrieve = candidates.find((candidate) => candidate.id.startsWith('RETRIEVE:known:station:crafting_table'))
  const retrieveFurnace = candidates.find((candidate) => candidate.id.includes('station:furnace'))
  const pass =
    decision.chosen === 'craft_and_place' &&
    retrieve !== undefined &&
    retrieve.meta.prereqPath === 'craft_and_place' &&
    retrieveFurnace === undefined
  return { pass, detail: `${decision.line} | retrieve=${retrieve?.id ?? 'none'}` }
})

addCase('(live) #11 v2: smelt charcoal + cobblestone 67 + reachable remembered table is productive, never starving', () => {
  const feet: Vec3Json = { x: 32, y: 40, z: 37 }
  const table: Vec3Json = { x: 40, y: 29, z: 35 }
  const furnaceStation: Vec3Json = { x: 29, y: 61, z: 35 }
  const downStep: DescentOption = {
    dir: 'E',
    mode: 'down',
    dx: 1,
    dz: 0,
    step: { x: feet.x + 1, y: feet.y - 1, z: feet.z },
    wall: { x: feet.x + 1, y: feet.y, z: feet.z },
    head: { x: feet.x + 1, y: feet.y + 1, z: feet.z },
    floor: { x: feet.x + 1, y: feet.y - 1, z: feet.z },
    wallSolid: false,
    headSolid: false,
    floorSolid: true,
    safe: true,
    reason: 'safe',
    digName: 'dirt',
    digHarvestTool: 'pickaxe',
    digHarvestTier: 0,
    diggable: true,
  }
  const charcoal: QueuedGoal = {
    id: 'g924:smelt:charcoal',
    kind: 'smelt',
    description: 'smelt 1 x charcoal',
    targetItem: 'charcoal',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
  const state = worldState({
    position: feet,
    inventory: inventory({ cobblestone: 67, stick: 2, birch_planks: 2, wooden_pickaxe: 1, stone_pickaxe: 1 }),
    signals: signals({
      knownResources: [
        { name: 'crafting_table', kind: 'station', position: table },
        { name: 'furnace', kind: 'station', position: furnaceStation },
      ],
    }),
    descent: [downStep],
    current: charcoal,
  })
  const decision = planPrereqOptions(furnacePrereqInputFromState(state, defaultCandidateOptions))
  const chosen = selectPrereqPath(decision, new Set<PrereqPath>(['craft_and_place']))
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const acquire = candidates.find((candidate) => candidate.id === 'RETRIEVE:known:station:crafting_table:b40_29_35')
  const kept =
    chosen === null ? [] : candidates.filter((candidate) => candidate.meta.prereqPath === undefined || candidate.meta.prereqPath === chosen)
  const blockedBy = goalStarvationBlockedBy(null, charcoal, [])
  const starvation = candidateStarvationLine(kept, 'smelt:charcoal:1', false, blockedBy, [])
  const shadow = formatPrereqRankShadow(decision, chosen)
  const pass =
    decision.chosen === 'craft_and_place' &&
    chosen !== null &&
    kept.some((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE') &&
    acquire !== undefined &&
    acquire.meta.prereqPath === 'craft_and_place' &&
    acquire.affordance?.feasible === true &&
    starvation === null
  return {
    pass,
    detail: `${decision.line} | ${shadow} | chosen=${chosen} acquire=${acquire?.id ?? 'none'} kept=[${kept.map((candidate) => candidate.id).join(',')}] starvation=${starvation ?? 'none'}`,
  }
})

addCase('(live) #11 v2: with the world paths gone the abandoned craft path still yields the acquisition route', () => {
  const feet: Vec3Json = { x: 32, y: 40, z: 37 }
  const table: Vec3Json = { x: 40, y: 29, z: 35 }
  const furnaceStation: Vec3Json = { x: 29, y: 61, z: 35 }
  const downStep: DescentOption = {
    dir: 'E',
    mode: 'down',
    dx: 1,
    dz: 0,
    step: { x: feet.x + 1, y: feet.y - 1, z: feet.z },
    wall: { x: feet.x + 1, y: feet.y, z: feet.z },
    head: { x: feet.x + 1, y: feet.y + 1, z: feet.z },
    floor: { x: feet.x + 1, y: feet.y - 1, z: feet.z },
    wallSolid: false,
    headSolid: false,
    floorSolid: true,
    safe: true,
    reason: 'safe',
    digName: 'dirt',
    digHarvestTool: 'pickaxe',
    digHarvestTier: 0,
    diggable: true,
  }
  const charcoal: QueuedGoal = {
    id: 'g924:smelt:charcoal',
    kind: 'smelt',
    description: 'smelt 1 x charcoal',
    targetItem: 'charcoal',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
  const state = worldState({
    position: feet,
    inventory: inventory({ cobblestone: 67, stick: 2, birch_planks: 2, wooden_pickaxe: 1, stone_pickaxe: 1 }),
    signals: signals({
      knownResources: [
        { name: 'crafting_table', kind: 'station', position: table },
        { name: 'furnace', kind: 'station', position: furnaceStation },
      ],
    }),
    descent: [downStep],
    current: charcoal,
  })
  const options: CandidateOptions = {
    ...defaultCandidateOptions,
    unreachableStations: new Set([knownStationKey({ name: 'furnace', position: furnaceStation })]),
  }
  const decision = planPrereqOptions(furnacePrereqInputFromState(state, options))
  const chosen = selectPrereqPath(decision, new Set<PrereqPath>(['craft_and_place']))
  const candidates = generateCandidates(state, options)
  const acquire = candidates.find((candidate) => candidate.id === 'RETRIEVE:known:station:crafting_table:b40_29_35')
  const kept = candidates.filter(
    (candidate) => candidate.meta.prereqPath === undefined || candidate.meta.prereqPath === chosen,
  )
  const blockedBy = goalStarvationBlockedBy(null, charcoal, [])
  const starvation = candidateStarvationLine(kept, 'smelt:charcoal:1', false, blockedBy, [])
  const pass =
    decision.chosen === 'craft_and_place' &&
    chosen === 'craft_and_place' &&
    acquire !== undefined &&
    acquire.affordance?.feasible === true &&
    starvation === null
  return {
    pass,
    detail: `${decision.line} | chosen=${chosen} acquire=${acquire?.id ?? 'none'} starvation=${starvation ?? 'none'}`,
  }
})

// --- M2 craft-table deadlock: `craft 1 x furnace` must not collapse to WAIT ---

const rememberedTable: KnownResource = { name: 'crafting_table', kind: 'station', position: { x: 39, y: 31, z: 34 } }

addCase('(live) craft 1 x furnace + remembered table 21m away yields RETRIEVE, never only WAIT', () => {
  const state = worldState({
    position: { x: 39, y: 10, z: 34 },
    inventory: inventory({ cobblestone: 119 }),
    signals: signals({ knownResources: [rememberedTable] }),
    current: craftCurrent('furnace'),
  })

  const candidates = generateCandidates(state, craftOptions)
  const retrieve = candidates.find((candidate) => candidate.id.startsWith('RETRIEVE:known:station:crafting_table'))
  const productive = candidates.filter((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')
  const pass =
    retrieve !== undefined &&
    retrieve.kind === 'RETRIEVE' &&
    retrieve.meta.tableSource === 'remembered' &&
    retrieve.target?.x === rememberedTable.position.x &&
    retrieve.target?.y === rememberedTable.position.y &&
    retrieve.target?.z === rememberedTable.position.z &&
    productive.length > 0
  return { pass, detail: `candidates=[${candidates.map((candidate) => candidate.id).join(',')}]` }
})

addCase('(live) craft 1 x furnace + a held table places it instead of walking to a remembered one', () => {
  const spot: Vec3Json = { x: 38, y: 10, z: 34 }
  const state = worldState({
    position: { x: 39, y: 10, z: 34 },
    inventory: inventory({ cobblestone: 119, crafting_table: 1 }),
    signals: signals({ knownResources: [rememberedTable] }),
    placementSpots: [spot],
    current: craftCurrent('furnace'),
  })

  const candidates = generateCandidates(state, craftOptions)
  const place = candidates.find((candidate) => candidate.id.startsWith('PLACE:crafting_table'))
  const retrieve = candidates.find((candidate) => candidate.id.startsWith('RETRIEVE:known:station:crafting_table'))
  const pass =
    place !== undefined &&
    place.kind === 'PLACE' &&
    place.target?.x === spot.x &&
    place.target?.y === spot.y &&
    place.target?.z === spot.z &&
    retrieve === undefined
  return { pass, detail: `candidates=[${candidates.map((candidate) => candidate.id).join(',')}]` }
})

addCase('(live) craft 1 x furnace + blacklisted remembered table emits no doomed RETRIEVE', () => {
  const state = worldState({
    position: { x: 39, y: 10, z: 34 },
    inventory: inventory({ cobblestone: 119 }),
    signals: signals({ knownResources: [rememberedTable] }),
    current: craftCurrent('furnace'),
  })
  const options: CandidateOptions = {
    ...craftOptions,
    unreachableStations: new Set([knownStationKey({ name: 'crafting_table', position: rememberedTable.position })]),
  }

  const candidates = generateCandidates(state, options)
  const retrieve = candidates.find((candidate) => candidate.id.startsWith('RETRIEVE:known:station:crafting_table'))
  const productive = candidates.filter((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')
  const pass = retrieve === undefined && productive.length === 0
  return { pass, detail: `candidates=[${candidates.map((candidate) => candidate.id).join(',')}]` }
})

addCase('(live) a sensed table that failed pathing is re-planned as unavailable', () => {
  const sensedTable: StationEntry = { x: 31, y: 63, z: 37, source: 'sensed' }
  const state = worldState({
    position: { x: 29, y: 51, z: 37 },
    inventory: inventory({ stick: 2, birch_planks: 7, dirt: 8, leaf_litter: 4, cobblestone: 42 }),
    craftingTables: [sensedTable],
    signals: signals({
      lastFailureCode: 'path_stuck',
      failedCandidates: { 'CRAFT:wooden_pickaxe': 1 },
    }),
    current: craftCurrent('wooden_pickaxe'),
  })

  const candidates = generateCandidates(state, craftOptions)
  const retry = candidates.find((candidate) => candidate.id === 'CRAFT:wooden_pickaxe')
  const acquire = candidates.find((candidate) => candidate.id === 'CRAFT:crafting_table')
  const pass = retry === undefined && acquire !== undefined && acquire.meta.requiresTable === false
  return { pass, detail: `candidates=[${candidates.map((candidate) => candidate.id).join(',')}]` }
})

addCase('(live) an explicitly unreachable sensed table is not treated as available', () => {
  const sensedTable: StationEntry = { x: 31, y: 63, z: 37, source: 'sensed' }
  const state = worldState({
    position: { x: 29, y: 51, z: 37 },
    inventory: inventory({ stick: 2, birch_planks: 7 }),
    craftingTables: [sensedTable],
    signals: signals(),
    current: craftCurrent('wooden_pickaxe'),
  })
  const options: CandidateOptions = {
    ...craftOptions,
    unreachableStations: new Set([knownStationKey({ name: 'crafting_table', position: sensedTable })]),
  }

  const candidates = generateCandidates(state, options)
  const retry = candidates.find((candidate) => candidate.id === 'CRAFT:wooden_pickaxe')
  const acquire = candidates.find((candidate) => candidate.id === 'CRAFT:crafting_table')
  const pass = retry === undefined && acquire !== undefined
  return { pass, detail: `candidates=[${candidates.map((candidate) => candidate.id).join(',')}]` }
})

addCase('(live) furnace prerequisite skips a blacklisted sensed table and uses a remembered fallback', () => {
  const sensedTable: StationEntry = { x: 40, y: 29, z: 35, source: 'sensed' }
  const rememberedTable: KnownResource = { name: 'crafting_table', kind: 'station', position: { x: 39, y: 10, z: 40 } }
  const state = worldState({
    position: { x: 39, y: 10, z: 34 },
    inventory: inventory({ raw_iron: 3, coal: 2, cobblestone: 119 }),
    craftingTables: [sensedTable],
    signals: signals({ knownResources: [rememberedTable] }),
  })
  const options: CandidateOptions = {
    ...defaultCandidateOptions,
    unreachableStations: new Set([knownStationKey({ name: 'crafting_table', position: sensedTable })]),
  }

  const candidates = generateCandidates(state, options)
  const craftAtSensed = candidates.find(
    (candidate) =>
      candidate.id === 'CRAFT:furnace' &&
      candidate.target?.x === sensedTable.x &&
      candidate.target?.y === sensedTable.y &&
      candidate.target?.z === sensedTable.z,
  )
  const retrieveFallback = candidates.find(
    (candidate) =>
      candidate.id.startsWith('RETRIEVE:known:station:crafting_table') &&
      candidate.target?.x === rememberedTable.position.x &&
      candidate.target?.y === rememberedTable.position.y &&
      candidate.target?.z === rememberedTable.position.z,
  )
  const pass = craftAtSensed === undefined && retrieveFallback !== undefined && retrieveFallback.meta.prereqPath === 'craft_and_place'
  return { pass, detail: `candidates=[${candidates.map((candidate) => candidate.id).join(',')}]` }
})

addCase('(live) craft 1 x furnace + no table held or remembered still crafts one from logs', () => {
  const state = worldState({
    position: { x: 39, y: 10, z: 34 },
    inventory: inventory({ cobblestone: 119, oak_log: 3 }),
    signals: signals(),
    current: craftCurrent('furnace'),
  })

  const candidates = generateCandidates(state, craftOptions)
  const craft = candidates.find((candidate) => candidate.kind === 'CRAFT')
  const productive = candidates.filter((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')
  const pass = craft !== undefined && productive.length > 0
  return { pass, detail: `candidates=[${candidates.map((candidate) => candidate.id).join(',')}]` }
})

addCase('a 2x2 craft goal never acquires a table', () => {
  const state = worldState({
    position: { x: 39, y: 10, z: 34 },
    inventory: inventory({ oak_log: 1 }),
    signals: signals({ knownResources: [rememberedTable] }),
    current: craftCurrent('oak_planks'),
  })

  const candidates = generateCandidates(state, craftOptions)
  const retrieve = candidates.find((candidate) => candidate.id.startsWith('RETRIEVE:known:station'))
  const craft = candidates.find((candidate) => candidate.id === 'CRAFT:oak_planks')
  const pass = retrieve === undefined && craft !== undefined
  return { pass, detail: `candidates=[${candidates.map((candidate) => candidate.id).join(',')}]` }
})

// --- (M2 placed-station) a verified placement is itself station proof --------

addCase('(placed-station) a verified furnace placement registers the registered cell once', () => {
  const at: Vec3Json = { x: 31, y: 61, z: 35 }
  const stations: KnownResource[] = []
  const first = registerPlacedStation(stations, 'furnace', at)
  const again = registerPlacedStation(stations, 'furnace', at)
  const line = formatStationRegisteredPlaced('furnace', at)
  const pass =
    PLACED_STATION_ITEMS.has('furnace') &&
    first.added === true &&
    again.added === false &&
    stations.length === 1 &&
    stations[0]?.name === 'furnace' &&
    stations[0]?.kind === 'station' &&
    stations[0]?.position.x === 31 &&
    stations[0]?.position.y === 61 &&
    stations[0]?.position.z === 35 &&
    line === 'STATION_REGISTERED kind=furnace source=placed at=31,61,35' &&
    MIRRORED_MARKERS.has('STATION_REGISTERED')
  return { pass, detail: `added=${first.added}/${again.added} stations=${stations.length} line="${line}" mirrored=${MIRRORED_MARKERS.has('STATION_REGISTERED')}` }
})

addCase('(placed-station) the host registration detail renders STATION_REGISTERED kind=furnace source=placed at=31,61,35', () => {
  const detail = stationRegisteredPlacedDetail('furnace', { x: 31, y: 61, z: 35 })
  const line = `STATION_REGISTERED ${Object.entries(detail).map(([key, value]) => `${key}=${String(value)}`).join(' ')}`
  const pass = line === 'STATION_REGISTERED kind=furnace source=placed at=31,61,35'
  return { pass, detail: line }
})

addCase('(placed-station) an unverified/failed placement emits no FURNACE_READY and registers nothing', () => {
  const at: Vec3Json = { x: 31, y: 61, z: 35 }
  const air = placedStationReadyLine('furnace', null, at)
  const wrongBlock = placedStationReadyLine('furnace', 'cobblestone', at)
  const table = placedStationReadyLine('crafting_table', 'crafting_table', at)
  const verified = placedStationReadyLine('furnace', 'furnace', at)
  const pass =
    air === null &&
    wrongBlock === null &&
    table === null &&
    verified === 'FURNACE_READY source=placed at=31,61,35'
  return { pass, detail: `air=${air ?? 'null'} wrong=${wrongBlock ?? 'null'} table=${table ?? 'null'} verified="${verified ?? 'null'}"` }
})

addCase('(placed-station) FURNACE_READY is deterministic per verified placement and the registration fires once per cell', () => {
  const at: Vec3Json = { x: 31, y: 61, z: 35 }
  const stations: KnownResource[] = []
  const readyLines: string[] = []
  let registrations = 0
  for (let observation = 0; observation < 2; observation += 1) {
    const line = placedStationReadyLine('furnace', 'furnace', at)
    if (line !== null) readyLines.push(line)
    if (registerPlacedStation(stations, 'furnace', at).added) registrations += 1
  }
  const pass =
    readyLines.length === 2 &&
    readyLines[0] === readyLines[1] &&
    readyLines[0] === 'FURNACE_READY source=placed at=31,61,35' &&
    registrations === 1 &&
    stations.length === 1
  return { pass, detail: `ready="${readyLines[0] ?? 'null'}" emissions=${readyLines.length} registrations=${registrations} stations=${stations.length}` }
})

addCase('(placed-station) a registered-but-not-sensed furnace yields the walk-to-then-smelt RETRIEVE, never WAIT-only', () => {
  const at: Vec3Json = { x: 31, y: 61, z: 35 }
  const registered: StationEntry = { ...at, source: 'remembered' }
  const inputs = inventory({ raw_iron: 8, coal: 7 })
  const state = worldState({ inventory: inputs, furnaces: [registered] })
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const productive = candidates.filter((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')
  const retrieve = productive.find((candidate) => candidate.id.startsWith('RETRIEVE:known:station:furnace'))
  const unregistered = generateCandidates(worldState({ inventory: inputs }), defaultCandidateOptions)
  const starved = unregistered.every((candidate) => candidate.kind === 'WAIT' || candidate.kind === 'ESCALATE')
  const pass =
    retrieve !== undefined &&
    retrieve.meta.furnaceSource === 'known' &&
    retrieve.label.includes('to smelt') &&
    productive.length > 0 &&
    starved
  return {
    pass,
    detail: `registered=[${candidates.map((candidate) => candidate.id).join(',')}] unregistered=[${unregistered.map((candidate) => candidate.id).join(',')}]`,
  }
})

// --- (b) bounded placement retry --------------------------------------------

addCase('(b) a failed placement retries at the spot up to the bound', () => {
  const at: Vec3Json = { x: 10, y: 64, z: -3 }
  const first = evaluatePlaceRetry({ at, reason: 'verify_failed', priorRetries: 0 })
  const last = evaluatePlaceRetry({ at, reason: 'verify_failed', priorRetries: PLACE_RETRY_LIMIT - 1 })
  const over = evaluatePlaceRetry({ at, reason: 'verify_failed', priorRetries: PLACE_RETRY_LIMIT })
  const pass =
    first.retry === true &&
    first.count === 1 &&
    first.line === 'PLACE_RETRY at=10,64,-3 reason=verify_failed' &&
    last.retry === true &&
    last.count === PLACE_RETRY_LIMIT &&
    over.retry === false &&
    over.count === PLACE_RETRY_LIMIT + 1
  return { pass, detail: `first=${first.retry}/${first.count} last=${last.retry}/${last.count} over=${over.retry}/${over.count}` }
})

addCase('(b) a failed spot rotates the next PLACE retry a few blocks away', () => {
  const a: Vec3Json = { x: 28, y: 61, z: 35 }
  const b: Vec3Json = { x: 31, y: 61, z: 35 }
  const state = worldState({
    inventory: heldFurnaceInventory,
    placementSpots: [a, b],
    signals: signals({ failedCandidates: { 'PLACE:furnace:p28_61_35': 1 } }),
  })
  const candidate = generateCandidates(state, defaultCandidateOptions).find((entry) => entry.kind === 'PLACE')
  const pass = candidate !== undefined && candidate.id === 'PLACE:furnace:p31_61_35'
  return { pass, detail: candidate === undefined ? 'no PLACE' : candidate.id }
})

// --- (c) one-line abandon reason --------------------------------------------

addCase('(c) the abandon reason is logged for beta and each deterministic cause', () => {
  const lines = [
    formatAbandonReason('PLACE:furnace', classifyAbandonReason({ beta: 1, lastFailureCode: null, candidateFailures: 0, escalationRecommended: false })),
    formatAbandonReason('PLACE:furnace', classifyAbandonReason({ beta: 1, lastFailureCode: 'path_no_path', candidateFailures: 0, escalationRecommended: false })),
    formatAbandonReason('PLACE:furnace', classifyAbandonReason({ beta: 1, lastFailureCode: null, candidateFailures: 2, escalationRecommended: false })),
    formatAbandonReason('PLACE:furnace', classifyAbandonReason({ beta: 1, lastFailureCode: null, candidateFailures: 0, escalationRecommended: true })),
  ]
  const expected = [
    'ABANDON_REASON option=PLACE:furnace reason=β',
    'ABANDON_REASON option=PLACE:furnace reason=unreachable',
    'ABANDON_REASON option=PLACE:furnace reason=blocked',
    'ABANDON_REASON option=PLACE:furnace reason=no_progress',
  ]
  const pass = lines.every((line, index) => line === expected[index])
  return { pass, detail: lines.join(' | ') }
})

// --- fixture: held furnace -> PLACE -> SMELT -> SMELT_DONE -------------------

addCase('fixture: protected PLACE leads to a SMELT candidate and SMELT_DONE', async () => {
  const spot: Vec3Json = { x: 31, y: 61, z: 35 }
  const beforePlace = worldState({ inventory: heldFurnaceInventory, placementSpots: [spot] })
  const place = generateCandidates(beforePlace, defaultCandidateOptions).find((entry) => entry.kind === 'PLACE')
  const currentGoal = beforePlace.goalQueue.current
  const guard = shouldAdoptAbandon({
    actionId: place?.id ?? null,
    goals: currentGoal === null ? [] : [currentGoal],
    placedFurnaceCount: 0,
    abandonRequested: true,
  })
  if (place === undefined || guard.adopt) {
    return { pass: false, detail: `place=${place?.id ?? 'none'} adopt=${guard.adopt}` }
  }

  const afterPlace = worldState({ inventory: inventory({ raw_iron: 3, coal: 1 }), furnaces: [{ ...spot, source: 'sensed' }], placementSpots: [spot] })
  const smelt = generateCandidates(afterPlace, defaultCandidateOptions).find((entry) => entry.kind === 'SMELT')
  if (smelt === undefined) return { pass: false, detail: 'no SMELT candidate after the placement' }

  const stash: Record<string, number> = { raw_iron: 3, coal: 1, iron_ingot: 0 }
  let pending = 0
  const window: SmeltFurnaceWindow = {
    putInput: async (_type, _meta, count) => {
      pending = count
      stash.raw_iron = (stash.raw_iron ?? 0) - count
    },
    putFuel: async () => {
      stash.coal = (stash.coal ?? 0) - 1
    },
    outputItem: () => (pending > 0 ? { count: 1 } : null),
    takeOutput: async () => {
      pending -= 1
      stash.iron_ingot = (stash.iron_ingot ?? 0) + 1
    },
    close: () => undefined,
  }
  const lines: string[] = []
  const outcome = await executeFurnaceSmelt(
    {
      openFurnace: async () => window,
      inventoryItems: () => Object.entries(stash).map(([name, count], index) => ({ name, type: index, count })),
      countItem: (name) => stash[name] ?? 0,
      wait: async () => undefined,
      ensureOwned: () => undefined,
      timeoutMs: 5000,
      log: (event, detail) => lines.push(formatSmeltLog(event, detail)),
    },
    { inputItem: 'raw_iron', fuelItem: 'coal', outputItem: 'iron_ingot', inputCount: 3, fuelCount: 1 },
  )
  const done = lines.find((line) => line.startsWith('SMELT_DONE'))
  const pass = outcome.gained === 1 && (stash.iron_ingot ?? 0) === 1 && done !== undefined
  return { pass, detail: `smelt=${smelt.id} target=${smelt.target?.x},${smelt.target?.y},${smelt.target?.z} | ${done ?? 'no SMELT_DONE'}` }
})

let failures = 0
process.stdout.write('furnace placement protection + retry (#46)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} furnace-place cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
