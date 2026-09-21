// test-prereq-oscillation.mts - issue #78 acceptance suite.
//
// Four measured behaviours:
//   (a) a held furnace at rung=iron_ingot selects place_held, logs the
//       inventory-first PREREQ_OPTION detail, and the next decision cycle offers
//       the SMELT that emits FURNACE_READY source=held;
//   (b) a known-station retrieve that keeps ending verified=false progressDelta=0
//       is abandoned after the bound and the next option runs;
//   (c) a repeated position pair with no state change fires OSCILLATION_DETECTED
//       with action=escape;
//   (d) no world-retrieval option is chosen while the required item is held.
//
// Run: bun test-prereq-oscillation.mts
import { defaultCandidateOptions, furnacePrereqInputFromState, generateCandidates } from './src/candidates.ts'
import { formatFurnaceReady } from './src/placementGuard.ts'
import {
  evaluateRetrieveAbandon,
  formatPrereqOptionDetail,
  planPrereqOptions,
  prereqOptionReason,
  prereqRank,
  selectPrereqPath,
} from './src/prereqOption.ts'
import { evaluateOscillation, positionKey } from './src/oscillation.ts'
import type { OscillationState } from './src/oscillation.ts'
import type { AgentSignals, KnownResource, StationEntry, WorldState } from './src/state.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const STATION = 'b29_61_35'

function world(overrides: {
  inventory: Record<string, number>
  furnaces?: StationEntry[]
  signals?: Partial<AgentSignals>
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: {
      username: 'AI_M2P',
      position: { x: 39, y: 10, z: 34 },
      eyePosition: { x: 39, y: 11.62, z: 34 },
      yaw: 0,
      pitch: 0,
      onGround: true,
      health: 20,
      food: 20,
      gameMode: 'survival',
      dimension: 'overworld',
      isDay: true,
      heldItem: null,
    },
    inventory: {
      slots: Object.entries(overrides.inventory).map(([name, count], slot) => ({ name, count, slot })),
      counts: overrides.inventory,
      totalItems: Object.values(overrides.inventory).reduce((sum, n) => sum + n, 0),
    },
    entities: [],
    blocks: [],
    terrain: { standable: [{ x: 39, y: 10, z: 34 }] },
    craftingTables: [],
    furnaces: overrides.furnaces ?? [],
    placementSpots: [{ x: 40, y: 10, z: 34 }],
    goal: {
      id: 'smelt:iron_ingot',
      description: 'smelt 3 x iron_ingot',
      targetItem: 'iron_ingot',
      requiredCount: 3,
      startCount: 0,
      haveCount: 0,
      progress: 0,
      complete: false,
      startedAtMs: 0,
    },
    goalQueue: {
      depth: 2,
      current: {
        id: 'g41:smelt:iron_ingot',
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
    signals: {
      consecutiveFailures: 0,
      lastFailureCode: null,
      lastPathStatus: 'idle',
      stalledMs: 0,
      lastPolicyConfidence: null,
      maxConcurrentActions: 0,
      escalationRecommended: false,
      failedCandidates: {},
      knownResources: [
        { name: 'furnace', kind: 'station', position: { x: 29, y: 61, z: 35 } } as KnownResource,
      ],
      ...overrides.signals,
    },
  }
}

const heldFurnaceState = world({ inventory: { furnace: 1, raw_iron: 8, coal: 7, cobblestone: 112 } })

// --- (a) held furnace -> place_held -> SMELT/FURNACE_READY -------------------

addCase('(a) held furnace selects place_held and logs the inventory-first detail', () => {
  const input = furnacePrereqInputFromState(heldFurnaceState, defaultCandidateOptions)
  const decision = planPrereqOptions(input)
  const chosen = selectPrereqPath(decision)
  const detail = chosen === null ? 'none' : formatPrereqOptionDetail('furnace', chosen, prereqOptionReason(chosen), input.heldCount)
  const place = generateCandidates(heldFurnaceState, defaultCandidateOptions).find(
    (candidate) => candidate.meta.prereqPath === 'place_held',
  )
  const pass =
    chosen === 'place_held' &&
    prereqRank('place_held') === 0 &&
    detail === 'PREREQ_OPTION resource=furnace option=place_held reason=held_in_inventory qty=1' &&
    place !== undefined &&
    place.id.startsWith('PLACE:furnace') &&
    place.meta.furnaceSource === 'held'
  return { pass, detail: `${detail} candidate=${place?.id ?? 'none'} source=${String(place?.meta.furnaceSource)}` }
})

addCase('(a) the next decision cycle after the placement emits FURNACE_READY source=held', () => {
  const placed = world({
    inventory: { raw_iron: 8, coal: 7, cobblestone: 112 },
    furnaces: [{ x: 40, y: 10, z: 34, source: 'sensed' }],
    signals: { heldFurnacePlacedAt: 'b40_10_34' },
  })
  const smelt = generateCandidates(placed, defaultCandidateOptions).find((candidate) => candidate.kind === 'SMELT')
  const ready = formatFurnaceReady(String(smelt?.meta.furnaceSource ?? 'none'), { x: 40, y: 10, z: 34 })
  const pass =
    smelt !== undefined &&
    smelt.meta.furnaceSource === 'held' &&
    ready === 'FURNACE_READY source=held at=40,10,34'
  return { pass, detail: `${ready} smelt=${smelt?.id ?? 'none'}` }
})

// --- (b) unverified zero-progress retrieve is abandoned ----------------------

addCase('(b) an unverified zero-progress retrieve is abandoned after the bound', () => {
  const actionId = `RETRIEVE:known:station:furnace:${STATION}`
  let state = evaluateRetrieveAbandon({ actionId, verified: false, progressDelta: 0, previous: null })
  const first = state
  for (let i = 0; i < 2; i += 1) {
    state = evaluateRetrieveAbandon({ actionId, verified: false, progressDelta: 0, previous: state.state })
  }
  const third = state
  const nudge = evaluateRetrieveAbandon({
    actionId,
    verified: true,
    progressDelta: 0,
    previous: third.state,
  })
  const fourth = evaluateRetrieveAbandon({ actionId, verified: false, progressDelta: 0, previous: nudge.state })
  const productive = evaluateRetrieveAbandon({
    actionId,
    verified: true,
    progressDelta: 1,
    previous: fourth.state,
  })
  const pass =
    first.abandon === false &&
    third.abandon === false &&
    nudge.abandon === false &&
    nudge.state.unverified === 3 &&
    fourth.abandon === true &&
    fourth.line === `ABANDON_REASON=retrieve_unverified progress=0 option=${actionId}` &&
    productive.abandon === false &&
    productive.state.unverified === 0
  return { pass, detail: `after4="${fourth.line ?? 'none'}" nudge=${nudge.state.unverified} rearmed=${productive.state.unverified}` }
})

addCase('(b) abandoning the world path makes the next option run', () => {
  const state = world({
    inventory: { cobblestone: 119, raw_iron: 8, coal: 7 },
    signals: { knownResources: [{ name: 'furnace', kind: 'station', position: { x: 29, y: 61, z: 35 } }] },
  })
  state.craftingTables = [{ x: 39, y: 10, z: 34, source: 'sensed' }]
  const input = furnacePrereqInputFromState(state, defaultCandidateOptions)
  const decision = planPrereqOptions(input)
  const next = selectPrereqPath(decision, new Set(['use_known_station']))
  const kept = generateCandidates(state, defaultCandidateOptions).filter(
    (candidate) => candidate.meta.prereqPath === next,
  )
  const pass =
    next === 'craft_and_place' &&
    decision.chosen === 'craft_and_place' &&
    kept.some((candidate) => candidate.id === 'CRAFT:furnace') &&
    kept.every((candidate) => candidate.meta.prereqPath !== 'use_known_station')
  return { pass, detail: `next=${String(next)} kept=${kept.map((c) => c.id).join(',') || 'none'}` }
})

// --- (c) oscillation detector fires and escapes ------------------------------

addCase('(c) a repeated position pair fires OSCILLATION_DETECTED action=escape', () => {
  const signature = 'smelt:iron_ingot:3|{}'
  const a = positionKey({ x: 39.1, y: 10.3, z: 34.3 })
  const b = positionKey({ x: 39.1, y: 9.0, z: 33.5 })
  let state: OscillationState | null = null
  let last = evaluateOscillation({ position: a, signature, previous: state })
  state = last.state
  const seen: boolean[] = []
  let firstLine: string | null = null
  for (const position of [b, a, b, a, b]) {
    last = evaluateOscillation({ position, signature, previous: state })
    seen.push(last.detected)
    if (last.detected) {
      if (firstLine === null) firstLine = last.line
      state = null
    } else {
      state = last.state
    }
  }
  const changed = evaluateOscillation({ position: a, signature: 'different|{"furnace":1}', previous: state })
  const pass =
    seen.filter(Boolean).length === 1 &&
    firstLine === `OSCILLATION_DETECTED from=${b} to=${a} cycles=4 action=escape` &&
    changed.detected === false &&
    positionKey({ x: 1.04, y: 2.06, z: 3.05 }) === '1,2.1,3.1'
  return { pass, detail: `detections=${seen.filter(Boolean).length} line="${firstLine ?? 'none'}"` }
})

// --- (d) held item never chooses a world retrieve ----------------------------

addCase('(d) a held furnace beats even a zero-distance known station', () => {
  const state = world({ inventory: { furnace: 1, raw_iron: 8, coal: 7, cobblestone: 112 } })
  state.signals.knownResources = [
    { name: 'furnace', kind: 'station', position: { x: 39, y: 10, z: 34 } } as KnownResource,
  ]
  const input = furnacePrereqInputFromState(state, defaultCandidateOptions)
  const decision = planPrereqOptions(input)
  const chosen = selectPrereqPath(decision)
  const kept = generateCandidates(state, defaultCandidateOptions).filter(
    (candidate) => candidate.meta.prereqPath === chosen,
  )
  const pass =
    chosen === 'place_held' &&
    kept.length > 0 &&
    kept.every((candidate) => candidate.meta.prereqPath === 'place_held') &&
    kept.every((candidate) => candidate.meta.prereqPath !== 'use_known_station')
  return { pass, detail: `chosen=${String(chosen)} kept=${kept.map((c) => c.id).join(',')}` }
})

let failures = 0
process.stdout.write('issue #78 - held-inventory prerequisite option, retrieve abandon, oscillation\n')
process.stdout.write('-'.repeat(78) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(78) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} prereq-oscillation cases passed\n`)

if (failures > 0) process.exit(1)
