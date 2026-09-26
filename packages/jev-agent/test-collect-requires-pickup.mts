// test-collect-requires-pickup.mts - a COLLECT goal must actually ACQUIRE its
// drop. Live run-mu91qnt3-12tsi (source f759ab2): `MINE:b27_55_6` removed an
// iron_ore and observed the raw_iron drop, but the inventory stayed
// `raw_iron=2` (`gained=0`); the verifier recorded the dig as verified success
// and Jev moved to the next ore while the visible drop was never collected.
//
// The boundary proven here:
//   (a) a collect goal with `blockRemoved=true, dropObserved=true,
//       itemsGained=0` is NOT a completed/verified collect - the drop must be
//       actively picked up, and if the bounded pickup fails a TYPED failure
//       (`pickup_failed`) is surfaced;
//   (b) a pure dig goal with `blockRemoved=true, itemsGained=0` still succeeds
//       (a clearance / non-collect MINE whose drop may be transformed or lost).
//
// Pure: no bot, no network, no model.
import { readFileSync } from 'node:fs'
import {
  describeActionPostcondition,
  decideActionOutcome,
  truthfulActionOutcome,
} from './src/actionPostcondition.ts'
import * as actionPostcondition from './src/actionPostcondition.ts'
import { defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import type {
  AgentSignals,
  BlockState,
  GoalState,
  InventoryState,
  Vec3Json,
  WorldState,
} from './src/state.ts'
import type { QueuedGoal } from './src/goalQueue.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

/** The strict MINE post-condition the executor gates verification on. */
type MineEvidence = {
  requiresPickup: boolean
  blockRemoved: boolean
  dropObserved: boolean
  itemsGained: number
}
const isMinePostconditionMet: ((evidence: MineEvidence) => boolean) | undefined =
  actionPostcondition.isMinePostconditionMet

/** A collect MINE: the block is gone and the drop was seen, but it was not collected. */
const COLLECT_UNCOLLECTED = {
  kind: 'MINE',
  status: 'done',
  verified: true,
  itemsGained: 0,
  blockRemoved: true,
  requiresPickup: true,
} as const

/** A pure dig: the block is gone and the action is complete without an item. */
const PURE_DIG = {
  kind: 'MINE',
  status: 'done',
  verified: true,
  itemsGained: 0,
  blockRemoved: true,
  requiresPickup: false,
} as const

// --- (a) a collect goal requires the drop to be acquired ----------------------

addCase('(a) MINE post-condition: a collect goal with a removed block + observed drop but gained=0 is NOT met', () => {
  if (isMinePostconditionMet === undefined) {
    return { pass: false, detail: 'isMinePostconditionMet is not exported (RED: collect pickup boundary absent)' }
  }
  const uncollected = isMinePostconditionMet({
    requiresPickup: true,
    blockRemoved: true,
    dropObserved: true,
    itemsGained: 0,
  })
  const collected = isMinePostconditionMet({
    requiresPickup: true,
    blockRemoved: true,
    dropObserved: true,
    itemsGained: 1,
  })
  const noBlock = isMinePostconditionMet({
    requiresPickup: true,
    blockRemoved: false,
    dropObserved: true,
    itemsGained: 1,
  })
  const pass = uncollected === false && collected === true && noBlock === false
  return { pass, detail: `uncollected=${uncollected} collected=${collected} noBlock=${noBlock}` }
})

addCase('(a) truth layer: a collect MINE that did not acquire the drop is not a verified done collect', () => {
  const truth = truthfulActionOutcome(COLLECT_UNCOLLECTED)
  const pass =
    truth.verified === false &&
    truth.status !== 'done' &&
    truth.resetsFailureMemory === false &&
    truth.downgraded === true
  return {
    pass,
    detail: `verified=${truth.verified} status=${truth.status} downgraded=${truth.downgraded} resets=${truth.resetsFailureMemory}`,
  }
})

addCase('(a) decision layer: a collect MINE that did not acquire the drop cannot advance the ladder', () => {
  const decision = decideActionOutcome(COLLECT_UNCOLLECTED)
  const pass = decision.advances === false && decision.verdict !== 'verified'
  return { pass, detail: `verdict=${decision.verdict} advances=${decision.advances} line=${decision.unverifiedLine ?? 'none'}` }
})

addCase('(a) a collect MINE that DID acquire the drop stays verified and advances', () => {
  const truth = truthfulActionOutcome({ ...COLLECT_UNCOLLECTED, itemsGained: 1 })
  const decision = decideActionOutcome({ ...COLLECT_UNCOLLECTED, itemsGained: 1 })
  const pass = truth.verified === true && truth.status === 'done' && decision.advances === true
  return { pass, detail: `verified=${truth.verified} status=${truth.status} advances=${decision.advances}` }
})

addCase('(a) the executor surfaces a typed pickup failure and bounds the pickup by pickupPathTimeoutMs', () => {
  const executor = readFileSync(new URL('./src/executor.ts', import.meta.url), 'utf8')
  const usesPostcondition = executor.includes('isMinePostconditionMet(')
  const typedFailure = executor.includes("'pickup_failed'")
  const boundStart = executor.indexOf('private async collectDrop(')
  const boundEnd = executor.indexOf('private pickupAim(')
  const collectDrop = boundStart >= 0 && boundEnd > boundStart ? executor.slice(boundStart, boundEnd) : ''
  const bounded = collectDrop.includes('this.options.pickupPathTimeoutMs')
  const pass = usesPostcondition && typedFailure && bounded
  return { pass, detail: `usesPostcondition=${usesPostcondition} pickup_failed=${typedFailure} boundedByPathTimeout=${bounded}` }
})

addCase('(a) the MINE post-condition is named so the ACTION_UNVERIFIED line states acquisition', () => {
  const line = describeActionPostcondition('MINE')
  const pass = line.includes('itemsGained > 0') && line.toLowerCase().includes('collect')
  return { pass, detail: line }
})

// --- (b) a pure dig goal still succeeds on block removal -----------------------

addCase('(b) MINE post-condition: a pure dig with a removed block and gained=0 IS met (no regression)', () => {
  if (isMinePostconditionMet === undefined) {
    return { pass: false, detail: 'isMinePostconditionMet is not exported (RED)' }
  }
  const withoutDrop = isMinePostconditionMet({
    requiresPickup: false,
    blockRemoved: true,
    dropObserved: false,
    itemsGained: 0,
  })
  const withDrop = isMinePostconditionMet({
    requiresPickup: false,
    blockRemoved: true,
    dropObserved: true,
    itemsGained: 0,
  })
  const intact = isMinePostconditionMet({
    requiresPickup: false,
    blockRemoved: false,
    dropObserved: false,
    itemsGained: 0,
  })
  const pass = withoutDrop === true && withDrop === true && intact === false
  return { pass, detail: `withoutDrop=${withoutDrop} withDrop=${withDrop} intact=${intact}` }
})

addCase('(b) truth layer: a pure dig MINE with blockRemoved=true and gained=0 stays verified done', () => {
  const truth = truthfulActionOutcome(PURE_DIG)
  const decision = decideActionOutcome(PURE_DIG)
  const pass = truth.verified === true && truth.status === 'done' && decision.advances === true
  return { pass, detail: `verified=${truth.verified} status=${truth.status} advances=${decision.advances}` }
})

addCase('(b) a pure dig that removed nothing is still rejected', () => {
  const truth = truthfulActionOutcome({ ...PURE_DIG, verified: false, itemsGained: 0, blockRemoved: false })
  const pass = truth.verified === false
  return { pass, detail: `verified=${truth.verified} status=${truth.status}` }
})

// --- the boundary is generic: it is carried by the candidate, not item names ----

function self(position: Vec3Json): WorldState['self'] {
  return {
    username: 'AI_PICKUP',
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

function signals(): AgentSignals {
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
  }
}

function queued(overrides: Partial<QueuedGoal>): QueuedGoal {
  return {
    id: 'g',
    kind: 'collect',
    description: 'x',
    targetItem: 'log',
    requiredCount: 1,
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

function goalFor(current: QueuedGoal): GoalState {
  return {
    id: current.id,
    description: current.description,
    targetItem: current.targetItem ?? '',
    requiredCount: current.requiredCount,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

/** A collect goal with a pickup-adjacent, in-reach iron_ore and no ceiling cut. */
function collectMineWorld(): WorldState {
  const current = queued({ id: 'g-iron', description: 'collect 3 x raw_iron', targetItem: 'raw_iron', requiredCount: 3 })
  const ore: BlockState = {
    kind: 'ore',
    name: 'iron_ore',
    position: { x: 1, y: 60, z: 0 },
    distance: 1,
    diggable: true,
    inReach: true,
    hasAdjacentStandable: true,
    adjacentStandable: { x: 0, y: 60, z: 0 },
    yield: 'raw_iron',
    harvestTool: 'pickaxe',
    harvestTier: 0,
    visible: true,
  }
  return {
    schemaVersion: 1,
    tick: 3,
    timestampMs: 1_700_000_000_000,
    self: self({ x: 0.5, y: 60, z: 0.5 }),
    inventory: inventory({ stone_pickaxe: 1 }),
    entities: [],
    blocks: [ore],
    terrain: { standable: [{ x: 0, y: 60, z: 0 }] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goalFor(current),
    goalQueue: { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] },
    recentEvents: [],
    signals: signals(),
  }
}

/** A collect goal forced into the headroom escape: no in-reach ore, only a ceiling cut. */
function clearanceWorld(): WorldState {
  const current = queued({ id: 'g-iron', description: 'collect 3 x raw_iron', targetItem: 'raw_iron', requiredCount: 3 })
  return {
    schemaVersion: 1,
    tick: 4,
    timestampMs: 1_700_000_000_000,
    self: self({ x: 0.5, y: 60, z: 0.5 }),
    inventory: inventory({ stone_pickaxe: 1 }),
    entities: [],
    blocks: [],
    terrain: { standable: [{ x: 0, y: 60, z: 0 }] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goalFor(current),
    goalQueue: { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] },
    recentEvents: [],
    signals: signals(),
    headroomCuts: [{ pos: { x: 0, y: 61, z: 0 }, name: 'stone', safe: true, reason: 'test-ceiling' }],
  }
}

function mineCandidates(world: WorldState): Candidate[] {
  return generateGroundedCandidates(world, defaultCandidateOptions).candidates.filter(
    (candidate) => candidate.kind === 'MINE',
  )
}

addCase('(generic) a resource MINE carries requiresPickup=true from the collect goal, not from an item name', () => {
  const mine = mineCandidates(collectMineWorld()).find((candidate) => candidate.id === 'MINE:b1_60_0')
  const pass = mine !== undefined && mine.meta.requiresPickup === true
  return { pass, detail: `mine=${mine?.id ?? 'none'} requiresPickup=${String(mine?.meta.requiresPickup)}` }
})

addCase('(generic) a headroom clearance MINE stays a pure dig (requiresPickup !== true)', () => {
  const mine = mineCandidates(clearanceWorld()).find((candidate) => candidate.id === 'MINE:b0_61_0')
  const pass = mine !== undefined && mine.meta.clearance === true && mine.meta.requiresPickup !== true
  return {
    pass,
    detail: `mine=${mine?.id ?? 'none'} clearance=${String(mine?.meta.clearance)} requiresPickup=${String(mine?.meta.requiresPickup)}`,
  }
})

let failures = 0
process.stdout.write('collect requires pickup: a removed block + observed drop is not acquisition\n')
process.stdout.write('-'.repeat(78) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(78) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} collect-pickup cases passed\n`)
if (failures > 0) process.exit(1)
