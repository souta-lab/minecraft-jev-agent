// test-open-path-recovery.mts - CANDIDATE_GENERATION defect (open_path starvation).
//
// Live shape (verified): an unreachable MOVE/PLACE target is withheld by the
// affordance gate with
//
//   REACHABILITY candidate=MOVE:p56_60_24 reachable=false reason=no_path missing=[open_path]
//   -> CANDIDATE_WITHHELD
//   -> CANDIDATE_STARVATION goal=place:furnace:1 presented=2 productive=0
//
// with ONLY WAIT/ESCALATE presented. The bot's body never changed, so no causal
// progress could follow. The same withholding is reached from the dig-access
// retirement (`accessRefusal === 'no_path_to_stand'` ->
// `missingCapabilities: [{ kind: 'open_path' }]`, candidates.ts) and from the
// ordinary locomotion path probe (`pathProbe() === 'no_path'`,
// reachability.ts).
//
// The fix is CAN-only: when a withheld candidate is missing `open_path`, the
// generation pass must contribute the EXISTING generic route-opening family
// (STEP face-cut / DESCEND tunnel step / explore MOVE toward the target) so at
// least one mechanically-valid forward body change is PRESENTED. It must not
// choose, rank or replace Jev's WAIT/ESCALATE authority.
//
// Pure: no bot, no network, no model. Run: npx tsx test-open-path-recovery.mts
import { readFileSync } from 'node:fs'
import {
  applyReachabilityGate,
  defaultCandidateOptions,
  digAccessCandidateId,
  generateGroundedCandidates,
} from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type {
  AgentSignals,
  BlockState,
  GoalState,
  InventoryState,
  StepCut,
  Vec3Json,
  WorldState,
} from './src/state.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

// --- world builders ------------------------------------------------------------

function self(position: Vec3Json): WorldState['self'] {
  return {
    username: 'AI_OPEN_PATH',
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

function goal(targetItem: string): GoalState {
  return {
    id: `collect:${targetItem}`,
    description: `collect 1 x ${targetItem}`,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(targetItem: string): QueuedGoal {
  return {
    id: `g-${targetItem}`,
    kind: 'collect',
    description: `collect 1 x ${targetItem}`,
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

const BOT: Vec3Json = { x: 16.5, y: 64, z: 0.5 }
const ACCESS_STAND: Vec3Json = { x: 11, y: 65, z: 0 }
const BLOCK: Vec3Json = { x: 10, y: 64, z: 0 }

/** A blocked stone: out of reach, no walk-up access, needs the held pickaxe. */
function blockedStone(): BlockState {
  return {
    kind: 'stone',
    name: 'stone',
    position: BLOCK,
    distance: Math.hypot(BOT.x - BLOCK.x, BOT.y - BLOCK.y, BOT.z - BLOCK.z),
    diggable: true,
    inReach: false,
    hasAdjacentStandable: false,
    adjacentStandable: null,
    yield: 'cobblestone',
    harvestTool: 'pickaxe',
    harvestTier: 0,
  }
}

/** A safe 1-block face cut: the generic route-opening affordance for a no_path target. */
const CUT: StepCut = {
  dir: 'E',
  dx: 1,
  dz: 0,
  cut: { x: 1, y: 61, z: 0 },
  step: { x: 1, y: 61, z: 0 },
  name: 'stone',
  safe: true,
  reason: 'safe',
}

function worldState(overrides: {
  blocks?: BlockState[]
  inventory?: InventoryState
  signals?: AgentSignals
  standable?: Vec3Json[]
  stepCuts?: WorldState['stepCuts']
  descent?: WorldState['descent']
  goal: GoalState
  goalQueue?: GoalQueueState
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(BOT),
    inventory: overrides.inventory ?? inventory({ wooden_pickaxe: 1 }),
    entities: [],
    blocks: overrides.blocks ?? [],
    terrain: { standable: overrides.standable ?? [BOT, ACCESS_STAND] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: overrides.descent ?? [],
    stepCuts: overrides.stepCuts ?? [],
    headroomCuts: [],
    goal: overrides.goal,
    goalQueue: overrides.goalQueue ?? queueWith(queuedGoal(overrides.goal.targetItem ?? 'cobblestone')),
    recentEvents: [],
    signals: overrides.signals ?? signals(),
  }
}

/** The dig-access probe: a stand exists but has no path (the `no_path_to_stand` refusal). */
const standNoPath = (): { approach: Vec3Json; path: 'no_path' } => ({ approach: ACCESS_STAND, path: 'no_path' })

function optionsWith(
  reachability: CandidateOptions['reachability'],
): CandidateOptions {
  return { ...defaultCandidateOptions, reachability }
}

function productive(candidates: readonly Candidate[]): Candidate[] {
  return candidates.filter((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')
}

const ROUTE_OPENING_KINDS = new Set(['STEP', 'MOVE', 'DESCEND', 'MINE'])
function isRouteOpening(candidate: Candidate): boolean {
  return ROUTE_OPENING_KINDS.has(candidate.kind)
}

async function main(): Promise<void> {
  process.stdout.write('open_path recovery: a no-path withholding still presents a route-opening affordance\n')
  process.stdout.write('-'.repeat(78) + '\n')

  // (a) RED: the dig-access retirement shape. `accessRefusal === 'no_path_to_stand'`
  // is withheld with `reason=no_path missing=[open_path]`. Before the fix the
  // gate presented only WAIT/ESCALATE (productive=0); the generic STEP/MOVE
  // family must be on offer.
  {
    const state = worldState({ blocks: [blockedStone()], stepCuts: [CUT], goal: goal('cobblestone') })
    const grounded = generateGroundedCandidates(
      state,
      optionsWith({ memory: null, digApproach: standNoPath }),
    )
    const retirementId = digAccessCandidateId(BLOCK)
    const withheld = grounded.withheld.find((entry) => entry.candidate.id === retirementId)
    const productiveCandidates = productive(grounded.candidates)

    await check(
      '(a) an unreachable dig-access target is withheld with reason=no_path + missing=[open_path]',
      withheld !== undefined &&
        withheld.result.reason === 'no_path' &&
        withheld.result.missingCapabilities.some((capability) => capability.kind === 'open_path'),
      `withheld=${withheld?.candidate.id ?? 'none'} reason=${withheld?.result.reason ?? 'none'} missing=[${(withheld?.result.missingCapabilities ?? []).map((c) => c.kind).join(',')}]`,
    )
    await check(
      '(a) a generic route-opening candidate IS presented, not only WAIT/ESCALATE',
      productiveCandidates.length > 0 && productiveCandidates.some(isRouteOpening),
      `productive=[${productiveCandidates.map((candidate) => `${candidate.kind}:${candidate.id}`).join(',') || 'none'}] all=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
    )
    const recovery = grounded.candidates.find(isRouteOpening)
    await check(
      '(a) the recovery candidate is attributed to the withheld capability (acquisition-tagged)',
      recovery !== undefined &&
        recovery.meta.capabilityAcquisition === true &&
        recovery.meta.missingCapability === 'open_path',
      recovery === undefined ? 'no route-opening candidate presented' : JSON.stringify(recovery.meta),
    )
  }

  // (b) RED: the live `MOVE:p56_60_24` shape - an ordinary locomotion target
  // whose live path probe returns no_path. Same withheld capability; same
  // generic recovery must be presented, and the withheld id must not be
  // re-presented.
  {
    const state = worldState({ stepCuts: [CUT], goal: goal('cobblestone') })
    const unreachable: Candidate = {
      id: 'MOVE:p10_64_2',
      kind: 'MOVE',
      label: 'walk toward an unreachable target',
      targetName: null,
      target: { x: 10, y: 64, z: 2 },
      targetEntityId: null,
      itemName: null,
      requiresTool: false,
      toolName: null,
      inReach: false,
      hasStandableAdjacent: true,
      meta: { tick: state.tick },
    }
    const gateOptions = optionsWith({
      memory: null,
      pathProbe: (position) => (position.x === 10 && position.z === 2 ? 'no_path' : 'reachable'),
    })
    const gated = applyReachabilityGate([unreachable], state, gateOptions)
    const productiveCandidates = productive(gated.candidates)
    await check(
      '(b) a no_path locomotion target is withheld with missing=[open_path]',
      gated.withheld[0]?.result.reason === 'no_path' &&
        gated.withheld[0]?.result.missingCapabilities.some((capability) => capability.kind === 'open_path'),
      `withheld=${gated.withheld[0]?.result.reason ?? 'none'} missing=[${(gated.withheld[0]?.result.missingCapabilities ?? []).map((c) => c.kind).join(',')}]`,
    )
    await check(
      '(b) a generic route-opening candidate is presented for the live MOVE shape',
      productiveCandidates.length > 0 &&
        productiveCandidates.some(isRouteOpening) &&
        gated.candidates.every((candidate) => candidate.id !== unreachable.id),
      `productive=[${productiveCandidates.map((candidate) => `${candidate.kind}:${candidate.id}`).join(',') || 'none'}]`,
    )
  }

  // (c) Jev keeps the WHICH: the recovery candidate coexists with WAIT and
  // ESCALATE. The gate must not collapse the offer to one deterministic pick,
  // and no candidate may carry a code-side selection/priority marker.
  {
    const state = worldState({ stepCuts: [CUT], goal: goal('cobblestone') })
    const wait: Candidate = {
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
      meta: { tick: state.tick },
    }
    const escalate: Candidate = {
      id: 'ESCALATE',
      kind: 'ESCALATE',
      label: 'hand control to System 2',
      targetName: null,
      target: null,
      targetEntityId: null,
      itemName: null,
      requiresTool: false,
      toolName: null,
      inReach: true,
      hasStandableAdjacent: true,
      meta: { tick: state.tick, reason: 'unknown' },
    }
    const unreachable: Candidate = {
      ...wait,
      id: 'MOVE:p10_64_2',
      kind: 'MOVE',
      label: 'walk toward an unreachable target',
      target: { x: 10, y: 64, z: 2 },
      inReach: false,
      meta: { tick: state.tick },
    }
    const gated = applyReachabilityGate([unreachable, wait, escalate], state, optionsWith({
      memory: null,
      pathProbe: (position) => (position.x === 10 && position.z === 2 ? 'no_path' : 'reachable'),
    }))
    const kinds = gated.candidates.map((candidate) => candidate.kind)
    const selectionFields = gated.candidates.flatMap((candidate) =>
      ['selected', 'chosen', 'autoSelected', 'priority', 'rank'].filter((field) => field in candidate.meta),
    )
    await check(
      '(c) the offer keeps the recovery candidate AND the WAIT/ESCALATE alternatives',
      kinds.includes('WAIT') &&
        kinds.includes('ESCALATE') &&
        gated.candidates.some(isRouteOpening),
      `kinds=[${kinds.join(',')}]`,
    )
    await check(
      '(c) no deterministic selection/priority marker is added by the gate',
      selectionFields.length === 0,
      `markers=[${selectionFields.join(',') || 'none'}]`,
    )
    await check(
      '(c) the gate still exposes the full candidate set (selection is not collapsed to one)',
      gated.candidates.length > 1,
      `count=${gated.candidates.length}`,
    )
  }

  // (d) The change is generic: the route-opening family is keyed only on the
  // typed `open_path` capability, with no item/coordinate/furnace/portal
  // special-casing and no ordering added to the source.
  {
    const candidates = source('./src/candidates.ts')
    const wired =
      candidates.includes('function routeOpeningCandidates') &&
      candidates.includes("capability.kind === 'open_path'") &&
      candidates.includes('stepCutCandidates(state, options)') &&
      candidates.includes('exploreMoveCandidate(')
    const specialCased = candidates.includes('p56_60_24') || candidates.includes('place:furnace')
    await check(
      '(d) the open_path recovery is wired to the existing generic families',
      wired,
      `wired=${wired}`,
    )
    await check(
      '(d) the recovery is generic (no coordinate/furnace/portal special-casing)',
      !specialCased,
      `specialCased=${specialCased}`,
    )
  }

  process.stdout.write('-'.repeat(78) + '\n')
  process.stdout.write(`open-path-recovery: ${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}\n`)
  if (failures > 0) process.exit(1)
}

await main()
