// test-iron-ore-retire.mts - live iron-ore acquisition loop regression.
//
// Live defect (run-mu8a7phm-rfm0, RC 1ea64ef): the descend goal
// `descend_to:Y=-3` for `raw_iron` never got a body change. The deterministic
// policy ranks RETRIEVE above DESCEND, and the generator kept re-offering
// `RETRIEVE:known:raw_iron:b25_49_37` because the executor reports
// `verified=true status=done` for a SUB-METRE reuse-tunnel nudge:
//
//   RETRIEVE:known:raw_iron:b25_49_37 arrival targetDistance=12.26m->11.63m y=60.22->59.64 vertical=reuse
//   CAUSAL ... candidate=RETRIEVE:known:raw_iron:b25_49_37 ... verified=true status=done progressDelta=0
//
// `retireFailedKnownRetrieve` cleared its per-resource failure counter whenever
// `result.status === 'done' && result.verified`, so the present-but-unreachable
// ore was never dropped from `signals.knownResources` (28 retrieves, one
// `KNOWN_RESOURCE_UNREACHABLE` in the whole run). The fix gates the clear on
// OBSERVABLE progress, the same criterion the move-failure memory already uses.
//
// Run: npm run iron-ore-retire-test
import { defaultCandidateOptions, generateCandidates, generateGroundedCandidates } from './src/candidates.ts'
import {
  decideKnownRetrieve,
  filterKnownResources,
  knownRetrieveMadeProgress,
} from './src/controller.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { AgentSignals, DescentOption, GoalState, InventoryState, KnownResource, SelfState, Vec3Json, WorldState } from './src/state.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

/** The exact executor result fields for the live sub-metre nudge. */
const LIVE_NUDGE = {
  status: 'done' as const,
  verified: true,
  itemsGained: 0,
  blockRemoved: false,
  progressed: false,
}

/** The pre-fix clear rule, reproduced verbatim from `retireFailedKnownRetrieve`. */
function legacyClearsRetirementCounter(result: typeof LIVE_NUDGE): boolean {
  return result.status === 'done' && result.verified
}

function self(position: Vec3Json): SelfState {
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
    heldItem: null,
  }
}

function inventory(counts: Record<string, number>): InventoryState {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0) }
}

function goal(): GoalState {
  return {
    id: 'descend:raw_iron',
    description: 'descend_to:Y=-3',
    targetItem: 'raw_iron',
    requiredCount: 3,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(): QueuedGoal {
  return {
    id: 'g1',
    kind: 'descend',
    description: 'descend_to:Y=-3',
    targetItem: 'raw_iron',
    requiredCount: 3,
    targetY: -3,
    dimension: 'minecraft:overworld',
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
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

function downStep(dir: DescentOption['dir'], dx: number, dz: number, feet: Vec3Json): DescentOption {
  return {
    dir,
    mode: 'down',
    dx,
    dz,
    step: { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz },
    wall: { x: feet.x + dx, y: feet.y, z: feet.z + dz },
    head: { x: feet.x + dx, y: feet.y + 1, z: feet.z + dz },
    floor: { x: feet.x + dx, y: feet.y - 1, z: feet.z + dz },
    wallSolid: false,
    headSolid: false,
    floorSolid: true,
    safe: true,
    reason: 'safe',
    digName: 'stone',
    digHarvestTool: 'pickaxe',
    digHarvestTier: 1,
    diggable: true,
  }
}

const FEET: Vec3Json = { x: 28, y: 59, z: 33 }
/** Live remembered ore the bot could not route to (b25_49_37). */
const UNREACHABLE_ORE: KnownResource = { name: 'iron_ore', kind: 'ore', position: { x: 25, y: 49, z: 37 } }
const UNREACHABLE_ORE_KEY = 'iron_ore@25,49,37'

function oreWorld(known: KnownResource[]): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(FEET),
    inventory: inventory({ stone_pickaxe: 1 }),
    entities: [],
    blocks: [],
    terrain: { standable: [FEET] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: goal(),
    goalQueue: queueWith(queuedGoal()),
    recentEvents: [],
    descent: [downStep('W', -1, 0, FEET)],
    stepCuts: [],
    headroomCuts: [],
    signals: signals({ knownResources: known }),
  }
}

/** All candidate ids the generator produced, offered OR withheld by the gate. */
function allGeneratedIds(known: KnownResource[]): string[] {
  const grounded = generateGroundedCandidates(oreWorld(known), defaultCandidateOptions)
  return [
    ...grounded.candidates.map((candidate) => candidate.id),
    ...grounded.withheld.map((entry) => entry.candidate.id),
    ...grounded.reachability.map((entry) => entry.candidate.id),
  ]
}

// --- the executor trust boundary ------------------------------------------------

addCase('the live sub-metre nudge is verified but NOT known-retrieve progress', () => {
  const legacy = legacyClearsRetirementCounter(LIVE_NUDGE)
  const fixed = knownRetrieveMadeProgress(LIVE_NUDGE)
  return {
    pass: legacy === true && fixed === false,
    detail: `legacyClears=${legacy} fixedProgress=${fixed} (${JSON.stringify(LIVE_NUDGE)})`,
  }
})

addCase('a dug staircase step is known-retrieve progress', () => {
  const dug = { ...LIVE_NUDGE, blockRemoved: true }
  return { pass: knownRetrieveMadeProgress(dug) === true, detail: `progress=${knownRetrieveMadeProgress(dug)}` }
})

addCase('a gained item is known-retrieve progress', () => {
  const gained = { ...LIVE_NUDGE, itemsGained: 1 }
  return { pass: knownRetrieveMadeProgress(gained) === true, detail: `progress=${knownRetrieveMadeProgress(gained)}` }
})

addCase('a verified body change is known-retrieve progress', () => {
  const climbed = { ...LIVE_NUDGE, progressed: true }
  return { pass: knownRetrieveMadeProgress(climbed) === true, detail: `progress=${knownRetrieveMadeProgress(climbed)}` }
})

addCase('a downgraded failed retrieve is not progress', () => {
  const failed = { ...LIVE_NUDGE, status: 'failed' as const, verified: false }
  return { pass: knownRetrieveMadeProgress(failed) === false, detail: `progress=${knownRetrieveMadeProgress(failed)}` }
})

// --- the bounded retirement sequence ---------------------------------------------

addCase('the controller decision clears a real step and charges a nudge', () => {
  const cleared = decideKnownRetrieve({
    retrieval: 'known',
    target: UNREACHABLE_ORE.position,
    result: { ...LIVE_NUDGE, blockRemoved: true },
    previousAttempts: 5,
  })
  const charged = decideKnownRetrieve({
    retrieval: 'known',
    target: UNREACHABLE_ORE.position,
    result: LIVE_NUDGE,
    previousAttempts: 0,
  })
  const ignored = decideKnownRetrieve({
    retrieval: 'surface',
    target: UNREACHABLE_ORE.position,
    result: LIVE_NUDGE,
    previousAttempts: 0,
  })
  return {
    pass: cleared.kind === 'clear' && charged.kind === 'charge' && charged.attempts === 1 && ignored.kind === 'ignore',
    detail: `cleared=${cleared.kind} charged=${charged.kind}:${'attempts' in charged ? charged.attempts : '-'} ignored=${ignored.kind}`,
  }
})

addCase('two consecutive nudges retire the present-but-unreachable ore', () => {
  // Drive the real controller decision boundary, exactly as `onActionComplete`
  // does: each nudge gets the previous counter value back.
  let attempts = 0
  let retiredOn = -1
  for (let cycle = 1; cycle <= 2; cycle += 1) {
    const decision = decideKnownRetrieve({
      retrieval: 'known',
      target: UNREACHABLE_ORE.position,
      result: LIVE_NUDGE,
      previousAttempts: attempts,
    })
    if (decision.kind === 'charge' || decision.kind === 'retire') attempts = decision.attempts
    if (decision.kind === 'retire') retiredOn = cycle
  }
  // The pre-fix rule cleared every nudge, so the counter never advanced.
  const legacyAttempts = [1, 2].map(() => 0)
  return {
    pass: attempts === 2 && retiredOn === 2 && legacyAttempts.every((n) => n === 0),
    detail: `attempts=${attempts} retiredOnCycle=${retiredOn > 0 ? retiredOn : 'never'}`,
  }
})

// --- end-to-end: retiring the ore leaves the descend candidate --------------------

addCase('retiring the unreachable ore removes its RETRIEVE and keeps the DESCEND candidate', () => {
  const retrieveId = `RETRIEVE:known:raw_iron:b${UNREACHABLE_ORE.position.x}_${UNREACHABLE_ORE.position.y}_${UNREACHABLE_ORE.position.z}`
  const before = allGeneratedIds([UNREACHABLE_ORE])
  const beforeHasRetrieve = before.includes(retrieveId)
  const afterResources = filterKnownResources([UNREACHABLE_ORE], new Set([UNREACHABLE_ORE_KEY]))
  const after = allGeneratedIds(afterResources)
  const afterHasRetrieve = after.includes(retrieveId)
  const designed = generateCandidates(oreWorld(afterResources), defaultCandidateOptions)
  const descend = designed.find((candidate) => candidate.kind === 'DESCEND')
  return {
    pass:
      beforeHasRetrieve &&
      afterResources.length === 0 &&
      !afterHasRetrieve &&
      descend !== undefined &&
      descend.meta.predicate === 'descend_to:Y=-3',
    detail: `before=${beforeHasRetrieve} afterResources=${afterResources.length} after=${afterHasRetrieve} descend=${descend?.id ?? 'none'}`,
  }
})

let failures = 0
process.stdout.write('iron-ore acquisition: unreachable-ore retirement regression\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} iron-ore-retire cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
