// test-smelt-furnace.mts - M2 smelt pipeline: deterministic furnace acquisition,
// plan ordering, and a fixture run of the production furnace-window smelt.
//
// Run: node ../jev-agent/node_modules/.bin/tsx test-smelt-furnace.mts
import { defaultCandidateOptions, generateCandidates } from '../jev-agent/src/candidates.ts'
import type { Candidate } from '../jev-agent/src/candidates.ts'
import { executeFurnaceSmelt, formatSmeltLog } from '../jev-agent/src/executor.ts'
import type { SmeltFurnaceWindow } from '../jev-agent/src/executor.ts'
import { enforceSmeltPriority, furnacePrereqGoals, orderPlanGoalsByReadiness } from './planner.ts'
import { emptyWorldMemory } from './resident-types.ts'
import type { PlannedGoal } from '../jev-agent/src/goalQueue.ts'
import type { AgentSignals, BlockState, GoalState, InventoryState, KnownResource, SelfState, StationEntry, Vec3Json, WorldState } from '../jev-agent/src/state.ts'

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
    username: 'AI_M2SM',
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
    knownResources: [],
    ...overrides,
  }
}

function goal(overrides: Partial<GoalState>): GoalState {
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
    ...overrides,
  }
}

function worldState(overrides: {
  position: Vec3Json
  inventory?: InventoryState
  signals?: AgentSignals
  goal?: GoalState
  goalQueue?: WorldState['goalQueue']
  furnaces?: StationEntry[]
  placementSpots?: Vec3Json[]
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position),
    inventory: overrides.inventory ?? inventory({}),
    entities: [],
    blocks: [] as BlockState[],
    terrain: { standable: [overrides.position] },
    craftingTables: [],
    furnaces: overrides.furnaces ?? [],
    placementSpots: overrides.placementSpots ?? [],
    goal: overrides.goal ?? goal({}),
    goalQueue: overrides.goalQueue ?? {
      depth: 1,
      current: {
        id: 'g1',
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

const smeltCandidate = (candidates: readonly Candidate[]): Candidate | undefined =>
  candidates.find((candidate) => candidate.kind === 'SMELT')

// --- furnace acquisition ----------------------------------------------------

addCase('known station furnace yields a RETRIEVE toward it', () => {
  const known: KnownResource = { name: 'furnace', kind: 'station', position: { x: 22, y: 66, z: 29 } }
  const state = worldState({
    position: { x: 39, y: 11, z: 34 },
    // the 55-block climb needs a mechanically available ascend plan (placeable
    // block); without one the affordance gate withholds the retrieval.
    inventory: inventory({ raw_iron: 8, coal: 7, cobblestone: 8 }),
    signals: signals({ knownResources: [known] }),
  })
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const candidate = candidates[0]
  const pass = candidate !== undefined && candidate.kind === 'RETRIEVE' && candidate.id.includes('station:furnace')
  return { pass, detail: candidate === undefined ? 'no candidate' : `${candidate.kind} ${candidate.id}` }
})

addCase('held furnace yields a PLACE', () => {
  const state = worldState({
    position: { x: 39, y: 11, z: 34 },
    inventory: inventory({ raw_iron: 8, coal: 7, furnace: 1 }),
    signals: signals(),
    placementSpots: [{ x: 38, y: 11, z: 34 }],
  })
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const candidate = candidates[0]
  const pass = candidate !== undefined && candidate.kind === 'PLACE' && candidate.id.startsWith('PLACE:furnace') && candidate.meta.furnaceSource === 'held'
  return { pass, detail: candidate === undefined ? 'no candidate' : `${candidate.kind} ${candidate.id} src=${String(candidate.meta.furnaceSource)}` }
})

addCase('no furnace and none known yields nothing (the ladder crafts one)', () => {
  const state = worldState({
    position: { x: 39, y: 11, z: 34 },
    inventory: inventory({ raw_iron: 8, coal: 7, cobblestone: 112 }),
    signals: signals(),
  })
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const acquisition = candidates.filter((candidate) => candidate.kind === 'PLACE' || candidate.kind === 'RETRIEVE' || candidate.kind === 'SMELT')
  return { pass: acquisition.length === 0, detail: `candidates=${candidates.map((c) => c.id).join(',') || 'none'}` }
})

// --- smelt candidate + fuel satisfaction ------------------------------------

addCase('sensed furnace + raw_iron + coal yields SMELT with input/fuel counts', () => {
  const state = worldState({
    position: { x: 39, y: 65, z: 34 },
    inventory: inventory({ raw_iron: 8, coal: 7 }),
    furnaces: [{ x: 40, y: 65, z: 34, source: 'sensed' }],
  })
  const candidate = smeltCandidate(generateCandidates(state, defaultCandidateOptions))
  const pass =
    candidate !== undefined &&
    candidate.meta.inputItem === 'raw_iron' &&
    candidate.meta.fuelItem === 'coal' &&
    candidate.meta.inputCount === 3 &&
    candidate.meta.fuelCount === 1
  return { pass, detail: candidate === undefined ? 'no SMELT' : `input=${String(candidate.meta.inputItem)} fuel=${String(candidate.meta.fuelItem)} in=${String(candidate.meta.inputCount)} fuelN=${String(candidate.meta.fuelCount)}` }
})

addCase('any held fuel is accepted: logs/planks satisfy the fuel need', () => {
  const state = worldState({
    position: { x: 39, y: 65, z: 34 },
    inventory: inventory({ raw_iron: 3, oak_planks: 2, oak_log: 1 }),
    furnaces: [{ x: 40, y: 65, z: 34, source: 'sensed' }],
  })
  const candidate = smeltCandidate(generateCandidates(state, defaultCandidateOptions))
  const pass = candidate !== undefined && (candidate.meta.fuelItem === 'oak_planks' || candidate.meta.fuelItem === 'oak_log')
  return { pass, detail: candidate === undefined ? 'no SMELT' : `fuel=${String(candidate.meta.fuelItem)}` }
})

addCase('a single log is not reused as both charcoal input and furnace fuel', () => {
  const state = worldState({
    position: { x: 39, y: 65, z: 34 },
    inventory: inventory({ birch_log: 1 }),
    goal: goal({ id: 'smelt:charcoal', description: 'smelt 1 x charcoal', targetItem: 'charcoal', requiredCount: 1 }),
    furnaces: [{ x: 40, y: 65, z: 34, source: 'sensed' }],
  })
  const candidates = generateCandidates(state, defaultCandidateOptions)
  const pass = candidates.every((candidate) => candidate.kind !== 'SMELT')
  return { pass, detail: `candidates=${candidates.map((candidate) => candidate.id).join(',') || 'none'}` }
})

addCase('two logs satisfy the separate charcoal input and fuel slots', () => {
  const state = worldState({
    position: { x: 39, y: 65, z: 34 },
    inventory: inventory({ birch_log: 2 }),
    goal: goal({ id: 'smelt:charcoal', description: 'smelt 1 x charcoal', targetItem: 'charcoal', requiredCount: 1 }),
    goalQueue: {
      depth: 1,
      current: {
        id: 'g-charcoal',
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
      },
      empty: false,
      hasImpossible: false,
      done: 0,
      goals: [],
    },
    furnaces: [{ x: 40, y: 65, z: 34, source: 'sensed' }],
  })
  const candidate = smeltCandidate(generateCandidates(state, defaultCandidateOptions))
  const pass = candidate !== undefined && candidate.meta.inputItem === 'birch_log' && candidate.meta.fuelItem === 'birch_log' && candidate.meta.inputCount === 1 && candidate.meta.fuelCount === 1
  return { pass, detail: candidate === undefined ? 'no SMELT' : `input=${String(candidate.meta.inputItem)} fuel=${String(candidate.meta.fuelItem)} in=${String(candidate.meta.inputCount)} fuelN=${String(candidate.meta.fuelCount)}` }
})

// --- deterministic plan ordering --------------------------------------------

const descend: PlannedGoal = { kind: 'descend', description: 'descend_to:Y=8', targetItem: 'diamond', requiredCount: 1, targetY: 8, dimension: 'minecraft:overworld' }
const diamond: PlannedGoal = { kind: 'collect', description: 'collect 1 x diamond', targetItem: 'diamond', requiredCount: 1 }

addCase('a ready smelt is moved ahead of descend and logs PLAN_ORDER', () => {
  const logged: Array<{ event: string; detail: Record<string, unknown> }> = []
  const ordered = enforceSmeltPriority([descend, diamond], { raw_iron: 8, iron_ingot: 0, coal: 7 }, (event, detail) => {
    logged.push({ event, detail: detail ?? {} })
  })
  const first = ordered[0]
  const order = logged.find((entry) => entry.event === 'PLAN_ORDER')
  const pass =
    first !== undefined &&
    first.kind === 'smelt' &&
    first.targetItem === 'iron_ingot' &&
    first.requiredCount === 3 &&
    order?.detail.preferred === 'smelt_iron_ingot' &&
    order.detail.over === 'descend_to:Y=8'
  return { pass, detail: `first=${first?.description ?? 'none'} order=${JSON.stringify(order?.detail ?? null)}` }
})

addCase('an already-leading smelt is left untouched (no PLAN_ORDER)', () => {
  const smelt: PlannedGoal = { kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3 }
  const logged: string[] = []
  const ordered = enforceSmeltPriority([smelt, diamond], { raw_iron: 8, iron_ingot: 0, coal: 7 }, (event) => logged.push(event))
  const pass = ordered.length === 2 && ordered[0]?.kind === 'smelt' && logged.length === 0
  return { pass, detail: `first=${ordered[0]?.description ?? 'none'} logged=${logged.join(',') || 'none'}` }
})

addCase('insufficient raw_iron is not reordered', () => {
  const ordered = enforceSmeltPriority([descend], { raw_iron: 1, iron_ingot: 0, coal: 7 })
  return { pass: ordered[0]?.kind === 'descend', detail: `first=${ordered[0]?.kind ?? 'none'}` }
})

addCase('no fuel is not reordered', () => {
  const ordered = enforceSmeltPriority([descend], { raw_iron: 8, iron_ingot: 0 })
  return { pass: ordered[0]?.kind === 'descend', detail: `first=${ordered[0]?.kind ?? 'none'}` }
})

addCase('readiness ordering moves a ready smelt ahead of an unmet collect and logs the reason (#46)', () => {
  const logged: Array<{ event: string; detail: Record<string, unknown> }> = []
  const collect: PlannedGoal = { kind: 'collect', description: 'collect 1 x diamond', targetItem: 'diamond', requiredCount: 1 }
  const smelt: PlannedGoal = { kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3 }
  const ordered = orderPlanGoalsByReadiness(
    [collect, smelt],
    { raw_iron: 3, coal: 1 },
    { ...emptyWorldMemory(), furnaces: [{ x: 1, y: 64, z: 1 }] },
    (event, detail) => logged.push({ event, detail: detail ?? {} }),
  )
  const order = logged.find((entry) => entry.event === 'PLAN_ORDER')
  const pass =
    ordered[0]?.kind === 'smelt' &&
    ordered[0]?.targetItem === 'iron_ingot' &&
    ordered[0]?.ready === true &&
    ordered[1]?.targetItem === 'diamond' &&
    order?.detail.preferred === 'smelt_iron_ingot' &&
    order?.detail.over === 'collect 1 x diamond' &&
    order?.detail.reason === 'preconditions_satisfied'
  return { pass, detail: `order=[${ordered.map((goal) => goal.targetItem).join(',')}] smeltReady=${String(ordered[0]?.ready)} planOrder=${JSON.stringify(order?.detail ?? null)}` }
})

addCase('readiness ordering leaves the smelt unmarked while its inputs are not held (#46 merge evidence)', () => {
  const collect: PlannedGoal = { kind: 'collect', description: 'collect 1 x diamond', targetItem: 'diamond', requiredCount: 1 }
  const smelt: PlannedGoal = { kind: 'smelt', description: 'smelt 3 x iron_ingot', targetItem: 'iron_ingot', requiredCount: 3 }
  const ordered = orderPlanGoalsByReadiness([collect, smelt], { raw_iron: 1, coal: 1 }, emptyWorldMemory())
  const backSmelt = ordered.find((goal) => goal.kind === 'smelt')
  const diamondIndex = ordered.findIndex((goal) => goal.targetItem === 'diamond')
  const smeltIndex = ordered.findIndex((goal) => goal.kind === 'smelt')
  // The craft ingredient contract heads the plan with the satisfiable producer
  // (`collect 1 x log` for the diamond pickaxe chain); the smelt must stay
  // unmarked and keep its place behind the diamond goal.
  const pass =
    backSmelt?.ready !== true &&
    ordered[0]?.targetItem === 'log' &&
    diamondIndex >= 0 &&
    smeltIndex >= 0 &&
    diamondIndex < smeltIndex
  return { pass, detail: `order=[${ordered.map((goal) => goal.targetItem).join(',')}] smeltReady=${String(backSmelt?.ready)}` }
})

addCase('furnacePrereqGoals crafts from 8 cobblestone when nothing is known', () => {
  const goals = furnacePrereqGoals({ cobblestone: 112 }, 0, 0)
  const desc = goals.map((entry) => entry.description).join(' | ')
  return { pass: goals[0]?.kind === 'craft' && goals[1]?.kind === 'place', detail: desc }
})

addCase('furnacePrereqGoals skips the craft chain for a known furnace', () => {
  const goals = furnacePrereqGoals({ cobblestone: 112 }, 0, 2)
  return { pass: goals.length === 0, detail: `goals=${goals.map((entry) => entry.description).join(',') || 'none'}` }
})

addCase('furnacePrereqGoals only places a held furnace', () => {
  const goals = furnacePrereqGoals({ furnace: 1 }, 0, 0)
  return { pass: goals.length === 1 && goals[0]?.kind === 'place', detail: goals.map((entry) => entry.description).join(',') }
})

// --- production smelt execution fixture -------------------------------------

addCase('executeFurnaceSmelt places input+fuel, waits, collects, and logs SMELT_DONE', () => {
  const stash: Record<string, number> = { raw_iron: 3, coal: 1, iron_ingot: 0 }
  let pending = 0
  const window: SmeltFurnaceWindow = {
    putInput: async (_type, _meta, count) => {
      pending = count
      stash.raw_iron = (stash.raw_iron ?? 0) - count
    },
    putFuel: async (_type, _meta, count) => {
      stash.coal = (stash.coal ?? 0) - count
    },
    outputItem: () => (pending > 0 ? { count: 1 } : null),
    takeOutput: async () => {
      pending -= 1
      stash.iron_ingot = (stash.iron_ingot ?? 0) + 1
    },
    close: () => undefined,
  }
  const lines: string[] = []
  return executeFurnaceSmelt(
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
  ).then((outcome) => {
    const done = lines.find((line) => line.startsWith('SMELT_DONE'))
    const pass =
      outcome.gained === 3 &&
      outcome.outputCount === 3 &&
      (stash.iron_ingot ?? 0) === 3 &&
      done === 'SMELT_DONE item=iron_ingot gained=3 input=raw_iron fuel=coal output=3 delta=3'
    return { pass, detail: `gained=${outcome.gained} output=${outcome.outputCount} inv=${stash.iron_ingot} log=${done ?? 'none'}` }
  })
})

addCase('executeFurnaceSmelt reuses a different valid fuel already in the furnace', () => {
  const stash: Record<string, number> = { raw_iron: 1, charcoal: 1, iron_ingot: 0 }
  let pendingInput = 0
  let fuelPuts = 0
  let currentInput: { count: number; name: string } | null = null
  const window: SmeltFurnaceWindow = {
    putInput: async (_type, _meta, count) => {
      pendingInput = count
      currentInput = { count, name: 'raw_iron' }
      stash.raw_iron = (stash.raw_iron ?? 0) - count
    },
    putFuel: async () => {
      fuelPuts += 1
      throw new Error('the existing coal slot must be reused')
    },
    inputItem: () => currentInput,
    fuelItem: () => ({ count: 1, name: 'coal' }),
    outputItem: () => (pendingInput > 0 ? { count: 1 } : null),
    takeOutput: async () => {
      pendingInput = 0
      currentInput = null
      stash.iron_ingot = (stash.iron_ingot ?? 0) + 1
    },
    close: () => undefined,
  }
  const lines: string[] = []
  return executeFurnaceSmelt(
    {
      openFurnace: async () => window,
      inventoryItems: () => Object.entries(stash).map(([name, count], index) => ({ name, type: index, count })),
      countItem: (name) => stash[name] ?? 0,
      wait: async () => undefined,
      ensureOwned: () => undefined,
      timeoutMs: 5000,
      log: (event, detail) => lines.push(formatSmeltLog(event, detail)),
    },
    { inputItem: 'raw_iron', fuelItem: 'charcoal', outputItem: 'iron_ingot', inputCount: 1, fuelCount: 1 },
  ).then((outcome) => {
    const done = lines.find((line) => line.startsWith('SMELT_DONE'))
    const pass = outcome.gained === 1 && fuelPuts === 0 && done?.includes('fuel=coal') === true
    return { pass, detail: `gained=${outcome.gained} fuelPuts=${fuelPuts} log=${done ?? 'none'}` }
  })
})

let failures = 0
process.stdout.write('smelt furnace acquisition + execution\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} smelt furnace cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
