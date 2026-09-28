// test-acquisition-route.mts - acquisition routes apply to required harvest
// outputs and other real preconditions. A clearance dig consumes no drops, so
// its block's harvest-tool requirement must not create a fake tool prerequisite.
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
// The route's headroom MINE is tagged `clearance`, carries an optional speed
// tool, and is executable without that harvest tool. The cases below also keep
// strict tool acquisition coverage for resource harvests and required drops.
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
import { ensureCraftStepActionable } from './src/candidate-diagnostics.ts'
import { candidateStarvationLine, candidateStarvationMissing, MIRRORED_MARKERS } from './src/controller.ts'
import {
  filterRetiredRepeats,
  RepeatedOutcomeEscalation,
  repeatedOutcomeCell,
  repeatedOutcomeFactSignature,
  repeatedOutcomeSemanticProgress,
  repeatedOutcomeToken,
  REPEATED_OUTCOME_LIMIT_DEFAULT,
} from './src/repeatedOutcomeEscalation.ts'
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
  stepCuts?: WorldState['stepCuts']
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
    stepCuts: overrides.stepCuts ?? [],
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
// (i) THE MEASURED SHAPE: the ascend remains withheld until headroom is cleared,
//     while its grounded clearance action is offered without a drop-tool gate.
// ---------------------------------------------------------------------------
addCase('(i) an ascend names headroom while its clearance is offered without a pickaxe', () => {
  const state = liveState({ inventory: { cobblestone: 177, oak_log: 81, flint: 4 } })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const entry = withheldEntry(gate, 'ENTER:26,67,9')
  const missing = (entry?.result.missingCapabilities ?? []).map(capabilityKey)
  const clearance = gate.candidates.find((candidate) => candidate.meta.clearance === true)
  return {
    pass:
      entry !== null &&
      entry.result.reason === 'needs_ascend' &&
      missing.includes('headroom@27,62,15') &&
      !missing.some((capability) => capability.startsWith('tool:')) &&
      clearance !== undefined &&
      clearance.requiresTool === false &&
      clearance.toolName === null,
    detail: `reason=${entry?.result.reason ?? 'offered'} missing=[${missing.join(',')}] clearance=${clearance?.id ?? 'none'} requiresTool=${clearance?.requiresTool}`,
  }
})

addCase('(i) the acquisition pass does not bootstrap a tool for a clearance-only blocker', () => {
  const state = liveState({ inventory: { cobblestone: 177, oak_log: 81, flint: 4 } })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const entry = withheldEntry(gate, 'ENTER:26,67,9')
  const toolFacts = entry?.acquisition?.filter((fact) => fact.missing.startsWith('tool:')) ?? []
  const toolRoutes = gate.candidates.filter(
    (candidate) => typeof candidate.meta.missingCapability === 'string' && candidate.meta.missingCapability.startsWith('tool:'),
  )
  return {
    pass: entry?.withheld === true && toolFacts.length === 0 && toolRoutes.length === 0,
    detail: `withheld=${entry?.withheld ?? false} missing=[${(entry?.result.missingCapabilities ?? []).map(capabilityKey).join(',')}] toolFacts=${toolFacts.length} toolRoutes=${toolRoutes.map((c) => c.id).join(',') || 'none'}`,
  }
})

addCase('(i) clearing headroom makes the entry offerable without a pickaxe', () => {
  const state = liveState({ inventory: { cobblestone: 177, oak_log: 81 } })
  state.headroomCuts = []
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const entry = withheldEntry(gate, 'ENTER:26,67,9')
  return {
    pass: entry === null && gate.candidates.some((candidate) => candidate.id === 'ENTER:26,67,9'),
    detail: `withheld=[${gate.withheld.map((w) => w.candidate.id).join(',')}] offered=[${gate.candidates.map((c) => c.id).join(',')}]`,
  }
})

// ---------------------------------------------------------------------------
// (ii) An unobserved clearance cell is refused as missing world truth, not
//      misreported as a missing harvest tool.
// ---------------------------------------------------------------------------
addCase('(ii) unread clearance has a typed refusal and no tool-acquisition route', () => {
  const state = liveState({
    inventory: { cobblestone: 177, flint: 4, dirt: 128 },
    headroomCuts: [{ pos: HEAD_CELL, name: 'unknown', safe: false, reason: 'unloaded/unknown', currentFootprint: true }],
  })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const entry = withheldEntry(gate, 'ENTER:26,67,9')
  const fact = entry === null ? null : acquisitionFor(entry, 'headroom@27,62,15')
  const toolFacts = entry?.acquisition?.filter((candidate) => candidate.missing.startsWith('tool:')) ?? []
  return {
    pass:
      entry !== null &&
      fact?.reason === 'cell_unread' &&
      entry.result.reason === 'needs_ascend' &&
      gate.candidates.every((candidate) => candidate.meta.clearance !== true) &&
      toolFacts.length === 0,
    detail: `reason=${entry?.result.reason ?? 'offered'} headroom=${fact?.reason ?? 'none'} clearance=${gate.candidates.some((candidate) => candidate.meta.clearance === true)} toolFacts=${toolFacts.length}`,
  }
})

addCase('(ii) a safe-looking cut with an unregistered block name is not offered', () => {
  const state = liveState({
    inventory: { cobblestone: 177, flint: 4, dirt: 128 },
    headroomCuts: [
      { pos: HEAD_CELL, name: 'modded_unlisted_block', safe: true, reason: 'safe', currentFootprint: true },
    ],
  })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  return {
    pass: !gate.candidates.some((candidate) => candidate.meta.clearance === true),
    detail: `clearance=${gate.candidates.find((candidate) => candidate.meta.clearance === true)?.id ?? 'none'} offer=[${gate.candidates.map((candidate) => candidate.id).join(',')}]`,
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

addCase('(iv) holding a pickaxe only changes the optional clearance speed tool', () => {
  const state = liveState({ inventory: { cobblestone: 177, oak_log: 81, stone_pickaxe: 1 } })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const entry = withheldEntry(gate, 'ENTER:26,67,9')
  const missing = (entry?.result.missingCapabilities ?? []).map(capabilityKey)
  const clearance = gate.candidates.find((candidate) => candidate.meta.clearance === true)
  const toolFacts = (entry?.acquisition ?? []).filter((fact) => fact.missing.startsWith('tool:'))
  return {
    pass:
      clearance !== undefined &&
      clearance.requiresTool === false &&
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

addCase('(vii) a stone clearance remains productive without material/tool starvation', () => {
  const state = liveState({ inventory: { cobblestone: 177, flint: 4, dirt: 128 } })
  const gate = applyReachabilityGate([entryCandidate()], state, options)
  const line = candidateStarvationLine(
    gate.candidates,
    'place:nether_portal:1',
    false,
    'no_productive_action',
    candidateStarvationMissing(gate.withheld),
  )
  const clearance = gate.candidates.find((candidate) => candidate.meta.clearance === true)
  return {
    pass:
      line === null &&
      clearance !== undefined &&
      clearance.requiresTool === false &&
      !gate.withheld.some((entry) => (entry.acquisition ?? []).some((fact) => fact.missing.startsWith('tool:'))),
    detail: `starvation=${line ?? 'none'} clearance=${clearance?.id ?? 'none'} requiresTool=${clearance?.requiresTool}`,
  }
})

// ---------------------------------------------------------------------------
// (viii) The step-cut action is clearance too. It may use a held tool as a speed
//        preference, but its route does not need harvest drops.
// ---------------------------------------------------------------------------
const STEP_CUT: NonNullable<WorldState['stepCuts']>[number] = {
  dir: 'S',
  dx: 0,
  dz: 1,
  cut: { x: 23, y: 80, z: 8 },
  step: { x: 23, y: 80, z: 8 },
  name: 'stone',
  safe: true,
  reason: 'safe',
}

/** The measured live step-cut cell is terrain, so the resource index is empty. */
function stepState(
  inventoryCounts: Record<string, number>,
  stepCuts = [STEP_CUT],
  standable: Vec3Json[] = [FEET, { x: 27, y: 62, z: 15 }],
): WorldState {
  return liveState({ inventory: inventoryCounts, headroomCuts: [], stepCuts, standable })
}

/**
 * A locomotion leg with no standable approach, which is the live route-opening
 * shape the step-cut arm answers (`routeOpeningCandidates`): the MOVE is withheld
 * and the STEP is offered as the route that opens it.
 */
function approachlessMove(): Candidate {
  return {
    id: 'MOVE:p40_61_15',
    kind: 'MOVE',
    label: 'walk to (40,61,15)',
    targetName: null,
    target: { x: 40, y: 61, z: 15 },
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: false,
    meta: { tick: 7 },
  }
}

const stepWithheld = (gate: { withheld: CandidateReachability[] }): CandidateReachability | null =>
  gate.withheld.find((entry) => entry.candidate.kind === 'STEP') ?? null

const stepOffered = (gate: { candidates: Candidate[] }): Candidate | undefined =>
  gate.candidates.find((candidate) => candidate.kind === 'STEP')

addCase('(viii) a stone step cut is offered as clearance without a pickaxe', () => {
  const gate = applyReachabilityGate([approachlessMove()], stepState({ oak_log: 81, cobblestone: 177 }), options)
  const withheld = stepWithheld(gate)
  const offered = stepOffered(gate)
  return {
    pass:
      offered !== undefined &&
      offered.id === 'STEP:S:b23_80_8' &&
      offered.meta.clearance === true &&
      offered.requiresTool === false &&
      withheld === null,
    detail: `offered=${offered?.id ?? 'none'} clearance=${offered?.meta.clearance} requiresTool=${offered?.requiresTool} withheld=${withheld?.result.reason ?? 'none'}`,
  }
})

addCase('(viii) a held pickaxe is an optional speed tool for the step cut', () => {
  const gate = applyReachabilityGate(
    [approachlessMove()],
    stepState({ oak_log: 81, cobblestone: 177, wooden_pickaxe: 1 }),
    options,
  )
  const offered = stepOffered(gate)
  return {
    pass: offered !== undefined && offered.requiresTool === false && offered.toolName === 'pickaxe',
    detail: `offered=${offered?.id ?? 'none'} requiresTool=${offered?.requiresTool} tool=${offered?.toolName ?? 'none'}`,
  }
})

addCase('(viii) an unknown step cut is withheld rather than offered as clearance', () => {
  const unknownCut = { ...STEP_CUT, name: 'unknown', safe: false, reason: 'unloaded' }
  const gate = applyReachabilityGate([approachlessMove()], stepState({ cobblestone: 177, flint: 4, dirt: 128 }, [unknownCut], [FEET]), options)
  const withheld = stepWithheld(gate)
  return {
    pass: stepOffered(gate) === undefined && withheld === null,
    detail: `offered=${stepOffered(gate)?.id ?? 'none'} withheld=${withheld?.result.reason ?? 'none'}`,
  }
})

addCase('(viii) control: with the tool held the same step cut is offered, tool declared', () => {
  const gate = applyReachabilityGate([approachlessMove()], stepState({ oak_log: 3, wooden_pickaxe: 1 }), options)
  const offered = stepOffered(gate)
  return {
    pass:
      offered !== undefined &&
      offered.id === 'STEP:S:b23_80_8' &&
      offered.requiresTool === false &&
      offered.toolName === 'pickaxe' &&
      offered.toolTier === 0 &&
      stepWithheld(gate) === null,
    detail: `offered=${offered?.id ?? 'none'} requiresTool=${offered?.requiresTool} tool=${offered?.toolName}@${offered?.toolTier}`,
  }
})

addCase('(viii) a hand-diggable step cut is unaffected (no invented requirement)', () => {
  const dirtCut = { ...STEP_CUT, name: 'dirt' }
  const gate = applyReachabilityGate([approachlessMove()], stepState({ oak_log: 3 }, [dirtCut]), options)
  const offered = stepOffered(gate)
  return {
    pass:
      offered !== undefined && offered.requiresTool === false && offered.toolName === null && stepWithheld(gate) === null,
    detail: `offered=${offered?.id ?? 'none'} requiresTool=${offered?.requiresTool} tool=${offered?.toolName}`,
  }
})

// ---------------------------------------------------------------------------
// (p18.1) REVALIDATION PARITY: the fresh offer is rebuilt through the same
//         controller-side transforms as the decision offer (repeated-outcome
//         prune, then the deterministic craft backfill). Measured live
//         (portal-p18, run-mukohc1f): a known station made `craftCandidates`
//         answer `craft:crafting_table` with station-acquisition MOVEs; the
//         repeated-outcome prune retired them at decision time, so the backfill
//         added `CRAFT:oak_planks` to Jev's offer. The old revalidation path
//         skipped both transforms, kept the retired move, and vetoed the chosen
//         craft "vanished" on every tick - 741 vetoes in one stall.
// ---------------------------------------------------------------------------

function craftGoalState(inventoryCounts: Record<string, number>): WorldState {
  const base = liveState({ inventory: inventoryCounts, headroomCuts: [] })
  const current: QueuedGoal = {
    id: 'g15:craft:crafting_table',
    kind: 'craft',
    description: 'craft 1 x crafting_table',
    targetItem: 'crafting_table',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
  return {
    ...base,
    goal: {
      ...base.goal,
      id: 'craft:crafting_table:1',
      description: 'craft 1 x crafting_table',
      targetItem: 'crafting_table',
    },
    goalQueue: { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] },
  }
}

const STATION_MOVE_TARGET: Vec3Json = { x: 3220, y: 42, z: 2817 }
const stationMove: Candidate = {
  id: 'MOVE:p3220_42_2817',
  kind: 'MOVE',
  label: 'walk to the remembered crafting table at (3220,42,2817)',
  targetName: 'crafting_table',
  target: STATION_MOVE_TARGET,
  targetEntityId: null,
  itemName: null,
  requiresTool: false,
  toolName: null,
  inReach: true,
  hasStandableAdjacent: true,
  meta: { tick: 7, x: 3220, y: 42, z: 2817 },
}
const waitCandidate: Candidate = {
  id: 'WAIT',
  kind: 'WAIT',
  label: 'do nothing for one tick',
  targetName: null,
  target: null,
  targetEntityId: null,
  itemName: null,
  requiresTool: false,
  toolName: null,
  inReach: true,
  hasStandableAdjacent: true,
  meta: { tick: 7 },
}

function stationMoveObservation(cycle: number): Parameters<RepeatedOutcomeEscalation['note']>[0] {
  return {
    actionId: stationMove.id,
    actionShape: 'MOVE:p*',
    cell: repeatedOutcomeCell('overworld', STATION_MOVE_TARGET, FEET),
    outcome: repeatedOutcomeToken({ failure: 'path_stuck', status: 'failed', verified: false }),
    failureCode: 'path_stuck',
    semanticProgress: repeatedOutcomeSemanticProgress({ progressKinds: ['none'], itemsGained: 0, blockRemoved: false }),
    factSignature: repeatedOutcomeFactSignature({
      affordanceFingerprint: 'rv1|3220,42,2817|reachable|missing=[]|place=0|tools=[]|hazard=0|approach=1|head=1|foot=1',
      planIdentity: 'g15:craft:crafting_table',
      worldKey: 'overworld|epoch=1',
    }),
    now: 1_000 + cycle,
  }
}

addCase('(p18.1-a) the parity set keeps the chosen backfilled craft once the dead move retires', () => {
  const state = craftGoalState({ oak_log: 4, stick: 2 })
  const ledger = new RepeatedOutcomeEscalation({ limit: REPEATED_OUTCOME_LIMIT_DEFAULT })
  for (let cycle = 0; cycle < REPEATED_OUTCOME_LIMIT_DEFAULT; cycle += 1) {
    ledger.note(stationMoveObservation(cycle * 2))
  }
  const { kept, withheld } = filterRetiredRepeats([stationMove, waitCandidate], ledger, 'overworld', FEET)
  const parity = ensureCraftStepActionable(state, kept, options)
  return {
    pass:
      withheld.length === 1 &&
      withheld[0]?.candidate.id === stationMove.id &&
      parity.some((candidate) => candidate.id === 'CRAFT:oak_planks'),
    detail: `withheld=${withheld.map((entry) => entry.candidate.id).join(',') || 'none'} parity=${parity.map((candidate) => candidate.id).join(',')}`,
  }
})

addCase('(p18.1-b) control: while a productive candidate survives the backfill stays silent', () => {
  const state = craftGoalState({ oak_log: 4, stick: 2 })
  const parity = ensureCraftStepActionable(state, [stationMove, waitCandidate], options)
  return {
    pass: parity.every((candidate) => candidate.id !== 'CRAFT:oak_planks'),
    detail: `parity=${parity.map((candidate) => candidate.id).join(',')}`,
  }
})

// p19.1: survival armament. The goal-driven arm only fires for required kills
// (a collect whose item is a mob drop); a body under ordinary attack with the
// materials for a weapon was never offered it (live: 12 contact deaths with
// oak_planks+stick+crafting_table carried, weapon=fists every swing).
addCase('(p19.1-a) an unarmed body carrying sword materials is offered the arm-up route', () => {
  const state = liveState({ inventory: { oak_planks: 4, stick: 2, crafting_table: 1 } })
  const grounded = generateGroundedCandidates(state, options)
  const armRoute = grounded.candidates.filter((candidate) => candidate.meta.combatKit === 'sword')
  return {
    pass: armRoute.length > 0,
    detail: `arming=[${armRoute.map((candidate) => candidate.id).join(',') || 'none'}] offered=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
  }
})

addCase('(p19.1-b) self-limiting: an already-armed body gets no arm-up route', () => {
  const state = liveState({ inventory: { stone_sword: 1, oak_planks: 4, stick: 2, crafting_table: 1 } })
  const grounded = generateGroundedCandidates(state, options)
  const pass = grounded.candidates.every((candidate) => candidate.meta.combatKit !== 'sword')
  return { pass, detail: `offered=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]` }
})

addCase('(p19.1-c) no materials, no fabricated route: the offer stays silent', () => {
  const state = liveState({ inventory: {} })
  const grounded = generateGroundedCandidates(state, options)
  const pass = grounded.candidates.every((candidate) => candidate.meta.combatKit !== 'sword')
  return { pass, detail: `offered=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]` }
})

// ---------------------------------------------------------------------------
// (p19.2) MULTI-SITE KNOWN RETRIEVAL: `knownResourceFor` returned the single
//         nearest remembered cell, so when that one route burned its failure
//         budget the whole RETRIEVE arm went silent even though other sites
//         were still remembered (live: jungle_log across the water retired on
//         path_stuck x6; the 80m oak site was never offered). The arm now
//         enumerates the bounded nearest DISTINCT sites.
// ---------------------------------------------------------------------------

function collectLogState(overrides: {
  knownResources: NonNullable<AgentSignals['knownResources']>
  failedCandidates?: Record<string, number>
}): WorldState {
  const base = liveState({ inventory: {}, headroomCuts: [] })
  const current: QueuedGoal = {
    id: 'g1:collect:log',
    kind: 'collect',
    description: 'collect 3 x log',
    targetItem: 'log',
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
    ...base,
    goal: {
      ...base.goal,
      id: 'collect:log:3',
      description: 'collect 3 x log',
      targetItem: 'log',
    },
    goalQueue: { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] },
    signals: signals({ knownResources: overrides.knownResources, failedCandidates: overrides.failedCandidates ?? {} }),
  }
}

// NOTE: both sites sit past KNOWN_RESOURCE_PROOF_DISTANCE (8m) - a remembered
// cell nearer than that and absent from `blocks` is honestly falsified-depleted.
const NEAR_LOG = { name: 'oak_log', kind: 'log' as const, position: { x: 35, y: 61, z: 8 }, dimension: 'overworld', worldEpoch: 1 }
const NEAR_LOG_TOP = { name: 'oak_log', kind: 'log' as const, position: { x: 35, y: 64, z: 8 }, dimension: 'overworld', worldEpoch: 1 }
const FAR_LOG = { name: 'oak_log', kind: 'log' as const, position: { x: 50, y: 63, z: -30 }, dimension: 'overworld', worldEpoch: 1 }

/** every id a want produced, offered or gated-withheld */
function allCandidateIds(grounded: { candidates: Candidate[]; withheld: CandidateReachability[] }): string[] {
  return [
    ...grounded.candidates.map((candidate) => candidate.id),
    ...grounded.withheld.map((entry) => entry.candidate.id),
  ]
}

addCase('(p19.2-a) a failure-retired nearest site no longer silences the farther remembered site', () => {
  const state = collectLogState({
    knownResources: [NEAR_LOG, FAR_LOG],
    failedCandidates: { 'RETRIEVE:known:log:b35_61_8': 4 },
  })
  const ids = allCandidateIds(generateGroundedCandidates(state, options))
  return {
    pass:
      ids.includes('RETRIEVE:known:log:b50_63_-30') &&
      !ids.includes('RETRIEVE:known:log:b35_61_8'),
    detail: `retrieves=[${ids.filter((id) => id.startsWith('RETRIEVE')).join(',') || 'none'}]`,
  }
})

addCase('(p19.2-b) cells of one trunk dedupe to one site (bounded enumeration, not per-block noise)', () => {
  const state = collectLogState({ knownResources: [NEAR_LOG, NEAR_LOG_TOP] })
  const ids = allCandidateIds(generateGroundedCandidates(state, options)).filter((id) =>
    id.startsWith('RETRIEVE:known:'),
  )
  return { pass: ids.length === 1, detail: `retrieves=[${ids.join(',')}]` }
})

addCase('(p19.2-c) all remembered sites retired keeps the offer silent (retire machinery owns the retry)', () => {
  const state = collectLogState({
    knownResources: [NEAR_LOG, FAR_LOG],
    failedCandidates: { 'RETRIEVE:known:log:b35_61_8': 4, 'RETRIEVE:known:log:b50_63_-30': 4 },
  })
  const ids = allCandidateIds(generateGroundedCandidates(state, options))
  const pass = ids.every((id) => !id.startsWith('RETRIEVE:'))
  return { pass, detail: `ids=[${ids.join(',') || 'none'}]` }
})

addCase('(p19.2-d) control: two unretired distinct sites both reach the gate', () => {
  const state = collectLogState({ knownResources: [NEAR_LOG, FAR_LOG] })
  const ids = allCandidateIds(generateGroundedCandidates(state, options))
  return {
    pass:
      ids.includes('RETRIEVE:known:log:b35_61_8') &&
      ids.includes('RETRIEVE:known:log:b50_63_-30'),
    detail: `retrieves=[${ids.filter((id) => id.startsWith('RETRIEVE')).join(',') || 'none'}]`,
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
