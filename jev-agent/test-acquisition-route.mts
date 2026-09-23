// test-acquisition-route.mts - THE ACQUISITION ROUTE for a withheld mechanical
// fact: "a grounded candidate is withheld because a mechanical precondition is
// absent; the precondition is obtainable from the world or from carried
// materials; therefore a grounded acquisition route exists and must be offered
// (or a typed, actionable refusal must be reported)".
//
// THE MEASURED LIVE SHAPE (main 38cbb22, the operator's floated-portal trial):
//
//   CANDIDATE_WITHHELD candidate=ENTER:26,67,9 kind=ENTER_PORTAL reachable=false
//     reason=needs_ascend missing=["headroom@27,62,15"]
//     fingerprint=rv1|26,67,9|needs_ascend|missing=[headroom@27,62,15]|gap=ascend_far|
//     place=1|tools=[]|hazard=0|approach=1|head=0|foot=0 suppressed=true
//   CANDIDATE_STARVATION presented=2 productive=0 goal=place:nether_portal:1
//     blockedBy=no_productive_action missing=["ENTER:26,67,9:headroom@27,62,15"] repeat=7
//
//   -> the offer was [WAIT, ESCALATE] ONLY, the body was frozen at
//      (27.5,61.0,15.5) hp 20, and the inventory held NO pickaxe of any tier
//      (flint_and_steel 1, flint 4, diamond_sword 1, iron_ingot 2, raw_iron 2,
//      furnace 1, oak_log 81, cobblestone 177, dirt 128, soul_soil 222).
//
// The clearance cell is TERRAIN, so the scanner's resource index did not carry
// it; the tool need was therefore never derived (`tools=[]`), the clearance MINE
// advertised `requiresTool=false`, and the lease dug the block bare-handed into
// `dig_timeout` until move-failure memory retired the cut - after which the
// missing fact had no acquisition route at all and nothing in the run turned
// "the climb needs the cell above cleared" into "get a tool".
//
// The cases below pin the general contract, not the incident: no coordinate, no
// milestone ordering and no "if the goal is the portal then ..." appears in the
// implementation. The withheld candidate STAYS withheld in every case.
//
//   bun ./test-acquisition-route.mts
import { createRequire } from 'node:module'
import {
  applyReachabilityGate,
  defaultCandidateOptions,
  formatCandidateAcquisition,
  formatCandidateAcquisitionRefused,
  generateGroundedCandidates,
} from './src/candidates.ts'
import type { Candidate, CandidateAcquisition, CandidateReachability } from './src/candidates.ts'
import { candidateStarvationLine, candidateStarvationMissing, MIRRORED_MARKERS } from './src/controller-legacy.ts'
import { capabilityKey } from './src/reachability.ts'
import { createRecipeIndex } from './src/crafting.ts'
import type { AgentSignals, BlockState, GoalState, InventoryState, SelfState, Vec3Json, WorldState } from './src/state.ts'
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
const FEET: Vec3Json = { x: 27.5, y: 61, z: 15.5 }
const HEAD_CELL: Vec3Json = { x: 27, y: 62, z: 15 }
const ABOVE: Vec3Json = { x: 26, y: 67, z: 9 }

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_ACQ',
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
    id: 'place:nether_portal:1',
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
    id: 'g1:place:nether_portal',
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

/**
 * The measured live state: the body stands in its column with the jump cell
 * above its head blocked by a block the bare hand cannot harvest, exactly as the
 * sensor reports it (`headroomCuts` carries NAME truth; the scanner's resource
 * index does not carry terrain).
 */
function liveState(overrides: {
  inventory: Record<string, number>
  headroomCuts?: WorldState['headroomCuts']
  blocks?: BlockState[]
  standable?: Vec3Json[]
  placementSpots?: WorldState['placementSpots']
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
    craftingTables: [],
    furnaces: [],
    placementSpots: overrides.placementSpots ?? [],
    descent: [],
    stepCuts: [],
    headroomCuts:
      overrides.headroomCuts ?? [
        { pos: HEAD_CELL, name: 'stone', safe: true, reason: 'safe', currentFootprint: true },
      ],
    goal: goal(),
    goalQueue: queue(),
    recentEvents: [],
    signals: signals(),
  }
}

/** The withheld entry for the entry candidate, or null when it stayed offerable. */
function withheldEntry(gate: { withheld: CandidateReachability[] }, id: string): CandidateReachability | null {
  return gate.withheld.find((entry) => entry.candidate.id === id) ?? null
}

function acquisitionFor(entry: CandidateReachability, missing: string): CandidateAcquisition | null {
  return (entry.acquisition ?? []).find((fact) => fact.missing === missing) ?? null
}

/** The measured live entry candidate: a locomotion leg to a cell above. */
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

const options = { ...defaultCandidateOptions, recipes }

// ---------------------------------------------------------------------------
// (i) THE MEASURED LIVE SHAPE: an ascend withheld for a headroom cell whose
//     clearance needs a tool that is craftable from carried materials.
// ---------------------------------------------------------------------------
addCase('(i) an ascend withheld for a headroom cell names the tool the clearance needs', () => {
  const state = liveState({ inventory: { cobblestone: 177, oak_log: 81, flint: 4 } })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const entry = withheldEntry(gate, 'ENTER:26,67,9')
  const missing = (entry?.result.missingCapabilities ?? []).map(capabilityKey)
  return {
    pass:
      entry !== null &&
      entry.result.reason === 'needs_ascend' &&
      missing.includes('headroom@27,62,15') &&
      // THE BREAK: this tool fact is what the measured run never had (`tools=[]`).
      missing.includes('tool:pickaxe@0'),
    detail: `reason=${entry?.result.reason ?? 'offered'} missing=[${missing.join(',')}]`,
  }
})

addCase('(i) the acquisition pass offers a grounded craft route for the missing tool', () => {
  const state = liveState({ inventory: { cobblestone: 177, oak_log: 81, flint: 4 } })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const entry = withheldEntry(gate, 'ENTER:26,67,9')
  const fact = entry === null ? null : acquisitionFor(entry, 'tool:pickaxe@0')
  const productive = gate.candidates.filter(
    (candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE',
  )
  // The route must be a candidate Jev can CHOOSE (not a marker), and it must be
  // the acquisition for the missing tool - never the withheld entry itself.
  const crafted = productive.filter((candidate) => candidate.meta.capabilityAcquisition === true)
  return {
    pass:
      fact !== null &&
      fact.routes.length > 0 &&
      crafted.length > 0 &&
      crafted.every((candidate) => candidate.meta.missingCapability === 'tool:pickaxe@0') &&
      entry?.withheld === true,
    detail: `routes=[${(fact?.routes ?? []).join(',')}] tools=${fact?.tools ?? 'none'} offered=[${productive.map((c) => c.id).join(',')}]`,
  }
})

addCase('(i) executing the acquisition route makes the withheld entry offerable again', () => {
  // The mechanical effect of the offered route: the body ends up holding a
  // pickaxe and the headroom cell is cleared (that is what the craft route plus
  // the MINE lease it points at produce). No other fact is changed.
  const state = liveState({ inventory: { cobblestone: 177, oak_log: 81, wooden_pickaxe: 1 } })
  state.headroomCuts = []
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const entry = withheldEntry(gate, 'ENTER:26,67,9')
  return {
    pass: entry === null && gate.candidates.some((candidate) => candidate.id === 'ENTER:26,67,9'),
    detail: `withheld=[${gate.withheld.map((w) => w.candidate.id).join(',')}] offered=[${gate.candidates.map((c) => c.id).join(',')}]`,
  }
})

// ---------------------------------------------------------------------------
// (ii) THE SAME SHAPE WITH NO OBTAINABLE MATERIAL: typed refusal naming the
//      missing item and count, and no doomed attempt.
// ---------------------------------------------------------------------------
addCase('(ii) no obtainable material yields a typed refusal naming item and count', () => {
  // Cobblestone is held (so the pillar's placeable fact is satisfied) and no log,
  // plank or station exists anywhere: the tool cannot be made.
  const state = liveState({ inventory: { cobblestone: 177, flint: 4, dirt: 128 } })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const entry = withheldEntry(gate, 'ENTER:26,67,9')
  const fact = entry === null ? null : acquisitionFor(entry, 'tool:pickaxe@0')
  const line = entry === null || fact === null ? null : formatCandidateAcquisitionRefused('ENTER:26,67,9', fact)
  return {
    pass:
      fact !== null &&
      fact.routes.length === 0 &&
      fact.reason === 'no_material' &&
      typeof fact.item === 'string' &&
      (fact.count ?? 0) >= 1 &&
      line !== null &&
      line.includes(`item=${fact.item}`) &&
      line.includes(`count=${fact.count}`),
    detail: line ?? `routes=[${(fact?.routes ?? []).join(',')}]`,
  }
})

addCase('(ii) no attempt: the undiggable clearance cell is withheld, never offered', () => {
  const state = liveState({ inventory: { cobblestone: 177, flint: 4, dirt: 128 } })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const clearance = gate.candidates.find((candidate) => candidate.meta.clearance === true)
  const withheldClearance = gate.withheld.find((entry) => entry.candidate.meta.clearance === true)
  const starvation = candidateStarvationLine(
    gate.candidates,
    'place:nether_portal:1',
    false,
    'no_productive_action',
    candidateStarvationMissing(gate.withheld),
  )
  return {
    pass:
      clearance === undefined &&
      withheldClearance !== undefined &&
      withheldClearance.result.reason === 'missing_tool' &&
      starvation !== null,
    detail: `offeredClearance=${clearance?.id ?? 'none'} withheldClearance=${withheldClearance?.result.reason ?? 'none'} starvation=${starvation ?? 'none'}`,
  }
})

// ---------------------------------------------------------------------------
// (iii) A MISSING MATERIAL (not a tool): the ascend needs a placeable block the
//       body does not hold, so the acquisition routes to the MATERIAL producer.
// ---------------------------------------------------------------------------
const PLACEABLE: BlockState = {
  kind: 'stone',
  name: 'dirt',
  position: { x: 29, y: 61, z: 15 },
  distance: 2,
  diggable: true,
  inReach: true,
  hasAdjacentStandable: true,
  adjacentStandable: { x: 28, y: 61, z: 15 },
  yield: 'dirt',
  harvestTool: null,
  harvestTier: null,
  visible: true,
}

addCase('(iii) a missing material fact routes to the grounded producer of that material', () => {
  const state = liveState({
    inventory: { oak_log: 81, flint: 4 },
    headroomCuts: [],
    blocks: [PLACEABLE],
    standable: [FEET, { x: 28, y: 61, z: 15 }],
  })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const entry = withheldEntry(gate, 'ENTER:26,67,9')
  const missing = (entry?.result.missingCapabilities ?? []).map(capabilityKey)
  const fact = entry === null ? null : acquisitionFor(entry, 'placeable_block')
  const route = (fact?.routes ?? []).map((id) => gate.candidates.find((candidate) => candidate.id === id))
  return {
    pass:
      missing.includes('placeable_block') &&
      fact !== null &&
      fact.reason === null &&
      fact.routes.length > 0 &&
      route.some((candidate) => candidate?.kind === 'MINE' && candidate.target?.x === 29) &&
      entry?.withheld === true,
    detail: `missing=[${missing.join(',')}] routes=[${(fact?.routes ?? []).join(',')}] offered=[${gate.candidates.map((c) => c.id).join(',')}]`,
  }
})

// ---------------------------------------------------------------------------
// (iv) CONTROL: the precondition is already satisfied. The offer must be
//      byte-identical to the pre-acquisition behaviour - no invented route and
//      no acquisition evidence.
// ---------------------------------------------------------------------------
addCase('(iv) a satisfied precondition changes nothing (byte-identical offer)', () => {
  const state = liveState({
    inventory: { cobblestone: 177, oak_log: 81, stone_pickaxe: 1 },
    headroomCuts: [],
  })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const ids = gate.candidates.map((candidate) => candidate.id).sort()
  const acquisition = gate.withheld.flatMap((entry) => entry.acquisition ?? [])
  return {
    pass:
      ids.join('|') === 'ENTER:26,67,9' &&
      gate.withheld.length === 0 &&
      acquisition.length === 0,
    detail: `ids=[${ids.join(',')}] withheld=${gate.withheld.length} acquisition=${acquisition.length}`,
  }
})

addCase('(iv) a held tool keeps the clearance cell offerable and invents no tool route', () => {
  const state = liveState({ inventory: { cobblestone: 177, oak_log: 81, stone_pickaxe: 1 } })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const entry = withheldEntry(gate, 'ENTER:26,67,9')
  const missing = (entry?.result.missingCapabilities ?? []).map(capabilityKey)
  const clearance = gate.candidates.find((candidate) => candidate.meta.clearance === true)
  const toolFacts = (entry?.acquisition ?? []).filter((fact) => fact.missing.startsWith('tool:'))
  return {
    pass:
      clearance !== undefined &&
      clearance.requiresTool === true &&
      clearance.toolName === 'pickaxe' &&
      missing.includes('headroom@27,62,15') &&
      !missing.some((key) => key.startsWith('tool:')) &&
      toolFacts.length === 0,
    detail: `missing=[${missing.join(',')}] clearance=${clearance?.id ?? 'none'} requiresTool=${clearance?.requiresTool}`,
  }
})

// ---------------------------------------------------------------------------
// (v) THE CLOSURE: the acquisition route is ITSELF withheld for a deeper
//     mechanical fact, and the route for that fact is still offered. This is the
//     general "prerequisite of a prerequisite" case - no incident shape.
// ---------------------------------------------------------------------------
addCase('(v) a second-order prerequisite is expanded: the route to the route is offered', () => {
  // The ascend needs a placeable block. The only producer is stone, which needs a
  // pickaxe the body does not hold - so the acquisition MINE is itself withheld
  // and the closure must expand the tool fact it introduced.
  const state = liveState({
    inventory: { oak_log: 81, flint: 4 },
    headroomCuts: [],
    blocks: [{ ...PLACEABLE, name: 'stone', yield: 'cobblestone', harvestTool: 'pickaxe', harvestTier: 0 }],
    standable: [FEET, { x: 28, y: 61, z: 15 }],
  })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const entry = withheldEntry(gate, 'ENTER:26,67,9')
  const materialFact = entry === null ? null : acquisitionFor(entry, 'placeable_block')
  const productive = gate.candidates.filter(
    (candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE',
  )
  const toolRoute = productive.filter((candidate) => candidate.meta.missingCapability === 'tool:pickaxe@0')
  const withheldMaterial = gate.withheld.find(
    (w) => w.candidate.meta.capabilityAcquisition === true && w.candidate.kind === 'MINE',
  )
  return {
    pass:
      materialFact !== null &&
      materialFact.routes.length > 0 &&
      withheldMaterial !== undefined &&
      withheldMaterial.result.reason === 'missing_tool' &&
      toolRoute.length > 0,
    detail: `materialRoutes=[${(materialFact?.routes ?? []).join(',')}] withheldAcq=${withheldMaterial?.candidate.id}:${withheldMaterial?.result.reason} toolRoutes=[${toolRoute.map((c) => c.id).join(',')}]`,
  }
})

// ---------------------------------------------------------------------------
// (vi) MARKER SHAPES: the evidence is typed and mirrored, names the withheld
//      candidate, the missing fact, the route (or the typed reason), and the
//      tool state it was decided against.
// ---------------------------------------------------------------------------
addCase('(vi) the acquisition markers have the required shape', () => {
  const routed: CandidateAcquisition = {
    missing: 'headroom@27,62,15',
    routes: ['MINE:b27_62_15'],
    reason: null,
    item: null,
    count: null,
    held: null,
    tools: 'none',
  }
  const refused: CandidateAcquisition = {
    missing: 'tool:pickaxe@0',
    routes: [],
    reason: 'no_material',
    item: 'oak_planks',
    count: 3,
    held: 0,
    tools: 'pickaxe:-1',
  }
  const line = formatCandidateAcquisition('ENTER:26,67,9', routed)
  const refusal = formatCandidateAcquisitionRefused('ENTER:26,67,9', refused)
  // MIRRORED: both markers must reach the live record plane, not only the
  // generation-local sink (an unmirrored marker never reaches `buddy.log`, so a
  // reviewer cannot see which acquisition route the withheld fact produced).
  const mirrored =
    MIRRORED_MARKERS.has('CANDIDATE_ACQUISITION') && MIRRORED_MARKERS.has('CANDIDATE_ACQUISITION_REFUSED')
  return {
    pass:
      line === 'CANDIDATE_ACQUISITION candidate=ENTER:26,67,9 missing=headroom@27,62,15 route=MINE:b27_62_15 tools=none' &&
      refusal ===
        'CANDIDATE_ACQUISITION_REFUSED candidate=ENTER:26,67,9 missing=tool:pickaxe@0 reason=no_material item=oak_planks count=3 held=0 tools=pickaxe:-1' &&
      mirrored,
    detail: `mirrored=${mirrored} :: ${line} ;; ${refusal}`,
  }
})

// ---------------------------------------------------------------------------
// (vii) THE ASSEMBLED OFFER: the live shape no longer collapses to the
//       WAIT/ESCALATE starvation the operator measured, and the no-material
//       shape still reports the typed refusal instead of silence.
// ---------------------------------------------------------------------------
addCase('(vii) the assembled offer for the live shape is not a WAIT/ESCALATE starvation', () => {
  const state = liveState({ inventory: { cobblestone: 177, oak_log: 81, flint: 4 } })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const productive = gate.candidates.filter(
    (candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE',
  )
  const line = candidateStarvationLine(
    gate.candidates,
    'place:nether_portal:1',
    false,
    'no_productive_action',
    candidateStarvationMissing(gate.withheld),
  )
  return {
    pass: productive.length > 0 && line === null && withheldEntry(gate, 'ENTER:26,67,9') !== null,
    detail: `productive=[${productive.map((c) => c.id).join(',')}] starvation=${line ?? 'none'}`,
  }
})

addCase('(vii) the no-material shape keeps the starvation AND names the item it needs', () => {
  const state = liveState({ inventory: { cobblestone: 177, flint: 4, dirt: 128 } })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const line = candidateStarvationLine(
    gate.candidates,
    'place:nether_portal:1',
    false,
    'no_productive_action',
    candidateStarvationMissing(gate.withheld),
  )
  const refusals = gate.withheld.flatMap((entry) => (entry.acquisition ?? []).filter((fact) => fact.routes.length === 0))
  return {
    pass:
      line !== null &&
      refusals.some((fact) => fact.reason === 'no_material' && fact.item !== null && (fact.count ?? 0) >= 1),
    detail: `starvation=${line ?? 'none'} refusals=[${refusals.map((f) => `${f.missing}:${f.reason}:${f.item}x${f.count}`).join(',')}]`,
  }
})

let failures = 0
process.stdout.write('acquisition route - a withheld mechanical fact gets a grounded route or a typed refusal\n')
process.stdout.write('-'.repeat(78) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(78) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} acquisition-route cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
