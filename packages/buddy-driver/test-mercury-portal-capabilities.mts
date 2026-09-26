// test-mercury-portal-capabilities.mts - RED-FIRST contract for the M2 Nether
// portal MODEL-VISIBLE WHAT capabilities.
//
// Mercury/System2 owns WHAT; Code owns CAN/TRUE/SAFE/DONE and the geometry. The
// portal frame must therefore be a first-class typed kind (`build_portal_frame`)
// that Code grounds with `choosePortalSite` + `portalFrameLayout`, and the
// light/verify WHAT must compile onto the IGNITE selected skill. The frame is
// never leaked as a `place nether_portal` item (#263 pins that refusal).
//
// These cases fail before the capability/schema/compiler/candidate changes.
import {
  MERCURY_ALLOWED_GOALS,
  MUSE_SPARK_MODEL,
  compileMercuryGoal,
  mercuryTransportMode,
  parseMercuryJsonText,
  plannedGoalsFromMercury,
  validateMercuryPlan,
  validateMercuryPlanAgainstState,
} from './mercury-system2.ts'
import {
  NETHER,
  NETHER_PORTAL,
  OBSIDIAN,
  OVERWORLD,
  PORTAL_ENTERED_PREDICATE,
  PORTAL_LIT_PREDICATE,
  PORTAL_OBSIDIAN_REQUIRED,
  groundPortalFrame,
  orderedPlacementCells,
  portalFrameLayout,
} from '../jev-agent/src/netherPortalPlan.ts'
import type { Vec3Json, WorldState, SelfState, InventoryState, AgentSignals } from '../jev-agent/src/state.ts'
import type { QueuedGoal, GoalQueueState } from '../jev-agent/src/goalQueue.ts'
import { defaultCandidateOptions, generateGroundedCandidates } from '../jev-agent/src/candidates.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}

const cases: Case[] = []
function addCase(name: string, run: Case['run']): void {
  cases.push({ name, run })
}

const cellKey = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`
const cellSet = (cells: readonly { x: number; y: number; z: number }[]): Set<string> => new Set(cells.map(cellKey))

function reason(ok: boolean, error: string | undefined): string {
  return ok ? 'ACCEPTED' : (error ?? 'rejected')
}

addCase('(1) schema accepts build_portal_frame and rejects malformed geometry', () => {
  const accepted = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'build_portal_frame' }], reason: 'portal frame' })
  const acceptedGoal = accepted.ok ? plannedGoalsFromMercury(accepted.plan)[0] : null
  const unknownGeometry = validateMercuryPlan({
    op: 'patch',
    goals: [{ kind: 'build_portal_frame', origin: { x: 1, y: 2, z: 3 } }],
    reason: 'x',
  })
  const coords = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'build_portal_frame', x: 1, z: 2 }], reason: 'x' })
  const withItem = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'build_portal_frame', item: 'obsidian' }], reason: 'x' })
  const withCount = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'build_portal_frame', count: 10 }], reason: 'x' })
  const withY = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'build_portal_frame', y: 64 }], reason: 'x' })
  const withMode = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'build_portal_frame', mode: 'cave' }], reason: 'x' })
  const withDimension = validateMercuryPlan({
    op: 'patch',
    goals: [{ kind: 'build_portal_frame', dimension: OVERWORLD }],
    reason: 'x',
  })
  const rejected = [unknownGeometry, coords, withItem, withCount, withY, withMode, withDimension]
  const pass =
    accepted.ok &&
    acceptedGoal?.kind === 'place' &&
    acceptedGoal.targetItem === OBSIDIAN &&
    acceptedGoal.requiredCount === PORTAL_OBSIDIAN_REQUIRED &&
    String(acceptedGoal.targetItem) !== NETHER_PORTAL &&
    rejected.every((result) => !result.ok)
  return {
    pass,
    detail: `accepted=${reason(accepted.ok, accepted.ok ? undefined : accepted.error)} goal=${acceptedGoal?.kind}:${acceptedGoal?.targetItem}x${acceptedGoal?.requiredCount} rejected=${rejected.map((r) => reason(r.ok, r.ok ? undefined : r.error)).join(' | ')}`,
  }
})

addCase('(2) muse JSON-text and the tool-call path both carry build_portal_frame', () => {
  const plan = { op: 'replace', goals: [{ kind: 'build_portal_frame' }], reason: 'portal frame' }
  const toolCall = validateMercuryPlan(plan)
  const toolCallGoal = toolCall.ok ? plannedGoalsFromMercury(toolCall.plan)[0] : null
  const parsed = parseMercuryJsonText(JSON.stringify(plan))
  const jsonText = validateMercuryPlan(parsed)
  const jsonTextGoal = jsonText.ok ? plannedGoalsFromMercury(jsonText.plan)[0] : null
  const pass =
    mercuryTransportMode(MUSE_SPARK_MODEL) === 'json-text' &&
    mercuryTransportMode('inception/mercury-2.5') === 'tool-call' &&
    toolCallGoal?.targetItem === OBSIDIAN &&
    jsonTextGoal?.targetItem === OBSIDIAN
  return {
    pass,
    detail: `muse=${mercuryTransportMode(MUSE_SPARK_MODEL)} mercury=${mercuryTransportMode('inception/mercury-2.5')} toolCall=${toolCallGoal?.kind}:${toolCallGoal?.targetItem} jsonText=${jsonTextGoal?.kind}:${jsonTextGoal?.targetItem}`,
  }
})

addCase('(3) light_portal and verify_portal compile to the IGNITE portal_lit goal', () => {
  const light = validateMercuryPlan({
    op: 'patch',
    goals: [{ kind: 'light_portal', dimension: OVERWORLD }],
    reason: 'ignite',
  })
  const verify = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'verify_portal' }], reason: 'confirm' })
  const lightGoal = light.ok ? compileMercuryGoal(light.plan.goals[0] ?? { kind: undefined }) : null
  const verifyGoal = verify.ok ? compileMercuryGoal(verify.plan.goals[0] ?? { kind: undefined }) : null
  const geometry = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'light_portal', y: 64 }], reason: 'x' })
  const pass =
    light.ok &&
    verify.ok &&
    lightGoal?.kind === 'place' &&
    lightGoal.targetItem === NETHER_PORTAL &&
    lightGoal.targetPredicate === PORTAL_LIT_PREDICATE &&
    lightGoal.dimension === OVERWORLD &&
    verifyGoal?.targetItem === NETHER_PORTAL &&
    verifyGoal.targetPredicate === PORTAL_LIT_PREDICATE &&
    verifyGoal.dimension === OVERWORLD &&
    !geometry.ok
  return {
    pass,
    detail: `light=${lightGoal?.kind}:${lightGoal?.targetItem}@${lightGoal?.targetPredicate}/${lightGoal?.dimension} verify=${verifyGoal?.kind}:${verifyGoal?.targetItem}@${verifyGoal?.targetPredicate}/${verifyGoal?.dimension} geometry=${reason(geometry.ok, geometry.ok ? undefined : geometry.error)}`,
  }
})

addCase('(3b) the light/verify synonyms compile to the same IGNITE goal on both transports', () => {
  const viaBoth = (raw: unknown) => {
    const toolCall = validateMercuryPlan(raw)
    const jsonText = validateMercuryPlan(parseMercuryJsonText(JSON.stringify(raw)))
    return {
      toolCall: toolCall.ok ? compileMercuryGoal(toolCall.plan.goals[0] ?? { kind: undefined }) : null,
      jsonText: jsonText.ok ? compileMercuryGoal(jsonText.plan.goals[0] ?? { kind: undefined }) : null,
    }
  }
  const light = viaBoth({ op: 'patch', goals: [{ kind: 'light' }], reason: 'ignite' })
  const verify = viaBoth({ op: 'patch', goals: [{ kind: 'verify', dimension: OVERWORLD }], reason: 'confirm' })
  const ignite = (goal: ReturnType<typeof compileMercuryGoal>) =>
    goal?.kind === 'place' && goal.targetItem === NETHER_PORTAL && goal.targetPredicate === PORTAL_LIT_PREDICATE
  const pass =
    ignite(light.toolCall) &&
    ignite(light.jsonText) &&
    ignite(verify.toolCall) &&
    ignite(verify.jsonText) &&
    light.toolCall?.dimension === OVERWORLD &&
    verify.jsonText?.dimension === OVERWORLD
  return {
    pass,
    detail: `light=${light.toolCall?.targetItem}@${light.toolCall?.targetPredicate} jsonText=${light.jsonText?.targetItem} verify=${verify.toolCall?.targetItem}@${verify.toolCall?.targetPredicate}`,
  }
})

addCase('(3c) enter_portal is a model-visible WHAT that compiles to the existing dimension-transfer goal', () => {
  const checked = validateMercuryPlan({
    op: 'patch',
    goals: [{ kind: 'enter_portal' }],
    reason: 'the verified gate is already live',
  })
  const malformed = [
    validateMercuryPlan({ op: 'patch', goals: [{ kind: 'enter_portal', item: NETHER_PORTAL }], reason: 'x' }),
    validateMercuryPlan({ op: 'patch', goals: [{ kind: 'enter_portal', count: 1 }], reason: 'x' }),
    validateMercuryPlan({ op: 'patch', goals: [{ kind: 'enter_portal', y: 64 }], reason: 'x' }),
  ]
  const goal = checked.ok ? compileMercuryGoal(checked.plan.goals[0] ?? { kind: undefined }) : null
  const liveStateError = checked.ok
    ? validateMercuryPlanAgainstState(checked.plan, {
        dimension: OVERWORLD,
        portal: { verified: true, knownSites: 1 },
      })
    : 'plan rejected'
  const darkStateError = checked.ok
    ? validateMercuryPlanAgainstState(checked.plan, {
        dimension: OVERWORLD,
        portal: { verified: false, knownSites: 1 },
      })
    : null
  const pass =
    checked.ok &&
    goal?.kind === 'place' &&
    goal.targetItem === NETHER_PORTAL &&
    goal.targetPredicate === PORTAL_ENTERED_PREDICATE &&
    goal.dimension === NETHER &&
    liveStateError === null &&
    typeof darkStateError === 'string' &&
    darkStateError.includes('no live verified portal') &&
    malformed.every((result) => !result.ok)
  return {
    pass,
    detail: `goal=${goal?.kind}:${goal?.targetItem}@${goal?.targetPredicate}/${goal?.dimension} live=${liveStateError ?? 'ok'} dark=${darkStateError ?? 'unexpected-ok'} malformed=${malformed.map((r) => r.ok ? 'ACCEPTED' : 'rejected').join(',')}`,
  }
})

addCase('(4) the frame goal grounds to portalFrameLayout cells at execution time', () => {
  const origin: Vec3Json = { x: 5, y: 64, z: 0 }
  const self: Vec3Json = { x: 6, y: 64, z: -2 }
  const grounding = groundPortalFrame([origin], self)
  const expected = orderedPlacementCells(portalFrameLayout(origin, 'x').frame)
  const frameGoal = compileMercuryGoal({ kind: 'build_portal_frame' })
  const state = worldState({ position: { x: 6.5, y: 64, z: -1.5 }, goalQueue: queueWith(queuedPlace(frameGoal)) })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const place = grounded.candidates.find((candidate) => candidate.kind === 'PLACE' && candidate.itemName === OBSIDIAN)
  const sameSet =
    grounding !== null &&
    place?.placementCells !== undefined &&
    cellSet(grounding.cells).size === expected.length &&
    [...cellSet(place.placementCells)].every((key) => cellSet(expected).has(key)) &&
    cellSet(place.placementCells).size === expected.length &&
    place.target !== null &&
    cellKey(place.target) === cellKey(grounding.cells[0] ?? { x: 0, y: 0, z: 0 })
  return {
    pass: sameSet === true,
    detail: `grounded=${grounding?.cells.length ?? 0} expected=${expected.length} candidateCells=${place?.placementCells?.length ?? 0} origin=${grounding?.origin === undefined ? 'none' : cellKey(grounding.origin)} target=${place?.target === null || place?.target === undefined ? 'none' : cellKey(place.target)}`,
  }
})

addCase('(5) place:nether_portal stays REFUSED while the portal WHAT kinds are exposed', () => {
  const frameAsPlace = validateMercuryPlan({
    op: 'patch',
    goals: [{ kind: 'place', item: NETHER_PORTAL, count: 1 }],
    reason: 'portal frame',
  })
  const bareFrameAsPlace = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'place', item: NETHER_PORTAL }], reason: 'portal frame' })
  const stationPlace = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'place', item: 'furnace' }], reason: 'station' })
  const build = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'build_portal_frame' }], reason: 'frame' })
  const light = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'light_portal' }], reason: 'ignite' })
  const verify = validateMercuryPlan({ op: 'patch', goals: [{ kind: 'verify_portal' }], reason: 'confirm' })
  const pass =
    !frameAsPlace.ok &&
    !bareFrameAsPlace.ok &&
    stationPlace.ok &&
    build.ok &&
    light.ok &&
    verify.ok &&
    !MERCURY_ALLOWED_GOALS.place.includes(NETHER_PORTAL)
  return {
    pass,
    detail: `place:nether_portal=${reason(frameAsPlace.ok, frameAsPlace.ok ? undefined : frameAsPlace.error)} bare=${reason(bareFrameAsPlace.ok, bareFrameAsPlace.ok ? undefined : bareFrameAsPlace.error)} station=${stationPlace.ok} build=${build.ok} light=${light.ok} verify=${verify.ok}`,
  }
})

// ---------------------------------------------------------------------------
// fixtures for the candidate-level grounding case
// ---------------------------------------------------------------------------

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_PORTALCAP',
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

function queuedPlace(frameGoal: { requiredCount?: number } | null): QueuedGoal {
  return {
    id: 'g-frame',
    kind: 'place',
    description: 'build the obsidian nether portal frame',
    targetItem: OBSIDIAN,
    requiredCount: frameGoal?.requiredCount ?? PORTAL_OBSIDIAN_REQUIRED,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'mechanical',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function queueWith(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

function worldState(overrides: { position: Vec3Json; goalQueue: GoalQueueState }): WorldState {
  return {
    schemaVersion: 1,
    tick: 9,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position),
    inventory: inventory({ obsidian: PORTAL_OBSIDIAN_REQUIRED }),
    entities: [],
    blocks: [],
    terrain: { standable: [overrides.position] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [{ x: 5, y: 64, z: 0 }],
    descent: [],
    stepCuts: [],
    headroomCuts: [],
    goal: {
      id: 'place:obsidian',
      description: 'build the obsidian nether portal frame',
      targetItem: OBSIDIAN,
      requiredCount: PORTAL_OBSIDIAN_REQUIRED,
      startCount: 0,
      haveCount: 0,
      progress: 0,
      complete: false,
      startedAtMs: 0,
    },
    goalQueue: overrides.goalQueue,
    recentEvents: [],
    signals: signals(),
  }
}

let failures = 0
process.stdout.write('Mercury portal WHAT capabilities (model-visible, code-grounded geometry)\n')
process.stdout.write(`${'-'.repeat(72)}\n`)
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write(`${'-'.repeat(72)}\n`)
process.stdout.write(`${cases.length - failures}/${cases.length} portal-capability cases passed\n`)
if (failures > 0) process.exit(1)
