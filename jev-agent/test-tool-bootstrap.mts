// test-tool-bootstrap.mts - THE COLD BOOTSTRAP: "a body that cannot clear the
// cell blocking it must be able to obtain the tool that clears it, and a craft
// that needs a station must be able to reach one (sensed / carried / crafted)".
//
// THE MEASURED LIVE FREEZE (main 67388ac, run-mudlqw62-19miy, the operator's
// floated-portal trial, generation gen-mudlroc8-lev5py at 2026-09-23T04:28:24Z):
//
//   REACHABILITY candidate=ENTER:26,67,9 reachable=false reason=needs_ascend
//     missing=["headroom@-8,52,-6"]
//     fingerprint=rv1|26,67,9|needs_ascend|missing=[headroom@-8,52,-6]|gap=ascend_far|
//     place=1|tools=[]|hazard=0|approach=1|head=0|foot=0
//   CANDIDATE_ACQUISITION_REFUSED candidate=ENTER:26,67,9 missing=headroom@-8,52,-6
//     reason=no_producer item=null count=null held=null tools=none   (92x)
//   CANDIDATE_STARVATION presented=2 productive=0 goal=place:nether_portal:1
//
// The body held 81 oak_log and no pickaxe of any tier. The measurement below
// separates the two facts the live line conflated:
//
//   (b) the headroom cell's tool requirement was never derived, because the CELL
//       ITSELF WAS NEVER READ: `DIMENSION_READ_REFUSED cell=-8,52,-6 chunk=-1,-1
//       provenance=unknown reason=unknown_column source=world-state` is the
//       sensor refusing that read, so the cut is the `block === null` shape
//       (`name:'unknown'`, `safe:false`) and no harvest family exists to derive.
//       That is a missing READ, not a missing producer, and case (vii) pins the
//       typed marker that says so instead of inventing a tool;
//   (a)/(c) the station chain itself EXISTS and is live: with a cell whose
//       requirement IS derivable (a stone-family cut, cases (i1)-(i5)) the body
//       is offered planks -> sticks -> crafting_table -> place -> wooden_pickaxe,
//       and once the pickaxe is held the blocked cell is diggable again.
//
// Fixtures (the operator's five, plus the two evidence shapes):
//   (i)   THE LIVE SHAPE: logs, no table, no pickaxe, a stone headroom cell
//   (ii)  a reachable sensed table -> the historical route, offer byte-identical
//   (iii) a carried table -> placed and used; unplaceable -> typed no_station
//   (iv)  no logs and no table -> typed refusal naming the item and count
//   (v)   control with a pickaxe already held -> nothing new offered
//   (vi)  an EMPTY inventory and a standing tree -> a working tool is reachable
//   (vii) an unread headroom cell -> `cell_unread cell=...`, no invented tool
//
//   cd jev-agent && bun ./test-tool-bootstrap.mts
import { createRequire } from 'node:module'
import {
  applyReachabilityGate,
  defaultCandidateOptions,
  formatCandidateAcquisitionRefused,
  generateGroundedCandidates,
} from './src/candidates.ts'
import type { Candidate, CandidateAcquisition, CandidateOptions, CandidateReachability } from './src/candidates.ts'
import { candidateStarvationLine, candidateStarvationMissing, MIRRORED_MARKERS } from './src/controller-legacy.ts'
import { capabilityKey } from './src/reachability.ts'
import { createRecipeIndex } from './src/crafting.ts'
import type {
  AgentSignals,
  BlockState,
  GoalState,
  InventoryState,
  SelfState,
  StationEntry,
  Vec3Json,
  WorldState,
} from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'

const require = createRequire(import.meta.url)
const recipes = createRecipeIndex(require('minecraft-data')('1.21.11') as unknown)

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}
const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

// The measured body position and the cell the ascend column refused.
const FEET: Vec3Json = { x: -7.5, y: 51, z: -5.5 }
const HEAD_CELL: Vec3Json = { x: -8, y: 52, z: -6 }
const ABOVE: Vec3Json = { x: 26, y: 67, z: 9 }
const PLACE_SPOT: Vec3Json = { x: -6, y: 51, z: -6 }
const LOG_BLOCK: Vec3Json = { x: -6, y: 51, z: -5 }
const STONE_CUT = { pos: HEAD_CELL, name: 'stone', safe: true, reason: 'safe', currentFootprint: true }
const UNREAD_CUT = { pos: HEAD_CELL, name: 'unknown', safe: false, reason: 'cell is unloaded/unknown', currentFootprint: true }

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_TOOL_BOOTSTRAP',
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
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, count) => sum + count, 0) }
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
    id: 'g179:place:nether_portal',
    description: 'place 1 x nether_portal',
    targetItem: 'nether_portal',
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
    id: 'g179:place:nether_portal',
    kind: 'place',
    description: 'place 1 x nether_portal',
    targetItem: 'nether_portal',
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

function queue(): GoalQueueState {
  const current = queuedGoal()
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

/** The measured live state: the ascend blocked by the cell above the body's head. */
function liveState(overrides: {
  inventory: Record<string, number>
  headroomCuts?: WorldState['headroomCuts']
  blocks?: BlockState[]
  standable?: Vec3Json[]
  placementSpots?: WorldState['placementSpots']
  craftingTables?: StationEntry[]
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(FEET),
    inventory: inventory(overrides.inventory),
    entities: [],
    blocks: overrides.blocks ?? [],
    terrain: { standable: overrides.standable ?? [FEET] },
    craftingTables: overrides.craftingTables ?? [],
    furnaces: [],
    placementSpots: overrides.placementSpots ?? [],
    descent: [],
    stepCuts: [],
    headroomCuts: overrides.headroomCuts ?? [STONE_CUT],
    goal: goal(),
    goalQueue: queue(),
    recentEvents: [],
    signals: signals(),
  }
}

/** The measured live entry candidate: a locomotion leg to a cell far above. */
function entryCandidate(): Candidate {
  return {
    id: 'ENTER:26,67,9',
    kind: 'ENTER_PORTAL',
    label: 'walk into the lit nether portal at (26,67,9)',
    targetName: 'nether_portal',
    target: ABOVE,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: { tick: 7 },
  }
}

/** The measured standing tree: a sensed log a bare hand can harvest. */
function treeBlock(): BlockState {
  return {
    kind: 'log',
    name: 'oak_log',
    position: LOG_BLOCK,
    distance: 1.5,
    diggable: true,
    inReach: true,
    hasAdjacentStandable: true,
    adjacentStandable: LOG_BLOCK,
    yield: 'oak_log',
    harvestTool: null,
    harvestTier: null,
    visible: true,
  }
}

const options: CandidateOptions = { ...defaultCandidateOptions, recipes }

function entryFor(gate: { withheld: CandidateReachability[] }, id: string): CandidateReachability | null {
  return gate.withheld.find((entry) => entry.candidate.id === id) ?? null
}

function acquisitionFor(entry: CandidateReachability, missing: string): CandidateAcquisition | null {
  return (entry.acquisition ?? []).find((fact) => fact.missing === missing) ?? null
}

function refusalLine(entry: CandidateReachability, missing: string): string {
  const fact = acquisitionFor(entry, missing)
  return fact === null ? 'none' : formatCandidateAcquisitionRefused(entry.candidate.id, fact)
}

function ids(candidates: readonly Candidate[]): string[] {
  return candidates.map((candidate) => candidate.id)
}

function acquisitionIds(gate: { candidates: Candidate[] }): string[] {
  return ids(gate.candidates.filter((candidate) => candidate.meta.capabilityAcquisition === true))
}

// ---------------------------------------------------------------------------
// (i) THE LIVE SHAPE: a stone headroom cell + logs in hand -> the bootstrap.
// ---------------------------------------------------------------------------
addCase('(i1) the blocked ascend names the tool its clearance needs, and the tool route is offered', () => {
  const state = liveState({ inventory: { oak_log: 81, dirt: 140 } })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const entry = entryFor(gate, 'ENTER:26,67,9')
  const missing = (entry?.result.missingCapabilities ?? []).map(capabilityKey)
  const tool = entry === null ? null : acquisitionFor(entry, 'tool:pickaxe@0')
  return {
    pass:
      missing.includes(`headroom@${HEAD_CELL.x},${HEAD_CELL.y},${HEAD_CELL.z}`) &&
      missing.includes('tool:pickaxe@0') &&
      tool !== null &&
      tool.routes.includes('CRAFT:oak_planks') &&
      acquisitionIds(gate).includes('CRAFT:oak_planks'),
    detail: `missing=[${missing.join(',')}] routes=[${(tool?.routes ?? []).join(',')}] offer=[${ids(gate.candidates).join(',')}]`,
  }
})

addCase('(i2) the chain is enumerable step by step: planks -> sticks -> crafting_table', () => {
  const step = (counts: Record<string, number>): string[] => {
    const gate = applyReachabilityGate([entryCandidate()], liveState({ inventory: { dirt: 140, ...counts } }), options)
    return acquisitionIds(gate)
  }
  const logs = step({ oak_log: 81 })
  const planks = step({ oak_log: 81, oak_planks: 4 })
  const sticks = step({ oak_log: 81, oak_planks: 4, stick: 4 })
  return {
    pass:
      logs.includes('CRAFT:oak_planks') &&
      planks.includes('CRAFT:stick') &&
      sticks.includes('CRAFT:crafting_table'),
    detail: `logs=[${logs.join(',')}] planks=[${planks.join(',')}] sticks=[${sticks.join(',')}]`,
  }
})

addCase('(i3) the station a tool needs is reached from a CARRIED table (placed, then used)', () => {
  const carried = { oak_log: 81, oak_planks: 4, stick: 4, crafting_table: 1 }
  const gate = applyReachabilityGate(
    [entryCandidate()],
    liveState({ inventory: carried, placementSpots: [PLACE_SPOT] }),
    options,
  )
  const entry = entryFor(gate, 'ENTER:26,67,9')
  const tool = entry === null ? null : acquisitionFor(entry, 'tool:pickaxe@0')
  const place = tool?.routes.find((id) => id.startsWith('PLACE:crafting_table')) ?? null
  return {
    pass: place === `PLACE:crafting_table:p${PLACE_SPOT.x}_${PLACE_SPOT.y}_${PLACE_SPOT.z}` && place !== null,
    detail: `routes=[${(tool?.routes ?? []).join(',')}] offer=[${ids(gate.candidates).join(',')}]`,
  }
})

addCase('(i4) with the station PLACED (sensed, reachable) the tool craft itself is offered', () => {
  const state = liveState({
    inventory: { oak_log: 81, oak_planks: 4, stick: 4 },
    craftingTables: [{ ...PLACE_SPOT, source: 'sensed', name: 'crafting_table' } as StationEntry],
  })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const entry = entryFor(gate, 'ENTER:26,67,9')
  const tool = entry === null ? null : acquisitionFor(entry, 'tool:pickaxe@0')
  return {
    pass:
      tool !== null &&
      tool.routes.includes('CRAFT:wooden_pickaxe') &&
      acquisitionIds(gate).includes('CRAFT:wooden_pickaxe') &&
      // The sensed station is the route: the 2x2 station craft must NOT compete.
      !acquisitionIds(gate).includes('CRAFT:crafting_table'),
    detail: `routes=[${(tool?.routes ?? []).join(',')}] offer=[${ids(gate.candidates).join(',')}]`,
  }
})

addCase('(i5) once the pickaxe is held the blocked cell is diggable, and clearing it returns the ascent', () => {
  const armed = applyReachabilityGate(
    [entryCandidate()],
    liveState({ inventory: { oak_log: 81, dirt: 140, wooden_pickaxe: 1 } }),
    options,
  )
  const armedEntry = entryFor(armed, 'ENTER:26,67,9')
  const mine = armed.candidates.find((candidate) => candidate.kind === 'MINE')
  const stillNeedsTool = (armedEntry?.result.missingCapabilities ?? []).some(
    (capability) => capability.kind === 'tool',
  )
  // The cell is cleared: the ascend offer must come back (the measured live
  // pillar route: a placeable block held + the jump cell clear).
  const cleared = applyReachabilityGate(
    [entryCandidate()],
    liveState({
      inventory: { oak_log: 81, dirt: 140, wooden_pickaxe: 1 },
      headroomCuts: [],
      standable: [FEET, { x: -6, y: 51, z: -6 }, { x: -7, y: 51, z: -6 }],
    }),
    options,
  )
  return {
    pass:
      mine !== undefined &&
      mine.target !== null &&
      mine.target.x === HEAD_CELL.x &&
      mine.target.y === HEAD_CELL.y &&
      mine.target.z === HEAD_CELL.z &&
      !stillNeedsTool &&
      cleared.candidates.some((candidate) => candidate.id === 'ENTER:26,67,9'),
    detail: `mine=${mine?.id ?? 'none'} needsTool=${stillNeedsTool} clearedOffer=[${ids(cleared.candidates).join(',')}]`,
  }
})

// ---------------------------------------------------------------------------
// (ii) THE HISTORICAL ROUTE: a reachable sensed table -> the craft, byte-identical.
// ---------------------------------------------------------------------------
addCase('(ii) a reachable sensed station keeps the historical offer byte-identical', () => {
  const state = liveState({
    inventory: { oak_log: 81, oak_planks: 4, stick: 4 },
    craftingTables: [{ ...PLACE_SPOT, source: 'sensed', name: 'crafting_table' } as StationEntry],
  })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const grounded = generateGroundedCandidates(state, options)
  return {
    pass:
      // The historical route: ONE in-place craft at the sensed station, no
      // station-source step competing with it.
      ids(gate.candidates).join(',') === 'CRAFT:wooden_pickaxe' &&
      !ids(grounded.candidates).includes('CRAFT:crafting_table') &&
      ids(grounded.candidates).includes('WAIT'),
    detail: `offer=[${ids(gate.candidates).join(',')}] grounded=[${ids(grounded.candidates).join(',')}]`,
  }
})

// ---------------------------------------------------------------------------
// (iii) A CARRIED STATION: placed when it can be; a typed station refusal when not.
// ---------------------------------------------------------------------------
addCase('(iii1) an unplaceable carried station refuses as a STATION fact, never as a missing material', () => {
  const state = liveState({
    inventory: { oak_log: 81, oak_planks: 4, stick: 4, crafting_table: 1 },
    placementSpots: [],
  })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const entry = entryFor(gate, 'ENTER:26,67,9')
  const fact = entry === null ? null : acquisitionFor(entry, 'tool:pickaxe@0')
  const line = entry === null ? 'none' : refusalLine(entry, 'tool:pickaxe@0')
  return {
    pass:
      fact !== null &&
      fact.routes.length === 0 &&
      fact.reason === 'no_station' &&
      fact.item === 'crafting_table' &&
      fact.count === 1 &&
      fact.held === 1 &&
      line ===
        'CANDIDATE_ACQUISITION_REFUSED candidate=ENTER:26,67,9 missing=tool:pickaxe@0 reason=no_station item=crafting_table count=1 held=1 tools=pickaxe:-1' &&
      // the tool is never named as its own missing material
      !line.includes('item=wooden_pickaxe'),
    detail: line,
  }
})

// ---------------------------------------------------------------------------
// (iv) NO LOGS AND NO TABLE: typed refusal naming the item and count, no dig.
// ---------------------------------------------------------------------------
addCase('(iv) with nothing carried the refusal names the item and the count, and nothing is dug', () => {
  const state = liveState({ inventory: {} })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const entry = entryFor(gate, 'ENTER:26,67,9')
  const fact = entry === null ? null : acquisitionFor(entry, 'tool:pickaxe@0')
  const line = entry === null ? 'none' : refusalLine(entry, 'tool:pickaxe@0')
  const dig = gate.candidates.filter((candidate) => candidate.kind === 'MINE')
  return {
    pass:
      fact !== null &&
      fact.routes.length === 0 &&
      fact.reason === 'no_material' &&
      fact.item !== null &&
      (fact.count ?? 0) >= 1 &&
      /reason=no_material item=\S+ count=\d+/.test(line) &&
      dig.length === 0,
    detail: `${line} :: digs=[${ids(dig).join(',')}]`,
  }
})

// ---------------------------------------------------------------------------
// (v) CONTROL: a pickaxe already held -> nothing new is offered.
// ---------------------------------------------------------------------------
addCase('(v) a body that already holds the tool gets no craft step for it', () => {
  const state = liveState({
    inventory: { oak_log: 81, oak_planks: 4, stick: 4, crafting_table: 1, wooden_pickaxe: 1 },
    placementSpots: [PLACE_SPOT],
  })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const crafts = ids(gate.candidates).filter((id) => id.startsWith('CRAFT:'))
  return {
    pass: crafts.length === 0 && gate.candidates.some((candidate) => candidate.kind === 'MINE'),
    detail: `offer=[${ids(gate.candidates).join(',')}] crafts=[${crafts.join(',')}]`,
  }
})

// ---------------------------------------------------------------------------
// (vi) THE ACCEPTANCE SHAPE: an EMPTY inventory and a standing tree.
// ---------------------------------------------------------------------------
addCase('(vi) from an empty inventory and a standing tree the tool route starts at the log', () => {
  const state = liveState({
    inventory: {},
    blocks: [treeBlock()],
    standable: [FEET, LOG_BLOCK],
  })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const entry = entryFor(gate, 'ENTER:26,67,9')
  const tool = entry === null ? null : acquisitionFor(entry, 'tool:pickaxe@0')
  return {
    pass:
      tool !== null &&
      tool.routes.some((id) => id === `MINE:b${LOG_BLOCK.x}_${LOG_BLOCK.y}_${LOG_BLOCK.z}`),
    detail: `routes=[${(tool?.routes ?? []).join(',')}] offer=[${ids(gate.candidates).join(',')}]`,
  }
})

// ---------------------------------------------------------------------------
// (vii) AN UNREAD CELL: the refusal names the missing READ, not a producer.
// ---------------------------------------------------------------------------
addCase('(vii1) a headroom cell the sensor never read is named as such, and no tool is invented', () => {
  const state = liveState({ inventory: { oak_log: 81, dirt: 140 }, headroomCuts: [UNREAD_CUT] })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const entry = entryFor(gate, 'ENTER:26,67,9')
  const fact = entry === null ? null : acquisitionFor(entry, 'headroom@-8,52,-6')
  const line = entry === null ? 'none' : refusalLine(entry, 'headroom@-8,52,-6')
  const missing = (entry?.result.missingCapabilities ?? []).map(capabilityKey)
  return {
    pass:
      fact !== null &&
      fact.reason === 'cell_unread' &&
      fact.cell !== null &&
      fact.cell !== undefined &&
      fact.cell.x === HEAD_CELL.x &&
      fact.cell.y === HEAD_CELL.y &&
      fact.cell.z === HEAD_CELL.z &&
      line ===
        'CANDIDATE_ACQUISITION_REFUSED candidate=ENTER:26,67,9 missing=headroom@-8,52,-6 reason=cell_unread cell=-8,52,-6 tools=none' &&
      // the requirement is NOT derivable here, so no tool capability exists and
      // no craft is fabricated for it
      !missing.includes('tool:pickaxe@0') &&
      !acquisitionIds(gate).some((id) => id.startsWith('CRAFT:')),
    detail: `${line} :: missing=[${missing.join(',')}] offer=[${ids(gate.candidates).join(',')}]`,
  }
})

addCase('(vii2) the unread cell keeps the starvation visible instead of a silent WAIT', () => {
  const state = liveState({ inventory: { oak_log: 81, dirt: 140 }, headroomCuts: [UNREAD_CUT] })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const line = candidateStarvationLine(
    gate.candidates,
    'place:nether_portal:1',
    false,
    'no_productive_action',
    candidateStarvationMissing(gate.withheld),
  )
  return {
    pass: line !== null && line.includes('headroom@-8,52,-6'),
    detail: line ?? 'none',
  }
})

// ---------------------------------------------------------------------------
// (viii) THE MARKERS: typed, mirrored, and byte-shaped.
// ---------------------------------------------------------------------------
addCase('(viii) the acquisition refusals are typed, mirrored and byte-stable', () => {
  const base: Omit<CandidateAcquisition, 'missing' | 'reason' | 'item' | 'count' | 'held' | 'cell' | 'tools'> = {
    routes: [],
  }
  const station: CandidateAcquisition = {
    ...base,
    missing: 'tool:pickaxe@0',
    reason: 'no_station',
    item: 'crafting_table',
    count: 1,
    held: 1,
    cell: null,
    tools: 'pickaxe:-1',
  }
  const unread: CandidateAcquisition = {
    ...base,
    missing: 'headroom@-8,52,-6',
    reason: 'cell_unread',
    item: null,
    count: null,
    held: null,
    cell: HEAD_CELL,
    tools: 'none',
  }
  const material: CandidateAcquisition = {
    ...base,
    missing: 'tool:pickaxe@0',
    reason: 'no_material',
    item: 'oak_planks',
    count: 3,
    held: 0,
    tools: 'pickaxe:-1',
  }
  return {
    pass:
      formatCandidateAcquisitionRefused('ENTER:26,67,9', station) ===
        'CANDIDATE_ACQUISITION_REFUSED candidate=ENTER:26,67,9 missing=tool:pickaxe@0 reason=no_station item=crafting_table count=1 held=1 tools=pickaxe:-1' &&
      formatCandidateAcquisitionRefused('ENTER:26,67,9', unread) ===
        'CANDIDATE_ACQUISITION_REFUSED candidate=ENTER:26,67,9 missing=headroom@-8,52,-6 reason=cell_unread cell=-8,52,-6 tools=none' &&
      formatCandidateAcquisitionRefused('ENTER:26,67,9', material) ===
        'CANDIDATE_ACQUISITION_REFUSED candidate=ENTER:26,67,9 missing=tool:pickaxe@0 reason=no_material item=oak_planks count=3 held=0 tools=pickaxe:-1' &&
      MIRRORED_MARKERS.has('CANDIDATE_ACQUISITION') &&
      MIRRORED_MARKERS.has('CANDIDATE_ACQUISITION_REFUSED'),
    detail: `mirrored=${MIRRORED_MARKERS.has('CANDIDATE_ACQUISITION_REFUSED')}`,
  }
})

let passed = 0
for (const testCase of cases) {
  const outcome = testCase.run()
  if (outcome.pass) passed += 1
  process.stdout.write(`${outcome.pass ? 'PASS' : 'FAIL'} ${testCase.name}\n        ${outcome.detail}\n`)
}
process.stdout.write(`\n${passed}/${cases.length} tool-bootstrap cases passed\n`)
if (passed !== cases.length) process.exit(1)
