// test-candidate-starvation-furnace-place.mts - the CLASSIFIED live shape for a
// `place:furnace` goal: an unreachable locomotion target is withheld `open_path`
// and, before the fix, the policy only ever saw WAIT/ESCALATE.
//
// Preceding success in the same run (context, not asserted here): the craft
// ladder resumed (`LADDER_RESUME`), `MILESTONE iron_gear done=true`, the
// inventory held furnace=1 / iron_ingot=3 / iron_pickaxe=1, and the Options
// compiler emitted the abstract `place:furnace` goal (`OPTION_COMPILE`).
//
// Failure shape (classified live):
//   CANDIDATE_WITHHELD reason=no_path candidate=MOVE:p56_60_24 missing=["open_path"]
//   CANDIDATE_STARVATION presented=2 productive=0 goal="place:furnace:1"
//     blockedBy=precondition:furnace missing=["MOVE:p56_60_24:open_path"]
// Jev re-selected WAIT/ESCALATE because the gate had no route-opening affordance
// to offer; `llmResummon` never fired.
//
// After d7fcd10 the presented set MUST include the EXISTING generic STEP / MOVE /
// DESCEND route-opening families (CAN enumeration only), the withheld MOVE stays
// withheld (no deterministic substitution), and repeated `productive=0` re-summons
// System2/Mercury with reason `candidate_starvation`. Positions/ids are the
// classified-live illustration; the assertions about the presented families and
// preserved Jev authority are what matter.
//
// Pure: no bot, no network, no model. Run: npm run candidate-starvation-furnace-place-test
import {
  applyReachabilityGate,
  blockId,
  defaultCandidateOptions,
  generateGroundedCandidates,
} from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import {
  candidateStarvationLine,
  candidateStarvationMissing,
  formatCandidateStarvation,
} from './src/controller.ts'
import { compileGoalQueue } from './src/optionSpec.ts'
import { formatCandidateWithheld } from './src/reachability.ts'
import { evaluateSummonConditions, LLM_SUMMON_REASONS } from './src/system2.ts'
import type { AgentSignals, GoalState, InventoryState, StepCut, Vec3Json, WorldState } from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

function self(position: Vec3Json): WorldState['self'] {
  return {
    username: 'AI_PLACE_FURNACE',
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

function goal(targetItem: string, description: string): GoalState {
  return {
    id: `place:${targetItem}`,
    description,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(targetItem: string, description: string): QueuedGoal {
  return {
    id: `g-${targetItem}`,
    kind: 'place',
    description,
    targetItem,
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

function queueWith(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

// The classified-live illustration: the placement approach target the body
// cannot path to, plus a reachable frontier the generic MOVE family can offer.
const BOT: Vec3Json = { x: 56, y: 60, z: 0 }
const FRONTIER: Vec3Json = { x: 5, y: 60, z: 0 }
// A reachable cell between the body and the unreachable approach target, so the
// generic MOVE family has a frontier of its own to offer alongside the STEP.
const NEAR_FRONTIER: Vec3Json = { x: 56, y: 60, z: 5 }
const PLACE_TARGET: Vec3Json = { x: 56, y: 60, z: 24 }
const PLACE_TARGET_ID = `MOVE:${blockId('p', PLACE_TARGET)}`

const CUT: StepCut = {
  dir: 'E',
  dx: 1,
  dz: 0,
  cut: { x: 57, y: 61, z: 0 },
  step: { x: 57, y: 61, z: 0 },
  name: 'stone',
  safe: true,
  reason: 'safe',
}

function worldState(overrides: {
  position?: Vec3Json
  inventory?: InventoryState
  signals?: AgentSignals
  standable?: Vec3Json[]
  stepCuts?: WorldState['stepCuts']
}): WorldState {
  const placeGoal = goal('furnace', 'place 1 x furnace')
  const queued = queuedGoal('furnace', 'place 1 x furnace')
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position ?? BOT),
    inventory: overrides.inventory ?? inventory({}),
    entities: [],
    blocks: [],
    terrain: { standable: overrides.standable ?? [BOT, FRONTIER] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: [],
    stepCuts: overrides.stepCuts ?? [],
    headroomCuts: [],
    goal: placeGoal,
    goalQueue: queueWith(queued),
    recentEvents: [],
    signals: overrides.signals ?? signals(),
  }
}

/** The classified-live success inventory: the prior ladder run left these held. */
const HELD_AFTER_LADDER = inventory({ furnace: 1, iron_ingot: 3, iron_pickaxe: 1 })

/**
 * Preceding success in the same live run (`run-mu98ondr-192ql`), the tick before
 * the boundary: the craft ladder resumed (`LADDER_RESUME`), the iron_gear
 * milestone was reached (`MILESTONE iron_gear done=true`), and the Options
 * compiler emitted the abstract `place:furnace` goal (`OPTION_COMPILE`).
 */
const PRECEDING_RUN_EVENTS: readonly string[] = ['LADDER_RESUME', 'MILESTONE iron_gear done=true']
const PRECEDING_OPTION_ID = 'place:furnace'

/**
 * The boundary state must still carry the preceding-success facts: the items the
 * ladder left held, the `place` kind, and the OPTION_COMPILE'd `place:furnace`
 * spec - not a synthetic bare `place` goal.
 */
function precedingSuccessHolds(state: WorldState): { ok: boolean; detail: string } {
  const held = state.inventory.counts
  const compiled = compileGoalQueue(state.goalQueue).map((spec) => spec.id)
  const ok =
    PRECEDING_RUN_EVENTS.length === 2 &&
    held.furnace === 1 &&
    held.iron_ingot === 3 &&
    held.iron_pickaxe === 1 &&
    state.goal.targetItem === 'furnace' &&
    state.goalQueue.current?.kind === 'place' &&
    compiled.includes(PRECEDING_OPTION_ID)
  return {
    ok,
    detail: `events=[${PRECEDING_RUN_EVENTS.join(', ')}] held=${JSON.stringify(held)} goal=${state.goal.id} kind=${state.goalQueue.current?.kind ?? 'none'} OPTION_COMPILE=[${compiled.join(',')}]`,
  }
}

/** The live path probe: the placement approach has no path, the front is walkable. */
const livePathProbe = (position: Vec3Json): 'reachable' | 'no_path' =>
  position.x === PLACE_TARGET.x && position.y === PLACE_TARGET.y && position.z === PLACE_TARGET.z
    ? 'no_path'
    : 'reachable'

function optionsWith(pathProbe: CandidateOptions['reachability']): CandidateOptions {
  return { ...defaultCandidateOptions, reachability: pathProbe ?? null }
}

function productive(candidates: readonly Candidate[]): Candidate[] {
  return candidates.filter((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')
}

/** The raw locomotion candidate the gate must withhold: MOVE:p56_60_24. */
function placeApproachMove(state: WorldState): Candidate {
  return {
    id: PLACE_TARGET_ID,
    kind: 'MOVE',
    label: `walk to the furnace placement approach (${PLACE_TARGET.x},${PLACE_TARGET.y},${PLACE_TARGET.z})`,
    targetName: 'furnace',
    target: PLACE_TARGET,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: { tick: state.tick, x: PLACE_TARGET.x, y: PLACE_TARGET.y, z: PLACE_TARGET.z },
  }
}

const ROUTE_OPENING_KINDS: ReadonlySet<Candidate['kind']> = new Set(['STEP', 'MOVE', 'DESCEND'])

interface StarvationSummon {
  summon: boolean
  reason: string
  detail: string
}
type StarvationSummonFn = (
  productive: number,
  repeats: number,
  goal: string,
  blockedBy: string,
  missing?: readonly string[],
  threshold?: number,
) => StarvationSummon

async function main(): Promise<void> {
  process.stdout.write('place:furnace / open_path candidate starvation (classified live shape)\n')
  process.stdout.write('-'.repeat(78) + '\n')

  // Dynamic so a red run against the unfixed base reports the missing export as a
  // failed check instead of aborting the whole suite on a module-load error.
  const controllerModule = (await import('./src/controller.ts')) as unknown as Record<string, unknown>
  const candidateStarvationSummon = controllerModule.candidateStarvationSummon as StarvationSummonFn | undefined

  // (0) preceding success: the boundary tick still carries the iron_gear ladder
  // result and the OPTION_COMPILE'd `place:furnace` goal.
  {
    const state = worldState({ inventory: HELD_AFTER_LADDER })
    const preceding = precedingSuccessHolds(state)
    await check(
      '(0) the preceding ladder success + OPTION_COMPILE place:furnace are reproduced',
      preceding.ok,
      preceding.detail,
    )
  }

  // (1) exact withheld shape: MOVE:p56_60_24 -> no_path / open_path.
  {
    const state = worldState({
      inventory: HELD_AFTER_LADDER,
      standable: [BOT, PLACE_TARGET, NEAR_FRONTIER],
      stepCuts: [CUT],
      signals: signals({ escalationRecommended: true }),
    })
    const grounded = applyReachabilityGate([placeApproachMove(state)], state, optionsWith({ memory: null, pathProbe: livePathProbe }))
    const withheld = grounded.withheld.find((entry) => entry.candidate.id === PLACE_TARGET_ID)
    await check(
      '(1) the place approach MOVE is withheld with reason=no_path missing=[open_path]',
      withheld !== undefined &&
        withheld.result.reason === 'no_path' &&
        withheld.result.missingCapabilities.some((capability) => capability.kind === 'open_path'),
      `withheld=${withheld?.candidate.id ?? 'none'} reason=${withheld?.result.reason ?? 'none'} missing=[${(withheld?.result.missingCapabilities ?? []).map((c) => c.kind).join(',')}]`,
    )
    await check(
      '(1) the withheld marker matches the classified live line',
      formatCandidateWithheld(PLACE_TARGET_ID, 'no_path') === `CANDIDATE_WITHHELD reason=no_path candidate=${PLACE_TARGET_ID}`,
      formatCandidateWithheld(PLACE_TARGET_ID, 'no_path'),
    )
    await check(
      '(1) the starvation `missing` token is MOVE:p56_60_24:open_path',
      candidateStarvationMissing(grounded.withheld).includes(`${PLACE_TARGET_ID}:open_path`),
      `missing=${JSON.stringify(candidateStarvationMissing(grounded.withheld))}`,
    )
  }

  // (2) after the fix the presented set carries the generic STEP/MOVE families,
  // not only WAIT/ESCALATE. Assertions are family + attribution, never coordinates.
  {
    const state = worldState({
      inventory: HELD_AFTER_LADDER,
      standable: [BOT, PLACE_TARGET, NEAR_FRONTIER],
      stepCuts: [CUT],
      signals: signals({ escalationRecommended: true }),
    })
    const grounded = applyReachabilityGate([placeApproachMove(state)], state, optionsWith({ memory: null, pathProbe: livePathProbe }))
    const presented = productive(grounded.candidates)
    const routeOpening = presented.filter((candidate) => ROUTE_OPENING_KINDS.has(candidate.kind))
    const kinds = new Set(routeOpening.map((candidate) => candidate.kind))
    await check(
      '(2) route-opening affordances from the existing STEP/MOVE families are PRESENTED',
      routeOpening.length > 0 && (kinds.has('STEP') || kinds.has('MOVE') || kinds.has('DESCEND')),
      `presented=[${presented.map((candidate) => `${candidate.kind}:${candidate.id}`).join(',')}]`,
    )
    await check(
      '(2) alternatives span more than one family (Jev still chooses)',
      kinds.size >= 2,
      `kinds=[${[...kinds].join(',')}] presented=[${presented.map((candidate) => candidate.id).join(',')}]`,
    )
    await check(
      '(2) every route-opening candidate is acquisition-tagged for open_path (generic, no coordinates)',
      routeOpening.length > 0 &&
        routeOpening.every(
          (candidate) =>
            candidate.meta.capabilityAcquisition === true && candidate.meta.missingCapability === 'open_path',
        ),
      routeOpening.map((candidate) => JSON.stringify(candidate.meta)).join(' | ') || 'none',
    )
    await check(
      '(2) no WAIT-only set: the marker no longer fires for goal "place:furnace:1"',
      candidateStarvationLine(
        grounded.candidates,
        'place:furnace:1',
        false,
        'precondition:furnace',
        candidateStarvationMissing(grounded.withheld),
      ) === null,
      `line=${candidateStarvationLine(grounded.candidates, 'place:furnace:1', false, 'precondition:furnace', candidateStarvationMissing(grounded.withheld)) ?? 'none'}`,
    )
  }

  // (3) end-to-end classified shape through the real generator: an abstract
  // place:furnace goal with no placement spot falls back to the locomotion MOVE,
  // which is withheld. Before the fix this is CANDIDATE_STARVATION presented=2
  // productive=0; after it, a productive route-opening candidate exists.
  {
    const state = worldState({
      inventory: HELD_AFTER_LADDER,
      standable: [BOT, PLACE_TARGET],
      stepCuts: [CUT],
      signals: signals({ escalationRecommended: true }),
    })
    const grounded = generateGroundedCandidates(state, optionsWith({ memory: null, pathProbe: livePathProbe }))
    const withheld = grounded.withheld.find((entry) => entry.candidate.id === PLACE_TARGET_ID)
    await check(
      '(3) the generated place approach MOVE:p56_60_24 is withheld (open_path)',
      withheld !== undefined && withheld.result.missingCapabilities.some((capability) => capability.kind === 'open_path'),
      `withheld=[${grounded.withheld.map((entry) => `${entry.candidate.id}:${entry.result.reason}`).join(',')}]`,
    )
    const productiveIds = productive(grounded.candidates).map((candidate) => candidate.id)
    await check(
      '(3) the generated set is no longer WAIT/ESCALATE-only',
      productiveIds.length > 0,
      `productive=[${productiveIds.join(',')}] all=[${grounded.candidates.map((candidate) => `${candidate.kind}:${candidate.id}`).join(',')}]`,
    )
    // The pre-fix shape, asserted as the counterfactual the fix removes: with the
    // MOVE withheld and nothing productive on offer the marker would have been
    // presented=2 productive=0. Here only WAIT/ESCALATE would remain.
    const waitOnly = grounded.candidates.filter((candidate) => candidate.kind === 'WAIT' || candidate.kind === 'ESCALATE')
    const beforeFixLine = formatCandidateStarvation(waitOnly.length, 'place:furnace:1', 'precondition:furnace', [
      `${PLACE_TARGET_ID}:open_path`,
    ])
    await check(
      '(3) the pre-fix shape is exactly presented=2 productive=0 goal="place:furnace:1"',
      beforeFixLine ===
        'CANDIDATE_STARVATION presented=2 productive=0 goal="place:furnace:1" blockedBy=precondition:furnace missing=["MOVE:p56_60_24:open_path"]',
      beforeFixLine,
    )
  }

  // (4) Jev authority preserved: no deterministic substitution, ordering, or
  // planner auto-insertion. The withheld MOVE stays withheld; the additions are
  // facts tagged with the missing capability only; generation stays pure.
  {
    const state = worldState({
      inventory: HELD_AFTER_LADDER,
      standable: [BOT, PLACE_TARGET, NEAR_FRONTIER],
      stepCuts: [CUT],
      signals: signals({ escalationRecommended: true }),
    })
    const grounded = applyReachabilityGate([placeApproachMove(state)], state, optionsWith({ memory: null, pathProbe: livePathProbe }))
    const routes = grounded.candidates.filter((candidate) => ROUTE_OPENING_KINDS.has(candidate.kind))
    const forbiddenMeta = ['priority', 'rank', 'score', 'order', 'preferred', 'forced', 'autoInsert', 'plannerInsert']
    const noRanking = routes.every((candidate) =>
      forbiddenMeta.every((key) => !(key in candidate.meta)),
    )
    const withheldStaysWithheld = grounded.candidates.every((candidate) => candidate.id !== PLACE_TARGET_ID)
    const firstIds = generateGroundedCandidates(state, optionsWith({ memory: null, pathProbe: livePathProbe })).candidates.map(
      (candidate) => candidate.id,
    )
    const secondIds = generateGroundedCandidates(state, optionsWith({ memory: null, pathProbe: livePathProbe })).candidates.map(
      (candidate) => candidate.id,
    )
    await check(
      '(4) the withheld MOVE is not silently replaced by a deterministic same-target plan',
      withheldStaysWithheld && grounded.withheld.some((entry) => entry.candidate.id === PLACE_TARGET_ID),
      `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}] withheld=[${grounded.withheld.map((entry) => entry.candidate.id).join(',')}]`,
    )
    await check(
      '(4) route-opening candidates carry no priority/rank/ordering meta',
      noRanking,
      `metas=[${routes.map((candidate) => JSON.stringify(candidate.meta)).join(' | ')}]`,
    )
    await check(
      '(4) generation is pure and Jev-selectable (identical id sequence on repeat)',
      firstIds.length > 0 && firstIds.join(',') === secondIds.join(','),
      `ids=[${firstIds.join(',')}]`,
    )
  }

  // (5) the starvation re-summon to System2/Mercury is exercised for the exact
  // `place:furnace:1` goal - a reason only, never a substituted plan.
  {
    const below = candidateStarvationSummon?.(0, 1, 'place:furnace:1', 'precondition:furnace')
    const repeated = candidateStarvationSummon?.(0, 2, 'place:furnace:1', 'precondition:furnace', [
      `${PLACE_TARGET_ID}:open_path`,
    ])
    const healthy = candidateStarvationSummon?.(1, 9, 'place:furnace:1', 'no_productive_action')
    await check(
      '(5) repeated productive=0 on place:furnace:1 re-summons with candidate_starvation',
      repeated?.summon === true &&
        repeated.reason === 'candidate_starvation' &&
        repeated.detail.includes('place:furnace:1') &&
        repeated.detail.includes(`${PLACE_TARGET_ID}:open_path`),
      `summon=${repeated?.summon ?? 'n/a'} reason=${repeated?.reason ?? 'n/a'} detail=${repeated?.detail ?? 'n/a'}`,
    )
    await check(
      '(5) one starved tick does not summon; a productive candidate clears it',
      below?.summon === false && healthy?.summon === false,
      `below=${below?.summon ?? 'n/a'} healthy=${healthy?.summon ?? 'n/a'}`,
    )
    await check(
      '(5) the re-summon carries no goals/plan (no deterministic substitution)',
      repeated !== undefined &&
        !('goals' in repeated) &&
        !('plan' in repeated) &&
        LLM_SUMMON_REASONS.some((reason) => reason === repeated.reason) &&
        evaluateSummonConditions({
          queueEmpty: false,
          needLlm: false,
          actionImpossible: false,
          unknownSituation: false,
          noProgress: false,
          candidateStarvation: true,
        }).includes('candidate_starvation'),
      `keys=[${repeated === undefined ? 'n/a' : Object.keys(repeated).join(',')}]`,
    )
  }

  process.stdout.write('-'.repeat(78) + '\n')
  process.stdout.write(`place:furnace starvation: ${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}\n`)
  if (failures > 0) process.exit(1)
}

await main()
