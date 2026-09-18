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
import { defaultCandidateOptions, generateCandidates } from '../jev-agent/src/candidates.ts'
import type { Candidate } from '../jev-agent/src/candidates.ts'
import { executeFurnaceSmelt, formatSmeltLog } from '../jev-agent/src/executor.ts'
import type { SmeltFurnaceWindow } from '../jev-agent/src/executor.ts'
import {
  classifyAbandonReason,
  evaluatePlaceRetry,
  formatAbandonReason,
  PLACE_RETRY_LIMIT,
  prerequisiteProtection,
  shouldAdoptAbandon,
} from '../jev-agent/src/placementGuard.ts'
import type { AgentSignals, BlockState, GoalState, InventoryState, SelfState, Vec3Json, WorldState } from '../jev-agent/src/state.ts'

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
  furnaces?: Vec3Json[]
  placementSpots?: Vec3Json[]
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self({ x: 29, y: 61, z: 35 }),
    inventory: overrides.inventory ?? inventory({}),
    entities: [],
    blocks: [] as BlockState[],
    terrain: { standable: [{ x: 29, y: 61, z: 35 }] },
    craftingTables: [],
    furnaces: overrides.furnaces ?? [],
    placementSpots: overrides.placementSpots ?? [],
    goal: smeltGoal(),
    goalQueue: {
      depth: 2,
      current: {
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
      },
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

  const afterPlace = worldState({ inventory: inventory({ raw_iron: 3, coal: 1 }), furnaces: [spot], placementSpots: [spot] })
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
