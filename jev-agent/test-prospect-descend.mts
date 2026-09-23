// test-prospect-descend.mts - the exposure dig a descend-to-acquire row is missing.
//
// Measured (live run-muc3qbug-18vg3, main 4f4e0cb): a `descend_to:Y=-54` row for
// `raw_iron` walked a 1-wide staircase from y=63 to y=8 in ~40 minutes and
// raw_iron stayed at 2. The 110-decision descend window offered
// `{DESCEND} 100x, {RETRIEVE} 7x, {ESCALATE} 2x, {MINE} 1x`: the ore arm WAS
// called and legitimately had nothing to offer. A MINE needs a producer that is
// in reach AND pickup-adjacent (or has a walk-up stand); a staircase removes
// exactly the cells the body walks through and leaves solid rock everywhere
// else, so a vein one block behind a wall is sensed (name-scanned out to radius
// 64) but has no stand and is never the block any offered step digs. The
// acquisition the descent exists for therefore cannot happen en route.
//
// PROSPECT enumerates that exposure dig ALONGSIDE the descend step: the sensed
// producer's corridor at the body's own depth band, the wall in front of it, and
// the pre-computed SAFE level step that removes that wall. No bot, no network:
// the fixture supplies `buildDescent`'s steps, so hazard / breakability /
// support / tool facts stay the sensor's own typed facts.
//
// Run: bun test-prospect-descend.mts
import {
  defaultCandidateOptions,
  formatProspectRefused,
  generateGroundedCandidates,
  PROSPECT_MAX_LATERAL,
  PROSPECT_META,
  prospectCandidateId,
  prospectCandidates,
} from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type {
  AgentSignals,
  BlockState,
  DescentDigRequirement,
  DescentOption,
  GoalState,
  InventoryState,
  SelfState,
  Vec3Json,
  WorldState,
} from './src/state.ts'
import { distance } from './src/state.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const FEET: Vec3Json = { x: 28, y: 59, z: 33 }
const SELF: Vec3Json = { x: 28.5, y: 59, z: 33.5 }

function self(position: Vec3Json, overrides: Partial<SelfState> = {}): SelfState {
  return {
    username: 'AI_IRON',
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
    heldItem: { name: 'stone_pickaxe', count: 1, slot: 0 },
    ...overrides,
  }
}

function inventory(counts: Record<string, number>): InventoryState {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0) }
}

function goal(targetItem: string, kind: QueuedGoal['kind'] = 'descend'): GoalState {
  return {
    id: `${kind}:${targetItem}`,
    description: kind === 'descend' ? 'descend_to:Y=-54' : `collect 3 x ${targetItem}`,
    targetItem,
    requiredCount: 3,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(targetItem: string, overrides: Partial<QueuedGoal> = {}): QueuedGoal {
  return {
    id: 'g1',
    kind: 'descend',
    description: 'descend_to:Y=-54',
    targetItem,
    requiredCount: 3,
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

/** A sensed producer of `raw_iron`: buried unless the caller says otherwise. */
function ore(position: Vec3Json, overrides: Partial<BlockState> = {}): BlockState {
  return {
    kind: 'ore',
    name: 'iron_ore',
    position,
    distance: Math.round(distance(position, SELF) * 100) / 100,
    diggable: true,
    inReach: false,
    hasAdjacentStandable: false,
    adjacentStandable: null,
    yield: 'raw_iron',
    harvestTool: 'pickaxe',
    harvestTier: 1,
    ...overrides,
  }
}

/** One cell of a step's 1x2 profile, as the live `buildDescent` reports it. */
function dig(cell: Vec3Json, name = 'stone'): DescentDigRequirement {
  return { cell, name, harvestTool: 'pickaxe', harvestTier: 1, diggable: true }
}

function downStep(dir: DescentOption['dir'], dx: number, dz: number, feet: Vec3Json = FEET): DescentOption {
  const wall = { x: feet.x + dx, y: feet.y, z: feet.z + dz }
  const floor = { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz }
  return {
    dir,
    mode: 'down',
    dx,
    dz,
    step: { ...floor },
    wall,
    head: { x: feet.x + dx, y: feet.y + 1, z: feet.z + dz },
    floor,
    wallSolid: false,
    headSolid: false,
    floorSolid: true,
    supportSolid: true,
    hazardNearby: false,
    // the live builder's 1x2 profile: front cell (the body's upper half) first
    digs: [dig(wall), dig(floor)],
    safe: true,
    reason: 'safe',
    digName: 'stone',
    digHarvestTool: 'pickaxe',
    digHarvestTier: 1,
    diggable: true,
  }
}

/** The sensor's pre-computed level step: a solid wall at the body's own level. */
function levelStep(
  dir: DescentOption['dir'],
  dx: number,
  dz: number,
  overrides: Partial<DescentOption> = {},
  feet: Vec3Json = FEET,
): DescentOption {
  const wall = { x: feet.x + dx, y: feet.y, z: feet.z + dz }
  const head = { x: feet.x + dx, y: feet.y + 1, z: feet.z + dz }
  return {
    dir,
    mode: 'level',
    dx,
    dz,
    step: { ...wall },
    wall,
    head,
    floor: { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz },
    wallSolid: true,
    headSolid: true,
    floorSolid: true,
    supportSolid: true,
    hazardNearby: false,
    // the live builder's 1x2 corridor: solid passages first, primary last
    digs: [dig(wall), dig(head)],
    safe: true,
    reason: 'safe',
    digName: 'stone',
    digHarvestTool: 'pickaxe',
    digHarvestTier: 1,
    diggable: true,
    ...overrides,
  }
}

const ALL_LEVEL: DescentOption[] = [
  levelStep('E', 1, 0),
  levelStep('W', -1, 0),
  levelStep('N', 0, -1),
  levelStep('S', 0, 1),
]

function world(input: {
  focusItem: string
  blocks?: BlockState[]
  descent?: DescentOption[]
  current?: Partial<QueuedGoal>
  counts?: Record<string, number>
}): WorldState {
  const current = queuedGoal(input.focusItem, input.current ?? {})
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(SELF),
    inventory: inventory(input.counts ?? { stone_pickaxe: 1 }),
    entities: [],
    blocks: input.blocks ?? [],
    terrain: { standable: [FEET] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goal(input.focusItem, current.kind),
    goalQueue: queueWith(current),
    recentEvents: [],
    descent: input.descent ?? [downStep('E', 1, 0), ...ALL_LEVEL],
    stepCuts: [],
    headroomCuts: [],
    signals: signals(),
  }
}

const PROSPECT_PREFIX = 'PROSPECT:'
function prospects(candidates: readonly Candidate[]): Candidate[] {
  return candidates.filter((candidate) => candidate.id.startsWith(PROSPECT_PREFIX))
}
function descendSteps(candidates: readonly Candidate[]): Candidate[] {
  return candidates.filter((candidate) => candidate.id.startsWith('DESCEND:'))
}
function mines(candidates: readonly Candidate[]): Candidate[] {
  return candidates.filter((candidate) => candidate.kind === 'MINE')
}

// --- (a) the measured shape ------------------------------------------------------

addCase('a descend row passing a buried producer offers the exposure probe beside the descend step', () => {
  const state = world({ focusItem: 'raw_iron', blocks: [ore({ x: 31, y: 59, z: 33 })] })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const probes = prospects(grounded.candidates)
  const descends = descendSteps(grounded.candidates)
  const probe = probes[0]
  const downward = descends.find((candidate) => candidate.meta.mode === 'down' && candidate.meta.dir === 'E')
  const meta = probe?.meta ?? {}
  const pass =
    probes.length === 1 &&
    probe?.id === 'PROSPECT:level:E:b29_59_33' &&
    probe.kind === 'DESCEND' &&
    meta[PROSPECT_META] === true &&
    meta.mode === 'level' &&
    meta.dir === 'E' &&
    meta.prospectProducer === 'iron_ore' &&
    meta.prospectProducerX === 31 &&
    meta.prospectProducerY === 59 &&
    meta.prospectProducerZ === 33 &&
    meta.prospectAlong === 3 &&
    meta.prospectDeltaY === 0 &&
    meta.prospectDigKind === 'wall' &&
    meta.prospectExposure === 'branch_toward' &&
    meta.grounded === true &&
    // the step's own 1x2 dig profile is preserved: this probe digs the corridor
    // (head passage first, the wall the exposure claim names last) and steps in
    meta.digCount === 2 &&
    meta.digCells === '29,60,33;29,59,33' &&
    meta.stepX === 29 &&
    meta.stepY === 59 &&
    meta.stepZ === 33 &&
    downward?.id === 'DESCEND:down:E:b29_58_33' &&
    // Other safe level headings are also valid descent alternatives. The
    // exposure probe is appended after the ordinary route set; it never
    // replaces the downward step.
    grounded.candidates.indexOf(probe) > grounded.candidates.indexOf(downward!) &&
    grounded.withheld.every((entry) => !entry.candidate.id.startsWith(PROSPECT_PREFIX)) &&
    grounded.prospectRefusal === null &&
    mines(grounded.candidates).length === 0
  return {
    pass,
    detail: `ids=[${grounded.candidates.map((c) => c.id).join(',')}] meta=${JSON.stringify(meta)}`,
  }
})

addCase('a probe whose opened cell IS entrant keeps the step and advances the body', () => {
  // head already open: the 1x2 corridor is just the wall, and the step phase
  // advances the body into the cell it removed
  const state = world({
    focusItem: 'raw_iron',
    blocks: [ore({ x: 30, y: 59, z: 33 }, { inReach: true })],
    descent: [
      downStep('E', 1, 0),
      levelStep('E', 1, 0, { headSolid: false, digs: [dig({ x: 29, y: 59, z: 33 })] }),
      levelStep('W', -1, 0, { headSolid: false, digs: [dig({ x: 27, y: 59, z: 33 })] }),
      levelStep('N', 0, -1, { headSolid: false, digs: [dig({ x: 28, y: 59, z: 32 })] }),
      levelStep('S', 0, 1, { headSolid: false, digs: [dig({ x: 28, y: 59, z: 34 })] }),
    ],
  })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const probe = prospects(grounded.candidates)[0]
  const pass =
    probe?.meta.prospectExposure === 'exposed_by_this_dig' &&
    probe.meta.digCount === 1 &&
    probe.meta.digCells === '29,59,33' &&
    probe.meta.stepX === 29 &&
    probe.meta.stepY === 59 &&
    probe.meta.stepZ === 33
  return { pass, detail: `meta=${JSON.stringify(probe?.meta ?? {})}` }
})

addCase('an open wall with a solid head probes the head and then steps in', () => {
  const state = world({
    focusItem: 'raw_iron',
    blocks: [ore({ x: 31, y: 59, z: 33 })],
    descent: [
      downStep('E', 1, 0),
      levelStep('E', 1, 0, { wallSolid: false, digs: [dig({ x: 29, y: 60, z: 33 })] }),
    ],
  })
  const result = prospectCandidates(state, defaultCandidateOptions, 'raw_iron', -54)
  const probe = result.candidates[0]
  const pass =
    probe?.id === 'PROSPECT:level:E:b29_60_33' &&
    probe?.target?.y === 60 &&
    probe.meta.prospectDigKind === 'head' &&
    probe.meta.prospectExposure === 'branch_toward' &&
    probe.meta.digCells === '29,60,33' &&
    probe.meta.stepY === 59
  return { pass, detail: `id=${probe?.id ?? 'none'} meta=${JSON.stringify(probe?.meta ?? {})}` }
})

addCase('the probe carries the bounded branch claim and a stable id', () => {
  const state = world({ focusItem: 'raw_iron', blocks: [ore({ x: 31, y: 59, z: 33 })] })
  const result = prospectCandidates(state, defaultCandidateOptions, 'raw_iron', -54)
  const probe = result.candidates[0]
  const pass =
    result.candidates.length === 1 &&
    probe?.id === prospectCandidateId('E', { x: 29, y: 59, z: 33 }) &&
    probe?.id === 'PROSPECT:level:E:b29_59_33' &&
    probe?.target?.x === 29 &&
    probe?.target?.y === 59 &&
    probe?.target?.z === 33 &&
    probe?.label.includes('probe the E wall') &&
    probe?.label.includes('iron_ore') &&
    probe?.toolName === 'pickaxe'
  return { pass, detail: `id=${probe?.id ?? 'none'} target=${JSON.stringify(probe?.target)} label=${probe?.label ?? ''}` }
})

addCase('a producer behind a wall that is already pickup-adjacent gets the wall dig beside the MINE', () => {
  // occluded case: the producer is 2 blocks east with the solid wall between, so
  // the ordinary MINE branch (which has no `visible` fact for name-scanned ores)
  // offers a dig through rock. The wall probe is the grounded route - one dig
  // exposes the producer into the cell the body then stands in - and both offers
  // stay on the table: code enumerates CAN, Jev owns WHICH.
  const state = world({ focusItem: 'raw_iron', blocks: [ore({ x: 30, y: 59, z: 33 }, { inReach: true })] })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const probe = prospects(grounded.candidates)[0]
  const pass =
    mines(grounded.candidates).length === 1 &&
    probe?.id === 'PROSPECT:level:E:b29_59_33' &&
    probe.meta.prospectAlong === 2 &&
    probe.meta.prospectExposure === 'exposed_by_this_dig'
  return {
    pass,
    detail: `ids=[${grounded.candidates.map((c) => c.id).join(',')}] exposure=${String(probe?.meta.prospectExposure ?? 'none')}`,
  }
})

addCase('a producer one level above or below is not a lateral probe target', () => {
  const above = world({ focusItem: 'raw_iron', blocks: [ore({ x: 30, y: 60, z: 33 })] })
  const below = world({ focusItem: 'raw_iron', blocks: [ore({ x: 30, y: 58, z: 33 })] })
  const aboveResult = prospectCandidates(above, defaultCandidateOptions, 'raw_iron', -54)
  const belowResult = prospectCandidates(below, defaultCandidateOptions, 'raw_iron', -54)
  const pass =
    aboveResult.candidates.length === 0 &&
    belowResult.candidates.length === 0 &&
    aboveResult.refusal === null &&
    belowResult.refusal === null
  return {
    pass,
    detail: `above=${aboveResult.candidates.length} below=${belowResult.candidates.length}`,
  }
})

addCase('the same state twice produces the same probes in the same order (pure enumeration)', () => {
  const blocks = [ore({ x: 31, y: 59, z: 33 }), ore({ x: 29, y: 59, z: 31 })]
  const first = prospectCandidates(world({ focusItem: 'raw_iron', blocks }), defaultCandidateOptions, 'raw_iron', -54)
  const second = prospectCandidates(world({ focusItem: 'raw_iron', blocks }), defaultCandidateOptions, 'raw_iron', -54)
  const pass =
    first.candidates.length === 2 &&
    first.candidates.map((c) => c.id).join(',') === second.candidates.map((c) => c.id).join(',') &&
    first.candidates.map((c) => c.id).join(',') === 'PROSPECT:level:E:b29_59_33,PROSPECT:level:N:b28_59_32'
  return { pass, detail: `ids=[${first.candidates.map((c) => c.id).join(',')}]` }
})

// --- (b) an exposed producer stays with the ordinary mine arm ----------------------

addCase('a wall that IS ore and is pickup-adjacent keeps its MINE and gets no probe', () => {
  const state = world({
    focusItem: 'raw_iron',
    blocks: [
      ore(
        { x: 29, y: 59, z: 33 },
        { inReach: true, hasAdjacentStandable: true, adjacentStandable: FEET, visible: true },
      ),
    ],
  })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const pass =
    mines(grounded.candidates).length === 1 &&
    mines(grounded.candidates)[0]?.id === 'MINE:b29_59_33' &&
    prospects(grounded.candidates).length === 0 &&
    grounded.prospectRefusal === null
  return { pass, detail: `ids=[${grounded.candidates.map((c) => c.id).join(',')}]` }
})

addCase('a producer with a walk-up stand keeps its MOVE and gets no probe', () => {
  const state = world({
    focusItem: 'raw_iron',
    blocks: [
      ore({ x: 31, y: 59, z: 33 }, { hasAdjacentStandable: true, adjacentStandable: { x: 30, y: 59, z: 33 } }),
    ],
  })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const moves = grounded.candidates.filter((candidate) => candidate.kind === 'MOVE')
  const pass =
    moves.length === 1 &&
    prospects(grounded.candidates).length === 0 &&
    grounded.prospectRefusal === null
  return { pass, detail: `ids=[${grounded.candidates.map((c) => c.id).join(',')}]` }
})

// --- (c) a refused wall is a typed refusal, never a probe -------------------------

addCase('a hazard wall in front of the producer is a typed refusal and no probe', () => {
  const state = world({
    focusItem: 'raw_iron',
    blocks: [ore({ x: 31, y: 59, z: 33 })],
    descent: [
      // Both E steps share the wall/head/floor hazard neighborhood; keep the
      // fixture consistent with buildDescent so neither E route crosses it.
      {
        ...downStep('E', 1, 0),
        safe: false,
        reason: 'lava/water in the step column',
        refusal: 'hazard',
        hazardNearby: true,
      },
      levelStep('E', 1, 0, { safe: false, reason: 'lava/water in the step column', refusal: 'hazard' }),
      levelStep('W', -1, 0),
      levelStep('N', 0, -1),
      levelStep('S', 0, 1),
    ],
  })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const refusal = grounded.prospectRefusal
  const descends = descendSteps(grounded.candidates)
  const unsafeHeadingOffered = descends.some((candidate) => candidate.meta.dir === 'E')
  const safeAlternativeOffered = descends.some((candidate) => candidate.meta.mode === 'level' && candidate.meta.dir !== 'E')
  const pass =
    prospects(grounded.candidates).length === 0 &&
    refusal !== null &&
    refusal.reason === 'hazard' &&
    refusal.dir === 'E' &&
    refusal.producer === 'iron_ore' &&
    refusal.producerCell.x === 31 &&
    refusal.digCell.x === 29 &&
    !unsafeHeadingOffered &&
    safeAlternativeOffered
  return {
    pass,
    detail: `ids=[${grounded.candidates.map((c) => c.id).join(',')}] refusal=${refusal === null ? 'none' : formatProspectRefused(refusal)}`,
  }
})

addCase('an unbreakable wall in front of the producer is a typed refusal and no probe', () => {
  const state = world({
    focusItem: 'raw_iron',
    blocks: [ore({ x: 31, y: 59, z: 33 })],
    descent: [
      downStep('E', 1, 0),
      levelStep('E', 1, 0, { safe: false, reason: 'bedrock wall is not breakable', refusal: 'unbreakable', diggable: false, digName: 'bedrock' }),
      levelStep('W', -1, 0),
      levelStep('N', 0, -1),
      levelStep('S', 0, 1),
    ],
  })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const pass =
    prospects(grounded.candidates).length === 0 &&
    grounded.prospectRefusal?.reason === 'unbreakable' &&
    grounded.prospectRefusal.dir === 'E'
  return {
    pass,
    detail: `refusal=${grounded.prospectRefusal === null ? 'none' : formatProspectRefused(grounded.prospectRefusal)}`,
  }
})

addCase('no harvest tool for the producer is a typed no_tool refusal and no probe', () => {
  const state = world({
    focusItem: 'raw_iron',
    blocks: [ore({ x: 31, y: 59, z: 33 })],
    counts: {},
  })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const pass = prospects(grounded.candidates).length === 0 && grounded.prospectRefusal?.reason === 'no_tool'
  return {
    pass,
    detail: `ids=[${grounded.candidates.map((c) => c.id).join(',')}] refusal=${grounded.prospectRefusal === null ? 'none' : formatProspectRefused(grounded.prospectRefusal)}`,
  }
})

addCase('the typed refusal line is stable for every reason', () => {
  const producerCell: Vec3Json = { x: 31, y: 59, z: 33 }
  const digCell: Vec3Json = { x: 29, y: 59, z: 33 }
  const line = (reason: 'hazard' | 'no_tool'): string =>
    formatProspectRefused({ reason, dir: 'E', producer: 'iron_ore', producerCell, digCell })
  const pass =
    line('hazard') === 'PROSPECT_REFUSED reason=hazard producer=iron_ore dir=E cell=31,59,33 dig=29,59,33' &&
    line('no_tool') === 'PROSPECT_REFUSED reason=no_tool producer=iron_ore dir=E cell=31,59,33 dig=29,59,33'
  return { pass, detail: `${line('hazard')} | ${line('no_tool')}` }
})

// --- (d) no mineral producer: nothing is invented ---------------------------------

addCase('a descend for an item with no block producer invents no prospecting', () => {
  const state = world({ focusItem: 'ender_pearl', blocks: [ore({ x: 31, y: 59, z: 33 })] })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const pass =
    prospects(grounded.candidates).length === 0 &&
    grounded.prospectRefusal === null &&
    descendSteps(grounded.candidates).some((candidate) => candidate.meta.mode === 'down')
  return { pass, detail: `ids=[${grounded.candidates.map((c) => c.id).join(',')}]` }
})

addCase('a mineral focus with no sensed producer of that mineral invents no prospecting', () => {
  // the sensed producer is iron_ore; the focus is diamond
  const state = world({ focusItem: 'diamond', blocks: [ore({ x: 31, y: 59, z: 33 })] })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const pass =
    prospects(grounded.candidates).length === 0 &&
    grounded.prospectRefusal === null &&
    descendSteps(grounded.candidates).some((candidate) => candidate.meta.mode === 'down')
  return { pass, detail: `ids=[${grounded.candidates.map((c) => c.id).join(',')}]` }
})

addCase('a stone-class focus declares no block producer and invents no prospecting', () => {
  const state = world({
    focusItem: 'cobblestone',
    blocks: [ore({ x: 31, y: 59, z: 33 }, { name: 'stone', yield: 'cobblestone' })],
  })
  const result = prospectCandidates(state, defaultCandidateOptions, 'cobblestone', -54)
  return { pass: result.candidates.length === 0 && result.refusal === null, detail: `probes=${result.candidates.length}` }
})

// --- bounds, context and generality ----------------------------------------------

addCase('a producer beyond the bounded corridor is not probed', () => {
  const near = world({ focusItem: 'raw_iron', blocks: [ore({ x: 31, y: 59, z: 33 })] })
  const far = world({ focusItem: 'raw_iron', blocks: [ore({ x: 32, y: 59, z: 33 })] })
  const nearResult = prospectCandidates(near, defaultCandidateOptions, 'raw_iron', -54)
  const farResult = prospectCandidates(far, defaultCandidateOptions, 'raw_iron', -54)
  const pass =
    PROSPECT_MAX_LATERAL === 3 &&
    nearResult.candidates.length === 1 &&
    farResult.candidates.length === 0 &&
    farResult.refusal === null
  return {
    pass,
    detail: `lateral=${PROSPECT_MAX_LATERAL} near=${nearResult.candidates.length} far(at 4)=${farResult.candidates.length}`,
  }
})

addCase('an off-corridor producer (2 blocks sideways) is not probed', () => {
  const state = world({ focusItem: 'raw_iron', blocks: [ore({ x: 31, y: 59, z: 35 })] })
  const result = prospectCandidates(state, defaultCandidateOptions, 'raw_iron', -54)
  return { pass: result.candidates.length === 0 && result.refusal === null, detail: `probes=${result.candidates.length}` }
})

addCase('a non-descending local row with the same producer is unchanged', () => {
  // `collect raw_iron` with no target below and the producer at the body's own
  // level: not a travel/descend-to-acquire context, so no probe is invented.
  const state = world({
    focusItem: 'raw_iron',
    blocks: [ore({ x: 31, y: 59, z: 33 })],
    current: { kind: 'collect', targetY: null, description: 'collect 3 x raw_iron' },
  })
  const result = prospectCandidates(state, defaultCandidateOptions, 'raw_iron', null)
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  return {
    pass: result.candidates.length === 0 && prospects(grounded.candidates).length === 0,
    detail: `probes=${result.candidates.length} offered=[${grounded.candidates.map((c) => c.id).join(',')}]`,
  }
})

addCase('a travel row whose grounded target is below is a prospecting context', () => {
  // Family-contract assertion: the context predicate accepts a navigation row
  // whose code-grounded target sits below the body. Wiring note: `goto` rows are
  // answered by the generator's `goto` branch (a MOVE to the target), so this
  // context only produces offers on the acquisition rows that reach the mine arm
  // (`descend`, `collect`, `craft`, `smelt`, ...) - see the next case.
  const state = world({
    focusItem: 'raw_iron',
    blocks: [ore({ x: 31, y: 59, z: 33 })],
    current: { kind: 'goto', targetY: null, targetPosition: { x: 40, y: 12, z: 40 }, description: 'travel to the iron level' },
  })
  const result = prospectCandidates(state, defaultCandidateOptions, 'raw_iron', null)
  const pass = result.candidates.length === 1 && result.candidates[0]?.id === 'PROSPECT:level:E:b29_59_33'
  return { pass, detail: `probes=[${result.candidates.map((c) => c.id).join(',')}]` }
})

addCase('a descend row with no targetY still offers the probe through the wired generator', () => {
  const state = world({
    focusItem: 'raw_iron',
    blocks: [ore({ x: 31, y: 59, z: 33 })],
    current: { kind: 'descend', targetY: null, description: 'descend for iron' },
  })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const pass =
    prospects(grounded.candidates).length === 1 &&
    descendSteps(grounded.candidates).length >= 1 &&
    grounded.prospectRefusal === null
  return { pass, detail: `ids=[${grounded.candidates.map((c) => c.id).join(',')}]` }
})

addCase('a producer below the body keeps the context when the row only counts items', () => {
  const state = world({
    focusItem: 'raw_iron',
    blocks: [ore({ x: 31, y: 59, z: 33 }), ore({ x: 31, y: 50, z: 33 })],
    current: { kind: 'collect', targetY: null, description: 'collect 3 x raw_iron' },
  })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const pass = prospects(grounded.candidates).length === 1
  return { pass, detail: `ids=[${grounded.candidates.map((c) => c.id).join(',')}]` }
})

let failures = 0
process.stdout.write('prospect while descending - the en-route exposure dig\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} prospect-descend cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
